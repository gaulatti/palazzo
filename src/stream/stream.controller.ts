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
  Res,
  Sse,
  StreamableFile,
} from "@nestjs/common";
import { map, Observable } from "rxjs";
import {
  StreamService,
  type MixerPayload,
  type ProgramSongPayload,
  type ProgramInstantPayload,
  type ProgramPreflightRequest,
} from "./stream.service";
import { BroadcastLifecycleService } from "./broadcast-lifecycle.service";
import { ProgramMonitorService } from './program-monitor.service';
import type { ServerResponse } from 'node:http';
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
 * Playback control is exposed only under `/v1/programs/:programId`. The
 * unscoped root playback routes were retired and return Nest's normal 404.
 * The private `GET /metrics` scrape and `GET /proxy-audio` relay stay at the root.
 */
@Controller()
export class StreamController {
  constructor(
    private readonly streamService: StreamService,
    private readonly lifecycle: BroadcastLifecycleService,
    private readonly fillerStore: FillerStoreService,
    private readonly monitor: ProgramMonitorService,
  ) {}

  @Get('v1/programs/:programId/output/audio')
  @Header('Cache-Control', 'no-store')
  @Header('X-Accel-Buffering', 'no')
  async programAudio(
    @Param('programId') programId: string,
    @Res({ passthrough: true }) reply: { raw: ServerResponse },
  ): Promise<StreamableFile> {
    this.lifecycle.assertProgram(programId);
    const abort = new AbortController();
    const close = () => abort.abort();
    reply.raw.once('close', close);
    try {
      const output = await this.monitor.open(abort.signal);
      output.stream.once('close', () => reply.raw.removeListener('close', close));
      return new StreamableFile(output.stream, { type: output.type });
    } catch (error) {
      reply.raw.removeListener('close', close);
      throw error;
    }
  }

  @Get("v1/programs/:programId/automation")
  async getAutomation(@Param("programId") programId: string): Promise<unknown> {
    this.lifecycle.assertProgram(programId);
    return this.lifecycle.getState();
  }

  @Post("v1/programs/:programId/automation/start")
  async startAutomation(
    @Param("programId") programId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-command-sequence") commandSequence?: string,
    @Headers("x-filler-version") fillerVersion?: string,
  ): Promise<unknown> {
    this.lifecycle.assertProgram(programId);
    return this.lifecycle.start(idempotencyKey, commandSequence, fillerVersion);
  }

  @Get("v1/programs/:programId/fillers/:version")
  async getFiller(
    @Param("programId") programId: string,
    @Param("version") version: string,
  ) {
    this.lifecycle.assertProgram(programId);
    return this.fillerStore.getPublicState(version);
  }

  @Put("v1/programs/:programId/fillers/:version")
  async prepareFiller(
    @Param("programId") programId: string,
    @Param("version") version: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() request: FillerPreparationRequest,
  ) {
    this.lifecycle.assertProgram(programId);
    return this.fillerStore.prepare(version, request, idempotencyKey?.trim());
  }

  @Post("v1/programs/:programId/automation/stop")
  async stopAutomation(
    @Param("programId") programId: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-command-sequence") commandSequence?: string,
  ): Promise<unknown> {
    this.lifecycle.assertProgram(programId);
    return this.lifecycle.stop(idempotencyKey, commandSequence);
  }

  @Post("v1/programs/:programId/playback/song")
  async playProgramSong(
    @Param("programId") programId: string,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() data: ProgramSongPayload,
  ) {
    this.lifecycle.assertProgram(programId);
    this.lifecycle.startFromPlaybackCommand();
    return this.streamService.playProgramSong(programId, idempotencyKey, data);
  }

  @Put("v1/programs/:programId/playback/preflight")
  async preflightProgramAssets(
    @Param("programId") programId: string,
    @Body() data: ProgramPreflightRequest,
  ) {
    this.lifecycle.assertProgram(programId);
    return this.streamService.preflightProgramAssets(programId, data);
  }

  @Get("v1/programs/:programId/playback/preflight")
  async getProgramPreflight(@Param("programId") programId: string) {
    this.lifecycle.assertProgram(programId);
    return this.streamService.getProgramPreflight(programId);
  }

  @Post("v1/programs/:programId/playback/song/stop")
  async stopProgramSong(@Param("programId") programId: string) {
    this.lifecycle.assertProgram(programId);
    await this.streamService.stopSong();
    return { ok: true };
  }

  @Post("v1/programs/:programId/playback/instant")
  async playProgramInstant(
    @Param("programId") programId: string,
    @Body() data: ProgramInstantPayload,
  ) {
    this.lifecycle.assertProgram(programId);
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
  async stopProgramInstants(@Param("programId") programId: string) {
    this.lifecycle.assertProgram(programId);
    await this.streamService.stopAllInstants();
    return { ok: true };
  }

  @Get("v1/programs/:programId/mixer")
  async getProgramMixer(@Param("programId") programId: string) {
    this.lifecycle.assertProgram(programId);
    return this.streamService.getMixer();
  }

  @Put("v1/programs/:programId/mixer")
  async updateProgramMixer(
    @Param("programId") programId: string,
    @Body() data: MixerPayload,
  ) {
    this.lifecycle.assertProgram(programId);
    this.lifecycle.requireReady();
    return this.streamService.updateMixer(data);
  }

  @Get("v1/programs/:programId/playback/state")
  async getProgramPlaybackState(@Param("programId") programId: string) {
    this.lifecycle.assertProgram(programId);
    return this.streamService.telemetry.getState();
  }

  @Sse("v1/programs/:programId/playback/events")
  async programPlaybackEvents(
    @Param("programId") programId: string,
    @Headers("last-event-id") lastEventId?: string,
  ): Promise<Observable<MessageEvent>> {
    this.lifecycle.assertProgram(programId);
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
  async getMetrics(): Promise<string> {
    const telemetry = await this.streamService.telemetry.renderMetrics();
    return `${telemetry}${this.fillerStore.renderMetrics()}${await this.monitor.renderMetrics()}`;
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
