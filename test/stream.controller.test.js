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
