const assert = require('node:assert/strict');
const test = require('node:test');
const { firstValueFrom, take, toArray } = require('rxjs');
const {
  PlaybackTelemetryService,
} = require('../dist/stream/playback-telemetry.service.js');
const {
  assertBoundedLabels,
  parseExposition,
} = require('./prometheus-exposition');

function service(overrides = {}) {
  const values = {
    PALAZZO_INSTANCE_ID: 'test-palazzo',
    PALAZZO_BUILD_VERSION: 'build-test',
    ...overrides,
  };
  return new PlaybackTelemetryService({
    get: (key) => values[key],
  });
}

function snapshot(overrides = {}) {
  return {
    liquidsoap_sequence: 1,
    playing: true,
    playback_request_id: 'request-1',
    title: 'Test title',
    artist: 'Test artist',
    cover_url: 'https://example.test/cover.jpg',
    url: 'https://example.test/audio.mp3',
    started_at: 1_700_000_000,
    elapsed: 2.5,
    remaining: 7.5,
    song_rms: 0.2,
    song_peak: 0.4,
    instant_rms: 0.1,
    instant_peak: 0.3,
    output_rms: 0.25,
    output_peak: 0.5,
    icecast_connected: true,
    sampled_at: 1_700_000_002.5,
    ...overrides,
  };
}

function lifecycle(sequence, event_type) {
  return {
    sequence,
    event_type,
    playback_request_id: 'request-1',
    title: 'Test title',
    artist: 'Test artist',
    cover_url: 'https://example.test/cover.jpg',
    url: 'https://example.test/audio.mp3',
    occurred_at: 1_700_000_000 + sequence,
  };
}

test('retains last-known playback through telemetry loss and ends only on engine evidence', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);

  assert.equal(telemetry.getState().status, 'playing');
  assert.equal(telemetry.getState().track.playbackRequestId, 'request-1');
  assert.equal(
    telemetry.getState().track.coverUrl,
    'https://example.test/cover.jpg',
  );

  telemetry.markDisconnected();
  assert.equal(telemetry.getState().status, 'playing');
  assert.equal(telemetry.getState().liquidsoap.connected, false);
  assert.ok(telemetry.getState().liquidsoap.staleSince);
  assert.equal(telemetry.getState().availability, 'degraded');

  telemetry.apply(
    snapshot({
      liquidsoap_sequence: 2,
      playing: false,
      song_rms: 0,
      song_peak: 0,
      instant_rms: 0,
      instant_peak: 0,
      output_rms: 0,
      output_peak: 0,
    }),
    [lifecycle(1, 'track_started'), lifecycle(2, 'track_ended')],
  );
  assert.equal(telemetry.getState().status, 'idle');
  assert.equal(telemetry.getState().track, null);
  assert.deepEqual(telemetry.getState().levels, {
    song: { rms: 0, peak: 0 },
    instant: { rms: 0, peak: 0 },
    output: { rms: 0, peak: 0 },
  });
});

test('starts every SSE connection with a snapshot and then replays after Last-Event-ID', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const replay = telemetry.replay;
  const started = replay.find((event) => event.type === 'track.started');

  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const events = await firstValueFrom(
    telemetry.subscribe(started.id).pipe(take(2), toArray()),
  );

  assert.equal(events[0].type, 'snapshot');
  assert.equal(events[0].id, started.id);
  assert.notEqual(events[1].id, started.id);
  assert.ok(events[1].sequence > events[0].sequence);
  assert.equal(
    (await telemetry.renderMetrics()).match(/event="started"} 1/g)?.length,
    1,
  );
});

test('uses stable instance and per-boot IDs with bounded metric labels', async () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const state = telemetry.getState();
  const metrics = await telemetry.renderMetrics();

  assert.equal(state.instanceId, 'test-palazzo');
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.icecast.connected, true);
  assert.match(state.bootId, /^[0-9a-f-]{36}$/);
  assert.match(metrics, /palazzo_audio_song_rms 0\.2/);
  assert.match(metrics, /palazzo_audio_instant_peak 0\.3/);
  assert.match(metrics, /palazzo_audio_output_peak 0\.5/);
  assert.doesNotMatch(metrics, /request-1|Test title|example\.test/);
  assert.match(metrics, /palazzo_icecast_output_connected 1/);
});

