#!/usr/bin/env node
// palazzo#47 proof harness, voice side: pushes a paced 48 kHz mono PCM stream
// of silence with one full-scale 2 ms click every SPACING_MS into an encoder
// (ffmpeg) aimed at the input under test, and logs the wall-clock time each
// click's first sample is handed to the encoder. That moment stands in for
// the voice leaving the microphone.
//
//   node push-clicks.mjs --clicks 12 --spacing 10000 --log sent.jsonl -- \
//     ffmpeg -f s16le -ar 48000 -ac 1 -i - -c:a aac -f flv rtmp://127.0.0.1:1935/live/test
//
// Everything after `--` is the encoder command; it reads PCM on stdin.
import { spawn } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split < 0) throw new Error('usage: push-clicks.mjs [options] -- <encoder command>');
const opts = Object.fromEntries(
  args.slice(0, split).join(' ').split('--').filter(Boolean).map((pair) => pair.trim().split(/\s+/)),
);
const clicks = Number(opts.clicks ?? 12);
const spacingMs = Number(opts.spacing ?? 10_000);
const leadMs = Number(opts.lead ?? 3_000);
// Nothing is written until the downstream has started, so its start-up time
// never sits in the pipe as a backlog that delays every click after it.
const startDelayMs = Number(opts['start-delay'] ?? 0);
const log = opts.log ?? 'sent.jsonl';
const RATE = 48_000;
const CHUNK_MS = 10; // pacing granularity
const CHUNK = (RATE * CHUNK_MS) / 1000;
const CLICK_SAMPLES = (RATE * 2) / 1000;

writeFileSync(log, '');
const [cmd, ...cmdArgs] = args.slice(split + 1);
const encoder = spawn(cmd, cmdArgs, { stdio: ['pipe', 'inherit', 'inherit'] });

const clickAt = (i) => Math.round(((leadMs + i * spacingMs) * RATE) / 1000);
const totalSamples = clickAt(clicks - 1) + RATE * 3;
let written = 0;
let t0 = 0;
const origin = performance.timeOrigin;
await new Promise((resolve) => setTimeout(resolve, startDelayMs));
t0 = performance.now();

function chunk() {
  const buf = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < clicks; i += 1) {
    const start = clickAt(i);
    if (start >= written + CHUNK || start + CLICK_SAMPLES <= written) continue;
    for (let s = Math.max(start, written); s < Math.min(start + CLICK_SAMPLES, written + CHUNK); s += 1)
      buf.writeInt16LE(s - start < CLICK_SAMPLES / 2 ? 32_000 : -32_000, (s - written) * 2);
    // The click's own scheduled time: its first sample is handed over at or
    // after it (a chunk is written only once its last sample is due).
    if (start >= written)
      appendFileSync(
        log,
        JSON.stringify({ click: i, sent_ms: origin + t0 + (start / RATE) * 1000 }) + '\n',
      );
  }
  written += CHUNK;
  return buf;
}

// Real-time pacing: write a chunk whenever its due time has come.
const tick = setInterval(() => {
  const due = ((performance.now() - t0) * RATE) / 1000;
  while (written + CHUNK <= due && written < totalSamples)
    encoder.stdin.write(chunk());
  if (written >= totalSamples) {
    clearInterval(tick);
    encoder.stdin.end();
    // A live input (Liquidsoap's) never ends on its own: stop the downstream
    // once the last click has had time to come out.
    setTimeout(() => encoder.kill('SIGTERM'), Number(opts.drain ?? 4000));
  }
}, 2);
encoder.on('exit', (code) => process.exit(code ?? 0));
