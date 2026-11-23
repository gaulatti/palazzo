const assert = require("node:assert/strict");
const { identityRelay } = require('./media-relay-stub');
const test = require("node:test");
const { mkdtemp, readFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  PlaybackTelemetryService,
} = require("../dist/stream/playback-telemetry.service.js");
const { StreamService } = require("../dist/stream/stream.service.js");
const { mediaProbeResult } = require('./media-probe-fixture');

function streamService() {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: "/run/palazzo/active-filler.m3u",
  }, identityRelay);
  const commands = [];
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  service.telnet = {
    send: async (command) => {
      commands.push(command);
      return "ok";
    },
    close: () => undefined,
  };
  return { service, commands, telemetry };
}

test("propagates a caller-supplied playback request ID into Liquidsoap metadata", async () => {
  const { service, commands } = streamService();
  const accepted = await service.playSong({
    url: "https://example.test/song.mp3",
    title: "Title",
    artist: "Artist",
    coverUrl: "https://example.test/cover.jpg",
    playbackRequestId: "alcantara-request-42",
  });

  assert.equal(accepted.playbackRequestId, "alcantara-request-42");
  assert.deepEqual(commands.slice(0, 2), ["palazzo.mark_ending replacement", "songs.flush_and_skip"]);
  assert.match(commands[2], /palazzo_request_id="alcantara-request-42"/);
  assert.match(commands[2], /cover_url="https:\/\/example\.test\/cover\.jpg"/);
  assert.doesNotMatch(commands[2], /remaining/);
});

test("generates and returns an ID for backward-compatible callers", async () => {
  const { service, commands } = streamService();
  const accepted = await service.playInstant({
    url: "https://example.test/instant.mp3",
  });

  assert.match(accepted.playbackRequestId, /^[0-9a-f-]{36}$/);
  assert.match(commands[0], new RegExp(accepted.playbackRequestId));
});

// gaulatti/palazzo#60: Palazzo sets cue points only for songs, so an instant, a spot or an intro must
// not take cue values from the audio file's own tags: both are annotated empty, which overrides the file
// (measured on Liquidsoap 2.4.5, test/runtime/verify-item-cue.sh) and plays the item whole.
test("annotates an instant with empty cue values so its file's own cue tags are ignored", async () => {
  const { service, commands } = streamService();
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  assert.match(commands[0], /^instants\.push annotate:/);
  assert.match(commands[0], /liq_cue_in=""/);
  assert.match(commands[0], /liq_cue_out=""/);
  commands.length = 0;
  await service.playInstant({
    url: "https://example.test/instant.mp3",
    volume: 0.5,
  });
  assert.match(commands[0], /liq_cue_in="",liq_cue_out="",liq_amplify="0.5"/);
});

test("annotates an intro with empty cue values and leaves the song's annotations without any", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palazzo-playout-"));
  const { service, commands } = streamService();
  service.playoutJournalPath = join(directory, "commands.json");
  service.assetProbe = async () => mediaProbeResult();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  await service.playProgramSong("program-one", "command-60", {
    song: {
      title: "Song",
      url: "https://example.test/song.mp3",
      playbackId: "song-60",
      programId: "program-one",
    },
    intro: {
      url: "https://example.test/intro.mp3",
      playbackId: "intro-60",
      programId: "program-one",
      gain: 0.7,
      duckGain: 0.25,
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.2,
    },
  });
  const intro = commands.find((command) => command.startsWith("intros.push"));
  assert.match(intro, /liq_cue_in=""/);
  assert.match(intro, /liq_cue_out=""/);
  const song = commands.find((command) => command.startsWith("songs.push"));
  assert.doesNotMatch(song, /liq_cue/);
});

test("applies per-instant volume metadata for bumpers and manual instants", async () => {
  const { service, commands } = streamService();
  await service.playInstant({
    url: "https://example.test/bumper.mp3",
    volume: 0.35,
  });
  assert.match(commands[0], /liq_amplify="0.35"/);
});

