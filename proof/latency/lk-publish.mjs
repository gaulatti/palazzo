#!/usr/bin/env node
// palazzo#47 WebRTC path: reads 48 kHz mono s16le on stdin (Liquidsoap's
// output) and publishes it to a LiveKit room as a microphone track, 10 ms per
// frame, as fast as it arrives (Liquidsoap paces it in real time).
// Usage: lk-publish.mjs <ws-url> <deps-dir> [queue_ms]
import { createRequire } from 'node:module';
const [url, deps, queueMs = '100'] = process.argv.slice(2);
const require = createRequire(`${deps}/package.json`);
const { Room, AudioSource, LocalAudioTrack, AudioFrame, TrackPublishOptions, TrackSource } = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');

const token = new AccessToken('devkey', 'secret', { identity: 'program' });
token.addGrant({ roomJoin: true, room: 'proof', canPublish: true, canSubscribe: false });
const room = new Room();
await room.connect(url, await token.toJwt(), { autoSubscribe: false, dynacast: false });
const source = new AudioSource(48_000, 1, Number(queueMs));
const track = LocalAudioTrack.createAudioTrack('program', source);
const options = new TrackPublishOptions();
options.source = TrackSource.SOURCE_MICROPHONE;
await room.localParticipant.publishTrack(track, options);
process.stderr.write('published\n');

const FRAME = 480; // 10 ms at 48 kHz
// A live publisher stays at the live edge: when more than MAX_BACKLOG frames
// wait (Liquidsoap hands its start-up buffer over at once), the backlog is
// cut back to KEEP_BACKLOG instead of being played late forever. Ordinary
// output jitter (Liquidsoap writes in bursts) stays under MAX_BACKLOG and is
// never dropped. Counted on stderr.
const MAX_BACKLOG = Number(process.env.MAX_BACKLOG ?? 25);
const KEEP_BACKLOG = 4;
const backlog = [];
let dropped = 0;
let pumping = false;
let pending = Buffer.alloc(0);
async function pump() {
  if (pumping) return;
  pumping = true;
  while (backlog.length) await source.captureFrame(backlog.shift());
  pumping = false;
}
process.stdin.on('data', (chunk) => {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= FRAME * 2) {
    const bytes = pending.subarray(0, FRAME * 2);
    pending = pending.subarray(FRAME * 2);
    const samples = new Int16Array(FRAME);
    for (let i = 0; i < FRAME; i += 1) samples[i] = bytes.readInt16LE(i * 2);
    backlog.push(new AudioFrame(samples, 48_000, 1, FRAME));
    if (backlog.length > MAX_BACKLOG) dropped += backlog.splice(0, backlog.length - KEEP_BACKLOG).length;
  }
  void pump();
});
const chain = { then: (fn) => new Promise((resolve) => { const wait = () => (pumping || backlog.length ? setTimeout(wait, 10) : resolve(fn())); wait(); }) };
process.stdin.on('end', async () => {
  await chain.then(() => undefined);
  process.stderr.write(`dropped ${dropped} frames\n`);
  await room.disconnect();
  process.exit(0);
});
