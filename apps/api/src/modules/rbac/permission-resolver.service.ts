import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { permissions, rolePermissions, roles, userRoles } from '@/database/schema';

export interface ResolvedAccess {
  permissions: Set<string>;
  roleKeys: string[];
}

/**
 * Resolves the effective permission set of a user for an optional company.
 *
 * Effective permissions = union of permissions granted by
 *   - organization-wide role assignments (user_roles.company_id IS NULL), and
 *   - assignments scoped to the requested company.
 *
 * Resolution happens per request. It is a handful of indexed joins; a Redis
 * cache can be layered on later without changing callers.
 */
@Injectable()
export class PermissionResolverService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async resolve(
    userId: string,
    companyId?: string,
    executor: DbExecutor = this.db,
  ): Promise<ResolvedAccess> {
    const scope = companyId
      ? or(isNull(userRoles.companyId), eq(userRoles.companyId, companyId))
      : isNull(userRoles.companyId);

    const rows = await executor
      .select({ roleId: roles.id, roleKey: roles.key, permissionKey: permissions.key })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .leftJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(and(eq(userRoles.userId, userId), scope));

    const permissionSet = new Set<string>();
    const roleKeys = new Set<string>();
    for (const row of rows) {
      roleKeys.add(row.roleKey);
      if (row.permissionKey) permissionSet.add(row.permissionKey);
    }
    return { permissions: permissionSet, roleKeys: [...roleKeys].sort() };
  }

  /** Permissions granted by a set of roles (used by SoD checks before assignment). */
  async permissionsForRoles(
    roleIds: string[],
    executor: DbExecutor = this.db,
  ): Promise<Set<string>> {
    if (roleIds.length === 0) return new Set();
    const rows = await executor
      .select({ key: permissions.key })
      .from(rolePermissions)
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(inArray(rolePermissions.roleId, roleIds));
    return new Set(rows.map((r) => r.key));
  }
}
