import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PlaybackTelemetryService } from './playback-telemetry.service';
import { StreamService } from './stream.service';
import { FillerStoreService } from './filler-store.service';

type RequestedState = 'reconciliation-required' | 'running' | 'stopped';
type ActualState =
  | 'reconciliation-required'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stopped'
  | 'degraded'
  | 'failed';
type CommandAction = 'start' | 'stop';

interface CommandRecord {
  id: string;
  action: CommandAction;
  sequence: number;
  result: string;
  status: number;
  acceptedAt: string;
  fillerVersion: string | null;
}

@Injectable()
export class BroadcastLifecycleService {
  readonly programId: string;
  readonly instanceId: string;

  private readonly tokenFile: string;
  private readonly transitionTimeoutMs: number;
  private readonly bootedAt = new Date().toISOString();
  private requestedState: RequestedState = 'reconciliation-required';
  private actualState: ActualState = 'reconciliation-required';
  private transition: 'starting' | 'stopping' | null = null;
  private lastSequence = 0;
  private lastCommand: CommandRecord | null = null;
  private readonly commands = new Map<string, CommandRecord>();
  private commandTail: Promise<void> = Promise.resolve();
  private timestamps = {
    requestedAt: null as string | null,
    transitionStartedAt: null as string | null,
    readyAt: null as string | null,
    stoppedAt: null as string | null,
  };

  constructor(
    config: ConfigService,
    private readonly stream: StreamService,
    private readonly telemetry: PlaybackTelemetryService,
    private readonly fillerStore: FillerStoreService,
  ) {
    this.programId = config.get<string>('PROGRAM_ID')?.trim() ?? '';
    if (!this.programId) throw new Error('PROGRAM_ID is required');
    this.instanceId =
      config.get<string>('PALAZZO_INSTANCE_ID')?.trim() || 'palazzo';
    this.tokenFile =
      config.get<string>('PALAZZO_CONTROL_TOKEN_FILE')?.trim() ||
      '/run/secrets/palazzo-control-token';
    const configuredTimeout = Number(
      config.get<string>('LIFECYCLE_TRANSITION_TIMEOUT_MS') ?? 5_000,
    );
    if (!Number.isInteger(configuredTimeout) || configuredTimeout < 1) {
      throw new Error(
        'LIFECYCLE_TRANSITION_TIMEOUT_MS must be a positive integer',
      );
    }
    this.transitionTimeoutMs = configuredTimeout;
  }

  async authorize(programId: string, authorization?: string): Promise<void> {
    let expected: string;
    try {
      expected = (await readFile(this.tokenFile, 'utf8')).trim();
    } catch {
      throw new UnauthorizedException('control authentication unavailable');
    }
    const prefix = 'Bearer ';
    const supplied = authorization?.startsWith(prefix)
      ? authorization.slice(prefix.length)
      : '';
    if (!expected || !this.equalSecret(supplied, expected)) {
      throw new UnauthorizedException('unauthorized');
    }
    if (programId !== this.programId) {
      throw new NotFoundException('program not found');
    }
  }

