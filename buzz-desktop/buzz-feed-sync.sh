#!/bin/bash
# Mirror the newest ytheesh96/buzz-app release into the tailnet update feed
# that the patched Buzz app checks (BUZZ_UPDATER_ENDPOINT):
#
#   ~/.local/share/buzz-feed/latest.json          <- served by
#   ~/.local/share/buzz-feed/<version>/Buzz_*.AppImage
#   buzz-feed.service (127.0.0.1:8460) + tailscale serve --bg --https=8450 http://127.0.0.1:8460
#
# The repo is private and the app can't authenticate to GitHub, hence the
# mirror. Updates are signed; the app verifies them against the public key
# built into it, so the feed itself needs no trust beyond availability.
# Run by buzz-feed-sync.timer.
set -euo pipefail
REPO=ytheesh96/buzz-app
FEED="${BUZZ_FEED_DIR:-$HOME/.local/share/buzz-feed}"
BASE="${BUZZ_FEED_URL:-https://omarchy.tail65c5a9.ts.net:8450}"
GH="${GH:-$(command -v gh || ls "$HOME"/.local/share/mise/installs/gh/*/*/bin/gh | tail -1)}"
KEEP=3

mkdir -p "$FEED"
tag="$("$GH" release view -R "$REPO" --json tagName --jq .tagName)"
dir="${tag//+/_}"   # '+' would need escaping in URLs
current="$(jq -r .version "$FEED/latest.json" 2>/dev/null || true)"
[[ "$current" == "$tag" ]] && exit 0

tmp="$(mktemp -d "$FEED/.dl.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
"$GH" release download "$tag" -R "$REPO" -D "$tmp" --pattern 'Buzz_*.AppImage' --pattern 'latest.json'
chmod 644 "$tmp"/*
jq --arg base "$BASE/$dir" '.platforms |= map_values(.url = "\($base)/\(.url | split("/") | last)")' "$tmp/latest.json" > "$tmp/latest.json.new"
rm "$tmp/latest.json"
rm -rf "${FEED:?}/$dir"
mv "$tmp/latest.json.new" "$FEED/.latest.json.new"
mv "$tmp" "$FEED/$dir"
trap - EXIT
chmod 755 "$FEED/$dir"
mv "$FEED/.latest.json.new" "$FEED/latest.json"   # atomic switch
echo "feed: $current -> $tag"

# Keep the newest few versions so in-flight downloads finish.
ls -1dt "$FEED"/*/ | tail -n +$((KEEP + 1)) | xargs -r rm -rf
