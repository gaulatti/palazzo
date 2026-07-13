import { Module } from '@nestjs/common';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';
import { ScriptService } from './script.service';
import { TelnetService } from './telnet.service';

@Module({
  controllers: [StreamController],
  providers: [StreamService, ScriptService, TelnetService],
  exports: [StreamService],
})
export class StreamModule {}
