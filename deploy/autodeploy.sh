#!/usr/bin/env bash
# Auto-deploy Hive Hangouts from GitHub main.
#
# Run as root by hangouts-autodeploy.timer every 2 minutes (see deploy/README.md).
# When origin/main has moved and its "ci-ok" GitHub check passed, it
# fast-forwards the checkout, rebuilds (SDKs, demo, docs, server) as the repo
# owner, restarts the API and health-checks it. If the build or the health check
# fails, it rolls back to the previous commit and restarts that.
#
# With QUIET_WAIT_MAX_MIN set, a deploy first waits until no LiveKit room has
# anyone in it (a restart loses running recordings, see the README), up to that
# many minutes; after that it deploys anyway. Each tick checks once and exits,
# so a long wait never blocks the timer.
#
# Logs: journalctl -u hangouts-autodeploy

set -euo pipefail

REPO_DIR=${REPO_DIR:-/opt/hangouts}
REPO_SLUG=${REPO_SLUG:-Mantequilla-Soft/hangouts}
REPO_URL=${REPO_URL:-https://github.com/$REPO_SLUG.git}
GITHUB_API=${GITHUB_API:-https://api.github.com}
BRANCH=${BRANCH:-main}
CHECK_NAME=${CHECK_NAME:-ci-ok}
SERVICE=${SERVICE:-hangouts-api}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:3002/rooms}
STATE_DIR=${STATE_DIR:-/var/lib/hangouts-autodeploy}
LOCK_FILE=${LOCK_FILE:-/run/lock/hangouts-deploy.lock}
SKIP_RESTART=${SKIP_RESTART:-0}   # testing only
# What to build besides the SDKs and the server:
#   DEMO_BUILD=site    the demo site (hangout.3speak.tv), with DEMO_API_URL / DEMO_LIVEKIT_URL
#   DEMO_BUILD=egress  the LiveKit egress recording template: base /egress-template/,
#                      no VITE_* env (it falls back to the local API and LiveKit)
#   DEMO_BUILD=none    skip it
DEMO_BUILD=${DEMO_BUILD:-site}
DEMO_API_URL=${DEMO_API_URL:-https://hangout-api.3speak.tv}
DEMO_LIVEKIT_URL=${DEMO_LIVEKIT_URL:-wss://livekit.3speak.tv}
DOCS_BUILD=${DOCS_BUILD:-1}
# Wait for live rooms to empty before deploying, at most this many minutes (0 = off).
QUIET_WAIT_MAX_MIN=${QUIET_WAIT_MAX_MIN:-0}
LIVEKIT_HTTP=${LIVEKIT_HTTP:-http://127.0.0.1:7880}
# Read for LIVEKIT_API_KEY / LIVEKIT_API_SECRET (never printed).
LIVEKIT_KEYS_FILE=${LIVEKIT_KEYS_FILE:-/opt/livekit/lk.env}

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

# How many LiveKit rooms have someone in them; prints the count, fails when LiveKit
# can't be asked. Signs a short-lived admin token with the box's own key pair, so
# it sees every room: unlisted ones and OBS streams included, which /rooms and
# /streams leave out.
busy_rooms() {
  local key secret now header payload sig token body
  key=$(grep -m1 '^LIVEKIT_API_KEY=' "$LIVEKIT_KEYS_FILE" 2>/dev/null | cut -d= -f2-) || return 1
  secret=$(grep -m1 '^LIVEKIT_API_SECRET=' "$LIVEKIT_KEYS_FILE" 2>/dev/null | cut -d= -f2-) || return 1
  [ -n "$key" ] && [ -n "$secret" ] || return 1
  b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
  now=$(date +%s)
  header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(jq -cn --arg iss "$key" --argjson now "$now" \
    '{iss:$iss, sub:"autodeploy", nbf:($now-10), exp:($now+300), video:{roomList:true}}' | b64url)
  sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$secret" -binary | b64url)
  token="$header.$payload.$sig"
  body=$(curl -fsS --max-time 10 -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    -d '{}' "$LIVEKIT_HTTP/twirp/livekit.RoomService/ListRooms") || return 1
  jq -r '[.rooms[]? | select((.num_participants // 0) > 0)] | length' <<<"$body"
}

# 0 = deploy now, 1 = keep waiting (this tick ends). Only when QUIET_WAIT_MAX_MIN > 0.
# The wait starts with the first busy tick and is not reset by a newer commit, so
# merges during a long stream can't push the deploy out forever.
quiet_gate() {
  [ "${QUIET_WAIT_MAX_MIN:-0}" -gt 0 ] || return 0
  if [ -f "$STATE_DIR/force" ]; then
    rm -f "$STATE_DIR/force" "$STATE_DIR/quiet_since" "$STATE_DIR/quiet"
    log "force file found, deploying without waiting for live rooms"
    return 0
  fi
  local busy now since waited
  if ! busy=$(busy_rooms); then
    log_once quiet "could not ask LiveKit ($LIVEKIT_HTTP) for live rooms, deploying without waiting"
    rm -f "$STATE_DIR/quiet_since"
    return 0
  fi
  if [ "$busy" = 0 ]; then
    [ -f "$STATE_DIR/quiet_since" ] && log "no live rooms any more, deploying"
    rm -f "$STATE_DIR/quiet_since" "$STATE_DIR/quiet"
    return 0
  fi
  now=$(date +%s)
  [ -f "$STATE_DIR/quiet_since" ] || echo "$now" > "$STATE_DIR/quiet_since"
  since=$(cat "$STATE_DIR/quiet_since")
  waited=$(( (now - since) / 60 ))
  if [ "$waited" -ge "$QUIET_WAIT_MAX_MIN" ]; then
    log "still $busy live room(s) after ${waited} min (max $QUIET_WAIT_MAX_MIN), deploying anyway"
    rm -f "$STATE_DIR/quiet_since" "$STATE_DIR/quiet"
    return 0
  fi
  log_once quiet "waiting for live rooms to end before deploying $short (max $QUIET_WAIT_MAX_MIN min, since $(date -u -d "@$since" +%H:%MZ))"
  return 1
}

mkdir -p "$STATE_DIR"
exec 9>"$LOCK_FILE"
flock -n 9 || { log "another deploy is running, skipping"; exit 0; }

# Public repo: fetch over HTTPS so no SSH key is needed.
git_app fetch -q "$REPO_URL" "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
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
  "$GITHUB_API/repos/$REPO_SLUG/commits/$target/check-runs?check_name=$CHECK_NAME") || {
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
  as_app env DEMO_BUILD="$DEMO_BUILD" DOCS_BUILD="$DOCS_BUILD" \
    DEMO_API_URL="$DEMO_API_URL" DEMO_LIVEKIT_URL="$DEMO_LIVEKIT_URL" \
    bash -euo pipefail -c '
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
    case "$DEMO_BUILD" in
      site)
        echo "--- demo";   cd "$repo/demo"; deps demo
        VITE_API_URL=$DEMO_API_URL VITE_LIVEKIT_URL=$DEMO_LIVEKIT_URL \
          VITE_IMAGE_SERVER_API_KEY=${VITE_IMAGE_SERVER_API_KEY:-} npx vite build --logLevel warn ;;
      egress)
        # The recording template must NOT get VITE_* URLs: it falls back to the
        # local API and LiveKit, which is what the egress container can reach.
        echo "--- demo (egress template)"; cd "$repo/demo"; deps demo
        env -u VITE_API_URL -u VITE_LIVEKIT_URL -u VITE_IMAGE_SERVER_API_KEY \
          npx vite build --base /egress-template/ --logLevel warn ;;
      none) ;;
      *) echo "unknown DEMO_BUILD=$DEMO_BUILD"; exit 1 ;;
    esac
    if [ "$DOCS_BUILD" = 1 ]; then
      echo "--- docs";    cd "$repo/docs-site"; deps docs-site; npx vite build --logLevel warn
    fi
    # dist/ is not in git: without the compile the restarted API runs the old build.
    echo "--- server";    cd "$repo/server"; deps server; npm run build
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

quiet_gate || exit 0

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
