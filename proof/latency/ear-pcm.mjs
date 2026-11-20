#!/usr/bin/env node
// palazzo#47: reads 48 kHz mono s16le on stdin and logs the wall-clock time
// each click's onset arrives (one line per click, refractory 1 s).
import { appendFileSync, writeFileSync } from 'node:fs';
const log = process.argv[2] ?? 'ear.jsonl';
// --player: time each sample when a real-time player would play it (from the
// first sample's arrival, at 48 kHz, re-based after any underrun), instead of
// when it arrived. A player starts at the beginning of Icecast's connect burst,
// so this is what a listener hears; arrival time is the live edge.
const player = process.argv.includes('--player');
let playStart = null;
let played = 0;
writeFileSync(log, '');
const RATE = 48_000, THRESHOLD = 16_000;
let last = -Infinity, carry = Buffer.alloc(0), onset = 0;
process.stdin.on('data', (chunk) => {
  const now = performance.timeOrigin + performance.now();
  const buf = Buffer.concat([carry, chunk]);
  const samples = Math.floor(buf.length / 2);
  if (player) {
    if (playStart === null) playStart = now;
    // Underrun: the queue ran dry before this chunk arrived; play resumes now.
    if (playStart + (played / RATE) * 1000 < now - ((samples) / RATE) * 1000)
      playStart = now - (played / RATE) * 1000;
  }
  for (let i = 0; i < samples; i += 1) {
    if (Math.abs(buf.readInt16LE(i * 2)) < THRESHOLD) continue;
    // Arrival: this sample arrived (samples - i) samples before the chunk end.
    // Player: it plays at its position in the stream after playback started.
    const at = player
      ? playStart + ((played + i) / RATE) * 1000
      : now - ((samples - i) / RATE) * 1000;
    if (at - last < 1000) continue;
    last = at;
    appendFileSync(log, JSON.stringify({ onset: onset++, ear_ms: at }) + '\n');
  }
  played += samples;
  carry = buf.subarray(samples * 2);
});
