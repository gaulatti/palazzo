#!/usr/bin/env bash
# Disposable real Liquidsoap/Icecast verification; no production credentials.
set -euo pipefail
station_image="${1:-palazzo:ci}"
station_container="palazzo-ci-${RANDOM}-${RANDOM}"
station_work=$(mktemp -d)
cleanup() {
  docker rm --force "$station_container" >/dev/null 2>&1 || true
  rm -rf "$station_work"
}
trap cleanup EXIT

docker run --rm --detach --name "$station_container" \
  --publish 127.0.0.1::3100 \
  --log-driver=local \
  --log-opt max-size=10m \
  --log-opt max-file=3 \
  --env PALAZZO_PORT=3100 \
  --env PALAZZO_INSTANCE_ID=palazzo-ci \
  --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 \
  --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true \
  --env NODE_ENV=test \
  "$station_image"
station_api="http://$(docker port "$station_container" 3100/tcp)"
docker inspect "$station_container" \
  | jq --exit-status \
    '.[0].HostConfig.LogConfig.Type == "local" and .[0].HostConfig.LogConfig.Config == {"max-file":"3","max-size":"10m"}'
for attempt in $(seq 1 30); do
  if curl --fail --silent "$station_api"/v1/programs/program-ci/playback/state > "${station_work}/state.json" \
    && jq --exit-status \
      '.schemaVersion == 1 and .liquidsoap.running == true and .liquidsoap.connected == true and .icecast.connected == true' \
      "${station_work}/state.json" > /dev/null; then
    break
  fi
  sleep 1
done
jq --exit-status \
  '.schemaVersion == 1 and .liquidsoap.running == true and .liquidsoap.connected == true and .icecast.connected == true' \
  "${station_work}/state.json"
curl --fail --silent --request OPTIONS \
  --dump-header "${station_work}/cors-headers.txt" \
  --header 'Origin: http://localhost:5173' \
  --header 'Access-Control-Request-Method: POST' \
  --header 'Access-Control-Request-Headers: Idempotency-Key,X-Command-Sequence' \
  "$station_api"/v1/programs/program-ci/automation/start >/dev/null
grep --ignore-case '^access-control-allow-headers:.*Idempotency-Key' "${station_work}/cors-headers.txt"
grep --ignore-case '^access-control-allow-headers:.*X-Command-Sequence' "${station_work}/cors-headers.txt"
docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i sine=frequency=440:sample_rate=44100 -t 2 /tmp/filler.wav
# A distinct 4 s song for the handover checks (gaulatti/alcantara#230).
docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i sine=frequency=1000:sample_rate=44100 -t 4 /tmp/song.wav
docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i sine=frequency=2000:sample_rate=44100 -t 2 /tmp/instant.wav
# Tones for the spot-then-command check below: each song its own frequency.
for spec in 'spot-a 1000 6' 'spot-b 440 20' 'spot-spot 2000 5' 'spot-c 660 14' 'spot-d 550 8' 'hold-a 440 30' 'hold-b 660 30' 'hold-c 880 30'; do
  set -- $spec
  docker exec "$station_container" ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "sine=frequency=$2:sample_rate=44100" -t "$3" "/tmp/$1.wav"
done
docker exec --detach "$station_container" node -e \
  'const fs=require("node:fs");require("node:http").createServer(async (request,response)=>{let path=new URL(request.url,"http://x").pathname;if(path==="/missing.wav"){response.statusCode=404;response.end();return}const slow=/^\/slow-(\d+)(\/.+)$/.exec(path);if(slow){globalThis.fetched=globalThis.fetched||{};const again=globalThis.fetched[path];globalThis.fetched[path]=true;if(again)await new Promise(resolve=>setTimeout(resolve,Number(slow[1])));path=slow[2]}const own=/^\/(spot|hold)-[a-z]+\.wav$/.test(path)&&fs.existsSync("/tmp"+path);const name=own?path.slice(1):path==="/song.wav"?"song.wav":path==="/instant.wav"?"instant.wav":"filler.wav";const media="/tmp/"+name;response.setHeader("Content-Type","audio/wav");response.setHeader("Content-Length",fs.statSync(media).size);response.setHeader("Accept-Ranges","bytes");fs.createReadStream(media).pipe(response)}).listen(3200,"127.0.0.1")'
