// gaulatti/palazzo#42: an explicit song request time limit, and one counted
// failure event for each song request Liquidsoap cannot resolve.
const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { firstValueFrom, take, toArray } = require("rxjs");
const {
  PlaybackTelemetryService,
} = require("../dist/stream/playback-telemetry.service.js");
const { StreamService } = require("../dist/stream/stream.service.js");
const { buildLiquidsoapScript } = require("../dist/stream/liquidsoap-script.js");
const {
  assertBoundedLabels,
  parseExposition,
} = require("./prometheus-exposition");

const OPTIONS = {
  telnetPort: 14000,
  icecastPort: 8000,
  icecastPassword: "fixture-value",
  mount: "/stream",
  streamName: "Palazzo",
  genre: "Various",
  bitrate: 128,
  fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
};

function queueLine(script) {
  return script.split("\n").find((line) => line.startsWith("songs_queue = "));
}

// The limit the service reads from its configuration.
function limitFor(settings) {
  const config = { get: (key) => settings[key] };
  const service = new StreamService(
    config,
    new PlaybackTelemetryService(config),
    { initialize: async () => undefined, activePlaylistPath: "/run/palazzo/active-filler.m3u" },
  );
  return service.songRequestTimeoutMs;
}

test("the song queue states its request time limit, in seconds, from the option", () => {
  assert.equal(
    queueLine(buildLiquidsoapScript({ ...OPTIONS, songRequestTimeoutMs: 29_000 })),
    'songs_queue = palazzo_song_queue(id="songs", timeout=29.)',
  );
  assert.equal(
    queueLine(buildLiquidsoapScript({ ...OPTIONS, songRequestTimeoutMs: 60_000 })),
    'songs_queue = palazzo_song_queue(id="songs", timeout=60.)',
  );
  assert.equal(
    queueLine(buildLiquidsoapScript({ ...OPTIONS, songRequestTimeoutMs: 7_250 })),
    'songs_queue = palazzo_song_queue(id="songs", timeout=7.25)',
  );
});

test("intros and instants keep Liquidsoap's own request time limit", () => {
  const script = buildLiquidsoapScript({ ...OPTIONS, songRequestTimeoutMs: 60_000 });
  assert.match(script, /^intros_queue = request\.queue\(id="intros", prefetch=1\)$/m);
  assert.match(script, /^instants_queue = mksafe\(request\.queue\(id="instants"\)\)$/m);
  assert.doesNotMatch(script, /settings\.request\.timeout/);
});

test("the song queue journals each request it cannot resolve, by reason, from Liquidsoap", () => {
  const script = buildLiquidsoapScript({ ...OPTIONS, songRequestTimeoutMs: 29_000 });
  const block = script.slice(
    script.indexOf("def palazzo_song_queue("),
    script.indexOf("songs_queue = "),
  );
  assert.ok(block.length > 0, "the song queue is defined above its use");
  assert.match(block, /request\.resolve\(r, timeout=timeout\)/);
  assert.match(block, /remember_event\("song_request_timeout", meta\)/);
  assert.match(block, /remember_event\("song_request_failed", meta\)/);
  assert.match(block, /request\.destroy\(r\)/);
  // The telnet surface Node relies on stays the stdlib one.
  for (const command of ['"flush_and_skip"', '"push"', '"queue"', '"skip"', '"remove"']) {
    assert.ok(block.includes(command), `registers ${command}`);
  }
});

test("SONG_REQUEST_TIMEOUT_MS defaults to 29000 ms and is bounded to 5000-120000 ms", () => {
  assert.equal(limitFor({}), 29_000);
  assert.equal(limitFor({ SONG_REQUEST_TIMEOUT_MS: "60000" }), 60_000);
  assert.equal(limitFor({ SONG_REQUEST_TIMEOUT_MS: "1000" }), 5_000);
  assert.equal(limitFor({ SONG_REQUEST_TIMEOUT_MS: "999999" }), 120_000);
  assert.equal(limitFor({ SONG_REQUEST_TIMEOUT_MS: "29.5" }), 29_000);
  assert.equal(limitFor({ SONG_REQUEST_TIMEOUT_MS: "slow" }), 29_000);
});

