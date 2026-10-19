const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { FillerStoreService } = require('../dist/stream/filler-store.service');

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-filler-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { PROGRAM_ID: 'station', RADIO_FILLER_STORE_DIR: root, RADIO_FILLER_PLAYLIST_PATH: join(root, 'active.m3u') };
  const store = new FillerStoreService({ get: (key) => config[key] });
  await store.initialize();
  return { store, root, config, programRoot: join(root, createHash('sha256').update('station').digest('hex')) };
}
const asset = { id: 'audio', sha256: 'a'.repeat(64), downloadUrl: 'https://media.example.test/filler.mp3' };
const request = { commandId: 'prepare', assets: [asset] };

test('filler configuration validates required scope and bitrate and keeps documented defaults', () => {
  for (const config of [{}, { PROGRAM_ID: ' ' }, ...['0', '321', '1.5', 'bad'].map((BITRATE) => ({ PROGRAM_ID: 'station', BITRATE }))]) {
    assert.throws(() => new FillerStoreService({ get: (key) => config[key] }), /PROGRAM_ID|BITRATE/);
  }
  const store = new FillerStoreService({ get: (key) => key === 'PROGRAM_ID' ? 'station' : undefined });
  assert.equal(store.activePlaylistPath, '/run/palazzo/active-filler.m3u');
  assert.deepEqual(store.getRuntimeState(), { activeVersion: null, activeReady: false, preparationStatus: 'idle', preparedVersions: 0 });
});

test('filler request validation rejects malformed deliveries before any download', async (t) => {
  const { store } = await fixture(t);
  t.mock.method(global, 'fetch', () => assert.fail('invalid delivery cannot fetch media'));
  const invalid = [undefined, 'text', {}, { ...request, commandId: undefined }, { ...request, commandId: 'different' },
    { ...request, commandId: '-invalid' }, { ...request, mode: 'loop' },
    ...[undefined, '', 'x'.repeat(201)].map((shuffleSeed) => ({ ...request, mode: 'shuffle', shuffleSeed })),
    ...[undefined, [], Array(101).fill(asset)].map((assets) => ({ ...request, assets })),
    ...[null, { ...asset, id: 'bad/id' }, { ...asset, sha256: undefined }, { ...asset, sha256: 'bad' },
      { ...asset, downloadUrl: 'relative' }, { ...asset, downloadUrl: 'ftp://media.example.test/audio' }].map((item) => ({ ...request, assets: [item] })),
    { ...request, assets: [asset, asset] },
  ];
  for (const input of invalid) {
    await assert.rejects(store.prepare('v1', input, 'prepare'), (error) => error.getStatus() === 400);
  }
  await assert.rejects(store.prepare('bad/version', request, 'prepare'), /invalid-version/);
  await assert.rejects(store.prepare('v1', { ...request, commandId: undefined }, undefined), /invalid-command/);
  assert.equal((await store.getPublicState('v1')).status, 'unprepared');
  await assert.rejects(store.activate('v1'), /not prepared/);
});

test('preparing and failed states are observable without disclosing signed media URLs', async (t) => {
  const { store } = await fixture(t);
  let fetched;
  const entered = new Promise((resolve) => { fetched = resolve; });
  let respond;
  t.mock.method(global, 'fetch', async () => { fetched(); return new Promise((resolve) => { respond = resolve; }); });
  const pending = store.prepare('v1', request, 'prepare');
  await entered;
  assert.equal((await store.getPublicState('v1')).status, 'preparing');
  assert.equal((await store.getPublicState('other')).status, 'unprepared');
  assert.match(store.renderMetrics(), /preparation_in_progress 1/);
  respond(new Response(null, { status: 404 }));
  await assert.rejects(pending, (error) => error.getResponse().reason === 'download-failed');
  assert.equal((await store.getPublicState('v1')).failureReason, 'download-failed');
  assert.doesNotMatch(JSON.stringify(await store.getPublicState('v1')), /https:|downloadUrl/);
});

test('download failures, missing bodies and declared oversized media fail before writing', async (t) => {
  const { store, root } = await fixture(t);
  for (const response of [new Error('network'), new Response(null, { status: 204 }), new Response('body', { headers: { 'Content-Length': String(512 * 1024 * 1024 + 1) } })]) {
    const fetchMock = t.mock.method(global, 'fetch', async () => { if (response instanceof Error) throw response; return response; });
    await assert.rejects(store.download(asset.downloadUrl, join(root, 'download')), /download-failed|download-too-large/);
    fetchMock.mock.restore();
  }
  await assert.rejects(fs.stat(join(root, 'download')), { code: 'ENOENT' });
});

