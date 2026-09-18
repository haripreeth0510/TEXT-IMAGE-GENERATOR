import base64
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import Base, engine, get_db
from app.models import Generation
from app.schemas import GenerationHistoryItem
from app.services import image_service

STORAGE_DIR = Path(__file__).resolve().parent.parent / "storage"
STORAGE_DIR.mkdir(exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create tables if they don't exist yet. For a solo-dev project this
    # is fine; a real team project would use Alembic migrations instead
    # so schema changes are tracked and reversible.
    Base.metadata.create_all(bind=engine)
    # Load the image model once when the server starts, not per-request.
    image_service.load_pipeline()
    yield


app = FastAPI(title="Nano Banana - Phase 3 API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serves saved generation images back to the frontend at
# http://localhost:8000/storage/<filename>.png
app.mount("/storage", StaticFiles(directory=str(STORAGE_DIR)), name="storage")


def _save_generation(
    db: Session,
    mode: str,
    prompt: str,
    image_base64: str,
    seconds_taken: float,
) -> str:
    """Writes the image to disk under storage/ and records a Generation
    row. Returns the URL path the frontend can load the image from."""
    filename = f"{uuid.uuid4()}.png"
    file_path = STORAGE_DIR / filename
    file_path.write_bytes(base64.b64decode(image_base64))

    record = Generation(
        mode=mode,
        prompt=prompt,
        image_path=filename,
        seconds_taken=str(seconds_taken),
    )
    db.add(record)
    db.commit()

    return f"/storage/{filename}"


# ---------------------------------------------------------------------
# History
# ---------------------------------------------------------------------


@app.get("/history", response_model=list[GenerationHistoryItem])
async def history(db: Session = Depends(get_db)):
    records = (
        db.query(Generation)
        .order_by(Generation.created_at.desc())
        .limit(100)
        .all()
    )
    return [
        GenerationHistoryItem(
            id=r.id,
            mode=r.mode,
            prompt=r.prompt,
            image_url=f"/storage/{r.image_path}",
            seconds_taken=r.seconds_taken,
            created_at=r.created_at,
        )
        for r in records
    ]


@app.delete("/history/{generation_id}")
async def delete_history_item(generation_id: str, db: Session = Depends(get_db)):
    record = db.query(Generation).filter(Generation.id == generation_id).first()
    if not record:
        raise HTTPException(status_code=404, detail="Generation not found.")

    file_path = STORAGE_DIR / record.image_path
    if file_path.exists():
        file_path.unlink()

    db.delete(record)
    db.commit()

    return {"status": "deleted", "id": generation_id}


@app.delete("/history")
async def delete_all_history(db: Session = Depends(get_db)):
    records = db.query(Generation).all()

    for record in records:
        file_path = STORAGE_DIR / record.image_path
        if file_path.exists():
            file_path.unlink()
        db.delete(record)

    db.commit()

    return {"status": "deleted", "count": len(records)}


# ---------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": image_service.is_loaded(),
        "inpaint_model_loaded": image_service.is_inpaint_loaded(),
    }


# ---------------------------------------------------------------------
# Generation endpoints — all persist to history, no auth required
# ---------------------------------------------------------------------


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=500)
    width: int = Field(default=768, ge=256, le=1024)
    height: int = Field(default=768, ge=256, le=1024)


class GenerateResponse(BaseModel):
    image_url: str
    width: int
    height: int
    seconds_taken: float


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest, db: Session = Depends(get_db)):
    if not image_service.is_loaded():
        raise HTTPException(status_code=503, detail="Model is still loading.")

    try:
        result = await image_service.generate_image(
            prompt=req.prompt,
            width=req.width,
            height=req.height,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    image_url = _save_generation(
        db, "generate", req.prompt, result.image_base64, result.seconds_taken,
    )

    return GenerateResponse(
        image_url=image_url,
        width=result.width,
        height=result.height,
        seconds_taken=result.seconds_taken,
    )


@app.post("/inpaint", response_model=GenerateResponse)
async def inpaint(
    image: UploadFile = File(...),
    mask: UploadFile = File(...),
    prompt: str = Form(..., min_length=1, max_length=500),
    db: Session = Depends(get_db),
):
    if not image_service.is_inpaint_loaded():
        try:
            image_service.load_inpaint_pipeline()
        except Exception as e:
            raise HTTPException(
                status_code=503,
                detail=f"Failed to load inpainting model: {e}",
            )

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    image_bytes = await image.read()
    mask_bytes = await mask.read()
    if not image_bytes or not mask_bytes:
        raise HTTPException(status_code=400, detail="Image or mask is empty.")

    try:
        result = await image_service.inpaint_image(
            image_bytes=image_bytes,
            mask_bytes=mask_bytes,
            prompt=prompt,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    image_url = _save_generation(
        db, "inpaint", prompt, result.image_base64, result.seconds_taken,
    )

    return GenerateResponse(
        image_url=image_url,
        width=result.width,
        height=result.height,
        seconds_taken=result.seconds_taken,
    )


@app.post("/edit", response_model=GenerateResponse)
async def edit(
    image: UploadFile = File(...),
    prompt: str = Form(..., min_length=1, max_length=500),
    strength: float = Form(default=0.6, ge=0.1, le=1.0),
    db: Session = Depends(get_db),
):
    if not image_service.is_loaded():
        raise HTTPException(status_code=503, detail="Model is still loading.")

    if not image.content_type or not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="Uploaded file must be an image.")

    image_bytes = await image.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="Uploaded image is empty.")

    try:
        result = await image_service.edit_image(
            image_bytes=image_bytes,
            prompt=prompt,
            strength=strength,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    image_url = _save_generation(
        db, "repaint", prompt, result.image_base64, result.seconds_taken,
    )

    return GenerateResponse(
        image_url=image_url,
        width=result.width,
        height=result.height,
        seconds_taken=result.seconds_taken,
    )