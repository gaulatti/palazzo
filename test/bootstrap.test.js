const assert = require('node:assert/strict');
const { fork, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');

test('startup refuses an absent HTTP port before starting the application', () => {
  const result = spawnSync(process.execPath, ['dist/main.js'], {
    env: { ...process.env, PALAZZO_PORT: '' }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /PALAZZO_PORT env var is required/);
});

for (const allowed of [undefined, ' https://desk.example.test, ,https://other.example.test ']) {
  test(`real bootstrap applies ${allowed ? 'configured' : 'default'} CORS policy and module wiring`, { timeout: 15000 }, async (t) => {
    const env = { ...process.env, PALAZZO_PORT: '3100', PROGRAM_ID: 'bootstrap-fixture' };
    if (allowed === undefined) delete env.ALLOWED_ORIGINS;
    else env.ALLOWED_ORIGINS = allowed;
    const child = fork('test/bootstrap-runner.cjs', { env, silent: true, execArgv: [] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.resume();
    t.after(async () => {
      if (child.exitCode !== null) return;
      const exited = once(child, 'exit');
      child.send('close');
      const timer = setTimeout(() => child.kill(), 3000);
      const [code] = await exited;
      clearTimeout(timer);
      assert.equal(code, 0, stderr);
    });
    const [{ origin: listenOrigin }] = await Promise.race([
      once(child, 'message'),
      once(child, 'exit').then(([code]) => { throw new Error(`startup exited ${code}: ${stderr}`); }),
    ]);
    const address = new URL(listenOrigin);
    assert.equal(address.hostname, '0.0.0.0');
    address.hostname = '127.0.0.1';
    const origin = address.origin;
    for (const corsOrigin of [undefined, 'null', 'http://localhost:5173', 'https://127.0.0.1', ...(allowed ? ['https://desk.example.test', 'https://other.example.test'] : [])]) {
      const response = await fetch(origin + '/v1/programs/bootstrap-fixture/playback/state', {
        headers: corsOrigin === undefined ? {} : { Origin: corsOrigin },
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).schemaVersion, 1);
      if (corsOrigin !== undefined) assert.equal(response.headers.get('access-control-allow-origin'), corsOrigin);
    }
    for (const corsOrigin of ['https://untrusted.example.test', 'http://localhost.evil.test']) {
      const response = await fetch(origin + '/v1/programs/bootstrap-fixture/playback/state', { headers: { Origin: corsOrigin } });
      assert.equal(response.status, 500);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      await response.text();
    }
    for (const [method, path] of [['GET', '/status'], ['POST', '/song'], ['POST', '/song/stop'], ['POST', '/instant'], ['POST', '/instant/stop'], ['GET', '/mixer'], ['PUT', '/mixer'], ['GET', '/playback/state'], ['GET', '/playback/events']]) {
      const removed = await fetch(origin + path, { method, redirect: 'manual' });
      assert.equal(removed.status, 404, `${method} ${path}`);
      assert.equal(removed.headers.get('location'), null);
      assert.equal((await removed.json()).message, `Cannot ${method} ${path}`);
    }
    const preflight = await fetch(origin + '/v1/programs/bootstrap-fixture/automation/start', {
      method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'Idempotency-Key,X-Command-Sequence' },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-headers'), /Idempotency-Key/);
  });
}
