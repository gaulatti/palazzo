#!/usr/bin/env bash
# palazzo#47: Liquidsoap 2.4.5's own floor, PCM in on stdin and out on stdout,
# one run per setting. Usage: run-floor.sh <tag> [docker -e args...]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tag="$1"; shift
out="$here/.run"
node "$here/push-clicks.mjs" --clicks 14 --spacing 2000 --lead 6000 --start-delay 6000 \
  --log "$out/$tag-sent.jsonl" -- sh -c "docker run -i --rm --init --network none $* \
  -v $here/floor.liq:/floor.liq:ro -v $out:/logs --entrypoint liquidsoap \
  savonet/liquidsoap:v2.4.5 /floor.liq 2>/dev/null | node $here/ear-pcm.mjs $out/$tag-ear.jsonl"
docker ps -q --filter ancestor=savonet/liquidsoap:v2.4.5 | xargs -r docker rm -f >/dev/null
printf '%s %s\n' "$tag" "$(node "$here/analyze.mjs" "$out/$tag-sent.jsonl" "$out/$tag-ear.jsonl" | tail -1)"
