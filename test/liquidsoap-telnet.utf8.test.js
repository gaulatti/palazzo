const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { LiquidsoapTelnetClient } = require('../dist/stream/liquidsoap-telnet.client.js');

async function station(t, respond) {
  const peers = new Set();
  let connections = 0;
  const server = net.createServer((peer) => {
    peers.add(peer);
    const connection = ++connections;
    let commands = '';
    peer.on('error', () => {});
    peer.on('data', (bytes) => {
      commands += bytes.toString('utf8');
      while (commands.includes('\n')) {
        const boundary = commands.indexOf('\n');
        const command = commands.slice(0, boundary);
        commands = commands.slice(boundary + 1);
        respond(peer, command, connection);
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new LiquidsoapTelnetClient({ port: server.address().port });
  t.after(async () => {
    client.close();
    for (const peer of peers) peer.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, connections: () => connections };
}

test('real TCP responses preserve UTF-8 metadata at every byte split with LF and CRLF framing', async (t) => {
  let frame;
  let split;
  const expected = 'artist=Björk; title=Jóga 🎶; label=日本語; marker=WEEKEND';
  const { client, connections } = await station(t, (peer) => {
    let received = 0;
    const observe = (bytes) => {
      received += bytes.length;
      if (received < split) return;
      client.socket.off('data', observe);
      peer.write(frame.subarray(split));
    };
    // Observe real inbound bytes without replacing the production decoder or
    // parser. The suffix is sent only after the entire prefix arrived, so TCP
    // cannot coalesce away the byte boundary being tested.
    client.socket.on('data', observe);
    peer.write(frame.subarray(0, split));
  });
  for (const newline of ['\n', '\r\n']) {
    frame = Buffer.from(`${newline}${expected}${newline}END${newline}`, 'utf8');
    for (split = 1; split < frame.length; split += 1) {
      assert.equal(await client.send('metadata'), expected, `UTF-8 frame split at byte ${split} with ${JSON.stringify(newline)}`);
    }
  }
  assert.equal(connections(), 1, 'framing must preserve the persistent command connection');
});

test('a replacement TCP connection discards an incomplete UTF-8 character from its predecessor', async (t) => {
  const { client, connections } = await station(t, (peer, command, connection) => {
    if (connection === 1) peer.end(Buffer.from([0xe2]));
    else peer.write(`${command}:clean\r\nEND\r\n`);
  });
  await assert.rejects(client.send('old'), /connection closed/);
  assert.equal(await client.send('replacement'), 'replacement:clean');
  assert.equal(connections(), 2);
});
