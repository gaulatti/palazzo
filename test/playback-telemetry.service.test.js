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
  // palazzo#41: Liquidsoap journalled track_skipped for this playback.
  telemetry.recordEndReason('request-1', 'replacement');
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
  // palazzo#41: Liquidsoap journalled track_skipped for this playback.
  telemetry.recordEndReason('request-1', 'operator');
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
  // palazzo#41: a reason journalled then cancelled by a failed command.
  telemetry.recordEndReason('request-1', 'operator');
  telemetry.recordEndReason('request-1', 'cancel');
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
  // palazzo#41: Liquidsoap journalled track_skipped for this playback.
  telemetry.recordEndReason('request-1', 'replacement');
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

test('reports whether the live input is on the air (gaulatti/palazzo#48)', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  assert.deepEqual(telemetry.getState().live, { onAir: false });

  telemetry.apply(snapshot({ playing: false, live_on_air: true }), []);
  assert.equal(telemetry.getState().status, 'idle');
  assert.deepEqual(telemetry.getState().live, { onAir: true });

  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false, live_on_air: false }), []);
  assert.deepEqual(telemetry.getState().live, { onAir: false });

  // A snapshot without the field (an older script) never reports live.
  const { live_on_air: _omitted, ...older } = snapshot({ liquidsoap_sequence: 3, playing: false });
  telemetry.apply(older, []);
  assert.deepEqual(telemetry.getState().live, { onAir: false });
});

// gaulatti/palazzo#49: the silence at each song change, on Liquidsoap's clock, by how the next song came.
test('measures the gap at each song change by handoff, counting an announced start under the end as no gap', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const event = (sequence, type, id, occurred_at) => ({
    ...lifecycle(sequence, type),
    playback_request_id: id,
    playback_id: id,
    occurred_at,
  });
  const journal = [];
  const step = (...events) => {
    journal.push(...events);
    telemetry.apply(snapshot({ liquidsoap_sequence: journal.length }), [...journal]);
  };
  const gaps = async () => {
    const samples = parseExposition(await telemetry.renderMetrics());
    assertBoundedLabels(samples);
    const value = (name, labels = {}) =>
      samples.find(
        (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
      )?.value;
    return { value };
  };
  // Before any change: empty histograms, no last-gap sample.
  let read = await gaps();
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'command' }), 0);
  assert.equal(read.value('palazzo_song_change_last_gap_seconds'), undefined);

  step(event(1, 'track_started', 'song-a', 1_000));
  // A song command after the end: 9.2 s of silence (the bumper path of gaulatti/palazzo#49).
  step(event(2, 'track_ended', 'song-a', 1_200));
  step(event(3, 'track_started', 'song-b', 1_209.2));
  read = await gaps();
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'command' }), 1);
  assert.equal(read.value('palazzo_song_change_gap_seconds_sum', { handoff: 'command' }), 9.2);
  assert.equal(read.value('palazzo_song_change_gap_seconds_bucket', { handoff: 'command', le: '8' }), 0);
  assert.equal(read.value('palazzo_song_change_gap_seconds_bucket', { handoff: 'command', le: '10' }), 1);
  assert.equal(read.value('palazzo_song_change_gap_seconds_bucket', { handoff: 'command', le: '+Inf' }), 1);
  assert.equal(read.value('palazzo_song_change_last_gap_seconds'), 9.2);

  // An announced song that starts under the end of the playing one: no gap.
  telemetry.reportNextQueued('program-one', 'song-c');
  step(event(4, 'track_started', 'song-c', 1_400));
  step(event(5, 'track_ended', 'song-b', 1_401));
  read = await gaps();
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'announced' }), 1);
  assert.equal(read.value('palazzo_song_change_gap_seconds_bucket', { handoff: 'announced', le: '0' }), 1);
  assert.equal(read.value('palazzo_song_change_last_gap_seconds'), 0);

  // An announced song that starts just after the end (gate at remaining 0).
  telemetry.reportNextQueued('program-one', 'song-d');
  step(event(6, 'track_ended', 'song-c', 1_600));
  step(event(7, 'track_started', 'song-d', 1_600.1));
  read = await gaps();
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'announced' }), 2);
  assert.equal(read.value('palazzo_song_change_gap_seconds_bucket', { handoff: 'announced', le: '0.25' }), 2);
  assert.equal(read.value('palazzo_song_change_last_gap_seconds'), 0.1);

  // A start more than 30 s after the end is not a song change (the filler, a stop): not counted.
  step(event(8, 'track_ended', 'song-d', 1_800));
  step(event(9, 'track_started', 'song-e', 1_845));
  read = await gaps();
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'command' }), 1);
  assert.equal(read.value('palazzo_song_change_gap_seconds_count', { handoff: 'announced' }), 2);
});

