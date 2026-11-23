#!/bin/bash
# Build the buzz-host hardened sandbox Docker image locally.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
image="${BUZZ_SANDBOX_IMAGE:-buzz-host-sandbox:latest}"
exec docker build -t "$image" -f "$dir/Dockerfile" "$dir" "$@"
