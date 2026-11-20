#!/usr/bin/env node
// palazzo#47: the browser end of the latency proof. Serves one page and, on
// the same origin, proxies Palazzo's public Icecast mount, so the page can
// route a plain <audio> element (the way a listener's browser plays the
// stream) through Web Audio. An AudioWorklet finds each click onset in the
// samples the browser is about to play and maps it to the wall clock with
// AudioContext.getOutputTimestamp(), the moment it leaves the audio graph.
// The page posts every onset here; this process writes them as JSON lines.
// Usage: browser-ear.mjs <ear.jsonl> [port] [upstream]
import { createServer, request } from 'node:http';
import { appendFileSync, writeFileSync } from 'node:fs';

const log = process.argv[2] ?? 'browser-ear.jsonl';
const port = Number(process.argv[3] ?? 18080);
const upstream = new URL(process.argv[4] ?? 'http://127.0.0.1:18000/stream');
writeFileSync(log, '');

const worklet = `
class Onsets extends AudioWorkletProcessor {
  constructor() { super(); this.last = -1; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      if (Math.abs(channel[i]) < 0.45) continue;
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

const page = `<!doctype html><meta charset="utf-8"><title>palazzo#47 ear</title>
<button id="go" style="font-size:2em">Listen</button><pre id="out"></pre>
<script>
const out = document.getElementById('out');
let onset = 0;
document.getElementById('go').onclick = async () => {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/worklet.js');
  const audio = new Audio('/stream?' + Date.now());
  audio.crossOrigin = 'anonymous';
  const node = new AudioWorkletNode(ctx, 'onsets');
  ctx.createMediaElementSource(audio).connect(node).connect(ctx.destination);
  node.port.onmessage = ({ data: contextTime }) => {
    const ts = ctx.getOutputTimestamp();
    // When this sample leaves the graph, on the page's clock, as wall time.
    const graph = performance.timeOrigin + ts.performanceTime + (contextTime - ts.contextTime) * 1000;
    const record = { onset: onset++, ear_ms: graph, output_latency_ms: (ctx.outputLatency || 0) * 1000, base_latency_ms: ctx.baseLatency * 1000 };
    fetch('/ear', { method: 'POST', body: JSON.stringify(record) });
    out.textContent = JSON.stringify(record) + '\\n' + out.textContent;
  };
  await audio.play();
  window.started = performance.timeOrigin + performance.now();
  out.textContent = 'playing\\n';
};
</script>`;

createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  } else if (req.url === '/worklet.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(worklet);
  } else if (req.url === '/ear' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      appendFileSync(log, body + '\n');
      res.writeHead(204).end();
    });
  } else if (req.url.startsWith('/stream')) {
    const proxied = request(upstream, { headers: { 'icy-metadata': '0' } }, (up) => {
      res.writeHead(up.statusCode ?? 502, { 'content-type': up.headers['content-type'] ?? 'audio/mpeg', 'cache-control': 'no-store' });
      up.pipe(res);
    });
    proxied.on('error', () => res.writeHead(502).end());
    req.on('close', () => proxied.destroy());
    proxied.end();
  } else {
    res.writeHead(404).end();
  }
}).listen(port, '127.0.0.1', () => console.log(`ear page on http://127.0.0.1:${port}/`));
