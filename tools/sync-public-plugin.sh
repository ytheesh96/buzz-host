#!/usr/bin/env bash
# Sync the built Remote Agents plugin from buzz-host into a public buzz-app mirror
# (`plugins/remote-agents/`) so friends can install it in 1 click via Buzz's
# Settings → Plugins → Add from Git without needing access to private buzz-host.
#
# Usage:
#   tools/sync-public-plugin.sh [path-to-buzz-app]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${1:-${BUZZ_APP:-$HOME/Work/buzz-app}}"
DEST="$APP_DIR/plugins/remote-agents"

if [ ! -d "$APP_DIR/.git" ]; then
  echo "ERROR: buzz-app git repo not found at $APP_DIR" >&2
  exit 1
fi

echo "Building plugin bundles from $ROOT/plugin/src..."
node "$ROOT/plugin/build.mjs" "$APP_DIR"

mkdir -p "$DEST"
cp -f "$ROOT/plugin/manifest.json" "$DEST/manifest.json"
cp -f "$ROOT/plugin/plugin.js" "$DEST/plugin.js"
if [ -f "$ROOT/plugin/icon.png" ]; then
  cp -f "$ROOT/plugin/icon.png" "$DEST/icon.png"
fi

cat > "$DEST/README.md" <<'EOF'
# Remote Agents (Buzz Plugin)

Connect Buzz to a self-hosted `buzz-host` server so your AI agents run 24/7 in isolated Docker sandboxes — even when your laptop is asleep.

## Install in Buzz

1. Open **Settings → Plugins → Add from Git**.
2. Enter:
   - **Repository:** `https://github.com/ytheesh96/buzz-app.git`
   - **Folder:** `plugins/remote-agents`
3. Enable **Remote Agents**.
4. Open **Settings → Plugins → Remote Agents**, paste your invite link (`wss://...#token=bhg_...`) into the **Server** box, and click **Save and check**.
5. Create your first agent in **Agents → New agent → Harness → Remote → Self-hosted**.

> This folder is synced from `buzz-host` via `tools/sync-public-plugin.sh`. Do not edit `plugin.js` directly here.
EOF

echo "Synced Remote Agents plugin to $DEST:"
ls -lh "$DEST"
