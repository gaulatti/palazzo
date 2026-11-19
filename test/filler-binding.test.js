// gaulatti/palazzo#46: after a restart the radio has a filler bound without
// an automation Start. Real filler store and lifecycle over a real directory;
// versions are written with real artifact checksums (no ffmpeg needed).
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { identityRelay } = require('./media-relay-stub');
const { FillerStoreService } = require('../dist/stream/filler-store.service');
const { BroadcastLifecycleService } = require('../dist/stream/broadcast-lifecycle.service');
const { StreamController } = require('../dist/stream/stream.controller');
const { parseExposition } = require('./prometheus-exposition');

const hash = (value) => createHash('sha256').update(value).digest('hex');

async function station(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-filler-binding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = { PROGRAM_ID: 'station', RADIO_FILLER_STORE_DIR: join(root, 'store'), RADIO_FILLER_PLAYLIST_PATH: join(root, 'run', 'active-filler.m3u'), PALAZZO_INSTANCE_ID: 'palazzo-test', LIFECYCLE_TRANSITION_TIMEOUT_MS: '5' };
  const programRoot = join(root, 'store', hash('station'));
  await fs.mkdir(programRoot, { recursive: true });
  const logs = [];
  const boot = async () => {
    const filler = new FillerStoreService({ get: (key) => config[key] }, identityRelay);
    const log = t.mock.method(filler.logger, 'log', (message) => logs.push(message));
    await filler.initialize();
    log.mock.restore();
    return filler;
  };
  return { root, config, programRoot, boot, logs, playlist: () => fs.readFile(config.RADIO_FILLER_PLAYLIST_PATH, 'utf8') };
}

/** A prepared version as preparation leaves it; `preparedAt` orders versions. */
async function prepare(programRoot, name, preparedAt, { corrupt = false } = {}) {
  const directory = join(programRoot, name);
  await fs.mkdir(directory);
  const bytes = Buffer.from(`audio-${name}`);
  await fs.writeFile(join(directory, 'track-000.mp3'), corrupt ? 'tampered' : bytes);
  const manifest = { schemaVersion: 1, version: name, status: 'ready', ready: true, assets: [{ artifact: 'track-000.mp3', artifactSha256: hash(bytes) }], playbackOrder: ['track-000.mp3'] };
  if (preparedAt) manifest.preparedAt = preparedAt;
  await fs.writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  return join(directory, 'track-000.mp3');
}

function lifecycleFor(filler, config) {
  const playback = { liquidsoap: { running: true, connected: true }, icecast: { connected: true }, status: 'idle', levels: { instant: { peak: 0 } } };
  return new BroadcastLifecycleService(
    { get: (key) => config[key] },
    { clearProgramMaterial: async () => undefined },
    { getState: () => playback },
    filler,
  );
}

const gauges = async (filler, lifecycle) => {
  const controller = new StreamController(
    { telemetry: { renderMetrics: async () => '' }, renderMediaMetrics: () => '' },
    lifecycle,
    filler,
    { renderMetrics: async () => '' },
  );
  const samples = parseExposition(await controller.getMetrics());
  const read = (name) => samples.find((sample) => sample.name === name);
  assert.deepEqual(read('palazzo_filler_unbound_while_running').labels, {});
  return { unbound: read('palazzo_filler_unbound_while_running').value, active: read('palazzo_filler_active').value };
};

test('after a restart with a prepared filler and no selection, the first playback command binds it without a Start', async (t) => {
  const context = await station(t);
  const artifact = await prepare(context.programRoot, 'v1', '2026-11-01T00:00:00.000Z');
  const filler = await context.boot();
  // Boot binds nothing without a selection: a stopped radio stays silent.
  assert.equal(filler.getActiveVersion(), null);
  assert.equal(filler.getBoundBy(), null);
  assert.equal(await context.playlist(), '');
  assert.match(context.logs.join('\n'), /no filler bound at boot: preparedVersions=1/);
  const lifecycle = lifecycleFor(filler, context.config);
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(await context.playlist(), `${artifact}\n`);
  await assert.rejects(fs.stat(join(context.programRoot, '.active-version')), { code: 'ENOENT' });
  assert.deepEqual(lifecycle.getState().filler, { activeVersion: 'v1', ready: true, boundBy: 'fallback' });
  assert.deepEqual(await gauges(filler, lifecycle), { unbound: 0, active: 1 });
});

