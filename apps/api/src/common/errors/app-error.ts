import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from './error-codes';
import { ErrorCodes } from './error-codes';

/**
 * Base class for all domain/application errors. Carries a stable `code` that
 * the global filter serialises into the standard error envelope.
 */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, status);
  }
}

export class NotFoundError extends AppError {
  constructor(entity: string, id?: string) {
    super(
      ErrorCodes.NOT_FOUND,
      id ? `${entity} '${id}' was not found.` : `${entity} was not found.`,
      HttpStatus.NOT_FOUND,
      { entity, id },
    );
  }
}

export class ConflictError extends AppError {
  constructor(
    message: string,
    details: Record<string, unknown> = {},
    code: ErrorCode = ErrorCodes.CONFLICT,
  ) {
    super(code, message, HttpStatus.CONFLICT, details);
  }
}

export class DuplicateError extends ConflictError {
  constructor(entity: string, field: string, value: string) {
    super(
      `${entity} with ${field} '${value}' already exists.`,
      { entity, field, value },
      ErrorCodes.DUPLICATE,
    );
  }
}

export class UnauthenticatedError extends AppError {
  constructor(
    message = 'Authentication is required.',
    code: ErrorCode = ErrorCodes.UNAUTHENTICATED,
  ) {
    super(code, message, HttpStatus.UNAUTHORIZED);
  }
}

export class ForbiddenError extends AppError {
  constructor(
    message = 'You do not have permission to perform this action.',
    code: ErrorCode = ErrorCodes.FORBIDDEN,
    details: Record<string, unknown> = {},
  ) {
    super(code, message, HttpStatus.FORBIDDEN, details);
  }
}

export class PermissionDeniedError extends ForbiddenError {
  constructor(required: readonly string[]) {
    super('You do not have the required permission.', ErrorCodes.PERMISSION_DENIED, { required });
  }
}

export class BusinessRuleError extends AppError {
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);
  }
}