// gaulatti/palazzo#49 (review): a journalled spot between two songs is not silence, an unknown journal event
// never ends a song, and a song command is never labelled announced.
test('subtracts journalled spot time from the gap, ignores unknown journal events, and labels a command as a command', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const event = (sequence, type, id, occurred_at) => ({
    ...lifecycle(sequence, type),
    playback_request_id: id,
    playback_id: id,
    occurred_at,
  });
  const journal = [];
  const step = (...events) => {
    journal.push(...events);
    telemetry.apply(snapshot({ liquidsoap_sequence: journal.length }), [...journal]);
  };
  const value = async (name, labels = {}) => {
    const samples = parseExposition(await telemetry.renderMetrics());
    assertBoundedLabels(samples);
    return samples.find(
      (s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )?.value;
  };

  step(event(1, 'track_started', 'song-a', 2_000));
  // A spot fired by hand during the song is not part of any change.
  step(event(2, 'instant_started', 'spot-0', 2_010), event(3, 'instant_ended', 'spot-0', 2_015));
  // The bumper change of today: the song ends, a 5.6 s spot, silence, then the song by command 9.2 s after the end.
  step(event(4, 'track_ended', 'song-a', 2_100));
  // A snapshot while the spot is on air measures it on the instants bus (the default snapshot's level).
  step(event(5, 'instant_started', 'spot-1', 2_100.3));
  step(event(6, 'instant_ended', 'spot-1', 2_105.9));
  step(event(7, 'track_started', 'song-b', 2_109.2));
  assert.equal(await value('palazzo_song_change_last_gap_seconds'), 3.6);
  assert.equal(await value('palazzo_song_change_gap_seconds_sum', { handoff: 'command' }), 3.6);

  // A spot still on air when the next song starts counts up to the start.
  step(event(8, 'track_ended', 'song-b', 2_300));
  step(event(9, 'instant_started', 'spot-2', 2_300.1));
  step(event(10, 'track_started', 'song-c', 2_305.1));
  assert.equal(await value('palazzo_song_change_last_gap_seconds'), 0.1);
  step(event(11, 'instant_ended', 'spot-2', 2_306));

  // An event type this Palazzo does not know is ignored: it neither ends the song nor counts as a change.
  step({ ...event(12, 'some_future_event', 'song-c', 2_350) });
  assert.equal(telemetry.getState().status, 'playing');
  assert.equal(await value('palazzo_track_lifecycle_total', { event: 'ended' }), 2);

  // Announced, then a song command carrying the announced playback id: the change is a command.
  telemetry.reportNextQueued('program-one', 'song-d');
  telemetry.forgetAnnouncement();
  step(event(13, 'track_ended', 'song-c', 2_500));
  step(event(14, 'track_started', 'song-d', 2_501));
  assert.equal(await value('palazzo_song_change_gap_seconds_count', { handoff: 'announced' }), 0);
  assert.equal(await value('palazzo_song_change_gap_seconds_count', { handoff: 'command' }), 3);

  // The instant events reach SSE without a URL.
  const instants = telemetry.replay.filter((e) => e.type.startsWith('instant.'));
  assert.deepEqual(instants.map((e) => [e.type, e.data.playbackId]), [
    ['instant.started', 'spot-0'],
    ['instant.ended', 'spot-0'],
    ['instant.started', 'spot-1'],
    ['instant.ended', 'spot-1'],
    ['instant.started', 'spot-2'],
    ['instant.ended', 'spot-2'],
  ]);
  assert.doesNotMatch(JSON.stringify(instants), /https?:\/\//);
});

test('relays an instant journalled with only its request id and no program, and an end with no start', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot({ liquidsoap_sequence: 2 }), [
    { ...lifecycle(1, 'instant_ended'), playback_request_id: 'spot-x', playback_id: '', program_id: '' },
    { ...lifecycle(2, 'instant_started'), playback_request_id: 'spot-y', playback_id: '', program_id: '' },
  ]);
  const instants = telemetry.replay.filter((e) => e.type.startsWith('instant.'));
  assert.deepEqual(instants.map((e) => [e.type, e.data.playbackId, e.data.programId]), [
    ['instant.ended', 'spot-x', null],
    ['instant.started', 'spot-y', null],
  ]);
});

