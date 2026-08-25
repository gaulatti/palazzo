import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Headers,
  MessageEvent,
  Param,
  Post,
  Put,
  Query,
  Sse,
  StreamableFile,
} from "@nestjs/common";
import { map, Observable } from "rxjs";
import {
  StreamService,
  type SongPayload,
  type InstantPayload,
  type MixerPayload,
  type ProgramSongPayload,
  type ProgramInstantPayload,
} from "./stream.service";
import { BroadcastLifecycleService } from "./broadcast-lifecycle.service";
import {
  FillerStoreService,
  type FillerPreparationRequest,
} from "./filler-store.service";

/**
 * REST controller for radio stream operations.
 *
 * All endpoints (except `/proxy-audio`) delegate to {@link StreamService}
 * which communicates with the Liquidsoap engine over its Telnet interface.
 *
 * Routes:
 * - `GET  /status`         — stream health and metadata.
 * - `POST /song`           — push a track into the song queue.
 * - `POST /song/stop`      — stop active and queued songs.
 * - `POST /instant`        — push a short audio clip (jingle / SFX).
 * - `POST /instant/stop`   — skip all currently playing instant clips.
 * - `GET  /mixer`          — read applied volume / mute state.
 * - `PUT  /mixer`          — adjust volume / mute state.
 * - `GET  /proxy-audio`    — fetch and relay audio from an external URL.
 */
@Controller()
export class StreamController {
  constructor(
    private readonly streamService: StreamService,
    private readonly lifecycle: BroadcastLifecycleService,
    private readonly fillerStore: FillerStoreService,
  ) {}

  @Get("v1/programs/:programId/automation")
  async getAutomation(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
  ): Promise<unknown> {
    await this.lifecycle.authorize(programId, authorization);
    return this.lifecycle.getState();
  }

  @Post("v1/programs/:programId/automation/start")
  async startAutomation(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-command-sequence") commandSequence?: string,
    @Headers("x-filler-version") fillerVersion?: string,
  ): Promise<unknown> {
    await this.lifecycle.authorize(programId, authorization);
    return this.lifecycle.start(idempotencyKey, commandSequence, fillerVersion);
  }

  @Get('v1/programs/:programId/fillers/:version')
  async getFiller(
    @Param('programId') programId: string,
    @Param('version') version: string,
    @Headers('authorization') authorization?: string,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    return this.fillerStore.getPublicState(version);
  }

  @Put('v1/programs/:programId/fillers/:version')
  async prepareFiller(
    @Param('programId') programId: string,
    @Param('version') version: string,
    @Headers('authorization') authorization: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() request: FillerPreparationRequest,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    return this.fillerStore.prepare(version, request, idempotencyKey?.trim());
  }

  @Post("v1/programs/:programId/automation/stop")
  async stopAutomation(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-command-sequence") commandSequence?: string,
  ): Promise<unknown> {
    await this.lifecycle.authorize(programId, authorization);
    return this.lifecycle.stop(idempotencyKey, commandSequence);
  }

  @Post("v1/programs/:programId/playback/song")
  async playProgramSong(
    @Param("programId") programId: string,
    @Headers("authorization") authorization: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() data: ProgramSongPayload,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    this.lifecycle.requireReady();
    return this.streamService.playProgramSong(programId, idempotencyKey, data);
  }

  @Post("v1/programs/:programId/playback/song/stop")
  async stopProgramSong(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    await this.streamService.stopSong();
    return { ok: true };
  }

  @Post("v1/programs/:programId/playback/instant")
  async playProgramInstant(
    @Param("programId") programId: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() data: ProgramInstantPayload,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    this.lifecycle.requireReady();
    if (!data.url) throw new BadRequestException("url is required");
    if (data.programId !== programId) {
      throw new BadRequestException("instant belongs to another program");
    }
    if (!data.playbackId?.trim() || data.playbackId.length > 200) {
      throw new BadRequestException("playbackId is invalid");
    }
    return this.streamService.playInstant({
      ...data,
      playbackRequestId: data.playbackId,
    });
  }

  @Post("v1/programs/:programId/playback/instant/stop")
  async stopProgramInstants(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    await this.streamService.stopAllInstants();
    return { ok: true };
  }

  @Get("v1/programs/:programId/mixer")
  async getProgramMixer(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    return this.streamService.getMixer();
  }

