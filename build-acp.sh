#!/bin/bash
# Build buzz-acp from upstream block/buzz plus ./patches/*.patch, on the host,
# inside a capped Rust container, and install it for buzz-host.
#
#   ./build-acp.sh [host] [git-ref]      defaults: omarchy, origin/main
#
# Stops without installing if a patch no longer applies or the build fails.
# The previous binary is kept as bin/buzz-acp.prev. Agents keep running the
# old binary until you restart them (./deploy.sh restarts nothing; use
# `ssh host systemctl --user restart 'buzz-agent@*'`).
set -euo pipefail
HOST="${1:-omarchy}"
REF="${2:-origin/main}"
cd "$(dirname "$0")"
shopt -s nullglob
patches=(patches/*.patch)
(( ${#patches[@]} )) || { echo "no patches in ./patches" >&2; exit 1; }

ssh "$HOST" 'mkdir -p ~/.cache/buzz-host/patches && rm -f ~/.cache/buzz-host/patches/*.patch'
scp -q "${patches[@]}" "$HOST":.cache/buzz-host/patches/

ssh "$HOST" REF="$REF" bash -s <<'REMOTE'
set -euo pipefail
src=~/.cache/buzz-host/buzz
if [[ ! -d $src/.git ]]; then
  git clone -q --filter=blob:none https://github.com/block/buzz.git "$src"
fi
cd "$src"
git am --abort >/dev/null 2>&1 || true
git fetch -q origin
git checkout -q --detach "$REF"
base=$(git rev-parse --short HEAD)
echo "upstream $REF = $base ($(git log -1 --format=%cs))"
for p in ~/.cache/buzz-host/patches/*.patch; do
  if ! git -c user.name=buzz-host -c user.email=buzz-host@localhost am -q --3way "$p"; then
    git am --abort || true
    echo "PATCH FAILED: $(basename "$p") no longer applies to $base. Update it, then rerun." >&2
    exit 3
  fi
  echo "applied $(basename "$p")"
done
toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)
image="rust:${toolchain}-bookworm"
echo "building buzz-acp with $image (capped: 2 CPUs, 3 GiB, low priority)"
docker volume create buzz-host-cargo >/dev/null
docker volume create buzz-host-target >/dev/null
nice -n 15 docker run --rm --cpus 2 --memory 3g --memory-swap 6g \
  -e CARGO_BUILD_JOBS=2 -e CARGO_PROFILE_RELEASE_LTO=false \
  -v "$src":/src:ro -v buzz-host-cargo:/usr/local/cargo/registry \
  -v buzz-host-target:/target -e CARGO_TARGET_DIR=/target \
  -w /src "$image" \
  cargo build --release --locked -p buzz-acp
out=~/.cache/buzz-host/buzz-acp.new
docker run --rm -v buzz-host-target:/target -v ~/.cache/buzz-host:/out "$image" \
  install -m 0755 -o "$(id -u)" -g "$(id -g)" /target/release/buzz-acp /out/buzz-acp.new
"$out" --help >/dev/null
bin=~/.local/lib/buzz-host/bin
[[ -f $bin/buzz-acp ]] && cp -p "$bin/buzz-acp" "$bin/buzz-acp.prev"
mv "$out" "$bin/buzz-acp"
printf '%s +%s patches\n' "$base" "$(ls ~/.cache/buzz-host/patches/*.patch | wc -l)" > "$bin/buzz-acp.version"
echo "installed $bin/buzz-acp ($(cat "$bin/buzz-acp.version")); previous kept as buzz-acp.prev"
REMOTE