// gaulatti/palazzo#50: Liquidsoap's bumper results are counted, and a song started after an announced
// spot is a `bumper` change whose gap excludes the spot.
test('counts bumper results and measures a change after an announced spot without the spot', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const event = (sequence, type, id, occurred_at, extra = {}) => ({
    ...lifecycle(sequence, type),
    playback_request_id: id,
    playback_id: id,
    occurred_at,
    ...extra,
  });
  const journal = [];
  const step = (...events) => {
    journal.push(...events);
    telemetry.apply(snapshot({ liquidsoap_sequence: journal.length }), [...journal]);
  };
  step(event(1, 'track_started', 'song-a', 3_000));
  telemetry.reportNextQueued('program-one', 'song-b', true);
  step(event(2, 'track_ended', 'song-a', 3_100));
  step(event(3, 'instant_started', 'spot-1', 3_100.02), event(4, 'bumper_result', 'spot-1', 3_100.02, { reason: 'played' }));
  step(event(5, 'instant_ended', 'spot-1', 3_105.62), event(6, 'track_started', 'song-b', 3_105.66));
  step(event(7, 'bumper_result', 'spot-2', 3_200, { reason: 'dropped_late' }));
  step(event(8, 'bumper_result', 'spot-3', 3_201, { reason: 'something_else' }));
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  const value = (name, labels) =>
    samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
  assert.equal(value('palazzo_next_bumper_total', { result: 'played' }), 1);
  assert.equal(value('palazzo_next_bumper_total', { result: 'dropped_late' }), 1);
  assert.equal(value('palazzo_next_bumper_total', { result: 'dropped_failed' }), 0);
  assert.equal(value('palazzo_song_change_gap_seconds_count', { handoff: 'bumper' }), 1);
  assert.equal(value('palazzo_song_change_gap_seconds_bucket', { handoff: 'bumper', le: '0.25' }), 1);
  telemetry.observeBumper('dropped_unresolved');
  assert.match(await telemetry.renderMetrics(), /palazzo_next_bumper_total\{result="dropped_unresolved"\} 1/);
});

// gaulatti/palazzo#53: a spot journalled as played but silent on the instants bus is silence, not spot time.
test('subtracts a spot only when the instants bus measured it above -50 dBFS', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const event = (sequence, type, id, occurred_at) => ({
    ...lifecycle(sequence, type),
    playback_request_id: id,
    playback_id: id,
    occurred_at,
  });
  const journal = [];
  const step = (levels, ...events) => {
    journal.push(...events);
    telemetry.apply(snapshot({ liquidsoap_sequence: journal.length, ...levels }), [...journal]);
  };
  const last = async () =>
    parseExposition(await telemetry.renderMetrics()).find((s) => s.name === 'palazzo_song_change_last_gap_seconds')?.value;
  const silent = { instant_rms: 0, instant_peak: 0.001 };
  step(silent, event(1, 'track_started', 'song-a', 4_000));
  step(silent, event(2, 'track_ended', 'song-a', 4_100));
  // The spot is on air for 5.6 s but the instants bus never rises above -50 dBFS.
  step(silent, event(3, 'instant_started', 'spot-1', 4_100.1));
  step(silent, event(4, 'instant_ended', 'spot-1', 4_105.7));
  step(silent, event(5, 'track_started', 'song-b', 4_105.8));
  assert.equal(await last(), 5.8);
  // The same change with the spot heard: only the 0.2 s around it is silence.
  step(silent, event(6, 'track_ended', 'song-b', 4_300));
  step(silent, event(7, 'instant_started', 'spot-2', 4_300.1));
  step({ instant_rms: 0.17, instant_peak: 0.69 });
  step(silent, event(8, 'instant_ended', 'spot-2', 4_305.7));
  step(silent, event(9, 'track_started', 'song-c', 4_305.8));
  assert.equal(await last(), 0.2);
});

