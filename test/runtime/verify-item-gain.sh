#!/usr/bin/env bash
# gaulatti/palazzo#52 on a real Liquidsoap and Icecast, no production credentials: an instant's and an
# intro's own gain is applied (volume 0.5 is about 6 dB below volume 1, as it is without the validation),
# a missing or malformed annotation (nan, inf, text, empty, negative, above 1) leaves the level as it is
# (gain 1; without the validation nan silences the item and inf blows it out), and a song's level is not
# touched by an instant playing over it.
# The intros chain uses the same item_gain function; an intro can only be sent through a song command, whose
# API validates the gain, so its invalid values are covered by the instants runs above and by the script test.
# Levels are the peak of the Icecast output in the item's own frequency band, so a song and an item
# playing together are measured apart.
# Usage: test/runtime/verify-item-gain.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
c="palazzo-gain-${RANDOM}-${RANDOM}"
cleanup() { docker rm --force "$c" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$c" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 --env PALAZZO_INSTANCE_ID=palazzo-gain --env PROGRAM_ID=program-ci \
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

# Tones: an instant or intro at 2 kHz (3 s), a song at 440 Hz (16 s), both at the same source level.
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=2000:sample_rate=44100" -t 3 /tmp/item.wav
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 16 /tmp/song.wav
# The filler (6 kHz, well outside the 2 kHz and 440 Hz bands measured) keeps the station running between items.
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=6000:sample_rate=44100" -t 2 /tmp/filler.wav
docker exec --detach "$c" node -e \
  'const fs=require("node:fs");require("node:http").createServer((q,r)=>{const n=new URL(q.url,"http://x").pathname.slice(1);const f="/tmp/"+n;if(!/^[a-z]+\.wav$/.test(n)||!fs.existsSync(f)){r.statusCode=404;return r.end()}r.setHeader("Content-Type","audio/wav");r.setHeader("Content-Length",fs.statSync(f).size);fs.createReadStream(f).pipe(r)}).listen(3200,"127.0.0.1")'
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
id() { n=$((n + 1)); echo "g$n-${RANDOM}"; }
# Records the Icecast output for $1 seconds into /tmp/$2.wav (in the background), from the live point: the
# Icecast burst (about 16 s of past audio, which can hold the previous item) is dropped (live-recorder.cjs, #72).
record() {
  docker exec --detach "$c" sh -c "node /tmp/live-recorder.cjs $1 /tmp/$2.wav 2>/dev/null"
}
# Peak level (dB) of /tmp/$1.wav in the band around $2 Hz.
peak() {
  docker exec "$c" ffmpeg -hide_banner -nostats -i "/tmp/$1.wav" \
    -af "bandpass=f=$2:width_type=h:w=300,volumedetect" -f null - 2>&1 \
    | sed -n 's/.*max_volume: \(-\{0,1\}[0-9.]*\) dB.*/\1/p'
}
close() { awk -v a="$1" -v b="$2" -v t="$3" 'BEGIN { d = a - b; exit !(d <= t && d >= -t) }'; }
instant_api() { # $1 volume or empty
  local body
  if [ -n "$1" ]; then
    body="{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/item.wav\",\"volume\":$1}"
  else
    body="{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/item.wav\"}"
  fi
  curl --fail --silent --header "Idempotency-Key: $(id)" --header 'Content-Type: application/json' --request POST \
    --data "$body" "$api"/v1/programs/program-ci/playback/instant | jq --exit-status '.ok == true' >/dev/null
}
# Pushes a raw annotated request straight into Liquidsoap, as a malformed annotation would arrive.
instant_raw() { # $1 annotation value
  docker exec "$c" node -e \
    'const s=require("net").connect(14000,"127.0.0.1");s.write(process.argv[1]+"\nexit\n");s.on("data",()=>{});s.on("close",()=>process.exit(0))' \
    "instants.push annotate:liq_amplify=\"$1\":http://127.0.0.1:3200/item.wav"
}
song_api() { # $1 song id, $2 intro gain: a number, "omit" (an intro with no gain field) or "none" (no intro)
  local intro=""
  case "$2" in
    none) ;;
    omit) intro=",\"intro\":{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/item.wav\"}" ;;
    *) intro=",\"intro\":{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/item.wav\",\"gain\":$2}" ;;
  esac
  curl --fail --silent --header "Idempotency-Key: $1" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$1\",\"url\":\"http://127.0.0.1:3200/song.wav\",\"title\":\"T\",\"artist\":\"A\",\"duration\":16}$intro}" \
    "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