test('a filler prepared after the playback command flipped to running is bound by the next command', async (t) => {
  const context = await station(t);
  const filler = await context.boot();
  const lifecycle = lifecycleFor(filler, context.config);
  const warnings = [];
  t.mock.method(lifecycle.logger, 'warn', (message) => warnings.push(message));
  // Boot with nothing prepared succeeds, and the gauge shows the running program uncovered.
  assert.equal(filler.getBoundBy(), null);
  assert.equal(await context.playlist(), '');
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.deepEqual(await gauges(filler, lifecycle), { unbound: 1, active: 0 });
  assert.deepEqual(warnings, ['automation running with no prepared filler to bind']);
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(warnings.length, 1);
  // Preparation completes later (as `prepare` does, which recounts versions).
  const artifact = await prepare(context.programRoot, 'v1', '2026-11-01T00:00:00.000Z');
  await filler.cleanup();
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(await context.playlist(), `${artifact}\n`);
  assert.deepEqual(await gauges(filler, lifecycle), { unbound: 0, active: 1 });
});

test('a valid selection written by a Start wins over a newer prepared version and is restored', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'old', '2026-11-01T00:00:00.000Z');
  await prepare(context.programRoot, 'new', '2026-11-18T00:00:00.000Z');
  await fs.writeFile(join(context.programRoot, '.active-version'), 'old\n');
  const filler = await context.boot();
  assert.equal(filler.getActiveVersion(), 'old');
  assert.equal(filler.getBoundBy(), 'restored');
  assert.match(context.logs.join('\n'), /filler bound at boot: version=old boundBy=restored/);
  // A restored (Start-bound) filler stays immutable, as before.
  await assert.rejects(filler.activate('new'), /immutable/);
});

test('without a usable selection the playback command binds the newest valid version; invalid ones are never bound', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'older', '2026-11-01T00:00:00.000Z');
  await prepare(context.programRoot, 'middle', '2026-11-10T00:00:00.000Z');
  await prepare(context.programRoot, 'newest', '2026-11-18T00:00:00.000Z', { corrupt: true });
  await fs.mkdir(join(context.programRoot, 'not a version'));
  await fs.mkdir(join(context.programRoot, '.staging'));
  await fs.writeFile(join(context.programRoot, 'stray-file'), 'x');
  // A selection that no longer validates is removed and does not block the fallback.
  await fs.writeFile(join(context.programRoot, '.active-version'), 'newest\n');
  const filler = await context.boot();
  assert.equal(filler.getActiveVersion(), null);
  const lifecycle = lifecycleFor(filler, context.config);
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(filler.getActiveVersion(), 'middle');
  assert.equal(filler.getBoundBy(), 'fallback');
  assert.match(await context.playlist(), /middle\/track-000\.mp3\n$/);
  await assert.rejects(fs.stat(join(context.programRoot, '.active-version')), { code: 'ENOENT' });
  assert.equal(filler.getRuntimeState().preparedVersions, 2);
  // Binding is for an unbound filler only.
  assert.equal(await filler.bindFallback(), false);
  assert.equal(filler.getActiveVersion(), 'middle');
});

test('only versions that fail validation exist: nothing is bound and boot still succeeds', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'broken', '2026-11-18T00:00:00.000Z', { corrupt: true });
  const filler = await context.boot();
  assert.equal(filler.getActiveVersion(), null);
  assert.equal(filler.getBoundBy(), null);
  assert.equal(await context.playlist(), '');
  assert.match(context.logs.join('\n'), /no filler bound at boot: preparedVersions=0/);
  assert.equal(await filler.bindFallback(), false);
});

