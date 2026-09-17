import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type {
  CreateRoleInput,
  SetRolePermissionsInput,
  UpdateRoleInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  permissions,
  rolePermissions,
  roles,
  userRoles,
  type Permission,
  type Role,
} from '@/database/schema';

export interface RoleWithPermissions extends Role {
  permissions: string[];
  userCount: number;
}

const LOCKED_ROLE_KEYS = new Set(['SUPER_ADMIN']);

@Injectable()
export class RolesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly cache: AuthorizationCacheService,
  ) {}

  async listPermissions(): Promise<Permission[]> {
    return this.db
      .select()
      .from(permissions)
      .orderBy(asc(permissions.module), asc(permissions.key));
  }

  async list(organizationId: string): Promise<RoleWithPermissions[]> {
    const roleRows = await this.db
      .select()
      .from(roles)
      .where(eq(roles.organizationId, organizationId))
      .orderBy(asc(roles.isSystem), asc(roles.name));
    if (roleRows.length === 0) return [];

    const roleIds = roleRows.map((r) => r.id);
    const [permRows, countRows] = await Promise.all([
      this.db
        .select({ roleId: rolePermissions.roleId, key: permissions.key })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(inArray(rolePermissions.roleId, roleIds)),
      this.db
        .select({ roleId: userRoles.roleId, total: count() })
        .from(userRoles)
        .where(inArray(userRoles.roleId, roleIds))
        .groupBy(userRoles.roleId),
    ]);

    const permsByRole = new Map<string, string[]>();
    for (const row of permRows) {
      const list = permsByRole.get(row.roleId) ?? [];
      list.push(row.key);
      permsByRole.set(row.roleId, list);
    }
    const countByRole = new Map(countRows.map((r) => [r.roleId, Number(r.total)]));

    return roleRows.map((r) => ({
      ...r,
      permissions: (permsByRole.get(r.id) ?? []).sort(),
      userCount: countByRole.get(r.id) ?? 0,
    }));
  }

  async getOrThrow(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Role> {
    const [role] = await executor
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), eq(roles.organizationId, organizationId)));
    if (!role) throw new NotFoundError('Role', id);
    return role;
  }

  async getWithPermissions(organizationId: string, id: string): Promise<RoleWithPermissions> {
    const all = await this.list(organizationId);
    const role = all.find((r) => r.id === id);
    if (!role) throw new NotFoundError('Role', id);
    return role;
  }

  async create(organizationId: string, input: CreateRoleInput): Promise<RoleWithPermissions> {
    const id = await this.db.transaction(async (tx) => {
      let created: Role | undefined;
      try {
        [created] = await tx
          .insert(roles)
          .values({
            organizationId,
            key: input.key,
            name: input.name,
            description: input.description ?? null,
            isSystem: false,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'roles_org_key_uq'))
          throw new DuplicateError('Role', 'key', input.key);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');

      await this.replacePermissions(tx, created.id, input.permissions);
      await this.audit.record(
        {
          action: 'CREATE',
          module: 'RBAC',
          entityType: 'Role',
          entityId: created.id,
          newValue: { ...created, permissions: input.permissions },
        },
        tx,
      );
      return created.id;
    });
    // Every holder of the role is affected.
    this.cache.invalidateAll();
    return this.getWithPermissions(organizationId, id);
  }

  async update(
    organizationId: string,
    id: string,
    input: UpdateRoleInput,
  ): Promise<RoleWithPermissions> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(organizationId, id, tx);
      if (existing.isSystem && LOCKED_ROLE_KEYS.has(existing.key)) {
        throw new BusinessRuleError(
          ErrorCodes.SYSTEM_ROLE_IMMUTABLE,
          'This system role cannot be modified.',
        );
      }
      const [updated] = await tx
        .update(roles)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
        })
        .where(eq(roles.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: 'RBAC',
          entityType: 'Role',
          entityId: id,
          previousValue: previous,
          newValue: next,
        },
        tx,
      );
    });
    return this.getWithPermissions(organizationId, id);
  }

  async setPermissions(
    organizationId: string,
    id: string,
    input: SetRolePermissionsInput,
  ): Promise<RoleWithPermissions> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(organizationId, id, tx);
      if (existing.isSystem && LOCKED_ROLE_KEYS.has(existing.key)) {
        throw new BusinessRuleError(
          ErrorCodes.SYSTEM_ROLE_IMMUTABLE,
          'Permissions of this system role are fixed.',
        );
      }
      const before = await tx
        .select({ key: permissions.key })
        .from(rolePermissions)
        .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
        .where(eq(rolePermissions.roleId, id));

      await this.replacePermissions(tx, id, input.permissions);

      await this.audit.record(
        {
          action: 'PERMISSION_CHANGE',
          module: 'RBAC',
          entityType: 'Role',
          entityId: id,
          previousValue: { permissions: before.map((b) => b.key).sort() },
          newValue: { permissions: [...input.permissions].sort() },
        },
        tx,
      );
    });
    return this.getWithPermissions(organizationId, id);
  }

  private async replacePermissions(
    tx: DbExecutor,
    roleId: string,
    keys: readonly string[],
  ): Promise<void> {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    if (keys.length === 0) return;
    const permRows = await tx
      .select({ id: permissions.id, key: permissions.key })
      .from(permissions)
      .where(inArray(permissions.key, [...keys]));
    const missing = keys.filter((k) => !permRows.some((p) => p.key === k));
    if (missing.length > 0) {
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Unknown permission keys.', {
        missing,
      });
    }
    await tx.insert(rolePermissions).values(permRows.map((p) => ({ roleId, permissionId: p.id })));
  }
}
