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
from diffusers import (
    AutoPipelineForText2Image,
    AutoPipelineForInpainting,
)
from PIL import Image, ImageFilter

MODEL_ID = "stabilityai/sdxl-turbo"
INPAINT_MODEL_ID = "diffusers/stable-diffusion-xl-1.0-inpainting-0.1"
IP_ADAPTER_REPO = "h94/IP-Adapter"
IP_ADAPTER_WEIGHT = "ip-adapter_sdxl.bin"

# Only one generation may run on the GPU at a time — shared across
# text2img, inpainting, and reference-conditioned generation since they
# use the same underlying weights.
_generation_lock = asyncio.Lock()

_pipe = None
_inpaint_pipe = None
_ref_pipe = None


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
    print("[image_service] Text2img pipeline loaded and ready.")

    # NOTE: the inpainting pipeline is intentionally NOT loaded here.
    # It uses a separate, higher-quality checkpoint (not Turbo) for
    # realistic results, which costs significant extra memory — so it's
    # loaded lazily on first use via load_inpaint_pipeline(), rather
    # than adding that cost to every startup regardless of whether
    # inpainting is even used this session.


def load_inpaint_pipeline() -> None:
    """
    Loads a DEDICATED SDXL inpainting checkpoint — not Turbo — because
    Turbo's speed distillation caps achievable detail/realism no matter
    how the pipeline is tuned. This uses real step counts and real
    classifier-free guidance for actually realistic results.

    This is a separate ~7GB download from SDXL Turbo and a separate set
    of weights in memory (not shared via from_pipe), so it's called
    lazily on first inpaint request rather than at startup — keep this
    in mind on 16GB machines: running this alongside the Turbo
    pipelines is more memory pressure than Phase 1/2 had.
    """
    global _inpaint_pipe

    if _inpaint_pipe is not None:
        return

    device = _get_device()
    print(f"[image_service] Loading {INPAINT_MODEL_ID} on device={device} "
          f"(first call — this downloads ~7GB and may take a while) ...")

    dtype = torch.float16 if device in ("mps", "cuda") else torch.float32

    pipe = AutoPipelineForInpainting.from_pretrained(
        INPAINT_MODEL_ID,
        torch_dtype=dtype,
        variant="fp16" if device in ("mps", "cuda") else None,
    )
    pipe = pipe.to(device)

    pipe.enable_attention_slicing()
    try:
        pipe.enable_vae_slicing()
        pipe.enable_vae_tiling()
    except AttributeError:
        pass

    _inpaint_pipe = pipe
    print("[image_service] Quality inpainting pipeline loaded and ready.")


def is_loaded() -> bool:
    return _pipe is not None


def is_inpaint_loaded() -> bool:
    return _inpaint_pipe is not None


def is_reference_loaded() -> bool:
    return _ref_pipe is not None


def load_reference_pipeline() -> None:
    """
    Loads an IP-Adapter on TOP of the already-loaded Turbo weights
    (shared, not duplicated, via from_pipe) so text2img can also accept
    a reference image for style/character conditioning. Lazy-loaded on
    first use of the reference-image feature — adds a modest extra
    download (image encoder + adapter weights, a few hundred MB), not a
    whole second model.
    """
    global _ref_pipe

    if _ref_pipe is not None:
        return
    if _pipe is None:
        raise RuntimeError("Base pipeline not loaded. Call load_pipeline() first.")

    print(f"[image_service] Loading IP-Adapter ({IP_ADAPTER_REPO}) for "
          f"reference-image conditioning (first call — downloads weights) ...")

    ref_pipe = AutoPipelineForText2Image.from_pipe(_pipe)
    ref_pipe.load_ip_adapter(
        IP_ADAPTER_REPO,
        subfolder="sdxl_models",
        weight_name=IP_ADAPTER_WEIGHT,
    )
    _ref_pipe = ref_pipe
    print("[image_service] Reference-image pipeline ready.")


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


