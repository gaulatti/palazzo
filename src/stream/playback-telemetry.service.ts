import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Gauge, Registry, collectDefaultMetrics } from 'prom-client';
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
  event_type:
    | 'track_started'
    | 'track_ended'
    | 'intro_started'
    | 'intro_ended'
    | 'song_request_timeout'
    | 'song_request_failed'
    | 'next_withdrawn'
    | 'track_skipped'
    | 'instant_started'
    | 'instant_ended'
    | 'bumper_result'
    | 'duplicate_mark';
  playback_request_id: string;
  playback_id: string;
  parent_playback_id: string;
  program_id: string;
  title: string;
  artist: string;
  cover_url: string;
  url: string;
  /**
   * On next_withdrawn: replaced, withdrawn, flushed or not_ready. On track_skipped: replacement, operator,
   * or cancel after a failed command. On duplicate_mark: played (the deck still plays and sounds 1 s after an
   * ignored duplicate track mark) or ended (it did not, and the song was ended as a real end).
   */
  reason?: string;
  occurred_at: number;
}

export interface LiquidsoapSnapshot {
  liquidsoap_sequence: number;
  playing: boolean;
  playback_request_id: string;
  title: string;
  artist: string;
  cover_url: string;
  url: string;
  started_at: number;
  elapsed: number;
  remaining: number;
  song_rms: number;
  song_peak: number;
  instant_rms: number;
  instant_peak: number;
  intro_playing: boolean;
  intro_playback_id: string;
  intro_parent_playback_id: string;
  intro_program_id: string;
  intro_request_id: string;
  intro_url: string;
  intro_started_at: number;
  intro_rms: number;
  intro_peak: number;
  output_rms: number;
  output_peak: number;
  live_on_air?: boolean;
  icecast_connected: boolean;
  sampled_at: number;
}

export type PlaybackEventType =
  | 'snapshot'
  | 'replay.gap'
  | 'telemetry.connected'
  | 'telemetry.disconnected'
  | 'track.started'
  | 'track.ended'
  | 'intro.started'
  | 'intro.ended'
  | 'intro.failed'
  | 'playout.queued'
  | 'preflight.ready'
  | 'preflight.failed'
  | 'playout.started'
  | 'playout.transitioned'
  | 'playout.stopped'
  | 'playout.skipped'
  | 'playout.next_queued'
  | 'playout.next_withdrawn'
  | 'instant.started'
  | 'instant.ended'
  | 'playout.fallback'
  | 'playout.request_failed'
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
  intro: AudioLevel;
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
  icecast: {
    connected: boolean;
  };
  track: {
    playbackRequestId: string;
    title: string | null;
    artist: string | null;
    coverUrl: string | null;
    url: string;
    startedAt: string;
  } | null;
  intro: {
    playbackId: string;
    parentPlaybackId: string;
    programId: string;
    playbackRequestId: string;
    url: string;
    startedAt: string;
    status: 'playing' | 'failed';
    failureReason?: string;
  } | null;
  positionSeconds: number;
  remainingSeconds: number | null;
  levels: AudioLevels;
  // gaulatti/palazzo#48: whether the live RTMP input is on the air. Always
  // false when the station has no RTMP_URL. Status stays 'idle' during a live
  // show, so a reader that acts on 'idle' checks this first.
  live: { onAir: boolean };
  // What this Palazzo supports beyond the base contract. `next.bumper` (gaulatti/palazzo#50): PUT
  // /playback/next takes an optional `bumper` spot played before the announced song.
  capabilities: string[];
}

/** Capabilities a client may rely on only when listed in the playback state. */
export const PALAZZO_CAPABILITIES = ['next.bumper'] as const;

const MAX_REPLAY_EVENTS = 512;
const SEQUENCE_RESERVATION_SIZE = 1_000_000_000;
const LEVEL_EVENT_INTERVAL_MS = 100;
const BUILD_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const NORMALIZED_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);
const NORMALIZED_ROUTES = new Set([
  '/v1/programs/:programId/output/audio',
  '/metrics',
  '/proxy-audio',
  '/v1/programs/:programId/automation',
  '/v1/programs/:programId/automation/start',
  '/v1/programs/:programId/automation/stop',
  '/v1/programs/:programId/fillers/:version',
  '/v1/programs/:programId/playback/song',
  '/v1/programs/:programId/playback/song/stop',
  '/v1/programs/:programId/playback/instant',
  '/v1/programs/:programId/playback/instant/stop',
  '/v1/programs/:programId/playback/preflight',
  '/v1/programs/:programId/playback/state',
  '/v1/programs/:programId/playback/events',
  '/v1/programs/:programId/mixer',
]);

type SongChangePath = 'announced' | 'bumper' | 'command';
type CueEdge = 'head' | 'tail';
const SONG_TRIM_BUCKETS = [0.5, 1, 2, 3, 5, 8, 10] as const;
const emptyTrimHistogram = () => ({
  buckets: SONG_TRIM_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
});
/**
 * The instants-bus level (rms or peak, linear) above which an instant is
 * heard: -50 dBFS, the threshold of the silence checks (silencedetect
 * noise=-50dB) and of Alcantara's analysis.
 */
export const AUDIBLE_INSTANT_LEVEL = 10 ** (-50 / 20);
/** A song started more than this after the previous one ended is not a song change (the filler, a stop). */
const SONG_CHANGE_WINDOW_MS = 30_000;
/** Seconds; 1.5 s is the audible-silence line of gaulatti/palazzo#49. */
export const SONG_CHANGE_GAP_BUCKETS = [
  0, 0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 10, 15, 30,
] as const;
const emptyGapHistogram = () => ({
  buckets: SONG_CHANGE_GAP_BUCKETS.map(() => 0),
  sum: 0,
  count: 0,
});
const roundSeconds = (seconds: number) => Math.round(seconds * 1_000) / 1_000;

@Injectable()
export class PlaybackTelemetryService {
  readonly instanceId: string;
  readonly bootId = randomUUID();

