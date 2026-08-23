import { Socket } from 'node:net';

const RESPONSE_TERMINATOR = /\r?\nEND\r?\n/;

export interface LiquidsoapTelnetClientOptions {
  host?: string;
  port: number;
  commandTimeoutMs?: number;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  onReconnect?: () => void;
}

/**
 * A persistent, serialized client for Liquidsoap's line-oriented command
 * server. Liquidsoap terminates every response with a standalone `END` line.
 */
export class LiquidsoapTelnetClient {
  private socket: Socket | null = null;
  private buffer = '';
  private hasConnected = false;
  private tail: Promise<unknown> = Promise.resolve();
  private current:
    | {
        resolve: (value: string) => void;
        reject: (error: Error) => void;
        timer: NodeJS.Timeout;
      }
    | undefined;
  private readonly host: string;
  private readonly commandTimeoutMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectBaseDelayMs: number;

  constructor(private readonly options: LiquidsoapTelnetClientOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.commandTimeoutMs = options.commandTimeoutMs ?? 2_000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? 100;
  }

  send(command: string): Promise<string> {
    const operation = this.tail.then(() => this.execute(command));
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  close(): void {
    this.rejectCurrent(new Error('Liquidsoap Telnet client closed'));
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
  }

  private async execute(command: string): Promise<string> {
    const socket = await this.connectWithRetry();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          `Liquidsoap command timed out after ${this.commandTimeoutMs}ms`,
        );
        this.rejectCurrent(error);
        socket.destroy();
      }, this.commandTimeoutMs);

      this.current = { resolve, reject, timer };
      socket.write(`${command}\n`, 'utf8', (error) => {
        if (!error) return;
        this.rejectCurrent(error);
        socket.destroy();
      });
    });
  }

  private async connectWithRetry(): Promise<Socket> {
    if (this.socket && !this.socket.destroyed) return this.socket;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < this.maxReconnectAttempts; attempt += 1) {
      try {
        if (this.hasConnected || attempt > 0) {
          this.options.onReconnect?.();
        }
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(
              resolve,
              Math.min(this.reconnectBaseDelayMs * 2 ** (attempt - 1), 2_000),
            ),
          );
        }
        const socket = await this.connect();
        this.hasConnected = true;
        return socket;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    throw new Error(
      `Unable to connect to Liquidsoap after ${this.maxReconnectAttempts} attempts: ${lastError?.message ?? 'unknown error'}`,
    );
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = new Socket();
      const fail = (error: Error) => {
        socket.destroy();
        reject(error);
      };

      socket.once('error', fail);
      socket.connect(this.options.port, this.host, () => {
        socket.off('error', fail);
        socket.setKeepAlive(true, 5_000);
        socket.on('data', (chunk: Buffer) => this.onData(chunk));
        socket.on('error', (error) => this.onSocketFailure(error));
        socket.on('close', () =>
          this.onSocketFailure(new Error('Liquidsoap Telnet connection closed')),
        );
        this.socket = socket;
        resolve(socket);
      });
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    const match = RESPONSE_TERMINATOR.exec(this.buffer);
    if (!match || !this.current) return;

    const response = this.buffer.slice(0, match.index).replace(/^\r?\n/, '');
    this.buffer = this.buffer.slice(match.index + match[0].length);
    const current = this.current;
    this.current = undefined;
    clearTimeout(current.timer);
    current.resolve(response);
  }

  private onSocketFailure(error: Error): void {
    this.rejectCurrent(error);
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
  }

  private rejectCurrent(error: Error): void {
    if (!this.current) return;
    const current = this.current;
    this.current = undefined;
    clearTimeout(current.timer);
    current.reject(error);
  }
}
