// gaulatti/palazzo#40: the next-song announcement (PUT/DELETE v1/programs/:programId/playback/next),
// the two song decks it drives, and its telemetry. Contract: palazzo-40.contract.md.
const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  PlaybackTelemetryService,
} = require("../dist/stream/playback-telemetry.service.js");
const { StreamService } = require("../dist/stream/stream.service.js");
const { StreamController } = require("../dist/stream/stream.controller.js");
const { buildLiquidsoapScript } = require("../dist/stream/liquidsoap-script.js");
const { mediaProbeResult } = require("./media-probe-fixture");
const {
  assertBoundedLabels,
  parseExposition,
} = require("./prometheus-exposition");

function snapshot(overrides = {}) {
  return {
    liquidsoap_sequence: 1,
    playing: true,
    playback_request_id: "song-a",
    title: "A",
    artist: "Artist",
    cover_url: "",
    url: "https://example.test/a.mp3",
    started_at: 1_700_000_000,
    elapsed: 60,
    remaining: 120.5,
    song_rms: 0.2,
    song_peak: 0.4,
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
    output_rms: 0.2,
    output_peak: 0.4,
    icecast_connected: true,
    sampled_at: 1_700_000_060,
    ...overrides,
  };
}

async function harness(settings = {}, answers = {}) {
  const config = { get: (key) => settings[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const emitted = [];
  const emit = telemetry.emit.bind(telemetry);
  telemetry.emit = (type, data, occurredAt) => {
    emitted.push([type, data]);
    return emit(type, data, occurredAt);
  };
  const service = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: "/run/palazzo/active-filler.m3u",
  });
  const commands = [];
  service.telnet = {
    send: async (command) => {
      commands.push(command);
      for (const [prefix, answer] of Object.entries(answers)) {
        if (command.startsWith(prefix)) return answer;
      }
      return "ok";
    },
    close: () => undefined,
  };
  const directory = await mkdtemp(join(tmpdir(), "palazzo-next-"));
  service.playoutJournalPath = join(directory, "commands.json");
  service.assetProbe = async () => mediaProbeResult();
  const onAir = (overrides) => telemetry.apply(snapshot(overrides), []);
  const announce = (song = {}, key = "next-b", extra = {}) =>
    service.announceNext("program-one", key, {
      song: {
        programId: "program-one",
        playbackId: "song-b",
        url: "https://example.test/b.mp3",
        title: "B",
        artist: "Artist",
        ...song,
      },
      ...extra,
    });
  const counts = async () => {
    const samples = parseExposition(await telemetry.renderMetrics());
    assertBoundedLabels(samples);
    const out = {};
    for (const sample of samples) {
      if (sample.name === "palazzo_next_requests_total") {
        out[`request:${sample.labels.result}`] = sample.value;
      }
      if (sample.name === "palazzo_next_withdrawn_total") {
        out[`withdrawn:${sample.labels.reason}`] = sample.value;
      }
    }
    return out;
  };
  return { service, telemetry, commands, emitted, onAir, announce, counts };
}

const B_URI =
  'annotate:palazzo_request_id="song-b",palazzo_playback_id="song-b",palazzo_program_id="program-one",palazzo_url="https://example.test/b.mp3",title="B",artist="Artist",cover_url="":https://example.test/b.mp3';

async function rejects(promise, status, reason) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.getStatus(), status);
    assert.deepEqual(error.getResponse(), { ok: false, reason });
    return true;
  });
}

test("an announcement queues the next song behind the current one, limited by its remaining time", async () => {
  const { commands, emitted, onAir, announce, counts } = await harness();
  onAir();
  const response = await announce();
  assert.deepEqual(response, {
    ok: true,
    playbackRequestId: "song-b",
    state: "queued",
  });
  // A has 120.5 s left, under the 600 s default cap; A carried no segue, so no overlap.
  assert.deepEqual(commands, [`palazzo.prepare_next song-b 120.5 0 ${B_URI}`]);
  assert.deepEqual(
    emitted.filter(([type]) => type === "playout.next_queued"),
    [["playout.next_queued", { programId: "program-one", playbackId: "song-b" }]],
  );
  assert.equal((await counts())["request:queued"], 1);
});

test("the current song's overlap and the configured cap shape the announcement", async () => {
  const { service, commands, onAir, announce } = await harness({
    PLAYOUT_NEXT_RESOLVE_MAX_SECONDS: "90",
  });
  // A was commanded with a segue that asks for a 2 s overlap.
  await service.playProgramSong("program-one", "command-a", {
    song: {
      programId: "program-one",
      playbackId: "song-a",
      url: "https://example.test/a.mp3",
      title: "A",
      segue: {
        cueInSeconds: 0,
        cueOutSeconds: 180,
        fadeInSeconds: 0,
        fadeOutSeconds: 2,
        overlapSeconds: 2,
      },
    },
  });
  onAir();
  await announce({
    segue: {
      cueInSeconds: 1,
      cueOutSeconds: 200,
      fadeInSeconds: 1,
      fadeOutSeconds: 0,
      overlapSeconds: 0,
    },
  });
  const prepare = commands.find((c) => c.startsWith("palazzo.prepare_next"));
  assert.ok(prepare.startsWith("palazzo.prepare_next song-b 90 2 annotate:"));
  assert.match(prepare, /liq_cue_in="1",liq_cue_out="200",liq_fade_in="1",liq_fade_out="0"/);
});

