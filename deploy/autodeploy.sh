#!/usr/bin/env bash
# Auto-deploy Hive Hangouts from GitHub main.
#
# Run as root by hangouts-autodeploy.timer every 2 minutes (see deploy/README.md).
# When origin/main has moved and its "ci-ok" GitHub check passed, it
# fast-forwards the checkout, rebuilds (SDKs, demo, docs, server deps) as the
# repo owner, restarts the API and health-checks it. If the build or the health
# check fails, it rolls back to the previous commit and restarts that.
#
# Logs: journalctl -u hangouts-autodeploy

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/hangouts}
REPO_SLUG=${REPO_SLUG:-Mantequilla-Soft/hangouts}
BRANCH=${BRANCH:-main}
CHECK_NAME=${CHECK_NAME:-ci-ok}
SERVICE=${SERVICE:-hangouts-api}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3002/rooms}
STATE_DIR=${STATE_DIR:-/var/lib/hangouts-autodeploy}
LOCK_FILE=${LOCK_FILE:-/run/lock/hangouts-deploy.lock}
SKIP_RESTART=${SKIP_RESTART:-0}   # testing only

APP_USER=$(stat -c %U "$REPO_DIR")
APP_HOME=$(getent passwd "$APP_USER" | cut -d: -f6)

log() { echo "[autodeploy] $*"; }

# Run a command as the repo owner, so git objects and build output keep their ownership.
as_app() {
  if [ "$(id -un)" = "$APP_USER" ]; then
    env HOME="$APP_HOME" "$@"
  else
    runuser -u "$APP_USER" -- env HOME="$APP_HOME" PATH="$PATH" "$@"
  fi
}
git_app() { as_app git -C "$REPO_DIR" "$@"; }

# Log a message only the first time it is seen for a given key (avoids a line every tick).
log_once() {
  local key=$1; shift
  if [ "$(cat "$STATE_DIR/$key" 2>/dev/null)" != "$*" ]; then
    echo "$*" > "$STATE_DIR/$key"
    log "$*"
  fi
}

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another deploy is running, skipping"; exit 0; }

# Public repo: fetch over HTTPS so no SSH key is needed.
git_app fetch -q "https://github.com/$REPO_SLUG.git" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
current=$(git_app rev-parse HEAD)
target=$(git_app rev-parse "origin/$BRANCH")
[ "$current" = "$target" ] && exit 0

short=${target:0:7}
[ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$target" ] && exit 0

if ! git_app merge-base --is-ancestor HEAD "origin/$BRANCH"; then
  log_once blocked "HEAD ${current:0:7} is not an ancestor of origin/$BRANCH (local commits?), not deploying $short"
  exit 1
fi
if ! git_app diff --quiet HEAD; then
  log_once blocked "tracked files in $REPO_DIR have local changes, not deploying $short:"
  git_app status --short --untracked-files=no
  exit 1
fi

# Gate on the ci-ok check for this exact commit.
runs=$(curl -fsS --max-time 20 -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/$REPO_SLUG/commits/$target/check-runs?check_name=$CHECK_NAME") || {
  log "GitHub API unreachable, retrying next tick"; exit 0; }
read -r status conclusion < <(jq -r '.check_runs | sort_by(.started_at) | last | "\(.status // "none") \(.conclusion // "none")"' <<<"$runs")

if [ "$status" != "completed" ]; then
  log_once waiting "waiting for CI on $short (check $CHECK_NAME: $status)"
  exit 0
fi
if [ "$conclusion" != "success" ]; then
  echo "$target" > "$STATE_DIR/failed"
  log "CI did not pass on $short ($CHECK_NAME: $conclusion), not deploying it"
  exit 0
fi

# Rebuild everything deploy.sh builds. Runs as the repo owner in its own shell so
# `set -e` applies. `npm ci` only where the lockfile changed or deps are missing.
build() {
  local from=$1 to=$2
  as_app bash -euo pipefail -c '
    repo=$1 from=$2 to=$3
    [ -f "$repo/.env.local" ] && source "$repo/.env.local"
    deps() {
      if [ ! -d node_modules ] || ! git -C "$repo" diff --quiet "$from" "$to" -- "$1/package-lock.json"; then
        echo "--- npm ci in $1"
        npm ci --no-audit --no-fund --loglevel=error
      fi
    }
    echo "--- sdk-core";  cd "$repo/packages/sdk-core";  deps packages/sdk-core;  npm run build
    echo "--- sdk-react"; cd "$repo/packages/sdk-react"; deps packages/sdk-react
    rsync -a --delete "$repo/packages/sdk-core/dist/" ./node_modules/@snapie/hangouts-core/dist/
    npm run build
    echo "--- demo";      cd "$repo/demo"; deps demo
    VITE_API_URL=https://hangout-api.3speak.tv VITE_LIVEKIT_URL=wss://livekit.3speak.tv \
      VITE_IMAGE_SERVER_API_KEY=${VITE_IMAGE_SERVER_API_KEY:-} npx vite build --logLevel warn
    echo "--- docs";      cd "$repo/docs-site"; deps docs-site; npx vite build --logLevel warn
    echo "--- server";    cd "$repo/server"; deps server
  ' build "$REPO_DIR" "$from" "$to"
}

restart_and_check() {
  [ "$SKIP_RESTART" = 1 ] && { log "SKIP_RESTART=1, not restarting $SERVICE"; return 0; }
  systemctl restart "$SERVICE"
  for _ in $(seq 1 30); do
    sleep 2
    if curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL"; then return 0; fi
  done
  log "$SERVICE did not answer $HEALTH_URL within 60s"
  systemctl status "$SERVICE" --no-pager -n 20 || true
  return 1
}

log "deploying ${current:0:7} -> $short: $(git_app log -1 --format=%s "$target")"
git_app merge --ff-only -q "origin/$BRANCH"

if build "$current" "$target" && restart_and_check; then
  rm -f "$STATE_DIR/waiting" "$STATE_DIR/blocked"
  log "deployed $short"
  exit 0
fi

log "deploy of $short FAILED, rolling back to ${current:0:7}"
echo "$target" > "$STATE_DIR/failed"
git_app reset -q --hard "$current"
if build "$target" "$current" && restart_and_check; then
  log "rolled back to ${current:0:7}"
else
  log "ROLLBACK FAILED, $SERVICE needs a manual look"
fi
exit 1
