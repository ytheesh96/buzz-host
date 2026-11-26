#!/bin/sh
# Install a buzz-host bundle for this user, then (with --up) start it.
#
#   curl -fsSL https://github.com/ytheesh96/buzz-host/releases/latest/download/install.sh | sh -s -- --up
#
# Downloads buzz-host-<target>.tar.gz for this OS/CPU (linux-x64, linux-arm64,
# darwin-arm64) from a GitHub Release, checks it against the release's
# SHA256SUMS, unpacks it into ~/.local/share/buzz-host/runtime/<version>,
# points runtime/current at it and links ~/.local/bin/buzz-host. Needs only
# curl or wget, tar and sha256sum or shasum. Nothing runs as root.
#
# Options:
#   --version <tag>     Release tag (default: latest)
#   --bundle <file>     Install a local tarball instead of downloading. Checked
#                       against <file>.sha256 or SHA256SUMS next to it, or --sha256.
#   --sha256 <hex>      Expected checksum of --bundle
#   --repo <owner/name> GitHub repo (default ytheesh96/buzz-host)
#   --base-url <url>    Download from <url>/<asset> instead of GitHub
#   --up [args…]        Run `buzz-host up [args…]` afterwards (all later args go to it)
#
# Private repos: set GH_TOKEN (or GITHUB_TOKEN) to a token that can read the
# repo, or have an authenticated `gh` on PATH.
# BUZZ_HOST_RUNTIME_DIR and BUZZ_HOST_BIN_DIR override the install locations.
set -eu

REPO="ytheesh96/buzz-host"
TAG="latest"
BUNDLE=""
SHA=""
BASE_URL=""
RUN_UP=0
RUNTIME_DIR="${BUZZ_HOST_RUNTIME_DIR:-$HOME/.local/share/buzz-host/runtime}"
BIN_DIR="${BUZZ_HOST_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "buzz-host install: $*" >&2; }
die() { say "error: $*"; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || die "--version needs a value"; TAG="$2"; shift 2 ;;
    --bundle) [ $# -ge 2 ] || die "--bundle needs a file"; BUNDLE="$2"; shift 2 ;;
    --sha256) [ $# -ge 2 ] || die "--sha256 needs a value"; SHA="$2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a value"; REPO="$2"; shift 2 ;;
    --base-url) [ $# -ge 2 ] || die "--base-url needs a value"; BASE_URL="${2%/}"; shift 2 ;;
    --up) RUN_UP=1; shift; break ;;
    -h|--help) sed -n '2,25p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS $(uname -s) (linux and macOS only)" ;;
esac
case "$(uname -m)" in
  x86_64|amd64) cpu=x64 ;;
  aarch64|arm64) cpu=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
TARGET="$os-$cpu"
case "$TARGET" in
  linux-x64|linux-arm64|darwin-arm64) ;;
  *) die "no bundle for $TARGET (available: linux-x64, linux-arm64, darwin-arm64)" ;;
esac
ASSET="buzz-host-$TARGET.tar.gz"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  die "need sha256sum or shasum"
fi
command -v tar >/dev/null 2>&1 || die "need tar"

# fetch <url> <out> [header]
fetch() {
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${3:-}" ]; then
      curl -fsSL --retry 3 -H "$3" -H "Accept: application/octet-stream" -o "$2" "$1"
    else
      curl -fsSL --retry 3 -o "$2" "$1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "${3:-}" ]; then
      wget -q --header="$3" --header="Accept: application/octet-stream" -O "$2" "$1"
    else
      wget -q -O "$2" "$1"
    fi
  else
    die "need curl or wget"
  fi
}

# Download one release asset by name into <out>, using whatever access we have.
download_asset() {
  name="$1" out="$2"
  if [ -n "$BASE_URL" ]; then
    fetch "$BASE_URL/$name" "$out"
    return
  fi
  token="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if [ -z "$token" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    if [ "$TAG" = latest ]; then
      gh release download -R "$REPO" -p "$name" -O "$out" --clobber
    else
      gh release download "$TAG" -R "$REPO" -p "$name" -O "$out" --clobber
    fi
    return
  fi
  if [ -n "$token" ]; then
    # Private repos: release assets come from the API, by asset id.
    if [ "$TAG" = latest ]; then rel="latest"; else rel="tags/$TAG"; fi
    fetch "https://api.github.com/repos/$REPO/releases/$rel" "$WORK/release.json" "Authorization: Bearer $token"
    url="$(tr ',{}' '\n\n\n' < "$WORK/release.json" | awk -v want="\"name\": \"$name\"" '
      /"url": "https:\/\/api\.github\.com\/repos\/.*\/releases\/assets\/[0-9]+"/ { u = $0 }
      index($0, want) { sub(/.*"url": "/, "", u); sub(/".*/, "", u); print u; exit }')"
    [ -n "$url" ] || die "release $TAG of $REPO has no asset $name"
    fetch "$url" "$out" "Authorization: Bearer $token"
    return
  fi
  if [ "$TAG" = latest ]; then
    fetch "https://github.com/$REPO/releases/latest/download/$name" "$out"
  else
    fetch "https://github.com/$REPO/releases/download/$TAG/$name" "$out"
  fi
}

