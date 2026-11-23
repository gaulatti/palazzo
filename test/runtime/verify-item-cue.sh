#!/usr/bin/env bash
# gaulatti/palazzo#60 on a real Liquidsoap and Icecast, no production credentials: an instant and an intro
# play whole whatever cue metadata their audio file carries in its own tags (Palazzo sets cue points only for
# songs). Each item is a 4 s 2 kHz tone; the control file carries no cue tag. The audible length is the time
# the Icecast output holds energy in the 2 kHz band. Without the change a cue-out of 0.5 plays 0.5 s and a
# cue-in of 2.5 plays 1.5 s. A song's analysed cue points (annotated by Palazzo) still apply: a 16 s song sent
# with cue-in 2 and cue-out 6 plays 4 s.
# Usage: test/runtime/verify-item-cue.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
c="palazzo-cue-${RANDOM}-${RANDOM}"
cleanup() { docker rm --force "$c" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --rm --detach --name "$c" \
  --publish 127.0.0.1::3100 \
  --env PALAZZO_PORT=3100 --env PALAZZO_INSTANCE_ID=palazzo-cue --env PROGRAM_ID=program-ci \
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

# Items: 4 s 2 kHz tones as FLAC, which carries arbitrary tags: one with a cue-out of 0.5 s, one with a cue-in
# of 2.5 s and a plain control. The song is 16 s at 440 Hz.
tone() { docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=2000:sample_rate=44100" -t 4 "$@"; }
tone -c:a flac -metadata liq_cue_out=0.5 /tmp/cueout.flac
tone -c:a flac -metadata liq_cue_in=2.5 /tmp/cuein.flac
tone -c:a flac /tmp/plain.flac
tone -c:a flac -metadata title=LEAKTITLE -metadata artist=LEAKARTIST /tmp/titled.flac
docker exec "$c" ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 16 /tmp/song.wav
# The filler (6 kHz, well outside the 2 kHz and 440 Hz bands measured) keeps the station running between items.
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
id() { n=$((n + 1)); echo "c$n-${RANDOM}"; }
record() { docker exec --detach "$c" sh -c "rm -f /tmp/$2.done; ffmpeg -hide_banner -nostats -y -t $1 -i http://127.0.0.1:8000/stream -c:a pcm_s16le /tmp/$2.wav 2>/dev/null; touch /tmp/$2.done"; }
# Waits until the recording of /tmp/$1.wav has finished, so it is read whole.
recorded() { for attempt in $(seq 1 90); do docker exec "$c" test -e "/tmp/$1.done" && return 0; sleep 1; done; fail "the recording $1 did not finish"; }
# The audible span in the band around 2 kHz of /tmp/$1.wav: first to last 8 kHz mono sample above a threshold
# well under the tone (about 2700) and well over the leakage of the song before it (about 300) (the span, not a count: a 2 kHz tone sampled at 8 kHz has zero samples between its peaks).
audible() {
  docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -i /tmp/$1.wav -af bandpass=f=2000:width_type=h:w=300 -ac 1 -ar 8000 -f s16le - | node -e 'const b=[];process.stdin.on(\"data\",d=>b.push(d));process.stdin.on(\"end\",()=>{const x=Buffer.concat(b);let f=-1,l=-1;for(let i=0;i+1<x.length;i+=2)if(Math.abs(x.readInt16LE(i))>1000){if(f<0)f=i/2;l=i/2}console.log(f<0?\"0.00\":((l-f)/8000).toFixed(2))})'"
}
profile() { # $1 recording: the peak of the 2 kHz band per half second, to see where an item stops
  docker exec "$c" sh -c "ffmpeg -hide_banner -nostats -loglevel error -i /tmp/$1.wav -af bandpass=f=2000:width_type=h:w=300 -ac 1 -ar 8000 -f s16le - | node -e 'const b=[];process.stdin.on(\"data\",d=>b.push(d));process.stdin.on(\"end\",()=>{const x=Buffer.concat(b);const o=[];for(let s=0;s<x.length/16000;s+=0.5){let m=0;for(let i=Math.floor(s*8000);i<Math.min(x.length/2,(s+0.5)*8000);i++)m=Math.max(m,Math.abs(x.readInt16LE(i*2)));o.push(s.toFixed(1)+\":\"+m)}console.log(o.join(\" \"))})'"
}
instant_file() { # $1 file
  curl --fail --silent --header "Idempotency-Key: $(id)" --header 'Content-Type: application/json' --request POST \
    --data "{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/$1\"}" \
    "$api"/v1/programs/program-ci/playback/instant | jq --exit-status '.ok == true' >/dev/null
}
song_with_intro() { # $1 intro file
  local key; key="$(id)"
  curl --fail --silent --header "Idempotency-Key: $key" --header 'Content-Type: application/json' --request POST \
    --data "{\"song\":{\"programId\":\"program-ci\",\"playbackId\":\"$key\",\"url\":\"http://127.0.0.1:3200/song.wav\",\"title\":\"T\",\"artist\":\"A\",\"duration\":16},\"intro\":{\"programId\":\"program-ci\",\"playbackId\":\"$(id)\",\"url\":\"http://127.0.0.1:3200/$1\"}}" \
    "$api"/v1/programs/program-ci/playback/song | jq --exit-status '.ok == true' >/dev/null
}
idle() {
  for attempt in $(seq 1 120); do
    if state | jq --exit-status '.status == "idle"' >/dev/null; then sleep 2; return 0; fi
    sleep 0.5
  done
  echo "cue check failed: the station did not go idle"; exit 1
}
fail() { echo "FAIL: $1"; exit 1; }
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a >= b) }'; }