for (const [configured, expected] of [[undefined, "29."], ["60000", "60."]]) {
  test(`startup writes the ${expected} s limit into the script it validates (${configured ?? "unset"})`, async (t) => {
    const fs = require("node:fs/promises");
    const root = await mkdtemp(join(tmpdir(), "palazzo-42-startup-"));
    const values = {
      PLAYOUT_COMMAND_JOURNAL_PATH: join(root, "commands.json"),
      PLAYBACK_EVENT_SEQUENCE_PATH: join(root, "events.json"),
      SONG_REQUEST_TIMEOUT_MS: configured,
    };
    const config = { get: (key) => values[key] };
    const service = new StreamService(config, new PlaybackTelemetryService(config), {
      initialize: async () => undefined,
      activePlaylistPath: "/fixture/active.m3u",
    });
    let script;
    const mkdir = fs.mkdir;
    const writeFile = fs.writeFile;
    t.mock.method(fs, "mkdir", (path, ...args) =>
      path === "/tmp/palazzo" ? Promise.resolve(undefined) : mkdir(path, ...args),
    );
    t.mock.method(fs, "writeFile", (path, ...args) => {
      if (path !== "/tmp/palazzo/stream.liq") return writeFile(path, ...args);
      script = args[0];
      return Promise.reject(new Error("stop after the script"));
    });
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await assert.rejects(service.onModuleInit(), /stop after the script/);
    assert.equal(queueLine(script), `songs_queue = palazzo_song_queue(id="songs", timeout=${expected})`);
  });
}

function telemetryService() {
  return new PlaybackTelemetryService({
    get: (key) => ({ PALAZZO_INSTANCE_ID: "test-palazzo", PALAZZO_BUILD_VERSION: "build-test" })[key],
  });
}

function snapshot(sequence) {
  return {
    liquidsoap_sequence: sequence,
    playing: false,
    playback_request_id: "",
    title: "",
    artist: "",
    cover_url: "",
    url: "",
    started_at: 0,
    elapsed: 0,
    remaining: 0,
    song_rms: 0,
    song_peak: 0,
    instant_rms: 0,
    instant_peak: 0,
    intro_playing: false,
    intro_playback_id: "",
    intro_parent_playback_id: "",
    intro_program_id: "",
    intro_request_id: "",
    intro_url: "",
    intro_started_at: 0,
    intro_rms: 0,
    intro_peak: 0,
    output_rms: 0,
    output_peak: 0,
    icecast_connected: true,
    sampled_at: 1_700_000_100,
  };
}

function journal(sequence, event_type, ids = {}) {
  return {
    sequence,
    event_type,
    playback_request_id: "song-42",
    playback_id: "song-42",
    parent_playback_id: "",
    program_id: "program-one",
    title: "Harbor light",
    artist: "Fixture",
    cover_url: "",
    url: "https://media.example.test/song-42.mp3",
    occurred_at: 1_700_000_029,
    ...ids,
  };
}

async function failureCounts(telemetry) {
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  return Object.fromEntries(
    samples
      .filter((sample) => sample.name === "palazzo_song_request_failures_total")
      .map((sample) => [sample.labels.reason, sample.value]),
  );
}

test("both failure series are exposed at 0 before any failure", async () => {
  assert.deepEqual(await failureCounts(telemetryService()), { timeout: 0, other: 0 });
});

