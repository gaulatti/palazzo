const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const net = require('node:net');
const { networkInterfaces } = require('node:os');
const {
  MediaRelay,
  MAX_MEDIA_BYTES,
  MAX_RELAY_TOKENS,
  pinnedLookup,
  isAudioMediaType,
} = require('../dist/stream/media-relay');
const { unsafeAddress } = require('../dist/stream/address-policy');
const { assertBoundedLabels, parseExposition } = require('./prometheus-exposition');

// gaulatti/palazzo#45: media is read only through the loopback relay, which
// checks the address on every request and connects to the checked address.

const PUBLIC = '93.184.216.34';

/** A local origin standing in for a media host; every request is recorded. */
async function origin(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return { port: server.address().port, requests };
}

/**
 * A started relay whose resolver answers from `names` and whose transport
 * connects to the local origin, recording the address the pinned lookup gave.
 */
async function relayFor(t, originPort, names, config = {}) {
  const relay = new MediaRelay({ get: (key) => config[key] });
  const pinned = [];
  let clock = 1_000_000;
  relay.deps = {
    resolve: async (host) => {
      const answer = typeof names === 'function' ? names(host) : names[host];
      if (!answer) throw new Error('ENOTFOUND');
      return answer.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
    request: (scheme, options) => {
      options.lookup('ignored', {}, (_error, address) => pinned.push({ scheme, address, servername: options.servername, host: options.headers.host }));
      return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: originPort, lookup: undefined, servername: undefined });
    },
    now: () => clock,
  };
  await relay.onModuleInit();
  t.after(() => relay.onModuleDestroy());
  return { relay, pinned, advance: (ms) => (clock += ms) };
}

const audio = (body = Buffer.from('ID3 relay test audio')) => (req, res) => {
  res.writeHead(200, { 'content-type': 'audio/mpeg; charset=binary', 'content-length': body.length, 'accept-ranges': 'bytes', 'set-cookie': 'x=1' });
  res.end(req.method === 'HEAD' ? undefined : body);
};

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: options.method ?? 'GET', headers: options.headers ?? {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

async function counts(relay) {
  const text = relay.renderMetrics();
  // The exposition must parse as Prometheus text with bounded labels.
  assertBoundedLabels(parseExposition(text));
  const map = new Map();
  for (const line of text.split('\n')) {
    const match = /^(\S+) (\d+)$/.exec(line);
    if (match) map.set(match[1], Number(match[2]));
  }
  return map;
}

test('binds 127.0.0.1 only, on a port nothing publishes, and refuses another interface', async (t) => {
  const { port } = await origin(t, audio());
  const { relay } = await relayFor(t, port, {});
  const address = relay.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
  const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (external) {
    const error = await new Promise((resolve) => {
      const socket = net.connect(address.port, external.address);
      socket.once('connect', () => { socket.destroy(); resolve(null); });
      socket.once('error', resolve);
    });
    assert.equal(error?.code, 'ECONNREFUSED');
  }
});

test('relays an audio answer from the checked address, keeping SNI and Host and passing no other header', async (t) => {
  const { port, requests } = await origin(t, audio());
  const { relay, pinned } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const url = await relay.issue('https://media.example.test/songs/a.MP3?sig=abc', 'song', 5_000);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{32}\.mp3$/);
  const response = await get(url);
  assert.equal(response.status, 200);
  assert.equal(response.body.toString(), 'ID3 relay test audio');
  assert.equal(response.headers['content-type'], 'audio/mpeg');
  assert.equal(response.headers['set-cookie'], undefined);
  assert.deepEqual(pinned, [{ scheme: 'https:', address: PUBLIC, servername: 'media.example.test', host: 'media.example.test' }]);
  assert.equal(requests[0].url, '/songs/a.MP3?sig=abc');
  assert.deepEqual(Object.keys(requests[0].headers).sort(), ['connection', 'host', 'user-agent']);
  assert.equal(requests[0].headers['user-agent'], 'palazzo-media-relay');
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="song",result="ok"}'), 1);
});

