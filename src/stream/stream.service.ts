import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Socket } from 'net';

/**
 * Payload for pushing a song into the queue.
 *
 * @property url    - Publicly accessible audio file URL (MP3, AAC, etc.).
 * @property title  - Optional display title (used in Liquidsoap metadata).
 * @property artist - Optional artist name (used in Liquidsoap metadata).
 */
export interface SongPayload {
  url: string;
  title?: string;
  artist?: string;
}

/**
 * Payload for pushing an instant (short sound effect / jingle).
 *
 * @property url    - Publicly accessible audio file URL.
 * @property volume - Optional volume multiplier (0.0 – 1.0).
 */
export interface InstantPayload {
  url: string;
  volume?: number;
}

/**
 * Payload for the mixer control endpoint.
 *
 * All fields are optional — only the provided values would be applied.
 *
 * @remarks Currently a no-op; the Liquidsoap Telnet commands for per-source
 *          volume/mute are not yet implemented.
 */
export interface MixerPayload {
  songVolume?: number;
  instantVolume?: number;
  songMuted?: boolean;
  instantMuted?: boolean;
}

/**
 * Core service that manages the Liquidsoap streaming engine.
 *
 * Responsibilities:
 * 1. On startup generates a Liquidsoap script and spawns the process.
 * 2. Provides a Telnet interface to push songs and instant clips into
 *    Liquidsoap's request queues.
 * 3. Reports stream status (mount point, uptime, running state).
 * 4. On shutdown gracefully kills the Liquidsoap child process.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────┐   Telnet :14000   ┌─────────┐    MP3    ┌──────────┐
 * │  Palazzo    │ ────────────────→  │Liquidsoap│ ────────→ │ Icecast2 │
 * │  (NestJS)   │ ←── status ─────  │ .liq     │           │ :8000    │
 * └─────────────┘                   └─────────┘           └──────────┘
 * ```
 *
 * The Liquidsoap script defines two request queues:
 * - `songs`   — main playlist (sequential, gapless).
 * - `instants` — short interrupt clips that play over the current song.
 *
 * An optional RTMP live input can be mixed in when `RTMP_URL` is set.
 */
