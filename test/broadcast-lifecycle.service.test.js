const assert = require('node:assert/strict');
const test = require('node:test');
const {
  BroadcastLifecycleService,
} = require('../dist/stream/broadcast-lifecycle.service.js');

function playback(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: 'palazzo-test',
    bootId: 'boot',
    sequence: 1,
    availability: 'available',
    status: 'idle',
    liquidsoap: {
      running: true,
      connected: true,
      staleSince: null,
      lastSampleAt: new Date().toISOString(),
    },
    icecast: { connected: true },
    track: null,
    positionSeconds: 0,
    remainingSeconds: null,
    levels: {
      song: { rms: 0, peak: 0 },
      instant: { rms: 0, peak: 0 },
      output: { rms: 0, peak: 0 },
    },
    ...overrides,
  };
}

function fixture({ state = playback(), clearError, clearState, config = {} } = {}) {
  let currentState = state;
  let clears = 0;
  const telemetry = { getState: () => currentState };
  const stream = {
    clearProgramMaterial: async () => {
      clears += 1;
      if (clearError) throw clearError;
      currentState = clearState ?? playback();
    },
  };
  let activeVersion = null;
  const filler = {
    getActiveVersion: () => activeVersion,
    activate: async (version) => {
      if (version === 'missing') throw new Error('unprepared');
      if (activeVersion && activeVersion !== version) throw new Error('immutable');
      activeVersion = version;
    },
    deactivate: async () => { activeVersion = null; },
  };
  const values = {
    PROGRAM_ID: 'program-one',
    PALAZZO_INSTANCE_ID: 'palazzo-test',
    LIFECYCLE_TRANSITION_TIMEOUT_MS: '5',
    ...config,
  };
  const service = new BroadcastLifecycleService(
    { get: (key) => values[key] },
    stream,
    telemetry,
    filler,
  );
  return {
    service,
    get clears() {
      return clears;
    },
    setState: (next) => {
      currentState = next;
    },
  };
}

test('boots in reconciliation-required state without assuming prior success', () => {
  const { service } = fixture();
  const state = service.getState();

  assert.equal(state.requestedState, 'reconciliation-required');
  assert.equal(state.actualState, 'reconciliation-required');
  assert.equal(state.readiness, false);
});

test('lifecycle validates configuration and command identity before any queue effect', async () => {
  for (const config of [{ PROGRAM_ID: undefined }, { PROGRAM_ID: ' ' }, { LIFECYCLE_TRANSITION_TIMEOUT_MS: '0' }, { LIFECYCLE_TRANSITION_TIMEOUT_MS: '1.2' }]) {
    assert.throws(() => fixture({ config }), /required|positive integer/);
  }
  const context = fixture({ config: { PALAZZO_INSTANCE_ID: undefined } });
  assert.equal(context.service.getState().instanceId, 'palazzo');
  assert.throws(() => context.service.requireReady(), (error) => error.getStatus() === 409);
  for (const [key, sequence] of [[undefined, '1'], [' ', '1'], ['x'.repeat(201), '1'], ['key', undefined], ['key', '0'], ['key', '1.5']]) {
    await assert.rejects(context.service.stop(key, sequence), (error) => error.getStatus() === 400);
  }
  assert.equal(context.clears, 0);
});

test('a repeated playback command retains readiness and cannot interrupt a pending transition', async () => {
  const context = fixture({ config: { LIFECYCLE_TRANSITION_TIMEOUT_MS: '1000' } });
  context.service.startFromPlaybackCommand();
  const stamp = context.service.getState().timestamps.readyAt;
  context.service.startFromPlaybackCommand();
  assert.equal(context.service.getState().timestamps.readyAt, stamp);
  context.setState(playback({ icecast: { connected: false } }));
  const starting = context.service.start('not-ready', '1', 'v1');
  await new Promise(setImmediate);
  assert.equal(context.service.getState().transition, 'starting');
  assert.throws(() => context.service.startFromPlaybackCommand(), (error) => error.getStatus() === 409);
  context.setState(playback());
  assert.equal((await starting).readiness, true);
  const failed = fixture({ state: playback({ icecast: { connected: false } }) }).service;
  await assert.rejects(failed.start('not-ready', '1', 'v1'), (error) => error.getStatus() === 503);
  await assert.rejects(failed.start('not-ready', '1', 'v1'), (error) => error.getStatus() === 503 && error.getResponse().commandResult.duplicate);
});

test('Stop reports dependency degradation and refuses to claim idle when sound remains', async () => {
  const unavailable = playback({ icecast: { connected: false } });
  const context = fixture({ state: unavailable, clearState: unavailable });
  assert.equal(context.service.getState().actualState, 'degraded');
  const stopped = await context.service.stop('stop-degraded', '1');
  assert.equal(stopped.actualState, 'degraded');
  const audible = fixture({ clearState: playback({ status: 'playing', levels: { instant: { peak: 0.5 } } }) });
  await assert.rejects(audible.service.stop('not-idle', '1'), (error) => error.getStatus() === 503 && error.getResponse().actualState === 'failed');
  const instant = fixture({ clearState: playback({ levels: { instant: { peak: 0.5 } } }) });
  await assert.rejects(instant.service.stop('instant-not-idle', '1'), (error) => error.getStatus() === 503);
});

test('idempotency is bound to sequence and filler version and the bounded journal evicts oldest commands', async () => {
  const { service } = fixture();
  await service.start('start', '1', 'v1');
  await assert.rejects(service.start('start', '2', 'v1'), (error) => error.getStatus() === 409);
  await assert.rejects(service.start('start', '1', 'v2'), (error) => error.getStatus() === 409);
  for (let sequence = 2; sequence <= 258; sequence += 1) await service.stop(`stop-${sequence}`, String(sequence));
  const reused = await service.stop('stop-2', '259');
  assert.equal(reused.commandResult.duplicate, undefined);
  assert.equal(service.getState().lastSequence, 259);
});

