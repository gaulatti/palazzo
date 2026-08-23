import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Observable, Subject, concat, from } from 'rxjs';

export interface LiquidsoapLifecycleEvent {
  sequence: number;
  event_type: 'track_started' | 'track_ended';
  playback_request_id: string;
  title: string;
  artist: string;
  url: string;
  occurred_at: number;
}

export interface LiquidsoapSnapshot {
  liquidsoap_sequence: number;
  playing: boolean;
  playback_request_id: string;
  title: string;
  artist: string;
  url: string;
  started_at: number;
  elapsed: number;
  remaining: number;
  rms: number;
  peak: number;
  sampled_at: number;
}

export type PlaybackEventType =
  | 'telemetry.connected'
  | 'telemetry.disconnected'
  | 'track.started'
  | 'track.ended'
  | 'playback.position'
  | 'audio.levels'
  | 'heartbeat';

export interface PlaybackEvent {
  id: string;
  instanceId: string;
  bootId: string;
  sequence: number;
  type: PlaybackEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

export interface PlaybackState {
  instanceId: string;
  bootId: string;
  sequence: number;
  status: 'idle' | 'playing';
  telemetry: {
    connected: boolean;
    staleSince: string | null;
    lastSampleAt: string | null;
  };
  track: {
    playbackRequestId: string;
    title: string | null;
    artist: string | null;
    url: string;
    startedAt: string;
  } | null;
  positionSeconds: number;
  remainingSeconds: number | null;
  levels: { rms: number; peak: number };
}

const MAX_REPLAY_EVENTS = 512;

@Injectable()
export class PlaybackTelemetryService {
  readonly instanceId: string;
  readonly bootId = randomUUID();

  private sequence = 0;
  private liquidsoapSequence = 0;
  private connected = false;
  private staleSince: string | null = null;
  private lastSampleAt: string | null = null;
  private track: PlaybackState['track'] = null;
  private positionSeconds = 0;
  private remainingSeconds: number | null = null;
  private levels = { rms: 0, peak: 0 };
  private readonly replay: PlaybackEvent[] = [];
  private readonly live = new Subject<PlaybackEvent>();
  private lastPositionEventAt = 0;
  private lastHeartbeatAt = 0;
  private lifecycleStarted = 0;
  private lifecycleEnded = 0;
  private pollFailures = 0;
  private telnetReconnects = 0;
  private subscribers = 0;

  constructor(config: ConfigService) {
    this.instanceId = config.get<string>('PALAZZO_INSTANCE_ID') ?? 'palazzo';
  }

  apply(snapshot: LiquidsoapSnapshot, events: LiquidsoapLifecycleEvent[]): void {
    const now = Date.now();
    if (!this.connected) this.emit('telemetry.connected', {});
    this.connected = true;
    this.staleSince = null;
    this.lastSampleAt = new Date(snapshot.sampled_at * 1_000).toISOString();

    // A lower engine sequence means Liquidsoap restarted while Palazzo stayed
    // alive. Rebase the deduplication cursor and reconcile from its new journal.
    if (snapshot.liquidsoap_sequence < this.liquidsoapSequence) {
      this.liquidsoapSequence = 0;
    }

    for (const event of events) {
      if (event.sequence <= this.liquidsoapSequence) continue;
      this.liquidsoapSequence = event.sequence;
      this.applyLifecycle(event);
    }

    if (snapshot.playing) {
      this.track = {
        playbackRequestId: snapshot.playback_request_id,
        title: snapshot.title || null,
        artist: snapshot.artist || null,
        url: snapshot.url,
        startedAt: new Date(snapshot.started_at * 1_000).toISOString(),
      };
      this.positionSeconds = finiteOr(snapshot.elapsed, 0);
      this.remainingSeconds = finiteOrNull(snapshot.remaining);
    } else {
      this.track = null;
      this.positionSeconds = 0;
      this.remainingSeconds = null;
    }
    this.levels = {
      rms: clampLevel(snapshot.rms),
      peak: clampLevel(snapshot.peak),
    };

    this.emit('audio.levels', this.levels);
    if (now - this.lastPositionEventAt >= 1_000) {
      this.lastPositionEventAt = now;
      this.emit('playback.position', {
        playbackRequestId: this.track?.playbackRequestId ?? null,
        positionSeconds: this.positionSeconds,
        remainingSeconds: this.remainingSeconds,
        status: this.track ? 'playing' : 'idle',
      });
    }
    if (now - this.lastHeartbeatAt >= 10_000) {
      this.lastHeartbeatAt = now;
      this.emit('heartbeat', {
        liquidsoapSequence: snapshot.liquidsoap_sequence,
      });
    }
  }

  markDisconnected(): void {
    this.pollFailures += 1;
    if (!this.staleSince) this.staleSince = new Date().toISOString();
    if (!this.connected) return;
    this.connected = false;
    this.emit('telemetry.disconnected', { staleSince: this.staleSince });
    // Deliberately retain the last known track. A transport failure is not a
    // Liquidsoap track-end event.
  }

  countReconnect(): void {
    this.telnetReconnects += 1;
  }