@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private process: ChildProcess | null = null;

  /** Telnet port Liquidsoap listens on for remote control commands. */
  private readonly telnetPort = 14000;

  /** Timestamp captured at service construction for uptime calculation. */
  private readonly startedAt = Date.now();

  constructor(private readonly config: ConfigService) {}

  /**
   * Lifecycle hook — called once after the module is initialised.
   *
   * Reads stream configuration from environment, generates a Liquidsoap
   * script, writes it to `/tmp/palazzo/stream.liq`, and spawns the
   * `liquidsoap` child process.
   *
   * Environment variables honoured:
   * - `ICECAST_MOUNT`            (default `/stream`)
   * - `ICECAST_PORT`             (default `8000`)
   * - `ICECAST_SOURCE_PASSWORD`  (default `hackme`)
   * - `STREAM_NAME`              (default `Palazzo`)
   * - `STREAM_GENRE`             (default `Various`)
   * - `BITRATE`                  (default `128` kbps)
   * - `RTMP_URL`                 (optional — if set, adds a live RTMP input source)
   */
  async onModuleInit(): Promise<void> {
    const mount = this.config.get<string>('ICECAST_MOUNT') ?? '/stream';
    const port = Number(this.config.get<string>('ICECAST_PORT') ?? 8000);
    const pass =
      this.config.get<string>('ICECAST_SOURCE_PASSWORD') ?? 'hackme';
    const name = this.config.get<string>('STREAM_NAME') ?? 'Palazzo';
    const genre = this.config.get<string>('STREAM_GENRE') ?? 'Various';
    const br = Number(this.config.get<string>('BITRATE') ?? 128);
    const rtmp = this.config.get<string>('RTMP_URL') || null;

    // Build optional RTMP live-input snippet if a URL is configured.
    const rtmpIn = rtmp ? `live = mksafe(input.rtmp("${rtmp}"))` : '';
    const rtmpSrc = rtmp ? ', live' : '';

    // Liquidsoap script that sets up two request queues (songs + instants),
    // optionally mixes in an RTMP live source, and outputs to Icecast as MP3.
    const liq = `#!/usr/bin/liquidsoap

set("init.allow_root", true)
set("server.telnet", true)
set("server.telnet.bind_addr", "0.0.0.0")
set("server.telnet.port", ${this.telnetPort})
set("log.level", 3)

songs = request.queue(id="songs")
instants = mksafe(request.queue(id="instants"))
${rtmpIn}
radio = add(normalize=false, [songs, instants${rtmpSrc}])
radio = mksafe(radio)
output.icecast(
  %mp3(bitrate=${br}),
  host="127.0.0.1", port=${port},
  password="${pass}", mount="${mount}",
  name="${name}", genre="${genre}",
  description="${name}", radio
)`;

    const dir = '/tmp/palazzo';
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'stream.liq'), liq, 'utf8');

    // Spawn Liquidsoap with stdout/stderr piped for debug logging.
    this.process = spawn('liquidsoap', [join(dir, 'stream.liq')], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process.stdout?.on('data', (d: Buffer) =>
      this.logger.debug(d.toString().trim()),
    );
    this.process.stderr?.on('data', (d: Buffer) =>
      this.logger.debug(d.toString().trim()),
    );
    this.process.on('exit', (c) =>
      this.logger.warn(`Liquidsoap exited with code ${c}`),
    );

    this.logger.log(`Liquidsoap started, mount=${mount}`);
  }

  /** Lifecycle hook — kills the Liquidsoap child process on server shutdown. */
  onModuleDestroy(): void {
    this.process?.kill();
  }

  /**
   * Returns status information about the running stream.
   *
   * @returns An object containing the Icecast mount point, stream name,
   *          whether the Liquidsoap process is running, and the uptime
   *          (in milliseconds) since the service was constructed.
   */
  getStatus() {
    return {
      mount: this.config.get('ICECAST_MOUNT') ?? '/stream',
      streamName: this.config.get('STREAM_NAME') ?? 'Palazzo',
      running: this.process !== null && this.process.exitCode === null,
      uptime: Date.now() - this.startedAt,
    };
  }

  /**
   * Pushes a song URL into Liquidsoap's `songs` queue.
   *
   * The current track is skipped first so the new song starts immediately.
   *
   * @param data - The song payload (url is required; title/artist are optional).
   */
  async playSong(data: SongPayload): Promise<void> {
    // Swallow skip errors — the queue may be empty, which is harmless.
    await this.telnet('songs.skip').catch(() => {});
    await this.telnet(`songs.push ${this.esc(data.url)}`);
  }

  /** Skips the current song by advancing the `songs` request queue. */
  async stopSong(): Promise<void> {
    await this.telnet('songs.skip').catch(() => {});
  }

  /**
   * Pushes an instant audio URL (short clip, jingle, or sound effect)
   * into the `instants` request queue. Instants play over the current song.
   *
   * @param data - The instant payload (url is required; volume is optional).
   */
  async playInstant(data: InstantPayload): Promise<void> {
    await this.telnet(`instants.push ${this.esc(data.url)}`);
  }

  /** Stops all currently playing instant clips by skipping the `instants` queue. */
  async stopAllInstants(): Promise<void> {
    await this.telnet('instants.skip').catch(() => {});
  }

  /**
   * Updates mixer settings (volumes, mute state).
   *
   * @remarks **No-op stub** — Liquidsoap Telnet commands for per-source
   *          volume control are not yet implemented.
   */
  async updateMixer(_data: MixerPayload): Promise<void> {}

  /**
   * Sends a raw command to Liquidsoap's Telnet server and returns the response.
   *
   * Opens a TCP connection to `127.0.0.1:{telnetPort}`, writes the
   * command followed by a newline, then collects data for up to 500 ms
   * before returning the trimmed response.
   *
   * @param command - The Liquidsoap Telnet command string (e.g. `songs.push <url>`).
   * @returns The server's response text, trimmed of trailing whitespace.
   */
  private telnet(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.connect(this.telnetPort, '127.0.0.1', () =>
        socket.write(command + '\n', 'utf8'),
      );
      socket.on('data', (d: Buffer) => chunks.push(d));
      // After 500 ms of silence, assume the response is complete.
      const t = setTimeout(() => {
        socket.destroy();
        resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
      }, 500);
      socket.on('close', () => {
        clearTimeout(t);
        resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
      });
      socket.on('error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  /**
   * Shell-escapes a string for use in Liquidsoap Telnet command arguments.
   *
   * If the string contains spaces it is wrapped in double quotes, and
   * any backslashes or double quotes inside are backslash-escaped.
   *
   * @param s - The raw string to escape.
   * @returns The escaped string, safe for use in a Liquidsoap command.
   */
  private esc(s: string): string {
    return s.includes(' ')
      ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
      : s;
  }
}