// gaulatti/palazzo#53: cue edges trimmed, and edges over the bound not applied, are counted per edge.
test('counts trimmed and ignored cue edges per edge with bounded labels', async () => {
  const telemetry = service();
  telemetry.observeSongTrim('tail', 2.4);
  telemetry.observeSongTrim('head', 0.8);
  telemetry.observeSongTrim('tail', 9.5);
  telemetry.observeCueIgnored('tail');
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  const value = (name, labels) =>
    samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
  assert.equal(value('palazzo_song_trimmed_seconds_count', { edge: 'tail' }), 2);
  assert.equal(value('palazzo_song_trimmed_seconds_bucket', { edge: 'tail', le: '3' }), 1);
  assert.equal(value('palazzo_song_trimmed_seconds_bucket', { edge: 'tail', le: '10' }), 2);
  assert.equal(value('palazzo_song_trimmed_seconds_count', { edge: 'head' }), 1);
  assert.equal(value('palazzo_song_cue_ignored_total', { edge: 'tail', reason: 'bound' }), 1);
  assert.equal(value('palazzo_song_cue_ignored_total', { edge: 'head', reason: 'bound' }), 0);
});

// gaulatti/palazzo#51: Liquidsoap clears its playing song in an asynchronous end hook, so a snapshot just
// after a journalled end can still name the ended song. The state never names a track whose end is
// journalled.
function lifecycleOf(sequence, event_type, id) {
  return { ...lifecycle(sequence, event_type), playback_request_id: id, playback_id: id };
}

test('never reports a track as playing after its end is journalled, in the same poll or a later one', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 2, playback_request_id: 'song-a' }),
    [lifecycleOf(1, 'track_started', 'song-a'), lifecycleOf(2, 'track_ended', 'song-a')],
  );
  let state = telemetry.getState();
  assert.equal(state.status, 'idle');
  assert.equal(state.track, null);
  assert.equal(state.positionSeconds, 0);
  assert.equal(state.remainingSeconds, null);

  // A later poll whose snapshot still lags behind the end.
  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playback_request_id: 'song-a' }), []);
  assert.equal(telemetry.getState().track, null);

  // The next song plays as before.
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 3, playback_request_id: 'song-b' }),
    [lifecycleOf(3, 'track_started', 'song-b')],
  );
  state = telemetry.getState();
  assert.equal(state.status, 'playing');
  assert.equal(state.track.playbackRequestId, 'song-b');
});

test('keeps the next song under an overlap when a lagging snapshot still names the ended one', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 1, playback_request_id: 'song-a' }),
    [lifecycleOf(1, 'track_started', 'song-a')],
  );
  // B starts under A's end; A's end is journalled; the snapshot still names A.
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 3, playback_request_id: 'song-a' }),
    [lifecycleOf(2, 'track_started', 'song-b'), lifecycleOf(3, 'track_ended', 'song-a')],
  );
  const state = telemetry.getState();
  assert.equal(state.status, 'playing');
  assert.equal(state.track.playbackRequestId, 'song-b');
});

test('a new start of an ended id plays again, and only the most recent ended ids are remembered', () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 2, playback_request_id: 'song-a' }),
    [lifecycleOf(1, 'track_started', 'song-a'), lifecycleOf(2, 'track_ended', 'song-a')],
  );
  assert.equal(telemetry.getState().track, null);
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 3, playback_request_id: 'song-a' }),
    [lifecycleOf(3, 'track_started', 'song-a')],
  );
  assert.equal(telemetry.getState().track.playbackRequestId, 'song-a');

  // Sixteen more ended songs push song-old out of the bounded set; a snapshot naming it is read as is.
  let sequence = 3;
  const ended = (id) => {
    sequence += 2;
    telemetry.apply(snapshot({ liquidsoap_sequence: sequence, playing: false }), [
      lifecycleOf(sequence - 1, 'track_started', id),
      lifecycleOf(sequence, 'track_ended', id),
    ]);
  };
  ended('song-old');
  for (let i = 0; i < 16; i += 1) ended(`song-${i}`);
  telemetry.apply(snapshot({ liquidsoap_sequence: sequence, playback_request_id: 'song-15' }), []);
  assert.equal(telemetry.getState().track, null);
  telemetry.apply(snapshot({ liquidsoap_sequence: sequence, playback_request_id: 'song-old' }), []);
  assert.equal(telemetry.getState().track.playbackRequestId, 'song-old');
});

