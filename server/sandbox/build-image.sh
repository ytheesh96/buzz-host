#!/bin/bash
# Build the buzz-host hardened sandbox Docker image locally.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
# --desktop: the desktop sidecar image for sandboxed agents' desktops (#39).
if [[ "${1:-}" == "--desktop" ]]; then
  shift
  image="${BUZZ_SANDBOX_DESKTOP_IMAGE:-buzz-host-desktop:latest}"
  exec docker build -t "$image" -f "$dir/desktop/Dockerfile" "$dir/desktop" "$@"
fi
image="${BUZZ_SANDBOX_IMAGE:-buzz-host-sandbox:latest}"
exec docker build -t "$image" -f "$dir/Dockerfile" "$dir" "$@"
