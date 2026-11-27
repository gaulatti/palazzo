const assert = require("node:assert/strict");
const { identityRelay } = require('./media-relay-stub');
const test = require("node:test");
const { mkdtemp } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  PlaybackTelemetryService,
} = require("../dist/stream/playback-telemetry.service.js");
const {
  StreamService,
  loudnessGain,
} = require("../dist/stream/stream.service.js");
const { buildLiquidsoapScript } = require("../dist/stream/liquidsoap-script.js");
const { mediaProbeResult } = require("./media-probe-fixture");
const {
  assertBoundedLabels,
  parseExposition,
} = require("./prometheus-exposition");

async function harness(settings = {}) {
  const config = { get: (key) => settings[key] };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: "/run/palazzo/active-filler.m3u",
  }, identityRelay);
  const commands = [];
  service.telnet = {
    send: async (command) => {
      commands.push(command);
      return "ok";
    },
    close: () => undefined,
  };
  const directory = await mkdtemp(join(tmpdir(), "palazzo-analysis-"));
  service.playoutJournalPath = join(directory, "commands.json");
  service.assetProbe = async () => mediaProbeResult();
  service.trailingSilenceProbe = async () => ({ durationSeconds: 3, trailingSilenceSeconds: 0 });
  let key = 0;
  const play = async (song, intro) => {
    await service.playProgramSong("program-one", `command-${(key += 1)}`, {
      song: {
        programId: "program-one",
        playbackId: "song-42",
        url: "https://example.test/song.mp3",
        title: "Song",
        ...song,
      },
      ...(intro ? { intro } : {}),
    });
    // A song command now goes as palazzo.command_song <limit> <uri> (gaulatti/palazzo#66); its song request is
    // the same annotated URI that songs.push carried.
    const pushes = commands
      .filter((command) => command.startsWith("palazzo.command_song "))
      .map(
        (command) =>
          `songs.push ${command.slice("palazzo.command_song ".length).replace(/^\S+ /, "")}`,
      );
    return pushes[pushes.length - 1];
  };
  const dropped = async () => {
    const samples = parseExposition(await telemetry.renderMetrics());
    assertBoundedLabels(samples);
    const counts = {};
    for (const sample of samples) {
      if (sample.name === "palazzo_song_analysis_dropped_total") {
        assert.equal(sample.labels.result, "invalid");
        counts[sample.labels.group] = sample.value;
      }
    }
    return counts;
  };
  return { service, telemetry, commands, play, dropped };
}

// Exactly what main 3ab0a991 pushes for this song command.
const TODAY_SONG_PUSH =
  'songs.push annotate:palazzo_request_id="song-42",palazzo_playback_id="song-42",palazzo_program_id="program-one",palazzo_url="https://example.test/song.mp3",title="Song",artist="",cover_url="":https://example.test/song.mp3';

const SEGUE = {
  cueInSeconds: 3,
  cueOutSeconds: 182.5,
  fadeInSeconds: 0.5,
  fadeOutSeconds: 2.25,
  overlapSeconds: 1.5,
};
const LOUDNESS = { integratedLufs: -12, truePeakDbtp: -6 };

test("a song command without segue or loudness pushes today's exact request", async () => {
  const { play, dropped } = await harness();
  assert.equal(await play({}), TODAY_SONG_PUSH);
  assert.deepEqual(await dropped(), { loudness: 0, segue: 0 });
});

test("a song with both groups is annotated with cues, fades and the computed gain", async () => {
  const { play, dropped } = await harness();
  const push = await play({ segue: SEGUE, loudness: LOUDNESS, duration: 190 });
  // -16 target - -12 measured = -4 dB; peak -6 - 4 = -10 stays under -1.
  assert.equal(
    push,
    `${TODAY_SONG_PUSH.slice(0, TODAY_SONG_PUSH.indexOf(':https://'))},liq_cue_in="3",liq_cue_out="182.5",liq_fade_in="0.5",liq_fade_out="2.25",liq_amplify="0.630957":https://example.test/song.mp3`,
  );
  assert.doesNotMatch(push, /overlap/);
  assert.deepEqual(await dropped(), { loudness: 0, segue: 0 });
});

test("the loudness gain is capped so the true peak stays at the ceiling", async () => {
  const { play } = await harness();
  // -30 LUFS would need +14 dB, but a -2 dBTP peak allows only +1 dB.
  const push = await play({
    loudness: { integratedLufs: -30, truePeakDbtp: -2 },
  });
  assert.match(push, /,liq_amplify="1\.122018":https:/);
  assert.doesNotMatch(push, /liq_cue_in|liq_fade/);
  const gain = loudnessGain(
    { integratedLufs: -30, truePeakDbtp: -2 },
    -16,
    -1,
  );
  assert.ok(Math.abs(-2 + 20 * Math.log10(gain) - -1) < 1e-9);
});

