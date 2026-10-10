const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const {
  ProgramMonitorService,
} = require("../dist/stream/program-monitor.service");
const { StreamController } = require("../dist/stream/stream.controller");
const { EventEmitter } = require("node:events");

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const service = new ProgramMonitorService({
    get: (key) =>
      ({
        ICECAST_PORT: server.address().port,
        ICECAST_MOUNT: "/custom-output",
      })[key],
  });
  return {
    service,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("streams configured Icecast bytes incrementally, closes on cancellation and exposes bounded metrics", async () => {
  let closed;
  const disconnected = new Promise((resolve) => (closed = resolve));
  const { service, close } = await fixture((req, res) => {
    assert.equal(req.url, "/custom-output");
    assert.equal(req.headers["icy-metadata"], "0");
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.write(Buffer.from([255, 251, 144, 0]));
    res.once("close", closed);
  });
  const abort = new AbortController();
  const { stream, type } = await service.open(abort.signal);
  stream.on("error", () => {});
  assert.equal(type, "audio/mpeg");
  const chunk = await new Promise((resolve) => stream.once("data", resolve));
  assert.deepEqual(chunk, Buffer.from([255, 251, 144, 0]));
  abort.abort();
  await disconnected;
  await new Promise((resolve) => setImmediate(resolve));
  const metrics = await service.renderMetrics();
  assert.match(metrics, /palazzo_program_monitor_connections 0/);
  assert.match(metrics, /sessions_total\{result="opened"\} 1/);
  assert.match(metrics, /sessions_total\{result="aborted"\} 1/);
  assert.doesNotMatch(metrics, /custom-output|127\.0\.0\.1/);
  const {
    parseExposition,
    assertBoundedLabels,
  } = require("./prometheus-exposition");
  assertBoundedLabels(parseExposition(metrics));
  for (const sample of parseExposition(metrics)) {
    if (sample.name === "palazzo_program_monitor_sessions_total") {
      assert.deepEqual(Object.keys(sample.labels), ["result"]);
      assert.ok(
        ["opened", "closed", "failure", "aborted"].includes(
          sample.labels.result,
        ),
      );
    }
  }
  await close();
});

test("fails explicitly for missing mounts and non-audio upstream responses", async () => {
  for (const [status, type] of [
    [404, "audio/mpeg"],
    [200, "text/html"],
  ]) {
    const { service, close } = await fixture((_req, res) => {
      res.writeHead(status, { "Content-Type": type });
      res.end("unavailable");
    });
    await assert.rejects(
      service.open(new AbortController().signal),
      /Program audio is unavailable/,
    );
    assert.match(
      await service.renderMetrics(),
      /sessions_total\{result="failure"\} 1/,
    );
    await close();
  }
});

test("program route refuses another station and binds upstream cancellation to client disconnect", async () => {
  let signal;
  const { Readable } = require("node:stream");
  const controller = new StreamController(
    {},
    {
      assertProgram: (id) => {
        if (id !== "station") throw new Error("wrong program");
      },
    },
    {},
    {
      open: async (s) => {
        signal = s;
        return { stream: new Readable({ read() {} }), type: "audio/mpeg" };
      },
    },
  );
  const reply = { raw: new EventEmitter() };
  await assert.rejects(
    controller.programAudio("other", reply),
    /wrong program/,
  );
  assert.equal(signal, undefined);
  const output = await controller.programAudio("station", reply);
  assert.equal(output.getHeaders().type, "audio/mpeg");
  reply.raw.emit("close");
  assert.equal(signal.aborted, true);
  output.getStream().destroy();
});

test("the Fastify route returns live audio and exposes the actual collector after disconnect", async () => {
  const { Module, NotFoundException } = require("@nestjs/common");
  const { NestFactory } = require("@nestjs/core");
  const { FastifyAdapter } = require("@nestjs/platform-fastify");
  const { StreamService } = require("../dist/stream/stream.service");
  const {
    BroadcastLifecycleService,
  } = require("../dist/stream/broadcast-lifecycle.service");
  const { FillerStoreService } = require("../dist/stream/filler-store.service");
  let disconnected;
  const closed = new Promise((resolve) => (disconnected = resolve));
  const { service, close } = await fixture((_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/mpeg" });
    res.write(Buffer.from([255, 251, 144, 0]));
    res.once("close", disconnected);
  });
  class MonitorFixture {}
  Module({
    controllers: [StreamController],
    providers: [
      { provide: ProgramMonitorService, useValue: service },
      {
        provide: StreamService,
        useValue: { telemetry: { renderMetrics: async () => "" } },
      },
      {
        provide: BroadcastLifecycleService,
        useValue: {
          assertProgram: (id) => {
            if (id !== "station") throw new NotFoundException();
          },
        },
      },
      { provide: FillerStoreService, useValue: { renderMetrics: () => "" } },
    ],
  })(MonitorFixture);
  const app = await NestFactory.create(MonitorFixture, new FastifyAdapter(), {
    logger: false,
  });
  await app.listen(0, "127.0.0.1");
  const origin = await app.getUrl();
  assert.equal(
    (await fetch(origin + "/v1/programs/other/output/audio")).status,
    404,
  );
  const abort = new AbortController();
  const response = await fetch(origin + "/v1/programs/station/output/audio", {
    signal: abort.signal,
  });
  assert.equal(response.headers.get("content-type"), "audio/mpeg");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.deepEqual(
    Array.from((await response.body.getReader().read()).value),
    [255, 251, 144, 0],
  );
  abort.abort();
  await closed;
  const payload = await (await fetch(origin + "/metrics")).text();
  const {
    parseExposition,
    assertBoundedLabels,
  } = require("./prometheus-exposition");
  assertBoundedLabels(parseExposition(payload));
  assert.match(payload, /palazzo_program_monitor_connections 0/);
  assert.match(payload, /sessions_total\{result="aborted"\} 1/);
  await app.close();
  await close();
});
