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

test('lifecycle endpoints enforce the configured program before issuing a command', async () => {
  const calls = [];
  const controller = new StreamController(
    {},
    {
      assertProgram: (program) => {
        calls.push(['program', program]);
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
    'command-one',
    '1',
    'filler-v1',
  );

  assert.deepEqual(calls, [
    ['program', 'program-one'],
    ['start', 'command-one', '1', 'filler-v1'],
  ]);
  assert.equal(response.actualState, 'ready');
});

test('metrics render on the private control interface', async () => {
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
    {},
    {
      renderMetrics: () => {
        calls.push(['filler-render']);
        return 'palazzo_filler_prepared_versions 1\n';
      },
    },
  );

  const response = await controller.getMetrics();

  assert.equal(
    response,
    'palazzo_build_info 1\npalazzo_filler_prepared_versions 1\n',
  );
  assert.deepEqual(calls, [['render'], ['filler-render']]);
});

test('program playback enforces program scope and preserves the idempotency key', async () => {
  const calls = [];
  const controller = new StreamController(
    {
      playProgramSong: async (...args) => {
        calls.push(['play', ...args]);
        return { ok: true, playbackRequestId: 'song' };
      },
    },
    {
      assertProgram: (...args) => calls.push(['program', ...args]),
      startFromPlaybackCommand: () => calls.push(['start']),
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

  await controller.playProgramSong('program-one', 'command', payload);

  assert.deepEqual(calls, [
    ['program', 'program-one'],
    ['start'],
    ['play', 'program-one', 'command', payload],
  ]);
});

test('program instant rejects cross-program assets and maps authoritative IDs', async () => {
  const played = [];
  const controller = new StreamController(
    { playInstant: async (payload) => played.push(payload) },
    {
      assertProgram: () => undefined,
      requireReady: () => undefined,
    },
    {},
  );
  await assert.rejects(
    controller.playProgramInstant('program-one', {
      programId: 'program-two',
      playbackId: 'instant',
      url: 'https://example.test/instant.mp3',
    }),
    /belongs to another program/,
  );
  await controller.playProgramInstant('program-one', {
    programId: 'program-one',
    playbackId: 'instant',
    url: 'https://example.test/instant.mp3',
  });
  assert.equal(played[0].playbackRequestId, 'instant');
});

test('program preflight enforces program scope before probing or reading readiness', async () => {
  const calls = [];
  const controller = new StreamController(
    {
      preflightProgramAssets: async (...args) => {
        calls.push(['preflight', ...args]);
        return { assets: [] };
      },
      getProgramPreflight: (...args) => {
        calls.push(['read', ...args]);
        return { assets: [] };
      },
    },
    {
      assertProgram: (...args) => calls.push(['program', ...args]),
    },
    {},
  );
  const payload = { assets: [] };

  await controller.preflightProgramAssets('program-one', payload);
  await controller.getProgramPreflight('program-one');

  assert.deepEqual(calls, [
    ['program', 'program-one'],
    ['preflight', 'program-one', payload],
    ['program', 'program-one'],
    ['read', 'program-one'],
  ]);
});
