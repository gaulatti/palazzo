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
docker exec --detach "$station_container" node -e \
  'const fs=require("node:fs");const media="/tmp/filler.wav";require("node:http").createServer((_,response)=>{response.setHeader("Content-Length",fs.statSync(media).size);response.setHeader("Accept-Ranges","bytes");fs.createReadStream(media).pipe(response)}).listen(3200,"127.0.0.1")'
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
  | jq --exit-status '.status == "idle"'
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
curl --fail --silent \
  --header 'Idempotency-Key: ci-stop' \
  --header 'X-Command-Sequence: 2' \
  --request POST \
  "$station_api"/v1/programs/program-ci/automation/stop \
  | jq --exit-status '.actualState == "stopped" and .dependencies.icecast == true and .filler.activeVersion == null'
docker exec "$station_container" liquidsoap --version | grep 'Liquidsoap 2.4.5'
