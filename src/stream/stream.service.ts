import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildLiquidsoapScript } from "./liquidsoap-script";
import { FillerStoreService } from "./filler-store.service";
import { LiquidsoapTelnetClient } from "./liquidsoap-telnet.client";
import {
  LiquidsoapLifecycleEvent,
  LiquidsoapSnapshot,
  PlaybackTelemetryService,
} from "./playback-telemetry.service";

const execFileAsync = promisify(execFile);

export interface SongPayload {
  url: string;
  title?: string;
  artist?: string;
  coverUrl?: string;
  playbackRequestId?: string;
}

export interface InstantPayload {
  url: string;
  volume?: number;
  playbackRequestId?: string;
}

export interface MixerPayload {
  mainVolume?: number;
  songVolume?: number;
  instantVolume?: number;
  songMuted?: boolean;
  instantMuted?: boolean;
}

export interface MixerState {
  mainVolume: number;
  songVolume: number;
  instantVolume: number;
  songMuted: boolean;
  instantMuted: boolean;
}

export interface PlaybackRequestAccepted {
  ok: true;
  playbackRequestId: string;
}

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private readonly telnetPort = 14000;
  private readonly startedAt = Date.now();
  private readonly telnet: LiquidsoapTelnetClient;
  private process: ChildProcess | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private restartAttempt = 0;
  private shuttingDown = false;
  private pollInFlight = false;
  private operationTail: Promise<void> = Promise.resolve();
  private mixerState: MixerState = {
    mainVolume: 1,
    songVolume: 1,
    instantVolume: 1,
    songMuted: false,
    instantMuted: false,
  };

  constructor(
    private readonly config: ConfigService,
    readonly telemetry: PlaybackTelemetryService,
    private readonly fillerStore: FillerStoreService,
  ) {
    this.telnet = new LiquidsoapTelnetClient({
      port: this.telnetPort,
      onReconnect: () => this.telemetry.countReconnect(),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.fillerStore.initialize();
    const mount = this.config.get<string>("ICECAST_MOUNT") ?? "/stream";
    const port = Number(this.config.get<string>("ICECAST_PORT") ?? 8000);
    const password =
      this.config.get<string>("ICECAST_SOURCE_PASSWORD") ?? "hackme";
    const streamName = this.config.get<string>("STREAM_NAME") ?? "Palazzo";
    const genre = this.config.get<string>("STREAM_GENRE") ?? "Various";
    const bitrate = Number(this.config.get<string>("BITRATE") ?? 128);
    const rtmpUrl = this.config.get<string>("RTMP_URL") || undefined;

    const script = buildLiquidsoapScript({
      telnetPort: this.telnetPort,
      icecastPort: port,
      icecastPassword: password,
      mount,
      streamName,
      genre,
      bitrate,
      rtmpUrl,
      fillerPlaylistPath: this.fillerStore.activePlaylistPath,
    });
    const directory = "/tmp/palazzo";
    const scriptPath = join(directory, "stream.liq");
    await mkdir(directory, { recursive: true });
    await writeFile(scriptPath, script, "utf8");

    // Validate the exact environment-specific script with the bundled engine
    // before starting the long-lived process.
    await execFileAsync("liquidsoap", ["--check", scriptPath], {
      timeout: 30_000,
    });

    this.startLiquidsoap(scriptPath);

    const configuredHz = Number(
      this.config.get<string>("TELEMETRY_LEVEL_HZ") ?? 10,
    );
    const levelHz = Math.max(
      1,
      Math.min(10, Number.isFinite(configuredHz) ? configuredHz : 10),
    );
    this.pollTimer = setInterval(
      () => void this.pollTelemetry(),
      Math.ceil(1_000 / levelHz),
    );
    this.pollTimer.unref();
    void this.pollTelemetry();
    this.logger.log(`Liquidsoap started, mount=${mount}`);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.telnet.close();
    this.telemetry.shutdown();
    this.telemetry.setLiquidsoapRunning(false);
    this.process?.kill();
  }

  getStatus() {
    return {
      mount: this.config.get("ICECAST_MOUNT") ?? "/stream",
      streamName: this.config.get("STREAM_NAME") ?? "Palazzo",
      running: this.process !== null && this.process.exitCode === null,
      uptime: Date.now() - this.startedAt,
      filler: this.fillerStore.getRuntimeState(),
      playback: this.telemetry.getState(),
    };
  }

  async playSong(data: SongPayload): Promise<PlaybackRequestAccepted> {
    return this.serializeOperation(async () => {
      const playbackRequestId = data.playbackRequestId?.trim() || randomUUID();
      const uri = this.annotatedUri(data.url, {
        palazzo_request_id: playbackRequestId,
        palazzo_url: data.url,
        title: data.title ?? "",
        artist: data.artist ?? "",
        cover_url: data.coverUrl ?? "",
      });
      await this.telnet.send("songs.flush_and_skip");
      await this.telnet.send(`songs.push ${uri}`);
      this.logger.log({
        event: "song.request.accepted",
        playbackRequestId,
        title: data.title ?? null,
        artist: data.artist ?? null,
        coverUrl: data.coverUrl ?? null,
      });
      return { ok: true, playbackRequestId };
    });
  }

  async stopSong(): Promise<void> {
    await this.serializeOperation(async () => {
      await this.telnet.send("songs.flush_and_skip");
    });
  }

  async playInstant(data: InstantPayload): Promise<PlaybackRequestAccepted> {
    return this.serializeOperation(async () => {
      const playbackRequestId = data.playbackRequestId?.trim() || randomUUID();
      const uri = this.annotatedUri(data.url, {
        palazzo_request_id: playbackRequestId,
        palazzo_url: data.url,
        palazzo_kind: "instant",
        ...(data.volume === undefined
          ? {}
          : { liq_amplify: String(this.normalizeGain(data.volume, "volume")) }),
      });
      await this.telnet.send(`instants.push ${uri}`);
      this.logger.log({
        event: "instant.request.accepted",
        playbackRequestId,
      });
      return { ok: true, playbackRequestId };
    });
  }

  async stopAllInstants(): Promise<void> {
    await this.serializeOperation(async () => {
      await this.telnet.send("instants.skip").catch(() => undefined);
    });
  }

  async clearProgramMaterial(): Promise<void> {
    await this.serializeOperation(async () => {
      const results = await Promise.allSettled([
        this.telnet.send("songs.flush_and_skip"),
        this.telnet.send("instants.flush_and_skip"),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) throw failure.reason;
    });
  }

  getMixer(): MixerState {
    return { ...this.mixerState };
  }

  async updateMixer(data: MixerPayload): Promise<MixerState> {
    const next: MixerState = {
      mainVolume: this.optionalGain(
        data.mainVolume,
        "mainVolume",
        this.mixerState.mainVolume,
      ),
      songVolume: this.optionalGain(
        data.songVolume,
        "songVolume",
        this.mixerState.songVolume,
      ),
      instantVolume: this.optionalGain(
        data.instantVolume,
        "instantVolume",
        this.mixerState.instantVolume,
      ),
      songMuted: this.optionalBoolean(
        data.songMuted,
        "songMuted",
        this.mixerState.songMuted,
      ),
      instantMuted: this.optionalBoolean(
        data.instantMuted,
        "instantMuted",
        this.mixerState.instantMuted,
      ),
    };

    await this.serializeOperation(async () => {
      await this.telnet.send(
        `var.set palazzo_main_volume = ${next.mainVolume}`,
      );
      await this.telnet.send(
        `var.set palazzo_song_volume = ${next.songMuted ? 0 : next.songVolume}`,
      );
      await this.telnet.send(
        `var.set palazzo_instant_volume = ${next.instantMuted ? 0 : next.instantVolume}`,
      );
      this.mixerState = next;
    });
    return this.getMixer();
  }

  private optionalGain(
    value: unknown,
    field: string,
    fallback: number,
  ): number {
    return value === undefined ? fallback : this.normalizeGain(value, field);
  }

  private normalizeGain(value: unknown, field: string): number {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1
    ) {
      throw new BadRequestException(
        `${field} must be a number between 0 and 1`,
      );
    }
    return value;
  }

  private optionalBoolean(
    value: unknown,
    field: string,
    fallback: boolean,
  ): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== "boolean") {
      throw new BadRequestException(`${field} must be a boolean`);
    }
    return value;
  }

  private startLiquidsoap(scriptPath: string): void {
    const child = spawn("liquidsoap", [scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.process = child;
    this.telemetry.setLiquidsoapRunning(true);
    child.stdout?.on("data", (data: Buffer) =>
      this.logger.debug(data.toString().trim()),
    );
    child.stderr?.on("data", (data: Buffer) =>
      this.logger.debug(data.toString().trim()),
    );
    child.on("error", (error) =>
      this.logger.error(`Liquidsoap process error: ${error.message}`),
    );
    child.once("close", (code) => {
      if (this.process === child) this.process = null;
      this.telemetry.setLiquidsoapRunning(false);
      this.telemetry.markDisconnected();
      this.telemetry.observeDependency(
        "process_exit",
        this.shuttingDown ? "success" : "failure",
      );
      this.logger.warn(`Liquidsoap exited with code ${code}`);
      if (this.shuttingDown) return;

      const delayMs = Math.min(100 * 2 ** this.restartAttempt, 2_000);
      this.restartAttempt += 1;
      this.telemetry.countProcessRestart();
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.startLiquidsoap(scriptPath);
      }, delayMs);
      this.restartTimer.unref();
    });

    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = setTimeout(() => {
      if (this.process === child && child.exitCode === null) {
        this.restartAttempt = 0;
      }
    }, 5_000);
    this.stabilityTimer.unref();
  }

  private async pollTelemetry(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const [snapshotResponse, eventsResponse] = await Promise.all([
        this.telnet.send("palazzo.snapshot"),
        this.telnet.send("palazzo.events"),
      ]);
      const snapshot = JSON.parse(snapshotResponse) as LiquidsoapSnapshot;
      const events = JSON.parse(eventsResponse) as LiquidsoapLifecycleEvent[];
      this.telemetry.apply(snapshot, events);
      this.telemetry.observeDependency("telemetry_poll", "success");
    } catch (error) {
      if (error instanceof SyntaxError) {
        this.telemetry.markParseFailure();
        this.telemetry.observeDependency("telemetry_poll", "parse_failure");
      } else {
        this.telemetry.observeDependency("telemetry_poll", "failure");
      }
      this.telemetry.markDisconnected();
      this.logger.debug(
        `Liquidsoap telemetry poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.pollInFlight = false;
    }
  }

  private annotatedUri(url: string, metadata: Record<string, string>): string {
    if (/\r|\n/.test(url)) throw new Error("Audio URL cannot contain newlines");
    const annotations = Object.entries(metadata)
      .map(([key, value]) => `${key}="${this.annotationValue(value)}"`)
      .join(",");
    return `annotate:${annotations}:${url}`;
  }

  private annotationValue(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n");
  }

  private serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