  @Put("v1/programs/:programId/mixer")
  async updateProgramMixer(
    @Param("programId") programId: string,
    @Headers("authorization") authorization: string | undefined,
    @Body() data: MixerPayload,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    this.lifecycle.requireReady();
    return this.streamService.updateMixer(data);
  }

  @Get("v1/programs/:programId/playback/state")
  async getProgramPlaybackState(
    @Param("programId") programId: string,
    @Headers("authorization") authorization?: string,
  ) {
    await this.lifecycle.authorize(programId, authorization);
    return this.streamService.telemetry.getState();
  }

  @Sse("v1/programs/:programId/playback/events")
  async programPlaybackEvents(
    @Param("programId") programId: string,
    @Headers("authorization") authorization: string | undefined,
    @Headers("last-event-id") lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    await this.lifecycle.authorize(programId, authorization);
    return this.streamService.telemetry.subscribe(lastEventId).pipe(
      map((event) => ({
        id: event.id,
        type: event.type,
        data: event,
      })),
    );
  }

  /** Returns the current stream mount point, name, uptime, and running state. */
  @Get("status")
  getStatus() {
    return this.streamService.getStatus();
  }

  /**
   * Replaces Liquidsoap's active and queued songs with the requested song.
   */
  @Post("song")
  async playSong(@Body() data: SongPayload) {
    if (!data.url) throw new BadRequestException("url is required");
    this.lifecycle.startFromPlaybackCommand();
    return this.streamService.playSong(data);
  }

  /** Stops the active song and clears every queued song. */
  @Post("song/stop")
  async stopSong() {
    await this.streamService.stopSong();
    return { ok: true };
  }

  /** Pushes an instant audio URL (short sound effect or jingle) into the `instants` queue. */
  @Post("instant")
  async playInstant(@Body() data: InstantPayload) {
    this.lifecycle.requireReady();
    if (!data.url) throw new BadRequestException("url is required");
    return this.streamService.playInstant(data);
  }

  /** Stops all currently playing instant clips by skipping the `instants` queue. */
  @Post("instant/stop")
  async stopAllInstants() {
    await this.streamService.stopAllInstants();
    return { ok: true };
  }

  /** Returns the mixer state currently applied to Liquidsoap. */
  @Get("mixer")
  getMixer() {
    return this.streamService.getMixer();
  }

  /** Updates mixer settings (volumes, mute state). */
  @Put("mixer")
  async updateMixer(@Body() data: MixerPayload) {
    this.lifecycle.requireReady();
    return this.streamService.updateMixer(data);
  }

  /** Returns the latest authoritative Liquidsoap playback snapshot. */
  @Get("playback/state")
  getPlaybackState() {
    return this.streamService.telemetry.getState();
  }

  /**
   * Streams replay-safe playback events. Reconnecting clients can provide the
   * standard Last-Event-ID header to receive missed events from the bounded
   * in-memory journal.
   */
  @Sse("playback/events")
  playbackEvents(
    @Headers("last-event-id") lastEventId?: string,
  ): Observable<MessageEvent> {
    return this.streamService.telemetry.subscribe(lastEventId).pipe(
      map((event) => ({
        id: event.id,
        type: event.type,
        data: event,
      })),
    );
  }

  /** Exposes bounded-cardinality Prometheus telemetry on the private API. */
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async getMetrics(
    @Headers("authorization") authorization?: string,
  ): Promise<string> {
    await this.lifecycle.authorizeMachine(authorization);
    const telemetry = await this.streamService.telemetry.renderMetrics();
    return `${telemetry}${this.fillerStore.renderMetrics()}`;
  }

  /**
   * Proxies an external audio URL through the server.
   *
   * Used by browser-based UIs to fetch audio files from URLs that may not
   * send permissive CORS headers. The server fetches the content server-side
   * and streams it back with the original `Content-Type`.
   *
   * @param url - The remote audio URL to proxy.
   * @returns A `StreamableFile` containing the audio data.
   */
  @Get("proxy-audio")
  async proxyAudio(@Query("url") url: string): Promise<StreamableFile> {
    if (!url) throw new BadRequestException("url is required");
    const res = await fetch(url);
    if (!res.ok)
      throw new BadRequestException(`upstream returned ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") ?? "audio/mpeg";
    return new StreamableFile(buffer, { type: contentType });
  }
}
