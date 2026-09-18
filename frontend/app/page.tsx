"use client";

import { useEffect, useRef, useState } from "react";

const API_URL = "http://localhost:8000";

type Mode = "generate" | "repaint" | "inpaint" | "history";

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
  // last successful generate/repaint/inpaint produced. Repaint and
  // Paint & Edit can both continue from this instead of requiring a
  // fresh upload, which is what makes edits feel conversational.
  const [currentImage, setCurrentImage] = useState<string | null>(null);
  // Stack of previous currentImage values, most recent last — Undo
  // pops from here. This only affects what's shown/continued from on
  // screen; nothing is deleted from History or storage/.
  const [undoStack, setUndoStack] = useState<string[]>([]);

  const [prompt, setPrompt] = useState("");

  const [repaintPrompt, setRepaintPrompt] = useState("");
  const [strength, setStrength] = useState(0.6);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  // Call this after any successful generate/repaint/inpaint — advances
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

  // ---------- Repaint ----------
  function handleRepaintFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadFile(file);
    resetResult();
    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function useCurrentForRepaint() {
    if (!currentImage) return;
    resetResult();
    const file = await urlToFile(currentImage, "current.png");
    setUploadFile(file);
    setUploadPreview(currentImage);
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
      if (!res.ok) throw new Error("Could not load history.");
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
      if (!res.ok) throw new Error("Could not delete that item.");
    } catch (err) {
      setHistory(previous); // revert on failure
      setError(err instanceof Error ? err.message : "Something went wrong");
    }
  }

  async function deleteAllHistory() {
    if (
      !window.confirm(
        "Delete your entire generation history? This can't be undone."
      )
    ) {
      return;
    }
    const previous = history;
    setHistory([]); // optimistic
    try {
      const res = await fetch(`${API_URL}/history`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not delete history.");
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

  const tabs: { key: Mode; label: string }[] = [
    { key: "generate", label: "Generate" },
    { key: "repaint", label: "Repaint" },
    { key: "inpaint", label: "Paint & Edit" },
    { key: "history", label: "History" },
  ];

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-16">
      <h1 className="text-2xl font-semibold mb-2">Nano Banana</h1>
      <p className="text-neutral-500 text-sm mb-6">
        Phase 4 — generate, repaint, precisely edit, continue the
        conversation, and undo
      </p>

      {/* Session bar: shows the working image and lets you undo */}
      {currentImage && mode !== "history" && (
        <div className="w-full max-w-xl flex items-center gap-3 mb-6 bg-neutral-900 border border-neutral-800 rounded-lg px-3 py-2">
          <img
            src={currentImage}
            alt="Current working image"
            className="w-10 h-10 rounded object-cover"
          />
          <span className="text-neutral-400 text-xs flex-1">
            Working image — use &quot;Continue from this&quot; in Repaint or
            Paint &amp; Edit to keep editing it
          </span>
          <button
            onClick={handleUndo}
            disabled={undoStack.length === 0}
            className="text-neutral-300 hover:text-white text-sm underline disabled:opacity-30 disabled:no-underline whitespace-nowrap"
          >
            Undo
          </button>
        </div>
      )}

      <div className="flex gap-1 mb-8 bg-neutral-900 rounded-lg p-1 flex-wrap justify-center">
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
              <p className="text-neutral-300 font-medium">
                Click to upload an image
              </p>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png, image/jpeg"
              onChange={handleRepaintFileChange}
              className="hidden"
            />
          </div>

          {currentImage && (
            <button
              onClick={useCurrentForRepaint}
              className="text-yellow-400 hover:text-yellow-300 text-sm underline self-start"
            >
              Continue from this — use working image instead
            </button>
          )}

          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-4 py-2 outline-none focus:border-neutral-400"
              placeholder="Describe the new style, or what to change next..."
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
          {!inpaintPreview && (
            <>
              <div
                onClick={() => inpaintFileInputRef.current?.click()}
                className="cursor-pointer rounded-lg border-2 border-dashed border-neutral-700 hover:border-neutral-500 transition flex flex-col items-center justify-center py-8 px-4 text-center"
              >
                <p className="text-neutral-300 font-medium">
                  Click to upload an image
                </p>
                <input
                  ref={inpaintFileInputRef}
                  type="file"
                  accept="image/png, image/jpeg"
                  onChange={handleInpaintFileChange}
                  className="hidden"
                />
              </div>
              {currentImage && (
                <button
                  onClick={useCurrentForInpaint}
                  className="text-yellow-400 hover:text-yellow-300 text-sm underline self-start"
                >
                  Continue from this — use working image instead
                </button>
              )}
            </>
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
                  placeholder="Describe what should appear in the painted area..."
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
            </>
          )}
        </div>
      )}

      {mode === "history" && (
        <div className="w-full max-w-xl">
          {history.length > 0 && (
            <div className="flex justify-end mb-3">
              <button
                onClick={deleteAllHistory}
                className="text-red-400 hover:text-red-300 text-sm underline"
              >
                Delete all
              </button>
            </div>
          )}
          {historyLoading && (
            <p className="text-neutral-500 text-sm">Loading history...</p>
          )}
          {!historyLoading && history.length === 0 && (
            <p className="text-neutral-500 text-sm">
              No generations yet — go make something.
            </p>
          )}
          <div className="grid grid-cols-2 gap-4">
            {history.map((item) => (
              <div
                key={item.id}
                className="rounded-lg border border-neutral-800 overflow-hidden relative group"
              >
                <button
                  onClick={() => deleteHistoryItem(item.id)}
                  title="Delete this generation"
                  className="absolute top-2 right-2 w-7 h-7 rounded-full bg-neutral-950/80 text-neutral-300 hover:text-red-400 hover:bg-neutral-950 flex items-center justify-center text-sm leading-none z-10"
                >
                  ×
                </button>
                <img
                  src={`${API_URL}${item.image_url}`}
                  alt={item.prompt}
                  className="w-full aspect-square object-cover"
                />
                <div className="p-2">
                  <p className="text-xs text-neutral-500 uppercase tracking-wide">
                    {item.mode}
                  </p>
                  <p className="text-sm text-neutral-300 line-clamp-2">
                    {item.prompt}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && <p className="mt-4 text-red-400 text-sm max-w-xl">{error}</p>}

      {seconds !== null && !error && mode !== "history" && (
        <p className="mt-4 text-neutral-500 text-sm">Done in {seconds}s</p>
      )}

      {imageSrc && mode !== "history" && (
        <img
          src={imageSrc}
          alt="Result"
          className="mt-6 rounded-lg border border-neutral-800 max-w-xl w-full"
        />
      )}
    </main>
  );
}