import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { ScriptService } from './script.service';
import { TelnetService } from './telnet.service';

export interface StreamConfig {
  id?: string;
  mount: string;
  streamName: string;
  streamGenre: string;
  bitrate: number;
  icecastHost: string;
  icecastPort: number;
  icecastPassword: string;
}

export interface StreamStatus {
  id: string;
  mount: string;
  streamName: string;
  streamGenre: string;
  bitrate: number;
  icecastUrl: string;
  telnetPort: number;
  running: boolean;
  nowPlaying: { title: string; artist: string; url: string } | null;
  uptime: number;
}

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

interface StreamRecord {
  id: string;
  config: StreamConfig;
  process: ChildProcess | null;
  telnetPort: number;
  createdAt: number;
  nowPlaying: { title: string; artist: string; url: string } | null;
}

@Injectable()
export class StreamService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private readonly streams = new Map<string, StreamRecord>();
  private readonly defaultIcecastHost: string;
  private readonly defaultIcecastPort: number;
  private readonly defaultIcecastPassword: string;
  private readonly streamsDir: string;
  private readonly telnetPortStart: number;
  private readonly telnetPortEnd: number;
  private nextTelnetPort: number;

  constructor(
    private readonly scriptService: ScriptService,
    private readonly telnetService: TelnetService,
    private readonly configService: ConfigService,
  ) {
    this.defaultIcecastHost =
      this.configService.get<string>('ICECAST_HOST') ?? 'icecast';
    this.defaultIcecastPort = Number(
      this.configService.get<number>('ICECAST_PORT') ?? 8000,
    );
    this.defaultIcecastPassword =
      this.configService.get<string>('ICECAST_SOURCE_PASSWORD') ?? 'hackme';

    this.streamsDir =
      this.configService.get<string>('STREAMS_WORKDIR') ?? '/tmp/palazzo-streams';

    this.telnetPortStart = Number(
      this.configService.get<number>('TELNET_PORT_START') ?? 14000,
    );
    this.telnetPortEnd = Number(
      this.configService.get<number>('TELNET_PORT_END') ?? 14999,
    );
    this.nextTelnetPort = this.telnetPortStart;
  }

  async onModuleDestroy(): Promise<void> {
    this.telnetService.removeAll();
    for (const [, record] of this.streams) {
      this.killProcess(record);
    }
    this.streams.clear();
  }

  async createStream(config: StreamConfig): Promise<StreamStatus> {
    const id = config.id ?? randomUUID();
    if (this.streams.has(id)) {
      throw new Error(`Stream ${id} already exists`);
    }

    const resolved: StreamConfig = {
      ...config,
      id,
      icecastHost: config.icecastHost || this.defaultIcecastHost,
      icecastPort: config.icecastPort || this.defaultIcecastPort,
      icecastPassword:
        config.icecastPassword || this.defaultIcecastPassword,
    };

    const mount = resolved.mount.startsWith('/')
      ? resolved.mount
      : `/${resolved.mount}`;

    const telnetPort = this.allocateTelnetPort();

    const script = this.scriptService.render({
      telnetPort,
      icecastHost: resolved.icecastHost,
      icecastPort: resolved.icecastPort,
      icecastPassword: resolved.icecastPassword,
      mount,
      streamName: resolved.streamName,
      streamGenre: resolved.streamGenre,
      bitrate: resolved.bitrate,
    });

    const streamDir = join(this.streamsDir, id);
    await mkdir(streamDir, { recursive: true });
    const scriptPath = join(streamDir, 'stream.liq');
    await writeFile(scriptPath, script, 'utf8');

    const proc = spawn('liquidsoap', [scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      this.logger.debug(`[${id}] ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data: Buffer) => {
      this.logger.debug(`[${id}] ${data.toString().trim()}`);
    });
    proc.on('exit', (code, signal) => {
      this.logger.warn(`[${id}] Liquidsoap exited code=${code} signal=${signal}`);
      const record = this.streams.get(id);
      if (record) record.process = null;
    });

    await new Promise((resolve) => setTimeout(resolve, 3000));

    this.telnetService.registerEndpoint(id, 'localhost', telnetPort);

    const record: StreamRecord = {
      id,
      config: resolved,
      process: proc,
      telnetPort,
      createdAt: Date.now(),
      nowPlaying: null,
    };
    this.streams.set(id, record);

    this.logger.log(`Stream ${id} created (mount=${mount}, telnet=${telnetPort})`);
    return this.toStatus(record);
  }

  async destroyStream(id: string): Promise<void> {
    const record = this.streams.get(id);
    if (!record) {
      throw new Error(`Stream ${id} not found`);
    }

    this.telnetService.removeEndpoint(id);
    this.killProcess(record);

    this.streams.delete(id);

    this.logger.log(`Stream ${id} destroyed`);
  }

  async playSong(id: string, song: SongPayload): Promise<void> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);

    const escapedUrl = this.escapeTelnetString(song.url);
    const title = song.title ?? '';
    const artist = song.artist ?? '';

    let command: string;
    if (title || artist) {
      command =
        `songs.push annotate:title="${title}",annotate:artist="${artist}":${escapedUrl}`;
    } else {
      command = `songs.push ${escapedUrl}`;
    }

    await this.telnetService.send(id, command);
    record.nowPlaying = {
      title: title || this.basenameFromUrl(song.url),
      artist: artist || 'Unknown',
      url: song.url,
    };
  }

  async stopSong(id: string): Promise<void> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);

    await this.telnetService.send(id, 'songs.skip');
    record.nowPlaying = null;
  }

  async playInstant(id: string, instant: InstantPayload): Promise<void> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);

    const escapedUrl = this.escapeTelnetString(instant.url);
    await this.telnetService.send(id, `instants.push ${escapedUrl}`);

    if (typeof instant.volume === 'number' && Number.isFinite(instant.volume)) {
      const vol = Math.max(0, Math.min(1, instant.volume));
      await this.telnetService.send(
        id,
        `var.set instant_volume ${vol}`,
      ).catch(() => {});
    }
  }

  async stopAllInstants(id: string): Promise<void> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);

    await this.telnetService.send(id, 'instants.skip').catch(() => {});

    const lines = await this.telnetService.send(id, 'request.trace instants');
    const entries = lines
      .split('\n')
      .filter((l) => l.trim().length > 0);

    for (const entry of entries) {
      const match = /\| (\d+) /.exec(entry);
      if (match) {
        await this.telnetService
          .send(id, `instants.remove ${match[1]}`)
          .catch(() => {});
      }
    }
  }

  async updateMixer(id: string, mixer: MixerPayload): Promise<void> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);

    if (typeof mixer.songVolume === 'number') {
      const vol = this.clampVolume(mixer.songVolume);
      await this.telnetService
        .send(id, `var.set song_volume ${vol}`)
        .catch(() => {});
    }

    if (typeof mixer.instantVolume === 'number') {
      const vol = this.clampVolume(mixer.instantVolume);
      await this.telnetService
        .send(id, `var.set instant_volume ${vol}`)
        .catch(() => {});
    }

    if (typeof mixer.songMuted === 'boolean') {
      await this.telnetService
        .send(id, `var.set song_muted ${mixer.songMuted}`)
        .catch(() => {});
    }

    if (typeof mixer.instantMuted === 'boolean') {
      await this.telnetService
        .send(id, `var.set instant_muted ${mixer.instantMuted}`)
        .catch(() => {});
    }
  }

  async getStatus(id: string): Promise<StreamStatus> {
    const record = this.streams.get(id);
    if (!record) throw new Error(`Stream ${id} not found`);
    return this.toStatus(record);
  }

  async listStreams(): Promise<StreamStatus[]> {
    const results: StreamStatus[] = [];
    for (const [, record] of this.streams) {
      results.push(this.toStatus(record));
    }
    return results;
  }

  private allocateTelnetPort(): number {
    const port = this.nextTelnetPort;
    this.nextTelnetPort =
      this.nextTelnetPort >= this.telnetPortEnd
        ? this.telnetPortStart
        : this.nextTelnetPort + 1;
    return port;
  }

  private killProcess(record: StreamRecord): void {
    if (record.process) {
      record.process.kill('SIGTERM');
      setTimeout(() => {
        if (record.process) record.process.kill('SIGKILL');
      }, 5000);
    }
  }

  private toStatus(record: StreamRecord): StreamStatus {
    const cfg = record.config;
    return {
      id: record.id,
      mount: cfg.mount,
      streamName: cfg.streamName,
      streamGenre: cfg.streamGenre,
      bitrate: cfg.bitrate,
      icecastUrl: `http://${cfg.icecastHost}:${cfg.icecastPort}${cfg.mount}`,
      telnetPort: record.telnetPort,
      running: record.process !== null && record.process.exitCode === null,
      nowPlaying: record.nowPlaying,
      uptime: Date.now() - record.createdAt,
    };
  }

  private escapeTelnetString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private clampVolume(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private basenameFromUrl(url: string): string {
    try {
      const parsed = new URL(url);
      const parts = parsed.pathname.split('/');
      return decodeURIComponent(parts[parts.length - 1]) || 'audio';
    } catch {
      return 'audio';
    }
  }
}