  private sequence = 0;
  private sequenceCeiling = SEQUENCE_RESERVATION_SIZE;
  private readonly sequenceJournalPath: string;
  private liquidsoapSequence = 0;
  private running = false;
  private connected = false;
  private staleSince: string | null = null;
  private lastSampleAt: string | null = null;
  private track: PlaybackState['track'] = null;
  private intro: PlaybackState['intro'] = null;
  private positionSeconds = 0;
  private remainingSeconds: number | null = null;
  private levels: AudioLevels = emptyLevels();
  private icecastConnected = false;
  private liveOnAir = false;
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
  private replayGaps = 0;
  private playoutJournalRecords = 0;
  private playoutJournalTrimmed = 0;
  private readonly dependencyResults = new Map<string, number>();
  private readonly pairedCommandResults = new Map<string, number>();
  private readonly introLifecycleResults = new Map<string, number>();
  private readonly preflightResults = new Map<string, number>();
  private readonly preflightSkipped: Record<'unknown_kind', number> = {
    unknown_kind: 0,
  };
  private readonly playoutTransitions = new Map<string, number>();
  private readonly songTrims: Record<
    CueEdge,
    { buckets: number[]; sum: number; count: number }
  > = { head: emptyTrimHistogram(), tail: emptyTrimHistogram() };
  private readonly cueIgnored: Record<CueEdge, number> = { head: 0, tail: 0 };
  private readonly songAnalysisDropped: Record<'loudness' | 'segue', number> =
    { loudness: 0, segue: 0 };
  /** Song requests Liquidsoap could not resolve (palazzo#42). */
  private readonly songRequestFailures: Record<'timeout' | 'other', number> =
    { timeout: 0, other: 0 };
  private readonly nextRequests: Record<NextRequestResult, number> = {
    queued: 0,
    duplicate: 0,
    not_ready: 0,
    invalid: 0,
    no_current_song: 0,
  };
  private readonly nextWithdrawn: Record<NextWithdrawnReason, number> = {
    replaced: 0,
    withdrawn: 0,
    flushed: 0,
    not_ready: 0,
  };
  private nextProgramId: string | null = null;
  /** Liquidsoap sequence of the last applied track start. */
  private trackStartedSequence = 0;
  /** Cue-in per playback request, so position stays file-relative. */
  private readonly songCueIns = new Map<string, number>();
  /**
   * Why each song on air is about to end, by playback request id, from Liquidsoap's track_skipped journal
   * (gaulatti/palazzo#41). Consumed at that playback's track_ended; a song with no entry ended by itself.
   * Bounded to END_REASON_LIMIT entries, oldest first.
   */
  private readonly endReasons = new Map<string, 'replacement' | 'operator'>();
  private lastEndedTrack: { playbackId: string; occurredAt: number } | null =
    null;
  /**
   * Playback request ids whose track_ended the journal recorded (gaulatti/palazzo#51). Liquidsoap clears
   * its playing song in the deck's asynchronous end hook, so a snapshot taken just after the end can still
   * name the ended song; such a snapshot never makes it the track again. Bounded to ENDED_TRACK_LIMIT,
   * oldest first; a new start of the same id clears it.
   */
  private readonly endedRequestIds = new Set<string>();
  /**
   * Silence at each song change (gaulatti/palazzo#49): seconds from a song's track_ended to the next
   * song's track_started, both on Liquidsoap's clock, by how the next song came: `announced` (the song
   * announced through PUT /playback/next, started from its deck) or `command` (a song command after the
   * end). An announced song that starts under the end of the previous one is a change with no gap (0).
   * Only changes within SONG_CHANGE_WINDOW_MS count; a longer pause is not a song change.
   */
  private readonly songChangeGaps: Record<
    SongChangePath,
    { buckets: number[]; sum: number; count: number }
  > = {
    announced: emptyGapHistogram(),
    bumper: emptyGapHistogram(),
    command: emptyGapHistogram(),
  };
  private lastSongChangeGapSeconds: number | null = null;
  /**
   * A spot on air is not silence: the time an instant is on air between a song's end and the next song's
   * start, from Liquidsoap's instant_started/instant_ended journal, is subtracted from that change's gap.
   */
  private instantOnAirSinceMs: number | null = null;
  /**
   * Whether the instant on air was heard (gaulatti/palazzo#53): a snapshot
   * during it measured the instants bus above AUDIBLE_INSTANT_LEVEL. Only an
   * audible instant's time is subtracted from a change's gap, so a spot
   * journalled as played but silent counts as the silence it is.
   */
  private instantAudible = false;
  private spotMsInChange = 0;
  /** The song last accepted through PUT /playback/next, to tell an announced start from a command. */
  private announcedPlaybackId: string | null = null;
  /** Whether the announced song was announced with a spot before it (gaulatti/palazzo#50). */
  private announcedWithBumper = false;
  /** Spots and instants cued out at their last audio, by kind and result (gaulatti/palazzo#55). */
  private readonly itemTrims: Record<ItemTrimKind, Record<ItemTrimResult, number>> = {
    spot: { trimmed: 0, whole: 0, unmeasured: 0, failed: 0 },
    instant: { trimmed: 0, whole: 0, unmeasured: 0, failed: 0 },
  };
  private readonly bumperResults: Record<BumperResult, number> = {
    played: 0,
    dropped_unresolved: 0,
    dropped_late: 0,
    dropped_failed: 0,
  };
  /** What Liquidsoap's check found 1 s after each ignored duplicate track mark on a song deck. */
  private readonly duplicateMarks: Record<DuplicateMarkResult, number> = {
    played: 0,
    ended: 0,
  };
  /**
   * The last song start, from the journal only (never the engine snapshot), on Liquidsoap's clock: an
   * announced song that starts before the playing one ends is a change with no gap, counted at that end.
   */
  private lastStartedTrack: { playbackId: string; atMs: number } | null =
    null;
  private readonly httpMetrics = new Map<
    string,
    { count: number; durationSeconds: number }
  >();
  private readonly baselineRegistry = new Registry();

