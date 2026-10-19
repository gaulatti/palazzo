const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter, once } = require('node:events');
const { createServer } = require('node:http');
const { of, firstValueFrom } = require('rxjs');
const { StreamController } = require('../dist/stream/stream.controller');

function fixture() {
  const calls = [];
  const record = (method) => (...args) => { calls.push([method, ...args]); return { method }; };
  const event = { id: 'boot:1', type: 'track.started', data: { playbackId: 'song' } };
  const service = Object.fromEntries(['getStatus', 'stopSong', 'stopAllInstants', 'getMixer', 'updateMixer', 'playInstant'].map((key) => [key, record(key)]));
  service.telemetry = { getState: record('state'), subscribe: (cursor) => { calls.push(['subscribe', cursor]); return of(event); } };
  const lifecycle = { assertProgram: (id) => { assert.equal(id, 'program'); calls.push(['scope', id]); }, getState: record('lifecycle'), stop: record('stop'), requireReady: record('ready') };
  const filler = { getPublicState: record('filler'), prepare: record('prepare') };
  return { controller: new StreamController(service, lifecycle, filler), calls, event };
}

test('remaining control routes preserve arguments, program scope, readiness and acknowledgements', async () => {
  const { controller: c, calls } = fixture();
  assert.deepEqual(c.getStatus(), { method: 'getStatus' });
  assert.deepEqual(c.getMixer(), { method: 'getMixer' });
  assert.deepEqual(c.getPlaybackState(), { method: 'state' });
  assert.deepEqual(await c.getAutomation('program'), { method: 'lifecycle' });
  assert.deepEqual(await c.stopAutomation('program', 'key', '2'), { method: 'stop' });
  assert.deepEqual(await c.getFiller('program', 'v1'), { method: 'filler' });
  const request = { commandId: 'key', assets: [] };
  await c.prepareFiller('program', 'v1', ' key ', request);
  await c.prepareFiller('program', 'v1', undefined, request);
  assert.ok(calls.some(([name, version, payload, key]) => name === 'prepare' && version === 'v1' && payload === request && key === 'key'));
  assert.deepEqual(calls.at(-1), ['prepare', 'v1', request, undefined]);
  for (const result of [await c.stopSong(), await c.stopAllInstants(), await c.stopProgramSong('program'), await c.stopProgramInstants('program')]) assert.deepEqual(result, { ok: true });
  assert.deepEqual(await c.getProgramMixer('program'), { method: 'getMixer' });
  assert.deepEqual(await c.getProgramPlaybackState('program'), { method: 'state' });
  const mixer = { songVolume: 0.2 };
  await c.updateMixer(mixer);
  assert.deepEqual(calls.slice(-2), [['ready'], ['updateMixer', mixer]]);
  await c.updateProgramMixer('program', mixer);
  assert.deepEqual(calls.slice(-3), [['scope', 'program'], ['ready'], ['updateMixer', mixer]]);
});

test('SSE wrappers preserve the full authoritative event and replay cursor', async () => {
  const { controller: c, calls, event } = fixture();
  for (const stream of [c.playbackEvents('boot:0'), await c.programPlaybackEvents('program', 'boot:0')]) {
    assert.deepEqual(await firstValueFrom(stream), { id: event.id, type: event.type, data: event });
  }
  assert.equal(calls.filter(([name, cursor]) => name === 'subscribe' && cursor === 'boot:0').length, 2);
});

test('instant and song routes reject invalid identities before entering the engine', async () => {
  const { controller: c, calls } = fixture();
  await assert.rejects(c.playSong({}), /url is required/);
  await assert.rejects(c.playInstant({}), /url is required/);
  await c.playInstant({ url: 'https://media.example.test/instant.mp3' });
  for (const patch of [{ url: '' }, { playbackId: undefined }, { playbackId: ' ' }, { playbackId: 'x'.repeat(201) }]) {
    await assert.rejects(c.playProgramInstant('program', { programId: 'program', playbackId: 'instant', url: 'https://media.example.test/instant.mp3', ...patch }), /url is required|playbackId is invalid/);
  }
  assert.equal(calls.filter(([name]) => name === 'playInstant').length, 1);
});

test('output-monitor failures remove the reply disconnect listener and propagate the actual error', async () => {
  const error = new Error('audio unavailable');
  const c = new StreamController({}, { assertProgram: () => {} }, {}, { open: async () => { throw error; } });
  const reply = { raw: new EventEmitter() };
  await assert.rejects(c.programAudio('program', reply), (actual) => actual === error);
  assert.equal(reply.raw.listenerCount('close'), 0);
});

test('audio proxy relays actual bytes and content type, and rejects missing URLs or upstream errors', async (t) => {
  const c = new StreamController();
  await assert.rejects(c.proxyAudio(''), /url is required/);
  const server = createServer((req, res) => {
    if (req.url === '/failed') { res.writeHead(503); res.end('unavailable'); return; }
    if (req.url === '/typed') res.setHeader('Content-Type', 'audio/ogg');
    res.end(Buffer.from([0, 10, 255]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(c.proxyAudio(origin + '/failed'), /upstream returned 503/);
  for (const [path, type] of [['/typed', 'audio/ogg'], ['/untyped', 'audio/mpeg']]) {
    const result = await c.proxyAudio(origin + path);
    assert.equal(result.getHeaders().type, type);
    const chunks = [];
    for await (const chunk of result.getStream()) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), Buffer.from([0, 10, 255]));
  }
});
