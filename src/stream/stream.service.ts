import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChildProcess, spawn } from 'child_process';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { Socket } from 'net';

export interface SongPayload { url: string; title?: string; artist?: string; }
export interface InstantPayload { url: string; volume?: number; }
export interface MixerPayload { songVolume?: number; instantVolume?: number; songMuted?: boolean; instantMuted?: boolean; }

@Injectable()
export class StreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamService.name);
  private process: ChildProcess | null = null;
  private readonly telnetPort = 14000;
  private readonly startedAt = Date.now();

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const mount  = this.config.get<string>('ICECAST_MOUNT') ?? '/stream';
    const port   = Number(this.config.get<string>('ICECAST_PORT') ?? 8000);
    const pass   = this.config.get<string>('ICECAST_SOURCE_PASSWORD') ?? 'hackme';
    const name   = this.config.get<string>('STREAM_NAME') ?? 'Palazzo';
    const genre  = this.config.get<string>('STREAM_GENRE') ?? 'Various';
    const br     = Number(this.config.get<string>('BITRATE') ?? 128);
    const rtmp   = this.config.get<string>('RTMP_URL') || null;

    const rtmpIn = rtmp ? `live = mksafe(input.rtmp("${rtmp}"))` : '';
    const rtmpSrc = rtmp ? ', live' : '';

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

    this.process = spawn('liquidsoap', [join(dir, 'stream.liq')], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.process.stdout?.on('data', (d: Buffer) => this.logger.debug(d.toString().trim()));
    this.process.stderr?.on('data', (d: Buffer) => this.logger.debug(d.toString().trim()));
    this.process.on('exit', (c) => this.logger.warn(`Liquidsoap exited with code ${c}`));

    this.logger.log(`Liquidsoap started, mount=${mount}`);
  }

  onModuleDestroy(): void { this.process?.kill(); }

  getStatus() {
    return {
      mount: this.config.get('ICECAST_MOUNT') ?? '/stream',
      streamName: this.config.get('STREAM_NAME') ?? 'Palazzo',
      running: this.process !== null && this.process.exitCode === null,
      uptime: Date.now() - this.startedAt,
    };
  }

  async playSong(data: SongPayload): Promise<void> {
    await this.telnet('songs.skip').catch(() => {});
    await this.telnet(`songs.push ${this.esc(data.url)}`);
  }

  async stopSong(): Promise<void> {
    await this.telnet('songs.skip').catch(() => {});
  }

  async playInstant(data: InstantPayload): Promise<void> {
    await this.telnet(`instants.push ${this.esc(data.url)}`);
  }

  async stopAllInstants(): Promise<void> {
    await this.telnet('instants.skip').catch(() => {});
  }

  async updateMixer(_data: MixerPayload): Promise<void> {}

  private telnet(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      socket.connect(this.telnetPort, '127.0.0.1', () => socket.write(command + '\n', 'utf8'));
      socket.on('data', (d: Buffer) => chunks.push(d));
      const t = setTimeout(() => { socket.destroy(); resolve(Buffer.concat(chunks).toString('utf8').trimEnd()); }, 500);
      socket.on('close', () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString('utf8').trimEnd()); });
      socket.on('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  private esc(s: string): string {
    return s.includes(' ') ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
  }
}
