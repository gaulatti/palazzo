const assert = require('node:assert/strict');
const test = require('node:test');
const { firstValueFrom } = require('rxjs');
const {
  PlaybackTelemetryService,
} = require('../dist/stream/playback-telemetry.service.js');

function service() {
  return new PlaybackTelemetryService({
    get: (key) => (key === 'PALAZZO_INSTANCE_ID' ? 'test-palazzo' : undefined),
  });
}

function snapshot(overrides = {}) {
  return {
    liquidsoap_sequence: 1,
    playing: true,
    playback_request_id: 'request-1',
    title: 'Test title',
    artist: 'Test artist',
    url: 'https://example.test/audio.mp3',
    started_at: 1_700_000_000,
    elapsed: 2.5,
    remaining: 7.5,
    rms: 0.2,
    peak: 0.4,
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
    url: 'https://example.test/audio.mp3',
    occurred_at: 1_700_000_000 + sequence,
  };
}

test('retains last-known playback through telemetry loss and ends only on engine evidence', () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);

  assert.equal(telemetry.getState().status, 'playing');
  assert.equal(telemetry.getState().track.playbackRequestId, 'request-1');

  telemetry.markDisconnected();
  assert.equal(telemetry.getState().status, 'playing');
  assert.equal(telemetry.getState().telemetry.connected, false);
  assert.ok(telemetry.getState().telemetry.staleSince);

  telemetry.apply(
    snapshot({ liquidsoap_sequence: 2, playing: false, rms: 0, peak: 0 }),
    [lifecycle(1, 'track_started'), lifecycle(2, 'track_ended')],
  );
  assert.equal(telemetry.getState().status, 'idle');
  assert.equal(telemetry.getState().track, null);
  assert.deepEqual(telemetry.getState().levels, { rms: 0, peak: 0 });
});

test('deduplicates Liquidsoap events and replays after Last-Event-ID', async () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const replay = telemetry.replay;
  const started = replay.find((event) => event.type === 'track.started');

  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const next = firstValueFrom(telemetry.subscribe(started.id));
  const event = await next;

  assert.notEqual(event.id, started.id);
  assert.equal(
    telemetry.renderMetrics().match(/event="started"} 1/g)?.length,
    1,
  );
});

test('uses stable instance and per-boot IDs with bounded metric labels', () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const state = telemetry.getState();
  const metrics = telemetry.renderMetrics();

  assert.equal(state.instanceId, 'test-palazzo');
  assert.match(state.bootId, /^[0-9a-f-]{36}$/);
  assert.match(metrics, /palazzo_audio_rms 0\.2/);
  assert.doesNotMatch(metrics, /request-1|Test title|example\.test/);
});

test('rebases lifecycle deduplication after a Liquidsoap sequence reset', () => {
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
    telemetry.renderMetrics(),
    /palazzo_track_lifecycle_total\{event="started"\} 2/,
  );
});

test('bounds the replay journal under sustained level updates', () => {
  const telemetry = service();
  for (let index = 0; index < 700; index += 1) {
    telemetry.apply(snapshot({ elapsed: index / 10 }), []);
  }

  assert.equal(telemetry.replay.length, 512);
});
