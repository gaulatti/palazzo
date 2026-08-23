import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  Observable,
  Subject,
  concat,
  filter,
  from,
  merge,
  throttleTime,
} from 'rxjs';

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
  song_rms: number;
  song_peak: number;
  instant_rms: number;
  instant_peak: number;
  output_rms: number;
  output_peak: number;
  sampled_at: number;
}

export type PlaybackEventType =
  | 'snapshot'
  | 'telemetry.connected'
  | 'telemetry.disconnected'
  | 'track.started'
  | 'track.ended'
  | 'playback.position'
  | 'audio.levels'
  | 'heartbeat';

export interface PlaybackEvent {
  schemaVersion: 1;
  id: string;
  instanceId: string;
  bootId: string;
  sequence: number;
  type: PlaybackEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

interface AudioLevel {
  rms: number;
  peak: number;
}

interface AudioLevels {
  song: AudioLevel;
  instant: AudioLevel;
  output: AudioLevel;
}

export interface PlaybackState {
  schemaVersion: 1;
  instanceId: string;
  bootId: string;
  sequence: number;
  availability: 'available' | 'degraded';
  status: 'idle' | 'playing';
  liquidsoap: {
    running: boolean;
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
  levels: AudioLevels;
}

const MAX_REPLAY_EVENTS = 512;
const LEVEL_EVENT_INTERVAL_MS = 100;
const NORMALIZED_ROUTES = new Set([
  '/status',
  '/song',
  '/song/stop',
  '/instant',
  '/instant/stop',
  '/mixer',
  '/playback/state',
  '/playback/events',
  '/metrics',
  '/proxy-audio',
]);

@Injectable()
export class PlaybackTelemetryService {
  readonly instanceId: string;
  readonly bootId = randomUUID();

  private sequence = 0;
  private liquidsoapSequence = 0;
  private running = false;
  private connected = false;
  private staleSince: string | null = null;
  private lastSampleAt: string | null = null;
  private track: PlaybackState['track'] = null;
  private positionSeconds = 0;
  private remainingSeconds: number | null = null;
  private levels: AudioLevels = emptyLevels();
  private readonly replay: PlaybackEvent[] = [];
  private readonly snapshotByEventId = new Map<string, PlaybackState>();
  private readonly live = new Subject<PlaybackEvent>();
  private lastLevelEventAt = 0;
  private lastPositionEventAt = 0;
  private lastHeartbeatAt = 0;
  private lifecycleStarted = 0;
  private lifecycleEnded = 0;
  private pollSamples = 0;
  private pollFailures = 0;
  private parseFailures = 0;
  private telnetReconnects = 0;
  private processRestarts = 0;
  private subscribers = 0;
  private levelSamplesCoalesced = 0;
  private replayLevelsDropped = 0;
  private replayOtherDropped = 0;
  private readonly httpMetrics = new Map<
    string,
    { count: number; durationSeconds: number }
  >();

  constructor(config: ConfigService) {
    this.instanceId = config.get<string>('PALAZZO_INSTANCE_ID') ?? 'palazzo';
  }

  apply(snapshot: LiquidsoapSnapshot, events: LiquidsoapLifecycleEvent[]): void {
    const now = Date.now();
    this.pollSamples += 1;
    const becameConnected = !this.connected;
    this.connected = true;
    this.staleSince = null;
    this.lastSampleAt = new Date(snapshot.sampled_at * 1_000).toISOString();
    if (becameConnected) this.emit('telemetry.connected', {});

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
      this.track = trackFromSnapshot(snapshot);
      this.positionSeconds = finiteOr(snapshot.elapsed, 0);
      this.remainingSeconds = finiteOrNull(snapshot.remaining);
    } else {
      this.track = null;
      this.positionSeconds = 0;
      this.remainingSeconds = null;
    }
    this.levels = {
      song: snapshot.playing
        ? level(snapshot.song_rms, snapshot.song_peak)
        : { rms: 0, peak: 0 },
      instant: level(snapshot.instant_rms, snapshot.instant_peak),
      output: level(snapshot.output_rms, snapshot.output_peak),
    };

    if (now - this.lastLevelEventAt >= LEVEL_EVENT_INTERVAL_MS) {
      this.lastLevelEventAt = now;
      this.emit('audio.levels', { ...this.levels });
    } else {
      this.levelSamplesCoalesced += 1;
    }
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

  setLiquidsoapRunning(running: boolean): void {
    this.running = running;
  }

  markDisconnected(): void {
    this.pollFailures += 1;
    if (!this.staleSince) this.staleSince = new Date().toISOString();
    if (!this.connected) return;
    this.connected = false;
    this.emit('telemetry.disconnected', { staleSince: this.staleSince });
    // Deliberately retain the last-known track. A transport failure is not a
    // Liquidsoap track-end event.
  }

  markParseFailure(): void {
    this.parseFailures += 1;
  }

  countReconnect(): void {
    this.telnetReconnects += 1;
  }

