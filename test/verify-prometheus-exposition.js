const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const {
  assertBoundedLabels,
  parseExposition,
} = require("./prometheus-exposition");

const payload = readFileSync(process.argv[2], "utf8");
const samples = parseExposition(payload);
assertBoundedLabels(samples);
const names = new Set(samples.map((sample) => sample.name));

for (const required of [
  "palazzo_build_info",
  "palazzo_process_cpu_user_seconds_total",
  "palazzo_process_resident_memory_bytes",
  "palazzo_nodejs_eventloop_lag_seconds",
  "palazzo_http_requests_total",
  "palazzo_liquidsoap_running",
  "palazzo_dependency_operations_total",
  "palazzo_dependency_retries_total",
]) {
  assert.ok(names.has(required), `missing required metric ${required}`);
}