for attempt in $(seq 1 20); do
  if docker exec "$station_container" node -e \
    'fetch("http://127.0.0.1:3200/filler.wav").then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))'; then
    break
  fi
  sleep 0.1
done
docker exec "$station_container" node -e \
  'fetch("http://127.0.0.1:3200/filler.wav").then(response=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))'
FILLER_SHA=$(docker exec "$station_container" sha256sum /tmp/filler.wav | cut -d ' ' -f 1)
PREFLIGHT_AT=$(node -e 'process.stdout.write(new Date(Date.now()+60000).toISOString())')
jq --null-input --arg scheduledAt "$PREFLIGHT_AT" \
  '{assets:[{programId:"program-ci",playbackId:"ci-upcoming",kind:"song",url:"http://127.0.0.1:3200/filler.wav?signed=redacted",scheduledAt:$scheduledAt}]}' \
  > "${station_work}/preflight.json"
curl --fail --silent \
  --header 'Content-Type: application/json' \
  --request PUT \
  --data-binary "@${station_work}/preflight.json" \
  "$station_api"/v1/programs/program-ci/playback/preflight \
  | jq --exit-status \
    '.assets[0].readiness == "ready" and .assets[0].media.durationSeconds > 0 and .assets[0].media.sampleRateHz == 44100 and (.assets[0] | has("url") | not)'
curl --fail --silent \
  "$station_api"/v1/programs/program-ci/playback/preflight \
  | jq --exit-status \
    '.assets[0].playbackId == "ci-upcoming" and (.assets[0] | has("url") | not)'
curl --fail --silent "$station_api"/v1/programs/program-ci/playback/state \
  | jq --exit-status '.status == "idle" and .live.onAir == false'
for removed in 'GET status' 'POST song' 'POST song/stop' 'POST instant' 'POST instant/stop' 'GET mixer' 'PUT mixer' 'GET playback/state' 'GET playback/events'; do
  set -- $removed
  removed_status=$(curl --silent --output /dev/null --write-out '%{http_code} %{redirect_url}' --request "$1" "$station_api/$2")
  test "$removed_status" = '404 ' || { echo "legacy route $1 /$2 returned $removed_status"; exit 1; }
done
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"ci-prepare",mode:"ordered",assets:[{id:"ci-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.wav?signed=redacted"}]}' \
  > "${station_work}/filler.json"
curl --fail --silent \
  --header 'Idempotency-Key: ci-prepare' \
  --header 'Content-Type: application/json' \
  --request PUT \
  --data-binary "@${station_work}/filler.json" \
  "$station_api"/v1/programs/program-ci/fillers/ci-v1 \
  | jq --exit-status '.ready == true and .assets[0].id == "ci-filler"'
curl --fail --silent \
  --dump-header "${station_work}/metrics-headers.txt" \
  "$station_api"/metrics \
  > "${station_work}/metrics.txt"
grep --ignore-case 'content-type: text/plain; version=0.0.4' \
  "${station_work}/metrics-headers.txt"
node test/verify-prometheus-exposition.js "${station_work}/metrics.txt"
if grep --extended-regexp 'program-ci' "${station_work}/metrics.txt"; then
  echo 'metrics exposed private identifiers'
   exit 1
 fi
curl --fail --silent \
  --header 'Idempotency-Key: ci-start' \
  --header 'X-Command-Sequence: 1' \
  --header 'X-Filler-Version: ci-v1' \
  --request POST \
  "$station_api"/v1/programs/program-ci/automation/start \
  | jq --exit-status '.actualState == "ready" and .readiness == true and .filler.activeVersion == "ci-v1"'