  countProcessRestart(): void {
    this.processRestarts += 1;
  }

  shutdown(): void {
    this.live.complete();
  }

  observeHttp(
    method: string,
    route: string | undefined,
    statusCode: number,
    durationMs: number,
  ): void {
    const normalizedRoute =
      route && NORMALIZED_ROUTES.has(route) ? route : 'unmatched';
    const status = `${Math.floor(statusCode / 100)}xx`;
    const key = `${method.toUpperCase()}\t${normalizedRoute}\t${status}`;
    const current = this.httpMetrics.get(key) ?? {
      count: 0,
      durationSeconds: 0,
    };
    current.count += 1;
    current.durationSeconds += Math.max(0, durationMs / 1_000);
    this.httpMetrics.set(key, current);
  }

  getState(): PlaybackState {
    return {
      schemaVersion: 1,
      instanceId: this.instanceId,
      bootId: this.bootId,
      sequence: this.sequence,
      availability: this.connected && this.running ? 'available' : 'degraded',
      status: this.track ? 'playing' : 'idle',
      liquidsoap: {
        running: this.running,
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
    const replay = lastEventId ? this.eventsAfter(lastEventId) : [];
    const replaySnapshot = lastEventId
      ? this.snapshotByEventId.get(lastEventId)
      : undefined;
    const snapshot = replaySnapshot ?? this.getState();
    const initial: PlaybackEvent = {
      schemaVersion: 1,
      id: `${snapshot.bootId}:${snapshot.sequence}`,
      instanceId: snapshot.instanceId,
      bootId: snapshot.bootId,
      sequence: snapshot.sequence,
      type: 'snapshot',
      occurredAt: new Date().toISOString(),
      data: { state: snapshot },
    };
    const coalescedLive = merge(
      this.live.pipe(
        filter((event) => event.type === 'audio.levels'),
        throttleTime(LEVEL_EVENT_INTERVAL_MS, undefined, {
          leading: true,
          trailing: true,
        }),
      ),
      this.live.pipe(filter((event) => event.type !== 'audio.levels')),
    );

    return new Observable<PlaybackEvent>((subscriber) => {
      this.subscribers += 1;
      const subscription = concat(
        from([initial, ...replay]),
        coalescedLive,
      ).subscribe(subscriber);
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
      '# HELP palazzo_liquidsoap_running Whether the Liquidsoap child is running.',
      '# TYPE palazzo_liquidsoap_running gauge',
      `palazzo_liquidsoap_running ${this.running ? 1 : 0}`,
      '# HELP palazzo_telemetry_connected Whether the Liquidsoap telemetry bridge is connected.',
      '# TYPE palazzo_telemetry_connected gauge',
      `palazzo_telemetry_connected ${this.connected ? 1 : 0}`,
      '# HELP palazzo_telemetry_degraded Whether authoritative telemetry is degraded.',
      '# TYPE palazzo_telemetry_degraded gauge',
      `palazzo_telemetry_degraded ${this.connected && this.running ? 0 : 1}`,
      '# HELP palazzo_telemetry_sample_age_seconds Age of the latest Liquidsoap sample.',
      '# TYPE palazzo_telemetry_sample_age_seconds gauge',
      `palazzo_telemetry_sample_age_seconds ${sampleAge}`,
      ...levelMetricLines('song', this.levels.song),
      ...levelMetricLines('instant', this.levels.instant),
      ...levelMetricLines('output', this.levels.output),
      '# HELP palazzo_playback_position_seconds Current track position.',
      '# TYPE palazzo_playback_position_seconds gauge',
      `palazzo_playback_position_seconds ${this.positionSeconds}`,
      '# HELP palazzo_track_lifecycle_total Observed Liquidsoap track lifecycle events.',
      '# TYPE palazzo_track_lifecycle_total counter',
      `palazzo_track_lifecycle_total{event="started"} ${this.lifecycleStarted}`,
      `palazzo_track_lifecycle_total{event="ended"} ${this.lifecycleEnded}`,
      '# HELP palazzo_telemetry_samples_total Successful telemetry samples.',
      '# TYPE palazzo_telemetry_samples_total counter',
      `palazzo_telemetry_samples_total ${this.pollSamples}`,
      '# HELP palazzo_telemetry_poll_failures_total Failed telemetry polls.',
      '# TYPE palazzo_telemetry_poll_failures_total counter',
      `palazzo_telemetry_poll_failures_total ${this.pollFailures}`,
      '# HELP palazzo_telemetry_parse_failures_total Invalid telemetry responses.',
      '# TYPE palazzo_telemetry_parse_failures_total counter',
      `palazzo_telemetry_parse_failures_total ${this.parseFailures}`,
      '# HELP palazzo_telnet_reconnects_total Liquidsoap command socket reconnect attempts.',
      '# TYPE palazzo_telnet_reconnects_total counter',
      `palazzo_telnet_reconnects_total ${this.telnetReconnects}`,
      '# HELP palazzo_liquidsoap_restarts_total Liquidsoap child restart attempts.',
      '# TYPE palazzo_liquidsoap_restarts_total counter',
      `palazzo_liquidsoap_restarts_total ${this.processRestarts}`,
      '# HELP palazzo_level_samples_coalesced_total Level samples coalesced before SSE emission.',
      '# TYPE palazzo_level_samples_coalesced_total counter',
      `palazzo_level_samples_coalesced_total ${this.levelSamplesCoalesced}`,
      '# HELP palazzo_sse_event_buffer_events Events retained for replay.',
      '# TYPE palazzo_sse_event_buffer_events gauge',
      `palazzo_sse_event_buffer_events ${this.replay.length}`,
      '# HELP palazzo_sse_replay_dropped_total Events evicted from the bounded replay window.',
      '# TYPE palazzo_sse_replay_dropped_total counter',
      `palazzo_sse_replay_dropped_total{type="levels"} ${this.replayLevelsDropped}`,
      `palazzo_sse_replay_dropped_total{type="other"} ${this.replayOtherDropped}`,
      '# HELP palazzo_sse_subscribers Current playback event subscribers.',
      '# TYPE palazzo_sse_subscribers gauge',
      `palazzo_sse_subscribers ${this.subscribers}`,
      ...this.httpMetricLines(),
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
      this.track = {
        playbackRequestId: event.playback_request_id,
        title: event.title || null,
        artist: event.artist || null,
        url: event.url,
        startedAt: occurredAt,
      };
      this.emit('track.started', data, occurredAt);
    } else {
      this.lifecycleEnded += 1;
      if (this.track?.playbackRequestId === event.playback_request_id) {
        this.track = null;
      }
      this.emit('track.ended', data, occurredAt);
    }
  }

  private emit(
    type: Exclude<PlaybackEventType, 'snapshot'>,
    data: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): void {
    this.sequence += 1;
    const event: PlaybackEvent = {
      schemaVersion: 1,
      id: `${this.bootId}:${this.sequence}`,
      instanceId: this.instanceId,
      bootId: this.bootId,
      sequence: this.sequence,
      type,
      occurredAt,
      data,
    };
    this.replay.push(event);
    this.snapshotByEventId.set(event.id, this.getState());
    if (this.replay.length > MAX_REPLAY_EVENTS) {
      const dropped = this.replay.shift();
      if (dropped) {
        this.snapshotByEventId.delete(dropped.id);
        if (dropped.type === 'audio.levels') this.replayLevelsDropped += 1;
        else this.replayOtherDropped += 1;
      }
    }
    this.live.next(event);
  }

  private eventsAfter(lastEventId: string): PlaybackEvent[] {
    const index = this.replay.findIndex((event) => event.id === lastEventId);
    return index >= 0 ? this.replay.slice(index + 1) : [];
  }

  private httpMetricLines(): string[] {
    const lines = [
      '# HELP palazzo_http_requests_total HTTP requests by normalized route and status class.',
      '# TYPE palazzo_http_requests_total counter',
      '# HELP palazzo_http_request_duration_seconds_sum Cumulative HTTP request duration by normalized route and status class.',
      '# TYPE palazzo_http_request_duration_seconds_sum counter',
    ];
    for (const [key, metric] of [...this.httpMetrics].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const [method, route, status] = key.split('\t');
      const labels = `method="${method}",route="${route}",status="${status}"`;
      lines.push(`palazzo_http_requests_total{${labels}} ${metric.count}`);
      lines.push(
        `palazzo_http_request_duration_seconds_sum{${labels}} ${metric.durationSeconds}`,
      );
    }
    return lines;
  }
}

function trackFromSnapshot(snapshot: LiquidsoapSnapshot): NonNullable<PlaybackState['track']> {
  return {
    playbackRequestId: snapshot.playback_request_id,
    title: snapshot.title || null,
    artist: snapshot.artist || null,
    url: snapshot.url,
    startedAt: new Date(snapshot.started_at * 1_000).toISOString(),
  };
}

function emptyLevels(): AudioLevels {
  return {
    song: { rms: 0, peak: 0 },
    instant: { rms: 0, peak: 0 },
    output: { rms: 0, peak: 0 },
  };
}

function level(rms: number, peak: number): AudioLevel {
  return { rms: clampLevel(rms), peak: clampLevel(peak) };
}

function levelMetricLines(source: string, value: AudioLevel): string[] {
  return [
    `# HELP palazzo_audio_${source}_rms Current linear ${source} RMS level.`,
    `# TYPE palazzo_audio_${source}_rms gauge`,
    `palazzo_audio_${source}_rms ${value.rms}`,
    `# HELP palazzo_audio_${source}_peak Current linear ${source} peak level.`,
    `# TYPE palazzo_audio_${source}_peak gauge`,
    `palazzo_audio_${source}_peak ${value.peak}`,
  ];
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
