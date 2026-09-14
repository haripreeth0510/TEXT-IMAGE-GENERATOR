"use client";

import { useState } from "react";

const API_URL = "http://localhost:8000";

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState<number | null>(null);

  async function handleGenerate() {
    if (!prompt.trim()) return;

    setLoading(true);
    setError(null);
    setImageSrc(null);

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

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100 flex flex-col items-center px-4 py-16">
      <h1 className="text-2xl font-semibold mb-8">Nano Banana — Phase 1</h1>

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
          disabled={loading}
          className="rounded-md bg-yellow-400 text-neutral-900 font-medium px-5 py-2 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate"}
        </button>
      </div>

      {error && (
        <p className="mt-4 text-red-400 text-sm max-w-xl">{error}</p>
      )}

      {seconds !== null && !error && (
        <p className="mt-4 text-neutral-500 text-sm">
          Generated in {seconds}s
        </p>
      )}

      {imageSrc && (
        <img
          src={imageSrc}
          alt={prompt}
          className="mt-6 rounded-lg border border-neutral-800 max-w-xl w-full"
        />
      )}
    </main>
  );
}