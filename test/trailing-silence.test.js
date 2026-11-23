const assert = require("node:assert/strict");
const test = require("node:test");
const { parseTrailingSilence, cueOutSeconds } = require("../dist/stream/trailing-silence.js");

const head = "  Duration: 00:00:02.60, start: 0.000000, bitrate: 128 kb/s\n";

test("reads a trailing silence that runs to the end of the file", () => {
  const out = head + "[silencedetect @ 0x1] silence_start: 2.004014\n[silencedetect @ 0x1] silence_end: 2.6 | silence_duration: 0.595986\n";
  const m = parseTrailingSilence(out);
  assert.equal(m.durationSeconds, 2.6);
  assert.ok(Math.abs(m.trailingSilenceSeconds - 0.595986) < 1e-6);
});

test("reads an open-ended trailing silence", () => {
  const m = parseTrailingSilence(head + "silence_start: 2.1\n");
  assert.ok(Math.abs(m.trailingSilenceSeconds - 0.5) < 1e-6);
});

test("ignores silence in the middle of the file", () => {
  const m = parseTrailingSilence(head + "silence_start: 0.5\nsilence_end: 1.0 | silence_duration: 0.5\n");
  assert.equal(m.trailingSilenceSeconds, 0);
});

test("falls back to the last progress time when the file carries no duration", () => {
  const m = parseTrailingSilence("Duration: N/A\nsilence_start: 1.0\nsize=N/A time=00:00:01.40 bitrate=N/A\rsize=N/A time=00:00:01.40 bitrate=N/A\n");
  assert.equal(m.durationSeconds, 1.4);
  assert.ok(Math.abs(m.trailingSilenceSeconds - 0.4) < 1e-6);
});

test("refuses output without a duration", () => {
  assert.throws(() => parseTrailingSilence("silence_start: 1\n"));
});

test("caps the trim at one second and ignores silence under 50 ms", () => {
  assert.equal(cueOutSeconds({ durationSeconds: 10, trailingSilenceSeconds: 4 }), 9);
  assert.equal(cueOutSeconds({ durationSeconds: 2.6, trailingSilenceSeconds: 0.596 }), 2.004);
  assert.equal(cueOutSeconds({ durationSeconds: 3, trailingSilenceSeconds: 0.01 }), null);
  assert.equal(cueOutSeconds({ durationSeconds: 0.5, trailingSilenceSeconds: 0.5 }), null);
});