test("a timed-out song request emits one playout.request_failed and counts once", async () => {
  const telemetry = telemetryService();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(1), [journal(1, "song_request_timeout")]);
  // The same journal entry on the next poll is not a second failure.
  telemetry.apply(snapshot(1), [journal(1, "song_request_timeout")]);

  const failures = telemetry.replay.filter((event) => event.type === "playout.request_failed");
  assert.equal(failures.length, 1);
  assert.deepEqual(failures[0].data, {
    playbackRequestId: "song-42",
    playbackId: "song-42",
    programId: "program-one",
    reason: "timeout",
    liquidsoapSequence: 1,
  });
  assert.equal(failures[0].occurredAt, new Date(1_700_000_029_000).toISOString());
  assert.deepEqual(await failureCounts(telemetry), { timeout: 1, other: 0 });
  // A failed request never started, so nothing ended either.
  assert.equal(telemetry.replay.some((event) => event.type === "track.ended"), false);
  assert.match(await telemetry.renderMetrics(), /palazzo_track_lifecycle_total\{event="ended"\} 0/);
});

test("any other resolution failure is counted as other, with the legacy request id", async () => {
  const telemetry = telemetryService();
  telemetry.setLiquidsoapRunning(true);
  telemetry.apply(snapshot(1), [
    journal(1, "song_request_failed", { playback_id: "", program_id: "", playback_request_id: "legacy-7" }),
  ]);
  const failure = telemetry.replay.find((event) => event.type === "playout.request_failed");
  assert.deepEqual(failure.data, {
    playbackRequestId: "legacy-7",
    playbackId: "legacy-7",
    programId: null,
    reason: "other",
    liquidsoapSequence: 1,
  });
  assert.deepEqual(await failureCounts(telemetry), { timeout: 0, other: 1 });
});

test("the failure reaches the SSE stream in order with that playback's other events", async () => {
  const telemetry = telemetryService();
  telemetry.setLiquidsoapRunning(true);
  telemetry.reportPlayout("queued", { programId: "program-one", playbackId: "song-42", kind: "song", scheduledAt: "2026-11-17T10:00:00.000Z" });
  const queued = telemetry.replay.find((event) => event.type === "playout.queued");
  telemetry.apply(snapshot(2), [
    journal(1, "song_request_timeout"),
    journal(2, "track_started", { playback_request_id: "song-43", playback_id: "song-43" }),
  ]);
  const replayed = telemetry.replay.filter((event) => event.sequence > queued.sequence).length;
  const events = await firstValueFrom(
    telemetry.subscribe(queued.id).pipe(take(1 + replayed), toArray()),
  );
  // After the snapshot, the stream replays everything after playout.queued in sequence order.
  const after = events.slice(1);
  assert.deepEqual(after.map((event) => event.sequence), [...after.map((event) => event.sequence)].sort((a, b) => a - b));
  const order = after.map((event) => event.type).filter((type) => !type.startsWith("telemetry."));
  assert.deepEqual(order.slice(0, 2), ["playout.request_failed", "track.started"]);
  const failure = after.find((event) => event.type === "playout.request_failed");
  assert.ok(failure.sequence > queued.sequence);
  assert.equal(failure.data.playbackId, "song-42");
});

test("a song whose probe fails is reported once, by preflight, never as a request failure", async () => {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: "/run/palazzo/active-filler.m3u",
  });
  const commands = [];
  service.telnet = { send: async (command) => { commands.push(command); return "ok"; }, close: () => undefined };
  service.playoutJournalPath = join(await mkdtemp(join(tmpdir(), "palazzo-42-")), "commands.json");
  service.assetProbe = async () => {
    const error = new Error("probe timed out");
    error.killed = true;
    error.signal = "SIGTERM";
    throw error;
  };
  await assert.rejects(
    service.playProgramSong("program-one", "command-1", {
      song: { programId: "program-one", playbackId: "song-42", url: "https://media.example.test/song-42.mp3" },
    }),
    /song asset is not ready/,
  );
  assert.equal(commands.some((command) => command.startsWith("songs.push")), false);
  const types = telemetry.replay.map((event) => event.type);
  assert.equal(types.filter((type) => type === "preflight.failed").length, 1);
  assert.equal(types.includes("playout.request_failed"), false);
  assert.deepEqual(await failureCounts(telemetry), { timeout: 0, other: 0 });
});
