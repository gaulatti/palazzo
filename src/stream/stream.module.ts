import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { MetricsInterceptor } from './metrics.interceptor';
import { StreamController } from './stream.controller';
import { StreamService } from './stream.service';
import { PlaybackTelemetryService } from './playback-telemetry.service';

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
  providers: [
    PlaybackTelemetryService,
    StreamService,
    { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
  ],
  exports: [StreamService, PlaybackTelemetryService],
})
export class StreamModule {}
