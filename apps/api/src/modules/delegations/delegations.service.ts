import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import {
  DELEGABLE_PERMISSIONS,
  type DelegatedGrant,
  type DelegationStatus,
  type PaginatedResult,
} from '@accounting/types';
import type {
  CreateDelegationInput,
  DecideDelegationInput,
  DelegationPolicyInput,
  ListDelegationsQuery,
  RevokeDelegationInput,
  UpdateDelegationInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  branches,
  companies,
  delegationApprovals,
  delegationPolicies,
  delegationScopes,
  delegationUsage,
  delegations,
  userRoles,
  users,
  type Delegation,
  type DelegationApproval,
  type DelegationPolicy,
  type DelegationScope,
  type DelegationUsage,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorizationCacheService } from '@/modules/rbac/authorization-cache.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';
import { SodService } from '@/modules/rbac/sod.service';
import {
  approverPermission,
  formatDelegationNumber,
  isUsable,
  missingDelegatorPermissions,
  requiredApprovals,
  validateWindow,
} from './delegation.logic';

const MODULE = 'DELEGATIONS';

export interface DelegationView extends Delegation {
  delegatorName: string;
  delegatorEmail: string;
  delegateName: string;
  delegateEmail: string;
  companyCode: string;
  companyName: string;
  scopes: Array<DelegationScope & { branchCode: string | null; branchName: string | null }>;
  approvals: Array<DelegationApproval & { approverName: string | null }>;
  /** Whether the acting user may decide it right now. */
  canApprove: boolean;
  /** True when ACTIVE and inside its window at read time. */
  inEffect: boolean;
}

/**
 * Delegated authority. Owns the lifecycle
 *   PENDING -> ACTIVE (approvals per policy) -> EXPIRED
 *          \-> REJECTED / CANCELLED          ACTIVE -> REVOKED
 * and resolves the grants a user holds in a company. Enforcement per document
 * lives in AuthorityService; both use the pure rules in delegation.logic.ts.
 */
