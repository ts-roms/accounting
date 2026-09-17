import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { type Observable, defer, throwError, timer } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { unwrapPgError } from '@/common/utils/pg-errors';

/** Socket-level failures and server-side disconnects that a fresh connection will not repeat. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNREFUSED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

export function isTransientDbError(err: unknown): boolean {
  const pg = unwrapPgError(err);
  if (pg?.code && TRANSIENT_CODES.has(pg.code)) return true;
  const message = err instanceof Error ? err.message : '';
  return /Connection terminated|terminating connection|read ECONNRESET|write EPIPE/i.test(message);
}

/**
 * A pooled connection that the server (or a Docker port proxy) dropped fails
 * its next query with a socket error before the pool learns the client is
 * dead. That failure is safe to repeat for reads - no state changed - so
 * GET / HEAD handlers are re-run once on a fresh connection instead of
 * turning one stale socket into a 500 for the user. Writes are never retried:
 * a transaction that died mid-flight was rolled back and the caller decides.
 */
@Injectable()
export class TransientDbErrorInterceptor implements NestInterceptor {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(TransientDbErrorInterceptor.name);
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return next.handle();
    return next.handle().pipe(
      catchError((err: unknown) => {
        if (!isTransientDbError(err)) return throwError(() => err);
        this.logger.warn(
          { err, url: req.originalUrl },
          'Transient database error on a read - retrying once on a fresh connection',
        );
        return timer(50).pipe(mergeMap(() => defer(() => next.handle())));
      }),
    );
  }
}
