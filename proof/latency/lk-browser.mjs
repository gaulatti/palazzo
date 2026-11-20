#!/usr/bin/env node
// palazzo#47 WebRTC path, browser end: serves a page that joins the local
// LiveKit room with livekit-client (the browser SDK), subscribes to the
// program track and plays it the way a listener's page would (an <audio>
// element the SDK attaches). The same track is also routed into Web Audio,
// where an AudioWorklet timestamps each click as it leaves the audio graph
// (getOutputTimestamp), on the wall clock. Onsets are posted back here and
// written as JSON lines.
// Usage: lk-browser.mjs <ear.jsonl> <deps-dir> [port]
import { createServer } from 'node:http';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [log, deps, portText = '18081'] = process.argv.slice(2);
const require = createRequire(`${deps}/package.json`);
const { AccessToken } = require('livekit-server-sdk');
const bundle = readFileSync(`${deps}/node_modules/livekit-client/dist/livekit-client.umd.js`);
writeFileSync(log, '');

const worklet = `
class Onsets extends AudioWorkletProcessor {
  constructor() { super(); this.last = -1; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (Math.abs(channel[i]) < 0.4) continue;
      const at = currentTime + i / sampleRate;
      if (at - this.last < 1) continue;
      this.last = at;
      this.port.postMessage(at);
    }
    return true;
  }
}
registerProcessor('onsets', Onsets);
`;

const page = `<!doctype html><meta charset="utf-8"><title>palazzo#47 webrtc ear</title>
<script src="/livekit-client.js"></script>
<button id="go" style="font-size:2em">Listen</button><pre id="out"></pre>
<script>
const out = document.getElementById('out');
let onset = 0;
document.getElementById('go').onclick = async () => {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('/worklet.js');
  const token = await (await fetch('/token')).text();
  const room = new LivekitClient.Room({ adaptiveStream: false, dynacast: false });
  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== 'audio') return;
    // What a listener's page does: the SDK attaches the track to an element.
    // ?noattach leaves the element out (Web Audio alone), to tell what the
    // element costs.
    if (!location.search.includes('noattach')) {
      const element = track.attach();
      element.muted = true; // heard through Web Audio below, not twice
      document.body.appendChild(element);
    }
    const node = new AudioWorkletNode(ctx, 'onsets');
    ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack])).connect(node).connect(ctx.destination);
    node.port.onmessage = ({ data: contextTime }) => {
      const ts = ctx.getOutputTimestamp();
      const graph = performance.timeOrigin + ts.performanceTime + (contextTime - ts.contextTime) * 1000;
      const record = { onset: onset++, ear_ms: graph, output_latency_ms: (ctx.outputLatency || 0) * 1000, base_latency_ms: ctx.baseLatency * 1000 };
      fetch('/ear', { method: 'POST', body: JSON.stringify(record) });
      out.textContent = JSON.stringify(record) + '\\n' + out.textContent;
    };
    out.textContent = 'subscribed\\n';
  });
  await room.connect('ws://127.0.0.1:7880', token, { autoSubscribe: true });
  await ctx.resume();
  out.textContent = 'joined\\n' + out.textContent;
};
</script>`;

createServer(async (req, res) => {
  if (req.url.split('?')[0] === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (req.url === '/livekit-client.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(bundle);
  if (req.url === '/worklet.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(worklet);
  if (req.url === '/token') {
    const token = new AccessToken('devkey', 'secret', { identity: `browser-${Date.now()}` });
    token.addGrant({ roomJoin: true, room: 'proof', canPublish: false, canSubscribe: true });
    return res.writeHead(200, { 'content-type': 'text/plain' }).end(await token.toJwt());
  }
  if (req.url === '/ear' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      appendFileSync(log, body + '\n');
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
}).listen(Number(portText), '127.0.0.1', () => console.log(`webrtc ear page on http://127.0.0.1:${portText}/`));
