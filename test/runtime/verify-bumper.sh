#!/usr/bin/env bash
# gaulatti/palazzo#50 on a real Liquidsoap and Icecast, no production credentials. A song is on air, the
# next song is announced with a spot: the spot must follow the song and the song the spot, both
# preloaded, with no silence on the Icecast output; a spot that cannot be fetched must cost no air time.
# Usage: test/runtime/verify-bumper.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
station_container="palazzo-bumper-${RANDOM}-${RANDOM}"
station_work=$(mktemp -d)
cleanup() {
  docker rm --force "$station_container" >/dev/null 2>&1 || true
  rm -rf "$station_work"
}
trap cleanup EXIT

docker run --rm --detach --name "$station_container" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 \
  --env PALAZZO_INSTANCE_ID=palazzo-bumper \
  --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 \
  --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true \
  --env NODE_ENV=test \
  "$station_image" >/dev/null
api="http://$(docker port "$station_container" 3100/tcp)"
state() { curl --fail --silent "$api"/v1/programs/program-ci/playback/state; }
for attempt in $(seq 1 60); do
  if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then break; fi
  sleep 1
done
state | jq --exit-status '.capabilities | index("next.bumper") != null' >/dev/null

# Tones: song A 1 kHz 12 s, song B 440 Hz 6 s, the spot 2 kHz 5 s, the filler 300 Hz.
for spec in 'a 1000 12' 'b 440 6' 'c 660 6' 'd 550 6' 'e 770 6' 'spot 2000 5' 'longclip 1500 14' 'filler 300 2'; do
  set -- $spec
  docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=$2:sample_rate=44100" -t "$3" "/tmp/$1.wav"
done
docker exec --detach "$station_container" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.wav$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type","audio/wav");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
sleep 1
FILLER_SHA=$(docker exec "$station_container" sha256sum /tmp/filler.wav | cut -d ' ' -f 1)
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"b-prepare",mode:"ordered",assets:[{id:"b-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.wav"}]}' \
  | curl --fail --silent --header 'Idempotency-Key: b-prepare' --header 'Content-Type: application/json' \
    --request PUT --data-binary @- "$api"/v1/programs/program-ci/fillers/b-v1 >/dev/null
curl --fail --silent --header 'Idempotency-Key: b-start' --header 'X-Command-Sequence: 1' --header 'X-Filler-Version: b-v1' \
  --request POST "$api"/v1/programs/program-ci/automation/start >/dev/null

await() {
  local what="$1" filter="$2"
  for attempt in $(seq 1 80); do
    if state | jq --exit-status "$filter" >/dev/null; then return 0; fi
    sleep 0.25
  done
  echo "bumper check failed: $what"; state | jq '{status, track: .track.playbackRequestId}'; exit 1
}
song() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.wav\",\"title\":\"T\",\"artist\":\"A\",\"duration\":$3}}" \
    "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
announce() {
  curl --fail --silent --header "Idempotency-Key: next-$1" --header 'Content-Type: application/json' --request PUT \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.wav\",\"title\":\"T\",\"artist\":\"A\",\"duration\":6},\"bumper\":{\"playbackId\":\"$3\",\"url\":\"http://127.0.0.1:3200/$4.wav\"}}" \
    "$api"/v1/programs/program-ci/playback/next | jq --exit-status '.state == "queued"' >/dev/null
}
# Records the Icecast output and the event stream for $1 seconds, in the background.
record() {
  docker exec --detach "$station_container" sh -c \
    "ffmpeg -hide_banner -nostats -t $1 -i http://127.0.0.1:8000/stream -af silencedetect=noise=-50dB:d=0.3 -f null - 2> /tmp/$2.silence"
  ( curl --silent --no-buffer --max-time "$1" "$api"/v1/programs/program-ci/playback/events > "$station_work/$2.sse" || true ) &
}

# 1. A song on air, the next announced with a 5 s spot: A, spot, B with no silence.
# Icecast replays its burst (the silence before A) to a new listener, so recording starts first and
# silences in its first 4 s are that burst, not a change.
record 26 played
sleep 4
song song-a a 12
await 'song A on air' '.track.playbackRequestId == "song-a"'
announce song-b b spot-1 spot
await 'song B on air after the spot' '.track.playbackRequestId == "song-b"'
sleep 8
wait
docker exec "$station_container" cat /tmp/played.silence > "$station_work/played.silence"
echo "--- 1. announced spot: Icecast silences of 0.3 s or more (none expected while A, the spot and B play)"
grep -E 'silence_(start|end)' "$station_work/played.silence" || echo "(none)"
grep -oE '"type":"(track\.(started|ended)|instant\.(started|ended))"[^}]*"occurredAt":"[^"]*"' "$station_work/played.sse" \
  | sed -E 's/.*"type":"([^"]+)".*"(playbackRequestId|playbackId)":"([^"]+)".*"occurredAt":"([^"]+)"/\4 \1 \3/' | sort || true

# 2. A spot that cannot be fetched: B follows the end of A at once.
record 24 unresolved
sleep 4
song song-a2 a 12
await 'song A on air again' '.track.playbackRequestId == "song-a2"'
announce song-c c spot-missing missing
await 'song C on air without the spot' '.track.playbackRequestId == "song-c"'
sleep 6
wait
docker exec "$station_container" cat /tmp/unresolved.silence > "$station_work/unresolved.silence"
echo "--- 2. unresolvable spot: Icecast silences of 0.3 s or more"
grep -E 'silence_(start|end)' "$station_work/unresolved.silence" || echo "(none)"

instant() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.wav\"}" \
    "$api"/v1/programs/program-ci/playback/instant | jq --exit-status '.ok == true' >/dev/null
}
events_of() { grep -oE '"type":"[a-z.]+"[^}]*' "$station_work/$1.sse" | grep -E "$2" || true; }

# 3. A spot that is not on air within 1 s (it waits behind a 14 s clip fired by hand): the song starts at
# the end, and the spot is removed from the queue, so nothing of it plays after the song's gate opens.
song song-a3 a 12
await 'song A on air (3)' '.track.playbackRequestId == "song-a3"'
record 34 failed
sleep 6
instant hand-clip longclip
announce song-d d spot-late spot
await 'song D on air without waiting for the spot' '.track.playbackRequestId == "song-d"'
sleep 24
wait
echo "--- 3. spot not on air in time: spot-late must never start"
if events_of failed '"instant\.started"' | grep -q 'spot-late'; then echo "FAIL: the dropped spot came on air"; exit 1; fi
events_of failed '"instant\.(started|ended)"' | grep -oE '"playbackId":"[^"]+"' | sort | uniq -c

# 4. A song command while the spot is waiting: the announcement and its spot are flushed, no spot plays.
song song-a4 a 12
await 'song A on air (4)' '.track.playbackRequestId == "song-a4"'
record 14 flushed
announce song-e e spot-flushed spot
song song-x e 6
await 'the commanded song on air' '.track.playbackRequestId == "song-x"'
sleep 10
wait
echo "--- 4. song command while the spot waits: spot-flushed must never start"
if events_of flushed '"instant\.started"' | grep -q 'spot-flushed'; then echo "FAIL: the flushed spot came on air"; exit 1; fi
grep -oE '"type":"playout\.next_withdrawn".{0,200}' "$station_work/flushed.sse" | grep -oE '"reason":"[a-z_]+"' || echo "(no next_withdrawn event)"

echo "--- metrics"
curl --fail --silent "$api"/metrics | grep -E '^palazzo_next_bumper_total|^palazzo_song_change_gap_seconds_(count|sum)|^palazzo_song_change_last_gap_seconds'
