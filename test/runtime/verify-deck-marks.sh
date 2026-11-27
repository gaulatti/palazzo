#!/usr/bin/env bash
# gaulatti/palazzo#75 on the real Liquidsoap, no Icecast and no network: a second track mark on a song deck,
# a few milliseconds into the song, is not the song's end. In production the announced song's gate switch
# selected its queue twice, 4 ms apart; the deck's allow_partial end hook read the partial first track as
# the end, journalled track_ended 22 ms after track_started and released the deck. This runs the station's
# own generated script (from the image's dist, Icecast output swapped for output.dummy) with
# deck-marks-harness.liq appended, which forces that double selection on deck b, then checks the journal:
# one track_started, no track_ended while the song plays, and one track_ended at its real end. The same run
# without the double selection, a truncated file, a cue-out and a skip must still end when they end.
# Usage: test/runtime/verify-deck-marks.sh [image]   (default palazzo:ci)
set -euo pipefail
station_image="${1:-palazzo:ci}"
here="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $1"; exit 1; }

# $1 mode, then the expected seconds from track_started to track_ended (min max).
run() {
  local mode="$1" low="$2" high="$3" out
  out=$(docker run --rm -i --entrypoint sh --env MODE="$mode" "$station_image" -c '
    set -e
    cat > /tmp/harness.liq
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 3 /tmp/song.wav
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "sine=frequency=440:sample_rate=44100" -t 10 /tmp/long.wav
    # A WAV header for 10 s, cut after about 1.5 s of audio (mono 16-bit at 44.1 kHz: 88200 bytes a second).
    head -c 132400 /tmp/long.wav > /tmp/truncated.wav
    node -e "
      const fs = require(\"node:fs\");
      const { buildLiquidsoapScript } = require(\"/app/dist/stream/liquidsoap-script.js\");
      const script = buildLiquidsoapScript({ telnetPort: 14000, icecastPort: 8000, icecastPassword: \"deck-marks\",
        mount: \"/stream\", streamName: \"Palazzo\", genre: \"Various\", bitrate: 128,
        fillerPlaylistPath: \"/tmp/no-filler.m3u\", songRequestTimeoutMs: 10000 });
      const cut = script.indexOf(\"icecast_output = output.icecast(\");
      if (cut < 0) throw new Error(\"the generated script has no Icecast output to replace\");
      fs.writeFileSync(\"/tmp/station.liq\", script.slice(0, cut) + \"output.dummy(radio)\n\" + fs.readFileSync(\"/tmp/harness.liq\", \"utf8\"));
    "
    timeout 30 liquidsoap /tmp/station.liq 2>&1
  ' < "$here/deck-marks-harness.liq") || { echo "$out" | tail -20; fail "$mode: Liquidsoap did not run the station script"; }
  MODE="$mode" LOW="$low" HIGH="$high" node -e '
    const out = require("node:fs").readFileSync(0, "utf8");
    const { MODE, LOW, HIGH } = process.env;
    const fail = (why) => { console.log(`FAIL: ${MODE}: ${why}`); process.exit(1); };
    const line = (tag) => (out.split("\n").find((l) => l.startsWith(tag + " ")) || fail(`no ${tag} line`)).slice(tag.length + 1);
    const ours = (journal) => JSON.parse(journal).filter((e) => e.playback_request_id === "deck-marks");
    const of = (events, type) => events.filter((e) => e.event_type === type);
    const mid = line("MID");
    const midEvents = ours(mid.slice(mid.indexOf("journal=") + 8));
    const events = ours(line("EVENTS"));
    const started = of(events, "track_started"), ended = of(events, "track_ended");
    const switches = (out.match(/Switch to songs_next/g) || []).length;
    const ignored = /ignored a track end on request/.test(out);
    if (of(midEvents, "track_started").length !== 1) fail("the song was not journalled started once by mid-song");
    if (started.length !== 1) fail(`track_started journalled ${started.length} times`);
    if (ended.length !== 1) fail(`track_ended journalled ${ended.length} times`);
    const played = ended[0].occurred_at - started[0].occurred_at;
    if (MODE === "duplicate") {
      if (switches < 2) fail(`the deck switched to its queue ${switches} time(s): the double selection was not reproduced`);
      if (!ignored) fail("the duplicate mark was not logged as ignored");
      if (of(midEvents, "track_ended").length !== 0) fail("the song was journalled ended while it was still playing");
      if (!/deck_b_playing=true current_playing=true/.test(mid)) fail(`the deck was released mid-song (${mid.split(" journal=")[0]})`);
    } else if (ignored) {
      fail("a real end was taken for a duplicate mark");
    }
    if (played < Number(LOW) || played > Number(HIGH)) fail(`journalled ended ${played.toFixed(3)} s after it started, expected ${LOW} to ${HIGH} s`);
    console.log(`${MODE.padEnd(9)} switches=${switches} started=1 ended=1 after ${played.toFixed(2)} s${MODE === "duplicate" ? " (duplicate mark ignored)" : ""}`);
  ' <<<"$out"
}

run duplicate 2.5 3.6
run natural 2.5 3.6
run truncated 1.1 2.0
run cueout 0.7 1.4
run skip 1.1 1.9
echo "deck marks check passed"
