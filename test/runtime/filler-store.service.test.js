const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { promisify } = require('node:util');
const test = require('node:test');
const distRoot = process.env.PALAZZO_DIST_DIR || join(__dirname, '..', '..', 'dist');
const { FillerStoreService } = require(join(distRoot, 'stream', 'filler-store.service.js'));

const execFileAsync = promisify(execFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'palazzo-filler-'));
  const assets = join(root, 'sources');
  await require('node:fs/promises').mkdir(assets);
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '0.4', join(assets, 'one.wav')]);
  await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '0.4', join(assets, 'two.ogg')]);
  const server = http.createServer(async (request, response) => {
    const name = request.url?.startsWith('/two') ? 'two.ogg' : request.url?.startsWith('/missing') ? 'missing' : 'one.wav';
    try { response.end(await readFile(join(assets, name))); } catch { response.statusCode = 404; response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const config = {
    PROGRAM_ID: 'program-one',
    RADIO_FILLER_STORE_DIR: join(root, 'store'),
    RADIO_FILLER_PLAYLIST_PATH: join(root, 'run', 'active.m3u'),
    BITRATE: '128',
  };
  const store = new FillerStoreService({ get: (key) => config[key] });
  await store.initialize();
  const asset = async (name, id) => {
    const body = await readFile(join(assets, name));
    return { id, sha256: createHash('sha256').update(body).digest('hex'), downloadUrl: `http://127.0.0.1:${port}/${name}?signed=private` };
  };
  return { root, store, server, asset, close: async () => { await new Promise((resolve) => server.close(resolve)); await rm(root, { recursive: true }); } };
}

test('prepares ordered local audio, binds it immutably, and restores it after restart', async () => {
  const context = await fixture();
  try {
    const assets = [await context.asset('one.wav', 'one'), await context.asset('two.ogg', 'two')];
    const request = { commandId: 'prepare-one', mode: 'ordered', assets };
    const ready = await context.store.prepare('version-one', request, 'prepare-one');
    assert.equal(ready.ready, true);
    assert.equal(ready.assets.length, 2);
    assert.doesNotMatch(JSON.stringify(ready), /signed|downloadUrl|private/);
    await context.store.activate('version-one');
    const playlist = await readFile(join(context.root, 'run', 'active.m3u'), 'utf8');
    assert.match(playlist, /track-000\.mp3/);
    assert.match(playlist, /track-001\.mp3/);
    await assert.rejects(context.store.activate('other-version'));

    const config = { PROGRAM_ID: 'program-one', RADIO_FILLER_STORE_DIR: join(context.root, 'store'), RADIO_FILLER_PLAYLIST_PATH: join(context.root, 'run', 'active.m3u'), BITRATE: '128' };
    const restarted = new FillerStoreService({ get: (key) => config[key] });
    await restarted.initialize();
    assert.equal(restarted.getActiveVersion(), 'version-one');
    assert.match(restarted.renderMetrics(), /palazzo_filler_active 1/);
  } finally { await context.close(); }
});

test('makes shuffle deterministic, deduplicates delivery, and preserves known-good content on failure', async () => {
  const context = await fixture();
  try {
    const assets = [await context.asset('one.wav', 'one'), await context.asset('two.ogg', 'two')];
    const request = { commandId: 'shuffle-one', mode: 'shuffle', shuffleSeed: 'stable-seed', assets };
    const first = await context.store.prepare('shuffle-v1', request, 'shuffle-one');
    const duplicate = await context.store.prepare('shuffle-v1', { ...request, assets: assets.map((item) => ({ ...item, downloadUrl: `${item.downloadUrl}&refreshed=yes` })) }, 'shuffle-one');
    assert.deepEqual(duplicate, first);
    await assert.rejects(context.store.prepare('shuffle-v1', { ...request, commandId: 'different' }, 'different'), /different immutable content/);
    const bad = { commandId: 'bad', assets: [{ ...(await context.asset('one.wav', 'bad')), sha256: '0'.repeat(64) }] };
    await assert.rejects(context.store.prepare('bad-v1', bad, 'bad'), (error) => {
      assert.equal(error.getResponse().reason, 'checksum-mismatch');
      return true;
    });
    assert.equal((await context.store.getPublicState('bad-v1')).failureReason, 'checksum-mismatch');
    assert.equal((await context.store.getPublicState('shuffle-v1')).ready, true);
    assert.doesNotMatch(context.store.renderMetrics(), /shuffle-v1|stable-seed|sourceSha256/);
  } finally { await context.close(); }
});