test('rebases lifecycle deduplication after a Liquidsoap sequence reset', async () => {
  const telemetry = service();
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 20 }),
    [lifecycle(20, 'track_started')],
  );
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 1 }),
    [lifecycle(1, 'track_started')],
  );

  assert.match(
    await telemetry.renderMetrics(),
    /palazzo_track_lifecycle_total\{event="started"\} 2/,
  );
});

test('bounds the replay journal under sustained level updates', async () => {
  const telemetry = service();
  for (let index = 0; index < 700; index += 1) {
    telemetry.emit('audio.levels', { index });
  }

  assert.equal(telemetry.replay.length, 512);
  assert.match(
    await telemetry.renderMetrics(),
    /palazzo_sse_replay_dropped_total\{type="levels"\} 188/,
  );
});

test('normalizes HTTP metric labels to a bounded route set', async () => {
  const telemetry = service();
  telemetry.observeHttp('get', '/playback/state', 200, 12);
  telemetry.observeHttp('get', '/devices/track-123', 404, 5);
  telemetry.observeHttp('private-method', '/private/track-123', 999, 5);
  const metrics = await telemetry.renderMetrics();

  assert.match(metrics, /route="\/playback\/state",status="2xx"/);
  assert.match(metrics, /route="unmatched",status="4xx"/);
  assert.match(metrics, /method="OTHER",route="unmatched",status="other"/);
  assert.doesNotMatch(metrics, /track-123|private-method/);
});

test('renders a parseable process, build, dependency, and retry baseline', async () => {
  const telemetry = service({
    PALAZZO_BUILD_VERSION: 'private build value with spaces',
  });
  telemetry.observeDependency('telemetry_poll', 'success');
  telemetry.observeDependency('telemetry_poll', 'parse_failure');
  telemetry.countReconnect();
  telemetry.countProcessRestart();
  const metrics = await telemetry.renderMetrics();
  const samples = parseExposition(metrics);
  assertBoundedLabels(samples);
  const names = new Set(samples.map((sample) => sample.name));

  assert.ok(names.has('palazzo_build_info'));
  assert.ok(names.has('palazzo_process_cpu_user_seconds_total'));
  assert.ok(names.has('palazzo_process_resident_memory_bytes'));
  assert.ok(names.has('palazzo_nodejs_eventloop_lag_seconds'));
  assert.ok(names.has('palazzo_dependency_operations_total'));
  assert.ok(names.has('palazzo_dependency_retries_total'));
  assert.match(metrics, /palazzo_build_info\{service="palazzo",version="unknown"\} 1/);
  assert.match(metrics, /operation="telemetry_poll",result="success"/);
  assert.match(metrics, /operation="telemetry_poll",result="parse_failure"/);
  assert.match(metrics, /operation="telnet_connect"\} 1/);
  assert.doesNotMatch(metrics, /private build value/);
});

test('uses a fresh snapshot instead of replay across process boots', async () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);

  const event = await firstValueFrom(telemetry.subscribe('old-boot:99'));

  assert.equal(event.type, 'snapshot');
  assert.equal(event.bootId, telemetry.bootId);
  assert.equal(event.data.state.sequence, telemetry.getState().sequence);
});

test('preserves lifecycle ordering after level replay pressure', () => {
  const telemetry = service();
  for (let index = 0; index < 700; index += 1) {
    telemetry.emit('audio.levels', { index });
  }
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 2, playing: false }),
    [lifecycle(1, 'track_started'), lifecycle(2, 'track_ended')],
  );

  const lifecycleTypes = telemetry.replay
    .filter((event) => event.type.startsWith('track.'))
    .map((event) => event.type);
  assert.deepEqual(lifecycleTypes, ['track.started', 'track.ended']);
});
