// Records the station's Icecast output from the live point, not from Icecast's burst (gaulatti/palazzo#72).
// Icecast replays burst-size bytes of past audio to a new listener at once (256 KB, about 16 s at 128 kbps,
// since #68), so an ffmpeg -t N recording held mostly the past and ended before the item under test did.
// The burst arrives back to back in a few milliseconds; live audio then arrives one source write at a time,
// a few hundred milliseconds apart. Everything before the first gap of GAP_MS between two chunks is the
// burst and is dropped; the rest is decoded to WAV and stops after the requested seconds.
// Runs inside the station container: node live-recorder.cjs <seconds> <output.wav>
'use strict';
const http = require('node:http');
const { spawn } = require('node:child_process');

const GAP_MS = 150;
const [seconds, output] = process.argv.slice(2);
if (!(Number(seconds) > 0) || !output) {
  console.error('usage: live-recorder.cjs <seconds> <output.wav>');
  process.exit(2);
}

const ffmpeg = spawn(
  'ffmpeg',
  ['-hide_banner', '-nostats', '-loglevel', 'error', '-y', '-f', 'mp3', '-i', 'pipe:0', '-t', seconds, '-c:a', 'pcm_s16le', output],
  { stdio: ['pipe', 'ignore', 'inherit'] },
);
// ffmpeg closes its input once it has the requested seconds; later writes are expected to fail.
ffmpeg.stdin.on('error', () => {});
ffmpeg.on('exit', (code) => process.exit(code ?? 1));

let live = false;
let last = 0;
http
  .get('http://127.0.0.1:8000/stream', (response) => {
    response.on('data', (chunk) => {
      const now = Date.now();
      if (!live && last > 0 && now - last >= GAP_MS) live = true;
      last = now;
      if (live) ffmpeg.stdin.write(chunk);
    });
    response.on('end', () => ffmpeg.stdin.end());
  })
  .on('error', (error) => {
    console.error(`live-recorder: ${error.message}`);
    process.exit(1);
  });
