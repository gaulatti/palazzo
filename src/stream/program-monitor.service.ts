import { BadGatewayException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { request } from "node:http";
import { Readable } from "node:stream";
import { Counter, Gauge, Registry } from "prom-client";

/** Relays this appliance's configured Icecast output over its private API. */
@Injectable()
export class ProgramMonitorService {
  private readonly registry = new Registry();
  private readonly sessions = new Counter({
    name: "palazzo_program_monitor_sessions_total",
    help: "Private output monitor connection transitions.",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });
  private readonly active = new Gauge({
    name: "palazzo_program_monitor_connections",
    help: "Active private output monitor connections.",
    registers: [this.registry],
  });

  constructor(private readonly config: ConfigService) {}

  open(signal: AbortSignal): Promise<{ stream: Readable; type: string }> {
    return new Promise((resolve, reject) => {
      let responded = false;
      const upstream = request({
        hostname: "127.0.0.1",
        port: Number(this.config.get("ICECAST_PORT") ?? 8000),
        path: this.config.get<string>("ICECAST_MOUNT") ?? "/stream",
        method: "GET",
        headers: { Accept: "audio/mpeg", "Icy-MetaData": "0" },
        signal,
      });
      const timer = setTimeout(
        () => upstream.destroy(new Error("timeout")),
        8_000,
      );
      upstream.once("error", () => {
        clearTimeout(timer);
        if (responded) return;
        this.sessions.inc({ result: signal.aborted ? "aborted" : "failure" });
        reject(new BadGatewayException("Program audio is unavailable"));
      });
      upstream.once("response", (response) => {
        responded = true;
        clearTimeout(timer);
        const type = response.headers["content-type"] ?? "";
        if (response.statusCode !== 200 || !type.startsWith("audio/")) {
          response.destroy();
          this.sessions.inc({ result: "failure" });
          reject(new BadGatewayException("Program audio is unavailable"));
          return;
        }
        this.sessions.inc({ result: "opened" });
        this.active.inc();
        response.once("close", () => {
          this.active.dec();
          this.sessions.inc({
            result: signal.aborted
              ? "aborted"
              : response.complete
                ? "closed"
                : "failure",
          });
          upstream.destroy();
        });
        resolve({ stream: response, type });
      });
      upstream.end();
    });
  }

  renderMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