test('forwards Range and passes a partial answer, under the same rules', async (t) => {
  const { port, requests } = await origin(t, (req, res) => {
    if (req.url === '/text') {
      res.writeHead(206, { 'content-type': 'text/html', 'content-range': 'bytes 0-3/10' });
      return res.end('<htm');
    }
    res.writeHead(206, { 'content-type': 'audio/mp4', 'content-range': 'bytes 4-7/20', 'content-length': 4 });
    res.end('moov');
  });
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const ranged = await get(await relay.issue('https://media.example.test/a.m4a', 'preflight', 5_000), { headers: { range: 'bytes=4-7' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], 'bytes 4-7/20');
  assert.equal(ranged.body.toString(), 'moov');
  assert.equal(requests[0].headers.range, 'bytes=4-7');
  const text = await get(await relay.issue('https://media.example.test/text', 'preflight', 5_000), { headers: { range: 'bytes=0-3' } });
  assert.equal(text.status, 502);
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="preflight",result="content_type"}'), 1);
});

test('answers HEAD with headers only', async (t) => {
  const { port, requests } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const response = await get(await relay.issue('https://media.example.test/a.mp3', 'song', 5_000), { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.equal(response.body.length, 0);
  assert.equal(requests[0].method, 'HEAD');
});

test('only GET and HEAD on /m/<token> are served; anything else is 404 and reaches no origin', async (t) => {
  const { port, requests } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const url = await relay.issue('https://media.example.test/a.mp3', 'song', 5_000);
  const base = url.replace(/\/m\/.*$/, '');
  const token = /\/m\/([0-9a-f]{32})/.exec(url)[1];
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    assert.equal((await get(url, { method })).status, 404, method);
  }
  for (const path of ['/', '/m/', `/m/${token}/x`, `/m/${token.toUpperCase()}`, `/m/${'0'.repeat(32)}`, `/m/${token}?url=https://other.example.test/b.mp3`, '/m?url=https://media.example.test/a.mp3', `/x/${token}`]) {
    assert.equal((await get(base + path)).status, 404, path);
  }
  // No Host-based routing: a Host header naming a media host changes nothing.
  assert.equal((await get(base + '/a.mp3', { headers: { host: 'media.example.test' } })).status, 404);
  assert.equal(requests.length, 0);
});

test('a token expires at its deadline and the map stays bounded', async (t) => {
  const { port } = await origin(t, audio());
  const { relay, advance } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const url = await relay.issue('https://media.example.test/a.mp3', 'song', 1_000);
  advance(1_000);
  assert.equal((await get(url)).status, 404);
  // A song token survives any number of preflight tokens issued after it.
  const song = await relay.issue('https://media.example.test/a.mp3', 'song', 60_000);
  for (let i = 0; i < MAX_RELAY_TOKENS * 2; i += 1) await relay.issue('https://media.example.test/a.mp3', 'preflight', 60_000);
  assert.equal((await get(song)).status, 200);
  // Only playout tokens alone evict their oldest.
  const first = await relay.issue('https://media.example.test/a.mp3', 'next', 60_000);
  for (let i = 0; i < MAX_RELAY_TOKENS; i += 1) await relay.issue('https://media.example.test/a.mp3', 'song', 60_000);
  assert.equal((await get(first)).status, 404);
});

test('checks the address again at every request: a name that turns private is refused and never connected', async (t) => {
  const { port, requests } = await origin(t, audio());
  let answer = [PUBLIC];
  const { relay, pinned } = await relayFor(t, port, () => answer);
  const url = await relay.issue('https://rebind.example.test/a.mp3', 'next', 5_000);
  answer = ['10.0.0.8'];
  assert.equal((await get(url)).status, 502);
  answer = [];
  assert.equal((await get(url)).status, 502);
  assert.equal(requests.length, 0);
  assert.equal(pinned.length, 0);
  const metrics = await counts(relay);
  assert.equal(metrics.get('palazzo_media_fetch_total{path="next",result="address"}'), 1);
  assert.equal(metrics.get('palazzo_media_fetch_total{path="next",result="dns"}'), 1);
});

test('a URL refused when issued gets a token that every request refuses, counted each time', async (t) => {
  const { port, requests } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'inside.example.test': ['192.168.1.4'], 'mixed.example.test': [PUBLIC, '10.1.1.1'] });
  const cases = [
    ['https://10.0.0.1/a.mp3', 'address'],
    ['https://[::1]/a.mp3', 'address'],
    ['https://169.254.169.254/latest/a.mp3', 'address'],
    ['https://inside.example.test/a.mp3', 'address'],
    ['https://mixed.example.test/a.mp3', 'address'],
    ['https://user:pass@media.example.test/a.mp3', 'invalid_url'],
    ['not a url', 'invalid_url'],
    ['ftp://media.example.test/a.mp3', 'scheme'],
    ['https://unknown.example.test/a.mp3', 'dns'],
  ];
  for (const [url, reason] of cases) {
    const relayed = await relay.issue(url, 'instant', 5_000);
    assert.equal((await get(relayed)).status, 502, url);
    assert.ok((await counts(relay)).get(`palazzo_media_fetch_total{path="instant",result="${reason}"}`) >= 2, url);
  }
  assert.equal(requests.length, 0);
});

