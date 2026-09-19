"use client";

import { useEffect, useRef, useState } from "react";
import { Fraunces, IBM_Plex_Mono } from "next/font/google";

const display = Fraunces({
  subsets: ["latin"],
  weight: ["500", "600"],
  style: ["normal", "italic"],
  variable: "--font-display",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

const API_URL = "http://localhost:8000";

// ---------------------------------------------------------------------
// Palette (kept as constants rather than a Tailwind config change, so
// this file stays a drop-in single-file replacement)
// ---------------------------------------------------------------------
const c = {
  bg: "#14100D",
  panel: "#1C1712",
  panelAlt: "#211B15",
  border: "#2A231C",
  borderLit: "#4A3B2C",
  accent: "#D62828",
  accentHover: "#B01F1F",
  accentDim: "#7A2020",
  cream: "#F2E9DC",
  muted: "#9C8F7E",
  mutedDim: "#6B6153",
};

type Mode = "generate" | "inpaint" | "history";

type HistoryItem = {
  id: string;
  mode: string;
  prompt: string;
  image_url: string;
  seconds_taken: string | null;
  created_at: string;
};

async function urlToFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new File([blob], filename, { type: blob.type || "image/png" });
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("generate");

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  // The current "working" image for the conversation — whatever the
  // last successful generate/inpaint produced. Retouch can continue
  // from this instead of requiring a fresh upload, which is what makes
  // edits feel conversational.
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  // Stack of previous currentImage values, most recent last — Undo
  // pops from here. This only affects what's shown/continued from on
  // screen; nothing is deleted from Prints or storage/.
  const [undoStack, setUndoStack] = useState<string[]>([]);

  const [prompt, setPrompt] = useState("");
  const [resolution, setResolution] = useState(768);
  const [useReference, setUseReference] = useState(false);
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [referencePreview, setReferencePreview] = useState<string | null>(
    null
  );
  const [referenceStrength, setReferenceStrength] = useState(0.6);
  const referenceInputRef = useRef<HTMLInputElement>(null);

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

  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  function resetResult() {
    setError(null);
    setImageSrc(null);
    setSeconds(null);
  }

  // Call this after any successful generate/inpaint — advances
  // the working image and records what it replaced so Undo can go back.
  function advanceSession(newImageUrl: string) {
    setUndoStack((stack) =>
      currentImage ? [...stack, currentImage] : stack
    );
    setCurrentImage(newImageUrl);
  }

  function handleUndo() {
    if (undoStack.length === 0) return;
    const previous = undoStack[undoStack.length - 1];
    setUndoStack((stack) => stack.slice(0, -1));
    setCurrentImage(previous);
    setImageSrc(previous);
    setSeconds(null);
    setError(null);
  }

  // ---------- Generate ----------
  function handleReferenceFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setReferenceFile(file);
    const reader = new FileReader();
    reader.onload = () => setReferencePreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function handleGenerate() {
    if (!prompt.trim()) return;
    if (useReference && !referenceFile) return;
    setLoading(true);
    resetResult();
    try {
      let res: Response;
      if (useReference && referenceFile) {
        const formData = new FormData();
        formData.append("reference", referenceFile);
        formData.append("prompt", prompt);
        formData.append("reference_strength", String(referenceStrength));
        formData.append("width", String(resolution));
        formData.append("height", String(resolution));
        res = await fetch(`${API_URL}/generate/reference`, {
          method: "POST",
          body: formData,
        });
      } else {
        res = await fetch(`${API_URL}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            width: resolution,
            height: resolution,
          }),
        });
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = await res.json();
      const url = `${API_URL}${data.image_url}`;
      setImageSrc(url);
      setSeconds(data.seconds_taken);
      advanceSession(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Download / Upscale (shared result actions) ----------
  async function handleDownload() {
    if (!imageSrc) return;
    const res = await fetch(imageSrc);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = `picdrop-${Date.now()}.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleUpscale() {
    if (!imageSrc) return;
    setLoading(true);
    setError(null);
    try {
      const file = await urlToFile(imageSrc, "upscale-source.png");
      const formData = new FormData();
      formData.append("image", file);
      formData.append("factor", "2");
      const res = await fetch(`${API_URL}/upscale`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `Request failed (${res.status})`);
      }
      const data = await res.json();
      const url = `${API_URL}${data.image_url}`;
      setImageSrc(url);
      setSeconds(data.seconds_taken);
      advanceSession(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Inpaint ----------
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

  async function useCurrentForInpaint() {
    if (!currentImage) return;
    resetResult();
    setHasMaskStrokes(false);
    const file = await urlToFile(currentImage, "current.png");
    setInpaintFile(file);
    // Route through FileReader (data: URL) rather than using the
    // backend URL directly — a cross-origin <img> drawn onto canvas
    // taints it and breaks maskCanvas.toBlob() later.
    const reader = new FileReader();
    reader.onload = () => setInpaintPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!inpaintPreview) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
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

  function invertMask() {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!ctx || !canvas) return;
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const px = imageData.data;
    for (let i = 0; i < px.length; i += 4) {
      const inverted = 255 - px[i]; // mask is grayscale strokes on black
      px[i] = inverted;
      px[i + 1] = inverted;
      px[i + 2] = inverted;
      px[i + 3] = 255;
    }
    ctx.putImageData(imageData, 0, 0);
    setHasMaskStrokes(true);
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
      const url = `${API_URL}${data.image_url}`;
      setImageSrc(url);
      setSeconds(data.seconds_taken);
      advanceSession(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  // ---------- Prints (history) ----------
  async function loadHistory() {
    setHistoryLoading(true);
    try {
      const res = await fetch(`${API_URL}/history`);
      if (!res.ok) throw new Error("Could not load your prints.");
      const data = await res.json();
      setHistory(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function deleteHistoryItem(id: string) {
    const previous = history;
    setHistory((h) => h.filter((item) => item.id !== id)); // optimistic
    try {
      const res = await fetch(`${API_URL}/history/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not delete that print.");
    } catch (err) {
      setHistory(previous); // revert on failure
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function deleteAllHistory() {
    if (
      !window.confirm("Clear your whole print box? This can't be undone.")
    ) {
      return;
    }
    const previous = history;
    setHistory([]); // optimistic
    try {
      const res = await fetch(`${API_URL}/history`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not clear your prints.");
    } catch (err) {
      setHistory(previous); // revert on failure
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    resetResult();
    if (next === "history") loadHistory();
  }

  const rail: { key: Mode; label: string; hint: string }[] = [
    { key: "generate", label: "Develop", hint: "prompt to picture" },
    { key: "inpaint", label: "Retouch", hint: "paint a change" },
    { key: "history", label: "Prints", hint: "everything you've made" },
  ];

  return (
    <main
      className={`min-h-screen flex flex-col md:flex-row ${display.variable} ${mono.variable}`}
      style={{ backgroundColor: c.bg, color: c.cream, ...monoStyle }}
    >
      {/* ---------------- Rail ---------------- */}
      <aside
        className="w-full md:w-64 md:min-h-screen border-b md:border-b-0 md:border-r px-6 py-6 md:py-10 flex flex-col gap-8 md:gap-12"
        style={{ borderColor: c.border }}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="inline-block w-2 h-2 rounded-full"
            style={{
              backgroundColor: c.accent,
              boxShadow: `0 0 10px 2px ${c.accent}66`,
            }}
          />
          <h1
            className="text-2xl leading-none"
            style={{ ...displayStyle, fontWeight: 600 }}
          >
            PicDrop
          </h1>
        </div>

        <p className="text-xs leading-relaxed" style={{ color: c.muted }}>
          A private darkroom for generated pictures. Every image is made and
          kept on this machine.
        </p>

        <nav className="flex flex-row md:flex-col gap-1 -mx-2">
          {rail.map((r) => {
            const active = mode === r.key;
            return (
              <button
                key={r.key}
                onClick={() => switchMode(r.key)}
                className="text-left px-3 py-2.5 border-l-2 md:border-l-2 transition-colors"
                style={{
                  borderColor: active ? c.accent : "transparent",
                  backgroundColor: active ? c.panel : "transparent",
                }}
              >
                <span
                  className="block text-sm"
                  style={{ color: active ? c.cream : c.muted }}
                >
                  {r.label}
                </span>
                <span
                  className="hidden md:block text-[11px] mt-0.5"
                  style={{ color: c.mutedDim }}
                >
                  {r.hint}
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      {/* ---------------- Workbench ---------------- */}
      <section className="flex-1 px-6 py-10 md:px-14 md:py-14 flex flex-col items-start gap-6 max-w-3xl">
        {/* Current print / undo strip */}
        {currentImage && mode !== "history" && (
          <div
            className="w-full max-w-xl flex items-center gap-3 px-3 py-2 border"
            style={{ backgroundColor: c.panel, borderColor: c.border }}
          >
            <img
              src={currentImage}
              alt="Current print"
              className="w-9 h-9 object-cover"
              style={{ border: `1px solid ${c.border}` }}
            />
            <span className="text-[11px] flex-1" style={{ color: c.mutedDim }}>
              Current print — Retouch can continue from this
            </span>
            <button
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              className="text-xs whitespace-nowrap disabled:opacity-30"
              style={{ color: undoStack.length ? c.accent : c.mutedDim }}
            >
              Undo
            </button>
          </div>
        )}

        {/* ---------------- Develop ---------------- */}
        {mode === "generate" && (
          <div className="w-full max-w-xl flex flex-col gap-4">
            <div>
              <h2
                className="text-xl mb-1"
                style={{ ...displayStyle, fontWeight: 600 }}
              >
                Develop
              </h2>
              <p className="text-xs" style={{ color: c.mutedDim }}>
                Describe a picture. It's exposed and developed locally.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2">
              <input
                className="flex-1 px-3 py-2.5 text-sm outline-none border"
                style={inputStyle}
                placeholder="A lighthouse at dusk, storm rolling in..."
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleGenerate()}
              />
              <select
                value={resolution}
                onChange={(e) => setResolution(parseInt(e.target.value))}
                className="px-2 text-sm outline-none border"
                style={inputStyle}
              >
                <option value={512}>512px</option>
                <option value={768}>768px</option>
                <option value={1024}>1024px</option>
              </select>
              <button
                onClick={handleGenerate}
                disabled={
                  loading ||
                  !prompt.trim() ||
                  (useReference && !referenceFile)
                }
                className="px-5 py-2.5 text-sm whitespace-nowrap disabled:opacity-40 transition-colors"
                style={primaryButtonStyle}
              >
                {loading ? "Developing…" : "Develop image"}
              </button>
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-sm select-none">
              <input
                type="checkbox"
                checked={useReference}
                onChange={(e) => {
                  setUseReference(e.target.checked);
                  if (!e.target.checked) {
                    setReferenceFile(null);
                    setReferencePreview(null);
                  }
                }}
                style={{ accentColor: c.accent }}
              />
              <span style={{ color: c.muted }}>
                Guide it with a reference image
              </span>
            </label>

            {useReference && (
              <div className="flex flex-col gap-3">
                <div
                  onClick={() => referenceInputRef.current?.click()}
                  className="cursor-pointer border border-dashed flex flex-col items-center justify-center py-6 px-4 text-center transition-colors"
                  style={{ borderColor: c.border }}
                >
                  {referencePreview ? (
                    <img
                      src={referencePreview}
                      alt="Reference preview"
                      className="max-h-40"
                    />
                  ) : (
                    <p className="text-sm" style={{ color: c.muted }}>
                      Click to upload a reference image
                    </p>
                  )}
                  <input
                    ref={referenceInputRef}
                    type="file"
                    accept="image/png, image/jpeg"
                    onChange={handleReferenceFileChange}
                    className="hidden"
                  />
                </div>
                <div
                  className="flex items-center gap-3 text-xs"
                  style={{ color: c.mutedDim }}
                >
                  <span>loose</span>
                  <input
                    type="range"
                    min={0.1}
                    max={1}
                    step={0.05}
                    value={referenceStrength}
                    onChange={(e) =>
                      setReferenceStrength(parseFloat(e.target.value))
                    }
                    className="flex-1"
                    style={{ accentColor: c.accent }}
                  />
                  <span>strict</span>
                  <span className="w-10 text-right" style={{ color: c.muted }}>
                    {referenceStrength.toFixed(2)}
                  </span>
                </div>
                <p className="text-[11px]" style={{ color: c.mutedDim }}>
                  Higher strength copies the reference's style/content more
                  aggressively; lower lets the prompt lead.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ---------------- Retouch ---------------- */}
        {mode === "inpaint" && (
          <div className="w-full max-w-xl flex flex-col gap-4">
            <div>
              <h2
                className="text-xl mb-1"
                style={{ ...displayStyle, fontWeight: 600 }}
              >
                Retouch
              </h2>
              <p className="text-xs leading-relaxed" style={{ color: c.mutedDim }}>
                Paint over what should change. For a new background: paint
                around the subject, press Invert, then describe the
                background — the subject stays untouched.
              </p>
            </div>

            {!inpaintPreview && (
              <>
                <div
                  onClick={() => inpaintFileInputRef.current?.click()}
                  className="cursor-pointer border border-dashed flex flex-col items-center justify-center py-10 px-4 text-center transition-colors"
                  style={{ borderColor: c.border }}
                >
                  <p className="text-sm" style={{ color: c.muted }}>
                    Click to bring in a photo
                  </p>
                </div>
                <input
                  ref={inpaintFileInputRef}
                  type="file"
                  accept="image/png, image/jpeg"
                  onChange={handleInpaintFileChange}
                  className="hidden"
                />
                {currentImage && (
                  <button
                    onClick={useCurrentForInpaint}
                    className="text-sm self-start"
                    style={{ color: c.accent }}
                  >
                    Continue from the current print instead
                  </button>
                )}
              </>
            )}

            {inpaintPreview && (
              <>
                <div
                  className="relative mx-auto"
                  style={{
                    width: canvasDims.w || undefined,
                    border: `1px solid ${c.border}`,
                    boxShadow: `0 0 50px -18px ${c.accent}55`,
                  }}
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

                <div
                  className="flex items-center gap-3 text-xs flex-wrap"
                  style={{ color: c.mutedDim }}
                >
                  <span>brush</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={brushSize}
                    onChange={(e) => setBrushSize(parseInt(e.target.value))}
                    className="flex-1 min-w-[80px]"
                    style={{ accentColor: c.accent }}
                  />
                  <span className="w-10 text-right" style={{ color: c.muted }}>
                    {brushSize}px
                  </span>
                  <button onClick={clearMask} style={{ color: c.muted }}>
                    clear
                  </button>
                  <button
                    onClick={invertMask}
                    title="Paint around the subject, then invert to edit the background instead"
                    style={{ color: c.muted }}
                  >
                    invert
                  </button>
                  <button
                    onClick={() => {
                      setInpaintFile(null);
                      setInpaintPreview(null);
                      setHasMaskStrokes(false);
                    }}
                    style={{ color: c.muted }}
                  >
                    change photo
                  </button>
                </div>

                <div className="flex flex-col sm:flex-row gap-2">
                  <input
                    className="flex-1 px-3 py-2.5 text-sm outline-none border"
                    style={inputStyle}
                    placeholder="What should appear here..."
                    value={inpaintPrompt}
                    onChange={(e) => setInpaintPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleInpaint()}
                  />
                  <button
                    onClick={handleInpaint}
                    disabled={
                      loading || !inpaintPrompt.trim() || !hasMaskStrokes
                    }
                    className="px-5 py-2.5 text-sm whitespace-nowrap disabled:opacity-40"
                    style={primaryButtonStyle}
                  >
                    {loading ? "Retouching…" : "Apply"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- Prints (history) ---------------- */}
        {mode === "history" && (
          <div className="w-full max-w-2xl">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2
                  className="text-xl mb-1"
                  style={{ ...displayStyle, fontWeight: 600 }}
                >
                  Prints
                </h2>
                <p className="text-xs" style={{ color: c.mutedDim }}>
                  Everything you've developed, newest first.
                </p>
              </div>
              {history.length > 0 && (
                <button
                  onClick={deleteAllHistory}
                  className="text-xs whitespace-nowrap"
                  style={{ color: c.mutedDim }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = c.accent)
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = c.mutedDim)
                  }
                >
                  clear all
                </button>
              )}
            </div>

            {historyLoading && (
              <p className="text-sm" style={{ color: c.mutedDim }}>
                Loading your prints…
              </p>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="text-sm" style={{ color: c.mutedDim }}>
                Nothing developed yet.
              </p>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {history.map((item, i) => (
                <div
                  key={item.id}
                  className="relative group border"
                  style={{ borderColor: c.border, backgroundColor: c.panel }}
                >
                  <div
                    className="flex items-center justify-between px-2 py-1 text-[10px]"
                    style={{ color: c.mutedDim, borderBottom: `1px solid ${c.border}` }}
                  >
                    <span>
                      No.&nbsp;{String(history.length - i).padStart(3, "0")}
                    </span>
                    <button
                      onClick={() => deleteHistoryItem(item.id)}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      style={{ color: c.accent }}
                    >
                      remove
                    </button>
                  </div>
                  <img
                    src={`${API_URL}${item.image_url}`}
                    alt={item.prompt}
                    className="w-full aspect-square object-cover"
                  />
                  <div className="p-2">
                    <p
                      className="text-[10px] mb-0.5"
                      style={{ color: c.mutedDim }}
                    >
                      {item.mode}
                    </p>
                    <p
                      className="text-xs line-clamp-2"
                      style={{ color: c.muted }}
                    >
                      {item.prompt}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ---------------- Shared result / error ---------------- */}
        {error && (
          <p
            className="text-sm max-w-xl px-3 py-2 border"
            style={{
              color: "#F2A08A",
              backgroundColor: "#2A1210",
              borderColor: c.accentDim,
            }}
          >
            {error}
          </p>
        )}

        {seconds !== null && !error && mode !== "history" && (
          <p className="text-xs" style={{ color: c.mutedDim }}>
            done in {seconds}s
          </p>
        )}

        {imageSrc && mode !== "history" && (
          <>
            <img
              src={imageSrc}
              alt="Result"
              className="max-w-xl w-full"
              style={{
                border: `1px solid ${c.border}`,
                boxShadow: `0 0 60px -18px ${c.accent}55`,
              }}
            />
            <div className="flex gap-4 -mt-2">
              <button
                onClick={handleDownload}
                className="text-xs"
                style={{ color: c.muted }}
              >
                download
              </button>
              <button
                onClick={handleUpscale}
                disabled={loading}
                className="text-xs disabled:opacity-40"
                style={{ color: c.muted }}
              >
                upscale 2×
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------
// Shared inline style objects (kept outside the component body so they
// aren't recreated every render)
// ---------------------------------------------------------------------
const monoStyle = { fontFamily: "var(--font-mono)" } as const;
const displayStyle = { fontFamily: "var(--font-display)" } as const;

const inputStyle = {
  backgroundColor: "#1C1712",
  borderColor: "#2A231C",
  color: "#F2E9DC",
};

const primaryButtonStyle = {
  backgroundColor: "#D62828",
  color: "#F2E9DC",
};