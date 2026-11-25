#!/usr/bin/env bash
# Entry point of a sandboxed agent's desktop container (issue #39), started by
# desktop-sidecar.mjs. Runs buzz-host's own desktop launcher (Xvnc + Xfce,
# mounted read-only at its host path), then cua-driver bound to that display.
# Only rfb.sock and cua.sock leave the container, through the socket dir.
set -euo pipefail
[[ -n "${BUZZ_DESKTOP_LOG:-}" ]] && exec >"$BUZZ_DESKTOP_LOG" 2>&1
: "${HERMES_BD_ENV_FILE:?}" "${BUZZ_DESKTOP_LAUNCHER:?}" "${BUZZ_DESKTOP_CUA:?}" "${BUZZ_DESKTOP_CUA_SOCKET:?}"

# /tmp is a fresh tmpfs: Xvnc (not root) cannot create the X11 socket dir itself.
mkdir -p -m 1777 /tmp/.X11-unix
mkdir -p "$HOME"

bash "$BUZZ_DESKTOP_LAUNCHER" &
launcher=$!
trap 'kill $launcher ${cua:-} 2>/dev/null || true' EXIT TERM INT

for _ in $(seq 1 300); do
  [[ -s "$HERMES_BD_ENV_FILE" ]] && break
  kill -0 "$launcher" 2>/dev/null || { echo "desktop launcher exited" >&2; exit 1; }
  sleep 0.1
done
[[ -s "$HERMES_BD_ENV_FILE" ]] || { echo "desktop did not come up" >&2; exit 1; }

# No /dev/uinput in here, so cua-driver drives the display through XTEST.
(
  set -a
  # shellcheck disable=SC1090
  . "$HERMES_BD_ENV_FILE"
  set +a
  export XDG_SESSION_TYPE=x11
  rm -f "$BUZZ_DESKTOP_CUA_SOCKET"
  exec "$BUZZ_DESKTOP_CUA" serve --socket "$BUZZ_DESKTOP_CUA_SOCKET"
) >>"${BUZZ_DESKTOP_CUA_LOG:-/dev/null}" 2>&1 &
cua=$!

# Either one ending ends the container; buzz-host starts a fresh one on next use.
wait -n "$launcher" "$cua" || true
