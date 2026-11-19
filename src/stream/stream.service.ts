import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomUUID } from "node:crypto";
import { ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { buildLiquidsoapScript } from "./liquidsoap-script";
import { FillerStoreService } from "./filler-store.service";
import { MediaRelay, type MediaFetchPath } from "./media-relay";
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

export type ProgramAssetKind = "song" | "intro" | "instant";
export type PreflightFailureReason =
  | "outside_lookahead"
  | "missing"
  | "unreachable"
  | "timeout"
  | "corrupt"
  | "unsupported_media"
  | "invalid_metadata";

export interface ProgramPreflightAsset extends ProgramAsset {
  kind: ProgramAssetKind;
  scheduledAt: string;
}

export interface ProgramPreflightRequest {
  assets: ProgramPreflightAsset[];
}

export interface MediaProbeResult {
  mediaType: "audio";
  format: string;
  codec: string;
  durationSeconds: number;
  sampleRateHz: number;
  channels: number;
  readablePacketBytes: number;
}

export interface PreflightAssetState {
  programId: string;
  playbackId: string;
  kind: ProgramAssetKind;
  scheduledAt: string;
  readiness: "ready" | "quarantined" | "expired";
  reason: "ready" | "expired" | PreflightFailureReason;
  checkedAt: string;
  expiresAt: string;
  reused: boolean;
  media?: MediaProbeResult;
}

/** An asset the preflight did not check, and why. */
export interface PreflightSkippedAsset {
  index: number;
  playbackId: string;
  reason: "unknown_kind";
}

interface StoredPreflightAsset extends PreflightAssetState {
  url: string;
  urlDigest: string;
}

/** Analysis-derived segue points, in seconds, as Alcantara sends them. */
export interface SongSegue {
  cueInSeconds: number;
  cueOutSeconds: number;
  fadeInSeconds: number;
  fadeOutSeconds: number;
  /** Validated and otherwise ignored: overlap is not applied yet. */
  overlapSeconds: number;
}

/** Analysis-derived loudness measurements, as Alcantara sends them. */
export interface SongLoudness {
  integratedLufs: number;
  truePeakDbtp: number;
}

export type SongAnalysisGroup = "segue" | "loudness";

export interface ProgramSongPayload {
  song: ProgramAsset & {
    title?: string;
    artist?: string;
    coverUrl?: string;
    segue?: SongSegue;
    loudness?: SongLoudness;
    duration?: number;
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
  private readonly preflightAssets = new Map<string, StoredPreflightAsset>();
  private readonly playoutJournalPath: string;
  private readonly preflightLookaheadMs: number;
  private readonly preflightBatchSize: number;
  private readonly preflightConcurrency: number;
  private readonly preflightCacheEntries: number;
  private readonly preflightTtlMs: number;
  private readonly preflightTimeoutMs: number;
  /** Liquidsoap's limit to resolve one song request (palazzo#42). */
  private readonly songRequestTimeoutMs: number;
  private readonly targetLufs: number;
  private readonly truePeakCeilingDbtp: number;
  private readonly nextResolveMaxSeconds: number;
  /** True once a next song was announced: song commands and stops then reset the decks first. */
  private decksUsed = false;
  /** Overlap (seconds) of recent songs, by playback request, for the announcement that follows them. */
  private readonly songOverlaps = new Map<string, number>();
  private readonly nextCommands = new Map<
    string,
    { fingerprint: string; playbackRequestId: string }
  >();
  private playoutJournalLoaded = false;
  private now = (): number => Date.now();
  private assetProbe = async (
    url: string,
  ): Promise<MediaProbeResult> => {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        // The only address ffprobe opens is Palazzo's loopback media relay.
        "-protocol_whitelist",
        "http,tcp",
        "-read_intervals",
        "%+#1",
        "-select_streams",
        "a:0",
        "-show_entries",
        "format=format_name,duration:stream=codec_name,codec_type,sample_rate,channels,duration:packet=size",
        "-show_packets",
        "-of",
        "json",
        url,
      ],
      { timeout: this.preflightTimeoutMs, maxBuffer: 64 * 1024 },
    );
    return parseProbeOutput(stdout);
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
    private readonly relay: MediaRelay,
  ) {
    this.telnet = new LiquidsoapTelnetClient({
      port: this.telnetPort,
      onReconnect: () => this.telemetry.countReconnect(),
    });
    this.playoutJournalPath =
      this.config.get<string>("PLAYOUT_COMMAND_JOURNAL_PATH")?.trim() ||
      "/var/lib/palazzo/fillers/playout-commands.json";
    this.preflightLookaheadMs =
      boundedInteger(
        this.config.get<string>("PREFLIGHT_LOOKAHEAD_SECONDS"),
        900,
        1,
        86_400,
      ) * 1_000;
    this.preflightBatchSize = boundedInteger(
      this.config.get<string>("PREFLIGHT_BATCH_SIZE"),
      20,
      1,
      100,
    );
    this.preflightConcurrency = boundedInteger(
      this.config.get<string>("PREFLIGHT_CONCURRENCY"),
      2,
      1,
      8,
    );
    this.preflightCacheEntries = boundedInteger(
      this.config.get<string>("PREFLIGHT_CACHE_ENTRIES"),
      128,
      1,
      512,
    );
    this.preflightTtlMs =
      boundedInteger(
        this.config.get<string>("PREFLIGHT_TTL_SECONDS"),
        300,
        1,
        3_600,
      ) * 1_000;
    this.preflightTimeoutMs = boundedInteger(
      this.config.get<string>("PREFLIGHT_TIMEOUT_MS"),
      10_000,
      100,
      30_000,
    );
    // Liquidsoap's own default is 29 s, so the default changes nothing.
    this.songRequestTimeoutMs = boundedInteger(
      this.config.get<string>("SONG_REQUEST_TIMEOUT_MS"),
      29_000,
      5_000,
      120_000,
    );
    this.targetLufs = playoutLevelSetting(
      "PLAYOUT_TARGET_LUFS",
      this.config.get<string>("PLAYOUT_TARGET_LUFS"),
      -16,
      -70,
      0,
    );
    this.truePeakCeilingDbtp = playoutLevelSetting(
      "PLAYOUT_TRUE_PEAK_CEILING_DBTP",
      this.config.get<string>("PLAYOUT_TRUE_PEAK_CEILING_DBTP"),
      -1,
      -20,
      0,
    );
    this.nextResolveMaxSeconds = boundedInteger(
      this.config.get<string>("PLAYOUT_NEXT_RESOLVE_MAX_SECONDS"),
      600,
      1,
      3_600,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.fillerStore.initialize();
    await this.loadPlayoutJournal();
    await this.telemetry.initialize();
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
      songRequestTimeoutMs: this.songRequestTimeoutMs,
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

  async preflightProgramAssets(
    programId: string,
    request: ProgramPreflightRequest,
  ): Promise<{
    programId: string;
    checkedAt: string;
    limits: {
      lookaheadSeconds: number;
      batchSize: number;
      concurrency: number;
      cacheEntries: number;
      cacheWarmBytes: 0;
    };
    assets: PreflightAssetState[];
    skipped?: PreflightSkippedAsset[];
  }> {
    if (!request || !Array.isArray(request.assets)) {
      throw new BadRequestException("assets must be an array");
    }
    const maximum = this.preflightBatchSize;
    if (request.assets.length < 1 || request.assets.length > maximum) {
      throw new BadRequestException(
        `assets must contain between 1 and ${maximum} items`,
      );
    }
    // An asset of a kind Palazzo does not know is skipped and reported, not a
    // reason to refuse the whole preflight (gaulatti/ariston#217). It is still
    // validated for program binding and URL safety, and it is never probed.
    const assets: ProgramPreflightAsset[] = [];
    const skipped: PreflightSkippedAsset[] = [];
    request.assets.forEach((asset, index) => {
      const checked = this.validatePreflightAsset(
        programId,
        asset,
        `assets[${index}]`,
      );
      if (checked) {
        assets.push(checked);
        return;
      }
      this.telemetry.observePreflightSkipped("unknown_kind");
      skipped.push({
        index,
        playbackId: asset.playbackId,
        reason: "unknown_kind",
      });
    });
    const results = new Array<PreflightAssetState>(assets.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < assets.length) {
        const index = cursor;
        cursor += 1;
        this.telemetry.reportPlayout("queued", {
          programId,
          playbackId: assets[index].playbackId,
          kind: assets[index].kind,
          scheduledAt: assets[index].scheduledAt,
        });
        results[index] = await this.preflightOne(assets[index]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(this.preflightConcurrency, assets.length) },
        () => worker(),
      ),
    );
    return {
      programId,
      checkedAt: new Date(this.now()).toISOString(),
      limits: {
        lookaheadSeconds: this.preflightLookaheadMs / 1_000,
        batchSize: this.preflightBatchSize,
        concurrency: this.preflightConcurrency,
        cacheEntries: this.preflightCacheEntries,
        // Palazzo deliberately caches readiness metadata, not signed media.
        cacheWarmBytes: 0,
      },
      assets: results,
      ...(skipped.length ? { skipped } : {}),
    };
  }

  getProgramPreflight(programId: string): {
    programId: string;
    checkedAt: string;
    assets: PreflightAssetState[];
  } {
    const now = this.now();
    const assets = [...this.preflightAssets.values()]
      .filter((asset) => asset.programId === programId)
      .map((asset) => {
        if (Date.parse(asset.expiresAt) <= now) {
          return this.publicPreflightState({
            ...asset,
            readiness: "expired",
            reason: "expired",
            reused: false,
          });
        }
        return this.publicPreflightState(asset);
      })
      .sort((left, right) => left.scheduledAt.localeCompare(right.scheduledAt));
    return {
      programId,
      checkedAt: new Date(now).toISOString(),
      assets,
    };
  }

  async playSong(data: SongPayload): Promise<PlaybackRequestAccepted> {
    return this.serializeOperation(async () => {
      const playbackRequestId = data.playbackRequestId?.trim() || randomUUID();
      const target = await this.relayed(
        data.url,
        "song",
        this.songRequestTimeoutMs,
      );
      const uri = this.annotatedUri(target, {
        palazzo_request_id: playbackRequestId,
        palazzo_url: data.url,
        title: data.title ?? "",
        artist: data.artist ?? "",
        cover_url: data.coverUrl ?? "",
      });
      try {
        await this.markEnding("replacement");
        await this.resetDecksIfUsed();
        await this.telnet.send("songs.flush_and_skip");
        await this.telnet.send(`songs.push ${uri}`);
      } catch (error) {
        await this.cancelEnding();
        throw error;
      }
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
        ? this.optionalProgramGain(
            introPayload?.duckGain,
            "intro.duckGain",
            0.35,
          )
        : 1;
      const fadeIn = intro
        ? this.optionalDuration(
            introPayload?.fadeInSeconds,
            "intro.fadeInSeconds",
          )
        : 0;
      const fadeOut = intro
        ? this.optionalDuration(
            introPayload?.fadeOutSeconds,
            "intro.fadeOutSeconds",
          )
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

      const scheduledAt = new Date(this.now()).toISOString();
      this.telemetry.reportPlayout("queued", {
        programId,
        playbackId: song.playbackId,
        kind: "song",
        scheduledAt,
      });
      const songReadiness = await this.preflightOne({
        ...song,
        kind: "song",
        scheduledAt,
      });
      if (songReadiness.readiness !== "ready") {
        this.telemetry.observePairedCommand("rejected", "song_unavailable");
        throw new BadRequestException("song asset is not ready");
      }
      if (intro) {
        this.telemetry.reportPlayout("queued", {
          programId,
          playbackId: intro.playbackId,
          kind: "intro",
          scheduledAt,
        });
        const introReadiness = await this.preflightOne({
          ...intro,
          kind: "intro",
          scheduledAt,
        });
        if (introReadiness.readiness !== "ready") {
          this.telemetry.observeIntroLifecycle("failed", "asset_unavailable");
          this.telemetry.reportIntroFailure({
            playbackId: intro.playbackId,
            parentPlaybackId: song.playbackId,
            programId,
            playbackRequestId: song.playbackId,
            reason: "asset_unavailable",
          });
          this.telemetry.reportPlayout("fallback", {
            programId,
            playbackId: song.playbackId,
            failedPlaybackId: intro.playbackId,
            policy: "song_only",
            reason: introReadiness.reason,
          });
          intro.url = "";
        }
      }

      const songUri = this.annotatedUri(
        await this.relayed(song.url, "song", this.songRequestTimeoutMs),
        {
        palazzo_request_id: song.playbackId,
        palazzo_playback_id: song.playbackId,
        palazzo_program_id: programId,
        palazzo_url: song.url,
        title: data.song.title ?? "",
        artist: data.song.artist ?? "",
        cover_url: data.song.coverUrl ?? "",
        ...this.songAnalysisAnnotations(song.playbackId, data.song),
        },
      );
      const playableIntro = intro?.url ? intro : undefined;
      const introTarget = playableIntro
        ? await this.relayed(
            playableIntro.url,
            "intro",
            this.songRequestTimeoutMs,
          )
        : "";
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
        await this.markEnding("replacement");
        await this.resetDecksIfUsed();
        await this.telnet.send("intros.flush_and_skip");
        await this.telnet.send(
          `var.set palazzo_intro_duck_gain = ${playableIntro ? duckGain : 1}`,
        );
        await this.telnet.send(
          `palazzo.arm_intro ${playableIntro ? song.playbackId : ""}`,
        );
        if (playableIntro) {
          const introUri = this.annotatedUri(introTarget, {
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
        await this.cancelEnding();
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
      try {
        await this.markEnding("operator");
        await this.resetDecksIfUsed();
        await this.telnet.send("songs.flush_and_skip");
      } catch (error) {
        await this.cancelEnding();
        throw error;
      }
    });
  }

  async playInstant(data: InstantPayload): Promise<PlaybackRequestAccepted> {
    return this.serializeOperation(async () => {
      const playbackRequestId = data.playbackRequestId?.trim() || randomUUID();
      const target = await this.relayed(
        data.url,
        "instant",
        this.songRequestTimeoutMs,
      );
      const uri = this.annotatedUri(target, {
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
      // A clear must still clear when the reason cannot be journalled.
      await this.markEnding("operator").catch(() => undefined);
      await this.resetDecksIfUsed().catch(() => undefined);
      const results = await Promise.allSettled([
        this.telnet.send("songs.flush_and_skip"),
        this.telnet.send("instants.flush_and_skip"),
        this.telnet.send("intros.flush_and_skip"),
      ]);
      const failure = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failure) {
        await this.cancelEnding();
        throw failure.reason;
      }
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

  private async preflightOne(
    asset: ProgramPreflightAsset,
  ): Promise<PreflightAssetState> {
    const now = this.now();
    const urlDigest = createHash("sha256").update(asset.url).digest("hex");
    const cacheKey = `${asset.programId}\u0000${asset.kind}\u0000${asset.playbackId}`;
    const cached = this.preflightAssets.get(cacheKey);
    if (
      cached &&
      cached.urlDigest === urlDigest &&
      cached.readiness !== "expired" &&
      Date.parse(cached.expiresAt) > now
    ) {
      const reused = { ...cached, reused: true };
      this.preflightAssets.delete(cacheKey);
      this.preflightAssets.set(cacheKey, cached);
      if (cached.readiness === "ready") {
        this.telemetry.reportPreflight("reused", "cache_hit", {
          programId: asset.programId,
          playbackId: asset.playbackId,
          kind: asset.kind,
          checkedAt: cached.checkedAt,
          expiresAt: cached.expiresAt,
        });
      } else {
        this.telemetry.reportPreflight(
          "failed",
          cached.reason as PreflightFailureReason,
          {
            programId: asset.programId,
            playbackId: asset.playbackId,
            kind: asset.kind,
            checkedAt: cached.checkedAt,
            expiresAt: cached.expiresAt,
          },
        );
      }
      return this.publicPreflightState(reused);
    }

    let checkedAt = new Date(now).toISOString();
    let expiresAt = new Date(now + this.preflightTtlMs).toISOString();
    const scheduledAt = Date.parse(asset.scheduledAt);
    if (
      scheduledAt < now - 30_000 ||
      scheduledAt > now + this.preflightLookaheadMs
    ) {
      const state: StoredPreflightAsset = {
        ...asset,
        urlDigest,
        readiness: "quarantined",
        reason: "outside_lookahead",
        checkedAt,
        expiresAt,
        reused: false,
      };
      this.storePreflight(cacheKey, state);
      this.telemetry.reportPreflight("failed", "outside_lookahead", state);
      return this.publicPreflightState(state);
    }

    try {
      const media = await this.assetProbe(
        await this.relayed(asset.url, "preflight", this.preflightTimeoutMs),
      );
      validateProbeResult(media);
      const completedAt = this.now();
      checkedAt = new Date(completedAt).toISOString();
      expiresAt = new Date(completedAt + this.preflightTtlMs).toISOString();
      const state: StoredPreflightAsset = {
        ...asset,
        urlDigest,
        readiness: "ready",
        reason: "ready",
        checkedAt,
        expiresAt,
        reused: false,
        media,
      };
      this.storePreflight(cacheKey, state);
      this.telemetry.reportPreflight("ready", "none", state);
      return this.publicPreflightState(state);
    } catch (error) {
      const reason = classifyProbeFailure(error);
      const completedAt = this.now();
      checkedAt = new Date(completedAt).toISOString();
      expiresAt = new Date(completedAt + this.preflightTtlMs).toISOString();
      const state: StoredPreflightAsset = {
        ...asset,
        urlDigest,
        readiness: "quarantined",
        reason,
        checkedAt,
        expiresAt,
        reused: false,
      };
      this.storePreflight(cacheKey, state);
      this.telemetry.reportPreflight("failed", reason, state);
      return this.publicPreflightState(state);
    }
  }

  private storePreflight(key: string, state: StoredPreflightAsset): void {
    this.preflightAssets.delete(key);
    this.preflightAssets.set(key, state);
    while (this.preflightAssets.size > this.preflightCacheEntries) {
      // An over-capacity map is nonempty; every key is a scoped asset identity.
      const oldest = this.preflightAssets.keys().next().value!;
      this.preflightAssets.delete(oldest);
    }
  }

  private publicPreflightState(
    state: StoredPreflightAsset,
  ): PreflightAssetState {
    const { urlDigest: _urlDigest, url: _url, ...publicState } = state;
    return publicState;
  }

  /**
   * The validated asset, or null for a well-formed asset whose `kind` Palazzo
   * does not know. A missing or non-string kind is still invalid.
   */
  private validatePreflightAsset(
    programId: string,
    value: ProgramPreflightAsset | undefined,
    field: string,
  ): ProgramPreflightAsset | null {
    const asset = this.validateProgramAsset(programId, value, field);
    if (!value || typeof value.kind !== "string" || !value.kind.trim()) {
      throw new BadRequestException(`${field}.kind is invalid`);
    }
    if (!["song", "intro", "instant"].includes(value.kind)) return null;
    if (
      typeof value.scheduledAt !== "string" ||
      !value.scheduledAt.trim() ||
      !Number.isFinite(Date.parse(value.scheduledAt))
    ) {
      throw new BadRequestException(`${field}.scheduledAt is invalid`);
    }
    return {
      ...asset,
      kind: value.kind,
      scheduledAt: new Date(value.scheduledAt).toISOString(),
    };
  }

  /**
   * Announces the song that follows the current one (gaulatti/palazzo#40). Palazzo probes it, resolves
   * it in the background within the current song's remaining time (capped by
   * PLAYOUT_NEXT_RESOLVE_MAX_SECONDS) and starts it itself at the current song's cue-out minus its overlap.
   */
  async announceNext(
    programId: string,
    idempotencyKey: string | undefined,
    data: ProgramSongPayload,
  ): Promise<{
    ok: true;
    playbackRequestId: string;
    state: "queued";
    duplicate?: true;
  }> {
    return this.serializeOperation(async () => {
      const key = idempotencyKey?.trim() ?? "";
      let song: ProgramAsset;
      try {
        if (!key || key.length > 200) throw new Error("idempotency");
        if (!data || typeof data !== "object" || data.intro !== undefined) {
          throw new Error("intro");
        }
        song = this.validateProgramAsset(programId, data.song, "song");
        if (/\s/.test(song.playbackId)) throw new Error("playbackId");
      } catch {
        this.telemetry.observeNextRequest("invalid");
        throw new BadRequestException({ ok: false, reason: "invalid" });
      }
      const fingerprint = JSON.stringify(canonicalValue(data));
      const digest = this.commandDigest(key);
      const prior = this.nextCommands.get(digest);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          this.telemetry.observeNextRequest("invalid");
          throw new BadRequestException({ ok: false, reason: "invalid" });
        }
        this.telemetry.observeNextRequest("duplicate");
        return {
          ok: true,
          playbackRequestId: prior.playbackRequestId,
          state: "queued",
          duplicate: true,
        };
      }
      const current = this.telemetry.currentSong();
      if (!current) {
        this.telemetry.observeNextRequest("no_current_song");
        throw new ConflictException({ ok: false, reason: "no_current_song" });
      }
      const readiness = await this.preflightOne({
        ...song,
        kind: "song",
        scheduledAt: new Date(this.now()).toISOString(),
      });
      if (readiness.readiness !== "ready") {
        this.telemetry.observeNextRequest("not_ready");
        throw new UnprocessableEntityException({
          ok: false,
          reason: "not_ready",
        });
      }
      const overlap = this.songOverlaps.get(current.playbackRequestId) ?? 0;
      const annotations = this.songAnalysisAnnotations(
        song.playbackId,
        data.song,
      );
      if (overlap > 0) {
        // Entering under an overlap, the song rises over at least MIN_OVERLAP_FADE_IN_SECONDS so the
        // overlap limiter can hold the sum of both songs under the true-peak ceiling (measured).
        annotations.liq_fade_in = decimal(
          Math.max(
            Number(annotations.liq_fade_in ?? 0),
            MIN_OVERLAP_FADE_IN_SECONDS,
          ),
        );
      }
      const remaining = current.remainingSeconds;
      const limit = Math.min(
        this.nextResolveMaxSeconds,
        remaining !== null && remaining > 0
          ? remaining
          : this.nextResolveMaxSeconds,
      );
      const uri = this.annotatedUri(
        await this.relayed(song.url, "next", limit * 1000),
        {
          palazzo_request_id: song.playbackId,
          palazzo_playback_id: song.playbackId,
          palazzo_program_id: programId,
          palazzo_url: song.url,
          title: data.song.title ?? "",
          artist: data.song.artist ?? "",
          cover_url: data.song.coverUrl ?? "",
          ...annotations,
        },
      );
      this.decksUsed = true;
      const answer = await this.telnet.send(
        `palazzo.prepare_next ${song.playbackId} ${decimal(limit)} ${decimal(overlap)} ${uri}`,
      );
      if (answer.trim() !== "ok") {
        this.telemetry.observeNextRequest("not_ready");
        throw new UnprocessableEntityException({
          ok: false,
          reason: "not_ready",
        });
      }
      this.nextCommands.set(digest, {
        fingerprint,
        playbackRequestId: song.playbackId,
      });
      if (this.nextCommands.size > 64) {
        const oldest = this.nextCommands.keys().next().value as string;
        this.nextCommands.delete(oldest);
      }
      this.telemetry.observeNextRequest("queued");
      this.telemetry.reportNextQueued(programId, song.playbackId);
      return { ok: true, playbackRequestId: song.playbackId, state: "queued" };
    });
  }

  /** Withdraws the announced next song, if one is queued and has not started. */
  async withdrawNext(): Promise<{ ok: true; withdrawn: boolean }> {
    return this.serializeOperation(async () => {
      if (!this.decksUsed) return { ok: true, withdrawn: false };
      const answer = await this.telnet.send("palazzo.withdraw_next withdrawn");
      return { ok: true, withdrawn: answer.trim() === "withdrawn" };
    });
  }

  /**
   * Before a song command or a stop cuts what is on air: Liquidsoap journals the reason for each deck's song
   * at that instant (gaulatti/palazzo#41), so the reason is bound to that playback, including one that
   * started within the last telemetry poll.
   */
  private async markEnding(reason: "replacement" | "operator"): Promise<void> {
    await this.telnet.send(`palazzo.mark_ending ${reason}`);
  }

  /** After a failed song command or stop: the songs still on air will end for their own reasons. */
  private async cancelEnding(): Promise<void> {
    await this.telnet.send("palazzo.mark_ending cancel").catch(() => undefined);
  }

  /** Before a song command or a stop, once announcements were used: back to the single song deck. */
  private async resetDecksIfUsed(): Promise<void> {
    if (this.decksUsed) await this.telnet.send("palazzo.reset_decks");
  }

  private rememberOverlap(playbackRequestId: string, seconds: number): void {
    this.songOverlaps.delete(playbackRequestId);
    this.songOverlaps.set(playbackRequestId, seconds);
    if (this.songOverlaps.size > 64) {
      const oldest = this.songOverlaps.keys().next().value as string;
      this.songOverlaps.delete(oldest);
    }
  }

  /**
   * Liquidsoap annotations for a song's valid analysis groups. An invalid
   * group is dropped and counted; the song is never refused because of it.
   * Without either group this returns nothing, so the request is unchanged.
   */
  private songAnalysisAnnotations(
    playbackRequestId: string,
    song: ProgramSongPayload["song"],
  ): Record<string, string> {
    const annotations: Record<string, string> = {};
    if (song.segue !== undefined) {
      const segue = validSongSegue(song.segue, song.duration);
      if (segue) {
        annotations.liq_cue_in = decimal(segue.cueInSeconds);
        annotations.liq_cue_out = decimal(segue.cueOutSeconds);
        annotations.liq_fade_in = decimal(segue.fadeInSeconds);
        annotations.liq_fade_out = decimal(segue.fadeOutSeconds);
        this.telemetry.rememberSongCueIn(playbackRequestId, segue.cueInSeconds);
        this.rememberOverlap(playbackRequestId, segue.overlapSeconds);
      } else {
        this.telemetry.observeSongAnalysisDropped("segue");
      }
    }
    if (song.loudness !== undefined) {
      const loudness = validSongLoudness(song.loudness);
      if (loudness) {
        annotations.liq_amplify = decimal(
          loudnessGain(loudness, this.targetLufs, this.truePeakCeilingDbtp),
        );
      } else {
        this.telemetry.observeSongAnalysisDropped("loudness");
      }
    }
    return annotations;
  }

  /** palazzo_media_fetch_total, from the media relay. */
  renderMediaMetrics(): string {
    return this.relay.renderMetrics();
  }

  /**
   * The loopback relay address that reads `url` under the outbound check
   * (gaulatti/palazzo#45). Liquidsoap and ffprobe are only ever given this;
   * the original URL stays in the palazzo_url annotation for events.
   */
  private relayed(
    url: string,
    path: MediaFetchPath,
    ttlMs: number,
  ): Promise<string> {
    this.assertMediaUrl(url);
    return this.relay.issue(url.trim(), path, ttlMs);
  }

  private assertMediaUrl(url: string): void {
    if (typeof url !== "string" || !url.trim()) {
      throw new BadRequestException("url must be a non-empty string");
    }
    if (/\r|\n/.test(url)) {
      throw new BadRequestException("Audio URL cannot contain newlines");
    }
  }

  private annotatedUri(url: string, metadata: Record<string, string>): string {
    this.assertMediaUrl(url);
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

/** Reads a playout level setting, failing startup on an invalid value. */
function playoutLevelSetting(
  name: string,
  configured: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (configured === undefined || configured.trim() === "") return fallback;
  const parsed = Number(configured);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be a number between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteFields<K extends string>(
  value: unknown,
  keys: readonly K[],
): Record<K, number> | null {
  if (!isRecord(value)) return null;
  const fields = {} as Record<K, number>;
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry)) return null;
    fields[key] = entry;
  }
  return fields;
}

/**
 * The segue group when it is within bounds: all finite, 0 <= cueIn < cueOut,
 * cueOut <= duration when a duration is given, fades >= 0, and
 * 0 <= overlap <= cueOut - cueIn. Otherwise null.
 */
export function validSongSegue(
  value: unknown,
  duration?: unknown,
): SongSegue | null {
  const segue = finiteFields(value, [
    "cueInSeconds",
    "cueOutSeconds",
    "fadeInSeconds",
    "fadeOutSeconds",
    "overlapSeconds",
  ] as const);
  if (!segue) return null;
  if (segue.cueInSeconds < 0 || segue.cueInSeconds >= segue.cueOutSeconds) {
    return null;
  }
  if (
    duration !== undefined &&
    (typeof duration !== "number" ||
      !Number.isFinite(duration) ||
      segue.cueOutSeconds > duration)
  ) {
    return null;
  }
  if (segue.fadeInSeconds < 0 || segue.fadeOutSeconds < 0) return null;
  if (
    segue.overlapSeconds < 0 ||
    segue.overlapSeconds > segue.cueOutSeconds - segue.cueInSeconds
  ) {
    return null;
  }
  return segue;
}

/**
 * The loudness group when it is within bounds: both finite,
 * -70 <= integratedLufs <= 0 and truePeakDbtp <= +6. Otherwise null.
 */
export function validSongLoudness(value: unknown): SongLoudness | null {
  const loudness = finiteFields(value, [
    "integratedLufs",
    "truePeakDbtp",
  ] as const);
  if (!loudness) return null;
  if (loudness.integratedLufs < -70 || loudness.integratedLufs > 0) {
    return null;
  }
  if (loudness.truePeakDbtp > 6) return null;
  return loudness;
}

/**
 * Linear gain that brings the song to the target loudness, capped so that
 * its true peak plus the gain stays at or below the ceiling.
 */
export function loudnessGain(
  loudness: SongLoudness,
  targetLufs: number,
  ceilingDbtp: number,
): number {
  const gainDb = Math.min(
    targetLufs - loudness.integratedLufs,
    ceilingDbtp - loudness.truePeakDbtp,
  );
  return 10 ** (gainDb / 20);
}

/** Shortest rise of a song that enters under an overlap (gaulatti/palazzo#40, measured). */
const MIN_OVERLAP_FADE_IN_SECONDS = 0.25;

/** A plain decimal string (never exponent notation), to six places. */
function decimal(value: number): string {
  return String(Number(value.toFixed(6)));
}

function boundedInteger(
  configured: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(configured ?? fallback);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function parseProbeOutput(stdout: string): MediaProbeResult {
  let parsed: {
    format?: { format_name?: unknown; duration?: unknown };
    streams?: Array<{
      codec_name?: unknown;
      codec_type?: unknown;
      sample_rate?: unknown;
      channels?: unknown;
      duration?: unknown;
    }>;
    packets?: Array<{ size?: unknown }>;
  };
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new PreflightProbeError("corrupt");
  }
  const stream = parsed.streams?.find((entry) => entry.codec_type === "audio");
  if (!stream) throw new PreflightProbeError("unsupported_media");
  const duration = Number(parsed.format?.duration ?? stream.duration);
  const sampleRate = Number(stream.sample_rate);
  const channels = Number(stream.channels);
  const packetBytes = Number(parsed.packets?.[0]?.size);
  const result: MediaProbeResult = {
    mediaType: "audio",
    format:
      typeof parsed.format?.format_name === "string"
        ? parsed.format.format_name
        : "unknown",
    codec: typeof stream.codec_name === "string" ? stream.codec_name : "",
    durationSeconds: duration,
    sampleRateHz: sampleRate,
    channels,
    readablePacketBytes: packetBytes,
  };
  validateProbeResult(result);
  return result;
}

function validateProbeResult(result: MediaProbeResult): void {
  if (
    !result ||
    result.mediaType !== "audio" ||
    !result.codec ||
    !Number.isFinite(result.durationSeconds) ||
    result.durationSeconds <= 0 ||
    !Number.isInteger(result.sampleRateHz) ||
    result.sampleRateHz <= 0 ||
    !Number.isInteger(result.channels) ||
    result.channels <= 0 ||
    !Number.isInteger(result.readablePacketBytes) ||
    result.readablePacketBytes <= 0
  ) {
    throw new PreflightProbeError("invalid_metadata");
  }
}

class PreflightProbeError extends Error {
  constructor(readonly reason: PreflightFailureReason) {
    super(reason);
  }
}

function classifyProbeFailure(error: unknown): PreflightFailureReason {
  if (error instanceof PreflightProbeError) return error.reason;
  const nodeError = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string;
    stderr?: string;
  };
  const detail = `${nodeError.code ?? ""} ${nodeError.message ?? ""} ${
    nodeError.stderr ?? ""
  }`.toLowerCase();
  if (
    nodeError.killed ||
    nodeError.signal === "SIGTERM" ||
    /timed?\s*out|timeout|etimedout/.test(detail)
  ) {
    return "timeout";
  }
  if (/404|not found|enoent|no such file/.test(detail)) return "missing";
  if (/invalid data|moov atom|could not find codec parameters/.test(detail)) {
    return "corrupt";
  }
  if (/unsupported|unknown format|no audio/.test(detail)) {
    return "unsupported_media";
  }
  return "unreachable";
}