test("applies and reports song, instant, and main mixer controls", async () => {
  const { service, commands } = streamService();
  const state = await service.updateMixer({
    mainVolume: 0.9,
    songVolume: 0.75,
    instantVolume: 0.45,
    songMuted: false,
    instantMuted: true,
  });
  assert.deepEqual(commands, [
    "var.set palazzo_main_volume = 0.9",
    "var.set palazzo_song_volume = 0.75",
    "var.set palazzo_instant_volume = 0",
  ]);
  assert.deepEqual(service.getMixer(), state);
  assert.equal(state.instantMuted, true);
  assert.equal(state.instantVolume, 0.45);
});

test("rejects invalid mixer levels before sending Liquidsoap commands", async () => {
  const { service, commands } = streamService();
  await assert.rejects(
    service.updateMixer({ instantVolume: 1.1 }),
    /instantVolume must be a number between 0 and 1/,
  );
  assert.deepEqual(commands, []);
});

test("clears active and queued song and instant material for lifecycle Stop", async () => {
  const { service, commands } = streamService();

  await service.clearProgramMaterial();

  assert.deepEqual(commands, [
    "palazzo.mark_ending operator",
    "songs.flush_and_skip",
    "instants.flush_and_skip",
    "intros.flush_and_skip",
  ]);
});

test("song Stop clears active and queued songs", async () => {
  const { service, commands } = streamService();

  await service.stopSong();

  assert.deepEqual(commands, ["palazzo.mark_ending operator", "songs.flush_and_skip"]);
});

test("serializes multi-command playback operations against lifecycle queue clearing", async () => {
  const { service, commands } = streamService();

  await Promise.all([
    service.playSong({ url: "https://example.test/song.mp3" }),
    service.clearProgramMaterial(),
  ]);

  assert.deepEqual(commands.slice(0, 2), ["palazzo.mark_ending replacement", "songs.flush_and_skip"]);
  assert.match(commands[2], /^songs\.push /);
  assert.deepEqual(commands.slice(3), [
    "palazzo.mark_ending operator",
    "songs.flush_and_skip",
    "instants.flush_and_skip",
    "intros.flush_and_skip",
  ]);
});

test("prepares an intro before replacing the song and deduplicates retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palazzo-playout-"));
  const { service, commands } = streamService();
  service.playoutJournalPath = join(directory, "commands.json");
  service.assetProbe = async () => mediaProbeResult();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  const payload = {
    song: {
      programId: "program-one",
      playbackId: "song-42",
      url: "https://example.test/song.mp3",
      title: "Song",
    },
    intro: {
      programId: "program-one",
      playbackId: "intro-42",
      url: "https://example.test/intro.mp3",
      gain: 0.7,
      duckGain: 0.25,
      fadeInSeconds: 0.1,
      fadeOutSeconds: 0.2,
    },
  };

  const first = await service.playProgramSong(
    "program-one",
    "command-42",
    payload,
  );
  const duplicate = await service.playProgramSong(
    "program-one",
    "command-42",
    payload,
  );
  const reordered = await service.playProgramSong("program-one", "command-42", {
    intro: {
      fadeOutSeconds: 0.2,
      fadeInSeconds: 0.1,
      duckGain: 0.25,
      gain: 0.7,
      url: "https://example.test/intro.mp3",
      playbackId: "intro-42",
      programId: "program-one",
    },
    song: {
      title: "Song",
      url: "https://example.test/song.mp3",
      playbackId: "song-42",
      programId: "program-one",
    },
  });

  assert.equal(first.introPlaybackId, "intro-42");
  assert.equal(duplicate.duplicate, true);
  assert.equal(reordered.duplicate, true);
  assert.equal(
    commands.filter((command) => command.startsWith("songs.push")).length,
    1,
  );
  assert.ok(
    commands.indexOf("intros.flush_and_skip") <
      commands.findIndex((command) => command.startsWith("songs.flush")),
  );
  assert.match(
    commands.find((command) => command.startsWith("intros.push")),
    /liq_amplify="0.7"/,
  );
  assert.match(
    commands.find((command) => command.startsWith("intros.push")),
    /palazzo_parent_playback_id="song-42"/,
  );
  assert.equal(
    JSON.parse(await readFile(join(directory, "commands.json"))).length,
    1,
  );
});

