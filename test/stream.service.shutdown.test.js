const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const cp = require('node:child_process');
const test = require('node:test');
const { identityRelay } = require('./media-relay-stub');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service.js');
const { StreamService } = require('../dist/stream/stream.service.js');

function service() {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const stream = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: '/run/palazzo/active-filler.m3u',
  }, identityRelay);
  stream.telnet = { send: async () => 'ok', close: () => undefined };
  return stream;
}

// A stand-in for the Liquidsoap child: records the signals it is sent and
// exits when told to, or never.
function fakeChild({ exitsOn }) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === exitsOn) setImmediate(() => { child.exitCode = 0; child.emit('close', 0); });
    return true;
  };
  return child;
}

test('shutting down waits for Liquidsoap to exit on SIGTERM and does not kill it', async () => {
  const stream = service();
  const child = fakeChild({ exitsOn: 'SIGTERM' });
  stream.process = child;
  await stream.onModuleDestroy();
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(stream.shuttingDown, true);
});

test('a Liquidsoap that ignores SIGTERM is killed after the wait', async (t) => {
  const stream = service();
  const child = fakeChild({ exitsOn: 'SIGKILL' });
  stream.process = child;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const done = stream.onModuleDestroy();
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(3000);
  await done;
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});

test('shutting down with no Liquidsoap running, or one that already exited, signals nothing', async () => {
  const none = service();
  await none.onModuleDestroy();
  const exited = service();
  const child = fakeChild({ exitsOn: 'SIGTERM' });
  child.exitCode = 0;
  exited.process = child;
  await exited.onModuleDestroy();
  assert.deepEqual(child.signals, []);
});

test('a Liquidsoap that exits while the app is closing is not respawned', async (t) => {
  const stream = service();
  stream.logger = { log() {}, debug() {}, error() {}, warn() {} };
  const spawned = [];
  t.mock.method(cp, 'spawn', () => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null });
    child.kill = () => { setImmediate(() => { child.exitCode = 0; child.emit('close', 0); }); return true; };
    spawned.push(child);
    return child;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stream.startLiquidsoap('/tmp/palazzo/stream.liq');
  assert.equal(spawned.length, 1);
  await stream.onModuleDestroy();
  // The restart backoff is 100 ms to 2 s: far past it, nothing may start again.
  t.mock.timers.tick(10_000);
  assert.equal(spawned.length, 1, 'Liquidsoap was respawned during shutdown');
  assert.equal(stream.process, null);
});
