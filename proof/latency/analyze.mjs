#!/usr/bin/env node
// palazzo#47: pairs sent.jsonl (push-clicks.mjs) with ear.jsonl (listener.html)
// by order, after dropping ear onsets before the first click, and prints
// voice-to-ear per click plus median, min and max.
//   node analyze.mjs sent.jsonl ear.jsonl
import { readFileSync } from 'node:fs';
const read = (f) => readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sent = read(process.argv[2]);
const ear = read(process.argv[3]).filter((e) => e.ear_ms >= sent[0].sent_ms);
const spacing = sent.length > 1 ? sent[1].sent_ms - sent[0].sent_ms : Infinity;
const rows = sent.slice(0, ear.length).map((s, i) => ({ click: s.click, latency_ms: ear[i].ear_ms - s.sent_ms }));
if (rows.some((r) => r.latency_ms >= spacing)) throw new Error('a latency exceeds the click spacing: pairing is ambiguous, widen --spacing');
const ms = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
const median = ms.length % 2 ? ms[(ms.length - 1) / 2] : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2;
console.table(rows.map((r) => ({ ...r, latency_ms: Math.round(r.latency_ms) })));
console.log(JSON.stringify({ n: ms.length, median_ms: Math.round(median), min_ms: Math.round(ms[0]), max_ms: Math.round(ms.at(-1)), missed: sent.length - ms.length }));
