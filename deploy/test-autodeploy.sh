#!/usr/bin/env bash
# Tests for deploy/autodeploy.sh, run in a sandbox: a local git origin, a checkout
# owned by the current user, and stubs for curl (GitHub checks, LiveKit, the health
# URL), npm, npx, rsync and systemctl. Nothing touches the box it runs on.
#
#   bash deploy/test-autodeploy.sh          all cases
#   bash deploy/test-autodeploy.sh quiet    only cases whose name contains "quiet"
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/autodeploy.sh"
ONLY="${1:-}"
ROOT=$(mktemp -d); trap 'rm -rf "$ROOT"' EXIT
PASS=0; FAIL=0; CASE=
GIT_ID=(-c user.name=test -c user.email=test@example.invalid)

ok()  { PASS=$((PASS+1)); echo "  ok    $CASE: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $CASE: $1"; }
assert_eq() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }
assert_contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else bad "$3 (missing '$2')"; fi; }
assert_not_contains() { if grep -qF -- "$2" <<<"$1"; then bad "$3 (found '$2')"; else ok "$3"; fi; }
t() { CASE=$1; }
case_() { [ -z "$ONLY" ] || [[ "$1" == *"$ONLY"* ]]; }

stub() {   # name body: a logging stub in $SB/bin with $SB baked in
  { echo '#!/usr/bin/env bash'; echo "SB=$SB"; cat; } > "$SB/bin/$1"; chmod +x "$SB/bin/$1"
}

setup() {
  SB=$(mktemp -d "$ROOT/sb.XXXX")
  mkdir -p "$SB"/{bin,state,ctl}
  : > "$SB/calls.log"
  printf 'LIVEKIT_API_KEY=testkey\nLIVEKIT_API_SECRET=testsecret\n' > "$SB/lk.env"

  # curl: GitHub check-runs, LiveKit ListRooms, the health URL.
  stub curl <<'EOF'
url=; auth=
while [ $# -gt 0 ]; do
  case "$1" in -H) [[ "$2" == Authorization:* ]] && auth=${2#Authorization: Bearer }; shift ;;
    -X|-d|--max-time|-o) shift ;; http*) url=$1 ;; esac; shift
done
case "$url" in
  */check-runs*)
    st=$(cat "$SB/ctl/ci" 2>/dev/null || echo success)
    if [ "$st" = pending ]; then echo '{"check_runs":[{"status":"in_progress","conclusion":null,"started_at":"1"}]}'
    else echo "{\"check_runs\":[{\"status\":\"completed\",\"conclusion\":\"$st\",\"started_at\":\"1\"}]}"; fi ;;
  */twirp/livekit.RoomService/ListRooms)
    echo "livekit $auth" >> "$SB/calls.log"
    [ -f "$SB/ctl/livekit_down" ] && exit 7
    cat "$SB/ctl/rooms" 2>/dev/null || echo '{}' ;;
  *) [ -f "$SB/ctl/health_fail" ] && exit 7; echo ok ;;
esac
EOF
  stub systemctl <<<'echo "systemctl $*" >> "$SB/calls.log"'
  stub rsync <<<'exit 0'
  stub npm <<'EOF'
echo "npm $* in ${PWD##*/}" >> "$SB/calls.log"
[ "$1 $2" = "run build" ] && [ "${PWD##*/}" = server ] && [ -f "$SB/ctl/build_fail" ] && exit 1
exit 0
EOF
  stub npx <<<'echo "npx $* in ${PWD##*/} VITE_API_URL=${VITE_API_URL:-unset}" >> "$SB/calls.log"'

  git init -q --bare -b main "$SB/origin.git"
  git clone -q "$SB/origin.git" "$SB/dev" 2>/dev/null
  git -C "$SB/dev" checkout -q -b main
  mkdir -p "$SB/dev"/{packages/sdk-core,packages/sdk-react/node_modules/@snapie/hangouts-core,demo,docs-site,server}
  for d in packages/sdk-core packages/sdk-react demo docs-site server; do echo '{}' > "$SB/dev/$d/package-lock.json"; done
  printf 'node_modules\n' > "$SB/dev/.gitignore"
  echo v1 > "$SB/dev/server/index.ts"
  git -C "$SB/dev" add -A; git -C "$SB/dev" "${GIT_ID[@]}" commit -qm v1
  git -C "$SB/dev" push -q origin main
  git clone -q -b main "$SB/origin.git" "$SB/repo"
  for d in packages/sdk-core packages/sdk-react demo docs-site server; do mkdir -p "$SB/repo/$d/node_modules"; done
  LIVE0=$(git -C "$SB/repo" rev-parse HEAD)
}

