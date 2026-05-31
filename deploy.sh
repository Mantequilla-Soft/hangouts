#!/bin/bash
# Deploy Hive Hangouts to VPS
# Usage: sudo bash /opt/hangouts/deploy.sh

set -e

# Load secrets from /opt/hangouts/.env.local if present (not committed to git)
[ -f /opt/hangouts/.env.local ] && source /opt/hangouts/.env.local

echo "=== Pulling latest code ==="
cd /opt/hangouts
git stash 2>/dev/null || true
git pull

echo "=== Building sdk-core ==="
cd /opt/hangouts/packages/sdk-core
npm install --silent
npm run build

echo "=== Building sdk-react ==="
cd /opt/hangouts/packages/sdk-react
npm install --silent
npm run build

echo "=== Building demo ==="
cd /opt/hangouts/demo
npm install --silent
VITE_API_URL=https://hangout-api.3speak.tv VITE_LIVEKIT_URL=wss://livekit.3speak.tv VITE_IMAGE_SERVER_API_KEY=${VITE_IMAGE_SERVER_API_KEY:-} npx vite build

echo "=== Building docs ==="
cd /opt/hangouts/docs-site
npm install --silent
npx vite build

echo "=== Ensuring recording directory is persistent ==="
# Register with systemd-tmpfiles so the directory is never cleaned and is
# recreated automatically on every boot (before Docker starts).
echo 'd /tmp/livekit-recordings 0777 root root -' > /etc/tmpfiles.d/livekit-recordings.conf
systemd-tmpfiles --create /etc/tmpfiles.d/livekit-recordings.conf
# Restart the Egress container so its bind mount picks up the directory.
docker restart livekit-egress-1 2>/dev/null || true

echo "=== Restarting API server ==="
cd /opt/hangouts/server
npm install --silent
systemctl restart hangouts-api

echo "=== Done ==="
echo "Demo: https://hangout.3speak.tv"
echo "API:  https://hangout-api.3speak.tv"
echo "Docs: https://hangout.3speak.tv/docs"
