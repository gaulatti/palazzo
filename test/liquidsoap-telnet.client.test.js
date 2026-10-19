const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const {
  LiquidsoapTelnetClient,
} = require('../dist/stream/liquidsoap-telnet.client.js');

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
