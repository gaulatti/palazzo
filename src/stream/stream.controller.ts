import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { StreamService } from './stream.service';
import type { SongPayload, InstantPayload, MixerPayload, StreamConfig } from './stream.service';

@Controller('streams')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  @Get()
  async listStreams() {
    return this.streamService.listStreams();
  }

  @Post()
  async createStream(@Body() data: StreamConfig) {
    this.validateCreatePayload(data);
    return this.streamService.createStream(data);
  }

  @Delete(':id')
  async destroyStream(@Param('id') id: string) {
    await this.streamService.destroyStream(id);
    return { ok: true };
  }

  @Get(':id/status')
  async getStatus(@Param('id') id: string) {
    return this.streamService.getStatus(id);
  }

  @Post(':id/song')
  async playSong(@Param('id') id: string, @Body() data: SongPayload) {
    if (!data.url) {
      throw new BadRequestException('url is required');
    }
    await this.streamService.playSong(id, data);
    return { ok: true };
  }

  @Post(':id/song/stop')
  async stopSong(@Param('id') id: string) {
    await this.streamService.stopSong(id);
    return { ok: true };
  }

  @Post(':id/instant')
  async playInstant(@Param('id') id: string, @Body() data: InstantPayload) {
    if (!data.url) {
      throw new BadRequestException('url is required');
    }
    await this.streamService.playInstant(id, data);
    return { ok: true };
  }

  @Post(':id/instant/stop')
  async stopAllInstants(@Param('id') id: string) {
    await this.streamService.stopAllInstants(id);
    return { ok: true };
  }

  @Put(':id/mixer')
  async updateMixer(@Param('id') id: string, @Body() data: MixerPayload) {
    await this.streamService.updateMixer(id, data);
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

  private validateCreatePayload(data: StreamConfig): void {
    if (!data.mount || !data.streamName) {
      throw new BadRequestException('mount and streamName are required');
    }
    if (!data.icecastHost || !data.icecastPassword) {
      throw new BadRequestException('icecastHost and icecastPassword are required');
    }
    if (typeof data.bitrate !== 'number' || data.bitrate <= 0) {
      throw new BadRequestException('bitrate must be a positive number');
    }
  }
}
