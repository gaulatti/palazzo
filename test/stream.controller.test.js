const assert = require('node:assert/strict');
const test = require('node:test');
const { StreamController } = require('../dist/stream/stream.controller.js');

test('a song command starts automation before entering the playback queue', async () => {
  const calls = [];
  let played = 0;
  const controller = new StreamController(
    {
      playSong: async () => {
        played += 1;
        return { ok: true, playbackRequestId: 'request' };
      },
    },
    {
      startFromPlaybackCommand: () => {
        calls.push('start');
      },
    },
    {},
  );

  await controller.playSong({ url: 'https://example.test/song.mp3' });
  assert.equal(played, 1);
  assert.deepEqual(calls, ['start']);
});

test('lifecycle endpoints authenticate before issuing a command', async () => {
  const calls = [];
  const controller = new StreamController(
    {},
    {
      authorize: async (program, authorization) => {
        calls.push(['authorize', program, authorization]);
      },
      start: async (key, sequence, version) => {
        calls.push(['start', key, sequence, version]);
        return { actualState: 'ready' };
      },
    },
    {},
  );

  const response = await controller.startAutomation(
    'program-one',
    'Bearer redacted',
    'command-one',
    '1',
    'filler-v1',
  );

  assert.deepEqual(calls, [
    ['authorize', 'program-one', 'Bearer redacted'],
    ['start', 'command-one', '1', 'filler-v1'],
  ]);
  assert.equal(response.actualState, 'ready');
});

test('metrics authenticate before rendering the collector', async () => {
  const calls = [];
  const controller = new StreamController(
    {
      telemetry: {
        renderMetrics: async () => {
          calls.push(['render']);
          return 'palazzo_build_info 1\n';
        },
      },
    },
    {
      authorizeMachine: async (authorization) => {
        calls.push(['authorize', authorization]);
      },
    },
    {
      renderMetrics: () => {
        calls.push(['filler-render']);
        return 'palazzo_filler_prepared_versions 1\n';
      },
    },
  );

  const response = await controller.getMetrics('Bearer redacted');

  assert.equal(
    response,
    'palazzo_build_info 1\npalazzo_filler_prepared_versions 1\n',
  );
  assert.deepEqual(calls, [
    ['authorize', 'Bearer redacted'],
    ['render'],
    ['filler-render'],
  ]);
});

test('program playback authenticates and preserves the idempotency key', async () => {
  const calls = [];
  const controller = new StreamController(
    {
      playProgramSong: async (...args) => {
        calls.push(['play', ...args]);
        return { ok: true, playbackRequestId: 'song' };
      },
    },
    {
      authorize: async (...args) => calls.push(['authorize', ...args]),
      requireReady: () => calls.push(['ready']),
    },
    {},
  );
  const payload = {
    song: {
      programId: 'program-one',
      playbackId: 'song',
      url: 'https://example.test/song.mp3',
    },
  };

  await controller.playProgramSong(
    'program-one',
    'Bearer token',
    'command',
    payload,
  );

  assert.deepEqual(calls, [
    ['authorize', 'program-one', 'Bearer token'],
    ['ready'],
    ['play', 'program-one', 'command', payload],
  ]);
});

test('program instant rejects cross-program assets and maps authoritative IDs', async () => {
  const played = [];
  const controller = new StreamController(
    { playInstant: async (payload) => played.push(payload) },
    {
      authorize: async () => undefined,
      requireReady: () => undefined,
    },
    {},
  );
  await assert.rejects(
    controller.playProgramInstant('program-one', 'Bearer token', {
      programId: 'program-two',
      playbackId: 'instant',
      url: 'https://example.test/instant.mp3',
    }),
    /belongs to another program/,
  );
  await controller.playProgramInstant('program-one', 'Bearer token', {
    programId: 'program-one',
    playbackId: 'instant',
    url: 'https://example.test/instant.mp3',
  });
  assert.equal(played[0].playbackRequestId, 'instant');
});