test("the loudness target and ceiling come from configuration", async () => {
  const { play } = await harness({
    PLAYOUT_TARGET_LUFS: "-14",
    PLAYOUT_TRUE_PEAK_CEILING_DBTP: "-2",
  });
  // -14 - -20 = +6 dB, but -2 - -5 = +3 dB caps it.
  const push = await play({
    loudness: { integratedLufs: -20, truePeakDbtp: -5 },
  });
  assert.match(push, /liq_amplify="1\.412538"/);
  const blank = await harness({
    PLAYOUT_TARGET_LUFS: " ",
    PLAYOUT_TRUE_PEAK_CEILING_DBTP: "",
  });
  assert.match(
    await blank.play({ loudness: { integratedLufs: -16, truePeakDbtp: -3 } }),
    /liq_amplify="1"/,
  );
});

test("an invalid loudness target or ceiling fails startup", async () => {
  for (const [name, value] of [
    ["PLAYOUT_TARGET_LUFS", "loud"],
    ["PLAYOUT_TARGET_LUFS", "-71"],
    ["PLAYOUT_TARGET_LUFS", "1"],
    ["PLAYOUT_TRUE_PEAK_CEILING_DBTP", "Infinity"],
    ["PLAYOUT_TRUE_PEAK_CEILING_DBTP", "-21"],
    ["PLAYOUT_TRUE_PEAK_CEILING_DBTP", "0.5"],
  ]) {
    await assert.rejects(harness({ [name]: value }), new RegExp(name));
  }
});

const INVALID_SEGUE = [
  ["a non-finite value", { ...SEGUE, cueOutSeconds: Infinity }],
  ["a non-numeric value", { ...SEGUE, fadeInSeconds: "1" }],
  ["a missing value", { ...SEGUE, overlapSeconds: undefined }],
  ["a group that is not an object", null],
  ["a group that is an array", [3, 182.5]],
  ["a negative cue-in", { ...SEGUE, cueInSeconds: -0.1 }],
  ["a cue-in equal to the cue-out", { ...SEGUE, cueInSeconds: 182.5 }],
  ["a cue-in after the cue-out", { ...SEGUE, cueInSeconds: 190 }],
  ["a negative fade-in", { ...SEGUE, fadeInSeconds: -1 }],
  ["a negative fade-out", { ...SEGUE, fadeOutSeconds: -1 }],
  ["a negative overlap", { ...SEGUE, overlapSeconds: -1 }],
  [
    "an overlap longer than the cue span",
    { ...SEGUE, cueInSeconds: 10, cueOutSeconds: 12, overlapSeconds: 2.5 },
  ],
];

for (const [label, segue] of INVALID_SEGUE) {
  test(`drops segue with ${label}, still plays the song and counts the drop`, async () => {
    const { play, dropped } = await harness();
    const push = await play({ segue, loudness: LOUDNESS });
    assert.match(push, /,liq_amplify="0\.630957":https:/);
    assert.doesNotMatch(push, /liq_cue|liq_fade/);
    assert.deepEqual(await dropped(), { loudness: 0, segue: 1 });
  });
}

test("drops segue whose cue-out is past the given duration", async () => {
  const { play, dropped } = await harness();
  assert.equal(await play({ segue: SEGUE, duration: 180 }), TODAY_SONG_PUSH);
  assert.equal(await play({ segue: SEGUE, duration: "190" }), TODAY_SONG_PUSH);
  assert.equal(
    await play({ segue: SEGUE, duration: Number.NaN }),
    TODAY_SONG_PUSH,
  );
  assert.deepEqual(await dropped(), { loudness: 0, segue: 3 });
  // A cue-out exactly at the duration, and an overlap equal to the span, pass.
  const push = await play({
    segue: { ...SEGUE, overlapSeconds: 179.5 },
    duration: 182.5,
  });
  assert.match(push, /liq_cue_out="182\.5"/);
  assert.deepEqual(await dropped(), { loudness: 0, segue: 3 });
});

const INVALID_LOUDNESS = [
  ["a non-finite value", { integratedLufs: Number.NaN, truePeakDbtp: -1 }],
  ["a missing value", { integratedLufs: -14 }],
  ["a group that is not an object", "loud"],
  ["integrated loudness below -70", { integratedLufs: -70.1, truePeakDbtp: -1 }],
  ["integrated loudness above 0", { integratedLufs: 0.1, truePeakDbtp: -1 }],
  ["a true peak above +6", { integratedLufs: -14, truePeakDbtp: 6.1 }],
];

