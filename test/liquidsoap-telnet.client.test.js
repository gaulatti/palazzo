const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
  LiquidsoapTelnetClient,
} = require('../dist/stream/liquidsoap-telnet.client.js');
const {
  PlaybackTelemetryService,
} = require('../dist/stream/playback-telemetry.service.js');
const { assertBoundedLabels, parseExposition } = require('./prometheus-exposition');

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('serializes commands and incrementally frames fragmented responses', async () => {
  let connections = 0;
  const received = [];
  const server = net.createServer((socket) => {
    connections += 1;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const command = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        received.push(command);
        socket.write(`reply:${command}\r\nEN`);
        setImmediate(() => socket.write('D\r\n'));
      }
    });
  });
  const port = await listen(server);
  const client = new LiquidsoapTelnetClient({ port });

  const responses = await Promise.all([client.send('one'), client.send('two')]);

  assert.deepEqual(responses, ['reply:one', 'reply:two']);
  assert.deepEqual(received, ['one', 'two']);
  assert.equal(connections, 1);
  client.close();
  await close(server);
});

test('reconnects after a dropped persistent connection', async () => {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.once('data', (chunk) => {
      const command = chunk.toString('utf8').trim();
      if (command === 'drop') {
        socket.destroy();
        return;
      }
      socket.end(`ok:${command}\r\nEND\r\n`);
    });
  });
  const port = await listen(server);
  let reconnects = 0;
  const client = new LiquidsoapTelnetClient({
    port,
    reconnectBaseDelayMs: 1,
    onReconnect: () => {
      reconnects += 1;
    },
  });

  await assert.rejects(client.send('drop'));
  assert.equal(await client.send('recover'), 'ok:recover');
  assert.equal(connections, 2);
  assert.equal(reconnects, 1);
  client.close();
  await close(server);
});

test('timed out commands reject, destroy the socket and clear the pending response', async (t) => {
  const server = net.createServer((socket) => {
    socket.on('data', (chunk) => { if (chunk.toString().trim() !== 'timeout') socket.write('recovered\r\nEND\r\n'); });
  });
  const port = await listen(server);
  const client = new LiquidsoapTelnetClient({ port, commandTimeoutMs: 25 });
  t.after(async () => { client.close(); await close(server); });
  await assert.rejects(client.send('timeout'), /timed out after 25ms/);
  assert.equal(client.current, undefined);
  assert.equal(client.socket === null || client.socket.destroyed, true);
  client.onData(Buffer.from('\r\nEND\r\n'));
});

test('failed connections retry with a bound and expose the last dependency error', async () => {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const client = new LiquidsoapTelnetClient({ host: '127.0.0.1', port, maxReconnectAttempts: 2, reconnectBaseDelayMs: 1 });
  await assert.rejects(client.send('never sent'), /Unable to connect.*2 attempts.*ECONNREFUSED/);
  client.close();
  const disabled = new LiquidsoapTelnetClient({ port, maxReconnectAttempts: 0 });
  await assert.rejects(disabled.send('never sent'), /0 attempts: unknown error/);
  disabled.close();
});

test('retry diagnostics normalize non-Error transport rejections', async (t) => {
  const client = new LiquidsoapTelnetClient({ port: 1, maxReconnectAttempts: 1 });
  t.mock.method(client, 'connect', async () => { throw 'transport fixture'; });
  await assert.rejects(client.send('command'), /transport fixture/);
  client.close();
});

test('write callback failures and socket error events reject active commands without hanging the queue', async (t) => {
  const server = net.createServer((socket) => socket.resume());
  const port = await listen(server);
  const client = new LiquidsoapTelnetClient({ port });
  t.after(async () => { client.close(); await close(server); });
  // Inject an OS write failure at the socket callback, after a real TCP connect.
  const socket = await client.connectWithRetry();
  const write = t.mock.method(socket, 'write', function (chunk, encoding, callback) {
    queueMicrotask(() => callback(new Error('EPIPE fixture')));
    return false;
  });
  await assert.rejects(client.send('write-failure'), /EPIPE fixture/);
  write.mock.restore();
  const pending = client.send('socket-failure');
  await new Promise((resolve) => server.once('connection', resolve));
  await new Promise(setImmediate);
  client.socket.emit('error', new Error('ECONNRESET fixture'));
  await assert.rejects(pending, /ECONNRESET fixture/);
});

