const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, readFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { PlaybackTelemetryService } = require("../dist/stream/playback-telemetry.service.js");
const { StreamService } = require("../dist/stream/stream.service.js");
const { cueOutSeconds } = require("../dist/stream/trailing-silence.js");
const { identityRelay } = require("./media-relay-stub");

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

// Real ffmpeg, real probe: a 1.0 s tone followed by 0.4 s of digital silence is
// cued out at the last audio; a clip without trailing silence is left whole.
test("measures real trailing digital silence and cues the item out at the last audio", { skip: !hasFfmpeg }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "palazzo-silence-"));
  const tail = join(dir, "tail.wav");
  const whole = join(dir, "whole.wav");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.0", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono:d=0.4", "-filter_complex", "[0][1]concat=n=2:v=0:a=1", "-ar", "44100", "-ac", "1", tail]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.0", "-ar", "44100", "-ac", "1", whole]);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "audio/wav" });
    res.end(readFileSync(req.url === "/tail.wav" ? tail : whole));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = { get: () => undefined };
  const service = new StreamService(config, new PlaybackTelemetryService(config), { initialize: async () => undefined, activePlaylistPath: "/x" }, identityRelay);
  t.after(() => service.onModuleDestroy());
  const base = `http://127.0.0.1:${server.address().port}`;
  const measured = await service.trailingSilenceProbe(`${base}/tail.wav`, 10_000);
  const cue = cueOutSeconds(measured);
  assert.ok(Math.abs(cue - 1.0) < 0.05, `cue-out ${cue} should be the last audio (about 1.0 s)`);
  assert.equal(cueOutSeconds(await service.trailingSilenceProbe(`${base}/whole.wav`, 10_000)), null);
});
