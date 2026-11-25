#!/bin/bash
# Build the buzz-host-iroh Rust sidecar (`iroh-bridge/`) for this machine.
#
# Usage:
#   ./build-iroh.sh             Build release binary in iroh-bridge/target/release/buzz-host-iroh
#   ./build-iroh.sh --install   Also install atomically to $BUZZ_HOST_LIB_DIR/bin/buzz-host-iroh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
BRIDGE_DIR="$REPO_ROOT/iroh-bridge"
BIN="$BRIDGE_DIR/target/release/buzz-host-iroh"

if [ -d "$HOME/.cargo/bin" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi

INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL=1 ;;
    -h|--help)
      sed -n '2,6p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 [--install]" >&2
      exit 2
      ;;
  esac
done

(
  cd "$BRIDGE_DIR"
  cargo build --release --locked
)

"$BIN" --help >/dev/null
echo "built $BIN"

if [ "$INSTALL" = "1" ]; then
  LIB_DIR="${BUZZ_HOST_LIB_DIR:-$HOME/.local/lib/buzz-host}"
  mkdir -p "$LIB_DIR/bin"
  tmp="$(mktemp "$LIB_DIR/bin/.buzz-host-iroh.tmp.XXXXXX")"
  cp -p "$BIN" "$tmp"
  chmod 0755 "$tmp"
  mv -f "$tmp" "$LIB_DIR/bin/buzz-host-iroh"
  echo "installed $LIB_DIR/bin/buzz-host-iroh"
fi
