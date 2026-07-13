import { Injectable } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';

interface StreamConfig {
  telnetPort: number;
  icecastHost: string;
  icecastPort: number;
  icecastPassword: string;
  mount: string;
  streamName: string;
  streamGenre: string;
  bitrate: number;
}

@Injectable()
export class ScriptService {
  private readonly templatePath = join(
    process.cwd(),
    'src',
    'templates',
    'stream.liq.template',
  );

  render(config: StreamConfig): string {
    const template = readFileSync(this.templatePath, 'utf8');

    return template
      .replaceAll('{{TELNET_PORT}}', String(config.telnetPort))
      .replaceAll('{{ICECAST_HOST}}', config.icecastHost)
      .replaceAll('{{ICECAST_PORT}}', String(config.icecastPort))
      .replaceAll('{{ICECAST_PASSWORD}}', config.icecastPassword)
      .replaceAll('{{MOUNT}}', config.mount)
      .replaceAll('{{STREAM_NAME}}', config.streamName)
      .replaceAll('{{STREAM_GENRE}}', config.streamGenre)
      .replaceAll('{{BITRATE}}', String(config.bitrate));
  }
}
