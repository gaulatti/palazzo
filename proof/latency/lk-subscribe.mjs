#!/usr/bin/env node
// palazzo#47 WebRTC path, listener end: joins the LiveKit room, subscribes to
// the program track and logs the wall-clock time each click onset comes out
// of libwebrtc's receive path (Opus decode and its NetEq jitter buffer, as a
// browser's WebRTC stack has), one line per click (refractory 1 s).
// Usage: lk-subscribe.mjs <ws-url> <deps-dir> <ear.jsonl>
import { createRequire } from 'node:module';
import { appendFileSync, writeFileSync } from 'node:fs';
const [url, deps, log] = process.argv.slice(2);
const require = createRequire(`${deps}/package.json`);
const { Room, RoomEvent, AudioStream, TrackKind } = require('@livekit/rtc-node');
const { AccessToken } = require('livekit-server-sdk');

writeFileSync(log, '');
const token = new AccessToken('devkey', 'secret', { identity: 'listener' });
token.addGrant({ roomJoin: true, room: 'proof', canPublish: false, canSubscribe: true });
const room = new Room();
const THRESHOLD = 14_000;
let onset = 0;
let last = -Infinity;
room.on(RoomEvent.TrackSubscribed, async (track) => {
  if (track.kind !== TrackKind.KIND_AUDIO) return;
  process.stderr.write('subscribed\n');
  const stream = new AudioStream(track, 48_000, 1);
  for await (const frame of stream) {
    const now = performance.timeOrigin + performance.now();
    const samples = frame.data;
    for (let i = 0; i < samples.length; i += 1) {
      if (Math.abs(samples[i]) < THRESHOLD) continue;
      // The frame was delivered now; this sample sits (length - i) samples
      // before its end.
      const at = now - ((samples.length - i) / 48_000) * 1000;
      if (at - last < 1000) continue;
      last = at;
      appendFileSync(log, JSON.stringify({ onset: onset++, ear_ms: at }) + '\n');
    }
  }
});
await room.connect(url, await token.toJwt(), { autoSubscribe: true, dynacast: false });
process.stderr.write('joined\n');
process.on('SIGTERM', async () => {
  await room.disconnect();
  process.exit(0);
});