  constructor(config: ConfigService) {
    this.instanceId = config.get<string>('PALAZZO_INSTANCE_ID') ?? 'palazzo';
    this.sequenceJournalPath =
      config.get<string>('PLAYBACK_EVENT_SEQUENCE_PATH')?.trim() ||
      '/var/lib/palazzo/fillers/playback-event-sequence.json';
    collectDefaultMetrics({
      prefix: 'palazzo_',
      register: this.baselineRegistry,
    });
    // Node handle/resource type labels can expand with library-defined async
    // resource names. Keep the managed scrape contract strictly bounded while
    // retaining the remaining process and runtime baseline.
    for (const name of [
      'palazzo_nodejs_active_handles',
      'palazzo_nodejs_active_handles_total',
      'palazzo_nodejs_active_requests',
      'palazzo_nodejs_active_requests_total',
      'palazzo_nodejs_active_resources',
      'palazzo_nodejs_active_resources_total',
    ]) {
      this.baselineRegistry.removeSingleMetric(name);
    }
    const configuredVersion =
      config.get<string>('PALAZZO_BUILD_VERSION')?.trim() || 'development';
    const version = BUILD_VERSION_PATTERN.test(configuredVersion)
      ? configuredVersion
      : 'unknown';
    const buildInfo = new Gauge({
      name: 'palazzo_build_info',
      help: 'Palazzo service build identity.',
      labelNames: ['service', 'version'] as const,
      registers: [this.baselineRegistry],
    });
    buildInfo.set({ service: 'palazzo', version }, 1);
  }

