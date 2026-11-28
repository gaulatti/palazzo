const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildLiquidsoapScript,
} = require("../dist/stream/liquidsoap-script.js");

test("generates a private authoritative telemetry script", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "secret",
    mount: "/stream",
    streamName: "Palazzo",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: '/run/palazzo/active-filler.m3u',
  });

  assert.match(script, /settings\.server\.telnet\.bind_addr := "127\.0\.0\.1"/);
  // Each song deck reports its own track starts and ends (gaulatti/palazzo#40).
  assert.match(script, /deck\.on_track\(/);
  assert.match(script, /deck\.on_position\(\n    position=\{0\.\}, remaining=true/);
  assert.match(script, /watch_deck\("a", deck_a\)\nwatch_deck\("b", deck_b\)/);
  // palazzo#41: each deck's song on air, and a command journals why it ends before cutting it.
  assert.match(script, /set_deck_request\(name, metadata_value\("palazzo_request_id", meta\)\)/);
  assert.match(script, /usage="mark_ending <replacement\|operator\|cancel>"/);
  assert.match(script, /event_type="track_skipped"/);
  assert.match(script, /palazzo_request_id/);
  assert.match(script, /cover_url/);
  assert.match(
    script,
    /icy_metadata=\["song", "title", "artist", "cover_url"\]/,
  );
  assert.match(script, /namespace="palazzo"/);
  assert.match(script, /"snapshot"/);
  assert.match(script, /"events"/);
  assert.match(script, /icecast_connected/);
  assert.match(script, /icecast_output\.on_connect/);
  assert.match(script, /icecast_output\.on_disconnect/);
  assert.match(script, /duration=0\.1/);
  assert.match(script, /radio_rms = rms/);
  assert.match(script, /radio = peak/);
  assert.match(script, /songs_rms = rms/);
  assert.match(script, /instants_rms = rms/);
  assert.match(script, /intros_queue = request\.queue\(id="intros"/);
  assert.match(script, /current_request_id\(\) == armed_intro_parent_id\(\)/);
  assert.match(script, /remember_event\("intro_started"/);
  assert.match(script, /remember_event\("intro_ended"/);
  assert.match(script, /smooth_add\(/);
  assert.match(script, /reload_mode="watch"/);
  // gaulatti/alcantara#230: the filler takes the air whenever no song or intro
  // is on, because smooth_add alone always reports ready.
  assert.match(
    script,
    /songs_on_air = switch\(\s*id="songs_on_air",\s*track_sensitive=false,\s*\[\(\{source\.is_ready\(songs\) or source\.is_ready\(intros\)\}, ducked_songs\)\]\s*\)/,
  );
  assert.match(
    script,
    /fallback\(track_sensitive=false, \[songs_on_air, filler\]\)/,
  );
  // The filler waits out ordinary handoffs, loads and instants.
  assert.match(script, /instants_requests = request\.queue\(id="instants"\)/);
  assert.match(script, /instants_queue = mksafe\(instants_titled\)/);
  assert.match(
    script,
    /source\.is_ready\(songs\) or source\.is_ready\(intros\) or source\.is_ready\(instants_requests\)/,
  );
  assert.match(script, /time\(\) - filler_last_on_air\(\) > 15\./);
  // The presence check runs on the output's clock, never from a thread that could race the clock waking the
  // sources at startup (CamlinternalLazy.Undefined, 2026-11-28).
  assert.match(
    script,
    /radio = mksafe\(radio\)\nstation_title := [^\n]*\n(#[^\n]*\n)*radio\.on_frame\(before=true, synchronous=true, fun \(\) ->\n  if source\.is_ready\(songs\)/,
  );
  assert.doesNotMatch(script, /thread\.run\(every=/);
  // gaulatti/palazzo#48: without a live input nothing else counts as on air.
  assert.match(
    script,
    /source\.is_ready\(instants_requests\) then\n\s*filler_last_on_air := time\(\)/,
  );
  assert.doesNotMatch(script, /live_input|input\.rtmp/);
  assert.match(script, /live_on_air=false,/);
  assert.match(script, /interactive\.float\("palazzo_song_volume", 1\.\)/);
  assert.match(script, /interactive\.float\("palazzo_instant_volume", 1\.\)/);
  assert.match(script, /interactive\.float\("palazzo_main_volume", 1\.\)/);
  // gaulatti/palazzo#52: the instants chain applies an instant's own gain, and the station instant volume
  // multiplies on top of it.
  assert.match(script, /instants_per_item = amplify\(override="liq_amplify", 1\., instants_queue\)/);
  assert.match(script, /instants_controlled = amplify\(override=null, instant_volume, instants_per_item\)/);
  assert.doesNotMatch(script, /server\.telnet\.bind_addr := "0\.0\.0\.0"/);
});

test("instants and intros read a validated per-item gain and spots without one stay at 1", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "password",
    mount: "/stream",
    streamName: "Name",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
  });
  // Both queues read liq_amplify.
  assert.match(script, /intros_per_item = amplify\(override="liq_amplify", 1\., intros_gained\)/);
  assert.match(script, /instants_per_item = amplify\(override="liq_amplify", 1\., instants_queue\)/);
  // The annotation is validated before it is read: finite and within [0, 1], else 1 (nan, inf, text,
  // negative and above 1 all fail the comparison and read as 1).
  assert.match(script, /def item_gain\(m\) =\n  raw = list\.assoc\(default="", "liq_amplify", m\)\n  g = float_of_string\(default=-1\., raw\)\n  if raw == "" then\n    1\.\n  elsif g >= 0\. and g <= 1\. then\n    g\n  else\n    id = list\.assoc\(default="", "palazzo_request_id", m\)\n    url = list\.assoc\(default="", "palazzo_url", m\)\n    log\.important\(label="item_gain"/);
  // An ignored value is logged once per item with its request id and URL, never the value itself.
  assert.match(script, /ignored an invalid gain for #\{id\} \(#\{url\}\)/);
  assert.doesNotMatch(script, /ignored an invalid gain[^\n]*#\{raw\}/);
  // The instants mapper keeps stripping the file's own tags (palazzo#54) and re-emits the validated gain on
  // both branches, so a file tag called liq_amplify cannot reach the amplify.
  assert.equal(script.match(/\("liq_amplify", string\(item_gain\(m\)\)\)/g).length, 3);
  // The intro mapper must not strip: the fades and events read the intro's other annotations.
  assert.match(script, /id="intros_gain",\n  strip=false,/);
  // gaulatti/palazzo#60: an intro's own file tags never reach the playback events.
  assert.match(
    script,
    /intros_gained = metadata\.map\([^)]*fun \(m\) -> \[\("liq_amplify", string\(item_gain\(m\)\)\), \("title", ""\), \("artist", ""\), \("song", ""\)\]/s,
  );
});

test("escapes user-controlled Liquidsoap string values", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: 'quote"\npassword',
    mount: "/stream",
    streamName: 'Name"\nnext',
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: '/run/palazzo/active-filler.m3u',
    rtmpUrl: 'rtmp://example.test/live"\nnext',
  });

  assert.match(script, /password="quote\\"\\npassword"/);
  assert.match(script, /name="Name\\"\\nnext"/);
  assert.match(
    script,
    /input\.rtmp\("rtmp:\/\/example\.test\/live\\"\\nnext"\)/,
  );
});

test("counts a live RTMP input on the air as presence for the filler", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "fixture-value",
    mount: "/stream",
    streamName: "Fixture",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
    rtmpUrl: "rtmp://example.test/live",
  });

  // gaulatti/palazzo#48: the raw input reports whether a live feed is on; the
  // mksafe wrapper is what the mix hears.
  assert.match(
    script,
    /live_input = input\.rtmp\("rtmp:\/\/example\.test\/live"\)\nlive = mksafe\(live_input\)/,
  );
  assert.match(
    script,
    /source\.is_ready\(instants_requests\) or source\.is_ready\(live_input\) then\n\s*filler_last_on_air := time\(\)/,
  );
  assert.ok(
    script.indexOf("live_input = input.rtmp") <
      script.indexOf("filler_last_on_air = ref"),
    "the live input is defined before the presence check reads it",
  );
  assert.match(script, /live_on_air=source\.is_ready\(live_input\),/);
  assert.match(
    script,
    /add\(normalize=false, \[program_audio, instants, live\]\)/,
  );
});

// gaulatti/palazzo#54: an instant never puts its file's own tags on the stream. With nothing else on air
// it is titled with the station name; over a song it carries no title. An announced spot, which starts
// while the song is on air, puts the station name on the stream directly.
test("instants are titled with the station name, never with their file's tags", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "secret",
    mount: "/stream",
    streamName: 'Radio "Modo" Italiano',
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
  });
  assert.match(
    script,
    /instants_titled = metadata\.map\(\n  id="instants_titles",\n  insert_missing=true,\n  strip=true,\n  fun \(m\) ->\n    if source\.is_ready\(songs\) or source\.is_ready\(intros\) then\n      \[\("title", ""\), \("artist", ""\), \("song", ""\), \("liq_amplify", string\(item_gain\(m\)\)\)\]\n    else\n      \[\("title", "Radio \\"Modo\\" Italiano"\), \("artist", ""\), \("song", ""\), \("liq_amplify", string\(item_gain\(m\)\)\)\]\n    end,\n  instants_requests\n\)\ninstants_queue = mksafe\(instants_titled\)\n/,
  );
  // The journal hooks stay on the queue itself.
  assert.match(script, /instants_requests\.on_track\(/);
  assert.ok(
    script.indexOf("station_title = ref(fun () -> ())") <
      script.indexOf("instants_requests.on_track("),
  );
  // Liquidsoap 2.4.5 calls a function held in a ref only once it is bound to a name.
  assert.match(
    script,
    /if metadata_value\("palazzo_spot", meta\) == "true" then\n        put_station_title = station_title\(\)\n        put_station_title\(\)\n      end/,
  );
  assert.match(
    script,
    /radio = mksafe\(radio\)\nstation_title := fun \(\) -> radio\.insert_metadata\(\[\("title", "Radio \\"Modo\\" Italiano"\)\]\)\n/,
  );
});

// gaulatti/palazzo#75: a second track mark on a song deck (its gate switch selecting the queue twice) is the
// same song going on. Behaviour on the real Liquidsoap: test/runtime/verify-deck-marks.sh.
test("a duplicate track mark on a song deck neither ends the song nor starts it again", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "password",
    mount: "/stream",
    streamName: "Name",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
    songRequestTimeoutMs: 10000,
  });
  // A mark is a duplicate only while the deck's queue still plays the request that "ended" and the remaining
  // time handed to the hook is above the hook's own point; a missing rid is never a duplicate.
  assert.match(
    script,
    /def deck_mark_is_duplicate\(name, pos, point, meta\) =\n  rid = metadata_value\("rid", meta\)\n  current = deck_queue\(name\)\.current\(\)\n  if rid == "" or pos <= point \+ 0\.5 or not null\.defined\(current\) then\n    false\n  else\n    string\(request\.id\(null\.get\(current\)\)\) == rid\n  end\nend/,
  );
  const watch = script.slice(script.indexOf("def watch_deck(name, deck) ="), script.indexOf('watch_deck("a", deck_a)'));
  // Every allow_partial hook of the deck checks the mark against its own point before acting.
  const hooks = watch.match(/allow_partial=true/g).length;
  assert.equal(hooks, 5);
  for (const point of ["next_overlap\\(\\) \\+ 0\\.1", "next_overlap\\(\\)", "0\\.12", "0\\."]) {
    assert.match(watch, new RegExp(`deck_mark_is_duplicate\\(name, pos, ${point}, meta\\)`));
  }
  assert.equal(watch.match(/deck_mark_is_duplicate\(/g).length, hooks);
  // The end hook journals nothing for a duplicate (it only schedules the check after the mark, production
  // 2026-11-28); track_ended stays in the branch for a real end.
  assert.match(
    watch,
    /if deck_mark_is_duplicate\(name, pos, 0\., meta\) then\n        log\.important\([^\n]*duplicate track mark[^\n]*\n        check_after_duplicate_mark\(name, deck, rid, pos, meta\)\n      else\n      begin\n        set_deck_playing\(name, false\)[\s\S]*remember_event\("track_ended", meta\)/,
  );
  // A start on the request already started on the deck is not journalled again.
  assert.match(
    watch,
    /if rid != "" and rid == deck_started_rid\(name\) then\n        log\.important\([^\n]*second track mark[^\n]*\n      else\n      begin\n        set_deck_started_rid\(name, rid\)[\s\S]*remember_event\("track_started", meta\)/,
  );
});

// Production 2026-11-28: after an ignored duplicate mark the deck held its request and its clock ran, but it
// was silent while Palazzo reported the song playing. Behaviour on the real Liquidsoap:
// test/runtime/verify-deck-marks.sh (duplicate, stalled and silent).
test("a song deck's gate sits above its fades, and a duplicate mark is checked 1 s later", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "password",
    mount: "/stream",
    streamName: "Name",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
    songRequestTimeoutMs: 10000,
  });
  const deck = script.slice(script.indexOf("def song_deck(queue, is_open) ="), script.indexOf("deck_a = song_deck("));
  // The gate switch is the deck's last operator before its meter: a reselection's mark never reaches the fades.
  assert.ok(deck.indexOf("fade.out(") < deck.indexOf("switch(track_sensitive=false"));
  assert.ok(deck.indexOf("switch(track_sensitive=false") < deck.indexOf("peak(duration=0.5, gated)"));
  assert.match(deck, /switch\(track_sensitive=false, \[\(\{is_open\(\)\}, faded\)\]\)/);

  const check = script.slice(
    script.indexOf("def check_after_duplicate_mark(name, deck, rid, pos, meta) ="),
    script.indexOf("def watch_deck(name, deck) ="),
  );
  // Only the check after the deck's latest mark acts, and only while that song is still the deck's.
  assert.match(check, /generation = deck_mark_check\(name\) \+ 1\n  set_deck_mark_check\(name, generation\)\n  thread\.run\(delay=1\., fun \(\) ->/);
  assert.match(check, /if deck_mark_check\(name\) == generation and deck_started_rid\(name\) == rid and deck_playing\(name\) then/);
  // Held: still the deck's request, its queue's remaining time went down, and it sounds (a song volume at 0
  // counts as sounding, so muting the songs never ends one).
  assert.match(check, /sounding = volume <= 0\. or level > 0\.001 \* volume/);
  assert.match(check, /if held and left > 0\. and left < pos - 0\.5 and sounding then[\s\S]*remember_duplicate_mark\("played", meta\)\n          end\n        else/);
  // Otherwise ended: the queue is skipped so the deck's own end hooks journal the end, with a closed gate
  // opened first and the skip sent after it, then a release if the deck is still marked playing.
  assert.match(check, /remember_duplicate_mark\("ended", meta\)\n[\s\S]*if held and deck_is_open\(name\) then\n              deck_queue\(name\)\.skip\(\)\n            elsif held then\n              begin\n                set_deck_open\(name, true\)\n                thread\.run\(delay=0\.1, fun \(\) -> if deck_holds\(name, rid\) then deck_queue\(name\)\.skip\(\) end\)/);
  assert.match(check, /thread\.run\(delay=0\.6, fun \(\) -> release_stalled_deck\(name, rid, meta\)\)/);
  const release = script.slice(
    script.indexOf("def release_stalled_deck(name, rid, meta) ="),
    script.indexOf("def check_after_duplicate_mark("),
  );
  assert.match(release, /if deck_started_rid\(name\) == rid and deck_playing\(name\) then/);
  assert.match(release, /set_deck_playing\(name, false\)[\s\S]*open_next_gate\(\)[\s\S]*remember_event\("track_ended", meta\)[\s\S]*current_playing := false/);
  assert.match(script, /event_type="duplicate_mark",\n      playback_request_id=metadata_value\("palazzo_request_id", meta\),/);
});
