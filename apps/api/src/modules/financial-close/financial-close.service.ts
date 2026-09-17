import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  type CloseAutoCheck,
  type CloseStatus,
  type CloseTaskStatus,
  type CloseType,
  type PaginatedResult,
  type ReconciliationArea,
} from '@accounting/types';
import type {
  AddCloseTaskInput,
  CloseDecisionInput,
  ListClosesQuery,
  StartCloseInput,
  UpdateCloseTaskInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  bankReconciliations,
  bankStatements,
  closeTasks,
  depreciationRuns,
  financialCloses,
  fiscalPeriods,
  fixedAssets,
  fxRevaluations,
  journalEntries,
  reconciliationExceptions,
  reconciliations,
  revenueScheduleLines,
  revenueSchedules,
  users,
  type AccountingPolicy,
  type CloseTask,
  type FinancialClose,
  type FiscalPeriod,
} from '@/database/schema';
import { FiscalPeriodsService } from '@/modules/accounting/fiscal/fiscal-periods.service';
import { IntegrityService } from '@/modules/accounting/integrity/integrity.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ReconciliationsService } from '@/modules/reconciliation/reconciliations.service';
import { SuspenseService } from '@/modules/accounting/suspense/suspense.service';
import { ReportingService } from '@/modules/reporting/reporting.service';

const MODULE = 'FINANCIAL_CLOSE';

export interface CloseBlocker {
  key: string;
  message: string;
  /** Blocking (policy says it must pass) or informational. */
  blocking: boolean;
  detail?: Record<string, unknown>;
}

export interface CloseTaskView extends CloseTask {
  ownerName: string | null;
  reviewerName: string | null;
  completedByName: string | null;
}

export interface CloseView extends FinancialClose {
  periodName: string;
  periodStatus: FiscalPeriod['status'];
  periodStart: string;
  periodEnd: string;
  startedByName: string | null;
  approvedByName: string | null;
  completedByName: string | null;
  taskCount: number;
  doneCount: number;
  /** 0-100 over required tasks. */
  progress: number;
}

export interface CloseDetail extends CloseView {
  tasks: CloseTaskView[];
  blockers: CloseBlocker[];
}

/** The checklist every close starts with; companies add manual tasks on top. */
/** Statuses of a close that still owns its period (a period has at most one). */
const LIVE_STATUSES: CloseStatus[] = ['IN_PROGRESS', 'READY', 'APPROVED'];