mkdir -p "$RUNTIME_DIR"
WORK="$(mktemp -d "$RUNTIME_DIR/.install.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ -n "$BUNDLE" ]; then
  [ -f "$BUNDLE" ] || die "no such bundle: $BUNDLE"
  tarball="$BUNDLE"
  if [ -z "$SHA" ]; then
    if [ -f "$BUNDLE.sha256" ]; then
      SHA="$(awk '{print $1; exit}' "$BUNDLE.sha256")"
    elif [ -f "$(dirname "$BUNDLE")/SHA256SUMS" ]; then
      SHA="$(awk -v f="$(basename "$BUNDLE")" '$2 == f || $2 == "*" f {print $1; exit}' "$(dirname "$BUNDLE")/SHA256SUMS")"
    fi
  fi
  [ -n "$SHA" ] || die "no checksum for $BUNDLE (pass --sha256, or put $BUNDLE.sha256 next to it)"
else
  say "downloading $ASSET ($TAG) from ${BASE_URL:-$REPO}"
  download_asset SHA256SUMS "$WORK/SHA256SUMS" || die "could not download SHA256SUMS (private repo? set GH_TOKEN)"
  download_asset "$ASSET" "$WORK/$ASSET" || die "could not download $ASSET"
  tarball="$WORK/$ASSET"
  SHA="$(awk -v f="$ASSET" '$2 == f || $2 == "*" f {print $1; exit}' "$WORK/SHA256SUMS")"
  [ -n "$SHA" ] || die "SHA256SUMS lists no $ASSET"
fi

actual="$(sha256_of "$tarball")"
[ "$actual" = "$SHA" ] || die "checksum mismatch for $(basename "$tarball"): expected $SHA, got $actual"
say "checksum ok ($actual)"

mkdir "$WORK/x"
tar -xzf "$tarball" -C "$WORK/x"
src=""
for d in "$WORK"/x/*; do
  [ -z "$src" ] && [ -d "$d" ] || die "unexpected bundle layout (want one top-level directory)"
  src="$d"
done
[ -n "$src" ] || die "empty bundle"
[ -f "$src/VERSION" ] && [ -x "$src/bin/buzz-host" ] || die "not a buzz-host bundle (no VERSION or bin/buzz-host)"
[ "$(cat "$src/TARGET" 2>/dev/null)" = "$TARGET" ] || die "bundle is for $(cat "$src/TARGET" 2>/dev/null || echo '?'), this machine is $TARGET"
VERSION="$(cat "$src/VERSION")"
case "$VERSION" in
  ''|*/*|.*) die "bad bundle version '$VERSION'" ;;
esac

dest="$RUNTIME_DIR/$VERSION"
if [ -d "$dest" ] && [ "$(cat "$dest/BUNDLE_ID" 2>/dev/null)" = "$(cat "$src/BUNDLE_ID")" ]; then
  say "$VERSION is already installed"
else
  if [ -e "$dest" ]; then
    # Same version, different build: move the old one aside first.
    mv "$dest" "$WORK/old"
  fi
  mv "$src" "$dest"
  say "installed $VERSION into $dest"
fi

previous="$(readlink "$RUNTIME_DIR/current" 2>/dev/null || true)"
ln -s "$VERSION" "$RUNTIME_DIR/.current.tmp.$$"
mv -T "$RUNTIME_DIR/.current.tmp.$$" "$RUNTIME_DIR/current" 2>/dev/null \
  || mv -fh "$RUNTIME_DIR/.current.tmp.$$" "$RUNTIME_DIR/current" 2>/dev/null \
  || { rm -f "$RUNTIME_DIR/.current.tmp.$$"; ln -sfn "$VERSION" "$RUNTIME_DIR/current"; }

# Keep the new version and the one it replaced; drop older ones.
for d in "$RUNTIME_DIR"/*; do
  [ -d "$d" ] && [ ! -L "$d" ] || continue
  v="$(basename "$d")"
  [ "$v" = "$VERSION" ] || [ "$v" = "$previous" ] || rm -rf "$d"
done

mkdir -p "$BIN_DIR"
ln -sfn "$RUNTIME_DIR/current/bin/buzz-host" "$BIN_DIR/buzz-host"
say "buzz-host $VERSION -> $BIN_DIR/buzz-host"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) say "note: $BIN_DIR is not on PATH; run $BIN_DIR/buzz-host or add it" ;;
esac

if [ "$RUN_UP" = 1 ]; then
  rm -rf "$WORK"
  trap - EXIT INT TERM
  exec "$BIN_DIR/buzz-host" up "$@"
fi
