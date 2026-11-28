#!/usr/bin/env bash
# gaulatti/palazzo#75 on the real Liquidsoap, no Icecast and no network: a second track mark on a song deck,
# a few milliseconds into the song, is not the song's end. In production the announced song's gate switch
# selected its queue twice, 4 ms apart; the deck's allow_partial end hook read the partial first track as
# the end, journalled track_ended 22 ms after track_started and released the deck. This runs the station's
# own generated script (from the image's dist, Icecast output swapped for output.dummy) with
# deck-marks-harness.liq appended, which forces that double selection on deck b, then checks the journal:
# one track_started, no track_ended while the song plays, and one track_ended at its real end. The same run
# without the double selection, a truncated file, a cue-out and a skip must still end when they end.
# Production 2026-11-28: after the duplicate mark the song must still sound on the song bus (the deck held
# its request and its clock ran, but the bus was silent while Palazzo reported the song playing), and
# Liquidsoap checks the deck 1 s after the mark: "played" when it still plays and sounds;
# a deck that stalls after the mark (stalled: its gate closes again and stays closed) or plays on without
# sounding (silent: a song of digital silence) is ended within ~1 s.
# Production 2026-11-28, later: a song command arrived on the frame the announced song's gate had opened, before
# its track started; the announced request played out and the commanded song queued behind it on the same deck,
# then played silent (fade.out's end hook for the first request, whose end came before its remaining time
# reached 0, ran after its reset for the second). stacked puts two such requests back to back in one deck and
# requires the second to sound; command sends the song command in that window and requires the announced
# request not to play out; silentstart requires a song silent 1 s after its start, with no duplicate mark, to
# be journalled start_check "silent" and ended within ~1 s; faded requires the song's own fades to still apply.
# No mode may journal start_check for a song that sounds.
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
    ffmpeg -hide_banner -loglevel error -y -f lavfi -i "anullsrc=channel_layout=mono:sample_rate=44100" -t 10 /tmp/silent.wav
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
    const all = (journal) => JSON.parse(journal);
    const ours = (journal) => all(journal).filter((e) => e.playback_request_id === "deck-marks");
    const of = (events, type) => events.filter((e) => e.event_type === type);
    const mid = line("MID");
    const midEvents = ours(mid.slice(mid.indexOf("journal=") + 8));
    const songRms = Number((mid.match(/ song_rms=([^ ]+)/) || [])[1]);
    const lateRms = Number((line("LATE").match(/song_rms=([^ ]+)/) || [])[1]);
    const events = ours(line("EVENTS"));
    const checks = of(events, "duplicate_mark").map((e) => e.reason);
    const startChecks = of(all(line("EVENTS")), "start_check").map((e) => `${e.playback_request_id}:${e.reason}`);
    const started = of(events, "track_started"), ended = of(events, "track_ended");
    const switches = (out.match(/Switch to songs_next/g) || []).length;
    const ignored = /ignored a track end on request/.test(out);
    if (MODE !== "stalled" && MODE !== "silent" && of(midEvents, "track_started").length !== 1) fail("the song was not journalled started once by mid-song");
    if (started.length !== 1) fail(`track_started journalled ${started.length} times`);
    if (ended.length !== 1) fail(`track_ended journalled ${ended.length} times`);
    const played = ended[0].occurred_at - started[0].occurred_at;
    if (MODE === "duplicate") {
      if (switches < 2) fail(`the deck switched to its queue ${switches} time(s): the double selection was not reproduced`);
      if (!ignored) fail("the duplicate mark was not logged as ignored");
      if (of(midEvents, "track_ended").length !== 0) fail("the song was journalled ended while it was still playing");
      if (!/deck_b_playing=true current_playing=true/.test(mid)) fail(`the deck was released mid-song (${mid.split(" journal=")[0]})`);
      if (!(songRms > 0.01)) fail(`the song bus was silent after the duplicate mark (song_rms=${songRms}) while the song was reported playing`);
      if (checks.join() !== "played") fail(`the deck check after the duplicate mark journalled [${checks}], expected [played]`);
    } else if (MODE === "stalled" || MODE === "silent") {
      if (!ignored) fail("the duplicate mark was not logged as ignored");
      if (checks.join() !== "ended") fail(`the deck check after the duplicate mark journalled [${checks}], expected [ended]`);
    } else if (ignored) {
      fail("a real end was taken for a duplicate mark");
    }
    if (MODE === "silentstart") {
      if (startChecks.join() !== "deck-marks:silent") fail(`the check after the start journalled [${startChecks}], expected [deck-marks:silent]`);
    } else if (startChecks.length) {
      fail(`the check after the start journalled [${startChecks}] for a song that sounds`);
    }
    if (["natural", "stacked", "command"].includes(MODE) && !(songRms > 0.01)) fail(`the song bus was silent mid-song (song_rms=${songRms})`);
    if (MODE === "faded") {
      if (!(songRms > 0.012 && songRms < 0.05)) fail(`1 s into a 2 s fade-in the song bus was at ${songRms}, expected about half of 0.0625`);
      if (!(lateRms > 0.008 && lateRms < 0.045)) fail(`0.4 s before the end with a 1 s fade-out the song bus was at ${lateRms}, expected about 0.4 of 0.0625`);
    } else if (MODE === "natural" && !(lateRms > 0.05)) {
      fail(`the song bus was not at full level 2.6 s into a song without fades (song_rms=${lateRms})`);
    }
    if (MODE === "command") {
      const announced = all(line("EVENTS")).filter((e) => e.playback_request_id === "deck-marks-announced");
      const aStarted = of(announced, "track_started"), aEnded = of(announced, "track_ended");
      if (!/a song command came before the announced request/.test(out)) fail("reset_decks did not take the announced request that had not started yet");
      if (aEnded.length > 1 || aStarted.length > 1) fail(`the announced request was journalled started ${aStarted.length} and ended ${aEnded.length} times`);
      if (aStarted.length && (!aEnded.length || aEnded[0].occurred_at - aStarted[0].occurred_at > 0.5)) fail("the announced request played on after the song command");
      if (Number(started[0].occurred_at) < Math.max(0, ...aEnded.map((e) => e.occurred_at)) - 0.05) fail("the commanded song started before the announced request ended");
    }
    if (!["duplicate", "stalled", "silent"].includes(MODE) && checks.length) fail(`a deck check ran without a duplicate mark: [${checks}]`);
    if (played < Number(LOW) || played > Number(HIGH)) fail(`journalled ended ${played.toFixed(3)} s after it started, expected ${LOW} to ${HIGH} s`);
    console.log(`${MODE.padEnd(11)} switches=${switches} started=1 ended=1 after ${played.toFixed(2)} s, song_rms ${songRms.toFixed(4)} then ${lateRms.toFixed(4)}${["duplicate", "stalled", "silent"].includes(MODE) ? ` (duplicate mark ignored, check: ${checks})` : ""}${startChecks.length ? ` (start check: ${startChecks})` : ""}`);
  ' <<<"$out"
}

run duplicate 2.5 3.6
run stalled 0.9 2.0
run silent 0.9 2.0
run natural 2.5 3.6
run truncated 1.1 2.0
run cueout 0.7 1.4
run skip 1.1 1.9
run stacked 2.5 3.6
run silentstart 0.9 2.0
run faded 2.5 3.6
run command 2.5 3.6
echo "deck marks check passed"
