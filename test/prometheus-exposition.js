const SAMPLE_PATTERN =
  /^(?<name>[a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(?<labels>.*)\})? (?<value>(?:[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)|NaN|Nan|[-+]?Inf)$/;
const LABEL_PATTERN =
  /(?<key>[a-zA-Z_][a-zA-Z0-9_]*)="(?<value>(?:\\.|[^"\\])*)"/gy;

function parseExposition(payload) {
  const samples = [];
  const seen = new Set();
  for (const line of payload.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = SAMPLE_PATTERN.exec(line);
    if (!match) throw new Error(`Invalid Prometheus sample: ${line}`);
    const labels = {};
    const source = match.groups.labels ?? "";
    let cursor = 0;
    while (cursor < source.length) {
      LABEL_PATTERN.lastIndex = cursor;
      const label = LABEL_PATTERN.exec(source);
      if (!label) throw new Error(`Invalid Prometheus labels: ${source}`);
      labels[label.groups.key] = label.groups.value;
      cursor = LABEL_PATTERN.lastIndex;
      if (cursor < source.length) {
        if (source[cursor] !== ",") {
          throw new Error(`Invalid Prometheus labels: ${source}`);
        }
        cursor += 1;
      }
    }
    const identity = `${match.groups.name}\t${JSON.stringify(
      Object.entries(labels).sort(),
    )}`;
    if (seen.has(identity))
      throw new Error(`Duplicate Prometheus series: ${identity}`);
    seen.add(identity);
    samples.push({
      name: match.groups.name,
      labels,
      value: Number(match.groups.value),
    });
  }
  return samples;
}

function assertBoundedLabels(samples) {
  const fixed = {
    dependency: new Set(["liquidsoap"]),
    event: new Set(["ended", "started"]),
    method: new Set([
      "DELETE",
      "GET",
      "HEAD",
      "OPTIONS",
      "OTHER",
      "PATCH",
      "POST",
      "PUT",
    ]),
    operation: new Set([
      "process_exit",
      "process_restart",
      "telnet_connect",
      "telemetry_poll",
    ]),
    outcome: new Set(["conflict", "failure", "success"]),
    result: new Set(["failure", "parse_failure", "success"]),
    route: new Set([
      "/instant",
      "/instant/stop",
      "/metrics",
      "/mixer",
      "/playback/events",
      "/playback/state",
      "/proxy-audio",
      "/song",
      "/song/stop",
      "/status",
      "/v1/programs/:programId/automation",
      "/v1/programs/:programId/automation/start",
      "/v1/programs/:programId/automation/stop",
      "/v1/programs/:programId/fillers/:version",
      "unmatched",
    ]),
    service: new Set(["palazzo"]),
    status: new Set(["1xx", "2xx", "3xx", "4xx", "5xx", "other"]),
    type: new Set(["levels", "other"]),
  };
  const runtimeLabels = new Set([
    "kind",
    "le",
    "major",
    "minor",
    "patch",
    "space",
    "version",
  ]);
  for (const sample of samples) {
    for (const [name, value] of Object.entries(sample.labels)) {
      if (fixed[name]) {
        if (!fixed[name].has(value)) {
          throw new Error(`Unbounded ${name} label value: ${value}`);
        }
      } else if (runtimeLabels.has(name)) {
        if (!/^[A-Za-z0-9+._-]{1,64}$/.test(value)) {
          throw new Error(`Unbounded runtime label value: ${value}`);
        }
      } else {
        throw new Error(`Unbounded label name: ${name}`);
      }
    }
  }
}

module.exports = { assertBoundedLabels, parseExposition };