for (const [label, loudness] of INVALID_LOUDNESS) {
  test(`drops loudness with ${label}, still plays the song and counts the drop`, async () => {
    const { play, dropped } = await harness();
    const push = await play({ segue: SEGUE, loudness });
    assert.match(push, /liq_cue_in="3"/);
    assert.doesNotMatch(push, /liq_amplify/);
    assert.deepEqual(await dropped(), { loudness: 1, segue: 0 });
  });
}

test("accepts loudness at its bounds", async () => {
  const { play, dropped } = await harness();
  assert.match(
    await play({ loudness: { integratedLufs: -70, truePeakDbtp: -60 } }),
    /liq_amplify=/,
  );
  assert.match(
    await play({ loudness: { integratedLufs: 0, truePeakDbtp: 6 } }),
    /liq_amplify="0\.158489"/,
  );
  assert.deepEqual(await dropped(), { loudness: 0, segue: 0 });
});

test("song analysis never reaches the intro request", async () => {
  const intro = {
    programId: "program-one",
    playbackId: "intro-42",
    url: "https://example.test/intro.mp3",
    gain: 0.7,
    fadeInSeconds: 0.1,
    fadeOutSeconds: 0.2,
  };
  const plain = await harness();
  await plain.play({}, intro);
  const analysed = await harness();
  await analysed.play({ segue: SEGUE, loudness: LOUDNESS }, intro);
  const introPush = (commands) =>
    commands.find((command) => command.startsWith("intros.push"));
  assert.equal(introPush(analysed.commands), introPush(plain.commands));
  assert.match(introPush(plain.commands), /liq_amplify="0\.7"/);
});

