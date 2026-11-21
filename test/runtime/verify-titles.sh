#!/usr/bin/env bash
# gaulatti/palazzo#54 on a real Liquidsoap and Icecast, no production credentials. A spot never shows its
# file's own tags (nor the filler's) as the stream title: an announced spot and a spot by command show the
# station name, an instant over a song leaves the song's title, and the song after a spot shows its own.
# Usage: test/runtime/verify-titles.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
station_container="palazzo-titles-${RANDOM}-${RANDOM}"
station_work=$(mktemp -d)
cleanup() {
  docker rm --force "$station_container" >/dev/null 2>&1 || true
  rm -rf "$station_work"
}
trap cleanup EXIT

docker run --rm --detach --name "$station_container" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 \
  --env PALAZZO_INSTANCE_ID=palazzo-titles \
  --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 \
  --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true \
  --env STREAM_NAME="Station Name" \
  --env NODE_ENV=test \
  "$station_image" >/dev/null
api="http://$(docker port "$station_container" 3100/tcp)"
state() { curl --fail --silent "$api"/v1/programs/program-ci/playback/state; }
for attempt in $(seq 1 60); do
  if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then break; fi
  sleep 1
done

# MP3s carrying their own tags, as catalog files do: the spot is tagged like a song.
tagged() {
  docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=$2:sample_rate=44100:duration=$3" -ac 2 -c:a libmp3lame -b:a 128k \
    -metadata title="$4" -metadata artist="$5" "/tmp/$1.mp3"
}
tagged songa 220 14 "Song A file title" "File Artist"
tagged songb 330 16 "Song B file title" "File Artist"
tagged songc 262 12 "Song C file title" "File Artist"
tagged spot 880 6 "Spot file title" "Spot Artist"
tagged filler 300 20 "Filler Title" "Filler Artist"
docker exec --detach "$station_container" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.mp3$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type","audio/mpeg");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
sleep 1
FILLER_SHA=$(docker exec "$station_container" sha256sum /tmp/filler.mp3 | cut -d ' ' -f 1)
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"t-prepare",mode:"ordered",assets:[{id:"t-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.mp3"}]}' \
  | curl --fail --silent --header 'Idempotency-Key: t-prepare' --header 'Content-Type: application/json' \
    --request PUT --data-binary @- "$api"/v1/programs/program-ci/fillers/t-v1 >/dev/null
curl --fail --silent --header 'Idempotency-Key: t-start' --header 'X-Command-Sequence: 1' --header 'X-Filler-Version: t-v1' \
  --request POST "$api"/v1/programs/program-ci/automation/start >/dev/null

# Each StreamTitle change on the Icecast output, with the moment it was read.
docker exec --detach "$station_container" node -e '
  const http = require("node:http"), fs = require("node:fs"), t0 = Date.now();
  http.get("http://127.0.0.1:8000/stream", { headers: { "Icy-MetaData": "1" } }, (res) => {
    const metaint = Number(res.headers["icy-metaint"]); let buf = Buffer.alloc(0), audio = metaint, meta = -1;
    res.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (meta < 0) { if (buf.length < audio) { audio -= buf.length; buf = Buffer.alloc(0); return; } buf = buf.subarray(audio); audio = metaint; meta = 0; }
        if (meta === 0) { if (!buf.length) return; meta = buf[0] * 16; buf = buf.subarray(1); if (!meta) { meta = -1; continue; } }
        if (buf.length < meta) return;
        const text = buf.subarray(0, meta).toString("utf8").replace(/\0+$/, ""); buf = buf.subarray(meta); meta = -1;
        fs.appendFileSync("/tmp/titles.log", ((Date.now() - t0) / 1000).toFixed(2) + " " + text + "\n");
      }
    });
  });'
mark() { docker exec "$station_container" sh -c "echo \"MARK $1\" >> /tmp/titles.log"; }
await() {
  for attempt in $(seq 1 300); do
    if state | jq --exit-status "$2" >/dev/null; then return 0; fi
    sleep 0.1
  done
  echo "titles check failed: $1"; exit 1
}
song() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.mp3\",\"title\":\"$3\",\"artist\":\"$4\",\"duration\":$5}}" \
    "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
instant() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/spot.mp3\"}" \
    "$api"/v1/programs/program-ci/playback/instant >/dev/null
}

# The filler takes the air first (nothing else for its hold-off), so its title is on the stream.
sleep 20
mark "song A"; song a songa "Song A" "Artist A" 14
await "song A on air" '.track.playbackRequestId == "a"'
# 1. An announced spot after A: the station name, then B's own title.
curl --fail --silent --header 'Idempotency-Key: next-b' --header 'Content-Type: application/json' --request PUT \
  --data '{"song":{"programId":"program-ci","playbackId":"b","url":"http://127.0.0.1:3200/songb.mp3","title":"Song B","artist":"Artist B","duration":16},"bumper":{"playbackId":"spot-1","url":"http://127.0.0.1:3200/spot.mp3"}}' \
  "$api"/v1/programs/program-ci/playback/next | jq --exit-status '.state == "queued"' >/dev/null
await "song B on air after the spot" '.track.playbackRequestId == "b"'
# 2. An instant over B: B's title stays.
sleep 3; mark "instant over B"; instant over-b
await "song B ended" '.track == null'
# 3. A spot by command, as an engine without the announcement plays it: the station name, then C's own.
mark "spot by command"; instant spot-cmd
sleep 8; mark "song C"; song c songc "Song C" "Artist C" 12
await "song C on air" '.track.playbackRequestId == "c"'
sleep 3
docker exec "$station_container" cat /tmp/titles.log > "$station_work/titles.log"
cat "$station_work/titles.log"

# The titles between each mark, in order.
between() { awk -v from="MARK $1" -v to="MARK $2" '$0 == from { on = 1; next } $0 == to { on = 0 } on && /StreamTitle/' "$station_work/titles.log"; }
expect() {
  if ! grep -q "StreamTitle='$2';" <<<"$1"; then echo "titles check failed: expected '$2' ($3)"; exit 1; fi
}
reject() {
  if grep -qE "$2" <<<"$1"; then echo "titles check failed: unexpected title matching '$2' ($3)"; exit 1; fi
}
first=$(between "song A" "instant over B")
expect "$first" "Artist A - Song A" "song A"
expect "$first" "Station Name" "announced spot"
expect "$first" "Artist B - Song B" "song B after the spot"
reject "$first" "Spot file title|Filler Title" "announced spot"
over=$(between "instant over B" "spot by command")
reject "$over" "StreamTitle" "an instant over a song never retitles the stream"
cmd=$(between "spot by command" "song C")
expect "$cmd" "Station Name" "spot by command"
reject "$cmd" "Spot file title|Filler Title" "spot by command"
after=$(awk '/MARK song C/ { on = 1; next } on && /StreamTitle/' "$station_work/titles.log")
expect "$after" "Artist C - Song C" "song C after the spot"
echo "titles check passed"
