import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type {
  NotificationEventType,
  NotificationSeverity,
  PaginatedResult,
} from '@accounting/types';
import type { ListNotificationsQuery, NotificationPolicyInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  notificationPolicies,
  notifications,
  permissions,
  rolePermissions,
  userRoles,
  users,
  type Notification,
  type NotificationPolicy,
} from '@/database/schema';

export interface NotifyInput {
  organizationId: string;
  eventType: NotificationEventType;
  title: string;
  body?: string;
  severity?: NotificationSeverity;
  link?: string;
  entityType?: string;
  entityId?: string;
  /** Explicit recipients... */
  userIds?: string[];
  /** ...or everyone in the organization holding one of these permissions (optionally in a company). */
  permission?: string;
  companyId?: string | null;
  /** Repeats with the same key inside the policy's throttle window are dropped. */
  dedupeKey?: string;
}

/**
 * In-app notifications with per-organization policies (enabled / throttle).
 * Throttling is what keeps a flapping integration from paging everyone every
 * minute: the same dedupe key is delivered once per window per user.
 */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationsService.name);
  }

  async notify(input: NotifyInput, executor: DbExecutor = this.db): Promise<number> {
    try {
      const policy = await this.policy(input.organizationId, input.eventType, executor);
      if (!policy.enabled) return 0;
      const recipients = new Set(input.userIds ?? []);
      if (input.permission) {
        for (const id of await this.usersWithPermission(
          input.organizationId,
          input.permission,
          input.companyId ?? null,
          executor,
        ))
          recipients.add(id);
      }
      if (recipients.size === 0) return 0;
      let suppressed = new Set<string>();
      if (input.dedupeKey && policy.throttleMinutes > 0) {
        const since = new Date(Date.now() - policy.throttleMinutes * 60_000);
        const recent = await executor
          .select({ userId: notifications.userId })
          .from(notifications)
          .where(
            and(
              inArray(notifications.userId, [...recipients]),
              eq(notifications.dedupeKey, input.dedupeKey),
              gte(notifications.createdAt, since),
            ),
          );
        suppressed = new Set(recent.map((r) => r.userId));
      }
      const targets = [...recipients].filter((id) => !suppressed.has(id));
      if (targets.length === 0) return 0;
      await executor.insert(notifications).values(
        targets.map((userId) => ({
          organizationId: input.organizationId,
          userId,
          eventType: input.eventType,
          severity: input.severity ?? 'INFO',
          title: input.title.slice(0, 200),
          body: input.body?.slice(0, 2000) ?? null,
          link: input.link ?? null,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          dedupeKey: input.dedupeKey ?? null,
        })),
      );
      return targets.length;
    } catch (err) {
      // Notifying must never fail the operation that triggered it.
      this.logger.warn({ err, eventType: input.eventType }, 'Notification delivery failed');
      return 0;
    }
  }

  async list(
    user: AuthenticatedUser,
    query: ListNotificationsQuery,
  ): Promise<PaginatedResult<Notification>> {
    const filters: SQL[] = [eq(notifications.userId, user.id)];
    if (query.unreadOnly) filters.push(isNull(notifications.readAt));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, notifications, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async unreadCount(userId: string): Promise<number> {
    return countWhere(
      this.db,
      notifications,
      and(eq(notifications.userId, userId), isNull(notifications.readAt)),
    );
  }

  async markRead(userId: string, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      );
  }

  async markAllRead(userId: string): Promise<number> {
    const rows = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return rows.length;
  }

  // ---------------------------------------------------------------- policies

  async listPolicies(organizationId: string): Promise<NotificationPolicy[]> {
    return this.db
      .select()
      .from(notificationPolicies)
      .where(eq(notificationPolicies.organizationId, organizationId));
  }

  async upsertPolicy(
    actor: AuthenticatedUser,
    eventType: NotificationEventType,
    input: NotificationPolicyInput,
  ): Promise<NotificationPolicy> {
    const [row] = await this.db
      .insert(notificationPolicies)
      .values({ organizationId: actor.organizationId, eventType, ...input })
      .onConflictDoUpdate({
        target: [notificationPolicies.organizationId, notificationPolicies.eventType],
        set: { enabled: input.enabled, throttleMinutes: input.throttleMinutes },
      })
      .returning();
    return row!;
  }

  private async policy(
    organizationId: string,
    eventType: string,
    executor: DbExecutor,
  ): Promise<{ enabled: boolean; throttleMinutes: number }> {
    const [row] = await executor
      .select({
        enabled: notificationPolicies.enabled,
        throttleMinutes: notificationPolicies.throttleMinutes,
      })
      .from(notificationPolicies)
      .where(
        and(
          eq(notificationPolicies.organizationId, organizationId),
          eq(notificationPolicies.eventType, eventType),
        ),
      );
    return row ?? { enabled: true, throttleMinutes: 60 };
  }

  /** Active users holding `permission` organization-wide or in `companyId`. */
  async usersWithPermission(
    organizationId: string,
    permission: string,
    companyId: string | null,
    executor: DbExecutor = this.db,
  ): Promise<string[]> {
    const rows = await executor
      .selectDistinct({ id: users.id })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
      .innerJoin(permissions, eq(permissions.id, rolePermissions.permissionId))
      .where(
        and(
          eq(users.organizationId, organizationId),
          eq(users.status, 'ACTIVE'),
          eq(permissions.key, permission),
          companyId
            ? sql`(${userRoles.companyId} IS NULL OR ${userRoles.companyId} = ${companyId})`
            : sql`${userRoles.companyId} IS NULL`,
        ),
      );
    return rows.map((r) => r.id);
  }
}
