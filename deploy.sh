#!/bin/bash
# Copy buzz-host's server files to the host and restart it. Agents keep running.
# Usage:
#   ./deploy.sh [host]        Deploy over SSH (default: omarchy)
#   ./deploy.sh --local       Deploy atomically to the local machine (no SSH;
#                             systemd --user on Linux, a launchd LaunchAgent on macOS)
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
  mcp-server.mjs
  memory.mjs
  nip44.mjs
  discovery.mjs
  attention-relay.mjs
  noble.mjs
  workspace.mjs
  catalog.mjs
  orchestrator.mjs
  control.mjs
  file-lock.mjs
  ws-security.mjs
  service-manager.mjs
  iroh-supervisor.mjs
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

# Escape a value for an XML text node, then for a sed replacement (| delimiter).
plist_value() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/[|&\\]/\\&/g'
}

# macOS: install the buzz-host LaunchAgent from server/com.buzz-host.server.plist
# and (re)start it in the user's gui/<uid> domain.
install_launch_agent() {
  local lib_dir="$1"
  local agents_dir="${BUZZ_HOST_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
  local log_dir="${BUZZ_HOST_LOG_DIR:-$HOME/Library/Logs/buzz-host}"
  local label="com.buzz-host.server"
  local plist="$agents_dir/$label.plist"
  local node_bin runtime_dir
  node_bin="$(command -v node || true)"
  [ -n "$node_bin" ] || { echo "error: node not found on PATH" >&2; exit 1; }
  runtime_dir="${XDG_RUNTIME_DIR:-/tmp/bh-$(id -u)}"
  mkdir -p "$agents_dir" "$log_dir"
  local tmp
  tmp="$(mktemp "$agents_dir/.$label.plist.tmp.XXXXXX")"
  sed -e "s|__NODE__|$(plist_value "$node_bin")|g" \
      -e "s|__LIB__|$(plist_value "$lib_dir")|g" \
      -e "s|__HOME__|$(plist_value "$HOME")|g" \
      -e "s|__RUNTIME_DIR__|$(plist_value "$runtime_dir")|g" \
      -e "s|__LOG_DIR__|$(plist_value "$log_dir")|g" \
      "$SERVER_DIR/com.buzz-host.server.plist" > "$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$plist"
  if [ "${BUZZ_HOST_SKIP_RESTART:-0}" != "1" ]; then
    local domain="gui/$(id -u)"
    if launchctl print "$domain/$label" >/dev/null 2>&1; then
      # Reload so plist edits take effect, then it starts (RunAtLoad).
      launchctl bootout "$domain/$label" || true
      # bootout returns before the old job is gone; bootstrapping too soon
      # fails with "5: Input/output error".
      local i
      for i in 1 2 3 4 5 6 7 8 9 10; do
        launchctl print "$domain/$label" >/dev/null 2>&1 || break
        sleep 0.5
      done
    fi
    launchctl bootstrap "$domain" "$plist"
    launchctl print "$domain/$label" | grep -E '^[[:space:]]*state = ' || true
  fi
}