const TEMPLATE: Array<{
  key: string;
  title: string;
  kind: 'AUTO' | 'MANUAL';
  required: boolean;
  types?: CloseType[];
}> = [
  { key: 'BANK_RECONCILIATION', title: 'Bank reconciliation', kind: 'AUTO', required: true },
  { key: 'AR_RECONCILIATION', title: 'AR reconciliation approved', kind: 'AUTO', required: true },
  { key: 'AP_RECONCILIATION', title: 'AP reconciliation approved', kind: 'AUTO', required: true },
  {
    key: 'INVENTORY_RECONCILIATION',
    title: 'Inventory reconciliation approved',
    kind: 'AUTO',
    required: true,
  },
  {
    key: 'FIXED_ASSET_RECONCILIATION',
    title: 'Fixed asset reconciliation approved',
    kind: 'AUTO',
    required: true,
  },
  {
    key: 'DEPRECIATION',
    title: 'Depreciation posted for the period',
    kind: 'AUTO',
    required: true,
  },
  { key: 'MANUAL_ACCRUALS', title: 'Accruals reviewed and posted', kind: 'MANUAL', required: true },
  { key: 'MANUAL_PREPAYMENTS', title: 'Prepayments recognised', kind: 'MANUAL', required: true },
  { key: 'FX_REVALUATION', title: 'FX revaluation run', kind: 'AUTO', required: false },
  {
    key: 'REVENUE_RECOGNITION',
    title: 'Deferred revenue recognized',
    kind: 'AUTO',
    required: true,
  },
  { key: 'TAX_RECONCILIATION', title: 'Tax reconciliation approved', kind: 'AUTO', required: true },
  {
    key: 'MANUAL_INTERCOMPANY',
    title: 'Intercompany balances confirmed',
    kind: 'MANUAL',
    required: false,
  },
  {
    key: 'SUSPENSE_BALANCES',
    title: 'Suspense balances within policy',
    kind: 'AUTO',
    required: true,
  },
  { key: 'MANUAL_SUSPENSE', title: 'Suspense account review', kind: 'MANUAL', required: true },
  {
    key: 'UNAPPROVED_JOURNALS',
    title: 'No unposted journals in the period',
    kind: 'AUTO',
    required: true,
  },
  {
    key: 'OPEN_RECONCILIATION_EXCEPTIONS',
    title: 'No open reconciliation exceptions',
    kind: 'AUTO',
    required: true,
  },
  { key: 'TRIAL_BALANCE', title: 'Trial balance balances', kind: 'AUTO', required: true },
  { key: 'INTEGRITY', title: 'Financial integrity checks pass', kind: 'AUTO', required: true },
  {
    key: 'MANUAL_STATEMENT_REVIEW',
    title: 'Financial statement review',
    kind: 'MANUAL',
    required: true,
  },
  {
    key: 'MANUAL_YEAR_END_ADJUSTMENTS',
    title: 'Year-end adjustments and audit schedules',
    kind: 'MANUAL',
    required: true,
    types: ['YEAR'],
  },
];

const AREA_OF: Partial<Record<string, ReconciliationArea>> = {
  AR_RECONCILIATION: 'AR',
  AP_RECONCILIATION: 'AP',
  INVENTORY_RECONCILIATION: 'INVENTORY',
  FIXED_ASSET_RECONCILIATION: 'FIXED_ASSETS',
  TAX_RECONCILIATION: 'TAX',
};

/**
 * Financial close: a checklist per period whose automatic tasks are evaluated
 * from the ledger and the reconciliation records, whose blockers follow the
 * company policy, and whose completion is the only path that closes (and
 * optionally locks) the period from the close workflow. Nothing here posts.
 */
