import { Module } from '@nestjs/common';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';

/**
 * Stream feature module.
 *
 * Wires together the HTTP controller and the core service that manages
 * the Liquidsoap child process and Telnet command interface.
 * `StreamService` is exported so other modules (e.g. future multi-stream
 * orchestrator) can reuse it.
 */
@Module({
  controllers: [StreamController],
  providers: [StreamService],
  exports: [StreamService],
})
export class StreamModule {}
