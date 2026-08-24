const assert = require("node:assert/strict");
const test = require("node:test");
const {
  PlaybackTelemetryService,
} = require("../dist/stream/playback-telemetry.service.js");
const { StreamService } = require("../dist/stream/stream.service.js");

function streamService() {
  const config = { get: () => undefined };
  const telemetry = new PlaybackTelemetryService(config);
  const service = new StreamService(config, telemetry, {
    initialize: async () => undefined,
    activePlaylistPath: '/run/palazzo/active-filler.m3u',
  });
  const commands = [];
  service.telnet = {
    send: async (command) => {
      commands.push(command);
      return "ok";
    },
    close: () => undefined,
  };
  return { service, commands };
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
  assert.equal(commands[0], "songs.flush_and_skip");
  assert.match(commands[1], /palazzo_request_id="alcantara-request-42"/);
  assert.match(commands[1], /cover_url="https:\/\/example\.test\/cover\.jpg"/);
  assert.doesNotMatch(commands[1], /remaining/);
});

test("generates and returns an ID for backward-compatible callers", async () => {
  const { service, commands } = streamService();
  const accepted = await service.playInstant({
    url: "https://example.test/instant.mp3",
  });

  assert.match(accepted.playbackRequestId, /^[0-9a-f-]{36}$/);
  assert.match(commands[0], new RegExp(accepted.playbackRequestId));
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
    "songs.flush_and_skip",
    "instants.flush_and_skip",
  ]);
});

test("song Stop clears active and queued songs", async () => {
  const { service, commands } = streamService();

  await service.stopSong();

  assert.deepEqual(commands, ["songs.flush_and_skip"]);
});

test("serializes multi-command playback operations against lifecycle queue clearing", async () => {
  const { service, commands } = streamService();

  await Promise.all([
    service.playSong({ url: "https://example.test/song.mp3" }),
    service.clearProgramMaterial(),
  ]);

  assert.equal(commands[0], "songs.flush_and_skip");
  assert.match(commands[1], /^songs\.push /);
  assert.deepEqual(commands.slice(2), [
    "songs.flush_and_skip",
    "instants.flush_and_skip",
  ]);
});