idle() {
  for attempt in $(seq 1 120); do
    if state | jq --exit-status '.status == "idle"' >/dev/null; then sleep 2; return 0; fi
    sleep 0.5
  done
  echo "gain check failed: the station did not go idle"; exit 1
}
fail() { echo "FAIL: $1"; exit 1; }
# Plain variables, not associative arrays, so the script runs on bash 3.2 too.
setv() { printf -v "$1" '%s' "$2"; }
getv() { printf '%s' "${!1}"; }

# 1. Instants: volume 1, 0.5 and none; then the malformed annotations, each read as no annotation.
run_instant() { # $1 name, $2 how
  idle
  record 8 "$1"
  sleep 2
  case "$2" in
    api:*) instant_api "${2#api:}" ;;
    raw:*) instant_raw "${2#raw:}" ;;
  esac
  sleep 8
  peak "$1" 2000
}
for spec in 'one api:1' 'half api:0.5' 'none api:' 'nan raw:nan' 'inf raw:inf' 'abc raw:abc' 'empty raw:' 'two raw:2' 'negative raw:-0.5'; do
  set -- $spec
  setv "level_$1" "$(run_instant "i-$1" "$2")"
  echo "instant  $(printf '%-9s' "$1") ${2}  ->  $(getv "level_$1") dB"
done
close "$level_half" "$(awk -v a="$level_one" 'BEGIN { print a - 6.0206 }')" 0.5 || fail "instant volume 0.5 is not about 6 dB below volume 1 ($level_half vs $level_one)"
close "$level_none" "$level_one" 0.3 || fail "an instant with no volume is not at the same level as volume 1"
for name in nan inf abc empty two negative; do
  close "$(getv "level_$name")" "$level_none" 0.3 || fail "the malformed annotation '$name' changed the level ($(getv "level_$name") vs $level_none)"
done
awk -v a="$level_one" 'BEGIN { exit !(a > -40) }' || fail "the reference instant is not audible"
# Each ignored value is logged once, for its own item: five invalid values were pushed (an empty one is an
# absent value and a valid one is silent), and no log line carries the value itself.
ignored_lines=$(docker logs "$c" 2>&1 | grep -c 'item_gain.*ignored an invalid gain' || true)
[ "$ignored_lines" = 5 ] || fail "expected one log line per ignored value (5), found $ignored_lines"
if docker logs "$c" 2>&1 | grep 'ignored an invalid gain' | grep -qiE 'nan|inf|-0\.5'; then fail "a log line carries the ignored value"; fi
echo "log      one line per ignored value: $ignored_lines"


# 2. Intros: gain 1, 0.5 and none (the intro is measured in its own 2 kHz band over the 440 Hz song).
run_intro() { # $1 name, $2 gain or none
  idle
  record 12 "$1"
  sleep 2
  song_api "$(id)" "$2"
  sleep 12
  peak "$1" 2000
}
for spec in 'one 1' 'half 0.5' 'omitted omit'; do
  set -- $spec
  setv "intro_$1" "$(run_intro "n-$1" "$2")"
  echo "intro    $(printf '%-9s' "$1") gain=${2}  ->  $(getv "intro_$1") dB (2 kHz band)"
done
close "$intro_half" "$(awk -v a="$intro_one" 'BEGIN { print a - 6.0206 }')" 0.7 || fail "intro gain 0.5 is not about 6 dB below gain 1 ($intro_half vs $intro_one)"
close "$intro_omitted" "$intro_one" 0.7 || fail "an intro with no gain is not at the same level as gain 1"
awk -v a="$intro_one" 'BEGIN { exit !(a > -40) }' || fail "the reference intro is not audible"

# 3. A song's level is unaffected by an instant's override playing over it (440 Hz band).
song_run() { # $1 name, $2 volume or none
  idle
  record 12 "$1"
  sleep 2
  song_api "$(id)" none
  sleep 3
  if [ "$2" != none ]; then instant_api "$2"; fi
  sleep 8
  peak "$1" 440
}
song_alone=$(song_run s-alone none)
song_over=$(song_run s-over 0.5)
echo "song     alone ${song_alone} dB, with an instant at volume 0.5 over it ${song_over} dB (440 Hz band)"
close "$song_over" "$song_alone" 0.7 || fail "an instant's override changed the song's level (${song_over} vs ${song_alone})"
awk -v a="$song_alone" 'BEGIN { exit !(a > -40) }' || fail "the reference song is not audible"
echo "item gain check passed"
