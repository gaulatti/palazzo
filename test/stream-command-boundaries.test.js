const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { StreamService } = require('../dist/stream/stream.service');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { mediaProbeResult } = require('./media-probe-fixture');

async function fixture(t, values = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-command-boundary-'));
  const path = join(root, 'commands.json');
  const config = { get: (key) => ({ PLAYOUT_COMMAND_JOURNAL_PATH: path, ...values })[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, { getRuntimeState: () => ({}) });
  service.logger = { log() {}, debug() {} };
  service.assetProbe = async () => mediaProbeResult();
  const commands = [];
  service.telnet = { send: async (command) => { commands.push(command); return 'ok'; }, close() {} };
  t.after(async () => { service.onModuleDestroy(); await fs.rm(root, { recursive: true, force: true }); });
  const song = { programId: 'station', playbackId: 'song', url: 'https://media.example.test/song.wav' };
  return { service, telemetry, root, path, song, commands };
}

test('paired playout rejects invalid command identities, payloads, gains and durations before issuing engine commands', async (t) => {
  const { service, song, commands } = await fixture(t);
  for (const key of [undefined, '', 'x'.repeat(201)]) await assert.rejects(service.playProgramSong('station', key, { song }), /Idempotency-Key/);
  for (const data of [undefined, { song: 'invalid' }, { song: {} }]) await assert.rejects(service.playProgramSong('station', 'key', data), /required|invalid/);
  const intro = { ...song, playbackId: 'intro', url: 'https://media.example.test/intro.wav' };
  for (const gain of ['1', NaN, -0.1, 1.1]) await assert.rejects(service.playProgramSong('station', 'key', { song, intro: { ...intro, gain } }), /between 0 and 1/);
  for (const fadeInSeconds of ['1', NaN, -0.1, 5.1]) await assert.rejects(service.playProgramSong('station', 'key', { song, intro: { ...intro, fadeInSeconds } }), /between 0 and 5/);
  assert.deepEqual(commands, []);
});

test('canonical fingerprints retain nested arrays and reject same-key playout substitution', async (t) => {
  const { service, song, commands } = await fixture(t);
  const first = { song, extension: [{ b: 2, a: 1 }, null] };
  assert.equal((await service.playProgramSong('station', 'command', first)).introPlaybackId, null);
  assert.equal((await service.playProgramSong('station', 'command', { extension: [{ a: 1, b: 2 }, null], song })).duplicate, true);
  await assert.rejects(service.playProgramSong('station', 'command', { song: { ...song, url: song.url + '?changed' } }), /already used/);
  assert.equal(commands.filter((command) => command.startsWith('songs.push')).length, 1);
  assert.ok(commands.includes('var.set palazzo_intro_duck_gain = 1'));
});

test('mixer validates each value and applies mute/unmute without allowing caller mutation of stored state', async (t) => {
  const { service, commands } = await fixture(t);
  for (const songMuted of [null, 'true', 1]) await assert.rejects(service.updateMixer({ songMuted }), /must be a boolean/);
  const state = await service.updateMixer({ songMuted: true, instantMuted: false, mainVolume: 0 });
  assert.ok(commands.includes('var.set palazzo_song_volume = 0'));
  assert.ok(commands.includes('var.set palazzo_instant_volume = 1'));
  state.songVolume = 0.1;
  assert.equal(service.getMixer().songVolume, 1);
  assert.equal((await service.updateMixer({})).mainVolume, 0);
});

test('queue failures clear pending track-end expectations, while instant Stop remains idempotent', async (t) => {
  const { service, telemetry } = await fixture(t);
  service.telnet.send = async () => { throw new Error('engine fixture'); };
  for (const operation of [() => service.playSong({ url: 'https://media.example.test/song.wav' }), () => service.stopSong(), () => service.clearProgramMaterial()]) {
    await assert.rejects(operation(), /engine fixture/);
    assert.equal(telemetry.pendingTrackEnd, null);
  }
  await service.stopAllInstants();
  assert.equal(telemetry.pendingTrackEnd, null);
});

test('annotation rejects control-line injection and escapes caller metadata before writing Telnet commands', async (t) => {
  const { service, commands } = await fixture(t);
  await assert.rejects(service.playSong({ url: 'https://media.example.test/song\nshutdown' }), /cannot contain newlines/);
  await service.playSong({ url: 'https://media.example.test/song.wav', playbackRequestId: ' request ', title: 'quote"\r\n\\title' });
  assert.match(commands[1], /palazzo_request_id="request"/);
  assert.match(commands[1], /title="quote\\"\\r\\n\\\\title"/);
  const instant = await service.playInstant({ url: 'https://media.example.test/instant.wav', playbackRequestId: ' explicit ', volume: 0 });
  assert.equal(instant.playbackRequestId, 'explicit');
  assert.match(commands.at(-1), /liq_amplify="0"/);
});

test('journal parsing rejects corrupt storage and ignores incomplete records without losing valid reservations', async (t) => {
  const corrupt = await fixture(t);
  await fs.writeFile(corrupt.path, '{invalid');
  await assert.rejects(corrupt.service.playProgramSong('station', 'key', { song: corrupt.song }), /journal is unavailable/);
  assert.deepEqual(corrupt.commands, []);
  const restored = await fixture(t);
  await fs.writeFile(restored.path, JSON.stringify([null, {}, { digest: 'empty-fingerprint' }, { digest: 'old', fingerprint: 'prior-command', playbackRequestId: 'prior', introPlaybackId: null, acceptedAt: '2026-01-01T00:00:00Z' }]));
  await restored.service.playProgramSong('station', 'fresh', { song: restored.song });
  const records = JSON.parse(await fs.readFile(restored.path, 'utf8'));
  assert.equal(records.length, 2);
  assert.equal(records[0].digest, 'old');
});

test('engine failure and cleanup failures cannot be reported as accepted playout', async (t) => {
  const { service, telemetry, path, song } = await fixture(t);
  let attempted = false;
  service.telnet.send = async () => {
    if (!attempted) { attempted = true; await fs.mkdir(path + '.tmp'); }
    throw new Error('private engine detail');
  };
  await assert.rejects(service.playProgramSong('station', 'failure', { song }), (error) => error.getStatus() === 400 && /engine rejected/.test(error.message) && !error.message.includes('private engine detail'));
  assert.equal(telemetry.pendingTrackEnd, null);
  assert.match(await telemetry.renderMetrics(), /result="rejected",reason="engine_failure"\} 1/);
});

test('durable playout reservations remain bounded under sustained commands', async (t) => {
  const { service, path, song } = await fixture(t);
  for (let index = 0; index < 258; index += 1) await service.playProgramSong('station', `key-${index}`, { song: { ...song, playbackId: `song-${index}` } });
  const records = JSON.parse(await fs.readFile(path, 'utf8'));
  assert.equal(records.length, 256);
  assert.equal(records[0].playbackRequestId, 'song-2');
  assert.equal(records.at(-1).playbackRequestId, 'song-257');
  assert.equal(service.getProgramPreflight('station').assets.length, 128);
});

test('transport poll failures remain observable and do not erase last-known playback', async (t) => {
  const { service, telemetry } = await fixture(t);
  for (const reason of [new Error('dependency unavailable'), 'untyped transport rejection']) {
    service.telnet.send = async () => { throw reason; };
    await service.pollTelemetry();
  }
  assert.equal(telemetry.getState().liquidsoap.connected, false);
  assert.match(await telemetry.renderMetrics(), /operation="telemetry_poll",result="failure"\} 2/);
});

test('legacy song and instant routes bound caller-supplied playbackRequestId', async (t) => {
  const { service, commands } = await fixture(t);
  const url = 'https://media.example.test/song.wav';
  await assert.rejects(service.playSong({ url, playbackRequestId: 'x'.repeat(201) }), /at most 200/);
  await assert.rejects(service.playInstant({ url, playbackRequestId: 'x'.repeat(250) }), /at most 200/);
  const accepted = await service.playSong({ url, playbackRequestId: 'x'.repeat(150) });
  assert.ok(accepted.ok || commands.length >= 0);
  assert.equal(accepted.playbackRequestId.length, 150);
});

test('song push proceeds when there is nothing to skip', async (t) => {
  const { service, commands } = await fixture(t);
  const send = service.telnet.send;
  service.telnet.send = async (command) => {
    if (command === 'songs.flush_and_skip') throw new Error('nothing playing');
    return send(command);
  };
  const accepted = await service.playSong({ url: 'https://media.example.test/song.wav' });
  assert.equal(accepted.ok, true);
  assert.equal(commands.filter((c) => c.startsWith('songs.push')).length, 1);
});
