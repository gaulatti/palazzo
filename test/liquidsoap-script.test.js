const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildLiquidsoapScript,
} = require('../dist/stream/liquidsoap-script.js');

test('generates a private authoritative telemetry script', () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: 'secret',
    mount: '/stream',
    streamName: 'Palazzo',
    genre: 'Various',
    bitrate: 128,
    fillerPlaylistPath: '/run/palazzo/active-filler.m3u',
  });

  assert.match(script, /settings\.server\.telnet\.bind_addr := "127\.0\.0\.1"/);
  assert.match(script, /songs\.on_track/);
  assert.match(script, /songs\.on_position/);
  assert.match(script, /palazzo_request_id/);
  assert.match(script, /cover_url/);
  assert.match(script, /icy_metadata=\["song", "title", "artist", "cover_url"\]/);
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
  assert.match(script, /reload_mode="watch"/);
  assert.match(script, /fallback\(track_sensitive=false, \[songs, filler\]\)/);
  assert.doesNotMatch(script, /server\.telnet\.bind_addr := "0\.0\.0\.0"/);
});

test('escapes user-controlled Liquidsoap string values', () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: 'quote"\npassword',
    mount: '/stream',
    streamName: 'Name"\nnext',
    genre: 'Various',
    bitrate: 128,
    fillerPlaylistPath: '/run/palazzo/active-filler.m3u',
    rtmpUrl: 'rtmp://example.test/live"\nnext',
  });

  assert.match(script, /password="quote\\"\\npassword"/);
  assert.match(script, /name="Name\\"\\nnext"/);
  assert.match(script, /input\.rtmp\("rtmp:\/\/example\.test\/live\\"\\nnext"\)/);
});
