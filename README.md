# Warble

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**Short daily vocal exercises. Real-time pitch feedback. No sheet music required.**

Warble is a desktop vocal-training app: pitch-matching drills, guided warm-ups, a vocal range test, and gamified progress (streaks, XP, levels) — inspired by apps like Vanido, but built as an original, unaffiliated project. Sing into your mic, see your pitch tracked live against each exercise's target notes, and build a daily practice habit.

> **Warble is a fork of [sing-attune](https://github.com/leonarduk/sing-attune)**, a MusicXML/choir-score practice tool by [@leonarduk](https://github.com/leonarduk). It reuses sing-attune's real-time pitch-detection engine (mic capture → pYIN/CREPE → WebSocket stream) but replaces the score-following UI with short, exercise-based practice sessions. All credit for the original pitch pipeline goes to the upstream project — see [Licence](#licence) below.

---

## Status

🚧 **Active rework in progress.** This fork is being transformed from a sheet-music practice tool into an exercise-based vocal trainer, one phase at a time — the app stays runnable at every step.

| Phase | What it covers | Status |
|---|---|---|
| 1. Design system + app shell | New light/warm visual identity, nav rail, screen router | ✅ Done |
| 2. Exercise engine core | Exercise data model, scoring, reference-tone player | ✅ Done |
| 3. Exercise Player (first exercise) | Live pitch-matching gameplay screen | ✅ Done |
| 4. Remaining exercises + picker | Scale climbs, interval jumps, guided warm-up, picker screen | ✅ Done |
| 5. Vocal Range Test | Guided low/high note capture → voice type | ✅ Done |
| 6. Gamification | XP, streaks, daily goals, results screen | ✅ Done |
| 7. Progress screen | Streak calendar, XP trend, range history | ✅ Done |
| 8. Settings screen | Mic device, voice type, pitch-detection tuning | ✅ Done |
| 9. Cleanup | Remove unused score/OSMD code and dependency | ✅ Done |
| 10. Branding + packaging | Electron installer branding, icon | 🔲 Planned |

The frontend no longer contains any score/MusicXML code, and has **no runtime npm dependencies**. The backend's score endpoints (`/score`, `/transcribe/audio`) still exist and are left untouched — they're simply not called, since real-time pitch streaming was already independent of score-following.

---

## Why it exists

Apps like [Vanido](https://vanido-app.com/) do short, gamified pitch-training exercises well, but only on mobile. Warble brings that same exercise-first loop — sing a target note or pattern, get instant visual feedback, build a streak — to the desktop, running entirely locally with no cloud, subscription, or account.

---

## The loop (target experience)

1. Pick an exercise — a single note to hold, a scale climb, an interval jump, or a guided warm-up
2. A reference tone plays; a target band appears on the pitch graph
3. Sing along — your live pitch traces the graph, green when in tune
4. Finish the exercise, see your accuracy and XP earned
5. Build a daily streak

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3.12, FastAPI, uvicorn |
| Pitch detection (GPU) | torchcrepe (PyTorch-based CREPE) |
| Pitch detection (CPU) | librosa pYIN |
| Frontend | Vite, TypeScript — no framework, hand-rolled Feature/Screen registries |
| Desktop packaging | Electron + PyInstaller backend binary |

---

## Requirements

- macOS, Windows 10/11, or Linux (real-time pitch detection needs a working microphone; GPU is optional)
- Python 3.12+
- Node 18+
- [uv](https://github.com/astral-sh/uv)
- [just](https://github.com/casey/just)
- NVIDIA GPU with CUDA 12.x optional (for torchcrepe pitch detection; librosa pYIN works fine on CPU)
- **Headphones** — essential during practice to prevent mic picking up any played-back audio

Install `just`: `brew install just` (macOS), `winget install Casey.Just` (Windows), `sudo apt install just` (Debian/Ubuntu), or `cargo install just`.

---

## Developer setup

```bash
git clone https://github.com/Wildcat252/warble
cd warble

# Install Python dependencies
uv sync

# Optional: GPU pitch engine (skip for CPU-only)
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install torchcrepe

# Install Node dependencies
cd frontend && npm install && cd ..

# Terminal 1 — start backend
just dev-backend

# Terminal 2 — start frontend
just dev-frontend
```

Open http://localhost:5173. API docs: http://localhost:8000/docs.

Verify the backend is up:
```bash
curl http://127.0.0.1:8000/health
# Expected: {"status":"ok","version":"0.2.0",...}
```

### Backend environment variables

- `CORS_ORIGINS` — comma-separated allowed browser origins for the FastAPI backend. Defaults to `http://localhost:5173,http://127.0.0.1:5173`.
- `ELECTRON_MODE` — set to `1` when the backend is launched by the packaged Electron app (wildcard CORS, credentials disabled, so the packaged renderer can reach the API without rebuilding the backend).

---

## Testing

```bash
# Backend: lint + tests
uv run ruff check backend/ --fix
uv run pytest -v --cov=backend --cov-report=term-missing

# Frontend: unit tests
cd frontend && npm test

# Frontend: e2e tests (downloads a Chromium binary on first run)
cd frontend && npx playwright install chromium && npm run test:e2e
```

---

## Project structure

```
backend/
  audio/          Mic capture + pitch detection pipeline (score-independent)
  score/, music/  MusicXML parsing & transcription from upstream — still
                  present and tested, but no longer called by the frontend
  main.py         FastAPI app, REST endpoints, WebSocket pitch stream
frontend/
  src/
    branding.ts        App name / storage-prefix constant
    styles/            Design tokens + shared component CSS
    screens/           Home, Exercises, Results, Progress, Settings
    features/          app-shell (nav + routing), exercise-player,
                       range-test, audio-preflight
    exercises/         Exercise model, scheduling, scoring, catalog
    gamification/      XP, streaks, practice log, confetti
    pitch/             Pitch graph, accuracy maths, WS client, voice type
electron/
  main.js         Electron shell: backend process lifecycle + dynamic port
```

---

## Known limitations

- Real-time pitch tracking is monophonic — polyphonic input isn't supported.
- Falsetto/airy tone can reduce pitch-detection confidence and produce gaps in the trace.
- On machines without a GPU, the CPU pitch engine (librosa pYIN) can fall behind real-time under load — see the engine's own inference-latency warnings in the backend log.

---

## Licence

Licensed under the [Apache License 2.0](LICENSE) — permissive open-source licensing with an explicit patent grant. This project is a fork of [leonarduk/sing-attune](https://github.com/leonarduk/sing-attune); see [NOTICE](NOTICE) for third-party attributions.
