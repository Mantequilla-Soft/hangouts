#!/bin/bash
# Deploy Hive Hangouts to VPS
# Usage: sudo bash /opt/hangouts/deploy.sh

set -e

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
VITE_API_URL=https://hangout-api.3speak.tv VITE_LIVEKIT_URL=wss://livekit.3speak.tv npx vite build

echo "=== Building docs ==="
cd /opt/hangouts/docs-site
npm install --silent
npx vite build

echo "=== Restarting API server ==="
cd /opt/hangouts/server
npm install --silent
systemctl restart hangouts-api

echo "=== Done ==="
echo "Demo: https://hangout.3speak.tv"
echo "API:  https://hangout-api.3speak.tv"
echo "Docs: https://hangout.3speak.tv/docs"
