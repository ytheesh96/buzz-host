#!/bin/bash
# Assemble one buzz-host bundle tarball from this checkout plus prebuilt binaries.
#
#   bundle/make-bundle.sh --version <v> --target <linux-x64|linux-arm64|darwin-arm64> \
#       --bins <dir> --out <dir> [--node-tarball <node-vX-os-cpu.tar.xz>]
#
# <bins> holds buzz-acp, buzz, buzz-acp.version (bundle/build-upstream.sh) and
# optionally buzz-host-iroh and buzz-mcp-bridge. The Node tarball is the
# official one for bundle/node.env's NODE_VERSION and is checked against the
# checksum pinned there; without --node-tarball it is downloaded.
#
# Output: <out>/buzz-host-<target>.tar.gz (top directory buzz-host-<v>-<target>/)
# and <out>/buzz-host-<target>.tar.gz.sha256.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="" TARGET="" BINS="" OUT="" NODE_TARBALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    --bins) BINS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --node-tarball) NODE_TARBALL="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$VERSION" ] && [ -n "$TARGET" ] && [ -n "$BINS" ] && [ -n "$OUT" ] || { sed -n '2,14p' "$0" >&2; exit 2; }
case "$VERSION" in ''|*/*|.*|*[[:space:]]*) echo "bad version '$VERSION'" >&2; exit 2 ;; esac
case "$TARGET" in
  linux-x64|linux-arm64|darwin-arm64) ;;
  *) echo "unknown target $TARGET" >&2; exit 2 ;;
esac
for f in buzz-acp buzz buzz-acp.version; do
  [ -f "$BINS/$f" ] || { echo "missing $BINS/$f" >&2; exit 1; }
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# shellcheck source=node.env
. "$REPO_ROOT/bundle/node.env"

node_var="NODE_SHA256_${TARGET//-/_}"
node_sha="${!node_var}"
node_name="node-v$NODE_VERSION-$TARGET.tar.xz"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [ -z "$NODE_TARBALL" ]; then
  NODE_TARBALL="$work/$node_name"
  curl -fsSL --retry 3 -o "$NODE_TARBALL" "https://nodejs.org/dist/v$NODE_VERSION/$node_name"
fi
[ "$(sha256_of "$NODE_TARBALL")" = "$node_sha" ] || { echo "Node tarball checksum mismatch ($node_name)" >&2; exit 1; }

top="buzz-host-$VERSION-$TARGET"
stage="$work/$top"
mkdir -p "$stage/bin" "$stage/node"

# The files deploy.sh --local installs, minus tests: deploy.sh stays the one
# place that knows what goes where.
(cd "$REPO_ROOT" && tar -cf - \
  --exclude='*.test.mjs' --exclude='test_*.py' --exclude='__pycache__' --exclude='*.pyc' \
  --exclude='node_modules' --exclude='.DS_Store' \
  deploy.sh server hermes-plugin agy-plugin cli bin/buzz-host) | tar -xf - -C "$stage"

for f in buzz-acp buzz buzz-host-iroh buzz-mcp-bridge; do
  [ -f "$BINS/$f" ] && install -m 0755 "$BINS/$f" "$stage/bin/$f"
done
install -m 0644 "$BINS/buzz-acp.version" "$stage/bin/buzz-acp.version"

tar -xJf "$NODE_TARBALL" -C "$stage/node" --strip-components=1
rm -rf "$stage/node/include" "$stage/node/share" "$stage/node/CHANGELOG.md" "$stage/node/README.md"

commit="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=""
git -C "$REPO_ROOT" diff --quiet HEAD 2>/dev/null || dirty="-dirty"
printf '%s\n' "$VERSION" > "$stage/VERSION"
printf '%s\n' "$TARGET" > "$stage/TARGET"
# BUNDLE_ID changes whenever any input does: `buzz-host up` reinstalls on a new one.
printf '%s %s %s%s acp=%s node=%s\n' "$VERSION" "$TARGET" "$commit" "$dirty" \
  "$(sha256_of "$BINS/buzz-acp" | cut -c1-12)" "$NODE_VERSION" > "$stage/BUNDLE_ID"

asset="buzz-host-$TARGET.tar.gz"
tar -czf "$OUT/$asset" -C "$work" "$top"
printf '%s  %s\n' "$(sha256_of "$OUT/$asset")" "$asset" > "$OUT/$asset.sha256"
echo "built $OUT/$asset ($(du -h "$OUT/$asset" | cut -f1)): $(cat "$stage/BUNDLE_ID")"
