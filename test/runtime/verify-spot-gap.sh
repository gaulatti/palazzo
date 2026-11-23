#!/usr/bin/env bash
# gaulatti/palazzo#55 on a real Liquidsoap and Icecast, no production credentials: the gap between an
# announced spot's last audio and the announced song's first audio, measured on the Icecast output with MP3
# files (the codecs production uses) rather than tones in WAV. Song A (1 kHz, HOLD_SECONDS, default 14 s) is on air, song B
# (440 Hz, 8 s) is announced with a 3 s spot (2 kHz). Each tone is found in its own band, so the spot's last
# frame and the song's first frame are measured apart; the gap is the time between them.
# Usage: test/runtime/verify-spot-gap.sh [image] [max gap seconds]   (default palazzo:ci, 0.1)
set -euo pipefail
station_image="${1:-palazzo:ci}"
max_gap="${2:-0.1}"
hold="${HOLD_SECONDS:-14}"  # song A length: the announced song and spot wait this long behind the closed gate
c="palazzo-spotgap-${RANDOM}-${RANDOM}"
cleanup() { docker rm --force "$c" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$c" --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 --env PALAZZO_INSTANCE_ID=palazzo-spotgap --env PROGRAM_ID=program-ci \
  --env ICECAST_PORT=8000 --env ICECAST_SOURCE_PASSWORD=ci-password \
  --env PALAZZO_MEDIA_ALLOW_PRIVATE=true --env NODE_ENV=test "$station_image" >/dev/null
api="http://$(docker port "$c" 3100/tcp)"
state() { curl --fail --silent "$api"/v1/programs/program-ci/playback/state; }
for attempt in $(seq 1 60); do
  if state 2>/dev/null | jq --exit-status '.liquidsoap.connected == true and .icecast.connected == true' >/dev/null; then break; fi
  sleep 1
done
state | jq --exit-status '.capabilities | index("next.bumper") != null' >/dev/null

mp3() { # name frequency seconds
  docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=$2:sample_rate=44100" -t "$3" -c:a libmp3lame -b:a 128k "/tmp/$1.mp3"
}
mp3 songa 1000 "$hold"; mp3 songb 440 8; mp3 spot 2000 3
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=300:sample_rate=44100" -t 2 /tmp/filler.wav
docker exec --detach "$c" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.(wav|mp3)$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type",n.endsWith(".mp3")?"audio/mpeg":"audio/wav");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
sleep 1
FILLER_SHA=$(docker exec "$c" sha256sum /tmp/filler.wav | cut -d ' ' -f 1)
jq --null-input --arg checksum "$FILLER_SHA" \
  '{commandId:"s-prepare",mode:"ordered",assets:[{id:"s-filler",sha256:$checksum,downloadUrl:"http://127.0.0.1:3200/filler.wav"}]}' \
  | curl --fail --silent --header 'Idempotency-Key: s-prepare' --header 'Content-Type: application/json' \
    --request PUT --data-binary @- "$api"/v1/programs/program-ci/fillers/s-v1 >/dev/null
curl --fail --silent --header 'Idempotency-Key: s-start' --header 'X-Command-Sequence: 1' --header 'X-Filler-Version: s-v1' \
  --request POST "$api"/v1/programs/program-ci/automation/start >/dev/null
sleep 4

await() {
  for attempt in $(seq 1 $(( (hold + 30) * 4 ))); do
    if state | jq --exit-status "$2" >/dev/null; then return 0; fi
    sleep 0.25
  done
  echo "spot gap check failed: $1"; exit 1
}
# Starts recording first: Icecast replays its burst to a new listener, which the analysis ignores (it looks
# only for the spot band and the song band).
docker exec --detach "$c" sh -c "rm -f /tmp/gap.done; ffmpeg -hide_banner -nostats -y -t $((hold + 18)) -i http://127.0.0.1:8000/stream -c:a pcm_s16le /tmp/gap.wav 2>/dev/null; touch /tmp/gap.done"
sleep 3
curl --fail --silent --header 'Idempotency-Key: gap-a' --header 'Content-Type: application/json' --request POST \
  --data '{"song":{"programId":"program-ci","playbackId":"gap-a","url":"http://127.0.0.1:3200/songa.mp3","title":"A","artist":"A","duration":'"$hold"'}}' \
  "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
await 'song A on air' '.track.playbackRequestId == "gap-a"'
curl --fail --silent --header 'Idempotency-Key: next-gap-b' --header 'Content-Type: application/json' --request PUT \
  --data '{"song":{"programId":"program-ci","playbackId":"gap-b","url":"http://127.0.0.1:3200/songb.mp3","title":"B","artist":"B","duration":8},"bumper":{"playbackId":"gap-spot","url":"http://127.0.0.1:3200/spot.mp3"}}' \
  "$api"/v1/programs/program-ci/playback/next | jq --exit-status '.state == "queued"' >/dev/null
await 'song B on air after the spot' '.track.playbackRequestId == "gap-b"'
for attempt in $(seq 1 90); do docker exec "$c" test -e /tmp/gap.done && break; sleep 1; done

# Times (s) at which a band holds energy: read from a raw 22.05 kHz mono stream on stdin.
docker exec -i "$c" sh -c 'cat > /tmp/band.js' <<'JS'
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const x = Buffer.concat(chunks);
  // Runs of energy: [start, end] in seconds, runs closer than 20 ms merged (a tone crosses zero).
  const runs = [];
  for (let i = 0; i + 1 < x.length; i += 2) {
    if (Math.abs(x.readInt16LE(i)) <= 1000) continue;
    const t = i / 2 / 22050;
    const last = runs[runs.length - 1];
    if (last && t - last[1] < 0.02) last[1] = t;
    else runs.push([t, t]);
  }
  console.log(JSON.stringify(runs));
});
JS
band() { # frequency
  docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -i /tmp/gap.wav -af bandpass=f=$1:width_type=h:w=200 -ac 1 -ar 22050 -f s16le - | node /tmp/band.js"
}
spot_times=$(band 2000)
song_times=$(band 440)
read -r spot_first spot_last song_first < <(node -e '
const s = JSON.parse(process.argv[1]), b = JSON.parse(process.argv[2]);
// The spot is the 2 kHz run (the longest); the song is the first 440 Hz run starting after the spot began.
const spot = s.reduce((best, r) => (r[1] - r[0] > best[1] - best[0] ? r : best), s[0]);
const song = b.find((r) => r[0] > spot[0]);
console.log(spot[0].toFixed(3), spot[1].toFixed(3), song === undefined ? "NaN" : song[0].toFixed(3));
' "$spot_times" "$song_times")
gap=$(awk -v a="$spot_last" -v b="$song_first" 'BEGIN { printf "%.3f", b - a }')
echo "spot on the output: ${spot_first} s to ${spot_last} s ($(awk -v a="$spot_first" -v b="$spot_last" 'BEGIN { printf "%.2f", b - a }') s of its 3 s); song B first audio at ${song_first} s"
echo "gap from the spot's last audio to the song's first audio: ${gap} s (limit ${max_gap} s)"
awk -v g="$gap" -v m="$max_gap" 'BEGIN { exit !(g == g && g <= m) }' || { echo "FAIL: the gap is over ${max_gap} s"; exit 1; }
echo "spot gap check passed"
