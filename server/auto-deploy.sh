#!/bin/bash
# Pull-based auto-deploy for buzz-host on its host machine.
# Driven by buzz-host-deploy.timer (or manually via `systemctl --user start buzz-host-deploy`).
#
# Flow:
#   1. Acquire non-blocking flock so overlapping timer/manual runs never collide.
#   2. Fetch origin/$BRANCH into a dedicated clean checkout (separate from ~/Work/buzz-host).
#   3. Fast no-op when origin/$BRANCH matches deployed-sha (or known last-failed-sha).
#   4. Skip restarting buzz-host if no server/hermes-plugin/deploy.sh files changed.
#   5. Run the local server test suites before touching live files.
#   6. Snapshot managed live files, atomically install via deploy.sh --local, restart,
#      and verify service active + /health; roll back automatically on failure.
set -euo pipefail

REPO_URL="${BUZZ_HOST_REPO_URL:-git@github.com:ytheesh96/buzz-host.git}"
BRANCH="${BUZZ_HOST_BRANCH:-main}"
DEPLOY_REPO="${BUZZ_HOST_DEPLOY_REPO:-$HOME/.local/share/buzz-host-deploy/repo}"
STATE_DIR="${BUZZ_HOST_DEPLOY_STATE:-$HOME/.local/state/buzz-host-deploy}"
LIB_DIR="${BUZZ_HOST_LIB_DIR:-$HOME/.local/lib/buzz-host}"
SYSTEMD_DIR="${BUZZ_HOST_SYSTEMD_DIR:-$HOME/.config/systemd/user}"
HERMES_DIR="${BUZZ_HOST_HERMES_DIR:-$HOME/.hermes}"
GEMINI_DIR="${BUZZ_HOST_GEMINI_DIR:-$HOME/.gemini}"
CONFIG_PATH="${BUZZ_HOST_CONFIG:-$HOME/.config/buzz-host/config.json}"
HEALTH_TIMEOUT="${BUZZ_HOST_HEALTH_TIMEOUT:-15}"

SEED_ONLY=0
if [ "${1:-}" = "--seed" ]; then
  SEED_ONLY=1
fi

mkdir -p "$(dirname "$DEPLOY_REPO")" "$STATE_DIR"

exec 9>"$STATE_DIR/lock"
if ! flock -n 9; then
  exit 0
fi

log() {
  printf '[buzz-host-deploy] %s\n' "$*"
}

err() {
  printf '[buzz-host-deploy] ERROR: %s\n' "$*" >&2
}

write_atomic() {
  local path="$1" value="$2" tmp
  tmp="$(mktemp "$(dirname "$path")/.$(basename "$path").tmp.XXXXXX")"
  printf '%s\n' "$value" > "$tmp"
  mv -f "$tmp" "$path"
}

resolve_health_url() {
  if [ -n "${BUZZ_HOST_HEALTH_URL:-}" ]; then
    printf '%s' "$BUZZ_HOST_HEALTH_URL"
    return
  fi
  local port=8457
  if [ -f "$CONFIG_PATH" ] && command -v node >/dev/null 2>&1; then
    local parsed
    parsed="$(node -e 'try { const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (Number.isInteger(c.port)) console.log(c.port); } catch {}' "$CONFIG_PATH" 2>/dev/null || true)"
    if [ -n "$parsed" ]; then
      port="$parsed"
    fi
  fi
  printf 'http://127.0.0.1:%s/health' "$port"
}

run_git() {
  if [ -n "${BUZZ_HOST_GIT_SSH_COMMAND:-}" ]; then
    GIT_SSH_COMMAND="$BUZZ_HOST_GIT_SSH_COMMAND" git "$@"
  else
    git "$@"
  fi
}

# 1. Ensure dedicated clean checkout and fetch latest origin/$BRANCH.
if [ ! -d "$DEPLOY_REPO/.git" ]; then
  rm -rf "$DEPLOY_REPO"
  run_git clone --quiet --branch "$BRANCH" --single-branch "$REPO_URL" "$DEPLOY_REPO"
else
  run_git -C "$DEPLOY_REPO" fetch --quiet origin "$BRANCH"
fi

target_sha="$(git -C "$DEPLOY_REPO" rev-parse "origin/$BRANCH")"
deployed_sha=""
if [ -f "$STATE_DIR/deployed-sha" ]; then
  deployed_sha="$(tr -d '[:space:]' < "$STATE_DIR/deployed-sha")"
