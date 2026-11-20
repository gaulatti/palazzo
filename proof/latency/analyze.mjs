#!/usr/bin/env node
// palazzo#47: pairs sent.jsonl (push-clicks.mjs) with ear.jsonl (listener.html)
// by order, after dropping ear onsets before the first click, and prints
// voice-to-ear per click plus median, min and max.
//   node analyze.mjs sent.jsonl ear.jsonl
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sent = read(process.argv[2]);
const ear = read(process.argv[3]);
// Each onset belongs to the latest click sent before it; a click with no onset
// before the next click is missed.
const rows = [];
for (const [i, s] of sent.entries()) {
  const next = sent[i + 1]?.sent_ms ?? Infinity;
  const hit = ear.find((e) => e.ear_ms >= s.sent_ms && e.ear_ms < next);
  if (hit) rows.push({ click: s.click, latency_ms: hit.ear_ms - s.sent_ms });
}
const ms = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
const median = ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2;
console.table(rows.map((r) => ({ ...r, latency_ms: Math.round(r.latency_ms) })));
console.log(JSON.stringify({ n: ms.length, median_ms: Math.round(median), min_ms: Math.round(ms[0]), max_ms: Math.round(ms.at(-1)), missed: sent.length - ms.length }));
