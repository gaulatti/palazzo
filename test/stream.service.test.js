const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PlaybackTelemetryService,
} = require('../dist/stream/playback-telemetry.service.js');
const { StreamService } = require('../dist/stream/stream.service.js');

function streamService() {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry);
  const commands = [];
  service.telnet = {
    send: async (command) => {
      commands.push(command);
      return 'ok';
    },
    close: () => undefined,
  };
  return { service, commands };
}

test('propagates a caller-supplied playback request ID into Liquidsoap metadata', async () => {
  const { service, commands } = streamService();
  const accepted = await service.playSong({
    url: 'https://example.test/song.mp3',
    title: 'Title',
    artist: 'Artist',
    playbackRequestId: 'alcantara-request-42',
  });

  assert.equal(accepted.playbackRequestId, 'alcantara-request-42');
  assert.match(commands[1], /palazzo_request_id="alcantara-request-42"/);
  assert.doesNotMatch(commands[1], /remaining/);
});

test('generates and returns an ID for backward-compatible callers', async () => {
  const { service, commands } = streamService();
  const accepted = await service.playInstant({
    url: 'https://example.test/instant.mp3',
  });

  assert.match(accepted.playbackRequestId, /^[0-9a-f-]{36}$/);
  assert.match(commands[0], new RegExp(accepted.playbackRequestId));
});