fi
last_failed_sha=""
if [ -f "$STATE_DIR/last-failed-sha" ]; then
  last_failed_sha="$(tr -d '[:space:]' < "$STATE_DIR/last-failed-sha")"
fi

if [ "$SEED_ONLY" -eq 1 ]; then
  git -C "$DEPLOY_REPO" reset --hard --quiet "$target_sha"
  git -C "$DEPLOY_REPO" clean -fdq
  write_atomic "$STATE_DIR/deployed-sha" "$target_sha"
  rm -f "$STATE_DIR/last-failed-sha"
  log "seeded deployed-sha at ${target_sha:0:7}"
  exit 0
fi

# 2. Fast no-op checks.
if [ "$target_sha" = "$deployed_sha" ]; then
  exit 0
fi

if [ "$target_sha" = "$last_failed_sha" ] && [ "${BUZZ_HOST_FORCE_RETRY:-0}" != "1" ]; then
  exit 0
fi

# 3. Reset dedicated checkout cleanly to target_sha.
git -C "$DEPLOY_REPO" reset --hard --quiet "$target_sha"
git -C "$DEPLOY_REPO" clean -fdq

short_old="${deployed_sha:0:7}"
if [ -z "$short_old" ]; then
  short_old="none"
fi
short_new="${target_sha:0:7}"

# 4. Path filter: skip restart when only plugins/docs changed.
needs_deploy=1
if [ -n "$deployed_sha" ] && git -C "$DEPLOY_REPO" cat-file -e "${deployed_sha}^{commit}" 2>/dev/null; then
  changed="$(git -C "$DEPLOY_REPO" diff --name-only "$deployed_sha" "$target_sha")"
  if ! printf '%s\n' "$changed" | grep -qE '^(server/|hermes-plugin/|agy-plugin/|deploy\.sh$)'; then
    needs_deploy=0
  fi
fi

if [ "$needs_deploy" -eq 0 ]; then
  write_atomic "$STATE_DIR/deployed-sha" "$target_sha"
  rm -f "$STATE_DIR/last-failed-sha"
  log "skip (no server/hermes-plugin changes): $short_old -> $short_new"
  exit 0
fi

# 5. Pre-deploy test gate.
run_tests() {
  if [ "${BUZZ_HOST_DEPLOY_SKIP_TESTS:-0}" = "1" ]; then
    return 0
  fi
  if [ -n "${BUZZ_HOST_TEST_CMD:-}" ]; then
    (cd "$DEPLOY_REPO" && bash -c "$BUZZ_HOST_TEST_CMD")
    return $?
  fi
  (
    cd "$DEPLOY_REPO"
    python3 -m unittest discover -s server -p 'test_*.py'
    node --test server/
    node --test attention/ memory/
  )
}

log "testing $short_old -> $short_new"
if ! run_tests; then
  err "pre-deploy tests failed for $short_new; keeping live $short_old"
  write_atomic "$STATE_DIR/last-failed-sha" "$target_sha"
  exit 1
fi