test('unknown-length streams enforce the real byte limit and close the destination on failure', async (t) => {
  const { store } = await fixture(t);
  const chunk = new Uint8Array(1024 * 1024);
  let chunks = 0;
  let written = 0;
  let closes = 0;
  // Reuse actual 1 MiB chunks; the disk boundary is a byte-counting sink so this
  // unit limit test consumes neither 512 MiB of disk nor simultaneous memory.
  t.mock.method(fs, 'open', async () => ({ write: async (bytes) => { written += bytes.byteLength; }, close: async () => { closes += 1; } }));
  t.mock.method(global, 'fetch', async () => new Response(new ReadableStream({ pull(controller) { chunks += 1; controller.enqueue(chunk); if (chunks === 513) controller.close(); } })));
  await assert.rejects(store.download(asset.downloadUrl, 'unit-sink'), /download-too-large/);
  assert.equal(written, 512 * 1024 * 1024);
  assert.equal(closes, 1);
});

test('invalid manifests and missing/corrupt artifacts never activate or survive restart selection', async (t) => {
  const { store, programRoot, config } = await fixture(t);
  const dir = join(programRoot, 'v1');
  await fs.mkdir(dir);
  const good = { schemaVersion: 1, version: 'v1', status: 'ready', assets: [{ artifact: 'track.mp3', artifactSha256: 'a'.repeat(64) }], playbackOrder: ['track.mp3'] };
  for (const manifest of [{ ...good, schemaVersion: 2 }, { ...good, version: 'other' }, { ...good, status: 'preparing' },
    { ...good, assets: undefined }, { ...good, playbackOrder: undefined }, good]) {
    await fs.writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest));
    assert.equal((await store.getPublicState('v1')).ready, false);
  }
  await fs.writeFile(join(dir, 'track.mp3'), 'tampered');
  assert.equal((await store.getPublicState('v1')).ready, false);
  await fs.writeFile(join(programRoot, '.active-version'), 'v1\n');
  const restarted = new FillerStoreService({ get: (key) => config[key] });
  await restarted.initialize();
  assert.equal(restarted.getActiveVersion(), null);
  await assert.rejects(fs.stat(join(programRoot, '.active-version')), { code: 'ENOENT' });
  await fs.writeFile(join(programRoot, '.active-version'), '  \n');
  await restarted.initialize();
  assert.equal(restarted.getActiveVersion(), null);
});

async function sourceAudio(root) {
  const { promisify } = require('node:util');
  const exec = promisify(require('node:child_process').execFile);
  const path = join(root, 'fixture.wav');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.1', path]);
  return fs.readFile(path);
}