docker exec "$station_container" node -e 'fetch("http://127.0.0.1:8000/stream").then(async response=>{const reader=response.body.getReader();let total=0;while(total<16384){const chunk=await reader.read();if(chunk.done)break;total+=chunk.value.length}if(total<16384)throw new Error("Icecast filler stream starved")}).catch(error=>{console.error(error.message);process.exit(1)})'
# gaulatti/alcantara#230: the filler is heard, not only streamed. Bytes alone
# pass for silence: before the fix the song chain held the air with nothing in
# it and the output level stayed at zero.
await_state() {
  local what="$1" filter="$2"
  for attempt in $(seq 1 60); do
    if curl --fail --silent "$station_api"/v1/programs/program-ci/playback/state \
      | jq --exit-status "$filter" >/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  echo "station check failed: $what"
  curl --silent "$station_api"/v1/programs/program-ci/playback/state | jq '{status, track: .track.playbackRequestId, levels: .levels.output}'
  exit 1
}
await_state 'the filler is heard with no song queued' \
  '.status == "idle" and .levels.output.rms > 0.01'
curl --fail --silent \
  --header 'Idempotency-Key: ci-song' \
  --header 'Content-Type: application/json' \
  --request POST \
  --data '{"song":{"programId":"program-ci","playbackId":"ci-song","url":"http://127.0.0.1:3200/song.wav?signed=redacted","title":"CI","artist":"CI","duration":4}}' \
  "$station_api"/v1/programs/program-ci/playback/song \
  | jq --exit-status '.ok == true'
await_state 'a song arriving takes the air' \
  '.status == "playing" and .track.playbackRequestId == "ci-song" and .levels.output.rms > 0.01'
await_state 'the filler resumes when the queue empties' \
  '.status == "idle" and .levels.output.rms > 0.01'
# An instant then a song after an ordinary gap never puts the filler on air:
# it waits FILLER_HOLDOFF_SECONDS (15 s) with nothing on before it enters.
curl --fail --silent \
  --header 'Idempotency-Key: ci-instant' \
  --header 'Content-Type: application/json' \
  --request POST \
  --data '{"programId":"program-ci","playbackId":"ci-instant","url":"http://127.0.0.1:3200/instant.wav?signed=redacted"}' \
  "$station_api"/v1/programs/program-ci/playback/instant >/dev/null
sleep 4
for sample in $(seq 1 6); do
  curl --fail --silent "$station_api"/v1/programs/program-ci/playback/state \
    | jq --exit-status '.status == "idle" and .levels.output.rms < 0.01' >/dev/null \
    || { echo 'station check failed: the filler entered during an ordinary handoff'; exit 1; }
  sleep 0.5
done
curl --fail --silent \
  --header 'Idempotency-Key: ci-song-2' \
  --header 'Content-Type: application/json' \
  --request POST \
  --data '{"song":{"programId":"program-ci","playbackId":"ci-song-2","url":"http://127.0.0.1:3200/song.wav?signed=redacted","title":"CI","artist":"CI","duration":4}}' \
  "$station_api"/v1/programs/program-ci/playback/song \
  | jq --exit-status '.ok == true'
await_state 'the next song takes the air after the handoff' \
  '.status == "playing" and .track.playbackRequestId == "ci-song-2"'
# P0 2026-11-21: a song command while an announced spot is on air flushes the announcement, and the spot
# plays out. A song announced after the command must wait for the commanded song's end; it must never start
# when that leftover spot ends (it did, and the two decks were summed: two songs on air at once).
spot_song() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.wav\",\"title\":\"CI\",\"artist\":\"CI\",\"duration\":$3}}" \
    "$station_api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
spot_next() {
  local bumper=""
  [ -n "${4:-}" ] && bumper=",\"bumper\":{\"playbackId\":\"$4\",\"url\":\"http://127.0.0.1:3200/spot-spot.wav\"}"
  curl --fail --silent --header "Idempotency-Key: next-$1" --header 'Content-Type: application/json' --request PUT \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2.wav\",\"title\":\"CI\",\"artist\":\"CI\",\"duration\":$3}$bumper}" \
    "$station_api"/v1/programs/program-ci/playback/next | jq --exit-status '.state == "queued"' >/dev/null
}
spot_song ci-spot-a spot-a 6
await_state 'the song before the spot is on air' '.track.playbackRequestId == "ci-spot-a"'
spot_next ci-spot-b spot-b 20 ci-spot
await_state 'the spot follows the song' '.track.playbackRequestId != "ci-spot-a"'
sleep 1
spot_song ci-spot-c spot-c 14
await_state 'the song commanded during the spot is on air' '.track.playbackRequestId == "ci-spot-c"'
spot_next ci-spot-d spot-d 8
# The spot (5 s) ends within the next 5 s; the commanded song (14 s) is still on air well after.
sleep 8
await_state 'a song announced after the command does not start when the leftover spot ends' \
  '.track.playbackRequestId == "ci-spot-c"'
