const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { MediaRelay } = require('../dist/stream/media-relay');
const { StreamService } = require('../dist/stream/stream.service');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { FillerStoreService } = require('../dist/stream/filler-store.service');
const { commandShim } = require('./command-shim');

// gaulatti/palazzo#45 wiring: every read Palazzo hands to Liquidsoap, ffprobe
// or the filler download goes through the real loopback relay; the supplied
// URL is never given to a tool, and events still carry it in palazzo_url.

const RELAYED = /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{32}(\.[a-z0-9]+)?$/;
const OUTSIDE = /https?:\/\/(?!127\.0\.0\.1:)/;

async function setup(t, { body = Buffer.from('RIFF relay wiring'), names } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const relay = new MediaRelay({ get: () => undefined });
  relay.deps = {
    resolve: async (host) => {
      const answer = (names ?? { 'media.example.test': ['93.184.216.34'] })[host];
      if (!answer) throw new Error('ENOTFOUND');
      return answer.map((address) => ({ address, family: 4 }));
    },
    request: (scheme, options) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined, servername: undefined }),
    now: () => Date.now(),
  };
  await relay.onModuleInit();
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-relay-wiring-'));
  t.after(async () => {
    await relay.onModuleDestroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { relay, root, requests, port, body };
}

function streamService(relay, root, extra = {}) {
  const values = { PLAYOUT_COMMAND_JOURNAL_PATH: join(root, 'journal.json'), PROGRAM_ID: 'station', ...extra };
  const config = { get: (key) => values[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, { getRuntimeState: () => ({}) }, relay);
  const commands = [];
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  service.telnet = { send: async (command) => { commands.push(command); return 'ok'; }, close: () => {} };
  return { service, telemetry, commands };
}

const target = (command) => command.slice(command.lastIndexOf('":') + 2);

test('a song and an instant reach Liquidsoap only as relay addresses, with the supplied URL kept for events', async (t) => {
  const { relay, root, requests } = await setup(t);
  const { service, commands } = streamService(relay, root);
  t.after(() => service.onModuleDestroy());
  const url = 'https://media.example.test/songs/a.wav?sig=abc';
  await service.playSong({ url, playbackRequestId: 'song-1', title: 'T' });
  await service.playInstant({ url: 'https://media.example.test/jingle.mp3', playbackRequestId: 'instant-1' });
  const pushes = commands.filter((command) => / push /.test(command) || command.startsWith('songs.push') || command.startsWith('instants.push'));
  assert.equal(pushes.length, 2);
  for (const push of pushes) {
    assert.match(target(push), RELAYED);
    assert.doesNotMatch(target(push), OUTSIDE);
  }
  assert.ok(pushes[0].includes(`palazzo_url="${url}"`));
  // The relay address really reads the supplied media.
  const read = await fetch(target(pushes[0]));
  assert.equal(read.status, 200);
  assert.equal(Buffer.from(await read.arrayBuffer()).toString(), 'RIFF relay wiring');
  assert.deepEqual(requests, ['/songs/a.wav?sig=abc']);
  assert.match(service.renderMediaMetrics(), /palazzo_media_fetch_total\{path="song",result="ok"\} 1/);
});

test('a refused address still reaches Liquidsoap as a relay address, which fails the read like an unreachable one', async (t) => {
  const { relay, root, requests } = await setup(t, { names: { 'inside.example.test': ['10.0.0.8'] } });
  const { service, commands } = streamService(relay, root);
  t.after(() => service.onModuleDestroy());
  await service.playSong({ url: 'https://inside.example.test/a.wav', playbackRequestId: 'song-2' });
  const push = commands.find((command) => command.startsWith('songs.push'));
  assert.match(target(push), RELAYED);
  assert.equal((await fetch(target(push))).status, 502);
  assert.equal(requests.length, 0);
  assert.match(relay.renderMetrics(), /palazzo_media_fetch_total\{path="song",result="address"\} 2/);
});

test('ffprobe is given the relay address with the http-only whitelist, never the supplied URL', async (t) => {
  const shim = await commandShim(t, 'ffprobe');
  await shim.configure({ stdout: JSON.stringify({ format: { format_name: 'wav', duration: '1' }, streams: [{ codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1, duration: '1' }], packets: [{ size: '2048' }] }) });
  const { relay, root } = await setup(t);
  const { service } = streamService(relay, root);
  t.after(() => service.onModuleDestroy());
  const result = await service.preflightProgramAssets('station', {
    assets: [{ programId: 'station', playbackId: 'p-1', kind: 'song', url: 'https://media.example.test/a.wav', scheduledAt: new Date().toISOString() }],
  });
  assert.equal(result.assets[0].readiness, 'ready');
  const args = await shim.arguments();
  const input = args[args.length - 1];
  assert.match(input, RELAYED);
  assert.deepEqual(args.filter((arg) => OUTSIDE.test(arg)), []);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp');
});

test('a preflight of a refused address is unreachable, the reason Alcantara already reads', async (t) => {
  const { relay, root, requests } = await setup(t, { names: { 'inside.example.test': ['192.168.0.9'] } });
  const { service } = streamService(relay, root);
  t.after(() => service.onModuleDestroy());
  const result = await service.preflightProgramAssets('station', {
    assets: [{ programId: 'station', playbackId: 'p-2', kind: 'song', url: 'https://inside.example.test/a.wav', scheduledAt: new Date().toISOString() }],
  });
  assert.equal(result.assets[0].readiness, 'quarantined');
  assert.equal(result.assets[0].reason, 'unreachable');
  assert.equal(requests.length, 0);
});

test('a filler is downloaded through the relay and prepared from the checked address', async (t) => {
  const source = join(tmpdir(), `palazzo-relay-filler-${process.pid}.wav`);
  await promisify(execFile)('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.4', source]);
  const body = await fs.readFile(source);
  await fs.rm(source);
  const { relay, root, requests } = await setup(t, { body });
  const values = { PROGRAM_ID: 'station', RADIO_FILLER_STORE_DIR: join(root, 'store'), RADIO_FILLER_PLAYLIST_PATH: join(root, 'run', 'active.m3u'), BITRATE: '128' };
  const store = new FillerStoreService({ get: (key) => values[key] }, relay);
  await store.initialize();
  const sha256 = createHash('sha256').update(body).digest('hex');
  const state = await store.prepare('v1', { commandId: 'c1', mode: 'ordered', assets: [{ id: 'a', sha256, downloadUrl: 'https://media.example.test/filler.wav?sig=x' }] }, 'c1');
  assert.equal(state.ready, true);
  assert.deepEqual(requests, ['/filler.wav?sig=x']);
  assert.match(relay.renderMetrics(), /palazzo_media_fetch_total\{path="filler",result="ok"\} 1/);
});
