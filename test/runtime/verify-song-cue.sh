#!/usr/bin/env bash
# gaulatti/palazzo#62 on a real Liquidsoap and Icecast, no production credentials: a song's analysed cue points
# still apply. A 16 s, 440 Hz song sent with a segue (cue-in 2 s, cue-out 6 s) plays about 4 s; the same song
# sent without a segue plays its whole 16 s. The audible span is measured in the 440 Hz band of the Icecast
# output. A cue that does not apply makes the cued song play whole, and this script exits non-zero.
# Companion to verify-item-cue.sh (instants and intros, #60).
# Usage: test/runtime/verify-song-cue.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
c="palazzo-song-cue-${RANDOM}-${RANDOM}"
cleanup() { docker rm --force "$c" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$c" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 --env PALAZZO_INSTANCE_ID=palazzo-song-cue --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true --env NODE_ENV=test \
  "$station_image" >/dev/null
api="http://$(docker port "$c" 3100/tcp)"
state() { curl --fail --silent "$api"/v1/programs/program-ci/playback/state; }
for attempt in $(seq 1 60); do
  if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then break; fi
  sleep 1
done
state | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null
docker cp "$(dirname "$0")/live-recorder.cjs" "$c":/tmp/live-recorder.cjs >/dev/null

# The song: 16 s at 440 Hz. The filler (6 kHz, outside the measured band) keeps the station running between items.
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 16 /tmp/song.wav
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=6000:sample_rate=44100" -t 2 /tmp/filler.wav
docker exec --detach "$c" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.(wav|flac)$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type",n.endsWith(".flac")?"audio/flac":"audio/wav");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
sleep 1
FILLER_SHA=$(docker exec "$c" sha256sum /tmp/filler.wav | cut -d ' ' -f 1)
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"g-prepare",mode:"ordered",assets:[{id:"g-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.wav"}]}' \
  | curl --fail --silent --header 'Idempotency-Key: g-prepare' --header 'Content-Type: application/json' \
    --request PUT --data-binary @- "$api"/v1/programs/program-ci/fillers/g-v1 >/dev/null
curl --fail --silent --header 'Idempotency-Key: g-start' --header 'X-Command-Sequence: 1' --header 'X-Filler-Version: g-v1' \
  --request POST "$api"/v1/programs/program-ci/automation/start >/dev/null
sleep 4

n=0
id() { n=$((n + 1)); echo "s$n-${RANDOM}"; }
# Records from the live point, past the Icecast burst (live-recorder.cjs, #72).
record() { docker exec --detach "$c" sh -c "rm -f /tmp/$2.done; node /tmp/live-recorder.cjs $1 /tmp/$2.wav 2>/dev/null; touch /tmp/$2.done"; }
fail() { echo "FAIL: $1"; exit 1; }
recorded() { for attempt in $(seq 1 90); do docker exec "$c" test -e "/tmp/$1.done" && return 0; sleep 1; done; fail "the recording $1 did not finish"; }
# The audible span in the 440 Hz band of /tmp/$1.wav: first to last 8 kHz mono sample above a threshold well
# under the tone and over the leakage of the filler before it. Measured as a span, as verify-item-cue.sh does.
audible() {
  docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -i /tmp/$1.wav -af bandpass=f=440:width_type=h:w=100 -ac 1 -ar 8000 -f s16le - | node -e 'const b=[];process.stdin.on(\"data\",d=>b.push(d));process.stdin.on(\"end\",()=>{const x=Buffer.concat(b);let f=-1,l=-1;for(let i=0;i+1<x.length;i+=2)if(Math.abs(x.readInt16LE(i))>1000){if(f<0)f=i/2;l=i/2}console.log(f<0?\"0.00\":((l-f)/8000).toFixed(2))})'"
}
idle() {
  for attempt in $(seq 1 120); do
    if state | jq --exit-status '.status == "idle"' >/dev/null; then sleep 2; return 0; fi
    sleep 0.5
  done
  fail "the station did not go idle"
}
# A song request; $1 is the recording name, $2 the segue JSON (empty for no cue points).
song() {
  local key segue_field=""
  key="$(id)"
  if [ -n "${2:-}" ]; then segue_field=",\"segue\":$2"; fi
  curl --fail --silent --header "Idempotency-Key: $key" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$key\",\"url\":\"http://127.0.0.1:3200/song.wav\",\"title\":\"T\",\"artist\":\"A\",\"duration\":16$segue_field}}" \
    "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
at_most() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'; }

# The recording starts at the live point and runs well past the song, so the song is read whole.
# Cued: cue-in 2 s and cue-out 6 s, both within CUE_EDGE_BOUND_SECONDS (10 s), so both are annotated.
idle; record 28 "cued"; sleep 2
song cued '{"cueInSeconds":2,"cueOutSeconds":6,"fadeInSeconds":0,"fadeOutSeconds":0,"overlapSeconds":0}'
sleep 20; recorded cued
seconds=$(audible cued)
echo "song     cued    plays ${seconds} s (cue-in 2 s, cue-out 6 s: expect about 4 s)"
at_least "$seconds" 3.5 || fail "the cued song played ${seconds} s, less than its 4 s span"
at_most "$seconds" 4.5 || fail "the cued song played ${seconds} s: its cue points did not apply (it played nearly whole)"

# Uncued: the same song with no segue plays its whole length.
idle; record 28 "whole"; sleep 2
song whole
sleep 20; recorded whole
seconds=$(audible whole)
echo "song     whole   plays ${seconds} s (no cue points: expect 16 s)"
at_least "$seconds" 14.5 || fail "the uncued song played ${seconds} s, not its whole 16 s"

echo "song cue check passed"