test("intro readiness failure degrades to song-only playout", async () => {
  const directory = await mkdtemp(join(tmpdir(), "palazzo-playout-"));
  const { service, commands, telemetry } = streamService();
  service.playoutJournalPath = join(directory, "commands.json");
  let probes = 0;
  service.assetProbe = async () => {
    probes += 1;
    if (probes === 2) throw new Error("unavailable");
    return mediaProbeResult();
  };

  const result = await service.playProgramSong("program-one", "command", {
    song: {
      programId: "program-one",
      playbackId: "song",
      url: "https://example.test/song.mp3",
    },
    intro: {
      programId: "program-one",
      playbackId: "intro",
      url: "https://example.test/intro.mp3",
    },
  });

  assert.equal(result.introPlaybackId, null);
  assert.equal(
    commands.some((command) => command.startsWith("intros.push")),
    false,
  );
  assert.equal(
    commands.some((command) => command.startsWith("songs.push")),
    true,
  );
  assert.equal(telemetry.getState().intro.status, "failed");
  const fallback = telemetry.replay.find(
    (event) => event.type === "playout.fallback",
  );
  assert.equal(fallback.data.policy, "song_only");
  assert.equal(fallback.data.failedPlaybackId, "intro");
  assert.match(
    await telemetry.renderMetrics(),
    /result="failed",reason="asset_unavailable"\} 1/,
  );
});

test("preflights valid, missing, corrupt, and slow assets without touching the active queue", async () => {
  const { service, commands } = streamService();
  service.assetProbe = async (url) => {
    if (url.includes("missing")) throw new Error("HTTP error 404 Not Found");
    if (url.includes("corrupt"))
      throw new Error("Invalid data found when processing input");
    if (url.includes("slow")) {
      const error = new Error("probe timed out");
      error.code = "ETIMEDOUT";
      throw error;
    }
    return {
      mediaType: "audio",
      format: "mp3",
      codec: "mp3",
      durationSeconds: 120,
      sampleRateHz: 48000,
      channels: 2,
      readablePacketBytes: 512,
    };
  };
  const scheduledAt = new Date(Date.now() + 60_000).toISOString();
  const result = await service.preflightProgramAssets("program-one", {
    assets: ["valid", "missing", "corrupt", "slow"].map((name) => ({
      programId: "program-one",
      playbackId: name,
      kind: "song",
      url: `https://example.test/${name}.mp3`,
      scheduledAt,
    })),
  });

  assert.deepEqual(
    result.assets.map(({ readiness, reason }) => ({ readiness, reason })),
    [
      { readiness: "ready", reason: "ready" },
      { readiness: "quarantined", reason: "missing" },
      { readiness: "quarantined", reason: "corrupt" },
      { readiness: "quarantined", reason: "timeout" },
    ],
  );
  assert.equal(result.assets[0].media.durationSeconds, 120);
  assert.equal(
    result.assets.some((asset) => "url" in asset),
    false,
  );
  assert.deepEqual(commands, []);
});

test("enforces lookahead, concurrency, and bounded readiness-cache limits", async () => {
  const { service } = streamService();
  service.preflightConcurrency = 2;
  service.preflightCacheEntries = 2;
  service.preflightLookaheadMs = 120_000;
  let active = 0;
  let peak = 0;
  service.assetProbe = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      mediaType: "audio",
      format: "mp3",
      codec: "mp3",
      durationSeconds: 30,
      sampleRateHz: 44100,
      channels: 2,
      readablePacketBytes: 256,
    };
  };
  const now = Date.now();
  const assets = [0, 1].map((index) => ({
    programId: "program-one",
    playbackId: `asset-${index}`,
    kind: "song",
    url: `https://example.test/${index}.mp3`,
    scheduledAt: new Date(now + 30_000).toISOString(),
  }));
  const first = await service.preflightProgramAssets("program-one", { assets });
  const reused = await service.preflightProgramAssets("program-one", {
    assets: [assets[1]],
  });
  const outside = await service.preflightProgramAssets("program-one", {
    assets: [
      {
        ...assets[0],
        playbackId: "outside",
        scheduledAt: new Date(now + 300_000).toISOString(),
      },
    ],
  });

  assert.equal(peak, 2);
  assert.equal(first.limits.cacheEntries, 2);
  assert.equal(reused.assets[0].reused, true);
  assert.equal(outside.assets[0].reason, "outside_lookahead");
  assert.equal(service.getProgramPreflight("program-one").assets.length, 2);
});

