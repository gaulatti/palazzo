const assert = require('node:assert/strict');
const test = require('node:test');
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
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
    intro_playing: false,
    intro_playback_id: '',
    intro_parent_playback_id: '',
    intro_program_id: '',
    intro_request_id: '',
    intro_url: '',
    intro_started_at: 0,
    intro_rms: 0,
    intro_peak: 0,
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
    playback_id: 'request-1',
    parent_playback_id: '',
    program_id: 'program-one',
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
    intro: { rms: 0, peak: 0 },
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
    (await telemetry.renderMetrics()).match(
      /palazzo_track_lifecycle_total\{event="started"\} 1/g,
    )?.length,
    1,
  );
});

test('publishes correlated intro lifecycle and clears ended intro levels', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const intro = {
    ...lifecycle(2, 'intro_started'),
    playback_id: 'intro-1',
    parent_playback_id: 'request-1',
    program_id: 'program-one',
    url: 'https://example.test/intro.mp3',
  };
  telemetry.apply(
    snapshot({
      liquidsoap_sequence: 2,
      intro_playing: true,
      intro_playback_id: 'intro-1',
      intro_parent_playback_id: 'request-1',
      intro_program_id: 'program-one',
      intro_request_id: 'request-1',
      intro_url: 'https://example.test/intro.mp3',
      intro_started_at: 1_700_000_001,
      intro_rms: 0.2,
      intro_peak: 0.4,
    }),
    [lifecycle(1, 'track_started'), intro],
  );

  assert.equal(telemetry.getState().intro.playbackId, 'intro-1');
  assert.deepEqual(telemetry.getState().levels.intro, { rms: 0.2, peak: 0.4 });
  const started = telemetry.replay.find(
    (event) => event.type === 'intro.started',
  );
  assert.equal(started.data.parentPlaybackId, 'request-1');

  telemetry.apply(
    snapshot({
      liquidsoap_sequence: 3,
      intro_playing: false,
      intro_rms: 0.2,
      intro_peak: 0.4,
    }),
    [
      lifecycle(1, 'track_started'),
      intro,
      { ...intro, sequence: 3, event_type: 'intro_ended' },
    ],
  );
  assert.equal(telemetry.getState().intro, null);
  assert.deepEqual(telemetry.getState().levels.intro, { rms: 0, peak: 0 });
  assert.match(
    await telemetry.renderMetrics(),
    /palazzo_intro_lifecycle_total\{result="ended",reason="none"\} 1/,
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
  telemetry.apply(snapshot({ liquidsoap_sequence: 20 }), [
    lifecycle(20, 'track_started'),
  ]);
  telemetry.apply(snapshot({ liquidsoap_sequence: 1 }), [
    lifecycle(1, 'track_started'),
  ]);

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
  telemetry.observeHttp('get', '/v1/programs/:programId/playback/state', 200, 12);
  telemetry.observeHttp('get', '/devices/track-123', 404, 5);
  telemetry.observeHttp('private-method', '/private/track-123', 999, 5);
  const metrics = await telemetry.renderMetrics();

  assert.match(metrics, /route="\/v1\/programs\/:programId\/playback\/state",status="2xx"/);
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
  assert.ok(!names.has('palazzo_nodejs_active_handles'));
  assert.ok(!names.has('palazzo_nodejs_active_requests'));
  assert.ok(!names.has('palazzo_nodejs_active_resources'));
  assert.match(
    metrics,
    /palazzo_build_info\{service="palazzo",version="unknown"\} 1/,
  );
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
  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false }), [
    lifecycle(1, 'track_started'),
    lifecycle(2, 'track_ended'),
  ]);

  const lifecycleTypes = telemetry.replay
    .filter((event) => event.type.startsWith('track.'))
    .map((event) => event.type);
  assert.deepEqual(lifecycleTypes, ['track.started', 'track.ended']);
});