@Injectable()
export class DelegationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly resolver: PermissionResolverService,
    private readonly sod: SodService,
    private readonly notifications: NotificationsService,
    private readonly logger: PinoLogger,
    private readonly cache: AuthorizationCacheService,
  ) {
    this.logger.setContext(DelegationsService.name);
  }

  // ------------------------------------------------------------------ policy

  async policy(organizationId: string, executor: DbExecutor = this.db): Promise<DelegationPolicy> {
    const [row] = await executor
      .select()
      .from(delegationPolicies)
      .where(eq(delegationPolicies.organizationId, organizationId));
    if (row) return row;
    return {
      id: '',
      organizationId,
      approvalPolicy: 'MANAGER_APPROVAL',
      maxDurationDays: 90,
      expiryWarningDays: 2,
      revalidateAtUse: true,
      updatedBy: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
  }

  async updatePolicy(
    actor: AuthenticatedUser,
    input: DelegationPolicyInput,
  ): Promise<DelegationPolicy> {
    return this.db.transaction(async (tx) => {
      const previous = await this.policy(actor.organizationId, tx);
      const [row] = await tx
        .insert(delegationPolicies)
        .values({ organizationId: actor.organizationId, ...input, updatedBy: actor.id })
        .onConflictDoUpdate({
          target: delegationPolicies.organizationId,
          set: { ...input, updatedBy: actor.id },
        })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'DelegationPolicy',
          entityId: row!.id,
          previousValue: {
            approvalPolicy: previous.approvalPolicy,
            maxDurationDays: previous.maxDurationDays,
          },
          newValue: input,
        },
        tx,
      );
      return row!;
    });
  }

  delegablePermissions() {
    return DELEGABLE_PERMISSIONS;
  }

  // ----------------------------------------------------------------- queries

  async list(
    actor: AuthenticatedUser,
    query: ListDelegationsQuery,
  ): Promise<PaginatedResult<DelegationView>> {
    const filters: SQL[] = [eq(delegations.organizationId, actor.organizationId)];
    if (query.status) filters.push(eq(delegations.status, query.status));
    if (query.companyId) filters.push(eq(delegations.companyId, query.companyId));
    if (query.userId)
      filters.push(
        or(
          eq(delegations.delegatorUserId, query.userId),
          eq(delegations.delegateUserId, query.userId),
        )!,
      );
    if (query.role === 'delegate') filters.push(eq(delegations.delegateUserId, actor.id));
    if (query.role === 'delegator')
      filters.push(
        or(eq(delegations.delegatorUserId, actor.id), eq(delegations.createdBy, actor.id))!,
      );
    if (query.role === 'approver') filters.push(eq(delegations.status, 'PENDING'));
    if (query.permission)
      filters.push(
        sql`exists (select 1 from delegation_scopes s where s.delegation_id = ${delegations.id} and s.permission = ${query.permission})`,
      );
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        sql`(${delegations.delegationNumber} ILIKE ${term} OR ${delegations.reason} ILIKE ${term})`,
      );
    }
    // Non-administrators (and non-auditors) only see delegations they take part in.
    if (
      !actor.permissions.has('delegation.manage') &&
      !actor.permissions.has('delegation.approve') &&
      !actor.permissions.has('audit.view')
    )
      filters.push(
        or(
          eq(delegations.delegatorUserId, actor.id),
          eq(delegations.delegateUserId, actor.id),
          eq(delegations.createdBy, actor.id),
        )!,
      );
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(delegations)
        .where(where)
        .orderBy(desc(delegations.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, delegations, where),
    ]);
    const views = await this.toViews(rows, actor);
    return toPaginatedResult(
      query.role === 'approver' ? views.filter((v) => v.canApprove) : views,
      total,
      query,
    );
  }

  async get(
    actor: AuthenticatedUser,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<DelegationView> {
    const row = await this.getRow(actor.organizationId, id, executor);
    const [view] = await this.toViews([row], actor, executor);
    const participant =
      row.delegatorUserId === actor.id ||
      row.delegateUserId === actor.id ||
      row.createdBy === actor.id;
    if (
      !participant &&
      !actor.permissions.has('delegation.manage') &&
      !actor.permissions.has('delegation.approve') &&
      !actor.permissions.has('audit.view')
    )
      throw new ForbiddenError('You are not a party to this delegation.');
    return view!;
  }

  async usage(
    actor: AuthenticatedUser,
    id: string,
  ): Promise<Array<DelegationUsage & { delegateName: string | null }>> {
    await this.get(actor, id);
    return this.db
      .select({
        ...getColumns(),
        delegateName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(delegationUsage)
      .leftJoin(users, eq(users.id, delegationUsage.delegateUserId))
      .where(eq(delegationUsage.delegationId, id))
      .orderBy(desc(delegationUsage.usedAt));
  }

  /** Active, in-window grants lent to `userId` in `companyId` (what the auth guard attaches). */
  async grantsFor(
    userId: string,
    companyId: string,
    executor: DbExecutor = this.db,
  ): Promise<DelegatedGrant[]> {
    const now = new Date();
    const rows = await executor
      .select({
        delegation: delegations,
        scope: delegationScopes,
        delegatorName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(delegations)
      .innerJoin(delegationScopes, eq(delegationScopes.delegationId, delegations.id))
      .innerJoin(users, eq(users.id, delegations.delegatorUserId))
      .where(
        and(
          eq(delegations.delegateUserId, userId),
          eq(delegations.companyId, companyId),
          eq(delegations.status, 'ACTIVE'),
          lte(delegations.startAt, now),
          gt(delegations.endAt, now),
          eq(users.status, 'ACTIVE'),
        ),
      );
    return rows.map(({ delegation, scope, delegatorName }) => ({
      delegationId: delegation.id,
      delegationNumber: delegation.delegationNumber,
      delegatorUserId: delegation.delegatorUserId,
      delegatorName,
      permission: scope.permission as DelegatedGrant['permission'],
      companyId: delegation.companyId,
      branchId: scope.branchId,
      maxAmount: scope.maxAmount,
      currency: scope.currency,
      startAt: delegation.startAt.toISOString(),
      endAt: delegation.endAt.toISOString(),
    }));
  }

  // ------------------------------------------------------------------ writes

  async create(actor: AuthenticatedUser, input: CreateDelegationInput): Promise<DelegationView> {
    const delegatorId = input.delegatorUserId ?? actor.id;
    if (delegatorId !== actor.id && !actor.permissions.has('delegation.manage'))
      throw new ForbiddenError(
        'Only administrators may create delegations on behalf of another user.',
      );
    if (delegatorId === input.delegateUserId)
      throw new BusinessRuleError(
        ErrorCodes.DELEGATION_NOT_PERMITTED,
        'A user cannot delegate authority to themselves.',
      );
    const id = await this.db.transaction(async (tx) => {
      const policy = await this.policy(actor.organizationId, tx);
      const now = new Date();
      const window = { startAt: new Date(input.startAt), endAt: new Date(input.endAt) };
      const windowError = validateWindow(window, now, policy.maxDurationDays);
      if (windowError)
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, windowError, { field: 'endAt' });

      // Sequential on purpose: one transaction client must not run queries concurrently.
      const delegator = await this.activeUser(tx, actor.organizationId, delegatorId, 'Delegator');
      const delegate = await this.activeUser(
        tx,
        actor.organizationId,
        input.delegateUserId,
        'Delegate',
      );
      const [company] = await tx
        .select()
        .from(companies)
        .where(
          and(
            eq(companies.id, input.companyId),
            eq(companies.organizationId, actor.organizationId),
          ),
        );
      if (!company) throw new NotFoundError('Company', input.companyId);

      // Rule 1 / 2: the delegator must hold every permission natively in that company (no chaining of delegations).
      const delegatorAccess = await this.resolver.resolve(delegator.id, company.id, tx);
      const requested = input.scopes.map((s) => s.permission);
      const missing = missingDelegatorPermissions(requested, delegatorAccess.permissions);
      if (missing.length)
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_NOT_PERMITTED,
          'You can only delegate permissions you hold in this company.',
          { missing },
        );

      // Rule 6: the delegate must be able to act in the company at all.
      const access = await tx
        .select({ companyId: userRoles.companyId })
        .from(userRoles)
        .where(
          and(
            eq(userRoles.userId, delegate.id),
            or(isNull(userRoles.companyId), eq(userRoles.companyId, company.id)),
          ),
        );
      if (access.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_NOT_ELIGIBLE,
          `${delegate.firstName} ${delegate.lastName} has no role in ${company.code}.`,
        );
      for (const scope of input.scopes) {
        if (scope.branchId) {
          const [branch] = await tx
            .select({ id: branches.id })
            .from(branches)
            .where(and(eq(branches.id, scope.branchId), eq(branches.companyId, company.id)));
          if (!branch) throw new NotFoundError('Branch', scope.branchId);
        }
      }

      // Rule 8: the delegate's combined authority must not violate segregation of duties.
      const delegateAccess = await this.resolver.resolve(delegate.id, company.id, tx);
      const combined = new Set([...delegateAccess.permissions, ...requested]);
      const sodWarnings = await this.sod.assertAllowed(actor.organizationId, combined, tx);

      const needed = requiredApprovals(policy.approvalPolicy);
      const status: DelegationStatus = needed === 0 ? 'ACTIVE' : 'PENDING';
      const number = await this.nextNumber(tx, actor.organizationId);
      const [row] = await tx
        .insert(delegations)
        .values({
          organizationId: actor.organizationId,
          companyId: company.id,
          delegationNumber: number,
          delegatorUserId: delegator.id,
          delegateUserId: delegate.id,
          startAt: window.startAt,
          endAt: window.endAt,
          status,
          reason: input.reason,
          requiredApprovals: needed,
          createdBy: actor.id,
          approvedAt: status === 'ACTIVE' ? now : null,
        })
        .returning();
      await tx.insert(delegationScopes).values(
        input.scopes.map((s) => ({
          delegationId: row!.id,
          permission: s.permission,
          branchId: s.branchId ?? null,
          maxAmount: s.maxAmount ?? null,
          currency: s.maxAmount ? (s.currency ?? company.baseCurrency) : null,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Delegation',
          entityId: row!.id,
          newValue: {
            delegationNumber: number,
            delegator: delegator.email,
            delegate: delegate.email,
            company: company.code,
            startAt: window.startAt,
            endAt: window.endAt,
            scopes: input.scopes,
            status,
            reason: input.reason,
          },
          metadata: {
            policy: policy.approvalPolicy,
            sodWarnings: sodWarnings.length ? sodWarnings : undefined,
          },
          companyId: company.id,
        },
        tx,
      );
      if (status === 'ACTIVE')
        await this.audit.record(
          {
            action: 'ACTIVATE',
            module: MODULE,
            entityType: 'Delegation',
            entityId: row!.id,
            newValue: { status: 'ACTIVE', via: 'SELF_SERVICE' },
            companyId: company.id,
          },
          tx,
        );
      await this.notifications.notify(
        {
          organizationId: actor.organizationId,
          eventType: 'DELEGATION_CREATED',
          title: `${number}: ${delegator.firstName} ${delegator.lastName} delegated authority to you`,
          body: input.reason,
          link: '/admin/delegations',
          entityType: 'Delegation',
          entityId: row!.id,
          userIds: [delegate.id],
        },
        tx,
      );
      if (status === 'PENDING') {
        const perm = approverPermission(policy.approvalPolicy);
        await this.notifications.notify(
          {
            organizationId: actor.organizationId,
            eventType: 'DELEGATION_APPROVAL_REQUIRED',
            severity: 'WARNING',
            title: `${number} needs your approval`,
            body: `${delegator.firstName} ${delegator.lastName} -> ${delegate.firstName} ${delegate.lastName}: ${input.reason}`,
            link: '/admin/delegations',
            entityType: 'Delegation',
            entityId: row!.id,
            permission: perm ?? undefined,
            companyId: company.id,
            dedupeKey: `delegation-approval:${row!.id}`,
          },
          tx,
        );
      }
      return row!.id;
    });
    this.cache.invalidateAll();
    return this.get(actor, id);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDelegationInput,
  ): Promise<DelegationView> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, actor.organizationId, id);
      if (row.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_INVALID_STATE,
          'Only pending delegations can be edited.',
        );
      if (
        row.delegatorUserId !== actor.id &&
        row.createdBy !== actor.id &&
        !actor.permissions.has('delegation.manage')
      )
        throw new ForbiddenError('Only the delegator may edit this delegation.');
      const policy = await this.policy(actor.organizationId, tx);
      const window = {
        startAt: input.startAt ? new Date(input.startAt) : row.startAt,
        endAt: input.endAt ? new Date(input.endAt) : row.endAt,
      };
      const windowError = validateWindow(window, new Date(), policy.maxDurationDays);
      if (windowError)
        throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, windowError, { field: 'endAt' });
      if (input.scopes) {
        const access = await this.resolver.resolve(row.delegatorUserId, row.companyId, tx);
        const missing = missingDelegatorPermissions(
          input.scopes.map((s) => s.permission),
          access.permissions,
        );
        if (missing.length)
          throw new BusinessRuleError(
            ErrorCodes.DELEGATION_NOT_PERMITTED,
            'The delegator does not hold every requested permission.',
            { missing },
          );
        const [company] = await tx
          .select({ baseCurrency: companies.baseCurrency })
          .from(companies)
          .where(eq(companies.id, row.companyId));
        await tx.delete(delegationScopes).where(eq(delegationScopes.delegationId, id));
        await tx.insert(delegationScopes).values(
          input.scopes.map((s) => ({
            delegationId: id,
            permission: s.permission,
            branchId: s.branchId ?? null,
            maxAmount: s.maxAmount ?? null,
            currency: s.maxAmount ? (s.currency ?? company!.baseCurrency) : null,
          })),
        );
      }
      await tx
        .update(delegations)
        .set({ startAt: window.startAt, endAt: window.endAt, reason: input.reason ?? row.reason })
        .where(eq(delegations.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Delegation',
          entityId: id,
          previousValue: { startAt: row.startAt, endAt: row.endAt, reason: row.reason },
          newValue: input,
          companyId: row.companyId,
        },
        tx,
      );
    });
    this.cache.invalidateAll();
    return this.get(actor, id);
  }

  /** Approve / reject under the organization policy; activates when enough distinct approvers agreed. */
  async decide(
    actor: AuthenticatedUser,
    id: string,
    input: DecideDelegationInput,
  ): Promise<DelegationView> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, actor.organizationId, id);
      if (row.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_INVALID_STATE,
          `Delegation is ${row.status.toLowerCase()}.`,
        );
      if (
        row.delegatorUserId === actor.id ||
        row.delegateUserId === actor.id ||
        row.createdBy === actor.id
      )
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'A party to the delegation cannot approve it.',
        );
      const policy = await this.policy(actor.organizationId, tx);
      const needed = approverPermission(policy.approvalPolicy);
      if (needed) {
        const access = await this.resolver.resolve(actor.id, row.companyId, tx);
        if (!access.permissions.has(needed))
          throw new BusinessRuleError(
            ErrorCodes.DELEGATION_NOT_ELIGIBLE,
            `Approving delegations requires the ${needed} permission.`,
          );
      }
      const prior = await tx
        .select()
        .from(delegationApprovals)
        .where(eq(delegationApprovals.delegationId, id));
      if (prior.some((a) => a.approverUserId === actor.id))
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_NOT_ELIGIBLE,
          'You already decided this delegation.',
        );
      await tx.insert(delegationApprovals).values({
        delegationId: id,
        approverUserId: actor.id,
        decision: input.decision,
        comment: input.comment ?? null,
      });
      const now = new Date();
      if (input.decision === 'REJECT') {
        await tx
          .update(delegations)
          .set({
            status: 'REJECTED',
            rejectedBy: actor.id,
            rejectedAt: now,
            rejectionReason: input.comment ?? null,
          })
          .where(eq(delegations.id, id));
        await this.audit.record(
          {
            action: 'REJECT',
            module: MODULE,
            entityType: 'Delegation',
            entityId: id,
            newValue: { status: 'REJECTED', comment: input.comment ?? null },
            companyId: row.companyId,
          },
          tx,
        );
        await this.notifications.notify(
          {
            organizationId: actor.organizationId,
            eventType: 'DELEGATION_REJECTED',
            severity: 'WARNING',
            title: `${row.delegationNumber} was rejected`,
            body: input.comment,
            link: '/admin/delegations',
            entityType: 'Delegation',
            entityId: id,
            userIds: [row.delegatorUserId, row.delegateUserId],
          },
          tx,
        );
        return;
      }
      const approvals = prior.filter((a) => a.decision === 'APPROVE').length + 1;
      const activate = approvals >= row.requiredApprovals;
      await tx
        .update(delegations)
        .set(activate ? { status: 'ACTIVE', approvedBy: actor.id, approvedAt: now } : {})
        .where(eq(delegations.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'Delegation',
          entityId: id,
          newValue: { approvals, required: row.requiredApprovals, comment: input.comment ?? null },
          companyId: row.companyId,
        },
        tx,
      );
      if (activate) {
        await this.audit.record(
          {
            action: 'ACTIVATE',
            module: MODULE,
            entityType: 'Delegation',
            entityId: id,
            newValue: { status: 'ACTIVE', approvedBy: actor.email },
            companyId: row.companyId,
          },
          tx,
        );
        await this.notifications.notify(
          {
            organizationId: actor.organizationId,
            eventType: 'DELEGATION_APPROVED',
            title: `${row.delegationNumber} is now active`,
            body: `Valid until ${row.endAt.toISOString()}`,
            link: '/admin/delegations',
            entityType: 'Delegation',
            entityId: id,
            userIds: [row.delegatorUserId, row.delegateUserId],
          },
          tx,
        );
      }
    });
    this.cache.invalidateAll();
    return this.get(actor, id);
  }

  async revoke(
    actor: AuthenticatedUser,
    id: string,
    input: RevokeDelegationInput,
  ): Promise<DelegationView> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, actor.organizationId, id);
      if (row.status !== 'ACTIVE' && row.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_INVALID_STATE,
          `Delegation is ${row.status.toLowerCase()}.`,
        );
      if (row.delegatorUserId !== actor.id && !actor.permissions.has('delegation.manage'))
        throw new ForbiddenError(
          'Only the delegator or an administrator may revoke this delegation.',
        );
      await tx
        .update(delegations)
        .set({
          status: 'REVOKED',
          revokedBy: actor.id,
          revokedAt: new Date(),
          revokeReason: input.reason,
        })
        .where(eq(delegations.id, id));
      await this.audit.record(
        {
          action: 'REVOKE',
          module: MODULE,
          entityType: 'Delegation',
          entityId: id,
          previousValue: { status: row.status },
          newValue: { status: 'REVOKED', reason: input.reason },
          companyId: row.companyId,
        },
        tx,
      );
      await this.notifications.notify(
        {
          organizationId: actor.organizationId,
          eventType: 'DELEGATION_REVOKED',
          severity: 'WARNING',
          title: `${row.delegationNumber} was revoked`,
          body: input.reason,
          link: '/admin/delegations',
          entityType: 'Delegation',
          entityId: id,
          userIds: [row.delegatorUserId, row.delegateUserId].filter((u) => u !== actor.id),
        },
        tx,
      );
    });
    this.cache.invalidateAll();
    return this.get(actor, id);
  }

  /** The delegator withdraws a PENDING request. */
  async cancel(actor: AuthenticatedUser, id: string): Promise<DelegationView> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, actor.organizationId, id);
      if (row.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.DELEGATION_INVALID_STATE,
          'Only pending delegations can be cancelled; revoke active ones.',
        );
      if (
        row.delegatorUserId !== actor.id &&
        row.createdBy !== actor.id &&
        !actor.permissions.has('delegation.manage')
      )
        throw new ForbiddenError('Only the delegator may cancel this delegation.');
      await tx
        .update(delegations)
        .set({ status: 'CANCELLED', cancelledAt: new Date() })
        .where(eq(delegations.id, id));
      await this.audit.record(
        {
          action: 'CANCEL',
          module: MODULE,
          entityType: 'Delegation',
          entityId: id,
          previousValue: { status: 'PENDING' },
          newValue: { status: 'CANCELLED' },
          companyId: row.companyId,
        },
        tx,
      );
    });
    this.cache.invalidateAll();
    return this.get(actor, id);
  }

  /** Scheduled: expire delegations past their end and warn ahead of expiry. Idempotent. */
  async expireDue(now = new Date()): Promise<{ expired: number; warned: number }> {
    const due = await this.db
      .select()
      .from(delegations)
      .where(and(inArray(delegations.status, ['ACTIVE', 'PENDING']), lte(delegations.endAt, now)));
    for (const row of due) {
      await this.db.transaction(async (tx) => {
        const [updated] = await tx
          .update(delegations)
          .set({ status: 'EXPIRED', expiredAt: now })
          .where(
            and(eq(delegations.id, row.id), inArray(delegations.status, ['ACTIVE', 'PENDING'])),
          )
          .returning({ id: delegations.id });
        if (!updated) return;
        await this.audit.record(
          {
            action: 'EXPIRE',
            module: MODULE,
            entityType: 'Delegation',
            entityId: row.id,
            previousValue: { status: row.status },
            newValue: { status: 'EXPIRED' },
            organizationId: row.organizationId,
            companyId: row.companyId,
          },
          tx,
        );
      });
    }
    let warned = 0;
    const policies = await this.db.select().from(delegationPolicies);
    const warnDays = new Map(policies.map((p) => [p.organizationId, p.expiryWarningDays]));
    const soonRows = await this.db
      .select()
      .from(delegations)
      .where(
        and(
          eq(delegations.status, 'ACTIVE'),
          isNull(delegations.expiryNotifiedAt),
          lte(delegations.endAt, new Date(now.getTime() + 30 * 24 * 3600 * 1000)),
        ),
      );
    for (const row of soonRows) {
      const days = warnDays.get(row.organizationId) ?? 2;
      if (days <= 0) continue;
      if (row.endAt.getTime() - now.getTime() > days * 24 * 3600 * 1000) continue;
      await this.notifications.notify({
        organizationId: row.organizationId,
        eventType: 'DELEGATION_EXPIRING',
        title: `${row.delegationNumber} expires ${row.endAt.toISOString().slice(0, 10)}`,
        link: '/admin/delegations',
        entityType: 'Delegation',
        entityId: row.id,
        userIds: [row.delegatorUserId, row.delegateUserId],
        dedupeKey: `delegation-expiring:${row.id}`,
      });
      await this.db
        .update(delegations)
        .set({ expiryNotifiedAt: now })
        .where(eq(delegations.id, row.id));
      warned += 1;
    }
    if (due.length) this.cache.invalidateAll();
    return { expired: due.length, warned };
  }

  // ----------------------------------------------------------------- helpers

  async getRow(
    organizationId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Delegation> {
    const [row] = await executor
      .select()
      .from(delegations)
      .where(and(eq(delegations.id, id), eq(delegations.organizationId, organizationId)));
    if (!row) throw new NotFoundError('Delegation', id);
    return row;
  }

  private async lock(tx: DbExecutor, organizationId: string, id: string): Promise<Delegation> {
    const [row] = await tx
      .select()
      .from(delegations)
      .where(and(eq(delegations.id, id), eq(delegations.organizationId, organizationId)))
      .for('update');
    if (!row) throw new NotFoundError('Delegation', id);
    return row;
  }

  private async activeUser(tx: DbExecutor, organizationId: string, userId: string, label: string) {
    const [user] = await tx
      .select()
      .from(users)
      .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)));
    if (!user) throw new NotFoundError(label, userId);
    if (user.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.DELEGATION_NOT_ELIGIBLE,
        `${label} ${user.email} is not active.`,
      );
    return user;
  }

  private async nextNumber(tx: DbExecutor, organizationId: string): Promise<string> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(delegations)
      .where(eq(delegations.organizationId, organizationId));
    return formatDelegationNumber(Number(row?.count ?? 0) + 1);
  }

  private async toViews(
    rows: Delegation[],
    actor: AuthenticatedUser,
    executor: DbExecutor = this.db,
  ): Promise<DelegationView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const userIds = [...new Set(rows.flatMap((r) => [r.delegatorUserId, r.delegateUserId]))];
    // Sequential: the executor may be a transaction client.
    const scopes = await executor
      .select({ scope: delegationScopes, branchCode: branches.code, branchName: branches.name })
      .from(delegationScopes)
      .leftJoin(branches, eq(branches.id, delegationScopes.branchId))
      .where(inArray(delegationScopes.delegationId, ids))
      .orderBy(asc(delegationScopes.permission));
    const approvals = await executor
      .select({
        approval: delegationApprovals,
        approverName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(delegationApprovals)
      .leftJoin(users, eq(users.id, delegationApprovals.approverUserId))
      .where(inArray(delegationApprovals.delegationId, ids));
    const people = await executor
      .select({
        id: users.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
      })
      .from(users)
      .where(inArray(users.id, userIds));
    const comps = await executor
      .select({ id: companies.id, code: companies.code, name: companies.name })
      .from(companies)
      .where(inArray(companies.id, [...new Set(rows.map((r) => r.companyId))]));

    const policy = await this.policy(actor.organizationId, executor);
    const needed = approverPermission(policy.approvalPolicy);
    const now = new Date();
    const person = (id: string) => people.find((p) => p.id === id);
    return rows.map((r) => {
      const dg = person(r.delegatorUserId);
      const de = person(r.delegateUserId);
      const company = comps.find((c) => c.id === r.companyId);
      const myApprovals = approvals.filter((a) => a.approval.delegationId === r.id);
      const party =
        r.delegatorUserId === actor.id || r.delegateUserId === actor.id || r.createdBy === actor.id;
      const canApprove =
        r.status === 'PENDING' &&
        !party &&
        (needed === null || actor.permissions.has(needed)) &&
        !myApprovals.some((a) => a.approval.approverUserId === actor.id);
      return {
        ...r,
        delegatorName: dg ? `${dg.firstName} ${dg.lastName}` : 'Unknown',
        delegatorEmail: dg?.email ?? '',
        delegateName: de ? `${de.firstName} ${de.lastName}` : 'Unknown',
        delegateEmail: de?.email ?? '',
        companyCode: company?.code ?? '',
        companyName: company?.name ?? '',
        scopes: scopes
          .filter((s) => s.scope.delegationId === r.id)
          .map((s) => ({ ...s.scope, branchCode: s.branchCode, branchName: s.branchName })),
        approvals: myApprovals.map((a) => ({ ...a.approval, approverName: a.approverName })),
        canApprove,
        inEffect: isUsable(r, now),
      };
    });
  }
}

function getColumns() {
  return {
    id: delegationUsage.id,
    delegationId: delegationUsage.delegationId,
    organizationId: delegationUsage.organizationId,
    companyId: delegationUsage.companyId,
    branchId: delegationUsage.branchId,
    delegateUserId: delegationUsage.delegateUserId,
    delegatorUserId: delegationUsage.delegatorUserId,
    permission: delegationUsage.permission,
    action: delegationUsage.action,
    documentType: delegationUsage.documentType,
    documentId: delegationUsage.documentId,
    documentNumber: delegationUsage.documentNumber,
    amount: delegationUsage.amount,
    currency: delegationUsage.currency,
    correlationId: delegationUsage.correlationId,
    usedAt: delegationUsage.usedAt,
  };
}