test('refuses a redirect without following it, an error status, a non-audio answer and an oversized one', async (t) => {
  const { port, requests } = await origin(t, (req, res) => {
    if (req.url === '/moved') { res.writeHead(302, { location: 'https://media.example.test/a.mp3' }); return res.end(); }
    if (req.url === '/missing') { res.writeHead(404); return res.end(); }
    if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>'); }
    if (req.url === '/untyped') { res.writeHead(200); return res.end('x'); }
    if (req.url === '/huge') { res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': String(MAX_MEDIA_BYTES + 1) }); return res.end(); }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.end('ok');
  });
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const expected = new Map();
  for (const [path, result] of [['/moved', 'redirect'], ['/missing', 'http_status'], ['/page', 'content_type'], ['/untyped', 'content_type'], ['/huge', 'too_large']]) {
    const response = await get(await relay.issue(`https://media.example.test${path}`, 'song', 5_000));
    assert.equal(response.status, 502, path);
    expected.set(result, (expected.get(result) ?? 0) + 1);
    assert.equal((await counts(relay)).get(`palazzo_media_fetch_total{path="song",result="${result}"}`), expected.get(result), path);
  }
  assert.equal(requests.filter((r) => r.url === '/a.mp3').length, 0);
});

test('cuts a streamed answer that passes the cap', async (t) => {
  const { port } = await origin(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(Buffer.alloc(6));
    setImmediate(() => res.end(Buffer.alloc(6)));
  });
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  relay.maxBytes = 8;
  const outcome = await get(await relay.issue('https://media.example.test/a.mp3', 'song', 5_000)).catch((error) => error);
  assert.ok(outcome instanceof Error || outcome.body.length <= 8);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="song",result="too_large"}'), 1);
});

test('times out an origin that outlives the token deadline, and a refused connection is a network failure', async (t) => {
  const { port } = await origin(t, () => undefined);
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const response = await get(await relay.issue('https://media.example.test/slow.mp3', 'preflight', 50));
  assert.equal(response.status, 504);
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="preflight",result="timeout"}'), 1);

  const closed = new MediaRelay({ get: () => undefined });
  closed.deps = { ...relay.deps, request: (scheme, options) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: 1, lookup: undefined, servername: undefined }) };
  await closed.onModuleInit();
  t.after(() => closed.onModuleDestroy());
  assert.equal((await get(await closed.issue('https://media.example.test/a.mp3', 'filler', 5_000))).status, 502);
  assert.equal((await counts(closed)).get('palazzo_media_fetch_total{path="filler",result="network"}'), 1);
});

