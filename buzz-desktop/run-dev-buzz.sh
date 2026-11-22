#!/usr/bin/env bash
# Launch Buzz-dev_x86_64.AppImage on omarchy's headless owner desktop (:60)
# pointed at a local Vite dev server from a patched buzz-app checkout/worktree.
#
# Usage:
#   omarchy/run-dev-buzz.sh <buzz-app-dir> [dev-appimage-path]
#
# Iterating on UI patches (e.g. patches/0006-models-for-hosted.patch) takes ~3 s
# with Vite HMR instead of waiting for a full CI AppImage rebuild.
#
# Note: dev-mode Buzz sends Origin: http://localhost:1430 to buzz-host. Make
# sure "http://localhost:1430" is in ~/.config/buzz-host/config.json allowOrigins
# while testing against buzz-host.
set -euo pipefail

APP_DIR="${1:-$HOME/Work/buzz-app}"
DEV_APPIMAGE="${2:-$HOME/Applications/Buzz-dev.AppImage}"
ENV_FILE="${OWNER_DESKTOP_ENV:-$HOME/.local/share/buzz-owner-desktop/env}"
PORT="${BUZZ_DEV_PORT:-1430}"

if [[ ! -d "$APP_DIR" ]]; then
  echo "buzz-app directory not found: $APP_DIR" >&2
  exit 1
fi
if [[ ! -x "$DEV_APPIMAGE" ]]; then
  echo "Dev AppImage not found or not executable: $DEV_APPIMAGE" >&2
  echo "Download artifact 'buzz-dev-x86_64' from the buzz-dev-appimage GitHub workflow (ytheesh96/buzz-app) first." >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Owner desktop env file not found: $ENV_FILE (is buzz-owner-desktop.service active?)" >&2
  exit 1
fi

if [[ -f "$HOME/.config/buzz-host/config.json" ]] && ! grep -q "http://localhost:${PORT}" "$HOME/.config/buzz-host/config.json"; then
  echo "WARNING: http://localhost:${PORT} is not listed in ~/.config/buzz-host/config.json allowOrigins;" >&2
  echo "         buzz-host will reject WebSocket connections from dev-mode Buzz with 403." >&2
fi

VITE_PID=""
cleanup() {
  if [[ -n "$VITE_PID" ]] && kill -0 "$VITE_PID" 2>/dev/null; then
    kill -TERM "$VITE_PID" 2>/dev/null || true
    wait "$VITE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

VITE_LOG="${XDG_CACHE_HOME:-$HOME/.cache}/buzz-dev-vite.log"
mkdir -p "$(dirname "$VITE_LOG")"

echo "==> Starting Vite dev server on http://127.0.0.1:${PORT} from ${APP_DIR}"
(
  cd "$APP_DIR"
  exec "$APP_DIR/node_modules/.bin/vite" --host 127.0.0.1 --port "$PORT" --strictPort --force
) >"$VITE_LOG" 2>&1 &
VITE_PID=$!

for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "Vite exited early:" >&2
    cat "$VITE_LOG" >&2
    exit 1
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
  echo "Timed out waiting for Vite on http://127.0.0.1:${PORT}" >&2
  exit 1
fi

# Build a clean allowlist env from the owner desktop (:60) env file — never
# inherit WAYLAND_DISPLAY or HYPRLAND_* from the caller's shell.
declare -a DENV=(
  "HOME=$HOME"
  "USER=${USER:-$(id -un)}"
  "PATH=$PATH"
  "LANG=${LANG:-C.UTF-8}"
  "APPIMAGE_EXTRACT_AND_RUN=1"
)
while IFS= read -r line; do
  [[ -n "$line" ]] && DENV+=("$line")
done < "$ENV_FILE"

echo "==> Launching $(basename "$DEV_APPIMAGE") on owner desktop (:60)"
env -i "${DENV[@]}" "$DEV_APPIMAGE"
