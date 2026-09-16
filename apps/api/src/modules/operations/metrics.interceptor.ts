import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { MetricsService } from './metrics.service';

/**
 * Records one `http_requests_total` sample and one latency observation per
 * request, labelled by the route template (never the raw URL, so ids do not
 * explode the label space). Health and metrics endpoints are excluded.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    if (/\/(health|metrics)(\/|$)/.test(route)) return next.handle();
    const started = process.hrtime.bigint();
    const record = (status: number) => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const labels = { method: req.method, route, status: `${Math.floor(status / 100)}xx` };
      this.metrics.increment('http_requests_total', labels);
      this.metrics.observe('http_request_duration_seconds', { method: req.method, route }, seconds);
    };
    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode),
        error: (err: unknown) =>
          record(
            typeof (err as { getStatus?: () => number }).getStatus === 'function'
              ? (err as { getStatus: () => number }).getStatus()
              : typeof (err as { statusCode?: number }).statusCode === 'number'
                ? (err as { statusCode: number }).statusCode
                : 500,
          ),
      }),
    );
  }
}