test('emits authoritative transition timestamps without media URLs', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  telemetry.expectTrackEnd('skipped');
  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false }), [
    lifecycle(1, 'track_started'),
    lifecycle(2, 'track_ended'),
  ]);
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 3, playback_request_id: 'request-2' }),
    [
      lifecycle(1, 'track_started'),
      lifecycle(2, 'track_ended'),
      {
        ...lifecycle(3, 'track_started'),
        playback_request_id: 'request-2',
        playback_id: 'request-2',
      },
    ],
  );

  const transitions = telemetry.replay.filter((event) =>
    event.type.startsWith('playout.'),
  );
  assert.deepEqual(
    transitions.map((event) => event.type),
    [
      'playout.started',
      'playout.skipped',
      'playout.started',
      'playout.transitioned',
    ],
  );
  assert.equal(
    transitions[0].occurredAt,
    new Date(1_700_000_001 * 1000).toISOString(),
  );
  assert.equal(
    transitions[1].occurredAt,
    new Date(1_700_000_002 * 1000).toISOString(),
  );
  assert.doesNotMatch(JSON.stringify(telemetry.replay), /https?:\/\//);
  const initial = await firstValueFrom(telemetry.subscribe());
  assert.doesNotMatch(JSON.stringify(initial), /https?:\/\//);
  const metrics = await telemetry.renderMetrics();
  assert.match(metrics, /event="transitioned"\} 1/);
  assertBoundedLabels(parseExposition(metrics));
});

test('keeps preflight metric outcomes and reasons bounded', async () => {
  const telemetry = service();
  const data = {
    programId: 'program-one',
    playbackId: 'playback-one',
    kind: 'song',
    checkedAt: '2026-09-06T12:00:00.000Z',
    expiresAt: '2026-09-06T12:05:00.000Z',
  };
  telemetry.reportPreflight('ready', 'none', data);
  telemetry.reportPreflight('reused', 'cache_hit', data);
  for (const reason of [
    'outside_lookahead',
    'missing',
    'unreachable',
    'timeout',
    'corrupt',
    'unsupported_media',
    'invalid_metadata',
  ]) {
    telemetry.reportPreflight('failed', reason, data);
  }

  assertBoundedLabels(parseExposition(await telemetry.renderMetrics()));
});

test('persists a sequence reservation so a restarted process exposes a detectable gap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'palazzo-events-'));
  const path = join(directory, 'sequence.json');
  const first = service({ PLAYBACK_EVENT_SEQUENCE_PATH: path });
  await first.initialize();
  first.reportPlayout(
    'queued',
    { playbackId: 'one' },
    '2026-09-06T12:00:00.000Z',
  );
  const lastSequence = first.getState().sequence;

  const restarted = service({ PLAYBACK_EVENT_SEQUENCE_PATH: path });
  await restarted.initialize();
  const snapshotEvent = await firstValueFrom(
    restarted.subscribe(`${first.bootId}:${lastSequence}`),
  );

  assert.equal(snapshotEvent.type, 'snapshot');
  assert.notEqual(snapshotEvent.bootId, first.bootId);
  assert.ok(snapshotEvent.sequence > lastSequence);
});

test('distinguishes operator stops from natural ends using engine timestamps', () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  telemetry.expectTrackEnd('stopped');
  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false }), [
    lifecycle(1, 'track_started'),
    lifecycle(2, 'track_ended'),
  ]);

  const stopped = telemetry.replay.find(
    (event) => event.type === 'playout.stopped',
  );
  assert.equal(stopped.data.reason, 'operator');
  assert.equal(
    stopped.occurredAt,
    new Date(1_700_000_002 * 1000).toISOString(),
  );
});

test('journal initialization rejects unreadable/corrupt and exhausted reservations and validates stored sequences', async (t) => {
  const { writeFile, rm } = require('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'palazzo-sequence-errors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [contents, expected] of [['{bad', /unavailable/], [JSON.stringify({ nextSequence: Number.MAX_SAFE_INTEGER }), /exhausted/]]) {
    const path = join(root, 'invalid.json');
    await writeFile(path, contents);
    const telemetry = service({ PLAYBACK_EVENT_SEQUENCE_PATH: path });
    await assert.rejects(telemetry.initialize(), expected);
    telemetry.shutdown();
  }
  const unreadable = service({ PLAYBACK_EVENT_SEQUENCE_PATH: root });
  await assert.rejects(unreadable.initialize(), /unavailable/);
  unreadable.shutdown();
  for (const nextSequence of ['1', 1.2, -1]) {
    const path = join(root, `value-${nextSequence}.json`);
    await writeFile(path, JSON.stringify({ nextSequence }));
    const telemetry = service({ PLAYBACK_EVENT_SEQUENCE_PATH: path });
    await telemetry.initialize();
    telemetry.reportPlayout('queued', {});
    assert.equal(telemetry.getState().sequence, 1);
    telemetry.shutdown();
  }
});

