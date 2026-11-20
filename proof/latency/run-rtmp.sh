#!/usr/bin/env bash
# palazzo#47: the voice over RTMP (AAC in FLV, as an encoder sends it today)
# into Liquidsoap's input.rtmp, out as PCM. `edge` timestamps it as it leaves
# Liquidsoap; `webrtc` publishes it to the local LiveKit server and times it
# out of a subscriber, the whole proposed listening path.
# Usage: run-rtmp.sh <tag> edge|webrtc   (LIQ_ENV for Liquidsoap settings)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="$1"; mode="$2"
out="$here/.run"
deps="${PROOF_DEPS:-$HOME/source/gaulatti/palazzo-47-proof-deps}"
url=ws://127.0.0.1:7880
if [ "$mode" = webrtc ]; then
  node "$here/lk-subscribe.mjs" "$url" "$deps" "$out/$tag-ear.jsonl" 2>"$out/$tag-sub.log" &
  listener=$!
  sink="node $here/lk-publish.mjs $url $deps ${QUEUE_MS:-20}"
else
  sink="node $here/ear-pcm.mjs $out/$tag-ear.jsonl"
fi
sh -c "docker run -i --rm --init --name rtmp47 -p 127.0.0.1:12935:1935 ${LIQ_ENV:-} -v $here/rtmp.liq:/rtmp.liq:ro -v $out:/logs \
  --entrypoint liquidsoap savonet/liquidsoap:v2.4.5 /rtmp.liq 2>/dev/null </dev/null | $sink" 2>"$out/$tag-pub.log" &
station=$!
sleep 6
node "$here/push-clicks.mjs" --clicks 14 --spacing 2000 --lead 6000 --start-delay 0 --drain 4000 \
  --log "$out/$tag-sent.jsonl" -- ffmpeg -hide_banner -loglevel error -f s16le -ar 48000 -ac 1 -i - \
  -c:a aac -b:a 128k -flush_packets 1 -f flv rtmp://127.0.0.1:12935/live/proof || true
sleep 3
docker rm -f rtmp47 >/dev/null 2>&1 || true
wait "$station" 2>/dev/null || true
if [ "$mode" = webrtc ]; then kill "$listener" 2>/dev/null || true; wait "$listener" 2>/dev/null || true; fi
printf '%s %s\n' "$tag" "$(node "$here/analyze.mjs" "$out/$tag-sent.jsonl" "$out/$tag-ear.jsonl" | tail -1)"
