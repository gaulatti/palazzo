const assert = require('node:assert/strict');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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

function fixture({ state = playback(), clearError } = {}) {
  let currentState = state;
  let clears = 0;
  const telemetry = { getState: () => currentState };
  const stream = {
    clearProgramMaterial: async () => {
      clears += 1;
      if (clearError) throw clearError;
      currentState = playback();
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

test('private authentication rejects missing credentials and wrong program scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palazzo-auth-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-control-token\n');
  const state = playback();
  const values = {
    PROGRAM_ID: 'program-one',
    PALAZZO_INSTANCE_ID: 'palazzo-test',
    PALAZZO_CONTROL_TOKEN_FILE: tokenFile,
  };
  const service = new BroadcastLifecycleService(
    { get: (key) => values[key] },
    { clearProgramMaterial: async () => undefined },
    { getState: () => state },
    { getActiveVersion: () => null, activate: async () => undefined, deactivate: async () => undefined },
  );
  try {
    await assert.rejects(service.authorize('program-one'), /unauthorized/);
    await assert.rejects(service.authorizeMachine(), /unauthorized/);
    await assert.rejects(
      service.authorizeMachine('Bearer wrong-control-token'),
      /unauthorized/,
    );
    await assert.rejects(
      service.authorize('wrong-program', 'Bearer test-control-token'),
      /program not found/,
    );
    await service.authorizeMachine('Bearer test-control-token');
    await service.authorize('program-one', 'Bearer test-control-token');
    assert.doesNotMatch(JSON.stringify(service.getState()), /test-control-token/);
  } finally {
    await rm(directory, { recursive: true });
  }
});
