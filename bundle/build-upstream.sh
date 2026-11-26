#!/bin/bash
# Build the patched buzz-acp and the buzz CLI for this machine, natively:
# upstream block/buzz at bundle/UPSTREAM_REF plus ./patches/*.patch (the same
# patches build-acp.sh applies), then `cargo build --release --locked`.
#
#   bundle/build-upstream.sh <out-dir> [git-ref]
#
# Writes <out-dir>/{buzz-acp,buzz,buzz-acp.version}. Needs git, a Rust
# toolchain (rustup installs the one upstream's rust-toolchain.toml names) and
# a C compiler. The clone goes to $BUZZ_UPSTREAM_SRC (default <out-dir>/.src).
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:?usage: $0 <out-dir> [git-ref]}"
REF="${2:-$(tr -d '[:space:]' < "$REPO_ROOT/bundle/UPSTREAM_REF")}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
SRC="${BUZZ_UPSTREAM_SRC:-$OUT/.src/buzz}"

shopt -s nullglob
patches=("$REPO_ROOT"/patches/*.patch)
(( ${#patches[@]} )) || { echo "no patches in $REPO_ROOT/patches" >&2; exit 1; }

if [[ ! -d $SRC/.git ]]; then
  git clone -q --filter=blob:none https://github.com/block/buzz.git "$SRC"
fi
cd "$SRC"
git am --abort >/dev/null 2>&1 || true
git fetch -q origin
git checkout -q --detach "$REF"
base="$(git rev-parse --short=9 HEAD)"
echo "upstream $REF = $base ($(git log -1 --format=%cs))"
for p in "${patches[@]}"; do
  if ! git -c user.name=buzz-host -c user.email=buzz-host@localhost am -q --3way "$p"; then
    git am --abort || true
    echo "PATCH FAILED: $(basename "$p") no longer applies to $base" >&2
    exit 3
  fi
  echo "applied $(basename "$p")"
done

# Install the toolchain upstream's rust-toolchain.toml pins (rustup >= 1.28
# no longer always does it implicitly).
if command -v rustup >/dev/null 2>&1; then rustup toolchain install; fi
cargo build --release --locked -p buzz-acp -p buzz-cli
target_dir="${CARGO_TARGET_DIR:-$SRC/target}"
install -m 0755 "$target_dir/release/buzz-acp" "$OUT/buzz-acp"
install -m 0755 "$target_dir/release/buzz" "$OUT/buzz"
"$OUT/buzz-acp" --help >/dev/null
printf '%s +%s patches\n' "$base" "${#patches[@]}" > "$OUT/buzz-acp.version"
echo "built $OUT/buzz-acp and $OUT/buzz ($(cat "$OUT/buzz-acp.version"))"
