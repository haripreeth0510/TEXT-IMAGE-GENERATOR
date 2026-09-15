"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = "http://localhost:8000";

type Mode = "generate" | "repaint" | "inpaint";

export default function Home() {
  const [mode, setMode] = useState<Mode>("generate");

  // Shared result state
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  // Generate tab state
  const [prompt, setPrompt] = useState("");

  // Repaint (img2img) tab state
  const [repaintPrompt, setRepaintPrompt] = useState("");
  const [strength, setStrength] = useState(0.6);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Inpaint tab state
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [inpaintFile, setInpaintFile] = useState<File | null>(null);
  const [inpaintPreview, setInpaintPreview] = useState<string | null>(null);
  const [brushSize, setBrushSize] = useState(40);
  const [hasMaskStrokes, setHasMaskStrokes] = useState(false);
  const inpaintFileInputRef = useRef<HTMLInputElement>(null);
  const imageCanvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const [canvasDims, setCanvasDims] = useState({ w: 0, h: 0 });

  function resetResult() {
    setError(null);
    setImageSrc(null);
    setSeconds(null);
  }

  // ---------- Generate ----------
  async function handleGenerate() {
    if (!prompt.trim()) return;
    setLoading(true);
    resetResult();
    try {
      const res = await fetch(`${API_URL}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, width: 768, height: 768 }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setImageSrc(`data:image/png;base64,${data.image_base64}`);
      setSeconds(data.seconds_taken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Repaint (img2img) ----------
  function handleRepaintFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    resetResult();
    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleRepaint() {
    if (!uploadFile || !repaintPrompt.trim()) return;
    setLoading(true);
    resetResult();
    try {
      const formData = new FormData();
      formData.append("image", uploadFile);
      formData.append("prompt", repaintPrompt);
      formData.append("strength", String(strength));
      const res = await fetch(`${API_URL}/edit`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setImageSrc(`data:image/png;base64,${data.image_base64}`);
      setSeconds(data.seconds_taken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Inpaint (masked edit) ----------
  function handleInpaintFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setInpaintFile(file);
    resetResult();
    setHasMaskStrokes(false);
    const reader = new FileReader();
    reader.onload = () => setInpaintPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  // Draw the uploaded image onto the base canvas once it's loaded, and
  // size both canvases to match its displayed dimensions.
  useEffect(() => {
    if (!inpaintPreview) return;
    const img = new window.Image();
    img.onload = () => {
      const maxW = 640;
      const scale = Math.min(maxW / img.width, 1);
      const w = Math.round(img.width * scale);
      const h = Math.round(img.height * scale);
      setCanvasDims({ w, h });

      requestAnimationFrame(() => {
        const imgCanvas = imageCanvasRef.current;
        const maskCanvas = maskCanvasRef.current;
        if (!imgCanvas || !maskCanvas) return;

        imgCanvas.width = w;
        imgCanvas.height = h;
        maskCanvas.width = w;
        maskCanvas.height = h;

        const ctx = imgCanvas.getContext("2d");
        ctx?.drawImage(img, 0, 0, w, h);

        const maskCtx = maskCanvas.getContext("2d");
        if (maskCtx) {
          maskCtx.fillStyle = "black";
          maskCtx.fillRect(0, 0, w, h);
        }
      });
    };
    img.src = inpaintPreview;
  }, [inpaintPreview]);

  function getCanvasPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = maskCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function paintAt(x: number, y: number) {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "white";
    ctx.beginPath();
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    setHasMaskStrokes(true);
  }

  function handleMaskMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    isDrawingRef.current = true;
    const { x, y } = getCanvasPos(e);
    paintAt(x, y);
  }

  function handleMaskMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const { x, y } = getCanvasPos(e);
    paintAt(x, y);
  }

  function handleMaskMouseUp() {
    isDrawingRef.current = false;
  }

  function clearMask() {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasMaskStrokes(false);
  }

  async function handleInpaint() {
    if (!inpaintFile || !inpaintPrompt.trim() || !hasMaskStrokes) return;
    const maskCanvas = maskCanvasRef.current;
    if (!maskCanvas) return;

    setLoading(true);
    resetResult();

    try {
      const maskBlob: Blob | null = await new Promise((resolve) =>
        maskCanvas.toBlob((b) => resolve(b), "image/png")
      );
      if (!maskBlob) throw new Error("Could not read the mask you painted.");

      const formData = new FormData();
      formData.append("image", inpaintFile);
      formData.append("mask", maskBlob, "mask.png");
      formData.append("prompt", inpaintPrompt);

      const res = await fetch(`${API_URL}/inpaint`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = await res.json();
      setImageSrc(`data:image/png;base64,${data.image_base64}`);
      setSeconds(data.seconds_taken);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    resetResult();
  }

  const tabs: { key: Mode; label: string }[] = [
    { key: "generate", label: "Generate" },
    { key: "repaint", label: "Repaint" },
    { key: "inpaint", label: "Paint & Edit" },
  ];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-16">
      <h1 className="text-2xl font-semibold mb-2">Nano Banana</h1>
      <p className="text-neutral-500 text-sm mb-8">
        Phase 2 — generate, repaint, or precisely edit
      </p>

      <div className="flex gap-1 mb-8 bg-neutral-900 rounded-lg p-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => switchMode(t.key)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
              mode === t.key
                ? "bg-yellow-400 text-neutral-900"
                : "text-neutral-400 hover:text-neutral-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "generate" && (
        <div className="w-full max-w-xl flex gap-2">
          <input
            className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-4 py-2 outline-none focus:border-neutral-400"
            placeholder="Describe the image you want..."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
          />
          <button
            onClick={handleGenerate}
            disabled={loading || !prompt.trim()}
            className="rounded-md bg-yellow-400 text-neutral-900 font-medium px-5 py-2 disabled:opacity-50"
          >
            {loading ? "Generating..." : "Generate"}
          </button>
        </div>
      )}

      {mode === "repaint" && (
        <div className="w-full max-w-xl flex flex-col gap-4">
          <p className="text-neutral-500 text-xs -mt-2">
            Repaints the whole image guided by your prompt. Good for style
            changes ("make it a painting"), not for precise single-object
            edits — the whole image will shift somewhat. Use "Paint & Edit"
            for that instead.
          </p>

          <div
            onClick={() => fileInputRef.current?.click()}
            className="cursor-pointer rounded-lg border-2 border-dashed border-neutral-700 hover:border-neutral-500 transition flex flex-col items-center justify-center py-8 px-4 text-center"
          >
            {uploadPreview ? (
              <img
                src={uploadPreview}
                alt="Upload preview"
                className="max-h-56 rounded-md"
              />
            ) : (
              <>
                <p className="text-neutral-300 font-medium">
                  Click to upload an image
                </p>
                <p className="text-neutral-500 text-sm mt-1">
                  PNG or JPG, any size
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png, image/jpeg"
              onChange={handleRepaintFileChange}
              className="hidden"
            />
          </div>

          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-4 py-2 outline-none focus:border-neutral-400"
              placeholder="Describe the new style... e.g. 'watercolor painting'"
              value={repaintPrompt}
              onChange={(e) => setRepaintPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRepaint()}
            />
            <button
              onClick={handleRepaint}
              disabled={loading || !uploadFile || !repaintPrompt.trim()}
              className="rounded-md bg-yellow-400 text-neutral-900 font-medium px-5 py-2 disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? "Working..." : "Repaint"}
            </button>
          </div>

          <div className="flex items-center gap-3 text-sm text-neutral-400">
            <span>Subtle</span>
            <input
              type="range"
              min={0.2}
              max={0.9}
              step={0.05}
              value={strength}
              onChange={(e) => setStrength(parseFloat(e.target.value))}
              className="flex-1"
            />
            <span>Strong</span>
            <span className="w-10 text-right text-neutral-300">
              {strength.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {mode === "inpaint" && (
        <div className="w-full max-w-xl flex flex-col gap-4">
          <p className="text-neutral-500 text-xs -mt-2">
            Upload a photo, paint over the area you want to change, and only
            that region will be edited — everything else stays untouched.
          </p>

          {!inpaintPreview && (
            <div
              onClick={() => inpaintFileInputRef.current?.click()}
              className="cursor-pointer rounded-lg border-2 border-dashed border-neutral-700 hover:border-neutral-500 transition flex flex-col items-center justify-center py-8 px-4 text-center"
            >
              <p className="text-neutral-300 font-medium">
                Click to upload an image
              </p>
              <p className="text-neutral-500 text-sm mt-1">
                PNG or JPG, any size
              </p>
              <input
                ref={inpaintFileInputRef}
                type="file"
                accept="image/png, image/jpeg"
                onChange={handleInpaintFileChange}
                className="hidden"
              />
            </div>
          )}

          {inpaintPreview && (
            <>
              <div
                className="relative rounded-lg overflow-hidden border border-neutral-800 mx-auto"
                style={{ width: canvasDims.w || undefined }}
              >
                <canvas
                  ref={imageCanvasRef}
                  className="absolute top-0 left-0"
                />
                <canvas
                  ref={maskCanvasRef}
                  className="relative cursor-crosshair opacity-50"
                  onMouseDown={handleMaskMouseDown}
                  onMouseMove={handleMaskMouseMove}
                  onMouseUp={handleMaskMouseUp}
                  onMouseLeave={handleMaskMouseUp}
                />
              </div>

              <div className="flex items-center gap-3 text-sm text-neutral-400">
                <span>Brush</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  step={5}
                  value={brushSize}
                  onChange={(e) => setBrushSize(parseInt(e.target.value))}
                  className="flex-1"
                />
                <span className="w-10 text-right text-neutral-300">
                  {brushSize}px
                </span>
                <button
                  onClick={clearMask}
                  className="text-neutral-400 hover:text-neutral-200 underline whitespace-nowrap"
                >
                  Clear mask
                </button>
                <button
                  onClick={() => {
                    setInpaintFile(null);
                    setInpaintPreview(null);
                    setHasMaskStrokes(false);
                  }}
                  className="text-neutral-400 hover:text-neutral-200 underline whitespace-nowrap"
                >
                  Change photo
                </button>
              </div>

              <div className="flex gap-2">
                <input
                  className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-4 py-2 outline-none focus:border-neutral-400"
                  placeholder="Describe what should appear in the painted area... e.g. 'a red baseball cap'"
                  value={inpaintPrompt}
                  onChange={(e) => setInpaintPrompt(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleInpaint()}
                />
                <button
                  onClick={handleInpaint}
                  disabled={
                    loading || !inpaintPrompt.trim() || !hasMaskStrokes
                  }
                  className="rounded-md bg-yellow-400 text-neutral-900 font-medium px-5 py-2 disabled:opacity-50 whitespace-nowrap"
                >
                  {loading ? "Editing..." : "Apply Edit"}
                </button>
              </div>
              {!hasMaskStrokes && (
                <p className="text-neutral-600 text-xs -mt-2">
                  Paint over the area you want to change before applying.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {error && <p className="mt-4 text-red-400 text-sm max-w-xl">{error}</p>}

      {seconds !== null && !error && (
        <p className="mt-4 text-neutral-500 text-sm">Done in {seconds}s</p>
      )}

      {imageSrc && (
        <img
          src={imageSrc}
          alt="Result"
          className="mt-6 rounded-lg border border-neutral-800 max-w-xl w-full"
        />
      )}
    </main>
  );
}