async def inpaint_image(
    image_bytes: bytes,
    mask_bytes: bytes,
    prompt: str,
    num_inference_steps: int = 30,
    guidance_scale: float = 8.0,
    mask_blur: int = 8,
    negative_prompt: str = "blurry, low quality, distorted, deformed, bad anatomy, artifacts",
) -> GenerationResult:
    """
    Runs masked inpainting using a DEDICATED inpainting checkpoint with
    real diffusion steps and real classifier-free guidance — this is
    what actually produces realistic detail, unlike Turbo's 1-4 step
    distilled shortcuts. Expect ~1-2 minutes per edit on a 16GB Mac in
    exchange for meaningfully better quality.

    Only the WHITE regions of the mask are regenerated; everything
    under BLACK stays close to the original pixels.

    `mask_bytes` must be a PNG where white = edit this area,
    black = keep as-is. A grayscale/RGB mask works too; it's converted
    to a single-channel "L" mask internally.
    """
    if _inpaint_pipe is None:
        raise RuntimeError(
            "Inpainting pipeline not loaded. Call load_inpaint_pipeline() first."
        )

    async with _generation_lock:
        start = time.time()

        def _run():
            source = Image.open(io.BytesIO(image_bytes))
            source = _resize_for_model(source)
            w, h = source.size

            mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
            mask = mask.resize((w, h))
            # Soften mask edges so the inpainted region blends instead
            # of showing a hard seam.
            if mask_blur > 0:
                mask = mask.filter(ImageFilter.GaussianBlur(mask_blur))

            result = _inpaint_pipe(
                prompt=prompt,
                negative_prompt=negative_prompt,
                image=source,
                mask_image=mask,
                width=w,
                height=h,
                num_inference_steps=num_inference_steps,
                guidance_scale=guidance_scale,
                strength=0.99,
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


def _resize_for_model(image: Image.Image, max_dim: int = 768) -> Image.Image:
    """
    Downscales large uploads before feeding them to the model — running
    inpainting on a huge uploaded photo will blow past 16GB fast. SDXL
    also expects dimensions divisible by 8.
    """
    image = image.convert("RGB")
    w, h = image.size
    scale = min(max_dim / max(w, h), 1.0)
    new_w = int(w * scale) // 8 * 8
    new_h = int(h * scale) // 8 * 8
    return image.resize((max(new_w, 8), max(new_h, 8)))


async def generate_with_reference(
    prompt: str,
    reference_image_bytes: bytes,
    reference_strength: float = 0.6,
    width: int = 768,
    height: int = 768,
    num_inference_steps: int = 2,
    guidance_scale: float = 0.0,
) -> GenerationResult:
    """
    Text-to-image generation conditioned on a reference image (style or
    character likeness) via IP-Adapter, on top of the text prompt.
    `reference_strength` (0.0-1.0) controls how strongly the reference
    image influences the result — low values lean on the prompt more,
    high values copy the reference's style/content more aggressively.
    """
    if _ref_pipe is None:
        raise RuntimeError(
            "Reference pipeline not loaded. Call load_reference_pipeline() first."
        )

    async with _generation_lock:
        start = time.time()

        def _run():
            ref_image = Image.open(io.BytesIO(reference_image_bytes)).convert("RGB")
            _ref_pipe.set_ip_adapter_scale(reference_strength)
            result = _ref_pipe(
                prompt=prompt,
                ip_adapter_image=ref_image,
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


async def upscale_image(image_bytes: bytes, factor: int = 2) -> GenerationResult:
    """
    Simple Lanczos upscale — NOT AI super-resolution. This resizes with
    a high-quality resampling filter, which sharpens edges reasonably
    but does not invent new detail the way a model like Real-ESRGAN
    would. It's fast (CPU-only, no GPU/model involved) and fine for
    "make this bigger for printing/sharing"; if you want actual
    AI-upscaled detail later, that's a separate model to add.
    """
    start = time.time()

    def _run():
        image = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        new_size = (image.width * factor, image.height * factor)
        return image.resize(new_size, Image.LANCZOS)

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