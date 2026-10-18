#!/usr/bin/env bash
# Builds livekit/ingress v1.5.0 with relay-stats-lock-order.patch applied and
# tags it livekit-ingress:1.5.0-lockfix (the image docker-compose.yaml uses).
#
# Why: on v1.5.0 a transcoded WHIP session (every OBS stream template, and the
# studio's OBS input) can deadlock at start. The stream never goes live, OBS
# keeps "streaming" into the dead session, and only an ingress restart clears
# it. Upstream fix: https://github.com/livekit/ingress/pull/530
#
# Drop this once a LiveKit release includes the fix: switch the compose file
# back to that release's image.
set -euo pipefail

TAG="${TAG:-livekit-ingress:1.5.0-lockfix}"
INGRESS_REF="v1.5.0"
# Same versions as upstream's own CI for v1.5.0 (.github/workflows/docker.yaml).
GOVERSION="1.25.0"
GSTVERSION="1.26.7"

here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --depth 1 --branch "$INGRESS_REF" https://github.com/livekit/ingress.git "$work/ingress"
git -C "$work/ingress" apply "$here/relay-stats-lock-order.patch"

docker build -t "$TAG" -f "$work/ingress/build/ingress/Dockerfile" \
  --build-arg GOVERSION="$GOVERSION" --build-arg GSTVERSION="$GSTVERSION" \
  "$work/ingress"

echo "Built $TAG. Then: docker compose up -d ingress (while nobody is streaming)."
