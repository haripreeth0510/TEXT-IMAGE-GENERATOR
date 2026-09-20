"use client";

import { useEffect, useRef, useState } from "react";
import { Manrope, IBM_Plex_Mono } from "next/font/google";

const display = Manrope({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-display",
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

const API_URL = "http://localhost:8000";

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

// ---------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------

function GlowBackdrop() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-black">
      <div className="absolute inset-0 opacity-[0.05] [background-image:radial-gradient(circle,#fff_1px,transparent_1px)] [background-size:22px_22px]" />
      <div
        className="absolute -bottom-40 -left-40 w-[560px] h-[560px] rounded-full opacity-70 blur-[110px]"
        style={{
          background:
            "radial-gradient(circle, #7C3AED 0%, #4C1D95 45%, transparent 70%)",
        }}
      />
      <div
        className="absolute -bottom-32 right-[-10%] w-[620px] h-[620px] rounded-full opacity-60 blur-[120px]"
        style={{
          background:
            "radial-gradient(circle, #22D3EE 0%, #1D4ED8 50%, transparent 70%)",
        }}
      />
      <div
        className="absolute top-[-20%] left-[30%] w-[420px] h-[420px] rounded-full opacity-30 blur-[130px]"
        style={{
          background:
            "radial-gradient(circle, #A78BFA 0%, transparent 70%)",
        }}
      />
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${
        active
          ? "bg-white text-black"
          : "text-white/60 hover:text-white/90 border border-white/15"
      }`}
    >
      {children}
    </button>
  );
}

export default function Home() {
  const [mode, setMode] = useState<Mode>("generate");

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  const [currentImage, setCurrentImage] = useState<string | null>(null);
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

  // ---------- Download / Upscale ----------
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
    const reader = new FileReader();
    reader.onload = () => setInpaintPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  useEffect(() => {
    if (!inpaintPreview) return;
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      const maxW = 560;
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
      const inverted = 255 - px[i];
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

  // ---------- History ----------
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
    setHistory((h) => h.filter((item) => item.id !== id));
    try {
      const res = await fetch(`${API_URL}/history/${id}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not delete that print.");
    } catch (err) {
      setHistory(previous);
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function deleteAllHistory() {
    if (!window.confirm("Clear your whole print box? This can't be undone.")) {
      return;
    }
    const previous = history;
    setHistory([]);
    try {
      const res = await fetch(`${API_URL}/history`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not clear your prints.");
    } catch (err) {
      setHistory(previous);
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    resetResult();
    if (next === "history") loadHistory();
  }

  const headline: Record<Mode, { title: string; sub: string }> = {
    generate: {
      title: "Make pictures\nat the speed of thought",
      sub: "Describe anything. It's generated entirely on this machine.",
    },
    inpaint: {
      title: "Retouch\nwithout the guesswork",
      sub: "Paint the part that should change — everything else stays untouched.",
    },
    history: {
      title: "Everything\nyou've made",
      sub: "Every print, kept locally, yours to revisit or clear.",
    },
  };

  return (
    <main
      className={`min-h-screen text-white ${display.variable} ${mono.variable}`}
      style={{ fontFamily: "var(--font-display)" }}
    >
      <GlowBackdrop />

      {/* Top bar */}
      <div className="flex items-center justify-between px-6 md:px-10 py-6">
        <div className="flex items-center gap-2">
          <span className="text-lg font-extrabold tracking-tight">
            PicDrop
          </span>
          <span
            className="text-[10px] px-2 py-0.5 rounded-full border border-white/20 text-white/60"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            local
          </span>
        </div>
        <nav className="flex items-center gap-2">
          <Pill active={mode === "generate"} onClick={() => switchMode("generate")}>
            Develop
          </Pill>
          <Pill active={mode === "inpaint"} onClick={() => switchMode("inpaint")}>
            Retouch
          </Pill>
          <Pill active={mode === "history"} onClick={() => switchMode("history")}>
            Prints
          </Pill>
        </nav>
      </div>

      {/* Hero */}
      <div className="flex flex-col items-center text-center px-6 pt-10 md:pt-16 pb-10">
        <h1 className="text-[2.6rem] leading-[1.05] sm:text-6xl md:text-7xl font-extrabold tracking-tight whitespace-pre-line max-w-3xl">
          {headline[mode].title}
        </h1>
        <p className="mt-5 text-base md:text-lg text-white/60 max-w-xl">
          {headline[mode].sub}
        </p>
      </div>

      {/* Console */}
      <div className="px-6 pb-24 flex flex-col items-center gap-6">
        {/* Current print / undo strip */}
        {currentImage && mode !== "history" && (
          <div className="w-full max-w-2xl flex items-center gap-3 px-4 py-2.5 rounded-2xl bg-white/5 border border-white/10 backdrop-blur">
            <img
              src={currentImage}
              alt="Current print"
              className="w-8 h-8 rounded-lg object-cover"
            />
            <span className="text-xs text-white/50 flex-1">
              Current print — Retouch can continue from this
            </span>
            <button
              onClick={handleUndo}
              disabled={undoStack.length === 0}
              className="text-xs font-medium disabled:opacity-30 text-white/80 hover:text-white"
            >
              Undo
            </button>
          </div>
        )}

        {/* ---------------- Develop console ---------------- */}
        {mode === "generate" && (
          <div className="w-full max-w-2xl rounded-[2rem] bg-white/[0.06] border border-white/10 backdrop-blur-xl p-2 shadow-[0_0_80px_-20px_rgba(124,58,237,0.5)]">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A lighthouse at dusk, storm rolling in..."
              rows={3}
              className="w-full bg-transparent outline-none resize-none px-4 pt-4 pb-2 text-lg placeholder-white/35"
            />

            {useReference && (
              <div className="px-4 pb-2 flex flex-col gap-3">
                <div
                  onClick={() => referenceInputRef.current?.click()}
                  className="cursor-pointer border border-dashed border-white/15 rounded-xl flex flex-col items-center justify-center py-5 px-4 text-center"
                >
                  {referencePreview ? (
                    <img
                      src={referencePreview}
                      alt="Reference preview"
                      className="max-h-32 rounded-lg"
                    />
                  ) : (
                    <p className="text-sm text-white/50">
                      Upload a reference image
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
                <div className="flex items-center gap-3 text-xs text-white/50">
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
                    className="flex-1 accent-violet-400"
                  />
                  <span>strict</span>
                  <span className="w-9 text-right text-white/70">
                    {referenceStrength.toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between px-3 pb-2 pt-1">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setUseReference(!useReference);
                    if (useReference) {
                      setReferenceFile(null);
                      setReferencePreview(null);
                    }
                  }}
                  className={`w-9 h-9 rounded-full flex items-center justify-center text-lg border transition-colors ${
                    useReference
                      ? "bg-white text-black border-white"
                      : "border-white/15 text-white/60 hover:text-white"
                  }`}
                  title="Guide with a reference image"
                >
                  +
                </button>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(parseInt(e.target.value))}
                  className="bg-white/10 border border-white/10 rounded-full px-3 py-1.5 text-xs outline-none"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  <option value={512}>512px</option>
                  <option value={768}>768px</option>
                  <option value={1024}>1024px</option>
                </select>
              </div>

              <button
                onClick={handleGenerate}
                disabled={
                  loading || !prompt.trim() || (useReference && !referenceFile)
                }
                className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center disabled:opacity-30 transition-transform active:scale-95"
                title={loading ? "Developing…" : "Develop image"}
              >
                {loading ? (
                  <span className="w-3.5 h-3.5 rounded-full border-2 border-black/30 border-t-black animate-spin" />
                ) : (
                  "↑"
                )}
              </button>
            </div>
          </div>
        )}

        {/* ---------------- Retouch console ---------------- */}
        {mode === "inpaint" && (
          <div className="w-full max-w-2xl rounded-[2rem] bg-white/[0.06] border border-white/10 backdrop-blur-xl p-5 shadow-[0_0_80px_-20px_rgba(34,211,238,0.45)] flex flex-col gap-4">
            {!inpaintPreview && (
              <>
                <div
                  onClick={() => inpaintFileInputRef.current?.click()}
                  className="cursor-pointer border border-dashed border-white/15 rounded-2xl flex flex-col items-center justify-center py-14 px-4 text-center"
                >
                  <p className="text-white/60">Click to bring in a photo</p>
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
                    className="text-sm text-white/70 hover:text-white self-start"
                  >
                    Continue from the current print instead
                  </button>
                )}
              </>
            )}

            {inpaintPreview && (
              <>
                <div
                  className="relative mx-auto rounded-xl overflow-hidden border border-white/10"
                  style={{ width: canvasDims.w || undefined }}
                >
                  <canvas ref={imageCanvasRef} className="absolute top-0 left-0" />
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
                  className="flex items-center gap-3 text-xs text-white/50 flex-wrap"
                  style={{ fontFamily: "var(--font-mono)" }}
                >
                  <span>brush</span>
                  <input
                    type="range"
                    min={10}
                    max={100}
                    step={5}
                    value={brushSize}
                    onChange={(e) => setBrushSize(parseInt(e.target.value))}
                    className="flex-1 min-w-[80px] accent-cyan-300"
                  />
                  <span className="w-10 text-right text-white/70">
                    {brushSize}px
                  </span>
                  <button onClick={clearMask} className="hover:text-white">
                    clear
                  </button>
                  <button onClick={invertMask} className="hover:text-white">
                    invert
                  </button>
                  <button
                    onClick={() => {
                      setInpaintFile(null);
                      setInpaintPreview(null);
                      setHasMaskStrokes(false);
                    }}
                    className="hover:text-white"
                  >
                    change photo
                  </button>
                </div>

                <div className="flex items-center gap-2 rounded-full bg-white/5 border border-white/10 pl-4 pr-1.5 py-1.5">
                  <input
                    className="flex-1 bg-transparent outline-none text-sm placeholder-white/35"
                    placeholder="What should appear here..."
                    value={inpaintPrompt}
                    onChange={(e) => setInpaintPrompt(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleInpaint()}
                  />
                  <button
                    onClick={handleInpaint}
                    disabled={loading || !inpaintPrompt.trim() || !hasMaskStrokes}
                    className="w-9 h-9 rounded-full bg-white text-black flex items-center justify-center disabled:opacity-30"
                  >
                    {loading ? (
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-black/30 border-t-black animate-spin" />
                    ) : (
                      "↑"
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ---------------- Prints (history) ---------------- */}
        {mode === "history" && (
          <div className="w-full max-w-4xl">
            {history.length > 0 && (
              <div className="flex justify-end mb-4">
                <button
                  onClick={deleteAllHistory}
                  className="text-xs text-white/40 hover:text-red-400"
                >
                  clear all
                </button>
              </div>
            )}

            {historyLoading && (
              <p className="text-sm text-white/50 text-center">
                Loading your prints…
              </p>
            )}
            {!historyLoading && history.length === 0 && (
              <p className="text-sm text-white/50 text-center">
                Nothing developed yet.
              </p>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {history.map((item) => (
                <div
                  key={item.id}
                  className="relative group rounded-2xl overflow-hidden bg-white/5 border border-white/10"
                >
                  <button
                    onClick={() => deleteHistoryItem(item.id)}
                    className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-black/60 text-white/80 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-xs"
                  >
                    ×
                  </button>
                  <img
                    src={`${API_URL}${item.image_url}`}
                    alt={item.prompt}
                    className="w-full aspect-square object-cover"
                  />
                  <div className="p-2.5">
                    <p
                      className="text-[10px] uppercase tracking-wide text-white/35 mb-0.5"
                      style={{ fontFamily: "var(--font-mono)" }}
                    >
                      {item.mode}
                    </p>
                    <p className="text-xs text-white/70 line-clamp-2">
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
          <p className="text-sm max-w-xl px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/25 text-red-300">
            {error}
          </p>
        )}

        {seconds !== null && !error && mode !== "history" && (
          <p
            className="text-xs text-white/40"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            done in {seconds}s
          </p>
        )}

        {imageSrc && mode !== "history" && (
          <div className="w-full max-w-xl flex flex-col items-center gap-3">
            <img
              src={imageSrc}
              alt="Result"
              className="w-full rounded-2xl border border-white/10 shadow-[0_0_60px_-20px_rgba(124,58,237,0.6)]"
            />
            <div className="flex gap-5">
              <button
                onClick={handleDownload}
                className="text-xs text-white/50 hover:text-white"
              >
                download
              </button>
              <button
                onClick={handleUpscale}
                disabled={loading}
                className="text-xs text-white/50 hover:text-white disabled:opacity-40"
              >
                upscale 2×
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}