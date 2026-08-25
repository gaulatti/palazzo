import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface ProgramInstantPayload extends InstantPayload {
  programId: string;
  playbackId: string;
}

export interface ProgramAsset {
  programId: string;
  playbackId: string;
  url: string;
}

export interface ProgramSongPayload {
  song: ProgramAsset & {
    title?: string;
    artist?: string;
    coverUrl?: string;
  };
  intro?: ProgramAsset & {
    gain?: number;
    duckGain?: number;
    fadeInSeconds?: number;
    fadeOutSeconds?: number;
  };
}

interface PlayoutCommandRecord {
  digest: string;
  fingerprint: string;
  playbackRequestId: string;
  introPlaybackId: string | null;
  acceptedAt: string;
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
  duplicate?: boolean;
  introPlaybackId?: string | null;
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
  private readonly playoutCommands = new Map<string, PlayoutCommandRecord>();
  private readonly playoutJournalPath: string;
  private playoutJournalLoaded = false;
  private assetProbe = async (url: string): Promise<void> => {
    await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "a:0",
        "-show_entries",
        "stream=codec_type",
        "-of",
        "json",
        url,
      ],
      { timeout: 20_000, maxBuffer: 64 * 1024 },
    );
  };
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
    this.playoutJournalPath =
      this.config.get<string>("PLAYOUT_COMMAND_JOURNAL_PATH")?.trim() ||
      "/var/lib/palazzo/fillers/playout-commands.json";
  }

  async onModuleInit(): Promise<void> {
    await this.fillerStore.initialize();
    await this.loadPlayoutJournal();
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

  async playProgramSong(
    programId: string,
    idempotencyKey: string | undefined,
    data: ProgramSongPayload,
  ): Promise<PlaybackRequestAccepted> {
    return this.serializeOperation(async () => {
      await this.loadPlayoutJournal();
      const key = idempotencyKey?.trim() ?? "";
      if (!key || key.length > 200) {
        this.telemetry.observePairedCommand("rejected", "idempotency");
        throw new BadRequestException("a bounded Idempotency-Key is required");
      }
      const song = this.validateProgramAsset(programId, data?.song, "song");
      const introPayload = data?.intro;
      const intro = introPayload
        ? this.validateProgramAsset(programId, introPayload, "intro")
        : undefined;
      const introGain = intro
        ? this.optionalProgramGain(introPayload?.gain, "intro.gain", 1)
        : 1;
      const duckGain = intro
        ? this.optionalProgramGain(introPayload?.duckGain, "intro.duckGain", 0.35)
        : 1;
      const fadeIn = intro
        ? this.optionalDuration(introPayload?.fadeInSeconds, "intro.fadeInSeconds")
        : 0;
      const fadeOut = intro
        ? this.optionalDuration(introPayload?.fadeOutSeconds, "intro.fadeOutSeconds")
        : 0;
      const fingerprint = JSON.stringify(canonicalValue(data));
      const digest = this.commandDigest(key);
      const prior = this.playoutCommands.get(digest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          this.telemetry.observePairedCommand("rejected", "key_reuse");
          throw new BadRequestException(
            "idempotency key was already used for another playout",
          );
        }
        this.telemetry.observePairedCommand("deduplicated", "duplicate");
        return {
          ok: true,
          playbackRequestId: prior.playbackRequestId,
          introPlaybackId: prior.introPlaybackId,
          duplicate: true,
        };
      }

      try {
        await this.assetProbe(song.url);
      } catch {
        this.telemetry.observePairedCommand("rejected", "song_unavailable");
        throw new BadRequestException("song asset is not ready");
      }
      if (intro) {
        try {
          await this.assetProbe(intro.url);
        } catch {
          this.telemetry.observeIntroLifecycle("failed", "asset_unavailable");
          this.telemetry.reportIntroFailure({
            playbackId: intro.playbackId,
            parentPlaybackId: song.playbackId,
            programId,
            playbackRequestId: song.playbackId,
            reason: "asset_unavailable",
          });
          intro.url = "";
        }
      }

      const songUri = this.annotatedUri(song.url, {
        palazzo_request_id: song.playbackId,
        palazzo_playback_id: song.playbackId,
        palazzo_program_id: programId,
        palazzo_url: song.url,
        title: data.song.title ?? "",
        artist: data.song.artist ?? "",
        cover_url: data.song.coverUrl ?? "",
      });
      const playableIntro = intro?.url ? intro : undefined;
      const record: PlayoutCommandRecord = {
        digest,
        fingerprint,
        playbackRequestId: song.playbackId,
        introPlaybackId: playableIntro?.playbackId ?? null,
        acceptedAt: new Date().toISOString(),
      };
      // Reserve the key durably before touching Liquidsoap. A crash can
      // therefore lose a command, but can never replay audible material.
      this.playoutCommands.set(digest, record);
      if (this.playoutCommands.size > 256) {
        const oldest = this.playoutCommands.keys().next().value as
          | string
          | undefined;
        if (oldest) this.playoutCommands.delete(oldest);
      }
      await this.persistPlayoutJournal();
      try {
        await this.telnet.send("intros.flush_and_skip");
        await this.telnet.send(
          `var.set palazzo_intro_duck_gain = ${playableIntro ? duckGain : 1}`,
        );
        await this.telnet.send(
          `palazzo.arm_intro ${playableIntro ? song.playbackId : ""}`,
        );
        if (playableIntro) {
          const introUri = this.annotatedUri(playableIntro.url, {
            palazzo_request_id: song.playbackId,
            palazzo_playback_id: playableIntro.playbackId,
            palazzo_parent_playback_id: song.playbackId,
            palazzo_program_id: programId,
            palazzo_url: playableIntro.url,
            palazzo_kind: "intro",
            liq_amplify: String(introGain),
            palazzo_fade_in: String(fadeIn),
            palazzo_fade_out: String(fadeOut),
          });
          await this.telnet.send(`intros.push ${introUri}`);
        }
        await this.telnet.send("songs.flush_and_skip");
        await this.telnet.send(`songs.push ${songUri}`);
      } catch {
        await this.telnet.send("intros.flush_and_skip").catch(() => undefined);
        await this.telnet.send("palazzo.arm_intro ").catch(() => undefined);
        this.playoutCommands.delete(digest);
        await this.persistPlayoutJournal().catch(() => undefined);
        this.telemetry.observePairedCommand("rejected", "engine_failure");
        throw new BadRequestException("playout engine rejected the command");
      }

      this.telemetry.observePairedCommand("accepted", "none");
      this.logger.log({
        event: "song_intro.request.accepted",
        playbackRequestId: song.playbackId,
        introPlaybackId: playableIntro?.playbackId ?? null,
        programId,
      });
      return {
        ok: true,
        playbackRequestId: song.playbackId,
        introPlaybackId: playableIntro?.playbackId ?? null,
      };
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
        this.telnet.send("intros.flush_and_skip"),
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

  private optionalProgramGain(
    value: unknown,
    field: string,
    fallback: number,
  ): number {
    return value === undefined ? fallback : this.normalizeGain(value, field);
  }

  private optionalDuration(value: unknown, field: string): number {
    if (value === undefined) return 0.25;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 5
    ) {
      throw new BadRequestException(
        `${field} must be a number between 0 and 5 seconds`,
      );
    }
    return value;
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

  private validateProgramAsset(
    programId: string,
    value: ProgramAsset | undefined,
    field: string,
  ): ProgramAsset {
    if (!value || typeof value !== "object") {
      throw new BadRequestException(`${field} is required`);
    }
    for (const key of ["programId", "playbackId", "url"] as const) {
      const entry = value[key];
      if (
        typeof entry !== "string" ||
        !entry.trim() ||
        entry.length > (key === "url" ? 4096 : 200)
      ) {
        throw new BadRequestException(`${field}.${key} is invalid`);
      }
    }
    if (value.programId !== programId) {
      throw new BadRequestException(`${field} belongs to another program`);
    }
    let parsed: URL;
    try {
      parsed = new URL(value.url);
    } catch {
      throw new BadRequestException(`${field}.url must be an absolute URL`);
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new BadRequestException(`${field}.url protocol is not allowed`);
    }
    return { ...value, url: value.url.trim() };
  }

  private commandDigest(key: string): string {
    return createHash("sha256").update(key).digest("hex");
  }

  private async loadPlayoutJournal(): Promise<void> {
    if (this.playoutJournalLoaded) return;
    this.playoutJournalLoaded = true;
    try {
      const records = JSON.parse(
        await readFile(this.playoutJournalPath, "utf8"),
      ) as PlayoutCommandRecord[];
      for (const record of records.slice(-256)) {
        if (record?.digest && record?.fingerprint) {
          this.playoutCommands.set(record.digest, record);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("playout command journal is unavailable");
      }
    }
  }

  private async persistPlayoutJournal(): Promise<void> {
    const records = [...this.playoutCommands.values()].slice(-256);
    const directory = dirname(this.playoutJournalPath);
    const temporary = `${this.playoutJournalPath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, JSON.stringify(records), { mode: 0o600 });
    await rename(temporary, this.playoutJournalPath);
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

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}
