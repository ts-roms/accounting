import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { DelegatedGrant } from '@accounting/types';
import type { ChangePasswordInput, LoginInput } from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { OrganizationsService } from '@/modules/organizations/organizations.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { PasswordService } from '@/modules/users/password.service';
import { UsersService, toUserView, type UserView } from '@/modules/users/users.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AppError, UnauthenticatedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { RequestContext } from '@/common/context/request-context';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { sessions, userRoles, users, type Company, type User } from '@/database/schema';
import type { IssuedTokens } from './auth-cookies';
import { TokenService } from './token.service';

const MODULE = 'AUTH';
/** Lockout policy: after N consecutive failures the account is locked for M minutes. */
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginResult {
  user: UserView;
  tokens: IssuedTokens;
  sessionId: string;
}

export interface MeResponse {
  user: UserView;
  organization: { id: string; name: string; baseCurrency: string; timezone: string };
  permissions: string[];
  roleKeys: string[];
  activeCompanyId: string | null;
  /** Active delegations lending the user approval authority in the active company. */
  delegations: readonly DelegatedGrant[];
  companies: Pick<Company, 'id' | 'code' | 'name' | 'baseCurrency'>[];
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
    private readonly resolver: PermissionResolverService,
    private readonly organizations: OrganizationsService,
    private readonly logger: PinoLogger,
    private readonly cache: AuthorizationCacheService,
  ) {
    this.logger.setContext(AuthService.name);
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.users.findByEmail(input.email);

    // Constant-ish time: always run a hash verification even when the user is
    // unknown so timing does not reveal whether an email exists.
    const valid = user
      ? await this.passwords.verify(user.passwordHash, input.password)
      : await this.passwords.verify(DUMMY_HASH, input.password).then(() => false);

    if (!user) {
      await this.audit.record({
        action: 'LOGIN_FAILED',
        module: MODULE,
        entityType: 'User',
        metadata: { email: input.email, reason: 'UNKNOWN_USER' },
      });
      throw new UnauthenticatedError('Invalid email or password.', ErrorCodes.INVALID_CREDENTIALS);
    }

    if (user.status === 'INACTIVE') {
      await this.recordFailure(user, 'INACTIVE');
      throw new UnauthenticatedError('This account is inactive.', ErrorCodes.ACCOUNT_INACTIVE);
    }
    if (user.status === 'LOCKED' || (user.lockedUntil && user.lockedUntil > new Date())) {
      await this.recordFailure(user, 'LOCKED');
      throw new UnauthenticatedError(
        'This account is locked. Try again later or contact an administrator.',
        ErrorCodes.ACCOUNT_LOCKED,
      );
    }

    if (!valid) {
      await this.registerFailedAttempt(user);
      throw new UnauthenticatedError('Invalid email or password.', ErrorCodes.INVALID_CREDENTIALS);
    }

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(users)
        .set({ failedLoginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() })
        .where(eq(users.id, user.id))
        .returning();
      if (!updated) throw new Error('Update returned no row');

      if (this.passwords.needsRehash(user.passwordHash)) {
        await tx
          .update(users)
          .set({ passwordHash: await this.passwords.hash(input.password) })
          .where(eq(users.id, user.id));
      }

      // A fresh sign-in always rebuilds the authorization context (roles changed out of band, etc.).
      this.cache.invalidateUser(user.id);
      const { sessionId, tokens } = await this.createSession(tx, updated);
      await this.audit.record(
        {
          action: 'LOGIN',
          module: MODULE,
          entityType: 'User',
          entityId: user.id,
          organizationId: user.organizationId,
          userId: user.id,
          userEmail: user.email,
          metadata: { sessionId },
        },
        tx,
      );
      return { user: toUserView(updated), tokens, sessionId };
    });
  }

  /** Rotates the refresh token: the presented token is revoked and replaced. */
  async refresh(refreshToken: string): Promise<LoginResult> {
    const hash = this.tokens.hashRefreshToken(refreshToken);
    const [presented] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.refreshTokenHash, hash));
    if (!presented)
      throw new UnauthenticatedError('Session is invalid.', ErrorCodes.SESSION_EXPIRED);

    if (presented.revokedAt) {
      // Reuse of a rotated token indicates theft: revoke every live session of the
      // user. This runs outside the transaction below so it commits even though
      // the request itself fails.
      this.logger.warn(
        { userId: presented.userId, sessionId: presented.id },
        'Refresh token reuse detected',
      );
      const owner = await this.users.findById(presented.userId);
      await this.db.transaction(async (tx) => {
        await tx
          .update(sessions)
          .set({ revokedAt: new Date() })
          .where(and(eq(sessions.userId, presented.userId), isNull(sessions.revokedAt)));
        await this.audit.record(
          {
            action: 'LOGOUT',
            module: MODULE,
            entityType: 'User',
            entityId: presented.userId,
            organizationId: owner?.organizationId,
            userId: presented.userId,
            userEmail: owner?.email,
            metadata: { reason: 'REFRESH_TOKEN_REUSE', sessionId: presented.id },
          },
          tx,
        );
      });
      throw new UnauthenticatedError('Session is invalid.', ErrorCodes.SESSION_EXPIRED);
    }

    return this.db.transaction(async (tx) => {
      // Re-read under a row lock so two concurrent refreshes cannot both rotate.
      const [session] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.id, presented.id))
        .for('update');
      if (!session || session.revokedAt)
        throw new UnauthenticatedError('Session is invalid.', ErrorCodes.SESSION_EXPIRED);
      if (session.expiresAt <= new Date()) {
        throw new UnauthenticatedError('Session has expired.', ErrorCodes.SESSION_EXPIRED);
      }

      const user = await this.users.findById(session.userId, tx);
      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthenticatedError('This account is not active.', ErrorCodes.ACCOUNT_INACTIVE);
      }

      const next = await this.createSession(tx, user);
      await tx
        .update(sessions)
        .set({ revokedAt: new Date(), replacedBySessionId: next.sessionId })
        .where(eq(sessions.id, session.id));

      await this.audit.record(
        {
          action: 'TOKEN_REFRESH',
          module: MODULE,
          entityType: 'User',
          entityId: user.id,
          organizationId: user.organizationId,
          userId: user.id,
          userEmail: user.email,
          metadata: { previousSessionId: session.id, sessionId: next.sessionId },
        },
        tx,
      );
      return { user: toUserView(user), tokens: next.tokens, sessionId: next.sessionId };
    });
  }

  async logout(principal: AuthenticatedUser): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.id, principal.sessionId), isNull(sessions.revokedAt)));
      await this.audit.record(
        {
          action: 'LOGOUT',
          module: MODULE,
          entityType: 'User',
          entityId: principal.id,
          metadata: { sessionId: principal.sessionId },
        },
        tx,
      );
    });
  }

  async changePassword(principal: AuthenticatedUser, input: ChangePasswordInput): Promise<void> {
    const user = await this.users.findById(principal.id);
    if (!user) throw new UnauthenticatedError();
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      throw new AppError(ErrorCodes.INVALID_CREDENTIALS, 'Current password is incorrect.');
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordChangedAt: new Date() })
        .where(eq(users.id, user.id));
      this.cache.invalidateUser(user.id);
      // Invalidate every other session; the current one stays valid.
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, user.id), isNull(sessions.revokedAt)));
      await this.audit.record(
        { action: 'PASSWORD_CHANGE', module: MODULE, entityType: 'User', entityId: user.id },
        tx,
      );
    });
  }

  /** Session-validity check used by the auth guard on every request. */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
    return Boolean(row);
  }

  async me(principal: AuthenticatedUser): Promise<MeResponse> {
    const [user, organization, companies] = await Promise.all([
      this.users.getOrThrow(principal.organizationId, principal.id),
      this.organizations.getOrganization(principal.organizationId),
      this.accessibleCompanies(principal.id, principal.organizationId),
    ]);
    return {
      user: toUserView(user),
      organization: {
        id: organization.id,
        name: organization.name,
        baseCurrency: organization.baseCurrency,
        timezone: organization.timezone,
      },
      permissions: [...principal.permissions].sort(),
      roleKeys: [...principal.roleKeys],
      activeCompanyId: principal.companyId ?? null,
      delegations: principal.delegations ?? [],
      companies: companies.map((c) => ({
        id: c.id,
        code: c.code,
        name: c.name,
        baseCurrency: c.baseCurrency,
      })),
    };
  }

  /**
   * A user with at least one organization-wide role may act in every active
   * company; otherwise only in the companies of their scoped assignments.
   */
  async accessibleCompanies(userId: string, organizationId: string): Promise<Company[]> {
    const rows = await this.db
      .select({ companyId: userRoles.companyId })
      .from(userRoles)
      .where(eq(userRoles.userId, userId));
    const orgWide = rows.some((r) => r.companyId === null);
    const ids = [
      ...new Set(rows.map((r) => r.companyId).filter((id): id is string => Boolean(id))),
    ];
    return this.organizations.listAccessibleCompanies(organizationId, orgWide ? 'ALL' : ids);
  }

  // ------------------------------------------------------------------ internals

  private async createSession(
    tx: DbExecutor,
    user: User,
  ): Promise<{ sessionId: string; tokens: IssuedTokens }> {
    const refreshToken = this.tokens.generateRefreshToken();
    const ctx = RequestContext.get();
    const [session] = await tx
      .insert(sessions)
      .values({
        userId: user.id,
        refreshTokenHash: this.tokens.hashRefreshToken(refreshToken),
        ipAddress: ctx?.ipAddress ?? null,
        userAgent: ctx?.userAgent ?? null,
        expiresAt: new Date(Date.now() + this.tokens.refreshTtlSeconds * 1000),
      })
      .returning({ id: sessions.id });
    if (!session) throw new Error('Insert returned no row');

    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      sid: session.id,
      org: user.organizationId,
    });
    return { sessionId: session.id, tokens: { accessToken, refreshToken } };
  }

  private async registerFailedAttempt(user: User): Promise<void> {
    const attempts = user.failedLoginAttempts + 1;
    const lock = attempts >= MAX_FAILED_ATTEMPTS;
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          failedLoginAttempts: lock ? 0 : attempts,
          lockedUntil: lock ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
        })
        .where(eq(users.id, user.id));
      if (lock) this.cache.invalidateUser(user.id);
      await this.audit.record(
        {
          action: 'LOGIN_FAILED',
          module: MODULE,
          entityType: 'User',
          entityId: user.id,
          organizationId: user.organizationId,
          userEmail: user.email,
          metadata: { reason: 'BAD_PASSWORD', attempts, locked: lock },
        },
        tx,
      );
    });
  }

  private async recordFailure(user: User, reason: string): Promise<void> {
    await this.audit.record({
      action: 'LOGIN_FAILED',
      module: MODULE,
      entityType: 'User',
      entityId: user.id,
      organizationId: user.organizationId,
      userEmail: user.email,
      metadata: { reason },
    });
  }
}

/** A valid argon2id hash of a random string, used to equalise timing for unknown users. */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$Q6qkR2Ck3vT9hGmZ4a2p8i1fHnJm7X4OaY5Y0cJ2cPo';