commit() {   # content: a new commit on origin/main, prints its sha
  echo "$1" > "$SB/dev/server/index.ts"
  git -C "$SB/dev" add -A; git -C "$SB/dev" "${GIT_ID[@]}" commit -qm "$1"
  git -C "$SB/dev" push -q origin main 2>/dev/null
  git -C "$SB/dev" rev-parse HEAD
}

run() {   # VAR=value ...: run the script, output in $OUT, exit code in $RC
  OUT=$(env -i PATH="$SB/bin:/usr/local/bin:/usr/bin:/bin" HOME="$SB" \
    REPO_DIR="$SB/repo" REPO_URL="$SB/origin.git" GITHUB_API=https://gh.invalid \
    STATE_DIR="$SB/state" LOCK_FILE="$SB/deploy.lock" LIVEKIT_KEYS_FILE="$SB/lk.env" \
    HEALTH_URL=http://127.0.0.1:3002/rooms LIVEKIT_HTTP=http://127.0.0.1:7880 \
    VITE_API_URL=https://should-not-leak.invalid "$@" bash "$SCRIPT" 2>&1)
  RC=$?
}
head_sha() { git -C "$SB/repo" rev-parse HEAD; }
calls() { grep -c -- "$1" "$SB/calls.log"; }
rooms() { echo "{\"rooms\":[$1]}" > "$SB/ctl/rooms"; }

echo "autodeploy.sh"

if case_ up-to-date; then t up-to-date; setup
  run
  assert_eq "$RC" 0 "exits 0 when main has not moved"
  assert_eq "$(calls systemctl)" 0 "does not restart anything"
fi

if case_ ci-pending; then t ci-pending; setup
  sha=$(commit v2); echo pending > "$SB/ctl/ci"; run
  assert_eq "$(head_sha)" "$LIVE0" "does not deploy while CI runs"
  assert_contains "$OUT" "waiting for CI" "says it waits for CI"
fi

if case_ deploy-site; then t deploy-site; setup
  sha=$(commit v2); run
  assert_eq "$RC" 0 "exits 0"
  assert_eq "$(head_sha)" "$sha" "the checkout is on the new commit"
  assert_eq "$(calls 'systemctl restart hangouts-api')" 1 "restarts the API once"
  assert_eq "$(calls 'npm run build in server')" 1 "compiles the server (dist is not in git)"
  assert_contains "$(cat "$SB/calls.log")" "npx vite build --logLevel warn in demo VITE_API_URL=https://hangout-api.3speak.tv" "builds the demo site with its API URL"
  assert_eq "$(calls 'in docs-site')" 1 "builds the docs"
  assert_eq "$(calls livekit)" 0 "does not ask LiveKit when the wait is off (the default)"
fi

if case_ deploy-egress; then t deploy-egress; setup
  sha=$(commit v2); run DEMO_BUILD=egress DOCS_BUILD=0
  assert_eq "$(head_sha)" "$sha" "deploys"
  assert_contains "$(cat "$SB/calls.log")" "npx vite build --base /egress-template/ --logLevel warn in demo VITE_API_URL=unset" "builds the egress template with its base and no VITE_* URLs"
  assert_eq "$(calls 'in docs-site')" 0 "skips the docs"
fi

if case_ quiet-busy; then t quiet-busy; setup
  sha=$(commit v2); rooms '{"name":"s1","num_participants":3},{"name":"empty","num_participants":0}'
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$RC" 0 "exits 0 while waiting"
  assert_eq "$(head_sha)" "$LIVE0" "does not deploy while a room has people in it"
  assert_eq "$(calls systemctl)" 0 "does not restart the API"
  assert_contains "$OUT" "waiting for live rooms to end" "says why"
  [ -f "$SB/state/quiet_since" ] && ok "remembers when the wait began" || bad "remembers when the wait began"
  run QUIET_WAIT_MAX_MIN=240
  assert_not_contains "$OUT" "waiting for live rooms" "logs the wait once, not every tick"
  # The token LiveKit got: three parts, our key as issuer, roomList, and a valid HS256 signature.
  tok=$(grep -m1 '^livekit ' "$SB/calls.log" | cut -d' ' -f2)
  IFS=. read -r h p s <<<"$tok"
  pad() { local x=$1; while [ $(( ${#x} % 4 )) -ne 0 ]; do x="$x="; done; tr '_-' '/+' <<<"$x"; }
  claims=$(pad "$p" | openssl base64 -d -A)
  assert_eq "$(jq -r .iss <<<"$claims")" testkey "the token is issued by the box's LiveKit key"
  assert_eq "$(jq -r .video.roomList <<<"$claims")" true "the token may list rooms"
  want=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac testsecret -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  assert_eq "$s" "$want" "the token is signed with the box's LiveKit secret"
  assert_not_contains "$OUT" "testsecret" "never prints the secret"
fi

if case_ quiet-empty; then t quiet-empty; setup
  sha=$(commit v2); rooms '{"name":"empty","num_participants":0}'
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "deploys when no room has anyone in it"
fi

if case_ quiet-ends; then t quiet-ends; setup
  sha=$(commit v2); rooms '{"name":"s1","num_participants":2}'
  run QUIET_WAIT_MAX_MIN=240
  rooms ''
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "deploys once the stream has ended"
  assert_contains "$OUT" "no live rooms any more" "says so"
  [ -f "$SB/state/quiet_since" ] && bad "clears the wait" || ok "clears the wait"
fi

if case_ quiet-max; then t quiet-max; setup
  sha=$(commit v2); rooms '{"name":"s1","num_participants":2}'
  echo $(( $(date +%s) - 241*60 )) > "$SB/state/quiet_since"
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "deploys anyway after the maximum wait"
  assert_contains "$OUT" "deploying anyway" "says so"
fi

if case_ quiet-newer-commit; then t quiet-newer-commit; setup
  a=$(commit v2); rooms '{"name":"s1","num_participants":2}'
  run QUIET_WAIT_MAX_MIN=240
  since=$(cat "$SB/state/quiet_since")
  b=$(commit v3); run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(cat "$SB/state/quiet_since")" "$since" "a newer merge does not restart the wait"
fi

if case_ quiet-force; then t quiet-force; setup
  sha=$(commit v2); rooms '{"name":"s1","num_participants":2}'; touch "$SB/state/force"
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "the force file deploys right away"
  [ -f "$SB/state/force" ] && bad "the force file is used once" || ok "the force file is used once"
fi

if case_ quiet-livekit-down; then t quiet-livekit-down; setup
  sha=$(commit v2); touch "$SB/ctl/livekit_down"
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "deploys when LiveKit cannot be asked (nothing streams then)"
  assert_contains "$OUT" "could not ask LiveKit" "says so"
  t quiet-no-keys; setup
  sha=$(commit v2); rm "$SB/lk.env"
  run QUIET_WAIT_MAX_MIN=240
  assert_eq "$(head_sha)" "$sha" "deploys when the key file is missing, with a log line"
  assert_contains "$OUT" "could not ask LiveKit" "says so"
fi

if case_ rollback; then t rollback; setup
  sha=$(commit v2); touch "$SB/ctl/build_fail"; run
  assert_eq "$RC" 1 "exits 1 when the build fails"
  assert_eq "$(head_sha)" "$LIVE0" "rolls back to the previous commit"
  assert_eq "$(cat "$SB/state/failed")" "$sha" "remembers the failed commit"
  rm "$SB/ctl/build_fail"; : > "$SB/calls.log"; run
  assert_eq "$(calls systemctl)" 0 "does not retry the failed commit"
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
