#!/bin/bash
# Copy buzz-host's server files to the host and restart it. Agents keep running.
set -euo pipefail
HOST="${1:-omarchy}"
cd "$(dirname "$0")/server"
ssh "$HOST" 'mkdir -p ~/.local/lib/buzz-host/{bin,shims,agent-bin} ~/.config/systemd/user'
scp -q buzz-host.mjs agent-run attention.mjs attention-core.mjs buzz-mcp.mjs memory.mjs nip44.mjs attention-relay.mjs noble.mjs workspace.mjs catalog.mjs orchestrator.mjs control.mjs file-lock.mjs "$HOST":.local/lib/buzz-host/
# Agent desktops (Xvnc + Xfce + cua-driver per agent; see README "Agent desktops").
ssh "$HOST" 'rm -rf ~/.local/lib/buzz-host/desktop && mkdir -p ~/.local/lib/buzz-host/desktop'
scp -q desktop/*.mjs desktop/launcher.sh desktop/wallpaper.png "$HOST":.local/lib/buzz-host/desktop/
ssh "$HOST" 'rm -f ~/.local/lib/buzz-host/desktop/*.test.mjs'
scp -q acp-proxy "$HOST":.local/lib/buzz-host/bin/
scp -q shims/* "$HOST":.local/lib/buzz-host/shims/
scp -q agent-bin/* "$HOST":.local/lib/buzz-host/agent-bin/
scp -q buzz-host.service buzz-agent@.service "$HOST":.config/systemd/user/
# Hermes plugin: per-session agent identity in the gateway. buzz-host installs
# and enables it in each Hermes profile an agent uses, from this copy; refresh
# the profiles that already have it (default included). Code changes take effect
# on the next gateway reload (`systemctl --user reload hermes-gateway`).
ssh "$HOST" 'rm -rf ~/.local/lib/buzz-host/hermes-plugin && mkdir -p ~/.local/lib/buzz-host/hermes-plugin'
scp -q -r ../hermes-plugin/buzz-host-session-env "$HOST":.local/lib/buzz-host/hermes-plugin/
ssh "$HOST" 'src=~/.local/lib/buzz-host/hermes-plugin/buzz-host-session-env
  for home in "$HOME/.hermes" "$HOME"/.hermes/profiles/*; do
    t="$home/plugins/buzz-host-session-env"
    if [ -d "$t" ] || { [ "$home" = "$HOME/.hermes" ] && [ -d "$home/plugins" ]; }; then
      rm -rf "$t" && cp -r "$src" "$t"
    fi
  done'
ssh "$HOST" 'systemctl --user daemon-reload && systemctl --user restart buzz-host && systemctl --user is-active buzz-host'
