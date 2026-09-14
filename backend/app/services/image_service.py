"""
Image generation service.

Loads SDXL Turbo once at startup and keeps it resident in memory.
Enforces single-request concurrency on the GPU via an asyncio.Lock,
since 16GB unified memory cannot safely handle overlapping generations.
"""

import asyncio
import base64
import io
import time
from dataclasses import dataclass

import torch
from diffusers import AutoPipelineForText2Image
from PIL import Image

MODEL_ID = "stabilityai/sdxl-turbo"

# Only one generation may run on the GPU at a time.
_generation_lock = asyncio.Lock()

_pipe = None


@dataclass
class GenerationResult:
    image_base64: str
    width: int
    height: int
    seconds_taken: float


def _get_device() -> str:
    if torch.backends.mps.is_available():
        return "mps"
    if torch.cuda.is_available():
        return "cuda"
    return "cpu"


def load_pipeline() -> None:
    """
    Loads the SDXL Turbo pipeline into memory. Call this once at
    application startup, not per-request — loading takes real time
    and repeated loads will exhaust memory fast.
    """
    global _pipe

    if _pipe is not None:
        return

    device = _get_device()
    print(f"[image_service] Loading {MODEL_ID} on device={device} ...")

    dtype = torch.float16 if device in ("mps", "cuda") else torch.float32

    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL_ID,
        torch_dtype=dtype,
        variant="fp16" if device in ("mps", "cuda") else None,
    )
    pipe = pipe.to(device)

    # Memory optimizations — required at 16GB unified memory.
    pipe.enable_attention_slicing()
    try:
        pipe.enable_vae_slicing()
        pipe.enable_vae_tiling()
    except AttributeError:
        # Older diffusers versions may not expose these on every pipeline.
        pass

    _pipe = pipe
    print("[image_service] Pipeline loaded and ready.")


def is_loaded() -> bool:
    return _pipe is not None


async def generate_image(
    prompt: str,
    width: int = 768,
    height: int = 768,
    num_inference_steps: int = 2,
    guidance_scale: float = 0.0,
) -> GenerationResult:
    """
    Runs text-to-image generation. SDXL Turbo is trained for very few
    steps (1-4) and guidance_scale=0 — do not raise these casually,
    it will not improve quality and will only slow things down.
    """
    if _pipe is None:
        raise RuntimeError(
            "Pipeline not loaded. Call load_pipeline() at startup first."
        )

    async with _generation_lock:
        start = time.time()

        # Run the blocking diffusion call in a worker thread so it
        # doesn't block the FastAPI event loop.
        def _run():
            result = _pipe(
                prompt=prompt,
                width=width,
                height=height,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
            )
            return result.images[0]

        image: Image.Image = await asyncio.to_thread(_run)
        elapsed = time.time() - start

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("utf-8")

    return GenerationResult(
        image_base64=encoded,
        width=image.width,
        height=image.height,
        seconds_taken=round(elapsed, 2),
    )
