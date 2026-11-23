#!/usr/bin/env bash
# Sync the scrubbed public Remote Agents and Viewport plugin bundles from
# buzz-host into a public buzz-app mirror (`plugins/remote-agents/` and
# `plugins/viewport/`) so hosted members can install both in 1 click via
# Settings → Plugins → Add from Git without access to private buzz-host and
# without exposing any personal host details.
#
# Usage:
#   tools/sync-public-plugin.sh [path-to-buzz-app]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${1:-${BUZZ_APP:-$HOME/Work/buzz-app}}"
REMOTE_DEST="$APP_DIR/plugins/remote-agents"
VIEWPORT_DEST="$APP_DIR/plugins/viewport"

if [ ! -e "$APP_DIR/.git" ]; then
  echo "ERROR: buzz-app git repo not found at $APP_DIR" >&2
  exit 1
fi

ROLLDOWN_APP="$APP_DIR"
if [ ! -d "$ROLLDOWN_APP/node_modules/.pnpm" ] && [ -d "${BUZZ_APP:-$HOME/Work/buzz-app}/node_modules/.pnpm" ]; then
  ROLLDOWN_APP="${BUZZ_APP:-$HOME/Work/buzz-app}"
fi

echo "Building scrubbed public plugin bundles from $ROOT..."
(cd "$ROOT" && node plugin/build.mjs --public --out-public "$APP_DIR/plugins" "$ROLLDOWN_APP")

mkdir -p "$REMOTE_DEST" "$VIEWPORT_DEST"
cp -f "$ROOT/plugin/manifest.json" "$REMOTE_DEST/manifest.json"
if [ -f "$ROOT/plugin/icon.png" ]; then
  cp -f "$ROOT/plugin/icon.png" "$REMOTE_DEST/icon.png"
fi

cp -f "$ROOT/plugins/viewport/manifest.json" "$VIEWPORT_DEST/manifest.json"
if [ -f "$ROOT/plugins/viewport/icon.png" ]; then
  cp -f "$ROOT/plugins/viewport/icon.png" "$VIEWPORT_DEST/icon.png"
fi

cat > "$REMOTE_DEST/README.md" <<'EOF'
# Remote Agents (Buzz Plugin)

Connect Buzz to a self-hosted `buzz-host` server so your AI agents stay online 24/7 — even when your laptop is asleep.

## Install in Buzz

1. Open **Settings → Plugins → Add from Git**.
2. Enter:
   - **Repository:** `https://github.com/ytheesh96/buzz-app.git`
   - **Folder:** `plugins/remote-agents`
3. Enable **Remote Agents**.
4. Open **Settings → Plugins → Remote Agents**, paste your invite link (`wss://...#token=bhg_...`) into the **Server** box, and click **Save and check**.
5. Create your first agent in **Agents → New agent → Harness → Remote → Self-hosted**.

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
EOF

cat > "$VIEWPORT_DEST/README.md" <<'EOF'
# Viewport (Buzz Plugin)

Live remote desktop preview, in-app Viewport page, and takeover controls for self-hosted agents on a `buzz-host` server.

## Install in Buzz

1. Install and connect **Remote Agents** (`plugins/remote-agents`) with your server URL or invite link first.
2. Open **Settings → Plugins → Add from Git**.
3. Enter:
   - **Repository:** `https://github.com/ytheesh96/buzz-app.git`
   - **Folder:** `plugins/viewport`
4. Enable **Viewport** — it automatically reuses the server connection and invite token saved by **Remote Agents**.
5. Open **Viewport** from the app dock (or open your self-hosted agent's **Desktop** tab) to enable and view its remote desktop inside Buzz (requires an admin connection or a trusted guest invite with remote desktop enabled).

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh` with private host defaults scrubbed. Do not edit `plugin.js` directly here.
EOF

# Privacy gate: never leak private hostnames, personal names, or personal pubkeys into the public mirror.
if grep -rnEi 'tail65c5a9\.ts\.net|vaitheesh|ytheesh96/buzz-host|b9085cc5|9abc8b76|c9bad408|/home/ytheesh96' "$REMOTE_DEST" "$VIEWPORT_DEST"; then
  echo "ERROR: Private host details detected in public plugin mirror!" >&2
  exit 1
fi

echo "Synced public plugins to $APP_DIR/plugins/:"
ls -lh "$REMOTE_DEST" "$VIEWPORT_DEST"