# 6. Snapshot managed live files (never touches bin/buzz, bin/buzz-acp, npm/, probe/).
BACKUP_DIR="$STATE_DIR/backup"
backup_live() {
  rm -rf "$BACKUP_DIR"
  mkdir -p "$BACKUP_DIR/lib/bin" "$BACKUP_DIR/systemd"
  local f d
  for f in "$LIB_DIR"/*.mjs "$LIB_DIR"/agent-run "$LIB_DIR"/auto-deploy.sh; do
    if [ -f "$f" ]; then
      cp -p "$f" "$BACKUP_DIR/lib/"
    fi
  done
  for f in acp-proxy buzz-host-tokens; do
    if [ -f "$LIB_DIR/bin/$f" ]; then
      cp -p "$LIB_DIR/bin/$f" "$BACKUP_DIR/lib/bin/"
    fi
  done
  for d in desktop sandbox shims agent-bin hermes-plugin agy-plugin; do
    if [ -d "$LIB_DIR/$d" ]; then
      cp -rp "$LIB_DIR/$d" "$BACKUP_DIR/lib/"
    fi
  done
  for f in buzz-host.service buzz-agent@.service buzz-host-deploy.service buzz-host-deploy.timer; do
    if [ -f "$SYSTEMD_DIR/$f" ]; then
      cp -p "$SYSTEMD_DIR/$f" "$BACKUP_DIR/systemd/"
    fi
  done
}

restore_backup() {
  if [ ! -d "$BACKUP_DIR/lib" ]; then
    return 0
  fi
  mkdir -p "$LIB_DIR/bin" "$SYSTEMD_DIR"
  local f tmp d
  for f in "$BACKUP_DIR"/lib/*.mjs "$BACKUP_DIR"/lib/agent-run "$BACKUP_DIR"/lib/auto-deploy.sh; do
    if [ -f "$f" ]; then
      tmp="$(mktemp "$LIB_DIR/.restore.tmp.XXXXXX")"
      cp -p "$f" "$tmp"
      mv -f "$tmp" "$LIB_DIR/$(basename "$f")"
    fi
  done
  for f in acp-proxy buzz-host-tokens; do
    if [ -f "$BACKUP_DIR/lib/bin/$f" ]; then
      tmp="$(mktemp "$LIB_DIR/bin/.restore.tmp.XXXXXX")"
      cp -p "$BACKUP_DIR/lib/bin/$f" "$tmp"
      mv -f "$tmp" "$LIB_DIR/bin/$f"
    fi
  done
  for d in desktop sandbox shims agent-bin hermes-plugin agy-plugin; do
    if [ -d "$BACKUP_DIR/lib/$d" ]; then
      tmp="$(mktemp -d "$LIB_DIR/.restore-${d}.tmp.XXXXXX")"
      cp -rp "$BACKUP_DIR/lib/$d/." "$tmp/"
      rm -rf "${LIB_DIR:?}/$d"
      mv "$tmp" "$LIB_DIR/$d"
    fi
  done
  for f in "$BACKUP_DIR"/systemd/*; do
    if [ -f "$f" ]; then
      tmp="$(mktemp "$SYSTEMD_DIR/.restore.tmp.XXXXXX")"
      cp -p "$f" "$tmp"
      mv -f "$tmp" "$SYSTEMD_DIR/$(basename "$f")"
    fi
  done
}

restart_service() {
  if [ -n "${BUZZ_HOST_RESTART_CMD:-}" ]; then
    bash -c "$BUZZ_HOST_RESTART_CMD"
  else
    systemctl --user daemon-reload
    systemctl --user restart buzz-host.service
  fi
}

check_health() {
  local url
  url="$(resolve_health_url)"
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  while [ "$SECONDS" -lt "$deadline" ]; do
    local active_ok=0 health_ok=0
    if [ -n "${BUZZ_HOST_ACTIVE_CMD:-}" ]; then
      if bash -c "$BUZZ_HOST_ACTIVE_CMD"; then
        active_ok=1
      fi
    else
      if systemctl --user is-active --quiet buzz-host.service; then
        active_ok=1
      fi
    fi
    if [ "$active_ok" -eq 1 ]; then
      if [ -n "${BUZZ_HOST_HEALTH_CMD:-}" ]; then
        if bash -c "$BUZZ_HOST_HEALTH_CMD"; then
          health_ok=1
        fi
      else
        if [ "$(curl -sf --max-time 2 "$url" 2>/dev/null | tr -d '[:space:]')" = "ok" ]; then
          health_ok=1
        fi
      fi
    fi
    if [ "$active_ok" -eq 1 ] && [ "$health_ok" -eq 1 ]; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

backup_live

# 7. Atomic install + restart + health check (rollback on any failure).
deploy_ok=0
if BUZZ_HOST_LIB_DIR="$LIB_DIR" \
   BUZZ_HOST_SYSTEMD_DIR="$SYSTEMD_DIR" \
   BUZZ_HOST_HERMES_DIR="$HERMES_DIR" \
   BUZZ_HOST_GEMINI_DIR="$GEMINI_DIR" \
   BUZZ_HOST_SKIP_RESTART=1 \
   "$DEPLOY_REPO/deploy.sh" --local; then
  if restart_service && check_health; then
    deploy_ok=1
  fi
fi

if [ "$deploy_ok" -eq 1 ]; then
  write_atomic "$STATE_DIR/deployed-sha" "$target_sha"
  rm -f "$STATE_DIR/last-failed-sha"
  log "deployed: $short_old -> $short_new"
  exit 0
fi

err "deploy or health check failed for $short_new; rolling back to $short_old"
restore_backup || true
restart_service || true
write_atomic "$STATE_DIR/last-failed-sha" "$target_sha"
exit 1
