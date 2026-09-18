# Nano Banana — Phase 1 Setup

Minimal end-to-end loop: Next.js prompt box → FastAPI → SDXL Turbo (local, MPS) → image back to browser.

## 1. Backend setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Verify MPS is available before doing anything else:

```bash
python3 -c "import torch; print(torch.backends.mps.is_available())"
```

This must print `True`. If it prints `False`, stop and fix your PyTorch install
before continuing (usually means an old PyTorch version — reinstall with
`pip install --upgrade torch`).

Run the API:

```bash
uvicorn app.main:app --reload --port 8000
```

First startup will download the SDXL Turbo weights (a few GB) and load the
model into memory — this can take a few minutes the first time. You'll see
`[image_service] Pipeline loaded and ready.` when it's done.

Check it's alive:

```bash
curl http://localhost:8000/health
```

## 2. Frontend setup

In a separate terminal:

```bash
npx create-next-app@latest frontend-app --typescript --tailwind --app --no-src-dir
```

Answer the prompts with defaults. Then replace the generated
`frontend-app/app/page.tsx` with the `frontend/page.tsx` file from this
project.

Run it:

```bash
cd frontend-app
npm run dev
```

Open http://localhost:3000, type a prompt, click Generate.

## 3. What "done" looks like

- Typing a prompt and clicking Generate shows a real image within roughly
  10-40 seconds (first request will be slower as MPS warms up).
- The `seconds_taken` shown under the image tells you your real generation
  speed on your machine — note this down, it's your baseline for later
  optimization decisions.
- A second request sent while the first is still running should simply wait
  (not crash) — that's the concurrency lock in `image_service.py` doing its
  job.

## 4. If something breaks

- **Out of memory / process killed:** lower `width`/`height` further (try
  512x512), close other apps, confirm nothing else is holding GPU memory.
- **Very slow (minutes per image):** confirm `torch.backends.mps.is_available()`
  is `True` — if it's silently falling back to CPU, generation will be far
  slower than expected.
- **CORS errors in the browser console:** confirm the backend is running on
  port 8000 and the frontend on port 3000 — the CORS config in `main.py`
  only allows `localhost:3000`.

## Phase 2 — image upload + editing

The frontend now has three tabs: **Generate**, **Repaint**, and **Paint & Edit**.

**Repaint** (`/edit`, img2img) — renoises and regenerates the *whole*
image guided by your prompt. Good for style transforms ("make it a
watercolor painting"). Not reliable for small localized changes — even at
low strength, faces/details can shift because the entire image is being
regenerated, not just one region.

**Paint & Edit** (`/inpaint`, masked inpainting) — upload a photo, paint
over just the area you want changed with the brush tool, type what should
appear there. Only the painted (white mask) region is regenerated;
everything outside it stays close to the original pixels. **This is the
right tool for "add a hat", "remove this object", "change just the
background"** — anything where you want one change without disturbing the
rest of the photo.

**How the mask works technically:** the frontend draws your brush strokes
onto a black canvas (white = paint here = edit this area), converts it to
a PNG, and sends it alongside the original image to `/inpaint`. The
backend blurs the mask edges slightly so the edited region blends instead
of showing a hard seam.

**Tips for good inpainting results:**
- Paint a bit larger than the object itself — e.g. if adding a hat, cover
  the whole head area, not just where the hat sits, so the model has room
  to blend hair/hat interaction naturally.
- Keep your edit prompt focused on what goes in the masked area, not the
  whole scene — e.g. "a red baseball cap", not "a man wearing a red
  baseball cap in a bathroom".
- If the edit doesn't look convincing, try painting a slightly larger area
  rather than changing prompt wording repeatedly.

**If /edit or /inpaint fail immediately:** confirm `python-multipart`
installed correctly (`pip show python-multipart`) — file uploads through
FastAPI require it.

## Quality inpainting (Paint & Edit tab)

The "Paint & Edit" tab now uses a **dedicated SDXL inpainting checkpoint**
(`stabilityai/stable-diffusion-xl-1.0-inpainting-0.1`), not SDXL Turbo.
Turbo is a speed-distilled model — 1-4 steps, no real guidance — which
caps how much realism/detail it can ever produce, no matter how the
pipeline is tuned. The dedicated model uses real step counts (~30) and
real classifier-free guidance (~8.0), which is what actually produces
sharp, realistic detail and correct shadow/lighting blending.

**Trade-off:** expect **1-2 minutes per edit** instead of ~10-15 seconds.
This model is not Turbo-distilled, so it's inherently slower — that's the
cost of the quality jump.

**Memory note:** this is a separate ~7GB checkpoint, loaded lazily the
first time you use "Paint & Edit" (not at server startup, so Generate/
Repaint stay fast to boot). The first inpaint request after starting the
server will be slow — it's downloading and loading the model, not just
generating. After that first load, it stays resident in memory for the
rest of the session.

Because this runs *alongside* the already-loaded Turbo pipelines, memory
pressure is higher than earlier phases. If you hit crashes or extreme
slowdowns:
- Close other memory-heavy apps (browser tabs, IDEs) before using Paint & Edit
- Keep uploaded images modest in size — the resize-to-768px logic still applies
- If it's consistently unstable, we can add an option to unload the Turbo
  pipelines while the quality inpainting model is in use, trading "Generate
  tab stays instant" for "inpainting is more memory-safe" — let me know if
  you hit this.

## Phase 3 — Postgres history (no login)

Every generation is saved to Postgres (metadata) and to `backend/storage/`
(the actual image files) — the "don't put image binaries in the database"
principle from the blueprint. No login/signup — this is a single local
history table for the one person running the app.

### 1. Install and start Postgres (Mac)

```bash
brew install postgresql@16
brew services start postgresql@16
createdb Text_to_Image
```

Confirm it worked:

```bash
psql Text_to_Image -c "SELECT 1;"
```

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
```

The default `DATABASE_URL` in `.env.example` assumes a local Postgres with
no password and your Mac username as the DB user — standard for a Homebrew
install. If your setup differs, adjust the URL in `.env`.

### 3. Install new dependencies

```bash
pip install -r requirements.txt
```

This adds `sqlalchemy`, `psycopg2-binary`, `python-dotenv`.

### 4. Run it

```bash
python -m uvicorn app.main:app --reload --port 8000
```

The `generations` table is created automatically on first startup
(`Base.metadata.create_all`) — no manual migration step needed for this
phase.

### 5. Frontend

No new dependencies — same `npm run dev`. A new **History** tab shows your
past generations in a grid, newest first.

### What changed under the hood

- `/generate`, `/edit`, `/inpaint` now return `image_url` (a path served
  from `/storage/...`) instead of raw base64 — images are written to disk
  once and reused, not re-encoded on every response.
- New `/history` endpoint returns the last 100 generations, newest first.

### If something breaks

- **"could not connect to server" / connection refused:** Postgres isn't
  running — `brew services start postgresql@16`.
- **"database Text_to_Image does not exist":** run `createdb Text_to_Image`.
- **`ModuleNotFoundError: psycopg2`** or similar: confirm you're in the
  activated venv and re-ran `pip install -r requirements.txt` after pulling
  these changes.

## Next step

Once Phase 2 feels solid — uploads work, edits look reasonable, no memory
crashes — we move to Phase 3: a proper database (users, projects, history)
and authentication, so generations persist across sessions instead of
disappearing on refresh.
