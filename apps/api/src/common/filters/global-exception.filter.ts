import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import { PinoLogger } from 'nestjs-pino';
import { ThrottlerException } from '@nestjs/throttler';
import type { ApiErrorBody } from '@accounting/types';
import { RequestContext } from '../context/request-context';
import { AppError } from '../errors/app-error';
import { ErrorCodes } from '../errors/error-codes';
import { isTransactionConflict } from '../utils/pg-errors';

/**
 * Translates every thrown error into the standard envelope:
 *   { code, message, details, correlationId }
 * Unknown errors are logged with their stack but never leaked to the client.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(GlobalExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId = RequestContext.get()?.correlationId;

    const { status, body } = this.normalise(exception);
    body.correlationId = correlationId;

    if (status >= 500) {
      this.logger.error(
        { err: exception, method: req.method, url: req.originalUrl, correlationId },
        'Unhandled exception',
      );
    } else if (status === 401 || status === 403) {
      this.logger.warn(
        { code: body.code, method: req.method, url: req.originalUrl },
        'Access denied',
      );
    }

    res.status(status).json(body);
  }

  private normalise(exception: unknown): { status: number; body: ApiErrorBody } {
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError();
      const issues = (zodError as { issues?: unknown[] }).issues ?? [];
      return {
        status: HttpStatus.BAD_REQUEST,
        body: {
          code: ErrorCodes.VALIDATION_FAILED,
          message: 'Request validation failed.',
          details: { issues },
        },
      };
    }

    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        body: { code: exception.code, message: exception.message, details: exception.details },
      };
    }

    if (exception instanceof ThrottlerException) {
      return {
        status: HttpStatus.TOO_MANY_REQUESTS,
        body: { code: ErrorCodes.RATE_LIMITED, message: 'Too many requests. Please slow down.' },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ?? exception.message);
      return {
        status,
        body: {
          code: this.codeForStatus(status),
          message: Array.isArray(message) ? message.join('; ') : message,
        },
      };
    }

    // A deadlock or serialization failure rolled everything back: a retryable conflict, not a
    // server fault. (The Idempotency-Key interceptor saw the raw error and released the key.)
    if (isTransactionConflict(exception)) {
      return {
        status: HttpStatus.CONFLICT,
        body: {
          code: ErrorCodes.TRANSACTION_CONFLICT,
          message:
            'The change clashed with another one saved at the same time and was not applied. Try again.',
        },
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { code: ErrorCodes.INTERNAL_ERROR, message: 'An unexpected error occurred.' },
    };
  }

  private codeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return ErrorCodes.VALIDATION_FAILED;
      case HttpStatus.UNAUTHORIZED:
        return ErrorCodes.UNAUTHENTICATED;
      case HttpStatus.FORBIDDEN:
        return ErrorCodes.FORBIDDEN;
      case HttpStatus.NOT_FOUND:
        return ErrorCodes.NOT_FOUND;
      case HttpStatus.CONFLICT:
        return ErrorCodes.CONFLICT;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCodes.RATE_LIMITED;
      default:
        return ErrorCodes.INTERNAL_ERROR;
    }
  }
}