test("rejects an invalid song before queue mutation and records a bounded preflight metric", async () => {
  const { service, commands, telemetry } = streamService();
  service.assetProbe = async () => {
    throw new Error("No such file");
  };
  await assert.rejects(
    service.playProgramSong("program-one", "command", {
      song: {
        programId: "program-one",
        playbackId: "missing-song",
        url: "https://example.test/missing.mp3",
      },
    }),
    /song asset is not ready/,
  );

  assert.deepEqual(commands, []);
  assert.match(
    await telemetry.renderMetrics(),
    /palazzo_media_preflight_total\{result="failed",reason="missing"\} 1/,
  );
});

test("rejects cross-program assets before touching Liquidsoap", async () => {
  const { service, commands } = streamService();
  service.assetProbe = async () => mediaProbeResult();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  await assert.rejects(
    service.playProgramSong("program-one", "command", {
      song: {
        programId: "program-two",
        playbackId: "song",
        url: "https://example.test/song.mp3",
      },
    }),
    /belongs to another program/,
  );
  assert.deepEqual(commands, []);
});

test("records successful and malformed Liquidsoap telemetry poll outcomes", async () => {
  const { service, telemetry } = streamService();
  const snapshot = {
    liquidsoap_sequence: 0,
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
    output_rms: 0,
    output_peak: 0,
    icecast_connected: true,
    sampled_at: Date.now() / 1000,
  };
  service.telnet = {
    send: async (command) =>
      command === "palazzo.snapshot" ? JSON.stringify(snapshot) : "[]",
    close: () => undefined,
  };

  await service.pollTelemetry();
  service.telnet.send = async () => "not-json";
  await service.pollTelemetry();

  const metrics = await telemetry.renderMetrics();
  assert.match(metrics, /operation="telemetry_poll",result="success"\} 1/);
  assert.match(
    metrics,
    /operation="telemetry_poll",result="parse_failure"\} 1/,
  );
});

test("cues an instant out at its last audio, capped at one second of trim", async () => {
  const { service, commands, telemetry } = streamService();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 2.6, trailingSilenceSeconds: 0.596 });
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  assert.match(commands[0], /liq_cue_in="",liq_cue_out="2.004"/);
  commands.length = 0;
  service.itemCueOuts.clear();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 10, trailingSilenceSeconds: 4 });
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  assert.match(commands[0], /liq_cue_out="9"/);
  assert.match(await telemetry.renderMetrics(), /palazzo_item_trim_total\{kind="instant",result="trimmed"\}/);
});

test("plays an item whole when the trailing silence cannot be measured", async () => {
  const { service, commands, telemetry } = streamService();
  service.trailingSilenceProbe = async () => { throw new Error("ffmpeg failed"); };
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  assert.match(commands[0], /liq_cue_in="",liq_cue_out=""/);
  assert.match(await telemetry.renderMetrics(), /palazzo_item_trim_total\{kind="instant",result="failed"\} 1/);
});

test("measures one source once", async () => {
  const { service } = streamService();
  let probes = 0;
  service.trailingSilenceProbe = async () => { probes += 1; return { durationSeconds: 3, trailingSilenceSeconds: 0.3 }; };
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  await service.playInstant({ url: "https://example.test/instant.mp3" });
  assert.equal(probes, 1);
});
