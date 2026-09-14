import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, or, type SQL } from 'drizzle-orm';
import type { PaginatedResult } from '@accounting/types';
import type {
  CreateUserInput,
  ListUsersQuery,
  SetUserStatusInput,
  UpdateUserInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { RoleAssignmentService } from '@/modules/rbac/role-assignment.service';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { RequestContext } from '@/common/context/request-context';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { users, type User } from '@/database/schema';
import { PasswordService } from './password.service';

/** Public projection - never expose password hashes or lockout internals. */
export interface UserView {
  id: string;
  organizationId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: User['status'];
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const toUserView = (u: User): UserView => ({
  id: u.id,
  organizationId: u.organizationId,
  email: u.email,
  firstName: u.firstName,
  lastName: u.lastName,
  status: u.status,
  lastLoginAt: u.lastLoginAt,
  createdAt: u.createdAt,
  updatedAt: u.updatedAt,
});

const SORTABLE: Record<
  string,
  typeof users.email | typeof users.createdAt | typeof users.lastName
> = {
  email: users.email,
  createdAt: users.createdAt,
  lastName: users.lastName,
};

@Injectable()
export class UsersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
    private readonly assignments: RoleAssignmentService,
  ) {}

  async list(organizationId: string, query: ListUsersQuery): Promise<PaginatedResult<UserView>> {
    const filters: SQL[] = [eq(users.organizationId, organizationId)];
    if (query.status) filters.push(eq(users.status, query.status));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(ilike(users.email, term), ilike(users.firstName, term), ilike(users.lastName, term))!,
      );
    }
    const where = and(...filters);
    const sortColumn = SORTABLE[query.sortBy ?? ''] ?? users.createdAt;
    const orderBy = query.sortDir === 'desc' ? desc(sortColumn) : asc(sortColumn);

    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(users)
        .where(where)
        .orderBy(orderBy)
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, users, where),
    ]);
    return toPaginatedResult(rows.map(toUserView), total, query);
  }

  async getOrThrow(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<User> {
    const [user] = await executor
      .select()
      .from(users)
      .where(and(eq(users.id, id), eq(users.organizationId, organizationId)));
    if (!user) throw new NotFoundError('User', id);
    return user;
  }

  async findByEmail(email: string, executor: DbExecutor = this.db): Promise<User | undefined> {
    const [user] = await executor.select().from(users).where(eq(users.email, email.toLowerCase()));
    return user;
  }

  async findById(id: string, executor: DbExecutor = this.db): Promise<User | undefined> {
    const [user] = await executor.select().from(users).where(eq(users.id, id));
    return user;
  }

  async create(organizationId: string, input: CreateUserInput): Promise<UserView> {
    const passwordHash = await this.passwords.hash(input.password);
    return this.db.transaction(async (tx) => {
      let created: User | undefined;
      try {
        [created] = await tx
          .insert(users)
          .values({
            organizationId,
            email: input.email,
            firstName: input.firstName,
            lastName: input.lastName,
            passwordHash,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_uq'))
          throw new DuplicateError('User', 'email', input.email);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');

      await this.audit.record(
        {
          action: 'CREATE',
          module: 'USERS',
          entityType: 'User',
          entityId: created.id,
          newValue: toUserView(created),
        },
        tx,
      );
      for (const roleId of input.roleIds) {
        await this.assignments.assignWithin(tx, organizationId, created.id, {
          roleId,
          companyId: null,
        });
      }
      return toUserView(created);
    });
  }

  async update(organizationId: string, id: string, input: UpdateUserInput): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(organizationId, id, tx);
      let updated: User | undefined;
      try {
        [updated] = await tx
          .update(users)
          .set({
            firstName: input.firstName ?? existing.firstName,
            lastName: input.lastName ?? existing.lastName,
            email: input.email ?? existing.email,
          })
          .where(eq(users.id, id))
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'users_email_uq'))
          throw new DuplicateError('User', 'email', input.email ?? '');
        throw err;
      }
      if (!updated) throw new Error('Update returned no row');
      const { previous, next } = shallowDiff(
        toUserView(existing) as unknown as Record<string, unknown>,
        toUserView(updated) as unknown as Record<string, unknown>,
      );
      await this.audit.record(
        {
          action: 'UPDATE',
          module: 'USERS',
          entityType: 'User',
          entityId: id,
          previousValue: previous,
          newValue: next,
        },
        tx,
      );
      return toUserView(updated);
    });
  }

  async setStatus(
    organizationId: string,
    id: string,
    input: SetUserStatusInput,
  ): Promise<UserView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(organizationId, id, tx);
      if (existing.status === input.status) return toUserView(existing);

      if (input.status !== 'ACTIVE') {
        if (RequestContext.get()?.userId === id) {
          throw new BusinessRuleError(
            ErrorCodes.FORBIDDEN,
            'You cannot deactivate your own account.',
          );
        }
        await this.assignments.assertNotLastSuperAdmin(tx, organizationId, id);
      }

      const [updated] = await tx
        .update(users)
        .set({ status: input.status, failedLoginAttempts: 0, lockedUntil: null })
        .where(eq(users.id, id))
        .returning();
      if (!updated) throw new Error('Update returned no row');

      await this.audit.record(
        {
          action: input.status === 'ACTIVE' ? 'ACTIVATE' : 'DEACTIVATE',
          module: 'USERS',
          entityType: 'User',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: updated.status },
          metadata: input.reason ? { reason: input.reason } : undefined,
        },
        tx,
      );
      return toUserView(updated);
    });
  }
}
