import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { StreamModule } from './stream/stream.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    StreamModule,
  ],
})
export class AppModule {}
