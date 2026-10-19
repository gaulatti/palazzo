const assert = require('node:assert/strict');
const test = require('node:test');
const cp = require('node:child_process');
const fs = require('node:fs/promises');
const { EventEmitter } = require('node:events');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { StreamService } = require('../dist/stream/stream.service');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service');
const { commandShim } = require('./command-shim');

async function fixture(t, values = {}, pipes = true) {
  const root = await fs.mkdtemp(join(tmpdir(), 'palazzo-process-boundary-'));
  const config = { get: (key) => ({ PLAYOUT_COMMAND_JOURNAL_PATH: join(root, 'commands.json'), PLAYBACK_EVENT_SEQUENCE_PATH: join(root, 'events.json'), ...values })[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const filler = { initialize: async () => {}, activePlaylistPath: '/fixture/active.m3u', getRuntimeState: () => ({ activeVersion: null }) };
  const service = new StreamService(config, telemetry, filler);
  service.logger = { log() {}, debug() {}, error() {}, warn() {} };
  const commands = [];
  service.telnet = {
    send: async (command) => { commands.push(command); return JSON.stringify(command === 'palazzo.events' ? [] : { liquidsoap_sequence: 0, playing: false, sampled_at: Date.now() / 1000 }); },
    close() {},
  };
  const children = [];
  t.mock.method(cp, 'spawn', (file, args, options) => {
    assert.equal(file, 'liquidsoap');
    assert.deepEqual(args, ['/tmp/palazzo/stream.liq']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    const child = Object.assign(new EventEmitter(), { stdout: pipes ? new EventEmitter() : null, stderr: pipes ? new EventEmitter() : null, exitCode: null });
    child.kill = () => { child.exitCode = 0; child.emit('close', 0); return true; };
    children.push(child);
    return child;
  });
  // Redirect only the fixed script path to this fixture's private directory;
  // never overwrite another local Palazzo process's /tmp/palazzo/stream.liq.
  const mkdir = fs.mkdir;
  const writeFile = fs.writeFile;
  const translate = (path) => path === '/tmp/palazzo' ? join(root, 'script') : path === '/tmp/palazzo/stream.liq' ? join(root, 'script/stream.liq') : path;
  t.mock.method(fs, 'mkdir', (path, ...args) => mkdir(translate(path), ...args));
  t.mock.method(fs, 'writeFile', (path, ...args) => writeFile(translate(path), ...args));
  t.after(async () => { service.onModuleDestroy(); await fs.rm(root, { recursive: true, force: true }); });
  return { service, telemetry, children, commands, script: () => fs.readFile(join(root, 'script/stream.liq'), 'utf8') };
}

for (const hz of [undefined, 'not-a-number', '0']) {
  test(`startup validates the generated script, polls and releases the real lifecycle with sample rate ${hz}`, async (t) => {
    const shim = await commandShim(t, 'liquidsoap');
    await shim.configure({ stdout: 'validated' });
    const context = await fixture(t, hz === undefined ? {} : { TELEMETRY_LEVEL_HZ: hz, ICECAST_MOUNT: '/custom', STREAM_NAME: 'Fixture', ICECAST_PORT: '8001', ICECAST_SOURCE_PASSWORD: 'fixture-value', STREAM_GENRE: 'Test', BITRATE: '192', RTMP_URL: 'rtmp://media.example.test/live' });
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
    await context.service.onModuleInit();
    await new Promise(setImmediate);
    assert.deepEqual(await shim.arguments(), ['--check', '/tmp/palazzo/stream.liq']);
    assert.match(await context.script(), /settings\.server\.telnet\.bind_addr := "127\.0\.0\.1"/);
    assert.equal(context.service.getStatus().running, true);
    assert.equal(context.service.getStatus().mount, hz === undefined ? '/stream' : '/custom');
    assert.ok(context.commands.includes('palazzo.snapshot'));
    t.mock.timers.tick(1000);
    await new Promise(setImmediate);
    context.service.onModuleDestroy();
    assert.equal(context.service.getStatus().running, false);
    assert.equal(context.telemetry.getState().liquidsoap.running, false);
    assert.match(await context.telemetry.renderMetrics(), /operation="process_exit",result="success"\} 1/);
  });
}

test('process exits use bounded exponential restart, reset after stability and stop retrying on shutdown', async (t) => {
  const context = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  context.service.startLiquidsoap('/tmp/palazzo/stream.liq');
  const first = context.children[0];
  first.stdout.emit('data', Buffer.from('engine stdout'));
  first.stderr.emit('data', Buffer.from('engine stderr'));
  first.emit('error', new Error('spawn failure'));
  for (const delay of [100, 200, 400, 800, 1600, 2000]) {
    const count = context.children.length;
    context.children.at(-1).exitCode = 1;
    context.children.at(-1).emit('close', 1);
    assert.equal(context.service.getStatus().running, false);
    t.mock.timers.tick(delay - 1);
    assert.equal(context.children.length, count);
    t.mock.timers.tick(1);
    assert.equal(context.children.length, count + 1);
  }
  t.mock.timers.tick(5000);
  assert.equal(context.service.restartAttempt, 0);
  context.children.at(-1).emit('close', 1);
  context.service.onModuleDestroy();
  const count = context.children.length;
  t.mock.timers.tick(10000);
  assert.equal(context.children.length, count);
  assert.match(await context.telemetry.renderMetrics(), /operation="process_restart"\} 7/);
});

test('late close events cannot discard replacement processes, and exited processes are not stable', async (t) => {
  const context = await fixture(t, {}, false);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  context.service.startLiquidsoap('/tmp/palazzo/stream.liq');
  const old = context.children[0];
  context.service.startLiquidsoap('/tmp/palazzo/stream.liq');
  old.emit('close', 1);
  assert.equal(context.service.process, context.children[1]);
  context.children[1].exitCode = 1;
  context.service.restartAttempt = 4;
  // The pending restart is canceled to isolate the exit-before-close window.
  clearTimeout(context.service.restartTimer);
  t.mock.timers.tick(5000);
  assert.equal(context.service.restartAttempt, 4);
  context.service.onModuleDestroy();
});

test('failed script validation never spawns an unchecked long-lived engine', async (t) => {
  const shim = await commandShim(t, 'liquidsoap');
  await shim.configure({ code: 1, stderr: 'invalid script' });
  const context = await fixture(t);
  await assert.rejects(context.service.onModuleInit(), /invalid script/);
  assert.equal(context.children.length, 0);
});

test('the service reconnect observer publishes its real bounded dependency metric', async () => {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, {});
  service.telnet.options.onReconnect();
  assert.match(await telemetry.renderMetrics(), /operation="telnet_connect"\} 1/);
  service.onModuleDestroy();
});
