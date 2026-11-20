#!/usr/bin/env bash
# palazzo#47 step 1: today's path, click into Palazzo's RTMP live input (AAC in
# FLV, as a hardware or OBS encoder sends it) out of its public Icecast mount,
# decoded the moment a fresh listener connects (the connect burst included).
# Usage: run-today.sh <tag> [clicks] [spacing_ms]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="$1"; clicks="${2:-12}"; spacing="${3:-10000}"
out="$here/.run"
ffmpeg -hide_banner -loglevel error -fflags nobuffer -probesize 32768 -analyzeduration 0 \
  -i http://127.0.0.1:18000/stream -f s16le -ar 48000 -ac 1 - \
  | node "$here/ear-pcm.mjs" "$out/$tag-ear.jsonl" ${PLAYER:+--player} &
ear=$!
sleep 3
node "$here/push-clicks.mjs" --clicks "$clicks" --spacing "$spacing" --lead 4000 --start-delay 0 --drain 8000 \
  --log "$out/$tag-sent.jsonl" -- ffmpeg -hide_banner -loglevel error -f s16le -ar 48000 -ac 1 -i - \
  -c:a aac -b:a 128k -flush_packets 1 -f flv rtmp://127.0.0.1:11935/live/proof || true
sleep 10
pkill -f "ffmpeg.*127.0.0.1:18000/stream" || true
wait "$ear" 2>/dev/null || true
printf '%s %s\n' "$tag" "$(node "$here/analyze.mjs" "$out/$tag-sent.jsonl" "$out/$tag-ear.jsonl" | tail -1)"
