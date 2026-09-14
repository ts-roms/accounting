import { HttpStatus } from '@nestjs/common';
import type { IntegrationErrorCode } from '@accounting/types';
import { AppError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';

/**
 * Standardised integration failure. `code` drives the retry policy; the
 * message is safe to show (never contains credentials or raw provider bodies).
 */
export class IntegrationError extends Error {
  constructor(
    readonly code: IntegrationErrorCode,
    message: string,
    readonly options: {
      httpStatus?: number;
      retryAfterMs?: number;
      cause?: unknown;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = 'IntegrationError';
  }

  static from(err: unknown): IntegrationError {
    if (err instanceof IntegrationError) return err;
    if (err instanceof AppError) {
      const status = err.getStatus();
      const code: IntegrationErrorCode =
        err.code === ErrorCodes.VALIDATION_FAILED
          ? 'VALIDATION_ERROR'
          : err.code === ErrorCodes.DUPLICATE
            ? 'DUPLICATE'
            : status === HttpStatus.UNAUTHORIZED
              ? 'AUTHENTICATION_ERROR'
              : status === HttpStatus.FORBIDDEN
                ? 'AUTHORIZATION_ERROR'
                : status === HttpStatus.TOO_MANY_REQUESTS
                  ? 'RATE_LIMITED'
                  : status >= 500
                    ? 'PROVIDER_ERROR'
                    : 'VALIDATION_ERROR';
      return new IntegrationError(code, err.message, {
        httpStatus: status,
        cause: err,
        details: { appCode: err.code },
      });
    }
    if (err && typeof err === 'object') {
      const e = err as { name?: string; code?: string; message?: string };
      if (e.name === 'AbortError' || e.code === 'ETIMEDOUT' || e.name === 'TimeoutError')
        return new IntegrationError('TIMEOUT', 'The provider did not respond in time.', {
          cause: err,
        });
      if (
        e.code === 'ECONNREFUSED' ||
        e.code === 'ENOTFOUND' ||
        e.code === 'ECONNRESET' ||
        e.code === 'EAI_AGAIN' ||
        e.name === 'FetchError'
      )
        return new IntegrationError('NETWORK_ERROR', 'Could not reach the provider.', {
          cause: err,
        });
      if (e.name === 'ZodError')
        return new IntegrationError('VALIDATION_ERROR', 'The record failed validation.', {
          cause: err,
        });
    }
    return new IntegrationError(
      'UNKNOWN_ERROR',
      err instanceof Error ? err.message : 'Unknown integration error.',
      { cause: err },
    );
  }

  /** Maps an HTTP response status from a provider to a code. */
  static fromHttpStatus(status: number, message?: string, retryAfterMs?: number): IntegrationError {
    const code: IntegrationErrorCode =
      status === 401
        ? 'AUTHENTICATION_ERROR'
        : status === 403
          ? 'AUTHORIZATION_ERROR'
          : status === 429
            ? 'RATE_LIMITED'
            : status === 408 || status === 504
              ? 'TIMEOUT'
              : status === 409
                ? 'DUPLICATE'
                : status >= 500
                  ? 'PROVIDER_ERROR'
                  : status >= 400
                    ? 'VALIDATION_ERROR'
                    : 'UNKNOWN_ERROR';
    return new IntegrationError(code, message ?? `Provider responded with HTTP ${status}.`, {
      httpStatus: status,
      retryAfterMs,
    });
  }
}