test('equal preparation times pick the greater name and a missing time is the oldest', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'a-untimed', undefined);
  await prepare(context.programRoot, 'b', '2026-11-18T00:00:00.000Z');
  await prepare(context.programRoot, 'c', '2026-11-18T00:00:00.000Z');
  const filler = await context.boot();
  lifecycleFor(filler, context.config).startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(filler.getActiveVersion(), 'c');
});

test('a version that stops validating before the playback command is never bound and playback goes on', async (t) => {
  const context = await station(t);
  const filler = await context.boot();
  const lifecycle = lifecycleFor(filler, context.config);
  const warnings = [];
  const errors = [];
  t.mock.method(lifecycle.logger, 'warn', (message) => warnings.push(message));
  t.mock.method(lifecycle.logger, 'error', (message) => errors.push(message));
  const artifact = await prepare(context.programRoot, 'v1', '2026-11-18T00:00:00.000Z');
  await filler.cleanup();
  await fs.writeFile(artifact, 'tampered');
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(lifecycle.getState().readiness, true);
  assert.equal(filler.getActiveVersion(), null);
  assert.deepEqual(warnings, ['automation running with no valid prepared filler to bind']);
  // The version validates at listing and breaks before it is written: fail closed, no crash.
  await fs.writeFile(artifact, 'audio-v1');
  const original = filler.writeActivePlaylist.bind(filler);
  t.mock.method(filler, 'writeActivePlaylist', async () => { throw new Error('disk'); });
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.deepEqual(errors, ['binding a prepared filler failed; none is bound']);
  assert.equal(filler.getActiveVersion(), null);
  assert.equal(await context.playlist(), '');
  filler.writeActivePlaylist = original;
});

test('an explicit Start replaces a fallback-bound filler but an activate-bound one stays immutable', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'v1', '2026-11-01T00:00:00.000Z');
  await prepare(context.programRoot, 'v2', '2026-11-02T00:00:00.000Z');
  await prepare(context.programRoot, 'v3', '2026-11-03T00:00:00.000Z');
  const filler = await context.boot();
  const lifecycle = lifecycleFor(filler, context.config);
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(filler.getActiveVersion(), 'v3');
  assert.equal(lifecycle.getState().requestedState, 'running');
  // The Start carries its own version while the state is running: it wins.
  const started = await lifecycle.start('start-one', '1', 'v1');
  assert.deepEqual(started.filler, { activeVersion: 'v1', ready: true, boundBy: 'activate' });
  assert.match(await context.playlist(), /v1\/track-000\.mp3\n$/);
  assert.equal(await fs.readFile(join(context.programRoot, '.active-version'), 'utf8'), 'v1\n');
  // Bound by a Start, it cannot be replaced, in the lifecycle or in the store.
  await assert.rejects(lifecycle.start('start-two', '2', 'v2'), (error) => error.getStatus() === 409);
  await assert.rejects(filler.activate('v2'), /immutable/);
  assert.equal(filler.getActiveVersion(), 'v1');
  // Stop unbinds; nothing is bound until a playback command binds one again.
  await lifecycle.stop('stop', '3');
  assert.deepEqual(lifecycle.getState().filler, { activeVersion: null, ready: false, boundBy: null });
  lifecycle.startFromPlaybackCommand();
  await filler.bindingTail;
  assert.equal(lifecycle.getState().filler.boundBy, 'fallback');
});

test('a restart restores a Start-bound filler, which is reported as restored', async (t) => {
  const context = await station(t);
  await prepare(context.programRoot, 'v1', '2026-11-01T00:00:00.000Z');
  const first = await context.boot();
  await first.activate('v1');
  assert.equal(first.getBoundBy(), 'activate');
  const second = await context.boot();
  assert.equal(second.getBoundBy(), 'restored');
  assert.equal(lifecycleFor(second, context.config).getState().filler.boundBy, 'restored');
});
