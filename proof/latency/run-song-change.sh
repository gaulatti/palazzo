#!/usr/bin/env bash
# palazzo#47 step 1b: today's path across song changes. Clicks go into the RTMP
# live input every 15 s while Palazzo plays quiet tone "songs" under them:
# song A (40 s) starts at once, song B is queued at 45 s (after A's natural
# end), and song C replaces B at 95 s. A live-edge decoder listens alongside
# the browser page (browser-ear.mjs), so both see the same clicks.
# Usage: run-song-change.sh <tag>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="$1"
out="$here/.run"
api=http://127.0.0.1:13100/v1/programs/program-proof/playback/song
song() {
  curl --fail --silent --header "Idempotency-Key: $tag-$1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-proof\",\"playbackId\":\"$tag-$1\",\"url\":\"http://127.0.0.1:3200/song-$1.wav\",\"title\":\"Proof $1\",\"artist\":\"Proof\",\"duration\":$2}}" \
    "$api" >/dev/null && echo "$(date -u +%H:%M:%S.%3N 2>/dev/null || date -u +%H:%M:%S) song $1 commanded" >> "$out/$tag-songs.log"
}
: > "$out/$tag-songs.log"
ffmpeg -hide_banner -loglevel error -fflags nobuffer -probesize 32768 -analyzeduration 0 \
  -i http://127.0.0.1:18000/stream -f s16le -ar 48000 -ac 1 - \
  | node "$here/ear-pcm.mjs" "$out/$tag-edge.jsonl" &
ear=$!
sleep 3
( song a 40; sleep 45; song b 60; sleep 50; song c 60 ) &
songs=$!
node "$here/push-clicks.mjs" --clicks 12 --spacing 15000 --lead 4000 --start-delay 0 --drain 8000 \
  --log "$out/$tag-sent.jsonl" -- ffmpeg -hide_banner -loglevel error -f s16le -ar 48000 -ac 1 -i - \
  -c:a aac -b:a 128k -flush_packets 1 -f flv rtmp://127.0.0.1:11935/live/proof || true
wait "$songs" || true
sleep 12
pkill -f "ffmpeg.*127.0.0.1:18000/stream" || true
wait "$ear" 2>/dev/null || true
printf '%s edge %s\n' "$tag" "$(node "$here/analyze.mjs" "$out/$tag-sent.jsonl" "$out/$tag-edge.jsonl" | tail -1)"
