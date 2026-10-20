const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { LiquidsoapTelnetClient } = require('../dist/stream/liquidsoap-telnet.client.js');
const { PlaybackTelemetryService } = require('../dist/stream/playback-telemetry.service.js');
const { assertBoundedLabels, parseExposition } = require('./prometheus-exposition');

test('stalled TCP connections exhaust the retry budget and release the queue for a real recovery', async (t) => {
  const peers = new Set();
  const server = net.createServer((peer) => {
    peers.add(peer);
    peer.on('data', () => peer.write('recovered\r\nEND\r\n'));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const stalled = [];
  const originalConnect = net.Socket.prototype.connect;
  // Fault injection only at the OS connect boundary: no connect or error event
  // arrives. Retry, timers, queueing, metrics and the recovery TCP exchange are real.
  const connect = t.mock.method(net.Socket.prototype, 'connect', function (target, ...args) {
    if (target !== port) return originalConnect.call(this, target, ...args);
    stalled.push(this);
    return this;
  });
  const telemetry = new PlaybackTelemetryService({ get: () => undefined });
  const client = new LiquidsoapTelnetClient({
    port, commandTimeoutMs: 50, maxReconnectAttempts: 2, reconnectBaseDelayMs: 1,
    onReconnect: () => telemetry.countReconnect(),
  });
  let watchdog;
  t.after(async () => {
    clearTimeout(watchdog);
    connect.mock.restore();
    client.close();
    for (const peer of [...stalled, ...peers]) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  const outcome = await Promise.race([
    client.send('stalled').then(() => ({state: 'resolved'}), (error) => ({state: 'rejected', error})),
    new Promise((resolve) => { watchdog = setTimeout(() => resolve({state: 'still pending'}), 1000); }),
  ]);
  clearTimeout(watchdog);
  assert.equal(outcome.state, 'rejected', 'a stalled connect must settle without waiting for the OS network timeout');
  assert.match(outcome.error.message, /Unable to connect.*2 attempts.*connection timed out after 50ms/);
  assert.equal(stalled.length, 2, 'the configured retry limit remains authoritative');
  assert.ok(stalled.every((socket) => socket.destroyed), 'each timed-out transport is closed');
  connect.mock.restore();
  assert.equal(await client.send('recover'), 'recovered', 'the next queued command can connect to the real server');
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  assert.equal(samples.find((sample) => sample.name === 'palazzo_telnet_reconnects_total').value, 1);
});
