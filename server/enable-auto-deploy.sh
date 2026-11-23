#!/bin/bash
# Enable pull-based auto-deploy (buzz-host-deploy.timer) on this host.
# Usage:
#   ./server/enable-auto-deploy.sh           Install units and start timer
#   ./server/enable-auto-deploy.sh --seed    Also seed deployed-sha to current origin/main without restarting
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${BUZZ_HOST_LIB_DIR:-$HOME/.local/lib/buzz-host}"
SYSTEMD_DIR="${BUZZ_HOST_SYSTEMD_DIR:-$HOME/.config/systemd/user}"

mkdir -p "$LIB_DIR" "$SYSTEMD_DIR"
install -m 0755 "$SERVER_DIR/auto-deploy.sh" "$LIB_DIR/auto-deploy.sh"
install -m 0644 "$SERVER_DIR/buzz-host-deploy.service" "$SYSTEMD_DIR/buzz-host-deploy.service"
install -m 0644 "$SERVER_DIR/buzz-host-deploy.timer" "$SYSTEMD_DIR/buzz-host-deploy.timer"

if [ "${1:-}" = "--seed" ]; then
  "$LIB_DIR/auto-deploy.sh" --seed
fi

systemctl --user daemon-reload
systemctl --user enable --now buzz-host-deploy.timer
systemctl --user status buzz-host-deploy.timer --no-pager -n 0
