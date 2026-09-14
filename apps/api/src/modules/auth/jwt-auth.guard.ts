import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { COOKIES, HEADERS } from '@accounting/config';
import { OrganizationsService } from '@/modules/organizations/organizations.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { UsersService } from '@/modules/users/users.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { ForbiddenError, UnauthenticatedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global authentication guard.
 *  1. Extracts the access token (httpOnly cookie or Bearer header).
 *  2. Verifies the signature/expiry and that the session is not revoked.
 *  3. Loads the user (must be ACTIVE) and validates the optional company context.
 *  4. Resolves effective permissions and attaches the principal to the request.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly resolver: PermissionResolverService,
    private readonly organizations: OrganizationsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    // Public routes (login, refresh, health) never depend on a principal. A stale
    // or revoked cookie must not block them - refresh in particular has to reach
    // the service so token-reuse detection can run.
    if (isPublic) return true;

    const token = this.extractToken(req);
    if (!token) throw new UnauthenticatedError();

    const payload = await this.tokens.verifyAccessToken(token);
    if (!payload)
      throw new UnauthenticatedError(
        'Access token is invalid or expired.',
        ErrorCodes.SESSION_EXPIRED,
      );

    const [user, sessionActive] = await Promise.all([
      this.users.findById(payload.sub),
      this.auth.isSessionActive(payload.sid),
    ]);
    if (!user || user.organizationId !== payload.org) throw new UnauthenticatedError();
    if (!sessionActive)
      throw new UnauthenticatedError('Session has been revoked.', ErrorCodes.SESSION_EXPIRED);
    if (user.status !== 'ACTIVE')
      throw new UnauthenticatedError('This account is not active.', ErrorCodes.ACCOUNT_INACTIVE);

    const companyId = await this.resolveCompany(req, user.id, user.organizationId);
    const access = await this.resolver.resolve(user.id, companyId);

    const principal: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId: user.organizationId,
      sessionId: payload.sid,
      companyId,
      permissions: access.permissions,
      roleKeys: access.roleKeys,
    };
    req.user = principal;
    RequestContext.patch({
      userId: user.id,
      userEmail: user.email,
      organizationId: user.organizationId,
      companyId,
      sessionId: payload.sid,
    });
    return true;
  }

  private extractToken(req: Request): string | undefined {
    const header = req.header('authorization');
    if (header?.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = req.cookies?.[COOKIES.ACCESS_TOKEN];
    return typeof cookie === 'string' && cookie.length > 0 ? cookie : undefined;
  }

  /** Validates X-Company-Id: must be a company of the org that the user can access. */
  private async resolveCompany(
    req: Request,
    userId: string,
    organizationId: string,
  ): Promise<string | undefined> {
    const raw = req.header(HEADERS.COMPANY_ID);
    if (!raw) return undefined;
    if (!UUID_RE.test(raw)) {
      throw new ForbiddenError('X-Company-Id must be a UUID.', ErrorCodes.COMPANY_NOT_ACCESSIBLE);
    }
    const accessible = await this.auth.accessibleCompanies(userId, organizationId);
    if (!accessible.some((c) => c.id === raw)) {
      throw new ForbiddenError(
        'You do not have access to the selected company.',
        ErrorCodes.COMPANY_NOT_ACCESSIBLE,
        {
          companyId: raw,
        },
      );
    }
    return raw;
  }
}
