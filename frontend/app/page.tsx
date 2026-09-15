"use client";

import { useRef, useState } from "react";

const API_URL = "http://localhost:8000";

type Mode = "generate" | "edit";

export default function Home() {
  const [mode, setMode] = useState<Mode>("generate");

  // Shared result state
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  // Generate tab state
  const [prompt, setPrompt] = useState("");

  // Edit tab state
  const [editPrompt, setEditPrompt] = useState("");
  const [strength, setStrength] = useState(0.6);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function resetResult() {
    setError(null);
    setImageSrc(null);
    setSeconds(null);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploadFile(file);
    resetResult();

    const reader = new FileReader();
    reader.onload = () => setUploadPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

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

  async function handleEdit() {
    if (!uploadFile || !editPrompt.trim()) return;

    setLoading(true);
    resetResult();

    try {
      const formData = new FormData();
      formData.append("image", uploadFile);
      formData.append("prompt", editPrompt);
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

  function switchMode(next: Mode) {
    setMode(next);
    resetResult();
  }

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-16">
      <h1 className="text-2xl font-semibold mb-2">Nano Banana</h1>
      <p className="text-neutral-500 text-sm mb-8">Phase 2 — generate or edit</p>

      {/* Mode toggle */}
      <div className="flex gap-1 mb-8 bg-neutral-900 rounded-lg p-1">
        <button
          onClick={() => switchMode("generate")}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
            mode === "generate"
              ? "bg-yellow-400 text-neutral-900"
              : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Generate
        </button>
        <button
          onClick={() => switchMode("edit")}
          className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
            mode === "edit"
              ? "bg-yellow-400 text-neutral-900"
              : "text-neutral-400 hover:text-neutral-200"
          }`}
        >
          Edit an image
        </button>
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

      {mode === "edit" && (
        <div className="w-full max-w-xl flex flex-col gap-4">
          {/* Upload area */}
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
                  PNG or JPG, any size — it'll be resized automatically
                </p>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png, image/jpeg"
              onChange={handleFileChange}
              className="hidden"
            />
          </div>

          {/* Edit prompt */}
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-md bg-neutral-900 border border-neutral-700 px-4 py-2 outline-none focus:border-neutral-400"
              placeholder="Describe the edit... e.g. 'make it a watercolor painting'"
              value={editPrompt}
              onChange={(e) => setEditPrompt(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleEdit()}
            />
            <button
              onClick={handleEdit}
              disabled={loading || !uploadFile || !editPrompt.trim()}
              className="rounded-md bg-yellow-400 text-neutral-900 font-medium px-5 py-2 disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? "Editing..." : "Apply Edit"}
            </button>
          </div>

          {/* Strength slider */}
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

      {error && <p className="mt-4 text-red-400 text-sm max-w-xl">{error}</p>}

      {seconds !== null && !error && (
        <p className="mt-4 text-neutral-500 text-sm">
          {mode === "generate" ? "Generated" : "Edited"} in {seconds}s
        </p>
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