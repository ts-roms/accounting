import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { COOKIES, HEADERS, REQUESTED_WITH_VALUE } from '@accounting/config';
import { ForbiddenError } from '../errors/app-error';
import { ErrorCodes } from '../errors/error-codes';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Cookie-based sessions are vulnerable to CSRF. Because cookies are SameSite=Lax
 * and every state-changing request must additionally carry a custom header
 * (which cross-origin forms cannot set), forged requests are rejected here.
 * Requests authenticated with a Bearer token carry no ambient credential and
 * are exempt.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (SAFE_METHODS.has(req.method)) return true;

    const usesCookieAuth =
      Boolean(req.cookies?.[COOKIES.ACCESS_TOKEN]) || Boolean(req.cookies?.[COOKIES.REFRESH_TOKEN]);
    if (!usesCookieAuth) return true;

    if (req.header(HEADERS.REQUESTED_WITH) !== REQUESTED_WITH_VALUE) {
      throw new ForbiddenError(
        `State-changing requests must include the ${HEADERS.REQUESTED_WITH} header.`,
        ErrorCodes.CSRF_HEADER_MISSING,
      );
    }
    return true;
  }
}
