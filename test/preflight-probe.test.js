const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { StreamService } = require('../dist/stream/stream.service');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { commandShim } = require('./command-shim');
const { mediaProbeResult } = require('./media-probe-fixture');

async function fixture(t, config = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-probe-'));
  const values = { PLAYOUT_COMMAND_JOURNAL_PATH: join(root, 'journal.json'), ...config };
  const cfg = { get: (key) => values[key] };
  const telemetry = new PlaybackTelemetryService(cfg);
  const service = new StreamService(cfg, telemetry, {});
  const commands = [];
  service.telnet = { send: async (command) => { commands.push(command); return 'ok'; }, close: () => {} };
  t.after(async () => { service.onModuleDestroy(); await fs.rm(root, { recursive: true, force: true }); });
  const asset = (id = 'media') => ({ programId: 'station', playbackId: id, url: `https://media.example.test/${id}.wav`, kind: 'song', scheduledAt: new Date().toISOString() });
  return { service, telemetry, commands, asset };
}

test('the ffprobe boundary parses real process output, rejects malformed metadata and preserves bounded reasons', async (t) => {
  const shim = await commandShim(t, 'ffprobe');
  const { service, commands, asset } = await fixture(t);
  const good = { format: { format_name: 'wav', duration: '0.4' }, streams: [{ codec_type: 'video' }, { codec_type: 'audio', codec_name: 'pcm_s16le', sample_rate: '44100', channels: 1, duration: '0.4' }], packets: [{ size: '2048' }] };
  const cases = [
    [JSON.stringify(good), 'ready'],
    [JSON.stringify({ ...good, format: undefined }), 'ready'],
    ['invalid JSON', 'corrupt'],
    [JSON.stringify({}), 'unsupported_media'],
    [JSON.stringify({ streams: [] }), 'unsupported_media'],
    [JSON.stringify({ ...good, packets: undefined }), 'invalid_metadata'],
    [JSON.stringify({ ...good, packets: [] }), 'invalid_metadata'],
    ...[{ codec_name: undefined }, { sample_rate: 'bad' }, { channels: 0 }, { duration: 'bad' }].map((patch) => [JSON.stringify({ ...good, format: undefined, streams: [{ ...good.streams[1], ...patch }] }), 'invalid_metadata']),
    [JSON.stringify({ ...good, packets: [{ size: '0' }] }), 'invalid_metadata'],
  ];
  let index = 0;
  for (const [stdout, reason] of cases) {
    await shim.configure({ stdout });
    const result = await service.preflightProgramAssets('station', { assets: [asset(`case-${index++}`)] });
    assert.equal(result.assets[0].reason, reason);
    assert.equal(result.assets[0].readiness, reason === 'ready' ? 'ready' : 'quarantined');
  }
  assert.ok((await shim.arguments()).includes('-show_packets'));
  assert.ok((await shim.arguments()).includes('-select_streams'));
  assert.deepEqual(commands, []);
});

test('media probe errors classify unsupported formats, process timeouts and incomplete dependency errors', async (t) => {
  const { service, asset } = await fixture(t);
  for (const [error, reason] of [
    [Object.assign(new Error('dependency terminated'), { signal: 'SIGTERM' }), 'timeout'],
    [new Error('unsupported media'), 'unsupported_media'],
    [{ code: 'ENETDOWN', stderr: 'unreachable' }, 'unreachable'],
  ]) {
    service.assetProbe = async () => { throw error; };
    const result = await service.preflightProgramAssets('station', { assets: [asset(reason)] });
    assert.equal(result.assets[0].reason, reason);
  }
  const shim = await commandShim(t, 'ffprobe');
  await shim.configure({ delay: 2000, stdout: '{}' });
  const slow = await fixture(t, { PREFLIGHT_TIMEOUT_MS: '100' });
  const result = await slow.service.preflightProgramAssets('station', { assets: [slow.asset()] });
  assert.equal(result.assets[0].reason, 'timeout');
});

test('absent or invalid probe results never fabricate a ready asset', async (t) => {
  const { service, asset } = await fixture(t);
  for (const [index, media] of [undefined, { ...mediaProbeResult(), mediaType: 'video' }, { ...mediaProbeResult(), durationSeconds: 0 }, { ...mediaProbeResult(), sampleRateHz: 0 }, { ...mediaProbeResult(), sampleRateHz: 1.2 }, { ...mediaProbeResult(), channels: 1.2 }, { ...mediaProbeResult(), readablePacketBytes: 1.2 }].entries()) {
    service.assetProbe = async () => media;
    const result = await service.preflightProgramAssets('station', { assets: [asset(`invalid-${index}`)] });
    assert.equal(result.assets[0].reason, 'invalid_metadata');
    assert.equal(result.assets[0].readiness, 'quarantined');
    assert.equal(result.assets[0].media, undefined);
  }
});

test('preflight validates scope, input bounds, URLs, kinds and schedule before probing', async (t) => {
  const { service, asset } = await fixture(t, { PREFLIGHT_BATCH_SIZE: 'bad', PREFLIGHT_CACHE_ENTRIES: '1' });
  service.assetProbe = () => assert.fail('invalid inputs cannot probe media');
  for (const data of [undefined, {}, { assets: [] }, { assets: Array(21).fill(asset()) }]) await assert.rejects(service.preflightProgramAssets('station', data), /assets/);
  for (const patch of [{ programId: undefined }, { programId: ' ' }, { playbackId: 'x'.repeat(201) }, { url: 'x'.repeat(4097) }, { programId: 'other' }, { url: 'relative' }, { url: 'ftp://media.example.test/x' }, { kind: 'music-video' }, { scheduledAt: 12 }, { scheduledAt: ' ' }, { scheduledAt: 'invalid' }]) {
    await assert.rejects(service.preflightProgramAssets('station', { assets: [{ ...asset(), ...patch }] }), /invalid|another program|absolute URL|not allowed/);
  }
  await assert.rejects(service.preflightProgramAssets('station', { assets: [undefined] }), /required/);
  service.assetProbe = async () => mediaProbeResult();
  const past = { ...asset('past'), scheduledAt: new Date(Date.now() - 60000).toISOString() };
  assert.equal((await service.preflightProgramAssets('station', { assets: [past] })).assets[0].reason, 'outside_lookahead');
  assert.equal((await service.preflightProgramAssets('station', { assets: [past] })).assets[0].reused, true);
  const now = Date.now();
  service.now = () => now;
  const future = asset('future');
  await service.preflightProgramAssets('station', { assets: [future] });
  service.now = () => now + 400000;
  assert.equal(service.getProgramPreflight('station').assets[0].readiness, 'expired');
  service.now = () => now;
  await service.preflightProgramAssets('station', { assets: [asset('another')] });
  assert.equal(service.getProgramPreflight('station').assets.length, 1);
});
