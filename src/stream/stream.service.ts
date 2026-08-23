import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildLiquidsoapScript } from './liquidsoap-script';
import { LiquidsoapTelnetClient } from './liquidsoap-telnet.client';
import {
  LiquidsoapLifecycleEvent,
  LiquidsoapSnapshot,
  PlaybackTelemetryService,
} from './playback-telemetry.service';

const execFileAsync = promisify(execFile);

export interface SongPayload {
  url: string;
  title?: string;
  artist?: string;
}

export interface InstantPayload {
  url: string;
  volume?: number;
}

export interface MixerPayload {
  songVolume?: number;
  instantVolume?: number;
  songMuted?: boolean;
  instantMuted?: boolean;
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
  private pollInFlight = false;

  constructor(
    private readonly config: ConfigService,
    readonly telemetry: PlaybackTelemetryService,
  ) {
    this.telnet = new LiquidsoapTelnetClient({
      port: this.telnetPort,
      onReconnect: () => this.telemetry.countReconnect(),
    });
  }

  async onModuleInit(): Promise<void> {
    const mount = this.config.get<string>('ICECAST_MOUNT') ?? '/stream';
    const port = Number(this.config.get<string>('ICECAST_PORT') ?? 8000);
    const password =
      this.config.get<string>('ICECAST_SOURCE_PASSWORD') ?? 'hackme';
    const streamName = this.config.get<string>('STREAM_NAME') ?? 'Palazzo';
    const genre = this.config.get<string>('STREAM_GENRE') ?? 'Various';
    const bitrate = Number(this.config.get<string>('BITRATE') ?? 128);
    const rtmpUrl = this.config.get<string>('RTMP_URL') || undefined;

    const script = buildLiquidsoapScript({
      telnetPort: this.telnetPort,
      icecastPort: port,
      icecastPassword: password,
      mount,
      streamName,
      genre,
      bitrate,
      rtmpUrl,
    });
    const directory = '/tmp/palazzo';
    const scriptPath = join(directory, 'stream.liq');
    await mkdir(directory, { recursive: true });
    await writeFile(scriptPath, script, 'utf8');

    // Validate the exact environment-specific script with the bundled engine
    // before starting the long-lived process.
    await execFileAsync('liquidsoap', ['--check', scriptPath], {
      timeout: 30_000,
    });

    this.process = spawn('liquidsoap', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.process.stdout?.on('data', (data: Buffer) =>
      this.logger.debug(data.toString().trim()),
    );
    this.process.stderr?.on('data', (data: Buffer) =>
      this.logger.debug(data.toString().trim()),
    );
    this.process.on('exit', (code) => {
      this.telemetry.markDisconnected();
      this.logger.warn(`Liquidsoap exited with code ${code}`);
    });

    this.pollTimer = setInterval(() => void this.pollTelemetry(), 100);
    this.pollTimer.unref();
    void this.pollTelemetry();
    this.logger.log(`Liquidsoap started, mount=${mount}`);
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.telnet.close();
    this.process?.kill();
  }

  getStatus() {
    return {
      mount: this.config.get('ICECAST_MOUNT') ?? '/stream',
      streamName: this.config.get('STREAM_NAME') ?? 'Palazzo',
      running: this.process !== null && this.process.exitCode === null,
      uptime: Date.now() - this.startedAt,
      playback: this.telemetry.getState(),
    };
  }

  async playSong(data: SongPayload): Promise<PlaybackRequestAccepted> {
    const playbackRequestId = randomUUID();
    const uri = this.annotatedUri(data.url, {
      palazzo_request_id: playbackRequestId,
      palazzo_url: data.url,
      title: data.title ?? '',
      artist: data.artist ?? '',
    });
    await this.telnet.send('songs.skip').catch(() => undefined);
    await this.telnet.send(`songs.push ${uri}`);
    return { ok: true, playbackRequestId };
  }

  async stopSong(): Promise<void> {
    await this.telnet.send('songs.skip').catch(() => undefined);
  }

  async playInstant(data: InstantPayload): Promise<PlaybackRequestAccepted> {
    const playbackRequestId = randomUUID();
    const uri = this.annotatedUri(data.url, {
      palazzo_request_id: playbackRequestId,
      palazzo_url: data.url,
      palazzo_kind: 'instant',
    });
    await this.telnet.send(`instants.push ${uri}`);
    return { ok: true, playbackRequestId };
  }

  async stopAllInstants(): Promise<void> {
    await this.telnet.send('instants.skip').catch(() => undefined);
  }

  async updateMixer(_data: MixerPayload): Promise<void> {}

  private async pollTelemetry(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const [snapshotResponse, eventsResponse] = await Promise.all([
        this.telnet.send('palazzo.snapshot'),
        this.telnet.send('palazzo.events'),
      ]);
      const snapshot = JSON.parse(snapshotResponse) as LiquidsoapSnapshot;
      const events = JSON.parse(eventsResponse) as LiquidsoapLifecycleEvent[];
      this.telemetry.apply(snapshot, events);
    } catch (error) {
      this.telemetry.markDisconnected();
      this.logger.debug(
        `Liquidsoap telemetry poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.pollInFlight = false;
    }
  }

  private annotatedUri(
    url: string,
    metadata: Record<string, string>,
  ): string {
    if (/\r|\n/.test(url)) throw new Error('Audio URL cannot contain newlines');
    const annotations = Object.entries(metadata)
      .map(([key, value]) => `${key}="${this.annotationValue(value)}"`)
      .join(',');
    return `annotate:${annotations}:${url}`;
  }

  private annotationValue(value: string): string {
    return value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }
}
