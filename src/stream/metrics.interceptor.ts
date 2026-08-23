import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, finalize, tap } from 'rxjs';
import { PlaybackTelemetryService } from './playback-telemetry.service';

@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly telemetry: PlaybackTelemetryService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<{
      method: string;
      routeOptions?: { url?: string };
    }>();
    const response = context
      .switchToHttp()
      .getResponse<{ statusCode: number }>();
    const startedAt = process.hrtime.bigint();
    let statusCode: number | undefined;

    return next.handle().pipe(
      tap({
        error: (error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'getStatus' in error &&
            typeof error.getStatus === 'function'
          ) {
            statusCode = Number(error.getStatus());
          } else {
            statusCode = 500;
          }
        },
      }),
      finalize(() => {
        const durationMs =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000;
        this.telemetry.observeHttp(
          request.method,
          request.routeOptions?.url,
          statusCode ?? response.statusCode,
          durationMs,
        );
      }),
    );
  }
}