  /**
   * Reserves a durable sequence range before telemetry begins. A new process
   * therefore has a fresh boot ID and a sequence greater than any value the
   * previous process could have emitted from its reserved range. Consumers can
   * detect the boot boundary and reconcile from the mandatory snapshot.
   */
  async initialize(): Promise<void> {
    let nextSequence = 0;
    try {
      const parsed = JSON.parse(
        await readFile(this.sequenceJournalPath, 'utf8'),
      ) as { nextSequence?: unknown };
      if (
        typeof parsed.nextSequence === 'number' &&
        Number.isSafeInteger(parsed.nextSequence) &&
        parsed.nextSequence >= 0
      ) {
        nextSequence = parsed.nextSequence;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('playback event sequence journal is unavailable');
      }
    }
    this.sequence = nextSequence;
    this.sequenceCeiling = nextSequence + SEQUENCE_RESERVATION_SIZE;
    if (!Number.isSafeInteger(this.sequenceCeiling)) {
      throw new Error('playback event sequence is exhausted');
    }
    const directory = dirname(this.sequenceJournalPath);
    const temporary = `${this.sequenceJournalPath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(
      temporary,
      JSON.stringify({ nextSequence: this.sequenceCeiling }),
      { mode: 0o600 },
    );
    await rename(temporary, this.sequenceJournalPath);
  }

  apply(
    snapshot: LiquidsoapSnapshot,
    events: LiquidsoapLifecycleEvent[],
  ): void {
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
      this.trackStartedSequence = 0;
    }

    for (const event of events) {
      if (event.sequence <= this.liquidsoapSequence) continue;
      this.liquidsoapSequence = event.sequence;
      this.applyLifecycle(event);
    }
    if (
      this.instantOnAirSinceMs !== null &&
      (snapshot.instant_rms > AUDIBLE_INSTANT_LEVEL ||
        snapshot.instant_peak > AUDIBLE_INSTANT_LEVEL)
    ) {
      this.instantAudible = true;
    }

    const namesEndedTrack =
      snapshot.playing &&
      this.endedRequestIds.has(snapshot.playback_request_id);
    if (namesEndedTrack) {
      // The journal already ended this song (its track_ended cleared the track): it is not on air, and
      // its position is not reported. A track a later start set (the next song under an overlap) stays
      // as it is.
      if (this.track === null) {
        this.positionSeconds = 0;
        this.remainingSeconds = null;
      }
    } else if (snapshot.playing) {
      this.track = trackFromSnapshot(snapshot);
      // Liquidsoap's elapsed time on a cut song starts at 0 at the cue-in;
      // report the position relative to the file instead.
      this.positionSeconds =
        finiteOr(snapshot.elapsed, 0) +
        (this.songCueIns.get(snapshot.playback_request_id) ?? 0);
      this.remainingSeconds = finiteOrNull(snapshot.remaining);
    } else if (snapshot.liquidsoap_sequence >= this.trackStartedSequence) {
      // A snapshot sampled before a start that arrived in the same poll must not erase it.
      this.track = null;
      this.positionSeconds = 0;
      this.remainingSeconds = null;
    }
    if (snapshot.intro_playing) {
      this.intro = {
        playbackId: snapshot.intro_playback_id,
        parentPlaybackId: snapshot.intro_parent_playback_id,
        programId: snapshot.intro_program_id,
        playbackRequestId: snapshot.intro_request_id,
        url: snapshot.intro_url,
        startedAt: new Date(snapshot.intro_started_at * 1_000).toISOString(),
        status: 'playing',
      };
    } else if (this.intro?.status === 'playing') {
      this.intro = null;
    }
    this.levels = {
      song: snapshot.playing
        ? level(snapshot.song_rms, snapshot.song_peak)
        : { rms: 0, peak: 0 },
      instant: level(snapshot.instant_rms, snapshot.instant_peak),
      intro: snapshot.intro_playing
        ? level(snapshot.intro_rms, snapshot.intro_peak)
        : { rms: 0, peak: 0 },
      output: level(snapshot.output_rms, snapshot.output_peak),
    };
    this.icecastConnected = snapshot.icecast_connected === true;
    this.liveOnAir = snapshot.live_on_air === true;

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

  observeDependency(
    operation: 'process_exit' | 'telemetry_poll',
    result: 'failure' | 'parse_failure' | 'success',
  ): void {
    const key = `${operation}\t${result}`;
    this.dependencyResults.set(key, (this.dependencyResults.get(key) ?? 0) + 1);
  }

  /** #56: the persisted journal's size and the records the limit dropped. */
  observePlayoutJournal(records: number, trimmed: number): void {
    this.playoutJournalRecords = records;
    this.playoutJournalTrimmed += Math.max(0, trimmed);
  }

  observePairedCommand(
    result: 'accepted' | 'deduplicated' | 'rejected',
    reason:
      | 'none'
      | 'duplicate'
      | 'engine_failure'
      | 'idempotency'
      | 'key_reuse'
      | 'song_unavailable',
  ): void {
    const key = `${result}\t${reason}`;
    this.pairedCommandResults.set(
      key,
      (this.pairedCommandResults.get(key) ?? 0) + 1,
    );
  }

  /** The song on air, for a next-song announcement; null when nothing is playing. */
  currentSong(): {
    playbackRequestId: string;
    remainingSeconds: number | null;
  } | null {
    if (!this.track) return null;
    return {
      playbackRequestId: this.track.playbackRequestId,
      remainingSeconds: this.remainingSeconds,
    };
  }

  /** Counts a next-song announcement by its bounded result. */
  observeNextRequest(result: NextRequestResult): void {
    this.nextRequests[result] += 1;
  }

  /** Emits playout.next_queued for an accepted announcement. */
  /** A song command or a stop: the next song to start is not the announced one. */
  forgetAnnouncement(): void {
    this.announcedPlaybackId = null;
    this.announcedWithBumper = false;
  }

  /** Counts a measured spot or instant: cued out at its last audio (trimmed), played whole, played whole because it is not measured yet (unmeasured), or its measurement failed (failed). */
  observeItemTrim(kind: ItemTrimKind, result: ItemTrimResult): void {
    this.itemTrims[kind][result] += 1;
  }

  /** Counts what became of an announced spot that Palazzo itself decided before Liquidsoap had it. */
  observeBumper(result: BumperResult): void {
    this.bumperResults[result] += 1;
  }

  reportNextQueued(
    programId: string,
    playbackId: string,
    withBumper = false,
  ): void {
    this.nextProgramId = programId;
    this.announcedPlaybackId = playbackId;
    this.announcedWithBumper = withBumper;
    this.emit('playout.next_queued', { programId, playbackId });
  }

  /** A cue edge applied to a song, in seconds trimmed (gaulatti/palazzo#53). */
  observeSongTrim(edge: CueEdge, seconds: number): void {
    const histogram = this.songTrims[edge];
    SONG_TRIM_BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index] += 1;
    });
    histogram.sum += seconds;
    histogram.count += 1;
  }

  /** A cue edge not applied because it would trim more than the bound. */
  observeCueIgnored(edge: CueEdge): void {
    this.cueIgnored[edge] += 1;
  }

  /** Counts an invalid song analysis group dropped from a song command. */
  observeSongAnalysisDropped(group: 'segue' | 'loudness'): void {
    this.songAnalysisDropped[group] += 1;
  }

  /** Records the cue-in applied to a song, bounded to recent requests. */
  rememberSongCueIn(playbackRequestId: string, cueInSeconds: number): void {
    this.songCueIns.delete(playbackRequestId);
    this.songCueIns.set(playbackRequestId, cueInSeconds);
    if (this.songCueIns.size > SONG_CUE_IN_ENTRIES) {
      const oldest = this.songCueIns.keys().next().value as string;
      this.songCueIns.delete(oldest);
    }
  }

  observeIntroLifecycle(
    result: 'started' | 'ended' | 'failed',
    reason: 'none' | 'asset_unavailable' | 'decode_failure',
  ): void {
    const key = `${result}\t${reason}`;
    this.introLifecycleResults.set(
      key,
      (this.introLifecycleResults.get(key) ?? 0) + 1,
    );
  }

  reportIntroFailure(data: {
    playbackId: string;
    parentPlaybackId: string;
    programId: string;
    playbackRequestId: string;
    reason: 'asset_unavailable' | 'decode_failure';
  }): void {
    const occurredAt = new Date().toISOString();
    const { reason, ...identity } = data;
    this.intro = {
      ...identity,
      url: '',
      startedAt: occurredAt,
      status: 'failed',
      failureReason: reason,
    };
    this.emit('intro.failed', data, occurredAt);
  }

  /** Counts a preflight asset skipped because Palazzo does not know its kind. */
  observePreflightSkipped(reason: 'unknown_kind'): void {
    this.preflightSkipped[reason] += 1;
  }

  reportPreflight(
    result: 'ready' | 'failed' | 'reused',
    reason:
      | 'none'
      | 'cache_hit'
      | 'outside_lookahead'
      | 'missing'
      | 'unreachable'
      | 'timeout'
      | 'corrupt'
      | 'unsupported_media'
      | 'invalid_metadata',
    data: {
      programId: string;
      playbackId: string;
      kind: 'song' | 'intro' | 'instant';
      checkedAt: string;
      expiresAt: string;
    },
  ): void {
    const key = `${result}\t${reason}`;
    this.preflightResults.set(key, (this.preflightResults.get(key) ?? 0) + 1);
    this.emit(result === 'failed' ? 'preflight.failed' : 'preflight.ready', {
      ...data,
      reason,
      reused: result === 'reused',
    });
  }

  reportPlayout(
    event: 'queued' | 'fallback',
    data: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): void {
    this.countPlayoutTransition(event);
    this.emit(`playout.${event}`, data, occurredAt);
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
    const normalizedMethod = NORMALIZED_METHODS.has(method.toUpperCase())
      ? method.toUpperCase()
      : 'OTHER';
    const normalizedRoute =
      route && NORMALIZED_ROUTES.has(route) ? route : 'unmatched';
    const status =
      statusCode >= 100 && statusCode <= 599
        ? `${Math.floor(statusCode / 100)}xx`
        : 'other';
    const key = `${normalizedMethod}\t${normalizedRoute}\t${status}`;
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
      icecast: {
        connected: this.icecastConnected,
      },
      track: this.track,
      intro: this.intro,
      positionSeconds: this.positionSeconds,
      remainingSeconds: this.remainingSeconds,
      levels: this.levels,
      live: { onAir: this.liveOnAir },
      capabilities: [...PALAZZO_CAPABILITIES],
    };
  }

  subscribe(lastEventId?: string): Observable<PlaybackEvent> {
    const replay = lastEventId ? this.eventsAfter(lastEventId) : [];
    // #56: a cursor that is no longer in the replay window (evicted, or from
    // another boot) cannot be resumed. The client gets the current snapshot and
    // then an explicit gap marker, so a gap is never mistaken for a quiet stream.
    const replaySnapshot = lastEventId
      ? this.snapshotByEventId.get(lastEventId)
      : undefined;
    const snapshot = replaySnapshot ?? this.getState();
    // A client already at the current snapshot (including one that reconnects
    // right after a gap marker, which carries the snapshot's id) has missed
    // nothing.
    const gap =
      !!lastEventId &&
      lastEventId !== `${snapshot.bootId}:${snapshot.sequence}` &&
      !this.replay.some((event) => event.id === lastEventId);
    if (gap) this.replayGaps += 1;
    const initial: PlaybackEvent = {
      schemaVersion: 1,
      id: `${snapshot.bootId}:${snapshot.sequence}`,
      instanceId: snapshot.instanceId,
      bootId: snapshot.bootId,
      sequence: snapshot.sequence,
      type: 'snapshot',
      occurredAt: new Date().toISOString(),
      data: sanitizeEventData({ state: snapshot }),
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
        from(gap ? [initial, this.gapEvent(snapshot)] : [initial, ...replay]),
        coalescedLive,
      ).subscribe(subscriber);
      return () => {
        this.subscribers = Math.max(0, this.subscribers - 1);
        subscription.unsubscribe();
      };
    });
  }

  async renderMetrics(): Promise<string> {
    const sampleAge = this.lastSampleAt
      ? Math.max(0, (Date.now() - Date.parse(this.lastSampleAt)) / 1_000)
      : 0;
    const applicationMetrics = [
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
      '# HELP palazzo_icecast_output_connected Whether Liquidsoap is connected to Icecast.',
      '# TYPE palazzo_icecast_output_connected gauge',
      `palazzo_icecast_output_connected ${this.icecastConnected ? 1 : 0}`,
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
      ...this.dependencyMetricLines(),
      ...this.playoutMetricLines(),
      ...this.songChangeGapLines(),
      ...this.songRequestFailureLines(),
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
      '# HELP palazzo_playout_journal_records Playout commands in the persisted dedupe journal.',
      '# TYPE palazzo_playout_journal_records gauge',
      `palazzo_playout_journal_records ${this.playoutJournalRecords}`,
      '# HELP palazzo_playout_journal_trimmed_total Playout commands dropped from the journal by its limit.',
      '# TYPE palazzo_playout_journal_trimmed_total counter',
      `palazzo_playout_journal_trimmed_total ${this.playoutJournalTrimmed}`,
      '# HELP palazzo_replay_gap_total Reconnects whose last event id was no longer in the replay window.',
      '# TYPE palazzo_replay_gap_total counter',
      `palazzo_replay_gap_total ${this.replayGaps}`,
      '# HELP palazzo_sse_subscribers Current playback event subscribers.',
      '# TYPE palazzo_sse_subscribers gauge',
      `palazzo_sse_subscribers ${this.subscribers}`,
      ...this.httpMetricLines(),
      '',
    ].join('\n');
    return `${await this.baselineRegistry.metrics()}\n${applicationMetrics}`;
  }

  private recordEndReason(playbackRequestId: string, reason?: string): void {
    if (reason === 'cancel') {
      this.endReasons.delete(playbackRequestId);
      return;
    }
    if (reason !== 'replacement' && reason !== 'operator') return;
    this.endReasons.delete(playbackRequestId);
    this.endReasons.set(playbackRequestId, reason);
    if (this.endReasons.size > END_REASON_LIMIT) {
      this.endReasons.delete(this.endReasons.keys().next().value as string);
    }
  }

  private applyLifecycle(event: LiquidsoapLifecycleEvent): void {
    if (event.event_type === 'next_withdrawn') {
      const reason = NEXT_WITHDRAWN_REASONS.find((r) => r === event.reason);
      if (!reason) return;
      this.nextWithdrawn[reason] += 1;
      this.emit(
        'playout.next_withdrawn',
        {
          programId: this.nextProgramId,
          playbackId: event.playback_id,
          reason,
        },
        new Date(event.occurred_at * 1_000).toISOString(),
      );
      return;
    }
    if (event.event_type === 'track_skipped') {
      this.recordEndReason(event.playback_request_id, event.reason);
      return;
    }
    if (event.event_type === 'bumper_result') {
      const result = BUMPER_RESULTS.find((r) => r === event.reason);
      if (result) this.bumperResults[result] += 1;
      return;
    }
    if (event.event_type === 'duplicate_mark') {
      const result = DUPLICATE_MARK_RESULTS.find((r) => r === event.reason);
      if (result) this.duplicateMarks[result] += 1;
      return;
    }
    if (
      event.event_type === 'instant_started' ||
      event.event_type === 'instant_ended'
    ) {
      this.applyInstantLifecycle(event);
      return;
    }
    const data = {
      playbackRequestId: event.playback_request_id,
      title: event.title || null,
      artist: event.artist || null,
      coverUrl: event.cover_url || null,
      liquidsoapSequence: event.sequence,
    };
    const occurredAt = new Date(event.occurred_at * 1_000).toISOString();
    if (event.event_type === 'intro_started') {
      this.intro = {
        playbackId: event.playback_id,
        parentPlaybackId: event.parent_playback_id,
        programId: event.program_id,
        playbackRequestId: event.playback_request_id,
        url: event.url,
        startedAt: occurredAt,
        status: 'playing',
      };
      this.observeIntroLifecycle('started', 'none');
      this.emit(
        'intro.started',
        {
          ...data,
          playbackId: event.playback_id,
          parentPlaybackId: event.parent_playback_id,
          programId: event.program_id,
        },
        occurredAt,
      );
    } else if (event.event_type === 'intro_ended') {
      this.observeIntroLifecycle('ended', 'none');
      this.emit(
        'intro.ended',
        {
          ...data,
          playbackId: event.playback_id,
          parentPlaybackId: event.parent_playback_id,
          programId: event.program_id,
        },
        occurredAt,
      );
      if (this.intro?.playbackId === event.playback_id) this.intro = null;
    } else if (
      event.event_type === 'song_request_timeout' ||
      event.event_type === 'song_request_failed'
    ) {
      // Liquidsoap could not resolve this song request, so it never started.
      const reason =
        event.event_type === 'song_request_timeout' ? 'timeout' : 'other';
      this.songRequestFailures[reason] += 1;
      this.emit(
        'playout.request_failed',
        {
          playbackRequestId: event.playback_request_id,
          playbackId: event.playback_id || event.playback_request_id,
          programId: event.program_id || null,
          reason,
          liquidsoapSequence: event.sequence,
        },
        occurredAt,
      );
    } else if (event.event_type === 'track_started') {
      this.lifecycleStarted += 1;
      this.trackStartedSequence = event.sequence;
      this.endedRequestIds.delete(event.playback_request_id);
      this.track = {
        playbackRequestId: event.playback_request_id,
        title: event.title || null,
        artist: event.artist || null,
        coverUrl: event.cover_url || null,
        url: event.url,
        startedAt: occurredAt,
      };
      this.emit('track.started', data, occurredAt);
      this.countPlayoutTransition('started');
      this.emit(
        'playout.started',
        {
          playbackRequestId: event.playback_request_id,
          playbackId: event.playback_id || event.playback_request_id,
          programId: event.program_id,
          liquidsoapSequence: event.sequence,
        },
        occurredAt,
      );
      const startedAt = event.occurred_at * 1_000;
      const startedPlaybackId = event.playback_id || event.playback_request_id;
      const path: SongChangePath =
        startedPlaybackId !== this.announcedPlaybackId
          ? 'command'
          : this.announcedWithBumper
            ? 'bumper'
            : 'announced';
      this.lastStartedTrack = { playbackId: startedPlaybackId, atMs: startedAt };
      if (
        this.lastEndedTrack &&
        startedAt >= this.lastEndedTrack.occurredAt &&
        startedAt - this.lastEndedTrack.occurredAt <= SONG_CHANGE_WINDOW_MS
      ) {
        const changeStart = this.lastEndedTrack.occurredAt;
        const spotMs =
          this.spotMsInChange +
          (this.instantOnAirSinceMs !== null && this.instantAudible
            ? startedAt - Math.max(this.instantOnAirSinceMs, changeStart)
            : 0);
        this.observeSongChangeGap(
          path,
          Math.max(0, startedAt - changeStart - Math.max(0, spotMs)) / 1_000,
        );
        this.countPlayoutTransition('transitioned');
        this.emit(
          'playout.transitioned',
          {
            fromPlaybackId: this.lastEndedTrack.playbackId,
            toPlaybackId: event.playback_id || event.playback_request_id,
            programId: event.program_id,
            liquidsoapSequence: event.sequence,
          },
          occurredAt,
        );
      }
      this.lastEndedTrack = null;
      this.spotMsInChange = 0;
    } else if (event.event_type === 'track_ended') {
      this.lifecycleEnded += 1;
      // An announced song already on air when this one ends started under its end: a change with no gap.
      const endedPlaybackId = event.playback_id || event.playback_request_id;
      if (
        this.lastStartedTrack &&
        this.lastStartedTrack.playbackId !== endedPlaybackId &&
        this.lastStartedTrack.atMs <= event.occurred_at * 1_000
      ) {
        this.observeSongChangeGap(
          this.lastStartedTrack.playbackId === this.announcedPlaybackId
            ? 'announced'
            : 'command',
          0,
        );
      }
      if (this.lastStartedTrack?.playbackId === endedPlaybackId)
        this.lastStartedTrack = null;
      if (this.track?.playbackRequestId === event.playback_request_id) {
        this.track = null;
      }
      this.endedRequestIds.add(event.playback_request_id);
      if (this.endedRequestIds.size > ENDED_TRACK_LIMIT) {
        const oldest = this.endedRequestIds.values().next().value as string;
        this.endedRequestIds.delete(oldest);
      }
      this.emit('track.ended', data, occurredAt);
      const disposition = this.endReasons.get(event.playback_request_id);
      this.endReasons.delete(event.playback_request_id);
      this.lastEndedTrack = {
        playbackId: event.playback_id || event.playback_request_id,
        occurredAt: event.occurred_at * 1_000,
      };
      this.spotMsInChange = 0;
      if (disposition === 'replacement') {
        this.countPlayoutTransition('skipped');
        this.emit(
          'playout.skipped',
          {
            playbackRequestId: event.playback_request_id,
            playbackId: event.playback_id || event.playback_request_id,
            programId: event.program_id,
            reason: 'replacement',
            liquidsoapSequence: event.sequence,
          },
          occurredAt,
        );
      } else {
        this.countPlayoutTransition('stopped');
        this.emit(
          'playout.stopped',
          {
            playbackRequestId: event.playback_request_id,
            playbackId: event.playback_id || event.playback_request_id,
            programId: event.program_id,
            reason: disposition ?? 'natural_end',
            liquidsoapSequence: event.sequence,
          },
          occurredAt,
        );
      }
    }
  }

  private emit(
    type: Exclude<PlaybackEventType, 'snapshot'>,
    data: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): void {
    if (this.sequence >= this.sequenceCeiling) {
      throw new Error('playback event sequence reservation is exhausted');
    }
    this.sequence += 1;
    const event: PlaybackEvent = {
      schemaVersion: 1,
      id: `${this.bootId}:${this.sequence}`,
      instanceId: this.instanceId,
      bootId: this.bootId,
      sequence: this.sequence,
      type,
      occurredAt,
      data: sanitizeEventData(data),
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

  private gapEvent(snapshot: { bootId: string; sequence: number; instanceId: string }): PlaybackEvent {
    return {
      schemaVersion: 1,
      // The snapshot's id, so a reconnect resumes from the snapshot.
      id: `${snapshot.bootId}:${snapshot.sequence}`,
      instanceId: snapshot.instanceId,
      bootId: snapshot.bootId,
      sequence: snapshot.sequence,
      type: 'replay.gap',
      occurredAt: new Date().toISOString(),
      data: { reason: 'cursor_not_in_replay', replayEvents: this.replay.length },
    };
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

  private dependencyMetricLines(): string[] {
    const lines = [
      '# HELP palazzo_dependency_operations_total Liquidsoap dependency operations by bounded operation and result.',
      '# TYPE palazzo_dependency_operations_total counter',
      '# HELP palazzo_dependency_retries_total Liquidsoap dependency retry attempts by bounded operation.',
      '# TYPE palazzo_dependency_retries_total counter',
      `palazzo_dependency_retries_total{dependency="liquidsoap",operation="process_restart"} ${this.processRestarts}`,
      `palazzo_dependency_retries_total{dependency="liquidsoap",operation="telnet_connect"} ${this.telnetReconnects}`,
    ];
    for (const [key, count] of [...this.dependencyResults].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const [operation, result] = key.split('\t');
      lines.push(
        `palazzo_dependency_operations_total{dependency="liquidsoap",operation="${operation}",result="${result}"} ${count}`,
      );
    }
    return lines;
  }

  private songRequestFailureLines(): string[] {
    return [
      '# HELP palazzo_song_request_failures_total Song requests Liquidsoap could not resolve, by bounded reason.',
      '# TYPE palazzo_song_request_failures_total counter',
      `palazzo_song_request_failures_total{reason="timeout"} ${this.songRequestFailures.timeout}`,
      `palazzo_song_request_failures_total{reason="other"} ${this.songRequestFailures.other}`,
    ];
  }

  /** instant.started / instant.ended for any instant (a spot or one fired by hand), without its URL. */
  private applyInstantLifecycle(event: LiquidsoapLifecycleEvent): void {
    const at = event.occurred_at * 1_000;
    if (event.event_type === 'instant_started') {
      this.instantOnAirSinceMs = at;
      this.instantAudible = false;
    } else if (this.instantOnAirSinceMs !== null) {
      if (this.lastEndedTrack && this.instantAudible)
        this.spotMsInChange += Math.max(
          0,
          at - Math.max(this.instantOnAirSinceMs, this.lastEndedTrack.occurredAt),
        );
      this.instantOnAirSinceMs = null;
    }
    this.emit(
      event.event_type === 'instant_started' ? 'instant.started' : 'instant.ended',
      {
        playbackId: event.playback_id || event.playback_request_id,
        programId: event.program_id || null,
        liquidsoapSequence: event.sequence,
      },
      new Date(at).toISOString(),
    );
  }

  private observeSongChangeGap(path: SongChangePath, seconds: number): void {
    const histogram = this.songChangeGaps[path];
    SONG_CHANGE_GAP_BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index] += 1;
    });
    histogram.sum += seconds;
    histogram.count += 1;
    this.lastSongChangeGapSeconds = seconds;
  }

  private songChangeGapLines(): string[] {
    const lines = [
      '# HELP palazzo_song_change_gap_seconds Silence between a song ending and the next song starting, on Liquidsoap\'s clock, by how the next song came (announced or command). Time an instant is journalled on air in between is subtracted; an instant Liquidsoap does not journal is counted as silence.',
      '# TYPE palazzo_song_change_gap_seconds histogram',
    ];
    for (const path of ['announced', 'bumper', 'command'] as const) {
      const histogram = this.songChangeGaps[path];
      SONG_CHANGE_GAP_BUCKETS.forEach((bound, index) => {
        lines.push(
          `palazzo_song_change_gap_seconds_bucket{handoff="${path}",le="${bound}"} ${histogram.buckets[index]}`,
        );
      });
      lines.push(
        `palazzo_song_change_gap_seconds_bucket{handoff="${path}",le="+Inf"} ${histogram.count}`,
        `palazzo_song_change_gap_seconds_sum{handoff="${path}"} ${roundSeconds(histogram.sum)}`,
        `palazzo_song_change_gap_seconds_count{handoff="${path}"} ${histogram.count}`,
      );
    }
    lines.push(
      '# HELP palazzo_song_trimmed_seconds Seconds of silence trimmed from a song edge by its cue points (gaulatti/palazzo#53), per song sent with them.',
      '# TYPE palazzo_song_trimmed_seconds histogram',
    );
    for (const edge of ['head', 'tail'] as const) {
      const histogram = this.songTrims[edge];
      SONG_TRIM_BUCKETS.forEach((bound, index) => {
        lines.push(
          `palazzo_song_trimmed_seconds_bucket{edge="${edge}",le="${bound}"} ${histogram.buckets[index]}`,
        );
      });
      lines.push(
        `palazzo_song_trimmed_seconds_bucket{edge="${edge}",le="+Inf"} ${histogram.count}`,
        `palazzo_song_trimmed_seconds_sum{edge="${edge}"} ${roundSeconds(histogram.sum)}`,
        `palazzo_song_trimmed_seconds_count{edge="${edge}"} ${histogram.count}`,
      );
    }
    lines.push(
      '# HELP palazzo_song_cue_ignored_total Cue edges not applied because they would trim more than 10 s; the edge plays untrimmed.',
      '# TYPE palazzo_song_cue_ignored_total counter',
      `palazzo_song_cue_ignored_total{edge="head",reason="bound"} ${this.cueIgnored.head}`,
      `palazzo_song_cue_ignored_total{edge="tail",reason="bound"} ${this.cueIgnored.tail}`,
    );
    lines.push(
      '# HELP palazzo_song_change_last_gap_seconds The silence at the most recent song change; absent before the first.',
      '# TYPE palazzo_song_change_last_gap_seconds gauge',
    );
    if (this.lastSongChangeGapSeconds !== null)
      lines.push(
        `palazzo_song_change_last_gap_seconds ${roundSeconds(this.lastSongChangeGapSeconds)}`,
      );
    return lines;
  }

  private playoutMetricLines(): string[] {
    const lines = [
      '# HELP palazzo_paired_playout_commands_total Paired song-intro commands by bounded result and reason.',
      '# TYPE palazzo_paired_playout_commands_total counter',
      '# HELP palazzo_intro_lifecycle_total Intro lifecycle transitions by bounded result and reason.',
      '# TYPE palazzo_intro_lifecycle_total counter',
      '# HELP palazzo_media_preflight_total Media preflight outcomes by bounded result and reason.',
      '# TYPE palazzo_media_preflight_total counter',
      '# HELP palazzo_media_preflight_skipped_total Preflight assets skipped without probing, by bounded reason.',
      '# TYPE palazzo_media_preflight_skipped_total counter',
      '# HELP palazzo_playout_transitions_total Authoritative playout transitions by bounded event.',
      '# TYPE palazzo_playout_transitions_total counter',
      '# HELP palazzo_next_requests_total Next-song announcements, by bounded result.',
      '# TYPE palazzo_next_requests_total counter',
      '# HELP palazzo_next_withdrawn_total Announced next songs withdrawn before they started, by bounded reason.',
      '# TYPE palazzo_next_withdrawn_total counter',
      '# HELP palazzo_next_bumper_total Spots announced with the next song, by what became of them: played, or dropped (unresolved by the song end, late past 60 s, or failed to start) with the song started at once.',
      '# TYPE palazzo_next_bumper_total counter',
      '# HELP palazzo_song_analysis_dropped_total Invalid song analysis groups dropped from song commands, by bounded group and result.',
      '# TYPE palazzo_song_analysis_dropped_total counter',
    ];
    for (const [result, count] of Object.entries(this.nextRequests)) {
      lines.push(`palazzo_next_requests_total{result="${result}"} ${count}`);
    }
    for (const [reason, count] of Object.entries(this.nextWithdrawn)) {
      lines.push(`palazzo_next_withdrawn_total{reason="${reason}"} ${count}`);
    }
    for (const [result, count] of Object.entries(this.bumperResults)) {
      lines.push(`palazzo_next_bumper_total{result="${result}"} ${count}`);
    }
    lines.push(
      '# HELP palazzo_duplicate_track_marks_total Track ends ignored on a song deck as a duplicate track mark, by what the check 1 s later found: played (the deck still plays and sounds) or ended (it did not; the song was ended as a real end).',
      '# TYPE palazzo_duplicate_track_marks_total counter',
    );
    for (const [result, count] of Object.entries(this.duplicateMarks)) {
      lines.push(`palazzo_duplicate_track_marks_total{result="${result}"} ${count}`);
    }
    lines.push(
      '# HELP palazzo_item_trim_total Spots and instants measured for trailing digital silence before they play, by kind and result: trimmed (cued out at the last audio, at most 1 s), whole (no silence over 50 ms) or failed (not measured in time; the item plays whole).',
      '# TYPE palazzo_item_trim_total counter',
    );
    for (const [kind, results] of Object.entries(this.itemTrims)) {
      for (const [result, count] of Object.entries(results)) {
        lines.push(`palazzo_item_trim_total{kind="${kind}",result="${result}"} ${count}`);
      }
    }
    for (const [reason, count] of Object.entries(this.preflightSkipped)) {
      lines.push(
        `palazzo_media_preflight_skipped_total{reason="${reason}"} ${count}`,
      );
    }
    for (const [group, count] of Object.entries(this.songAnalysisDropped)) {
      lines.push(
        `palazzo_song_analysis_dropped_total{group="${group}",result="invalid"} ${count}`,
      );
    }
    for (const [key, count] of [...this.pairedCommandResults].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const [result, reason] = key.split('\t');
      lines.push(
        `palazzo_paired_playout_commands_total{result="${result}",reason="${reason}"} ${count}`,
      );
    }
    for (const [key, count] of [...this.introLifecycleResults].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const [result, reason] = key.split('\t');
      lines.push(
        `palazzo_intro_lifecycle_total{result="${result}",reason="${reason}"} ${count}`,
      );
    }
    for (const [key, count] of [...this.preflightResults].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      const [result, reason] = key.split('\t');
      lines.push(
        `palazzo_media_preflight_total{result="${result}",reason="${reason}"} ${count}`,
      );
    }
    for (const [event, count] of [...this.playoutTransitions].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(
        `palazzo_playout_transitions_total{event="${event}"} ${count}`,
      );
    }
    return lines;
  }

  private countPlayoutTransition(
    event:
      | 'queued'
      | 'started'
      | 'transitioned'
      | 'stopped'
      | 'skipped'
      | 'fallback',
  ): void {
    this.playoutTransitions.set(
      event,
      (this.playoutTransitions.get(event) ?? 0) + 1,
    );
  }
}

function sanitizeEventData(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return sanitizeValue(value) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(
        ([key]) => !/(url|authorization|credential|password|token)/i.test(key),
      )
      .map(([key, entry]) => [key, sanitizeValue(entry)]),
  );
}

const SONG_CUE_IN_ENTRIES = 64;
/** End reasons held for songs whose end has not been read yet (gaulatti/palazzo#41). */
const END_REASON_LIMIT = 64;
/** Ended playback ids remembered so a lagging snapshot never revives one (gaulatti/palazzo#51). */
const ENDED_TRACK_LIMIT = 16;

export type NextRequestResult =
  | 'queued'
  | 'duplicate'
  | 'not_ready'
  | 'invalid'
  | 'no_current_song';
type NextWithdrawnReason = 'replaced' | 'withdrawn' | 'flushed' | 'not_ready';
export type ItemTrimKind = 'spot' | 'instant';
export type ItemTrimResult = 'trimmed' | 'whole' | 'unmeasured' | 'failed';
/** What became of a spot announced with the next song (gaulatti/palazzo#50). */
export type BumperResult =
  | 'played'
  | 'dropped_unresolved'
  | 'dropped_late'
  | 'dropped_failed';
const BUMPER_RESULTS: BumperResult[] = [
  'played',
  'dropped_unresolved',
  'dropped_late',
  'dropped_failed',
];
/** What the check after an ignored duplicate track mark found (production 2026-11-28). */
type DuplicateMarkResult = 'played' | 'ended';
const DUPLICATE_MARK_RESULTS: DuplicateMarkResult[] = ['played', 'ended'];
const NEXT_WITHDRAWN_REASONS: NextWithdrawnReason[] = [
  'replaced',
  'withdrawn',
  'flushed',
  'not_ready',
];

function trackFromSnapshot(
  snapshot: LiquidsoapSnapshot,
): NonNullable<PlaybackState['track']> {
  return {
    playbackRequestId: snapshot.playback_request_id,
    title: snapshot.title || null,
    artist: snapshot.artist || null,
    coverUrl: snapshot.cover_url || null,
    url: snapshot.url,
    startedAt: new Date(snapshot.started_at * 1_000).toISOString(),
  };
}

function emptyLevels(): AudioLevels {
  return {
    song: { rms: 0, peak: 0 },
    intro: { rms: 0, peak: 0 },
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
