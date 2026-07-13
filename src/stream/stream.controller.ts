import { BadRequestException, Body, Controller, Get, Post, Put, Query, StreamableFile } from '@nestjs/common';
import { StreamService, type SongPayload, type InstantPayload, type MixerPayload } from './stream.service';

@Controller()
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  @Get('status')
  getStatus() {
    return this.streamService.getStatus();
  }

  @Post('song')
  async playSong(@Body() data: SongPayload) {
    if (!data.url) throw new BadRequestException('url is required');
    await this.streamService.playSong(data);
    return { ok: true };
  }

  @Post('song/stop')
  async stopSong() {
    await this.streamService.stopSong();
    return { ok: true };
  }

  @Post('instant')
  async playInstant(@Body() data: InstantPayload) {
    if (!data.url) throw new BadRequestException('url is required');
    await this.streamService.playInstant(data);
    return { ok: true };
  }

  @Post('instant/stop')
  async stopAllInstants() {
    await this.streamService.stopAllInstants();
    return { ok: true };
  }

  @Put('mixer')
  async updateMixer(@Body() data: MixerPayload) {
    await this.streamService.updateMixer(data);
    return { ok: true };
  }

  @Get('proxy-audio')
  async proxyAudio(@Query('url') url: string): Promise<StreamableFile> {
    if (!url) throw new BadRequestException('url is required');
    const res = await fetch(url);
    if (!res.ok) throw new BadRequestException(`upstream returned ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'audio/mpeg';
    return new StreamableFile(buffer, { type: contentType });
  }
}
