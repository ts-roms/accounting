import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { COOKIES, HEADERS } from '@accounting/config';
import { DelegationsService } from '@/modules/delegations/delegations.service';
import { ApiKeysService } from '@/modules/integrations/api-keys/api-keys.service';
import {
  effectiveApiKeyPermissions,
  isApiKeySecret,
} from '@/modules/integrations/api-keys/api-key.logic';
import { OrganizationsService } from '@/modules/organizations/organizations.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { UsersService } from '@/modules/users/users.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { RequestContext } from '@/common/context/request-context';
import { IS_PUBLIC_KEY } from '@/common/decorators/public.decorator';
import { AppError, ForbiddenError, UnauthenticatedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Global authentication guard.
 *  1. Extracts the credential: httpOnly session cookie, Bearer JWT, or Bearer API key (`ak_...`).
 *  2. Sessions: verifies signature / expiry and that the session is not revoked.
 *     API keys: verifies the hash, status, expiry and per-key rate limit.
 *  3. Loads the user (must be ACTIVE) and validates the optional company context.
 *  4. Resolves effective permissions (API keys: scopes intersected with the
 *     owner's permissions) plus active delegations for the company, and
 *     attaches the principal to the request.
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
    private readonly apiKeys: ApiKeysService,
    private readonly delegations: DelegationsService,
    private readonly cache: AuthorizationCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();

    // Public routes (login, refresh, health, webhook receivers) never depend on
    // a principal. A stale or revoked cookie must not block them - refresh in
    // particular has to reach the service so token-reuse detection can run.
    if (isPublic) return true;

    const token = this.extractToken(req);
    if (!token) throw new UnauthenticatedError();

    const principal = isApiKeySecret(token)
      ? await this.authenticateApiKey(req, token, context.switchToHttp().getResponse<Response>())
      : await this.authenticateSession(req, token);

    req.user = principal;
    RequestContext.patch({
      userId: principal.id,
      userEmail: principal.email,
      organizationId: principal.organizationId,
      companyId: principal.companyId,
      sessionId: principal.sessionId,
    });
    return true;
  }

  private async authenticateSession(req: Request, token: string): Promise<AuthenticatedUser> {
    const payload = await this.tokens.verifyAccessToken(token);
    if (!payload)
      throw new UnauthenticatedError(
        'Access token is invalid or expired.',
        ErrorCodes.SESSION_EXPIRED,
      );

    const [user, sessionActive] = await Promise.all([
      this.cache.remember(payload.sub, 'user', () => this.users.findById(payload.sub)),
      this.auth.isSessionActive(payload.sid),
    ]);
    if (!user || user.organizationId !== payload.org) throw new UnauthenticatedError();
    if (!sessionActive)
      throw new UnauthenticatedError('Session has been revoked.', ErrorCodes.SESSION_EXPIRED);
    if (user.status !== 'ACTIVE')
      throw new UnauthenticatedError('This account is not active.', ErrorCodes.ACCOUNT_INACTIVE);

    const companyId = await this.resolveCompany(req, user.id, user.organizationId);
    const context = await this.cache.remember(user.id, `context:${companyId ?? ''}`, async () => {
      const [access, delegations] = await Promise.all([
        this.resolver.resolve(user.id, companyId),
        companyId ? this.delegations.grantsFor(user.id, companyId) : Promise.resolve([]),
      ]);
      return { access, delegations };
    });
    const { access } = context;
    // Grants expire by the clock, not by a write: never honour one past its end from the cache.
    const nowIso = new Date().toISOString();
    const delegations = context.delegations.filter((d) => d.endAt > nowIso);

    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      organizationId: user.organizationId,
      sessionId: payload.sid,
      companyId,
      permissions: access.permissions,
      roleKeys: access.roleKeys,
      delegations,
    };
  }

  /**
   * API keys act as their owner, limited to the key's scopes, its company
   * list and its rate limit. They never receive delegated authority.
   */
  private async authenticateApiKey(
    req: Request,
    secret: string,
    res: Response,
  ): Promise<AuthenticatedUser> {
    const { key, scopes } = await this.apiKeys.authenticate(secret);
    const remaining = this.apiKeys.consumeQuota(key);
    res.setHeader(HEADERS.RATE_LIMIT_REMAINING, String(Math.max(remaining, 0)));
    if (remaining < 0)
      throw new AppError(
        ErrorCodes.RATE_LIMITED,
        'API key rate limit exceeded.',
        HttpStatus.TOO_MANY_REQUESTS,
        { limitPerMinute: key.rateLimitPerMinute },
      );
    const owner = await this.cache.remember(key.ownerUserId, 'user', () =>
      this.users.findById(key.ownerUserId),
    );
    if (!owner || owner.organizationId !== key.organizationId || owner.status !== 'ACTIVE')
      throw new UnauthenticatedError(
        'The API key owner is not active.',
        ErrorCodes.API_KEY_INVALID,
      );

    const companyId = await this.resolveCompany(req, owner.id, owner.organizationId);
    if (companyId && key.companyIds.length > 0 && !key.companyIds.includes(companyId))
      throw new ForbiddenError(
        'This API key is not allowed to act in the selected company.',
        ErrorCodes.COMPANY_NOT_ACCESSIBLE,
        { companyId },
      );
    const ownerAccess = await this.cache.remember(owner.id, `access:${companyId ?? ''}`, () =>
      this.resolver.resolve(owner.id, companyId),
    );
    this.apiKeys.touch(key.id);
    return {
      id: owner.id,
      email: owner.email,
      firstName: owner.firstName,
      lastName: owner.lastName,
      organizationId: owner.organizationId,
      sessionId: `apikey:${key.id}`,
      companyId,
      permissions: effectiveApiKeyPermissions(scopes, ownerAccess.permissions),
      roleKeys: [],
      apiKeyId: key.id,
      scopes,
      delegations: [],
    };
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
    const accessible = await this.cache.remember(userId, 'companies', () =>
      this.auth.accessibleCompanies(userId, organizationId),
    );
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
