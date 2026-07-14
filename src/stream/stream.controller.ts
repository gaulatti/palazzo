import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import {
  StreamService,
  type SongPayload,
  type InstantPayload,
  type MixerPayload,
} from './stream.service';

/**
 * REST controller for radio stream operations.
 *
 * All endpoints (except `/proxy-audio`) delegate to {@link StreamService}
 * which communicates with the Liquidsoap engine over its Telnet interface.
 *
 * Routes:
 * - `GET  /status`         — stream health and metadata.
 * - `POST /song`           — push a track into the song queue.
 * - `POST /song/stop`      — skip the current song.
 * - `POST /instant`        — push a short audio clip (jingle / SFX).
 * - `POST /instant/stop`   — skip all currently playing instant clips.
 * - `PUT  /mixer`          — (stub) adjust volume / mute state.
 * - `GET  /proxy-audio`    — fetch and relay audio from an external URL.
 */
@Controller()
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  /** Returns the current stream mount point, name, uptime, and running state. */
  @Get('status')
  getStatus() {
    return this.streamService.getStatus();
  }

  /**
   * Queues a song URL in Liquidsoap's `songs` request queue.
   * The currently playing track is skipped first so the new one starts immediately.
   */
  @Post('song')
  async playSong(@Body() data: SongPayload) {
    if (!data.url) throw new BadRequestException('url is required');
    await this.streamService.playSong(data);
    return { ok: true };
  }

  /** Skips the current song (advances the `songs` request queue). */
  @Post('song/stop')
  async stopSong() {
    await this.streamService.stopSong();
    return { ok: true };
  }

  /** Pushes an instant audio URL (short sound effect or jingle) into the `instants` queue. */
  @Post('instant')
  async playInstant(@Body() data: InstantPayload) {
    if (!data.url) throw new BadRequestException('url is required');
    await this.streamService.playInstant(data);
    return { ok: true };
  }

  /** Stops all currently playing instant clips by skipping the `instants` queue. */
  @Post('instant/stop')
  async stopAllInstants() {
    await this.streamService.stopAllInstants();
    return { ok: true };
  }

  /**
   * Updates mixer settings (volumes, mute state).
   *
   * @remarks Currently a no-op stub — Liquidsoap-level mixer controls are not yet wired.
   */
  @Put('mixer')
  async updateMixer(@Body() data: MixerPayload) {
    await this.streamService.updateMixer(data);
    return { ok: true };
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
  @Get('proxy-audio')
  async proxyAudio(@Query('url') url: string): Promise<StreamableFile> {
    if (!url) throw new BadRequestException('url is required');
    const res = await fetch(url);
    if (!res.ok)
      throw new BadRequestException(`upstream returned ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return new StreamableFile(buffer, { type: contentType });
  }
}