test('#56: a cursor evicted from the replay window gets a gap marker after the snapshot, and is counted', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const oldest = telemetry.replay[0].id;
  for (let index = 2; index <= 600; index += 1) telemetry.apply(snapshot({ liquidsoap_sequence: index }), [lifecycle(index, 'track_started')]);
  assert.ok(!telemetry.replay.some((event) => event.id === oldest), 'the oldest id was evicted');

  const events = await firstValueFrom(telemetry.subscribe(oldest).pipe(take(2), toArray()));

  assert.equal(events[0].type, 'snapshot');
  assert.equal(events[1].type, 'replay.gap');
  assert.deepEqual(events[1].data, { reason: 'cursor_not_in_replay', replayEvents: telemetry.replay.length });
  const metrics = await telemetry.renderMetrics();
  assert.match(metrics, /^palazzo_replay_gap_total 1$/m);
  assertBoundedLabels(parseExposition(metrics));
});

test('#56: a cursor from another boot is a gap, a cursor still in the window is not', async () => {
  const telemetry = service();
  telemetry.apply(snapshot(), [lifecycle(1, 'track_started')]);
  const kept = telemetry.replay[0].id;
  telemetry.apply(snapshot({ liquidsoap_sequence: 2 }), [lifecycle(2, 'track_started')]);

  const other = await firstValueFrom(telemetry.subscribe('old-boot:99').pipe(take(2), toArray()));
  assert.deepEqual(other.map((event) => event.type), ['snapshot', 'replay.gap']);
  const inWindow = await firstValueFrom(telemetry.subscribe(kept).pipe(take(2), toArray()));
  assert.notEqual(inWindow[1].type, 'replay.gap');
  assert.match(await telemetry.renderMetrics(), /^palazzo_replay_gap_total 1$/m);

  // Reconnecting with the gap marker's id resumes from the snapshot: no second gap.
  const resumed = await firstValueFrom(telemetry.subscribe(other[1].id));
  assert.equal(other[1].id, other[0].id);
  assert.equal(resumed.type, 'snapshot');
  assert.match(await telemetry.renderMetrics(), /^palazzo_replay_gap_total 1$/m);
});

test('#56: the playout journal size and trims are exposed', async () => {
  const telemetry = service();
  telemetry.observePlayoutJournal(256, 2);
  telemetry.observePlayoutJournal(256, 1);
  const metrics = await telemetry.renderMetrics();
  assert.match(metrics, /^palazzo_playout_journal_records 256$/m);
  assert.match(metrics, /^palazzo_playout_journal_trimmed_total 3$/m);
});

// gaulatti/palazzo#66: how each song command's preparation ended is counted from Liquidsoap's journal, with
// bounded labels: ready, fallback (not ready within the limit) and failed (not resolvable); anything else is ignored.
test('counts how song command preparations ended, with bounded labels', async () => {
  const telemetry = service();
  telemetry.setLiquidsoapRunning(true);
  const prepared = (sequence, reason) => ({
    ...lifecycle(sequence, 'command_prepare'),
    playback_request_id: '',
    playback_id: '',
    occurred_at: 4_000 + sequence,
    reason,
  });
  const before = parseExposition(await telemetry.renderMetrics());
  for (const result of ['ready', 'fallback', 'failed']) {
    assert.equal(
      before.find((s) => s.name === 'palazzo_song_command_prepare_total' && s.labels.result === result)?.value,
      0,
    );
  }
  const journal = [prepared(1, 'ready'), prepared(2, 'ready'), prepared(3, 'fallback'), prepared(4, 'failed'), prepared(5, 'surprise')];
  telemetry.apply(snapshot({ liquidsoap_sequence: journal.length }), journal);
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  const value = (result) =>
    samples.find((s) => s.name === 'palazzo_song_command_prepare_total' && s.labels.result === result)?.value;
  assert.equal(value('ready'), 2);
  assert.equal(value('fallback'), 1);
  assert.equal(value('failed'), 1);
  assert.equal(samples.filter((s) => s.name === 'palazzo_song_command_prepare_total').length, 3);
});
