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
  assert.match(script, /instants_per_item = amplify\(1\., instants_queue\)/);
  assert.doesNotMatch(script, /server\.telnet\.bind_addr := "0\.0\.0\.0"/);
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
    /instants_titled = metadata\.map\(\n  id="instants_titles",\n  insert_missing=true,\n  strip=true,\n  fun \(_\) ->\n    if source\.is_ready\(songs\) or source\.is_ready\(intros\) then\n      \[\("title", ""\), \("artist", ""\), \("song", ""\)\]\n    else\n      \[\("title", "Radio \\"Modo\\" Italiano"\), \("artist", ""\), \("song", ""\)\]\n    end,\n  instants_requests\n\)\ninstants_queue = mksafe\(instants_titled\)\n/,
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
