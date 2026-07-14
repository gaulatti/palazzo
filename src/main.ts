/**
 * Palazzo — NestJS bootstrap entry point.
 *
 * Starts a Fastify-powered HTTP server that exposes the REST API
 * for controlling a Liquidsoap/Icecast radio stream.
 *
 * @module main
 */

import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

/**
 * Creates and starts the NestJS application.
 *
 * Configuration is read from environment variables:
 * - `PALAZZO_PORT` (required) — the HTTP port to listen on.
 * - `ALLOWED_ORIGINS` (optional, comma-separated) — additional allowed CORS origins.
 *
 * All `localhost` and `127.0.0.1` origins are automatically allowed regardless
 * of port, so local web UIs can connect without explicit configuration.
 */
async function bootstrap(): Promise<void> {
  const port = Number(process.env.PALAZZO_PORT);
  if (!port) throw new Error('PALAZZO_PORT env var is required');

  // Fastify is used instead of Express for better performance and
  // lower memory footprint in the containerised environment.
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no Origin header (server-to-server / curl),
      // opaque origins, explicitly configured origins, or any localhost variant.
      if (
        !origin ||
        origin === 'null' ||
        allowedOrigins.includes(origin) ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Bind on all interfaces so Docker port forwarding works correctly.
  await app.listen(port, '0.0.0.0');
  console.log(`Palazzo listening on port ${port}`);
}

bootstrap();