await_state 'it starts at the end of the commanded song' '.track.playbackRequestId == "ci-spot-d"'
# gaulatti/palazzo#66: a song command prepares its song while the song on air keeps playing, then cuts to it.
# The /slow-<ms>/ media route answers its first request at once (the API's preflight probe) and every later one
# after <ms>, the way Liquidsoap's own fetch from the media origin is slow at a cold command.
hold_song() {
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/$2\",\"title\":\"CI\",\"artist\":\"CI\",\"duration\":30}}" \
    "$station_api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
on_air() {
  curl --fail --silent "$station_api"/v1/programs/program-ci/playback/state | jq --raw-output '.track.playbackRequestId'
}
hold_song ci-hold-a hold-a.wav
await_state 'the song before the commands is on air' '.track.playbackRequestId == "ci-hold-a" and .levels.output.rms > 0.01'
sleep 2
# Ready path: a song that takes 1.5 s to fetch replaces the one on air with no digital silence in the Icecast output.
docker exec --detach "$station_container" sh -c \
  'ffmpeg -hide_banner -nostats -i http://127.0.0.1:8000/stream -t 9 -af silencedetect=noise=-60dB:d=0.25 -f null - 2>/tmp/handoff-silence.log'
sleep 1
hold_song ci-hold-b slow-1500/hold-b.wav
test "$(on_air)" = ci-hold-a || { echo 'station check failed: a command cut the song on air before its song was ready'; exit 1; }
await_state 'the prepared song takes the air' '.track.playbackRequestId == "ci-hold-b"'
sleep 7
if docker exec "$station_container" grep -q silence_start /tmp/handoff-silence.log; then
  echo 'station check failed: a song command left digital silence on air'
  docker exec "$station_container" grep silence_ /tmp/handoff-silence.log
  exit 1
fi
# Fallback: a song not ready within the 3 s limit cuts the song on air anyway, so a command always acts.
hold_song ci-hold-c slow-5000/hold-c.wav
sleep 2
test "$(on_air)" = ci-hold-b || { echo 'station check failed: the song on air ended before the prepare limit'; exit 1; }
sleep 2
test "$(on_air)" != ci-hold-b || { echo 'station check failed: a command waited past its prepare limit'; exit 1; }
await_state 'the slow song plays once it arrives' '.track.playbackRequestId == "ci-hold-c"'
# Failed load: a song that cannot be fetched cuts the song on air at once, as before.
hold_song ci-hold-missing missing.wav
sleep 1.5
test "$(on_air)" != ci-hold-c || { echo 'station check failed: a failed song command did not cut the song on air'; exit 1; }
# Back to back: a newer command wins over one still preparing, and the older song never plays.
hold_song ci-hold-a2 hold-a.wav
await_state 'a song is on air before the back-to-back commands' '.track.playbackRequestId == "ci-hold-a2"'
hold_song ci-hold-old slow-1500/hold-b.wav
hold_song ci-hold-new hold-c.wav
await_state 'the newer command is on air' '.track.playbackRequestId == "ci-hold-new"'
sleep 3
test "$(on_air)" = ci-hold-new || { echo 'station check failed: an older command still preparing replaced the newer one'; exit 1; }
curl --fail --silent \
  --header 'Idempotency-Key: ci-stop' \
  --header 'X-Command-Sequence: 2' \
  --request POST \
  "$station_api"/v1/programs/program-ci/automation/stop \
  | jq --exit-status '.actualState == "stopped" and .dependencies.icecast == true and .filler.activeVersion == null'
docker exec "$station_container" liquidsoap --version | grep 'Liquidsoap 2.4.5'
