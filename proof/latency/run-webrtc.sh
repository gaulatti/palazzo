#!/usr/bin/env bash
# palazzo#47 step 2: the WebRTC listening path. Clicks go through Liquidsoap
# 2.4.5 (floor.liq: PCM in, PCM out), are published to a local LiveKit server
# (livekit/livekit-server:v1.13.4, container lk47) as an Opus microphone track
# and come out of a subscriber's libwebrtc receive path. With `direct`, the
# clicks skip Liquidsoap (the WebRTC transport alone).
# Usage: run-webrtc.sh <tag> [direct]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="$1"; mode="${2:-liquidsoap}"
out="$here/.run"
deps="${PROOF_DEPS:-$HOME/source/gaulatti/palazzo-47-proof-deps}"
url=ws://127.0.0.1:7880
node "$here/lk-subscribe.mjs" "$url" "$deps" "$out/$tag-ear.jsonl" 2>"$out/$tag-sub.log" &
listener=$!
sleep 3
if [ "$mode" = direct ]; then
  feed="node $here/lk-publish.mjs $url $deps ${QUEUE_MS:-20}"
else
  feed="docker run -i --rm --init --network none ${LIQ_ENV:-} -v $here/floor.liq:/floor.liq:ro -v $out:/logs \
    --entrypoint liquidsoap savonet/liquidsoap:v2.4.5 /floor.liq 2>/dev/null | node $here/lk-publish.mjs $url $deps ${QUEUE_MS:-20}"
fi
node "$here/push-clicks.mjs" --clicks 14 --spacing 2000 --lead 6000 --start-delay 6000 \
  --log "$out/$tag-sent.jsonl" -- sh -c "$feed" 2>"$out/$tag-pub.log" || true
docker ps -q --filter ancestor=savonet/liquidsoap:v2.4.5 | xargs -r docker rm -f >/dev/null
sleep 2
kill "$listener" 2>/dev/null || true
wait "$listener" 2>/dev/null || true
printf '%s %s\n' "$tag" "$(node "$here/analyze.mjs" "$out/$tag-sent.jsonl" "$out/$tag-ear.jsonl" | tail -1)"