  getState() {
    const playback = this.telemetry.getState();
    const dependencies = {
      liquidsoap: playback.liquidsoap.running,
      control: playback.liquidsoap.connected,
      icecast: playback.icecast.connected,
    };
    const healthy =
      dependencies.liquidsoap && dependencies.control && dependencies.icecast;
    if (!this.transition && this.actualState !== 'failed') {
      if (this.requestedState === 'reconciliation-required') {
        this.actualState = healthy ? 'reconciliation-required' : 'degraded';
      } else if (this.requestedState === 'running') {
        this.actualState = healthy ? 'ready' : 'degraded';
      } else {
        this.actualState = healthy ? 'stopped' : 'degraded';
      }
    }
    return {
      schemaVersion: 1,
      programId: this.programId,
      instanceId: this.instanceId,
      requestedState: this.requestedState,
      actualState: this.actualState,
      readiness: this.actualState === 'ready' && healthy,
      filler: {
        activeVersion: this.fillerStore.getActiveVersion(),
        ready: this.fillerStore.getActiveVersion() !== null,
      },
      transition: this.transition,
      dependencies,
      playback,
      lastSequence: this.lastSequence,
      lastCommand: this.lastCommand,
      timestamps: {
        bootedAt: this.bootedAt,
        ...this.timestamps,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  requireReady(): void {
    const state = this.getState();
    if (!state.readiness) {
      throw new ConflictException({
        error: 'automation is not ready',
        lifecycle: state,
      });
    }
  }

  startFromPlaybackCommand(): void {
    const state = this.getState();
    if (state.readiness) return;
    if (
      !this.transition &&
      state.dependencies.liquidsoap &&
      state.dependencies.control &&
      state.dependencies.icecast
    ) {
      const stamp = new Date().toISOString();
      this.requestedState = 'running';
      this.actualState = 'ready';
      this.timestamps.requestedAt = stamp;
      this.timestamps.readyAt = stamp;
      return;
    }
    throw new ConflictException({
      error: 'automation is not ready',
      lifecycle: state,
    });
  }

  start(
    key: string | undefined,
    sequenceText: string | undefined,
    fillerVersion: string | undefined,
  ) {
    return this.enqueue(() =>
      this.execute('start', key, sequenceText, fillerVersion?.trim() || null),
    );
  }

  stop(key: string | undefined, sequenceText: string | undefined) {
    return this.enqueue(() => this.execute('stop', key, sequenceText, null));
  }

  private async execute(
    action: CommandAction,
    key: string | undefined,
    sequenceText: string | undefined,
    fillerVersion: string | null,
  ) {
    const commandKey = key?.trim() ?? '';
    const sequence = Number(sequenceText);
    if (!commandKey || commandKey.length > 200) {
      throw new BadRequestException('a bounded Idempotency-Key is required');
    }
    if (!Number.isInteger(sequence) || sequence < 1) {
      throw new BadRequestException(
        'X-Command-Sequence must be a positive integer',
      );
    }

    const digest = createHash('sha256').update(commandKey).digest('hex');
    const prior = this.commands.get(digest);
    if (prior) {
      if (
        prior.action !== action ||
        prior.sequence !== sequence ||
        prior.fillerVersion !== fillerVersion
      ) {
        throw new ConflictException(
          'idempotency key was already used for another command',
        );
      }
      const state = {
        ...this.getState(),
        commandResult: { ...prior, duplicate: true },
      };
      if (prior.status >= 500) throw new ServiceUnavailableException(state);
      return state;
    }
    if (sequence <= this.lastSequence) {
      throw new ConflictException({
        error: 'command sequence is not newer than the last accepted command',
        lastAcceptedSequence: this.lastSequence,
      });
    }

    if (action === 'start') {
      if (!fillerVersion) {
        throw new BadRequestException('X-Filler-Version is required');
      }
      const activeVersion = this.fillerStore.getActiveVersion();
      if (
        this.requestedState === 'running' &&
        activeVersion &&
        activeVersion !== fillerVersion
      ) {
        throw new ConflictException(
          'active session filler version is immutable',
        );
      }
      await this.fillerStore.activate(fillerVersion);
    }

    const stamp = new Date().toISOString();
    this.requestedState = action === 'start' ? 'running' : 'stopped';
    this.actualState = action === 'start' ? 'starting' : 'stopping';
    this.transition = action === 'start' ? 'starting' : 'stopping';
    this.timestamps.requestedAt = stamp;
    this.timestamps.transitionStartedAt = stamp;

    if (action === 'start') {
      const ready = await this.waitFor(() => this.dependenciesReady());
      this.transition = null;
      if (!ready) {
        await this.fillerStore.deactivate();
        return this.finishFailure(
          digest,
          action,
          sequence,
          'dependencies-not-ready',
          fillerVersion,
        );
      }
      this.actualState = 'ready';
      this.timestamps.readyAt = new Date().toISOString();
      return this.finish(digest, action, sequence, 'ready', 200, fillerVersion);
    }

    try {
      await this.stream.clearProgramMaterial();
      await this.fillerStore.deactivate();
      const idle = await this.waitFor(() => this.playbackIdle());
      this.transition = null;
      if (!idle) {
        return this.finishFailure(
          digest,
          action,
          sequence,
          'playback-did-not-reach-idle',
          null,
        );
      }
      this.actualState = this.dependenciesReady() ? 'stopped' : 'degraded';
      this.timestamps.stoppedAt = new Date().toISOString();
      return this.finish(digest, action, sequence, 'stopped', 200, null);
    } catch {
      this.transition = null;
      return this.finishFailure(
        digest,
        action,
        sequence,
        'queue-clear-failed',
        null,
      );
    }
  }

  private finishFailure(
    digest: string,
    action: CommandAction,
    sequence: number,
    result: string,
    fillerVersion: string | null,
  ): never {
    this.actualState = 'failed';
    const state = this.finish(
      digest,
      action,
      sequence,
      result,
      503,
      fillerVersion,
    );
    throw new ServiceUnavailableException(state);
  }

  private finish(
    digest: string,
    action: CommandAction,
    sequence: number,
    result: string,
    status: number,
    fillerVersion: string | null,
  ) {
    const record: CommandRecord = {
      id: digest.slice(0, 16),
      action,
      sequence,
      result,
      status,
      acceptedAt: new Date().toISOString(),
      fillerVersion,
    };
    this.lastSequence = sequence;
    this.lastCommand = record;
    this.commands.set(digest, record);
    if (this.commands.size > 256) {
      const oldest = this.commands.keys().next().value as string | undefined;
      if (oldest) this.commands.delete(oldest);
    }
    return { ...this.getState(), commandResult: record };
  }

  private dependenciesReady(): boolean {
    const state = this.telemetry.getState();
    return (
      state.liquidsoap.running &&
      state.liquidsoap.connected &&
      state.icecast.connected
    );
  }

  private playbackIdle(): boolean {
    const state = this.telemetry.getState();
    return state.status === 'idle' && state.levels.instant.peak === 0;
  }

  private async waitFor(predicate: () => boolean): Promise<boolean> {
    const deadline = Date.now() + this.transitionTimeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.commandTail.then(operation, operation);
    this.commandTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private equalSecret(supplied: string, expected: string): boolean {
    const left = Buffer.from(supplied);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}
