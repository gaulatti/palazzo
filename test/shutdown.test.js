const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { installShutdownHandlers, SHUTDOWN_GRACE_MS } = require('../dist/shutdown');

function fakeProcess() {
  const handlers = new Map();
  return { once: (signal, listener) => handlers.set(signal, listener), handlers };
}

test('SIGTERM and SIGINT are handled, and a handled signal closes the application then exits 0', async () => {
  const target = fakeProcess();
  const calls = [];
  const shutdown = installShutdownHandlers(
    { close: async () => { calls.push('close'); } },
    { process: target, exit: (code) => calls.push(`exit ${code}`), log: () => {} },
  );
  assert.deepEqual([...target.handlers.keys()].sort(), ['SIGINT', 'SIGTERM']);
  target.handlers.get('SIGTERM')();
  await shutdown('SIGTERM');
  assert.deepEqual(calls, ['close', 'exit 0']);
});

test('the shutdown runs once however many signals arrive', async () => {
  const target = fakeProcess();
  let closes = 0;
  const exits = [];
  const shutdown = installShutdownHandlers(
    { close: async () => { closes += 1; } },
    { process: target, exit: (code) => exits.push(code), log: () => {} },
  );
  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);
  assert.equal(closes, 1);
  assert.deepEqual(exits, [0]);
});

test('a close that never finishes exits with 1 once the grace has passed', async () => {
  const exits = [];
  const logs = [];
  installShutdownHandlers(
    { close: () => new Promise(() => {}) },
    { process: fakeProcess(), graceMs: 30, exit: (code) => exits.push(code), log: (message) => logs.push(message) },
  )('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(exits, [1]);
  assert.match(logs.join('\n'), /did not finish within 30 ms/);
});

test('a close that fails exits with 1 and says why', async () => {
  const exits = [];
  const logs = [];
  await installShutdownHandlers(
    { close: async () => { throw new Error('boom'); } },
    { process: fakeProcess(), exit: (code) => exits.push(code), log: (message) => logs.push(message) },
  )('SIGTERM');
  assert.deepEqual(exits, [1]);
  assert.match(logs.join('\n'), /shutdown failed: boom/);
});

test('a non-error rejection is reported too', async () => {
  const logs = [];
  await installShutdownHandlers(
    { close: async () => { throw 'plain'; } },
    { process: fakeProcess(), exit: () => {}, log: (message) => logs.push(message) },
  )('SIGTERM');
  assert.match(logs.join('\n'), /shutdown failed: plain/);
});

test('the default grace leaves room inside the ten seconds Docker allows', () => {
  assert.ok(SHUTDOWN_GRACE_MS > 0 && SHUTDOWN_GRACE_MS < 10_000);
});

for (const [mode, expected, label] of [['clean', 0, 'a real SIGTERM ends a real process with 0 well inside the Docker grace'], ['hang', 1, 'a real SIGTERM with a hung close still ends the process with 1 after the grace']]) {
  test(label, { timeout: 8000 }, async () => {
    const child = fork('test/shutdown-runner.cjs', [mode], { silent: true, execArgv: [] });
    await once(child, 'message');
    const started = Date.now();
    child.kill('SIGTERM');
    const [code] = await once(child, 'exit');
    assert.equal(code, expected);
    assert.ok(Date.now() - started < 3000, 'exited within 3 s');
  });
}
