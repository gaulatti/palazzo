import { Injectable, Logger } from '@nestjs/common';
import { Socket } from 'net';

interface TelnetCommand {
  command: string;
  resolve: (result: string) => void;
  reject: (err: Error) => void;
}

@Injectable()
export class TelnetService {
  private readonly logger = new Logger(TelnetService.name);
  private readonly hosts = new Map<string, { host: string; port: number }>();

  registerEndpoint(streamId: string, host: string, port: number): void {
    this.hosts.set(streamId, { host, port });
  }

  removeEndpoint(streamId: string): void {
    this.hosts.delete(streamId);
  }

  async send(streamId: string, command: string): Promise<string> {
    const endpoint = this.hosts.get(streamId);
    if (!endpoint) {
      throw new Error(`No telnet endpoint for stream ${streamId}`);
    }

    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];

      socket.connect(endpoint.port, endpoint.host, () => {
        socket.write(command + '\n', 'utf8');
      });

      socket.on('data', (data: Buffer) => {
        chunks.push(data);
      });

      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
      }, 500);

      socket.on('close', () => {
        clearTimeout(timeout);
        resolve(Buffer.concat(chunks).toString('utf8').trimEnd());
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  removeAll(): void {
    this.hosts.clear();
  }
}
