import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { from, of, throwError, type Observable } from 'rxjs';
import { catchError, mergeMap, tap } from 'rxjs/operators';
import { HEADERS } from '@accounting/config';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AppError, ConflictError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { IdempotencyService, requestFingerprint } from './idempotency.service';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,128}$/;

/**
 * Honours the `Idempotency-Key` header on every mutating request of an
 * authenticated principal. Same key + same request => the stored response is
 * replayed (with `Idempotent-Replayed: true`); same key + different request
 * => 422 IDEMPOTENCY_CONFLICT; a concurrent duplicate => 409 while the first
 * is still running. 5xx failures release the key so a retry can succeed.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly service: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: AuthenticatedUser }>();
    const res = http.getResponse<Response>();
    const key = req.header(HEADERS.IDEMPOTENCY_KEY);
    if (!key || !MUTATING.has(req.method) || !req.user) return next.handle();
    if (!KEY_RE.test(key))
      return throwError(
        () =>
          new AppError(
            ErrorCodes.VALIDATION_FAILED,
            'Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-:.].',
          ),
      );

    const endpoint = `${req.method} ${req.path}`;
    const hash = requestFingerprint(req.method, req.path, req.body);
    const successStatus =
      this.reflector.get<number>(HTTP_CODE_METADATA, context.getHandler()) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return from(this.service.claim(req.user.organizationId, key, endpoint, hash)).pipe(
      mergeMap((claim) => {
        if (claim.kind === 'MISMATCH')
          return throwError(
            () =>
              new AppError(
                ErrorCodes.IDEMPOTENCY_CONFLICT,
                'This Idempotency-Key was already used with a different request.',
                HttpStatus.UNPROCESSABLE_ENTITY,
                { endpoint: claim.row.endpoint },
              ),
          );
        if (claim.kind === 'IN_PROGRESS')
          return throwError(
            () =>
              new ConflictError(
                'A request with this Idempotency-Key is still being processed.',
                {},
                ErrorCodes.IDEMPOTENCY_IN_PROGRESS,
              ),
          );
        if (claim.kind === 'REPLAY') {
          res.status(claim.row.responseStatus ?? successStatus);
          res.setHeader(HEADERS.IDEMPOTENT_REPLAYED, 'true');
          const body = claim.row.responseBody;
          if ((claim.row.responseStatus ?? 200) >= 400)
            return throwError(() => new HttpException(body as object, claim.row.responseStatus!));
          return of(body ?? undefined);
        }
        const rowId = claim.row.id;
        return next.handle().pipe(
          // Nest applies the status after the interceptor chain, so derive it from metadata.
          tap((body) => void this.service.complete(rowId, successStatus, body)),
          catchError((err: unknown) => {
            const status = err instanceof HttpException ? err.getStatus() : 500;
            // Client errors are deterministic: replay them. Server errors release the key.
            const settle =
              status >= 500
                ? this.service.release(rowId)
                : this.service.complete(
                    rowId,
                    status,
                    err instanceof HttpException ? err.getResponse() : { message: 'error' },
                  );
            return from(settle).pipe(mergeMap(() => throwError(() => err)));
          }),
        );
      }),
    );
  }
}
