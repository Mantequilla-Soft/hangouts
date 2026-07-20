#!/bin/bash
# Test upload to audio.3speak.tv
# Usage: AUDIO_API_KEY=your_key ./test-upload.sh

API_KEY="${AUDIO_API_KEY:?Set AUDIO_API_KEY env var first}"
API_URL="${AUDIO_API_URL:-https://audio.3speak.tv}"

# Create a tiny silent MP3 (1 second) using ffmpeg
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1 -q:a 9 /tmp/test-hangout.mp3 -y 2>/dev/null

echo "=== Uploading test file ==="
curl -v -X POST "$API_URL/api/audio/upload" \
  -H "X-API-Key: $API_KEY" \
  -H "X-User: meno" \
  -F "audio=@/tmp/test-hangout.mp3" \
  -F "duration=1" \
  -F "format=mp3" \
  -F "title=Hangout Upload Test" \
  -F "category=podcast" \
  -F 'tags=["test"]'

echo ""
echo "=== Done ==="
rm -f /tmp/test-hangout.mp3