test("the script applies song gain and fades on the song chain only", () => {
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
  assert.ok(
    script.includes(`songs_queue = palazzo_song_queue(id="songs", timeout=29.)
`) &&
      script.includes(`def song_deck(queue, is_open) =
  gated = switch(track_sensitive=false, [({is_open()}, queue)])
  normalized = amplify(override="liq_amplify", 1., gated)
  controlled = amplify(override=null, song_volume, normalized)
  faded = fade.in(duration=0., track_sensitive=true, controlled)
  fade.out(duration=0., track_sensitive=true, faded)
end
deck_a = song_deck(songs_queue, deck_a_open)
deck_b = song_deck(next_queue, deck_b_open)
`) &&
      script.includes(`songs_mixed = add(normalize=false, [deck_a, deck_b])
`),
  );
  // Filler and mixer are as before. Intros and instants (gaulatti/palazzo#52) read their own validated
  // per-item gain: a finite number in [0, 1] from the liq_amplify annotation, otherwise 1.
  assert.ok(
    script.includes(`def item_gain(m) =
  raw = list.assoc(default="", "liq_amplify", m)
  g = float_of_string(default=-1., raw)
  if raw == "" then
    1.
  elsif g >= 0. and g <= 1. then
    g
  else
    id = list.assoc(default="", "palazzo_request_id", m)
    url = list.assoc(default="", "palazzo_url", m)
    log.important(label="item_gain", "ignored an invalid gain for #{id} (#{url}): it is not a number from 0 to 1; the item plays at its own level")
    1.
  end
end
intros_queue = request.queue(id="intros", prefetch=1)
# An intro never puts its file's own tags on the events either (gaulatti/palazzo#60): Palazzo annotates no
# title or artist for an intro, so the ones in its file (intro_started and intro_ended carry them) are
# blanked, as the instants chain does. The song's own title is set by its own track start.
intros_gained = metadata.map(
  id="intros_gain",
  strip=false,
  fun (m) -> [("liq_amplify", string(item_gain(m))), ("title", ""), ("artist", ""), ("song", "")],
  intros_queue
)
intros_per_item = amplify(override="liq_amplify", 1., intros_gained)
intros_faded = fade.in(
  override_duration="palazzo_fade_in",
  duration=0.25,
  track_sensitive=true,
  intros_per_item
)
intros_faded = fade.out(
  override_duration="palazzo_fade_out",
  duration=0.25,
  track_sensitive=true,
  intros_faded
)`),
  );
  assert.ok(
    // gaulatti/palazzo#50: the queue is declared before the song decks, which push an announced spot to it.
    script.includes(`instants_requests = request.queue(id="instants")
`) &&
      script.indexOf(`instants_requests = request.queue(id="instants")`) <
        script.indexOf(`deck_a = song_deck(`) &&
      script.includes(`instants_queue = mksafe(instants_titled)
instant_volume = interactive.float("palazzo_instant_volume", 1.)
instants_per_item = amplify(override="liq_amplify", 1., instants_queue)
instants_controlled = amplify(override=null, instant_volume, instants_per_item)`),
  );
  // #230: the filler is gated by its hold-off, still mksafe'd underneath.
  assert.ok(script.includes("mksafe(filler_playlist))]"));
  assert.ok(
    script.includes(`main_volume = interactive.float("palazzo_main_volume", 1.)
radio = amplify(override=null, main_volume, radio)`),
  );
  assert.equal(script.match(/fade\.in\(/g).length, 2);
  assert.equal(script.match(/fade\.out\(/g).length, 2);
  // The song deck, the intro chain and the instants chain each read liq_amplify, and only those.
  assert.equal(script.match(/override="liq_amplify"/g).length, 3);
});

function snapshot(overrides = {}) {
  return {
    liquidsoap_sequence: 1,
    playing: true,
    playback_request_id: "song-42",
    title: "Song",
    artist: "",
    cover_url: "",
    url: "https://example.test/song.mp3",
    started_at: 1_700_000_000,
    elapsed: 10,
    remaining: 160,
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
    sampled_at: 1_700_000_010,
    ...overrides,
  };
}

function lifecycle(sequence, eventType) {
  return {
    sequence,
    event_type: eventType,
    playback_request_id: "song-42",
    playback_id: "song-42",
    parent_playback_id: "",
    program_id: "program-one",
    title: "Song",
    artist: "",
    cover_url: "",
    url: "https://example.test/song.mp3",
    occurred_at: 1_700_000_000 + sequence,
  };
}

test("reports position relative to the file and one start and end per cued play", async () => {
  const { telemetry, play } = await harness();
  telemetry.setLiquidsoapRunning(true);
  await play({ segue: SEGUE });

  telemetry.apply(snapshot(), [lifecycle(1, "track_started")]);
  // 10 s into the cut audio is 13 s into the file with a 3 s cue-in.
  assert.equal(telemetry.getState().positionSeconds, 13);
  assert.equal(telemetry.getState().remainingSeconds, 160);

  telemetry.apply(snapshot({ liquidsoap_sequence: 2, playing: false }), [
    lifecycle(2, "track_ended"),
  ]);
  assert.equal(telemetry.getState().positionSeconds, 0);
  const types = telemetry.replay.map((event) => event.type);
  assert.equal(types.filter((type) => type === "track.started").length, 1);
  assert.equal(types.filter((type) => type === "track.ended").length, 1);

  // A song without a cue-in reports Liquidsoap's elapsed time unchanged.
  telemetry.apply(
    snapshot({ liquidsoap_sequence: 3, playback_request_id: "other" }),
    [],
  );
  assert.equal(telemetry.getState().positionSeconds, 10);
});

test("keeps cue-ins for a bounded number of recent songs", () => {
  const telemetry = new PlaybackTelemetryService({ get: () => undefined });
  telemetry.rememberSongCueIn("first", 4);
  telemetry.rememberSongCueIn("first", 5);
  for (let index = 0; index < 64; index += 1) {
    telemetry.rememberSongCueIn(`song-${index}`, 1);
  }
  telemetry.apply(snapshot({ playback_request_id: "first" }), []);
  assert.equal(telemetry.getState().positionSeconds, 10);
  telemetry.apply(snapshot({ playback_request_id: "song-63" }), []);
  assert.equal(telemetry.getState().positionSeconds, 11);
});

// gaulatti/palazzo#53: Palazzo's own bound. An edge that would trim more than 10 s is not annotated, so that
// edge plays untrimmed, and it is counted; the other edge is still applied.
test("a cue edge that would trim more than 10 s is not annotated and is counted", async () => {
  const { play, telemetry } = await harness();
  // Head 11 s: not applied; tail 190 - 182.5 = 7.5 s: applied.
  let push = await play({ segue: { ...SEGUE, cueInSeconds: 11, overlapSeconds: 0 }, duration: 190 });
  assert.doesNotMatch(push, /liq_cue_in/);
  assert.match(push, /liq_cue_out="182\.5"/);
  // Head 3 s applied; tail 200 - 182.5 = 17.5 s: not applied.
  push = await play({ segue: SEGUE, duration: 200 });
  assert.match(push, /liq_cue_in="3"/);
  assert.doesNotMatch(push, /liq_cue_out/);
  // No known duration: the tail cannot be bounded here and is applied as sent (Alcantara bounds it).
  push = await play({ segue: SEGUE });
  assert.match(push, /liq_cue_out="182\.5"/);
  const samples = parseExposition(await telemetry.renderMetrics());
  assertBoundedLabels(samples);
  const value = (name, labels) =>
    samples.find((s) => s.name === name && Object.entries(labels).every(([k, v]) => s.labels[k] === v))?.value;
  assert.equal(value('palazzo_song_cue_ignored_total', { edge: 'head', reason: 'bound' }), 1);
  assert.equal(value('palazzo_song_cue_ignored_total', { edge: 'tail', reason: 'bound' }), 1);
  assert.equal(value('palazzo_song_trimmed_seconds_count', { edge: 'tail' }), 1);
  assert.equal(value('palazzo_song_trimmed_seconds_count', { edge: 'head' }), 2);
});
