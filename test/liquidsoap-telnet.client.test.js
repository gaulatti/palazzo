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
