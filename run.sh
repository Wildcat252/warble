#!/bin/bash
# Launches the Warble backend + frontend dev servers together.
#
# Usage:
#   ./run.sh
#
# Stops both servers on Ctrl+C. Run this from a real Terminal window (not a
# detached/background shell) — the backend captures your microphone directly
# via Python (sounddevice), and macOS only prompts for mic permission when
# the requesting process has a normal foreground Terminal in its process
# ancestry. A detached process silently gets no prompt and no audio.

set -euo pipefail
cd "$(dirname "$0")"

cleanup() {
  echo ""
  echo "Stopping backend and frontend..."
  kill "${BACKEND_PID:-}" "${FRONTEND_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Starting backend (uv run uvicorn ...) on http://127.0.0.1:8000"
just dev-backend &
BACKEND_PID=$!

echo "Starting frontend (vite) on http://localhost:5173"
just dev-frontend &
FRONTEND_PID=$!

echo ""
echo "Waiting for both to come up..."
for _ in $(seq 1 30); do
  backend_ok=false
  frontend_ok=false
  curl -sf http://127.0.0.1:8000/health > /dev/null 2>&1 && backend_ok=true
  curl -sf http://localhost:5173 > /dev/null 2>&1 && frontend_ok=true
  if [ "$backend_ok" = true ] && [ "$frontend_ok" = true ]; then
    echo ""
    echo "Backend:  http://127.0.0.1:8000  (docs: /docs)"
    echo "Frontend: http://localhost:5173"
    echo ""
    echo "Press Ctrl+C to stop both."
    break
  fi
  sleep 1
done

wait
