import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StreamModule } from './stream/stream.module';

/**
 * Root NestJS application module.
 *
 * Imports `ConfigModule` with `isGlobal: true` so that `ConfigService`
 * is available in every module without re-importing. The `StreamModule`
 * contains all radio-stream logic — HTTP endpoints, Liquidsoap process
 * management, and Telnet-based control.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StreamModule,
  ],
})
export class AppModule {}