for (const staleEvent of ['close', 'error', 'data', 'write error']) {
  test(`replacement connection ignores stale ${staleEvent} from the timed-out socket`, async (t) => {
    const peers = new Set();
    let connections = 0;
    let replacementPeer;
    let receivedReplacement;
    const replacementReceived = new Promise((resolve) => { receivedReplacement = resolve; });
    const server = net.createServer((peer) => {
      peers.add(peer);
      const connection = ++connections;
      peer.on('error', () => {});
      peer.on('data', (bytes) => {
        const command = bytes.toString('utf8').trim();
        if (connection === 1) peer.write('old-response\r\nEND\r\n');
        else if (command === 'replacement') { replacementPeer = peer; receivedReplacement(); }
        else peer.write(`reply:${command}\r\nEND\r\n`);
      });
    });
    const port = await listen(server);
    const telemetry = new PlaybackTelemetryService({ get: () => undefined });
    const client = new LiquidsoapTelnetClient({ port, commandTimeoutMs: 2000, onReconnect: () => telemetry.countReconnect() });
    t.after(async () => { client.close(); for (const peer of peers) peer.destroy(); await close(server); });
    const oldSocket = await client.connectWithRetry();
    const callbacks = Object.fromEntries(['close', 'error', 'data'].map((event) => [event, oldSocket.listeners(event)]));
    for (const event of Object.keys(callbacks)) oldSocket.removeAllListeners(event);
    let receivedOldData;
    let oldBytes;
    const oldDataReceived = new Promise((resolve) => { receivedOldData = resolve; });
    let pendingOldBytes = Buffer.alloc(0);
    oldSocket.on('data', (bytes) => {
      pendingOldBytes = Buffer.concat([pendingOldBytes, bytes]);
      if (oldBytes || !pendingOldBytes.includes(Buffer.from('\r\nEND\r\n'))) return;
      // Deliver an actual partial old frame before the timeout; hold its tail.
      // A replacement must reset that connection's partial framing buffer too.
      for (const callback of callbacks.data) callback.call(oldSocket, pendingOldBytes.subarray(0, 4));
      oldBytes = pendingOldBytes.subarray(4);
      receivedOldData();
    });
    let receivedOldClose;
    let oldCloseArguments;
    const oldCloseReceived = new Promise((resolve) => { receivedOldClose = resolve; });
    oldSocket.on('close', (...args) => { oldCloseArguments = args; receivedOldClose(); });
    oldSocket.on('error', () => {});
    let delayedWriteCallback;
    if (staleEvent === 'write error') {
      const write = oldSocket.write;
      t.mock.method(oldSocket, 'write', function (bytes, encoding, callback) {
        delayedWriteCallback = callback;
        return write.call(this, bytes, encoding, () => {});
      });
    }
    // Hold real TCP data/close delivery at the application's callback boundary.
    // Advance only the command timer, then connect a real replacement. This
    // proves the adverse ordering without sleeping or repeating for luck.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const timeout = assert.rejects(client.send('old-command'), /timed out after 2000ms/);
    await oldDataReceived;
    t.mock.timers.tick(2000);
    await timeout;
    await oldCloseReceived;
    const replacement = client.send('replacement').then((value) => ({ value }), (error) => ({ error }));
    await replacementReceived;
    const replacementSocket = client.socket;
    assert.notEqual(replacementSocket, oldSocket);
    if (staleEvent === 'close') for (const callback of callbacks.close) callback.apply(oldSocket, oldCloseArguments);
    if (staleEvent === 'data') for (const callback of callbacks.data) callback.call(oldSocket, oldBytes);
    if (staleEvent === 'error') for (const callback of callbacks.error) callback.call(oldSocket, new Error('old transport failure'));
    if (staleEvent === 'write error') delayedWriteCallback(new Error('old write failure'));
    assert.equal(client.socket, replacementSocket, 'an old connection cannot discard its replacement');
    assert.equal(replacementSocket.destroyed, false);
    replacementPeer.write('fresh-response\r\nEND\r\n');
    assert.deepEqual(await replacement, { value: 'fresh-response' });
    assert.equal(await client.send('next-command'), 'reply:next-command');
    assert.equal(connections, 2);
    const samples = parseExposition(await telemetry.renderMetrics());
    assertBoundedLabels(samples);
    assert.equal(samples.find((sample) => sample.name === 'palazzo_telnet_reconnects_total').value, 1);
  });
}
