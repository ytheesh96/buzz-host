#!/bin/bash
# Copy buzz-host's server files to the host and restart it. Agents keep running.
# Usage:
#   ./deploy.sh [host]        Deploy over SSH (default: omarchy)
#   ./deploy.sh --local       Deploy atomically to the local machine (no SSH)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$REPO_ROOT/server"

SERVER_FILES=(
  buzz-host.mjs
  agent-run
  auth.mjs
  attention.mjs
  attention-core.mjs
  buzz-mcp.mjs
  memory.mjs
  nip44.mjs
  attention-relay.mjs
  noble.mjs
  workspace.mjs
  catalog.mjs
  orchestrator.mjs
  control.mjs
  file-lock.mjs
)

atomic_copy() {
  local src="$1" dst="$2" mode="$3"
  local dir base tmp
  dir="$(dirname "$dst")"
  base="$(basename "$dst")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.${base}.tmp.XXXXXX")"
  cp -p "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst"
}

sync_hermes_plugin_local() {
  local src="$1" hermes_dir="$2"
  local home target tmp
  for home in "$hermes_dir" "$hermes_dir"/profiles/*; do
    [ -d "$home" ] || continue
    target="$home/plugins/buzz-host-session-env"
    if [ -d "$target" ] || { [ "$home" = "$hermes_dir" ] && [ -d "$home/plugins" ]; }; then
      mkdir -p "$home/plugins"
      tmp="$(mktemp -d "$home/plugins/.buzz-host-session-env.tmp.XXXXXX")"
      cp -r "$src/." "$tmp/"
      rm -rf "$target"
      mv "$tmp" "$target"
    fi
  done
}

deploy_local() {
  local lib_dir="${BUZZ_HOST_LIB_DIR:-$HOME/.local/lib/buzz-host}"
  local systemd_dir="${BUZZ_HOST_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
  local hermes_dir="${BUZZ_HOST_HERMES_DIR:-$HOME/.hermes}"

  mkdir -p "$lib_dir"/{bin,shims,agent-bin} "$systemd_dir"

  local f mode
  for f in "${SERVER_FILES[@]}"; do
    mode="0644"
    if [ -x "$SERVER_DIR/$f" ]; then
      mode="0755"
    fi
    atomic_copy "$SERVER_DIR/$f" "$lib_dir/$f" "$mode"
  done

  if [ -f "$SERVER_DIR/auto-deploy.sh" ]; then
    atomic_copy "$SERVER_DIR/auto-deploy.sh" "$lib_dir/auto-deploy.sh" 0755
  fi

  # Agent desktops (Xvnc + Xfce + cua-driver per agent; see README "Agent desktops").
  local desktop_tmp
  desktop_tmp="$(mktemp -d "$lib_dir/.desktop.tmp.XXXXXX")"
  for f in "$SERVER_DIR"/desktop/*.mjs "$SERVER_DIR"/desktop/launcher.sh "$SERVER_DIR"/desktop/wallpaper.png; do
    [ -f "$f" ] || continue
    case "$f" in
      *.test.mjs) continue ;;
    esac
    cp -p "$f" "$desktop_tmp/"
  done
  rm -rf "$lib_dir/desktop"
  mv "$desktop_tmp" "$lib_dir/desktop"

  # Sandbox runner scripts, shims, and proxy modules (exclude tests).
  if [ -d "$SERVER_DIR/sandbox" ]; then
    local sandbox_tmp
    sandbox_tmp="$(mktemp -d "$lib_dir/.sandbox.tmp.XXXXXX")"
    cp -r "$SERVER_DIR/sandbox/." "$sandbox_tmp/"
    find "$sandbox_tmp" -name '*.test.mjs' -delete
    rm -rf "$lib_dir/sandbox"
    mv "$sandbox_tmp" "$lib_dir/sandbox"
  fi

  atomic_copy "$SERVER_DIR/acp-proxy" "$lib_dir/bin/acp-proxy" 0755
  if [ -f "$SERVER_DIR/buzz-host-tokens" ]; then
    atomic_copy "$SERVER_DIR/buzz-host-tokens" "$lib_dir/bin/buzz-host-tokens" 0755
  fi

  for f in "$SERVER_DIR"/shims/*; do
    [ -f "$f" ] || continue
    atomic_copy "$f" "$lib_dir/shims/$(basename "$f")" 0755
  done

  for f in "$SERVER_DIR"/agent-bin/*; do
    [ -f "$f" ] || continue
    atomic_copy "$f" "$lib_dir/agent-bin/$(basename "$f")" 0755
  done

  atomic_copy "$SERVER_DIR/buzz-host.service" "$systemd_dir/buzz-host.service" 0644
  atomic_copy "$SERVER_DIR/buzz-agent@.service" "$systemd_dir/buzz-agent@.service" 0644

  # Refresh auto-deploy units only if already enabled/installed on this host.
  for f in buzz-host-deploy.service buzz-host-deploy.timer; do
    if [ -f "$systemd_dir/$f" ] && [ -f "$SERVER_DIR/$f" ]; then
      atomic_copy "$SERVER_DIR/$f" "$systemd_dir/$f" 0644
    fi
  done

  # Hermes plugin: per-session agent identity in the gateway.
  local hp_tmp
  hp_tmp="$(mktemp -d "$lib_dir/.hermes-plugin.tmp.XXXXXX")"
  cp -r "$REPO_ROOT/hermes-plugin/buzz-host-session-env" "$hp_tmp/"
  rm -rf "$lib_dir/hermes-plugin"
  mv "$hp_tmp" "$lib_dir/hermes-plugin"
  sync_hermes_plugin_local "$lib_dir/hermes-plugin/buzz-host-session-env" "$hermes_dir"

  if [ "${BUZZ_HOST_SKIP_RESTART:-0}" != "1" ]; then
    systemctl --user daemon-reload
    systemctl --user restart buzz-host
    systemctl --user is-active buzz-host
  fi
}

deploy_ssh() {
  local host="$1"
  cd "$SERVER_DIR"
  ssh "$host" 'mkdir -p ~/.local/lib/buzz-host/{bin,shims,agent-bin} ~/.config/systemd/user'
  scp -q "${SERVER_FILES[@]}" "$host":.local/lib/buzz-host/
  if [ -f auto-deploy.sh ]; then
    scp -q auto-deploy.sh "$host":.local/lib/buzz-host/
  fi
  # Agent desktops (Xvnc + Xfce + cua-driver per agent; see README "Agent desktops").
  ssh "$host" 'rm -rf ~/.local/lib/buzz-host/desktop && mkdir -p ~/.local/lib/buzz-host/desktop'
  scp -q desktop/*.mjs desktop/launcher.sh desktop/wallpaper.png "$host":.local/lib/buzz-host/desktop/
  ssh "$host" 'rm -f ~/.local/lib/buzz-host/desktop/*.test.mjs'
  if [ -d sandbox ]; then
    ssh "$host" 'rm -rf ~/.local/lib/buzz-host/sandbox && mkdir -p ~/.local/lib/buzz-host/sandbox'
    scp -q -r sandbox/* "$host":.local/lib/buzz-host/sandbox/
    ssh "$host" 'find ~/.local/lib/buzz-host/sandbox -name "*.test.mjs" -delete'
  fi
  scp -q acp-proxy "$host":.local/lib/buzz-host/bin/
  if [ -f buzz-host-tokens ]; then
    scp -q buzz-host-tokens "$host":.local/lib/buzz-host/bin/
  fi
  scp -q shims/* "$host":.local/lib/buzz-host/shims/
  scp -q agent-bin/* "$host":.local/lib/buzz-host/agent-bin/
  scp -q buzz-host.service buzz-agent@.service "$host":.config/systemd/user/
  # Hermes plugin: per-session agent identity in the gateway. buzz-host installs
  # and enables it in each Hermes profile an agent uses, from this copy; refresh
  # the profiles that already have it (default included). Code changes take effect
  # on the next gateway reload (`systemctl --user reload hermes-gateway`).
  ssh "$host" 'rm -rf ~/.local/lib/buzz-host/hermes-plugin && mkdir -p ~/.local/lib/buzz-host/hermes-plugin'
  scp -q -r ../hermes-plugin/buzz-host-session-env "$host":.local/lib/buzz-host/hermes-plugin/
  ssh "$host" 'src=~/.local/lib/buzz-host/hermes-plugin/buzz-host-session-env
    for home in "$HOME/.hermes" "$HOME"/.hermes/profiles/*; do
      t="$home/plugins/buzz-host-session-env"
      if [ -d "$t" ] || { [ "$home" = "$HOME/.hermes" ] && [ -d "$home/plugins" ]; }; then
        rm -rf "$t" && cp -r "$src" "$t"
      fi
    done'
  if [ "${BUZZ_HOST_SKIP_RESTART:-0}" != "1" ]; then
    ssh "$host" 'systemctl --user daemon-reload && systemctl --user restart buzz-host && systemctl --user is-active buzz-host'
  fi
}

case "${1:-omarchy}" in
  --local|local)
    deploy_local
    ;;
  -h|--help)
    sed -n '2,5p' "$0"
    ;;
  *)
    deploy_ssh "$1"
    ;;
esac