@Injectable()
export class FinancialCloseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly periods: FiscalPeriodsService,
    private readonly recon: ReconciliationsService,
    private readonly integrity: IntegrityService,
    private readonly suspense: SuspenseService,
    private readonly reports: ReportingService,
  ) {}

  // ------------------------------------------------------------------- reads

  async list(companyId: string, query: ListClosesQuery): Promise<PaginatedResult<CloseView>> {
    const filters: SQL[] = [eq(financialCloses.companyId, companyId)];
    if (query.status) filters.push(eq(financialCloses.status, query.status));
    if (query.closeType) filters.push(eq(financialCloses.closeType, query.closeType));
    const where = and(...filters);
    const [rows, [count]] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(desc(fiscalPeriods.startDate), desc(financialCloses.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(financialCloses)
        .where(where),
    ]);
    return toPaginatedResult(rows.map(toView), count?.total ?? 0, query);
  }

  async get(companyId: string, id: string): Promise<CloseDetail> {
    const [row] = await this.viewQuery().where(
      and(eq(financialCloses.id, id), eq(financialCloses.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Financial close', id);
    const tasks = await this.tasks(id);
    return { ...toView(row), tasks, blockers: (row.row.blockers as CloseBlocker[]) ?? [] };
  }

  /** Evaluates the blockers for a period without a close record (used by the dashboard and period page). */
  async blockersFor(companyId: string, fiscalPeriodId: string): Promise<CloseBlocker[]> {
    const period = await this.periods.getPeriodOrThrow(companyId, fiscalPeriodId);
    const policy = await this.recon.policy(companyId);
    const checks = await this.evaluateChecks(companyId, period);
    return blockersFrom(checks, policy);
  }

  // ---------------------------------------------------------------- commands

  async start(
    companyId: string,
    actor: AuthenticatedUser,
    input: StartCloseInput,
  ): Promise<CloseDetail> {
    const period = await this.periods.getPeriodOrThrow(companyId, input.fiscalPeriodId);
    if (period.status === 'CLOSED' || period.status === 'LOCKED')
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNTING_PERIOD_CLOSED,
        `${period.name} is already ${period.status.toLowerCase()}.`,
      );
    const id = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: financialCloses.id })
        .from(financialCloses)
        .where(
          and(
            eq(financialCloses.fiscalPeriodId, period.id),
            inArray(financialCloses.status, LIVE_STATUSES),
          ),
        );
      if (existing) throw new DuplicateError('Financial close', 'period', period.name);
      const [created] = await tx
        .insert(financialCloses)
        .values({
          companyId,
          fiscalPeriodId: period.id,
          closeType: input.closeType,
          startedBy: actor.id,
        })
        .returning({ id: financialCloses.id });
      const template = TEMPLATE.filter((t) => !t.types || t.types.includes(input.closeType));
      await tx.insert(closeTasks).values(
        template.map((t, i) => ({
          closeId: created!.id,
          companyId,
          sequence: i + 1,
          key: t.key,
          title: t.title,
          kind: t.kind,
          required: t.required,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'FinancialClose',
          entityId: created!.id,
          newValue: { period: period.name, closeType: input.closeType, tasks: template.length },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.refresh(companyId, actor, id);
  }

  /** Re-evaluates every automatic task and the blockers; moves between IN_PROGRESS and READY. */
  async refresh(
    companyId: string,
    actor: AuthenticatedUser | null,
    id: string,
  ): Promise<CloseDetail> {
    const close = await this.lock(companyId, id);
    if (close.status === 'COMPLETED' || close.status === 'CANCELLED')
      return this.get(companyId, id);
    const period = await this.periods.getPeriodOrThrow(companyId, close.fiscalPeriodId);
    const policy = await this.recon.policy(companyId);
    const checks = await this.evaluateChecks(companyId, period);
    const blockers = blockersFrom(checks, policy);
    await this.db.transaction(async (tx) => {
      const tasks = await tx.select().from(closeTasks).where(eq(closeTasks.closeId, id));
      for (const task of tasks) {
        if (task.kind !== 'AUTO') continue;
        const check = checks.find((c) => c.key === task.key);
        if (!check) continue;
        const status: CloseTaskStatus = check.passed
          ? 'DONE'
          : check.blocking
            ? 'BLOCKED'
            : 'PENDING';
        await tx
          .update(closeTasks)
          .set({
            status,
            required: check.required,
            detail: check.detail,
            completedAt: check.passed ? (task.completedAt ?? new Date()) : null,
            completedBy: check.passed ? (task.completedBy ?? actor?.id ?? null) : null,
          })
          .where(eq(closeTasks.id, task.id));
      }
      const after = await tx.select().from(closeTasks).where(eq(closeTasks.closeId, id));
      const ready = isReady(after, blockers);
      const status: CloseStatus =
        close.status === 'APPROVED'
          ? ready
            ? 'APPROVED'
            : 'IN_PROGRESS'
          : ready
            ? 'READY'
            : 'IN_PROGRESS';
      await tx
        .update(financialCloses)
        .set({
          blockers,
          evaluatedAt: new Date(),
          status,
          ...(status !== 'APPROVED' && close.status === 'APPROVED'
            ? { approvedBy: null, approvedAt: null }
            : {}),
        })
        .where(eq(financialCloses.id, id));
      if (close.status === 'APPROVED' && status !== 'APPROVED')
        await this.audit.record(
          {
            action: 'UPDATE',
            module: MODULE,
            entityType: 'FinancialClose',
            entityId: id,
            previousValue: { status: 'APPROVED' },
            newValue: { status, reason: 'approval withdrawn: checks regressed' },
            metadata: { actor: actor?.email ?? 'system' },
            companyId,
          },
          tx,
        );
    });
    return this.get(companyId, id);
  }

  async updateTask(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    taskId: string,
    input: UpdateCloseTaskInput,
  ): Promise<CloseDetail> {
    await this.db.transaction(async (tx) => {
      const close = await this.lock(companyId, id, tx);
      if (close.status === 'COMPLETED' || close.status === 'CANCELLED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `The close is ${close.status.toLowerCase()}.`,
        );
      const [task] = await tx
        .select()
        .from(closeTasks)
        .where(and(eq(closeTasks.id, taskId), eq(closeTasks.closeId, id)))
        .for('update');
      if (!task) throw new NotFoundError('Close task', taskId);
      if (task.kind === 'AUTO' && input.status)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Automatic tasks are evaluated by the system; refresh the close instead.',
        );
      if (input.status === 'SKIPPED' && task.required && !input.reason?.trim())
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Skipping a required task needs a reason.',
        );
      const status = input.status ?? task.status;
      await tx
        .update(closeTasks)
        .set({
          status,
          ownerId: input.ownerId === undefined ? task.ownerId : input.ownerId,
          reviewerId: input.reviewerId === undefined ? task.reviewerId : input.reviewerId,
          notes: input.notes === undefined ? task.notes : input.notes,
          skipReason: input.status === 'SKIPPED' ? (input.reason ?? null) : task.skipReason,
          startedAt: task.startedAt ?? (status !== 'PENDING' ? new Date() : null),
          completedAt:
            status === 'DONE' || status === 'SKIPPED' ? (task.completedAt ?? new Date()) : null,
          completedBy: status === 'DONE' || status === 'SKIPPED' ? actor.id : null,
        })
        .where(eq(closeTasks.id, taskId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CloseTask',
          entityId: taskId,
          previousValue: { status: task.status },
          newValue: { status, reason: input.reason, notes: input.notes },
          metadata: { actor: actor.email, closeId: id, task: task.title },
          companyId,
        },
        tx,
      );
    });
    return this.refresh(companyId, actor, id);
  }

  async addTask(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: AddCloseTaskInput,
  ): Promise<CloseDetail> {
    await this.db.transaction(async (tx) => {
      const close = await this.lock(companyId, id, tx);
      if (close.status === 'COMPLETED' || close.status === 'CANCELLED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `The close is ${close.status.toLowerCase()}.`,
        );
      const [agg] = await tx
        .select({ max: sql<number>`coalesce(max(${closeTasks.sequence}), 0)::int` })
        .from(closeTasks)
        .where(eq(closeTasks.closeId, id));
      const next = (agg?.max ?? 0) + 1;
      const key = `MANUAL_${input.title
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .slice(0, 40)}_${next}`;
      await tx.insert(closeTasks).values({
        closeId: id,
        companyId,
        sequence: next,
        key,
        title: input.title,
        kind: 'MANUAL',
        required: input.required,
        ownerId: input.ownerId ?? null,
      });
    });
    return this.refresh(companyId, actor, id);
  }

  /** Management approval: every required task done or skipped with a reason, and no blocking blocker. */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CloseDecisionInput,
  ): Promise<CloseDetail> {
    const fresh = await this.refresh(companyId, actor, id);
    if (fresh.status === 'COMPLETED' || fresh.status === 'CANCELLED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `The close is ${fresh.status.toLowerCase()}.`,
      );
    const blocking = fresh.blockers.filter((b) => b.blocking);
    const pending = fresh.tasks.filter(
      (t) => t.required && t.status !== 'DONE' && t.status !== 'SKIPPED',
    );
    if (blocking.length || pending.length)
      throw new BusinessRuleError(ErrorCodes.CLOSE_BLOCKED, 'The close cannot be approved yet.', {
        blockers: blocking.map((b) => b.message),
        pendingTasks: pending.map((t) => t.title),
      });
    await this.db.transaction(async (tx) => {
      await tx
        .update(financialCloses)
        .set({
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          approvalNotes: input.notes ?? null,
        })
        .where(eq(financialCloses.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'FinancialClose',
          entityId: id,
          previousValue: { status: fresh.status },
          newValue: { status: 'APPROVED', notes: input.notes },
          metadata: { actor: actor.email, period: fresh.periodName },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Completion closes the period through the fiscal-period service (which
   * re-checks sequence and unposted entries), closes the year for a YEAR
   * close, and locks the period when the policy says so.
   */
  async complete(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CloseDecisionInput,
  ): Promise<CloseDetail> {
    const fresh = await this.refresh(companyId, actor, id);
    if (fresh.status !== 'APPROVED')
      throw new BusinessRuleError(
        ErrorCodes.CLOSE_BLOCKED,
        'The close needs management approval before the period can be closed.',
        { status: fresh.status },
      );
    const policy = await this.recon.policy(companyId);
    const period = await this.periods.getPeriodOrThrow(companyId, fresh.fiscalPeriodId);
    if (period.status === 'OPEN' || period.status === 'SOFT_CLOSED')
      await this.periods.closePeriod(
        companyId,
        period.id,
        actor.id,
        input.notes ?? `Financial close ${fresh.periodName}`,
      );
    if (fresh.closeType === 'YEAR')
      await this.periods.closeYear(companyId, period.fiscalYearId, actor);
    if (policy.closeLockOnComplete)
      await this.periods.lockPeriod(
        companyId,
        period.id,
        actor.id,
        `Locked by financial close ${fresh.periodName}`,
      );
    await this.db.transaction(async (tx) => {
      await tx
        .update(financialCloses)
        .set({ status: 'COMPLETED', completedBy: actor.id, completedAt: new Date() })
        .where(eq(financialCloses.id, id));
      await this.audit.record(
        {
          action: 'PERIOD_CLOSE',
          module: MODULE,
          entityType: 'FinancialClose',
          entityId: id,
          previousValue: { status: 'APPROVED' },
          newValue: {
            status: 'COMPLETED',
            locked: policy.closeLockOnComplete,
            closeType: fresh.closeType,
          },
          metadata: { actor: actor.email, period: fresh.periodName },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: { reason: string },
  ): Promise<CloseDetail> {
    await this.db.transaction(async (tx) => {
      const close = await this.lock(companyId, id, tx);
      if (close.status === 'COMPLETED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'A completed close cannot be cancelled; reopen the period instead.',
        );
      await tx
        .update(financialCloses)
        .set({ status: 'CANCELLED', cancelledAt: new Date(), cancelReason: input.reason })
        .where(eq(financialCloses.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'FinancialClose',
          entityId: id,
          previousValue: { status: close.status },
          newValue: { status: 'CANCELLED', reason: input.reason },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // ------------------------------------------------------------------ checks

  private async evaluateChecks(companyId: string, period: FiscalPeriod): Promise<CheckResult[]> {
    const end = period.endDate;
    const results: CheckResult[] = [];
    const push = (
      key: CloseAutoCheck,
      passed: boolean,
      message: string,
      detail: Record<string, unknown> = {},
    ) => results.push({ key, passed, message, detail, blocking: false, required: true });

    // Approved subledger reconciliations as of the period end.
    const approved = await this.db
      .select({
        area: reconciliations.area,
        status: reconciliations.status,
        variance: reconciliations.variance,
      })
      .from(reconciliations)
      .where(and(eq(reconciliations.companyId, companyId), eq(reconciliations.asOf, end)));
    for (const [key, area] of Object.entries(AREA_OF) as [CloseAutoCheck, ReconciliationArea][]) {
      const rec = approved.find((r) => r.area === area);
      push(
        key,
        rec?.status === 'APPROVED',
        rec
          ? `${area} reconciliation as of ${end} is ${rec.status.replace('_', ' ').toLowerCase()}`
          : `${area} reconciliation as of ${end} has not been run`,
        { status: rec?.status ?? null, variance: rec?.variance ?? null },
      );
    }

    // Bank: every active account needs a COMPLETED reconciliation on a statement dated in the period.
    const banks = await this.db
      .select({ id: bankAccounts.id, code: bankAccounts.code })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.status, 'ACTIVE')));
    const missing: string[] = [];
    for (const b of banks) {
      const [done] = await this.db
        .select({ id: bankReconciliations.id })
        .from(bankReconciliations)
        .innerJoin(bankStatements, eq(bankStatements.id, bankReconciliations.statementId))
        .where(
          and(
            eq(bankReconciliations.bankAccountId, b.id),
            eq(bankReconciliations.status, 'COMPLETED'),
            gte(bankStatements.statementDate, period.startDate),
            lte(bankStatements.statementDate, end),
          ),
        )
        .limit(1);
      if (!done) missing.push(b.code);
    }
    push(
      'BANK_RECONCILIATION',
      missing.length === 0,
      missing.length
        ? `Bank accounts without a completed reconciliation in ${period.name}: ${missing.join(', ')}`
        : `Every bank account reconciled for ${period.name}`,
      { missing },
    );

    // Depreciation: a POSTED run for the period, unless no asset was in service by its end.
    const [activeAssets] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(fixedAssets)
      .where(
        and(
          eq(fixedAssets.companyId, companyId),
          eq(fixedAssets.status, 'ACTIVE'),
          lte(fixedAssets.inServiceDate, end),
        ),
      );
    const [run] = await this.db
      .select({ id: depreciationRuns.id })
      .from(depreciationRuns)
      .where(
        and(
          eq(depreciationRuns.companyId, companyId),
          eq(depreciationRuns.fiscalPeriodId, period.id),
          eq(depreciationRuns.status, 'POSTED'),
        ),
      )
      .limit(1);
    push(
      'DEPRECIATION',
      Boolean(run) || (activeAssets?.n ?? 0) === 0,
      run
        ? `Depreciation posted for ${period.name}`
        : (activeAssets?.n ?? 0) === 0
          ? 'No depreciating assets'
          : `No posted depreciation run for ${period.name} (${activeAssets?.n} active asset(s))`,
      { activeAssets: activeAssets?.n ?? 0, posted: Boolean(run) },
    );

    // FX revaluation as of the period end (informational unless policy requires it).
    const [fx] = await this.db
      .select({ id: fxRevaluations.id })
      .from(fxRevaluations)
      .where(and(eq(fxRevaluations.companyId, companyId), eq(fxRevaluations.asOfDate, end)))
      .limit(1);
    push(
      'FX_REVALUATION',
      Boolean(fx),
      fx ? `FX revaluation run as of ${end}` : `No FX revaluation as of ${end}`,
    );

    // Deferred revenue due by the period end that no recognition run has posted (Prompt #10).
    const [dueRevenue] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        amount: sql<string>`coalesce(sum(${revenueScheduleLines.amount}), 0)`,
      })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueSchedules.status, 'ACTIVE'),
          eq(revenueScheduleLines.status, 'PENDING'),
          lte(revenueScheduleLines.recognitionDate, end),
          sql`(${revenueSchedules.method} <> 'MILESTONE' or ${revenueScheduleLines.completedAt} is not null)`,
        ),
      );
    push(
      'REVENUE_RECOGNITION',
      (dueRevenue?.n ?? 0) === 0,
      dueRevenue?.n
        ? `${dueRevenue.n} deferred revenue line(s) due by ${end} (${dueRevenue.amount}) await a recognition run`
        : `Deferred revenue due by ${end} is recognized`,
      { pendingLines: dueRevenue?.n ?? 0, pendingAmount: dueRevenue?.amount ?? '0' },
    );

    // Journals still in draft / submitted / approved inside the period.
    const unposted = await this.db
      .select({ documentNumber: journalEntries.documentNumber, status: journalEntries.status })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.fiscalPeriodId, period.id),
          inArray(journalEntries.status, ['DRAFT', 'SUBMITTED', 'APPROVED']),
        ),
      )
      .limit(20);
    push(
      'UNAPPROVED_JOURNALS',
      unposted.length === 0,
      unposted.length
        ? `${unposted.length} journal(s) not yet posted in ${period.name}`
        : 'No unposted journals',
      { entries: unposted },
    );

    // Open exceptions on any reconciliation dated in or before the period end.
    const [openExc] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reconciliationExceptions)
      .innerJoin(reconciliations, eq(reconciliations.id, reconciliationExceptions.reconciliationId))
      .where(
        and(
          eq(reconciliationExceptions.companyId, companyId),
          eq(reconciliationExceptions.status, 'OPEN'),
          lte(reconciliations.asOf, end),
        ),
      );
    push(
      'OPEN_RECONCILIATION_EXCEPTIONS',
      (openExc?.n ?? 0) === 0,
      openExc?.n
        ? `${openExc.n} open reconciliation exception(s)`
        : 'No open reconciliation exceptions',
      { open: openExc?.n ?? 0 },
    );

    const suspense = await this.suspense.monitor(companyId, end);
    const flagged = suspense.accounts.filter((a) => a.status === 'REQUIRES_INVESTIGATION');
    push(
      'SUSPENSE_BALANCES',
      flagged.length === 0,
      flagged.length
        ? `Suspense balances requiring investigation: ${flagged.map((a) => `${a.code} (${a.balance}, ${a.ageDays}d)`).join(', ')}`
        : 'Suspense balances within policy',
      {
        totalBalance: suspense.totalBalance,
        accounts: flagged.map((a) => ({ code: a.code, balance: a.balance, ageDays: a.ageDays })),
      },
    );

    const tb = await this.reports.trialBalance(companyId, {
      from: period.startDate,
      to: end,
      includeZero: false,
    });
    push(
      'TRIAL_BALANCE',
      tb.balanced,
      tb.balanced ? 'Trial balance balances' : 'Trial balance does not balance',
      { debit: tb.totals.closingDebit, credit: tb.totals.closingCredit },
    );

    const integrity = await this.integrity.run(companyId, end);
    const failing = integrity.findings.filter((f) => f.count > 0 && f.severity === 'CRITICAL');
    push(
      'INTEGRITY',
      failing.length === 0,
      failing.length
        ? `Integrity checks failing: ${failing.map((f) => f.check).join(', ')}`
        : 'Integrity checks pass',
      { failing: failing.map((f) => f.check) },
    );
    return results;
  }

  // ----------------------------------------------------------------- helpers

  private async lock(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<FinancialClose> {
    const q = executor
      .select()
      .from(financialCloses)
      .where(and(eq(financialCloses.id, id), eq(financialCloses.companyId, companyId)));
    const [row] = executor === this.db ? await q : await q.for('update');
    if (!row) throw new NotFoundError('Financial close', id);
    return row;
  }

  private async tasks(closeId: string): Promise<CloseTaskView[]> {
    const name = (col: PgColumn) =>
      sql<string | null>`(select first_name || ' ' || last_name from users u where u.id = ${col})`;
    const rows = await this.db
      .select({
        row: closeTasks,
        ownerName: name(closeTasks.ownerId),
        reviewerName: name(closeTasks.reviewerId),
        completedByName: name(closeTasks.completedBy),
      })
      .from(closeTasks)
      .where(eq(closeTasks.closeId, closeId))
      .orderBy(asc(closeTasks.sequence));
    return rows.map((r) => ({
      ...r.row,
      ownerName: r.ownerName,
      reviewerName: r.reviewerName,
      completedByName: r.completedByName,
    }));
  }

  private viewQuery() {
    const name = (col: PgColumn) =>
      sql<
        string | null
      >`(select first_name || ' ' || last_name from ${users} u where u.id = ${col})`;
    return this.db
      .select({
        row: financialCloses,
        periodName: fiscalPeriods.name,
        periodStatus: fiscalPeriods.status,
        periodStart: fiscalPeriods.startDate,
        periodEnd: fiscalPeriods.endDate,
        startedByName: name(financialCloses.startedBy),
        approvedByName: name(financialCloses.approvedBy),
        completedByName: name(financialCloses.completedBy),
        taskCount: sql<number>`(select count(*)::int from close_tasks t where t.close_id = ${financialCloses.id} and t.required)`,
        doneCount: sql<number>`(select count(*)::int from close_tasks t where t.close_id = ${financialCloses.id} and t.required and t.status in ('DONE','SKIPPED'))`,
      })
      .from(financialCloses)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, financialCloses.fiscalPeriodId));
  }
}

interface CheckResult {
  key: CloseAutoCheck;
  passed: boolean;
  blocking: boolean;
  /** Policy says this check must pass (drives the task's required flag). */
  required: boolean;
  message: string;
  detail: Record<string, unknown>;
}

/** Applies the company policy: a failed check blocks only when the policy says it must pass. */
function blockersFrom(checks: CheckResult[], policy: AccountingPolicy): CloseBlocker[] {
  const must: Record<CloseAutoCheck, boolean> = {
    BANK_RECONCILIATION: policy.closeRequireBankReconciliation,
    AR_RECONCILIATION: policy.closeRequireReconciliations,
    AP_RECONCILIATION: policy.closeRequireReconciliations,
    INVENTORY_RECONCILIATION: policy.closeRequireReconciliations,
    FIXED_ASSET_RECONCILIATION: policy.closeRequireReconciliations,
    TAX_RECONCILIATION: policy.closeRequireReconciliations,
    DEPRECIATION: policy.closeRequireDepreciation,
    FX_REVALUATION: policy.closeRequireFxRevaluation,
    REVENUE_RECOGNITION: policy.closeRequireRevenueRecognition,
    UNAPPROVED_JOURNALS: policy.closeBlockOnUnapprovedJournals,
    OPEN_RECONCILIATION_EXCEPTIONS: policy.closeBlockOnOpenExceptions,
    TRIAL_BALANCE: true,
    INTEGRITY: policy.closeRequireIntegrityOk,
    SUSPENSE_BALANCES: policy.closeBlockOnSuspense,
  };
  for (const c of checks) {
    c.required = must[c.key];
    c.blocking = !c.passed && c.required;
  }
  return checks
    .filter((c) => !c.passed)
    .map((c) => ({ key: c.key, message: c.message, blocking: c.blocking, detail: c.detail }));
}

function isReady(tasks: CloseTask[], blockers: CloseBlocker[]): boolean {
  if (blockers.some((b) => b.blocking)) return false;
  return tasks.every((t) => !t.required || t.status === 'DONE' || t.status === 'SKIPPED');
}

type ViewRow = {
  row: FinancialClose;
  periodName: string;
  periodStatus: FiscalPeriod['status'];
  periodStart: string;
  periodEnd: string;
  startedByName: string | null;
  approvedByName: string | null;
  completedByName: string | null;
  taskCount: number;
  doneCount: number;
};

function toView(r: ViewRow): CloseView {
  const { blockers: _b, ...rest } = r.row;
  return {
    ...rest,
    blockers: [],
    periodName: r.periodName,
    periodStatus: r.periodStatus,
    periodStart: r.periodStart,
    periodEnd: r.periodEnd,
    startedByName: r.startedByName,
    approvedByName: r.approvedByName,
    completedByName: r.completedByName,
    taskCount: r.taskCount,
    doneCount: r.doneCount,
    progress: r.taskCount ? Math.round((r.doneCount / r.taskCount) * 100) : 0,
  };
}