  getState(): PlaybackState {
    return {
      instanceId: this.instanceId,
      bootId: this.bootId,
      sequence: this.sequence,
      status: this.track ? 'playing' : 'idle',
      telemetry: {
        connected: this.connected,
        staleSince: this.staleSince,
        lastSampleAt: this.lastSampleAt,
      },
      track: this.track,
      positionSeconds: this.positionSeconds,
      remainingSeconds: this.remainingSeconds,
      levels: this.levels,
    };
  }

  subscribe(lastEventId?: string): Observable<PlaybackEvent> {
    const replay = lastEventId
      ? this.eventsAfter(lastEventId)
      : [];
    return new Observable<PlaybackEvent>((subscriber) => {
      this.subscribers += 1;
      const subscription = concat(from(replay), this.live).subscribe(subscriber);
      return () => {
        this.subscribers = Math.max(0, this.subscribers - 1);
        subscription.unsubscribe();
      };
    });
  }

  renderMetrics(): string {
    const sampleAge = this.lastSampleAt
      ? Math.max(0, (Date.now() - Date.parse(this.lastSampleAt)) / 1_000)
      : 0;
    return [
      '# HELP palazzo_playback_active Whether a track is currently playing.',
      '# TYPE palazzo_playback_active gauge',
      `palazzo_playback_active ${this.track ? 1 : 0}`,
      '# HELP palazzo_telemetry_connected Whether the Liquidsoap telemetry bridge is connected.',
      '# TYPE palazzo_telemetry_connected gauge',
      `palazzo_telemetry_connected ${this.connected ? 1 : 0}`,
      '# HELP palazzo_telemetry_sample_age_seconds Age of the latest Liquidsoap sample.',
      '# TYPE palazzo_telemetry_sample_age_seconds gauge',
      `palazzo_telemetry_sample_age_seconds ${sampleAge}`,
      '# HELP palazzo_audio_rms Current linear RMS level.',
      '# TYPE palazzo_audio_rms gauge',
      `palazzo_audio_rms ${this.levels.rms}`,
      '# HELP palazzo_audio_peak Current linear peak level.',
      '# TYPE palazzo_audio_peak gauge',
      `palazzo_audio_peak ${this.levels.peak}`,
      '# HELP palazzo_playback_position_seconds Current track position.',
      '# TYPE palazzo_playback_position_seconds gauge',
      `palazzo_playback_position_seconds ${this.positionSeconds}`,
      '# HELP palazzo_track_lifecycle_total Observed Liquidsoap track lifecycle events.',
      '# TYPE palazzo_track_lifecycle_total counter',
      `palazzo_track_lifecycle_total{event="started"} ${this.lifecycleStarted}`,
      `palazzo_track_lifecycle_total{event="ended"} ${this.lifecycleEnded}`,
      '# HELP palazzo_telemetry_poll_failures_total Failed telemetry polls.',
      '# TYPE palazzo_telemetry_poll_failures_total counter',
      `palazzo_telemetry_poll_failures_total ${this.pollFailures}`,
      '# HELP palazzo_telnet_reconnects_total Liquidsoap command socket reconnect attempts.',
      '# TYPE palazzo_telnet_reconnects_total counter',
      `palazzo_telnet_reconnects_total ${this.telnetReconnects}`,
      '# HELP palazzo_sse_subscribers Current playback event subscribers.',
      '# TYPE palazzo_sse_subscribers gauge',
      `palazzo_sse_subscribers ${this.subscribers}`,
      '',
    ].join('\n');
  }

  private applyLifecycle(event: LiquidsoapLifecycleEvent): void {
    const data = {
      playbackRequestId: event.playback_request_id,
      title: event.title || null,
      artist: event.artist || null,
      url: event.url,
      liquidsoapSequence: event.sequence,
    };
    const occurredAt = new Date(event.occurred_at * 1_000).toISOString();
    if (event.event_type === 'track_started') {
      this.lifecycleStarted += 1;
      this.emit('track.started', data, occurredAt);
    } else {
      this.lifecycleEnded += 1;
      this.emit('track.ended', data, occurredAt);
    }
  }

  private emit(
    type: PlaybackEventType,
    data: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): void {
    this.sequence += 1;
    const event: PlaybackEvent = {
      id: `${this.bootId}:${this.sequence}`,
      instanceId: this.instanceId,
      bootId: this.bootId,
      sequence: this.sequence,
      type,
      occurredAt,
      data,
    };
    this.replay.push(event);
    if (this.replay.length > MAX_REPLAY_EVENTS) this.replay.shift();
    this.live.next(event);
  }

  private eventsAfter(lastEventId: string): PlaybackEvent[] {
    const index = this.replay.findIndex((event) => event.id === lastEventId);
    if (index >= 0) return this.replay.slice(index + 1);

    const [bootId, rawSequence] = lastEventId.split(':');
    const sequence = Number(rawSequence);
    if (bootId !== this.bootId || !Number.isFinite(sequence)) return [];
    return this.replay.filter((event) => event.sequence > sequence);
  }
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function clampLevel(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}