test('a playback command starts healthy automation', () => {
  const { service } = fixture();

  service.startFromPlaybackCommand();
  const state = service.getState();

  assert.equal(state.requestedState, 'running');
  assert.equal(state.actualState, 'ready');
  assert.equal(state.readiness, true);
});

test('a playback command remains blocked when a dependency is unavailable', () => {
  const { service } = fixture({
    state: playback({
      liquidsoap: {
        running: true,
        connected: false,
        staleSince: 'now',
        lastSampleAt: new Date().toISOString(),
      },
    }),
  });

  assert.throws(
    () => service.startFromPlaybackCommand(),
    (error) => error.getStatus() === 409,
  );
});

test('starts empty automation when Liquidsoap, control, and Icecast are healthy', async () => {
  const { service } = fixture();
  const state = await service.start('start-one', '1', 'filler-v1');

  assert.equal(state.requestedState, 'running');
  assert.equal(state.actualState, 'ready');
  assert.equal(state.readiness, true);
  assert.equal(state.playback.status, 'idle');
  service.requireReady();
});

test('Start requires a prepared version and keeps the active session version immutable', async () => {
  const { service } = fixture();
  await assert.rejects(service.start('missing-header', '1'), (error) => {
    assert.equal(error.getStatus(), 400);
    return true;
  });
  await service.start('start-one', '1', 'filler-v1');
  await assert.rejects(service.start('start-two', '2', 'filler-v2'), (error) => {
    assert.equal(error.getStatus(), 409);
    return true;
  });
  assert.equal(service.getState().filler.activeVersion, 'filler-v1');
});

test('Stop flushes all program material while preserving transport readiness', async () => {
  const context = fixture();
  await context.service.start('start', '1', 'filler-v1');
  context.setState(
    playback({
      status: 'playing',
      track: { playbackRequestId: 'track', startedAt: 'now' },
      levels: {
        song: { rms: 0.2, peak: 0.5 },
        instant: { rms: 0.1, peak: 0.3 },
        output: { rms: 0.3, peak: 0.6 },
      },
    }),
  );

  const state = await context.service.stop('stop', '2');

  assert.equal(context.clears, 1);
  assert.equal(state.requestedState, 'stopped');
  assert.equal(state.actualState, 'stopped');
  assert.equal(state.dependencies.icecast, true);
});

test('duplicate commands do not repeat queue effects', async () => {
  const context = fixture();
  await context.service.start('start', '1', 'filler-v1');
  await context.service.stop('stop', '2');
  const duplicate = await context.service.stop('stop', '2');

  assert.equal(context.clears, 1);
  assert.equal(duplicate.commandResult.duplicate, true);
});

test('queue exhaustion does not convert a running automation into Stop', async () => {
  const { service } = fixture();
  await service.start('start', '1', 'filler-v1');

  const state = service.getState();
  assert.equal(state.playback.status, 'idle');
  assert.equal(state.requestedState, 'running');
  assert.equal(state.actualState, 'ready');
});

test('dependency failures remain distinguishable from an intentional Stop', async () => {
  const context = fixture();
  await context.service.start('start', '1', 'filler-v1');
  context.setState(
    playback({
      liquidsoap: {
        running: true,
        connected: false,
        staleSince: 'now',
        lastSampleAt: 'before',
      },
      icecast: { connected: false },
    }),
  );

  const state = context.service.getState();
  assert.equal(state.requestedState, 'running');
  assert.equal(state.actualState, 'degraded');
  assert.deepEqual(state.dependencies, {
    liquidsoap: true,
    control: false,
    icecast: false,
  });
});

test('Start never reports Ready when a required dependency is unavailable', async () => {
  const { service } = fixture({
    state: playback({ icecast: { connected: false } }),
  });

  await assert.rejects(service.start('start', '1', 'filler-v1'), (error) => {
    const response = error.getResponse();
    assert.equal(response.actualState, 'failed');
    assert.equal(response.readiness, false);
    assert.equal(response.dependencies.icecast, false);
    return true;
  });
});

test('failed queue clearing reports failure and never claims Stopped', async () => {
  const { service } = fixture({ clearError: new Error('private detail') });
  await service.start('start', '1', 'filler-v1');

  await assert.rejects(service.stop('stop', '2'), (error) => {
    assert.equal(error.getStatus(), 503);
    assert.equal(error.getResponse().actualState, 'failed');
    assert.equal(error.getResponse().readiness, false);
    assert.doesNotMatch(JSON.stringify(error.getResponse()), /private detail/);
    return true;
  });
});

test('rejects replayed sequences and key reuse for another action', async () => {
  const { service } = fixture();
  await service.start('same', '5', 'filler-v1');

  await assert.rejects(service.stop('other', '4'), (error) => {
    assert.match(error.getResponse().error, /not newer/);
    return true;
  });
  await assert.rejects(service.stop('same', '6'), (error) => {
    assert.match(error.getResponse().message, /already used/);
    return true;
  });
});

test('private control rejects the wrong single-program scope without credentials', () => {
  const state = playback();
  const values = {
    PROGRAM_ID: 'program-one',
    PALAZZO_INSTANCE_ID: 'palazzo-test',
  };
  const service = new BroadcastLifecycleService(
    { get: (key) => values[key] },
    { clearProgramMaterial: async () => undefined },
    { getState: () => state },
    { getActiveVersion: () => null, activate: async () => undefined, deactivate: async () => undefined },
  );
  assert.throws(
    () => service.assertProgram('wrong-program'),
    /program not found/,
  );
  service.assertProgram('program-one');
});