async function prepared(t) {
  const context = await fixture(t);
  const bytes = await sourceAudio(context.root);
  t.mock.method(global, 'fetch', async () => new Response(bytes));
  const input = { commandId: 'prepare', assets: [{ ...asset, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  await context.store.prepare('v1', input, 'prepare');
  const directory = join(context.programRoot, 'v1');
  const manifest = JSON.parse(await fs.readFile(join(directory, 'manifest.json'), 'utf8'));
  return { ...context, input, directory, manifest };
}

test('corrupt downloaded bytes with a matching checksum still fail actual audio decoding', async (t) => {
  const { store } = await fixture(t);
  const bytes = Buffer.from('not audio');
  t.mock.method(global, 'fetch', async () => new Response(bytes));
  await assert.rejects(store.prepare('v1', { commandId: 'prepare', assets: [{ ...asset, sha256: createHash('sha256').update(bytes).digest('hex') }] }, 'prepare'), (error) => error.getResponse().reason === 'decode-failed');
  assert.equal((await store.getPublicState('v1')).ready, false);
});

test('validator rejects malformed subprocess output and incompatible encoded audio profiles', async (t) => {
  const { commandShim } = require('./command-shim');
  const shim = await commandShim(t, 'ffprobe');
  const { store } = await fixture(t);
  const good = { streams: [{ codec_name: 'mp3', sample_rate: '44100', channels: 2 }], format: { duration: '0.4' } };
  for (const output of ['invalid', {}, { ...good, streams: [] }, ...[{ codec_name: 'pcm_s16le' }, { sample_rate: '48000' }, { channels: 1 }].map((patch) => ({ ...good, streams: [{ ...good.streams[0], ...patch }] })), { ...good, format: undefined }, { ...good, format: { duration: '0' } }]) {
    await shim.configure({ stdout: typeof output === 'string' ? output : JSON.stringify(output) });
    await assert.rejects(store.validateAudio('fixture'), /validation-failed/);
  }
});

test('replacement quarantines corrupt versions and restores them if the atomic directory swap fails', async (t) => {
  const bytesRoot = await fs.mkdtemp(join(tmpdir(), 'palazzo-filler-source-'));
  t.after(() => fs.rm(bytesRoot, { recursive: true, force: true }));
  const bytes = await sourceAudio(bytesRoot);
  t.mock.method(global, 'fetch', async () => new Response(bytes));
  const input = { commandId: 'prepare', assets: [{ ...asset, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  for (const mode of ['success', 'swap-failure', 'permission-failure', 'non-error-failure', 'new-failure']) {
    const { store, programRoot } = await fixture(t);
    const target = join(programRoot, 'v1');
    if (mode !== 'new-failure') {
      await fs.mkdir(target);
      await fs.writeFile(join(target, 'sentinel'), 'original corrupt version');
    }
    const rename = fs.rename;
    const fault = t.mock.method(fs, 'rename', async (from, to) => {
      if (mode === 'non-error-failure' && from === target) throw 'untyped dependency failure';
      if (mode === 'permission-failure' && from === target) throw Object.assign(new Error('private disk detail'), { code: 'EACCES' });
      if (['swap-failure', 'new-failure'].includes(mode) && from.startsWith(join(programRoot, '.v1.')) && to === target) throw new Error('private disk detail');
      return rename(from, to);
    });
    if (mode === 'success') {
      assert.equal((await store.prepare('v1', input, 'prepare')).ready, true);
      await assert.rejects(fs.stat(join(target, 'sentinel')), { code: 'ENOENT' });
    } else {
      await assert.rejects(store.prepare('v1', input, 'prepare'), (error) => error.getResponse().reason === 'preparation-failed' && !JSON.stringify(error.getResponse()).includes('private disk detail'));
      if (mode !== 'new-failure') assert.equal(await fs.readFile(join(target, 'sentinel'), 'utf8'), 'original corrupt version');
    }
    fault.mock.restore();
    assert.equal((await fs.readdir(programRoot)).some((name) => name.startsWith('.v1.') || name.startsWith('v1.invalid.')), false);
  }
});

test('manifest playback order and activation revalidation reject missing or substituted artifacts', async (t) => {
  const { store, directory, manifest } = await prepared(t);
  for (const playbackOrder of [[], ['substituted.mp3']]) {
    await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, playbackOrder }));
    assert.equal((await store.getPublicState('v1')).ready, false);
  }
  await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  const path = join(directory, manifest.assets[0].artifact);
  const open = fs.open;
  let reads = 0;
  t.mock.method(fs, 'open', async (file, ...args) => {
    if (file === path && ++reads === 2) await fs.rm(path);
    return open(file, ...args);
  });
  await assert.rejects(store.activate('v1'), /not prepared/);
  assert.equal(store.getActiveVersion(), null);
});

test('cleanup retains the active session beyond the retention limit and ignores unprepared entries', async (t) => {
  const { store, directory, programRoot, manifest } = await prepared(t);
  await fs.utimes(directory, new Date(1000), new Date(1000));
  for (let index = 2; index <= 5; index += 1) {
    const target = join(programRoot, `v${index}`);
    await fs.cp(directory, target, { recursive: true });
    await fs.writeFile(join(target, 'manifest.json'), JSON.stringify({ ...manifest, version: `v${index}` }));
    await fs.utimes(target, new Date(index * 1000), new Date(index * 1000));
  }
  await fs.mkdir(join(programRoot, '.staging'));
  await fs.mkdir(join(programRoot, 'unprepared'));
  await fs.writeFile(join(programRoot, 'regular-file'), 'ignore');
  await store.activate('v1');
  await assert.rejects(store.activate('v5'), /immutable/);
  await store.cleanup(1);
  assert.equal(store.getRuntimeState().preparedVersions, 2);
  assert.equal((await store.getPublicState('v1')).ready, true);
  assert.equal((await store.getPublicState('v5')).ready, true);
  assert.equal((await store.getPublicState('v4')).ready, false);
  await store.deactivate();
  assert.equal(store.getActiveVersion(), null);
});
