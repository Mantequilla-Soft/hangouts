#!/bin/bash
# Test upload to audio.3speak.tv

API_KEY="sk_temporarykey_802d832ee3f80fe8499ec1323ea104843cb8c2eb4a0ad38c"
API_URL="https://audio.3speak.tv"

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