test('stops reading the origin when the tool hangs up, and an origin that breaks mid-answer counts as network', async (t) => {
  let originClosed;
  const gone = new Promise((resolve) => (originClosed = resolve));
  const { port } = await origin(t, (req, res) => {
    if (req.url === '/breaks') {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': '100' });
      res.write('abc');
      return setImmediate(() => res.socket.destroy());
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg' });
    res.write(Buffer.alloc(16));
    res.once('close', originClosed);
  });
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  // ffprobe hangs up once it has read what it needs: a successful read, and
  // the deadline must not later count it as a timeout.
  const url = await relay.issue('https://media.example.test/a.mp3', 'preflight', 200);
  await new Promise((resolve) => {
    const req = http.get(url, (res) => res.once('data', () => { req.destroy(); resolve(); }));
  });
  await gone;
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterHangUp = await counts(relay);
  assert.equal(afterHangUp.get('palazzo_media_fetch_total{path="preflight",result="ok"}'), 1);
  assert.equal(afterHangUp.get('palazzo_media_fetch_total{path="preflight",result="timeout"}'), 0);
  // A hang-up before any answer is a failed read.
  let release;
  const { port: slowPort } = await origin(t, (_req, res) => { release = () => res.destroy(); });
  const { relay: slow } = await relayFor(t, slowPort, { 'media.example.test': [PUBLIC] });
  const early = await slow.issue('https://media.example.test/a.mp3', 'preflight', 5_000);
  await new Promise((resolve) => {
    const req = http.get(early, () => undefined);
    req.on('error', () => undefined);
    setTimeout(() => { req.destroy(); resolve(); }, 50);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  release?.();
  assert.equal((await counts(slow)).get('palazzo_media_fetch_total{path="preflight",result="network"}'), 1);
  await get(await relay.issue('https://media.example.test/breaks', 'song', 5_000)).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="song",result="network"}'), 1);
});

test('no token, URL or host appears in the metrics, and every series starts at zero', async (t) => {
  const { port } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const fresh = await counts(relay);
  // 6 paths x 11 fetch results, plus one eviction series per path (#56).
  assert.equal(fresh.size, 6 * 11 + 6);
  assert.ok([...fresh.values()].every((value) => value === 0));
  const url = await relay.issue('https://media.example.test/a.mp3?sig=secret', 'song', 5_000);
  await get(url);
  const text = relay.renderMetrics();
  for (const leak of [/\/m\/([0-9a-f]{32})/.exec(url)[1], 'media.example.test', 'sig=secret', PUBLIC]) {
    assert.ok(!text.includes(leak), leak);
  }
});

test('the private-address allowance fails closed: honoured only when NODE_ENV says development or test', async (t) => {
  for (const environment of [undefined, '', 'production', 'staging', ' Production ', 'dev']) {
    assert.throws(
      () => new MediaRelay({ get: (key) => ({ PALAZZO_MEDIA_ALLOW_PRIVATE: 'true', NODE_ENV: environment })[key] }),
      /refused unless NODE_ENV is development or test/,
      String(environment),
    );
  }
  for (const environment of [undefined, 'production']) {
    assert.equal(new MediaRelay({ get: (key) => ({ NODE_ENV: environment })[key] }).allowPrivate, false);
  }
  assert.equal(new MediaRelay({ get: (key) => ({ PALAZZO_MEDIA_ALLOW_PRIVATE: 'true', NODE_ENV: 'development' })[key] }).allowPrivate, true);
  const { port } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'media.local': ['10.0.0.5'] }, { PALAZZO_MEDIA_ALLOW_PRIVATE: 'true', NODE_ENV: 'test' });
  assert.equal((await get(await relay.issue('http://media.local:8080/a.mp3', 'song', 5_000))).status, 200);
  assert.equal((await get(await relay.issue('http://127.0.0.1:8080/a.mp3', 'song', 5_000))).status, 200);
});

test('refuses to issue before it is started, and stops cleanly twice', async () => {
  const relay = new MediaRelay({ get: () => undefined });
  await assert.rejects(relay.issue('https://media.example.test/a.mp3', 'song', 1), /not started/);
  assert.equal(relay.address(), null);
  await relay.onModuleDestroy();
});

test('the pinned lookup answers only the checked address, single or all; the policy matches Alcantara', () => {
  const lookup = pinnedLookup({ address: PUBLIC, family: 4 });
  lookup('anything', {}, (error, address, family) => assert.deepEqual([error, address, family], [null, PUBLIC, 4]));
  lookup('anything', (error, address) => assert.equal(address, PUBLIC));
  lookup('anything', { all: true }, (error, all) => assert.deepEqual(all, [{ address: PUBLIC, family: 4 }]));
  assert.equal(isAudioMediaType('audio/mpeg'), true);
  assert.equal(isAudioMediaType('application/ogg'), true);
  assert.equal(isAudioMediaType('application/octet-stream'), true);
  assert.equal(isAudioMediaType('binary/octet-stream'), true);
  for (const refused of ['video/mp4', 'text/html', 'text/plain', 'application/json', 'image/png']) {
    assert.equal(isAudioMediaType(refused), false, refused);
  }
  for (const unsafe of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '::', '::1', 'fe80::1', 'fc00::1', 'fd00::1', 'ff02::1', '::ffff:10.0.0.1', '::ffff:a00:1', '64:ff9b::10.0.0.1', '64:ff9b::a00:1', '64:ff9b::zz', '::ffff:zz', '::1.2.3.4', '100::1', '2001:db8::1', '2001:10::1', '2001:2::1', 'not-an-address', '1.2.3']) {
    assert.equal(unsafeAddress(unsafe), true, unsafe);
  }
  for (const safe of [PUBLIC, '8.8.8.8', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(unsafeAddress(safe), false, safe);
  }
});

