import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { permissionsForScopes } from '@accounting/types';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { integrationScopes, users, type Integration } from '@/database/schema';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';

/**
 * The principal a sync job or inbound webhook acts as. It is the integration's
 * creator, narrowed to the integration's scopes - exactly the API-key rule -
 * so an integration can never post or approve unless a person with that
 * authority explicitly granted a `:post` scope. Domain services receive a
 * normal `AuthenticatedUser`; they do not know or care that an adapter is
 * calling them.
 */
@Injectable()
export class IntegrationPrincipalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly resolver: PermissionResolverService,
  ) {}

  async build(
    integration: Integration,
    executor: DbExecutor = this.db,
  ): Promise<AuthenticatedUser> {
    if (!integration.createdBy)
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'The integration has no owner to act as.',
      );
    const [owner] = await executor.select().from(users).where(eq(users.id, integration.createdBy));
    if (!owner || owner.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.INTEGRATION_INVALID_STATE,
        'The integration owner is not active.',
      );
    const scopes = (
      await executor
        .select({ scope: integrationScopes.scope })
        .from(integrationScopes)
        .where(eq(integrationScopes.integrationId, integration.id))
    ).map((s) => s.scope);
    const ownerAccess = await this.resolver.resolve(
      owner.id,
      integration.companyId ?? undefined,
      executor,
    );
    const granted = permissionsForScopes(scopes);
    const permissions = new Set<string>();
    for (const p of granted) if (ownerAccess.permissions.has(p)) permissions.add(p);
    return {
      id: owner.id,
      email: owner.email,
      firstName: owner.firstName,
      lastName: owner.lastName,
      organizationId: owner.organizationId,
      sessionId: `integration:${integration.id}`,
      companyId: integration.companyId ?? undefined,
      permissions,
      roleKeys: [],
      integrationId: integration.id,
      scopes,
    };
  }
}
