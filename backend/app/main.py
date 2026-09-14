from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from app.services import image_service


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Load the model once when the server starts, not per-request.
    image_service.load_pipeline()
    yield


app = FastAPI(title="Nano Banana - Phase 1 API", lifespan=lifespan)

# Allow the local Next.js dev server to call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=500)
    width: int = Field(default=768, ge=256, le=1024)
    height: int = Field(default=768, ge=256, le=1024)


class GenerateResponse(BaseModel):
    image_base64: str
    width: int
    height: int
    seconds_taken: float


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "model_loaded": image_service.is_loaded(),
    }


@app.post("/generate", response_model=GenerateResponse)
async def generate(req: GenerateRequest):
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

    return GenerateResponse(
        image_base64=result.image_base64,
        width=result.width,
        height=result.height,
        seconds_taken=result.seconds_taken,
    )