test('uses the system resolver by default: a local name is refused and an unknown one does not resolve', async (t) => {
  const relay = new MediaRelay({ get: () => undefined });
  await relay.onModuleInit();
  t.after(() => relay.onModuleDestroy());
  assert.equal((await get(await relay.issue('https://localhost/a.mp3', 'song', 5_000))).status, 502);
  assert.equal((await get(await relay.issue('https://palazzo-relay-test.invalid/a.mp3', 'song', 5_000))).status, 502);
  const metrics = await counts(relay);
  assert.ok(metrics.get('palazzo_media_fetch_total{path="song",result="address"}') >= 1);
  assert.ok(metrics.get('palazzo_media_fetch_total{path="song",result="dns"}') >= 1);
});

test('pins an IPv6 answer, refuses a content type that names no media type, and counts a transport that throws as network', async (t) => {
  const { port } = await origin(t, (req, res) => {
    res.writeHead(200, { 'content-type': req.url === '/semi' ? ';' : 'audio/mpeg' });
    res.end('x');
  });
  const { relay, pinned } = await relayFor(t, port, { 'v6.example.test': ['2606:4700::1111'] });
  assert.equal((await get(await relay.issue('https://v6.example.test/a.mp3', 'song', 5_000))).status, 200);
  assert.equal(pinned[0].address, '2606:4700::1111');
  assert.equal((await get(await relay.issue('https://v6.example.test/semi', 'song', 5_000))).status, 502);
  relay.deps = { ...relay.deps, request: () => { throw new Error('bad options'); } };
  assert.equal((await get(await relay.issue('https://v6.example.test/a.mp3', 'song', 5_000))).status, 502);
  const metrics = await counts(relay);
  assert.equal(metrics.get('palazzo_media_fetch_total{path="song",result="content_type"}'), 1);
  assert.equal(metrics.get('palazzo_media_fetch_total{path="song",result="network"}'), 1);
});

test('a lookup that outlives the deadline is a timeout and never connects', async (t) => {
  const { port, requests } = await origin(t, audio());
  const { relay } = await relayFor(t, port, {});
  let calls = 0;
  let answer;
  relay.deps = {
    ...relay.deps,
    // The check at issue answers at once; the relay's own check hangs.
    resolve: () => (++calls === 1 ? Promise.resolve([{ address: PUBLIC, family: 4 }]) : new Promise((resolve) => { answer = resolve; })),
  };
  const url = await relay.issue('https://media.example.test/a.mp3', 'preflight', 30);
  const pending = get(url);
  await new Promise((resolve) => setTimeout(resolve, 60));
  answer([{ address: PUBLIC, family: 4 }]);
  assert.equal((await pending).status, 504);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests.length, 0);
  assert.equal((await counts(relay)).get('palazzo_media_fetch_total{path="preflight",result="timeout"}'), 1);
});

test('waits for a slow reader instead of buffering the whole answer', async (t) => {
  const big = Buffer.alloc(4 * 1024 * 1024, 7);
  const { port } = await origin(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': big.length });
    res.end(big);
  });
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const url = await relay.issue('https://media.example.test/a.mp3', 'song', 10_000);
  const received = await new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.pause();
      let bytes = 0;
      setTimeout(() => {
        res.on('data', (chunk) => { bytes += chunk.length; });
        res.on('end', () => resolve(bytes));
        res.resume();
      }, 100);
    }).on('error', reject);
  });
  assert.equal(received, big.length);
});

test('#56: evicting a playout token at the limit warns once with the path kind and no URL, and is counted', async (t) => {
  const { port } = await origin(t, audio());
  const { relay } = await relayFor(t, port, { 'media.example.test': [PUBLIC] });
  const warnings = [];
  relay.logger = { warn: (message) => warnings.push(message), log() {}, error() {}, debug() {} };
  for (let i = 0; i < MAX_RELAY_TOKENS * 2; i += 1) await relay.issue('https://media.example.test/a.mp3', 'preflight', 60_000);
  assert.deepEqual(warnings, [], 'preflight eviction is routine and silent');
  for (let i = 0; i < MAX_RELAY_TOKENS; i += 1) await relay.issue('https://media.example.test/a.mp3', 'song', 60_000);
  await relay.issue('https://media.example.test/a.mp3', 'next', 60_000);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /evicted a song token at its 512-token limit/);
  assert.doesNotMatch(warnings[0], /media\.example\.test|https?:/);
  const samples = parseExposition(relay.renderMetrics());
  assertBoundedLabels(samples);
  assert.match(relay.renderMetrics(), /^palazzo_media_relay_evictions_total\{path="song"\} 1$/m);
  assert.match(relay.renderMetrics(), /^palazzo_media_relay_evictions_total\{path="preflight"\} [1-9]\d*$/m);
});