test('engine snapshots clear ended intros and normalize unavailable metadata and nonfinite levels', () => {
  const telemetry = service();
  telemetry.apply(snapshot({ intro_playing: true, intro_playback_id: 'intro', intro_started_at: 1 }), []);
  telemetry.apply(snapshot({ intro_playing: false, title: '', artist: '', cover_url: '', elapsed: NaN, remaining: -1, song_rms: NaN, song_peak: 5, instant_rms: -1, instant_peak: Infinity }), []);
  const state = telemetry.getState();
  assert.equal(state.intro, null);
  assert.equal(state.track.title, null);
  assert.equal(state.track.artist, null);
  assert.equal(state.track.coverUrl, null);
  assert.equal(state.positionSeconds, 0);
  assert.equal(state.remainingSeconds, null);
  assert.deepEqual(state.levels.song, { rms: 0, peak: 1 });
  assert.deepEqual(state.levels.instant, { rms: 0, peak: 0 });
  telemetry.shutdown();
});

test('lifecycle handles missing optional metadata, unrelated endings and nonadjacent engine timestamps', () => {
  const telemetry = service();
  const event = (sequence, type, occurred_at) => ({ ...lifecycle(sequence, type), playback_id: '', title: '', artist: '', cover_url: '', occurred_at });
  telemetry.apply(snapshot({ liquidsoap_sequence: 1 }), [event(1, 'track_started', 100)]);
  telemetry.expectTrackEnd('stopped');
  telemetry.cancelExpectedTrackEnd();
  telemetry.apply(snapshot({ liquidsoap_sequence: 2 }), [{ ...event(2, 'track_ended', 110), playback_request_id: 'other' }]);
  assert.equal(telemetry.replay.findLast((e) => e.type === 'playout.stopped').data.reason, 'natural_end');
  telemetry.apply(snapshot({ liquidsoap_sequence: 3 }), [event(3, 'track_started', 90)]);
  telemetry.apply(snapshot({ liquidsoap_sequence: 4 }), [event(4, 'track_ended', 100)]);
  telemetry.apply(snapshot({ liquidsoap_sequence: 5 }), [event(5, 'track_started', 140)]);
  assert.equal(telemetry.replay.filter((e) => e.type === 'playout.transitioned').length, 0);
  telemetry.apply(snapshot({ liquidsoap_sequence: 6, playing: false }), [event(6, 'intro_ended', 150)]);
  assert.equal(telemetry.getState().track, null);
  telemetry.shutdown();
});

test('replay evicts non-level events and sanitizes nested objects and arrays without losing public values', async () => {
  const telemetry = service();
  for (let index = 0; index < 700; index += 1) telemetry.reportPlayout('queued', { index });
  telemetry.reportPlayout('queued', { nested: [null, 'ok', { token: 'private', url: 'private', safe: 4 }], value: null });
  assert.deepEqual(telemetry.replay.at(-1).data, { nested: [null, 'ok', { safe: 4 }], value: null });
  assert.match(await telemetry.renderMetrics(), /replay_dropped_total\{type="other"\} [1-9]/);
  assert.ok(telemetry.replay.length <= 512);
  telemetry.shutdown();
});

test('legacy engine IDs remain correlated through skips and the next transition', () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [{ ...lifecycle(1, 'track_started'), playback_id: '' }]);
  telemetry.expectTrackEnd('skipped');
  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false }), [{ ...lifecycle(2, 'track_ended'), playback_id: '' }]);
  telemetry.apply(snapshot({ liquidsoap_sequence: 3 }), [{ ...lifecycle(3, 'track_started'), playback_id: '' }]);
  assert.equal(telemetry.replay.findLast((e) => e.type === 'playout.skipped').data.playbackId, 'request-1');
  assert.equal(telemetry.replay.findLast((e) => e.type === 'playout.transitioned').data.toPlaybackId, 'request-1');
  telemetry.shutdown();
});

test('exhausted event reservations refuse to emit beyond the durable sequence ceiling', () => {
  const telemetry = service();
  // Reachable after one reserved billion-event range; set the precondition
  // directly rather than generating a billion events in a unit test.
  telemetry.sequence = telemetry.sequenceCeiling;
  const before = telemetry.replay.length;
  assert.throws(() => telemetry.reportPlayout('queued', {}), /reservation is exhausted/);
  assert.equal(telemetry.replay.length, before);
  assert.equal(telemetry.getState().sequence, telemetry.sequenceCeiling);
  telemetry.shutdown();
});