test("a song without a title or artist and with a cover is annotated like a song command", async () => {
  const { commands, onAir, announce } = await harness();
  onAir();
  await announce({ title: undefined, artist: undefined, coverUrl: "https://example.test/b.jpg" });
  assert.match(commands[0], /title="",artist="",cover_url="https:\/\/example\.test\/b\.jpg"/);
});

test("without a remaining time the announcement uses the cap", async () => {
  const { commands, onAir, announce } = await harness();
  onAir({ remaining: 0 });
  await announce();
  assert.ok(commands[0].startsWith("palazzo.prepare_next song-b 600 0 "));
});

test("nothing on air is a 409, and nothing is sent", async () => {
  const { commands, onAir, announce, counts } = await harness();
  onAir({ playing: false });
  await rejects(announce(), 409, "no_current_song");
  assert.deepEqual(commands, []);
  assert.equal((await counts())["request:no_current_song"], 1);
});

test("a file that fails its probe is a 422 and nothing is queued", async () => {
  const { service, commands, onAir, announce, counts } = await harness();
  service.assetProbe = async () => {
    throw Object.assign(new Error("unreachable"), { code: "ECONNREFUSED" });
  };
  onAir();
  await rejects(announce(), 422, "not_ready");
  assert.deepEqual(commands, []);
  assert.equal((await counts())["request:not_ready"], 1);
});

test("Liquidsoap refusing the preparation is a 422", async () => {
  const { onAir, announce } = await harness({}, { "palazzo.prepare_next": "invalid" });
  onAir();
  await rejects(announce(), 422, "not_ready");
});

for (const [name, call] of [
  ["an empty idempotency key", (h) => h.announce({}, "")],
  ["no idempotency key", (h) => h.service.announceNext("program-one", undefined, { song: { programId: "program-one", playbackId: "song-b", url: "https://example.test/b.mp3" } })],
  ["an oversized idempotency key", (h) => h.announce({}, "k".repeat(201))],
  ["an intro", (h) => h.announce({}, "next-b", { intro: { programId: "program-one", playbackId: "i", url: "https://example.test/i.mp3" } })],
  ["a song of another program", (h) => h.announce({ programId: "program-two" })],
  ["a playback id with a space", (h) => h.announce({ playbackId: "song b" })],
  ["no body", (h) => h.service.announceNext("program-one", "next-b", undefined)],
]) {
  test(`${name} is a 400 and nothing is sent`, async () => {
    const h = await harness();
    h.onAir();
    await rejects(call(h), 400, "invalid");
    assert.deepEqual(h.commands, []);
    assert.equal((await h.counts())["request:invalid"], 1);
  });
}

test("a repeated announcement is a duplicate; the same key with another body is a 400", async () => {
  const { commands, onAir, announce, counts } = await harness();
  onAir();
  await announce();
  assert.deepEqual(await announce(), {
    ok: true,
    playbackRequestId: "song-b",
    state: "queued",
    duplicate: true,
  });
  await rejects(announce({ title: "Other" }), 400, "invalid");
  assert.equal(commands.length, 1);
  const c = await counts();
  assert.equal(c["request:duplicate"], 1);
  assert.equal(c["request:invalid"], 1);
});

test("remembered announcements and overlaps stay bounded", async () => {
  const { service, onAir, announce } = await harness();
  onAir();
  for (let i = 0; i < 66; i += 1) {
    await announce({ playbackId: `song-${i}` }, `key-${i}`);
  }
  assert.equal(service.nextCommands.size, 64);
  for (let i = 0; i < 66; i += 1) service.rememberOverlap(`song-${i}`, 1);
  assert.equal(service.songOverlaps.size, 64);
  assert.equal(service.songOverlaps.has("song-0"), false);
});

test("withdrawal: nothing to do before any announcement; otherwise Liquidsoap answers", async () => {
  const quiet = await harness();
  assert.deepEqual(await quiet.service.withdrawNext(), { ok: true, withdrawn: false });
  assert.deepEqual(quiet.commands, []);

  const used = await harness({}, { "palazzo.withdraw_next": "withdrawn" });
  used.onAir();
  await used.announce();
  assert.deepEqual(await used.service.withdrawNext(), { ok: true, withdrawn: true });
  assert.equal(used.commands[1], "palazzo.withdraw_next withdrawn");

  const none = await harness({}, { "palazzo.withdraw_next": "none" });
  none.onAir();
  await none.announce();
  assert.deepEqual(await none.service.withdrawNext(), { ok: true, withdrawn: false });
});

