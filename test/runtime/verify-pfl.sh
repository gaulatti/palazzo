#!/usr/bin/env bash
# gaulatti/alcantara#835 on a real Liquidsoap and Icecast, no production credentials: pre-fade listen. With a
# channel muted on air, its tap still carries it and the public output does not; the taps change nothing on air,
# are not Icecast mounts, and are not reachable from outside the container.
# Usage: test/runtime/verify-pfl.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
c="palazzo-pfl-${RANDOM}-${RANDOM}"
cleanup() { docker rm --force "$c" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "FAIL: $1"; exit 1; }

docker run --rm --detach --name "$c" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 --env PALAZZO_INSTANCE_ID=palazzo-pfl --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true --env NODE_ENV=test \
  "$station_image" >/dev/null
api="http://$(docker port "$c" 3100/tcp)"
program="$api/v1/programs/program-ci"
state() { curl --fail --silent "$program"/playback/state; }
for attempt in $(seq 1 60); do
  if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then break; fi
  sleep 1
done
state | jq --exit-status '.capabilities | index("monitor.pfl") != null' >/dev/null || fail "monitor.pfl is not listed"

# The song at 440 Hz, the spot at 1500 Hz, the filler at 6 kHz.
tone() { docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=$2:sample_rate=44100:duration=$3" -ac 2 "/tmp/$1.wav"; }
tone song 440 40
tone spot 1500 8
tone filler 6000 2
docker exec --detach "$c" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.wav$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type","audio/wav");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
sleep 1
FILLER_SHA=$(docker exec "$c" sha256sum /tmp/filler.wav | cut -d ' ' -f 1)
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"p-prepare",mode:"ordered",assets:[{id:"p-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.wav"}]}' \
  | curl --fail --silent --header 'Idempotency-Key: p-prepare' --header 'Content-Type: application/json' \
    --request PUT --data-binary @- "$program"/fillers/p-v1 >/dev/null
curl --fail --silent --header 'Idempotency-Key: p-start' --header 'X-Command-Sequence: 1' --header 'X-Filler-Version: p-v1' \
  --request POST "$program"/automation/start >/dev/null
sleep 4

mixer() { curl --fail --silent --header 'Content-Type: application/json' --request PUT --data "$1" "$program"/mixer >/dev/null; }
record() { docker exec --detach "$c" sh -c "rm -f /tmp/$1.done; ffmpeg -hide_banner -nostats -loglevel error -y -t $3 -i '$2' -c:a pcm_s16le /tmp/$1.wav; touch /tmp/$1.done"; }
recorded() { for attempt in $(seq 1 90); do docker exec "$c" test -e "/tmp/$1.done" && return 0; sleep 1; done; fail "the recording $1 did not finish"; }
# Seconds of /tmp/$1.wav in the band around $2 Hz above a threshold well under the tones.
heard() {
  docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -i /tmp/$1.wav -af bandpass=f=$2:width_type=h:w=80 -ac 1 -ar 8000 -f s16le - | node -e 'const b=[];process.stdin.on(\"data\",d=>b.push(d));process.stdin.on(\"end\",()=>{const x=Buffer.concat(b);let s=0;for(let i=0;i+800<=x.length/2;i+=800){let m=0;for(let j=0;j<800;j++)m=Math.max(m,Math.abs(x.readInt16LE((i+j)*2)));if(m>800)s+=0.1}console.log(s.toFixed(1))})'"
}
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }
at_most() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'; }

# A listener that never reads must not hold the program: it stays connected through the whole check.
docker exec --detach "$c" node -e 'const s=require("node:net").connect(8010,"127.0.0.1",()=>{s.write("GET /pfl/song HTTP/1.0\r\n\r\n");s.pause()});setTimeout(()=>{},120000)'

# Both channels muted on air, then a song and a spot.
mixer '{"songMuted":true,"instantMuted":true}'
curl --fail --silent --header 'Idempotency-Key: p-song' --header 'Content-Type: application/json' --request POST \
  --data '{"song":{"programId":"program-ci","playbackId":"p-song","url":"http://127.0.0.1:3200/song.wav","title":"T","artist":"A","duration":40}}' \
  "$program"/playback/song | jq --exit-status '.ok == true' >/dev/null
sleep 3
record air "http://127.0.0.1:8000/stream" 20
record pflsong "http://127.0.0.1:8010/pfl/song" 12
record pflinstant "http://127.0.0.1:8010/pfl/instant" 12
sleep 3
curl --fail --silent --header 'Idempotency-Key: p-spot' --header 'Content-Type: application/json' --request POST \
  --data '{"programId":"program-ci","playbackId":"p-spot","url":"http://127.0.0.1:3200/spot.wav"}' \
  "$program"/playback/instant >/dev/null
recorded pflsong; recorded pflinstant; recorded air

song_tap=$(heard pflsong 440); spot_tap=$(heard pflinstant 1500)
echo "pfl song    hears the muted song for ${song_tap} s of 12"
echo "pfl instant hears the muted spot for ${spot_tap} s (8 s spot)"
at_least "$song_tap" 9 || fail "the song tap carried ${song_tap} s of the muted song"
at_least "$spot_tap" 5 || fail "the instant tap carried ${spot_tap} s of the muted spot"
# Each tap carries its own channel only.
at_most "$(heard pflsong 1500)" 0.3 || fail "the spot is in the song tap"
at_most "$(heard pflinstant 440)" 0.3 || fail "the song is in the instant tap"
# Air (4 to 7 s behind) stays muted on both while they are heard: after the mute took hold.
air_song=$(docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -y -ss 8 -i /tmp/air.wav /tmp/airtail.wav" && heard airtail 440)
air_spot=$(heard airtail 1500)
echo "air         carries song ${air_song} s, spot ${air_spot} s (both muted)"
at_most "$air_song" 0.3 || fail "the muted song reached the public output"
at_most "$air_spot" 0.3 || fail "the muted spot reached the public output"
# Not Icecast mounts, and not reachable from outside the container.
status=$(docker exec "$c" node -e 'fetch("http://127.0.0.1:8000/pfl/song").then(r=>console.log(r.status),()=>console.log("refused"))')
[ "$status" != 200 ] || fail "Icecast serves a pre-fade tap"
address=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$c")
outside=$(docker exec "$c" node -e 'const s=require("node:net").connect(8010,process.argv[1]);s.on("connect",()=>{console.log("open");process.exit(0)});s.on("error",()=>{console.log("refused");process.exit(0)})' "$address")
[ "$outside" = refused ] || fail "the tap port answers on the container's network address"
# The API relays a tap and refuses anything else.
# The stream never ends, so curl stops at its time limit: the headers are what is read.
headers=$(curl --silent --max-time 3 --dump-header - --output /dev/null "$program"/output/pfl/song || true)
grep -qi '^content-type: audio/' <<<"$headers" || fail "the API did not relay the song tap: $headers"
[ "$(curl --silent --output /dev/null --write-out '%{http_code}' "$program"/output/pfl/stream)" = 404 ] || fail "an unknown channel was not refused"
mixer '{"songMuted":false,"instantMuted":false}'
state | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null || fail "the public output dropped"
# The tap clocks once raced the program's at start-up, in about one start of four: several starts in a row.
for start in 1 2 3 4 5 6; do
  docker restart --time 2 "$c" >/dev/null
  api="http://$(docker port "$c" 3100/tcp)"; program="$api/v1/programs/program-ci"
  up=false
  for attempt in $(seq 1 45); do
    if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then up=true; break; fi
    sleep 1
  done
  [ "$up" = true ] || fail "start $start never connected the public output"
done
echo "pre-fade listen check passed"
