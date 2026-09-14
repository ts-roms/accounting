import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { DelegatedGrant, PermissionKey } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { PERMISSIONS_KEY } from '@/common/decorators/require-permissions.decorator';
import { COMPANY_SCOPED_KEY } from '@/common/decorators/company-scoped.decorator';
import {
  ForbiddenError,
  PermissionDeniedError,
  UnauthenticatedError,
} from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';

/**
 * Enforces `@RequirePermissions()` and `@CompanyScoped()` metadata against the
 * principal resolved by the auth guard. Runs after JwtAuthGuard.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) throw new UnauthenticatedError();

    if (this.reflector.getAllAndOverride<boolean>(COMPANY_SCOPED_KEY, targets) && !user.companyId) {
      throw new ForbiddenError(
        'This operation requires an active company (X-Company-Id header).',
        ErrorCodes.COMPANY_CONTEXT_REQUIRED,
      );
    }

    const required =
      this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, targets) ?? [];
    return PermissionsGuard.hasAll(user.permissions, required, user.delegations);
  }

  /**
   * A permission is satisfied by the principal's own grant or by an active
   * delegation for the active company (grants are resolved per company by the
   * auth guard). Delegated permissions still go through
   * `AuthorityService.assert` in the service for scope / amount / SoD.
   */
  static hasAll(
    granted: ReadonlySet<string>,
    required: readonly string[],
    delegations: readonly DelegatedGrant[] = [],
  ): boolean {
    const missing = required.filter(
      (p) => !granted.has(p) && !delegations.some((d) => d.permission === p),
    );
    if (missing.length > 0) throw new PermissionDeniedError(missing);
    return true;
  }
}
