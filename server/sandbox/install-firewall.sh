#!/bin/bash
# One-time, root: install the sandbox egress filter as a system unit.
#   sudo server/sandbox/install-firewall.sh            # install / update
#   sudo server/sandbox/install-firewall.sh --remove   # uninstall
# docker-run refuses to start sandboxed agents while this unit is inactive.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
dir="$(cd "$(dirname "$0")" && pwd)/firewall"
unit=buzz-sandbox-firewall.service

if [[ "${1:-}" == "--remove" ]]; then
  systemctl disable --now "$unit" 2>/dev/null || true
  rm -f "/etc/systemd/system/$unit" /etc/buzz-host/buzz-sandbox.nft
  systemctl daemon-reload
  echo "removed $unit (sandboxed agents will refuse to start until it is reinstalled)"
  exit 0
fi

command -v nft >/dev/null || { echo "nft (nftables) is required" >&2; exit 1; }
nft -c -f "$dir/buzz-sandbox.nft"
install -d -m 755 /etc/buzz-host
install -m 644 "$dir/buzz-sandbox.nft" /etc/buzz-host/buzz-sandbox.nft
install -m 644 "$dir/$unit" "/etc/systemd/system/$unit"
systemctl daemon-reload
systemctl enable "$unit"
systemctl restart "$unit"
systemctl is-active --quiet "$unit"
echo "installed and started $unit"
nft list table inet buzz_sandbox | sed -n '1,4p'
