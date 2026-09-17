import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { AssignUserRoleInput } from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { RequestContext } from '@/common/context/request-context';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { companies, roles, userRoles, users } from '@/database/schema';
import { PermissionResolverService } from './permission-resolver.service';
import { RolesService } from './roles.service';
import { SodService, type SodConflict } from './sod.service';

export interface AssignmentResult {
  assignmentId: string;
  warnings: SodConflict[];
}

export interface UserRoleView {
  id: string;
  roleId: string;
  roleKey: string;
  roleName: string;
  companyId: string | null;
  companyName: string | null;
}

/**
 * Assigns and revokes roles, enforcing segregation-of-duties policies and the
 * "at least one super administrator" invariant.
 */
@Injectable()
export class RoleAssignmentService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly rolesService: RolesService,
    private readonly resolver: PermissionResolverService,
    private readonly sod: SodService,
    private readonly cache: AuthorizationCacheService,
  ) {}

  async listForUser(organizationId: string, userId: string): Promise<UserRoleView[]> {
    await this.assertUserInOrg(organizationId, userId, this.db);
    return this.db
      .select({
        id: userRoles.id,
        roleId: roles.id,
        roleKey: roles.key,
        roleName: roles.name,
        companyId: userRoles.companyId,
        companyName: companies.name,
      })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(companies, eq(companies.id, userRoles.companyId))
      .where(eq(userRoles.userId, userId));
  }

  async assign(
    organizationId: string,
    userId: string,
    input: AssignUserRoleInput,
  ): Promise<AssignmentResult> {
    const result = await this.db.transaction(async (tx) =>
      this.assignWithin(tx, organizationId, userId, input),
    );
    this.cache.invalidateUser(userId);
    return result;
  }

  /** Same as `assign` but participates in an outer transaction (user creation). */
  async assignWithin(
    tx: DbExecutor,
    organizationId: string,
    userId: string,
    input: AssignUserRoleInput,
  ): Promise<AssignmentResult> {
    await this.assertUserInOrg(organizationId, userId, tx);
    const role = await this.rolesService.getOrThrow(organizationId, input.roleId, tx);
    const companyId = input.companyId ?? null;

    if (companyId) {
      const [company] = await tx
        .select({ id: companies.id })
        .from(companies)
        .where(and(eq(companies.id, companyId), eq(companies.organizationId, organizationId)));
      if (!company) throw new NotFoundError('Company', companyId);
    }

    // SoD: evaluate the permission set the user WOULD hold in this scope.
    const current = await this.resolver.resolve(userId, companyId ?? undefined, tx);
    const added = await this.resolver.permissionsForRoles([role.id], tx);
    const effective = new Set([...current.permissions, ...added]);
    const warnings = await this.sod.assertAllowed(organizationId, effective, tx);

    let assignmentId: string;
    try {
      const [row] = await tx
        .insert(userRoles)
        .values({
          userId,
          roleId: role.id,
          companyId,
          assignedBy: RequestContext.get()?.userId ?? null,
        })
        .returning({ id: userRoles.id });
      if (!row) throw new Error('Insert returned no row');
      assignmentId = row.id;
    } catch (err) {
      if (isUniqueViolation(err, 'user_roles_uq')) {
        throw new BusinessRuleError(
          ErrorCodes.DUPLICATE,
          'The user already holds this role in that scope.',
        );
      }
      throw err;
    }

    await this.audit.record(
      {
        action: 'ROLE_ASSIGN',
        module: 'RBAC',
        entityType: 'User',
        entityId: userId,
        newValue: { roleId: role.id, roleKey: role.key, companyId },
        metadata: warnings.length > 0 ? { sodWarnings: warnings } : undefined,
      },
      tx,
    );
    return { assignmentId, warnings };
  }

  async revoke(organizationId: string, userId: string, assignmentId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.assertUserInOrg(organizationId, userId, tx);
      const [assignment] = await tx
        .select({
          id: userRoles.id,
          roleId: userRoles.roleId,
          roleKey: roles.key,
          companyId: userRoles.companyId,
        })
        .from(userRoles)
        .innerJoin(roles, eq(roles.id, userRoles.roleId))
        .where(and(eq(userRoles.id, assignmentId), eq(userRoles.userId, userId)))
        .for('update');
      if (!assignment) throw new NotFoundError('Role assignment', assignmentId);

      if (assignment.roleKey === 'SUPER_ADMIN' && assignment.companyId === null) {
        await this.assertNotLastSuperAdmin(tx, organizationId, userId);
      }

      await tx.delete(userRoles).where(eq(userRoles.id, assignmentId));
      this.cache.invalidateUser(userId);
      await this.audit.record(
        {
          action: 'ROLE_REVOKE',
          module: 'RBAC',
          entityType: 'User',
          entityId: userId,
          previousValue: {
            roleId: assignment.roleId,
            roleKey: assignment.roleKey,
            companyId: assignment.companyId,
          },
        },
        tx,
      );
    });
  }

  /** Guards against locking everyone out of administration. */
  async assertNotLastSuperAdmin(
    tx: DbExecutor,
    organizationId: string,
    excludingUserId: string,
  ): Promise<void> {
    const others = await tx
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(
        and(
          eq(roles.organizationId, organizationId),
          eq(roles.key, 'SUPER_ADMIN'),
          eq(users.status, 'ACTIVE'),
        ),
      );
    const remaining = others.filter((o) => o.userId !== excludingUserId);
    if (remaining.length === 0) {
      throw new BusinessRuleError(
        ErrorCodes.LAST_SUPER_ADMIN,
        'At least one active super administrator must remain in the organization.',
      );
    }
  }

  private async assertUserInOrg(
    organizationId: string,
    userId: string,
    executor: DbExecutor,
  ): Promise<void> {
    const [row] = await executor
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)));
    if (!row) throw new NotFoundError('User', userId);
  }
}