deploy_local() {
  local lib_dir="${BUZZ_HOST_LIB_DIR:-$HOME/.local/lib/buzz-host}"
  local systemd_dir="${BUZZ_HOST_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
  local hermes_dir="${BUZZ_HOST_HERMES_DIR:-$HOME/.hermes}"
  local gemini_dir="${BUZZ_HOST_GEMINI_DIR:-$HOME/.gemini}"

  local os_name
  os_name="$(uname -s)"

  mkdir -p "$lib_dir"/{bin,shims,agent-bin}
  if [ "$os_name" != "Darwin" ]; then
    mkdir -p "$systemd_dir"
  fi

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
  if [ -f "$REPO_ROOT/iroh-bridge/target/release/buzz-host-iroh" ]; then
    atomic_copy "$REPO_ROOT/iroh-bridge/target/release/buzz-host-iroh" "$lib_dir/bin/buzz-host-iroh" 0755
  fi

  # Tiny C stdio bridge per agent session (server/buzz-mcp-bridge.c). Compiled
  # here, atomically, whenever a C compiler is available; without one the
  # per-agent wrapper keeps starting the buzz-mcp.mjs fallback.
  local cc_bin=""
  for c in "${CC:-}" cc gcc clang; do
    if [ -n "$c" ] && command -v "$c" >/dev/null 2>&1; then
      cc_bin="$c"
      break
    fi
  done
  if [ -f "$SERVER_DIR/buzz-mcp-bridge.c" ] && [ -n "$cc_bin" ]; then
    local bridge_tmp
    bridge_tmp="$(mktemp "$lib_dir/bin/.buzz-mcp-bridge.tmp.XXXXXX")"
    if "$cc_bin" -O2 -Wall -Wextra -o "$bridge_tmp" "$SERVER_DIR/buzz-mcp-bridge.c"; then
      chmod 0755 "$bridge_tmp"
      mv -f "$bridge_tmp" "$lib_dir/bin/buzz-mcp-bridge"
    else
      rm -f "$bridge_tmp"
      echo "warning: buzz-mcp-bridge.c did not compile; keeping any installed bridge" >&2
    fi
  fi

  for f in "$SERVER_DIR"/shims/*; do
    [ -f "$f" ] || continue
    atomic_copy "$f" "$lib_dir/shims/$(basename "$f")" 0755
  done

  for f in "$SERVER_DIR"/agent-bin/*; do
    [ -f "$f" ] || continue
    atomic_copy "$f" "$lib_dir/agent-bin/$(basename "$f")" 0755
  done

  if [ "$os_name" != "Darwin" ]; then
    atomic_copy "$SERVER_DIR/buzz-host.service" "$systemd_dir/buzz-host.service" 0644
    atomic_copy "$SERVER_DIR/buzz-agent@.service" "$systemd_dir/buzz-agent@.service" 0644

    # Refresh auto-deploy units only if already enabled/installed on this host.
    for f in buzz-host-deploy.service buzz-host-deploy.timer; do
      if [ -f "$systemd_dir/$f" ] && [ -f "$SERVER_DIR/$f" ]; then
        atomic_copy "$SERVER_DIR/$f" "$systemd_dir/$f" 0644
      fi
    done
  fi

  # Hermes plugin: per-session agent identity in the gateway.
  local hp_tmp
  hp_tmp="$(mktemp -d "$lib_dir/.hermes-plugin.tmp.XXXXXX")"
  cp -r "$REPO_ROOT/hermes-plugin/buzz-host-session-env" "$hp_tmp/"
  rm -rf "$lib_dir/hermes-plugin"
  mv "$hp_tmp" "$lib_dir/hermes-plugin"
  sync_hermes_plugin_local "$lib_dir/hermes-plugin/buzz-host-session-env" "$hermes_dir"

  # Antigravity guard plugin: denies built-in `schedule` tool for Buzz agents.
  if [ -d "$REPO_ROOT/agy-plugin/buzz-host-guards" ]; then
    local ap_tmp
    ap_tmp="$(mktemp -d "$lib_dir/.agy-plugin.tmp.XXXXXX")"
    cp -r "$REPO_ROOT/agy-plugin/buzz-host-guards" "$ap_tmp/"
    chmod 0755 "$ap_tmp/buzz-host-guards/deny-schedule.sh" 2>/dev/null || true
    rm -rf "$lib_dir/agy-plugin"
    mv "$ap_tmp" "$lib_dir/agy-plugin"
    if [ -n "${BUZZ_HOST_GEMINI_DIR:-}" ] || [ -d "$gemini_dir" ]; then
      local agy_target="$gemini_dir/config/plugins/buzz-host-guards"
      mkdir -p "$gemini_dir/config/plugins"
      local agy_tmp
      agy_tmp="$(mktemp -d "$gemini_dir/config/plugins/.buzz-host-guards.tmp.XXXXXX")"
      cp -r "$lib_dir/agy-plugin/buzz-host-guards/." "$agy_tmp/"
      chmod 0755 "$agy_tmp/deny-schedule.sh" 2>/dev/null || true
      rm -rf "$agy_target"
      mv "$agy_tmp" "$agy_target"
    fi
  fi

  # Agents' own LaunchAgents are written by buzz-host (service-manager.mjs).
  if [ "$os_name" = "Darwin" ]; then
    install_launch_agent "$lib_dir"
  elif [ "${BUZZ_HOST_SKIP_RESTART:-0}" != "1" ]; then
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
  if [ -f "$REPO_ROOT/iroh-bridge/target/release/buzz-host-iroh" ]; then
    scp -q "$REPO_ROOT/iroh-bridge/target/release/buzz-host-iroh" "$host":.local/lib/buzz-host/bin/
  fi
  # Tiny C stdio bridge: compile on the host (it may not be this machine's arch).
  if [ -f buzz-mcp-bridge.c ]; then
    scp -q buzz-mcp-bridge.c "$host":.local/lib/buzz-host/
    ssh "$host" 'set -e
      src=~/.local/lib/buzz-host/buzz-mcp-bridge.c
      cc_bin=""
      for c in cc gcc clang; do
        if command -v "$c" >/dev/null 2>&1; then cc_bin="$c"; break; fi
      done
      if [ -n "$cc_bin" ]; then
        tmp="$(mktemp ~/.local/lib/buzz-host/bin/.buzz-mcp-bridge.tmp.XXXXXX)"
        if "$cc_bin" -O2 -Wall -Wextra -o "$tmp" "$src"; then
          chmod 0755 "$tmp"
          mv -f "$tmp" ~/.local/lib/buzz-host/bin/buzz-mcp-bridge
        else
          rm -f "$tmp"
          echo "warning: buzz-mcp-bridge.c did not compile; keeping any installed bridge" >&2
        fi
      else
        echo "warning: no C compiler on the host; skipping buzz-mcp-bridge" >&2
      fi'
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
  if [ -d "$REPO_ROOT/agy-plugin/buzz-host-guards" ]; then
    ssh "$host" 'rm -rf ~/.local/lib/buzz-host/agy-plugin && mkdir -p ~/.local/lib/buzz-host/agy-plugin'
    scp -q -r ../agy-plugin/buzz-host-guards "$host":.local/lib/buzz-host/agy-plugin/
    ssh "$host" 'chmod 0755 ~/.local/lib/buzz-host/agy-plugin/buzz-host-guards/deny-schedule.sh
      if [ -d "$HOME/.gemini" ]; then
        mkdir -p "$HOME/.gemini/config/plugins"
        rm -rf "$HOME/.gemini/config/plugins/buzz-host-guards"
        cp -r "$HOME/.local/lib/buzz-host/agy-plugin/buzz-host-guards" "$HOME/.gemini/config/plugins/buzz-host-guards"
        chmod 0755 "$HOME/.gemini/config/plugins/buzz-host-guards/deny-schedule.sh"
      fi'
  fi
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