# The recording is waited for before it is read. The Icecast output lags the item by 4 to 7 s, so the recording runs well past its 4 s.
run_instant() { idle; record 20 "$1"; sleep 2; instant_file "$2"; sleep 12; recorded "$1"; audible "$1"; }
run_intro() { idle; record 22 "$1"; sleep 2; song_with_intro "$2"; sleep 14; recorded "$1"; audible "$1"; }

for spec in plain cueout cuein; do
  seconds=$(run_instant "i-$spec" "$spec.flac")
  echo "instant  $(printf '%-7s' "$spec") plays ${seconds} s of its 4 s"
  if [ -n "${DEBUG:-}" ]; then profile "i-$spec"; fi
  at_least "$seconds" 3.3 || fail "the instant '$spec' did not play whole (${seconds} s of 4 s)"
done
for spec in plain cueout cuein; do
  seconds=$(run_intro "n-$spec" "$spec.flac")
  # An intro that did not play at all (0 s) means its song never started in the window (the previous song
  # was still on air): run it again once. A cue value would show as a shortened intro, never as none.
  if awk -v a="$seconds" 'BEGIN { exit !(a < 0.1) }'; then seconds=$(run_intro "n-$spec" "$spec.flac"); fi
  echo "intro    $(printf '%-7s' "$spec") plays ${seconds} s of its 4 s"
  if [ -n "${DEBUG:-}" ]; then profile "n-$spec"; fi
  at_least "$seconds" 3.3 || fail "the intro '$spec' did not play whole (${seconds} s of 4 s)"
done
# 3. An intro's own title and artist (gaulatti/palazzo#60): the stream titles seen on Icecast while a titled
# intro plays before a song titled T / A (polled every 0.5 s, so a brief title is seen too).
idle
seen=""
events_file="$(mktemp)"
curl --silent --no-buffer --max-time 32 "$api"/v1/programs/program-ci/playback/events > "$events_file" 2>/dev/null &
events_pid=$!
sleep 1
song_with_intro titled.flac
for poll in $(seq 1 30); do
  seen="$seen $(docker exec "$c" node -e 'fetch("http://127.0.0.1:8000/status-json.xsl").then((r) => r.text()).then(console.log)' 2>/dev/null | jq --raw-output '[.icestats.source | (if type == "array" then .[] else . end) | .title // empty] | join("|")' 2>/dev/null | tr ' ' '_')"
  sleep 0.5
done
echo "intro    titled  stream titles seen:$(echo "$seen" | tr ' ' '\n' | sort -u | tr '\n' ' ')"
if echo "$seen" | grep -q LEAK; then fail "the intro's own title or artist reached the stream"; fi
# The playback events (intro_started, intro_ended) report the item's own title and artist too.
wait "$events_pid" 2>/dev/null || true
event_leak=$(grep -o 'LEAK[A-Z]*' "$events_file" | sort -u | tr '\n' ' ' || true)
intro_events=$(grep -ci 'intro' "$events_file" || true)
echo "intro    titled  ${intro_events} intro events seen; fields carrying the file's own tags: ${event_leak:-none}"
[ "$intro_events" -ge 1 ] || fail "no intro event was seen on the events stream"
if [ -n "$event_leak" ]; then fail "the intro's own title or artist reached the playback events ($event_leak)"; fi
rm -f "$events_file"
echo "item cue check passed"
