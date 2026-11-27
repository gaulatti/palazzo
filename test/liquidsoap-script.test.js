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
    "the live input is defined before the presence thread reads it",
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

// gaulatti/palazzo#66: a song command prepares its song while the song on air keeps playing, then cuts to it; a
// queue flush (a stop, a clear) cancels a command still preparing, and a newer command wins over an older one.
test("prepares a commanded song before cutting the song on air", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "fixture-password",
    mount: "/stream",
    streamName: "Palazzo",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
  });
  assert.match(script, /usage="command_song <prepare limit seconds> <uri>"/);
  assert.match(script, /command_generation = ref\(0\)/);
  assert.match(
    script,
    /"flush_and_skip",\n    fun \(_\) ->\n      try\n        command_generation := command_generation\(\) \+ 1/,
  );
  // One poll per command decides and cuts (request.resolve does not stop a slow fetch on time): ready, failed, or
  // the limit; a newer command ends it. The resolver only records how the resolution ended.
  assert.match(script, /thread\.run\.recurrent\(delay=0\.05, fun \(\) ->\n            if command_generation\(\) != generation then\n              -1\./);
  assert.match(script, /cut_to_command\(r, "ready"\)/);
  assert.match(script, /cut_to_command\(request\.create\(uri\), "failed"\)/);
  assert.match(script, /elsif time\(\) - started >= limit then\n              begin\n                command_cut_generation := generation\n                cut_to_command\(request\.create\(uri\), "fallback"\)/);
  assert.match(script, /if command_generation\(\) == generation and command_cut_generation\(\) != generation then/);
  assert.match(script, /songs_queue\.set_queue\(\[\]\)\n    songs_queue\.skip\(\)\n    songs_queue\.push\(r\)/);
  assert.match(script, /event_type="command_prepare"/);
});