test("song commands and stops send exactly today's commands until a next song was announced", async () => {
  const { service, commands, onAir, announce } = await harness();
  const command = (key) =>
    service.playProgramSong("program-one", key, {
      song: { programId: "program-one", playbackId: key, url: "https://example.test/a.mp3" },
    });
  await command("before");
  await service.stopSong();
  await service.playSong({ url: "https://example.test/a.mp3" });
  await service.clearProgramMaterial();
  assert.equal(commands.includes("palazzo.reset_decks"), false);

  onAir();
  await announce();
  commands.length = 0;
  await command("after");
  assert.deepEqual(commands.slice(0, 2), ["palazzo.reset_decks", "intros.flush_and_skip"]);
  commands.length = 0;
  await service.stopSong();
  assert.deepEqual(commands, ["palazzo.reset_decks", "songs.flush_and_skip"]);
  commands.length = 0;
  await service.playSong({ url: "https://example.test/a.mp3" });
  assert.deepEqual(commands.slice(0, 2), ["palazzo.reset_decks", "songs.flush_and_skip"]);
  commands.length = 0;
  await service.clearProgramMaterial();
  assert.equal(commands[0], "palazzo.reset_decks");
});

test("a withdrawn announcement becomes playout.next_withdrawn with its reason, counted", async () => {
  const { telemetry, emitted, onAir, announce, counts } = await harness();
  onAir();
  await announce();
  const withdrawn = (sequence, reason) => ({
    sequence,
    event_type: "next_withdrawn",
    playback_request_id: "song-b",
    playback_id: "song-b",
    parent_playback_id: "",
    program_id: "",
    title: "",
    artist: "",
    cover_url: "",
    url: "",
    reason,
    occurred_at: 1_700_000_100,
  });
  telemetry.apply(snapshot({ liquidsoap_sequence: 3 }), [
    withdrawn(2, "not_ready"),
    withdrawn(3, "unexpected"),
  ]);
  assert.deepEqual(
    emitted.filter(([type]) => type === "playout.next_withdrawn"),
    [
      [
        "playout.next_withdrawn",
        { programId: "program-one", playbackId: "song-b", reason: "not_ready" },
      ],
    ],
  );
  const c = await counts();
  assert.equal(c["withdrawn:not_ready"], 1);
  assert.equal(c["withdrawn:replaced"], 0);
  // A withdrawal never touches the song on air.
  assert.equal(telemetry.currentSong().playbackRequestId, "song-a");
});

test("both counters are exposed at zero before any announcement", async () => {
  const { counts } = await harness();
  assert.deepEqual(await counts(), {
    "request:queued": 0,
    "request:duplicate": 0,
    "request:not_ready": 0,
    "request:invalid": 0,
    "request:no_current_song": 0,
    "withdrawn:replaced": 0,
    "withdrawn:withdrawn": 0,
    "withdrawn:flushed": 0,
    "withdrawn:not_ready": 0,
  });
});

test("the next-song routes check the program, then call the service", async () => {
  const calls = [];
  const controller = new StreamController(
    {
      announceNext: async (...args) => {
        calls.push(["announce", ...args]);
        return { ok: true };
      },
      withdrawNext: async () => {
        calls.push(["withdraw"]);
        return { ok: true, withdrawn: false };
      },
    },
    { assertProgram: (program) => calls.push(["program", program]) },
    {},
  );
  await controller.announceNextSong("program-one", "key", { song: {} });
  await controller.withdrawNextSong("program-one");
  assert.deepEqual(calls, [
    ["program", "program-one"],
    ["announce", "program-one", "key", { song: {} }],
    ["program", "program-one"],
    ["withdraw"],
  ]);
});

test("the script keeps deck a as the songs queue and gates the announced song on deck b", () => {
  const script = buildLiquidsoapScript({
    telnetPort: 14000,
    icecastPort: 8000,
    icecastPassword: "secret",
    mount: "/stream",
    streamName: "Palazzo",
    genre: "Various",
    bitrate: 128,
    fillerPlaylistPath: "/run/palazzo/active-filler.m3u",
    songRequestTimeoutMs: 29000,
  });
  assert.match(script, /songs_queue = palazzo_song_queue\(id="songs", timeout=29\.\)\n/);
  assert.match(script, /next_queue = request\.queue\(id="songs_next"\)/);
  assert.match(script, /deck_a_open = ref\(true\)\ndeck_b_open = ref\(false\)/);
  assert.match(script, /position=\{next_overlap\(\)\}, remaining=true/);
  assert.match(script, /request\.resolve\(timeout=resolve_limit, r\)/);
  for (const command of ["prepare_next", "withdraw_next", "reset_decks"]) {
    assert.match(script, new RegExp(`"${command}",`));
  }
  assert.match(script, /elapsed=finite_level\(active_deck_source\(\)\.elapsed\(\)\)/);
});
