import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { Money } from '@accounting/money';
import type { PaginatedResult, RevenueMilestone } from '@accounting/types';
import type { CompleteMilestoneInput, ListRevenueSchedulesQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  customers,
  invoices,
  journalEntries,
  revenuePolicies,
  revenueRecognitionRuns,
  revenueScheduleLines,
  revenueSchedules,
  type RevenueSchedule,
  type RevenueScheduleLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';
import { businessToday } from '@/common/time/clock';
import { RevenueConfigService } from './revenue-config.service';
import { buildSchedule } from './revenue.logic';

const MODULE = 'REVENUE';

/** An invoice line as the posting routine sees it (amounts already in base currency). */
export interface DeferrableLine {
  id: string;
  lineNumber: number;
  description: string;
  accountId: string;
  /** Net line amount in base currency. */
  amount: string;
  productId: string | null;
  revenuePolicyId: string | null;
  serviceStartDate: string | null;
  serviceEndDate: string | null;
  milestones: RevenueMilestone[];
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
}

export interface DeferralPlan {
  /** Invoice line id -> account the posting credits instead of the line's revenue account. */
  deferredAccountByLine: Map<string, string>;
  scheduleIds: string[];
}

export interface RevenueScheduleView extends RevenueSchedule {
  documentNumber: string;
  documentDate: string;
  customerCode: string;
  customerName: string;
  policyCode: string;
  policyName: string;
  deferredAccountCode: string;
  revenueAccountCode: string;
  remainingAmount: string;
  /** Earliest pending recognition date (null when only undated milestones remain). */
  nextRecognitionDate: string | null;
}

export interface RevenueScheduleLineView extends RevenueScheduleLine {
  runNumber: string | null;
  journalNumber: string | null;
}

export interface RevenueScheduleDetail extends RevenueScheduleView {
  lines: RevenueScheduleLineView[];
}

/**
 * Deferred revenue schedules (Prompt #10). `deferInvoiceLines` runs inside
 * the invoice posting transaction: it decides which lines defer, builds
 * their schedules and tells the posting which account to credit. From then
 * on the schedule is the subledger of the DEFERRED_REVENUE account - every
 * movement of that account is a schedule line posted by a recognition run
 * (or the void reversal of the whole invoice).
 */
@Injectable()
export class RevenueSchedulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly config: RevenueConfigService,
  ) {}

  // ------------------------------------------------------------- posting hook

  /**
   * Draft-time check (create / update): every line's policy resolves and
   * its schedule can be built, so a bad service window or milestone split
   * is refused when the line is entered rather than when the invoice posts.
   */
  async validateDraftLines(
    tx: DbExecutor,
    companyId: string,
    documentType: string,
    documentDate: string,
    lines: ReadonlyArray<
      Pick<
        DeferrableLine,
        | 'lineNumber'
        | 'revenuePolicyId'
        | 'productId'
        | 'serviceStartDate'
        | 'serviceEndDate'
        | 'milestones'
      >
    >,
  ): Promise<void> {
    if (documentType !== 'INVOICE') {
      if (lines.some((l) => l.revenuePolicyId || l.milestones.length > 0))
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          'Only invoices can defer revenue; credit and debit notes hit revenue directly.',
        );
      return;
    }
    const keyed = lines.map((l, i) => ({ ...l, id: String(i) }));
    const policies = await this.config.resolveLinePolicies(tx, companyId, keyed);
    for (const line of keyed) {
      const policy = policies.get(line.id);
      if (!policy) continue;
      try {
        buildSchedule({
          method: policy.method,
          amount: '1',
          currency: 'XXX',
          documentDate,
          serviceStartDate: line.serviceStartDate,
          serviceEndDate: line.serviceEndDate,
          defaultTermMonths: policy.defaultTermMonths,
          milestones: line.milestones,
        });
      } catch (err) {
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          `Line ${line.lineNumber} (${policy.code}): ${(err as Error).message}.`,
          { lineNumber: line.lineNumber, policy: policy.code },
        );
      }
    }
  }

  /**
   * Creates a schedule for every invoice line under a deferring policy and
   * returns the deferred revenue account those lines credit. Lines without
   * a policy (or under POINT_IN_TIME) are left alone. Invoices only -
   * credit and debit notes always hit revenue directly.
   */
  async deferInvoiceLines(
    tx: DbExecutor,
    companyId: string,
    invoice: {
      id: string;
      customerId: string;
      documentNumber: string;
      documentDate: string;
      documentType: string;
      currency: string;
    },
    lines: readonly DeferrableLine[],
  ): Promise<DeferralPlan> {
    const plan: DeferralPlan = { deferredAccountByLine: new Map(), scheduleIds: [] };
    if (invoice.documentType !== 'INVOICE') return plan;
    const policies = await this.config.resolveLinePolicies(tx, companyId, lines);
    if (policies.size === 0) return plan;
    const deferred = await this.accounts.resolveMapped(companyId, 'DEFERRED_REVENUE', tx);
    for (const line of lines) {
      const policy = policies.get(line.id);
      if (!policy) continue;
      const amount = Money.of(line.amount, invoice.currency);
      if (!amount.isPositive()) continue;
      let built: ReturnType<typeof buildSchedule>;
      try {
        built = buildSchedule({
          method: policy.method,
          amount: amount.toString(),
          currency: invoice.currency,
          documentDate: invoice.documentDate,
          serviceStartDate: line.serviceStartDate,
          serviceEndDate: line.serviceEndDate,
          defaultTermMonths: policy.defaultTermMonths,
          milestones: line.milestones,
        });
      } catch (err) {
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          `Line ${line.lineNumber} (${policy.code}): ${(err as Error).message}.`,
          { lineNumber: line.lineNumber, policy: policy.code },
        );
      }
      if (built.lines.length === 0) continue;
      const [schedule] = await tx
        .insert(revenueSchedules)
        .values({
          companyId,
          invoiceId: invoice.id,
          invoiceLineId: line.id,
          customerId: invoice.customerId,
          policyId: policy.id,
          method: policy.method,
          description: `${invoice.documentNumber} - ${line.description}`,
          currency: invoice.currency,
          totalAmount: amount.toString(),
          deferredAccountId: deferred.id,
          revenueAccountId: line.accountId,
          serviceStartDate: built.serviceStart,
          serviceEndDate: built.serviceEnd,
          branchId: line.branchId,
          departmentId: line.departmentId,
          costCenterId: line.costCenterId,
          projectId: line.projectId,
        })
        .returning();
      await tx.insert(revenueScheduleLines).values(
        built.lines.map((l) => ({
          scheduleId: schedule!.id,
          sequence: l.sequence,
          recognitionDate: l.recognitionDate,
          amount: l.amount,
          milestoneName: l.milestoneName,
          milestonePercent: l.milestonePercent,
        })),
      );
      plan.deferredAccountByLine.set(line.id, deferred.id);
      plan.scheduleIds.push(schedule!.id);
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'RevenueSchedule',
          entityId: schedule!.id,
          newValue: {
            invoice: invoice.documentNumber,
            line: line.lineNumber,
            method: policy.method,
            amount: amount.toString(),
            lines: built.lines.length,
          },
          companyId,
        },
        tx,
      );
    }
    return plan;
  }

  /**
   * Void hook: an invoice whose revenue has (partly) been recognized cannot
   * be voided - reverse the recognition runs first. Otherwise the schedules
   * are cancelled; the void reversal itself clears the deferred balance.
   */
  async cancelForInvoice(tx: DbExecutor, companyId: string, invoiceId: string): Promise<number> {
    const rows = await tx
      .select()
      .from(revenueSchedules)
      .where(
        and(
          eq(revenueSchedules.companyId, companyId),
          eq(revenueSchedules.invoiceId, invoiceId),
          eq(revenueSchedules.status, 'ACTIVE'),
        ),
      )
      .for('update');
    if (rows.length === 0) return 0;
    const recognized = rows.filter((r) => !Money.of(r.recognizedAmount, r.currency).isZero());
    if (recognized.length > 0)
      throw new BusinessRuleError(
        ErrorCodes.REVENUE_RECOGNIZED,
        'Revenue on this invoice has already been recognized. Reverse the recognition runs before voiding it.',
        { scheduleIds: recognized.map((r) => r.id) },
      );
    const ids = rows.map((r) => r.id);
    await tx
      .update(revenueScheduleLines)
      .set({ status: 'CANCELLED' })
      .where(
        and(
          inArray(revenueScheduleLines.scheduleId, ids),
          eq(revenueScheduleLines.status, 'PENDING'),
        ),
      );
    await tx
      .update(revenueSchedules)
      .set({ status: 'CANCELLED', cancelledAt: new Date() })
      .where(inArray(revenueSchedules.id, ids));
    for (const row of rows)
      await this.audit.record(
        {
          action: 'CANCEL',
          module: MODULE,
          entityType: 'RevenueSchedule',
          entityId: row.id,
          previousValue: { status: row.status },
          newValue: { status: 'CANCELLED', reason: 'invoice voided' },
          companyId,
        },
        tx,
      );
    return rows.length;
  }

  // ------------------------------------------------------------------ queries

  async list(
    companyId: string,
    query: ListRevenueSchedulesQuery,
  ): Promise<PaginatedResult<RevenueScheduleView>> {
    const filters: SQL[] = [eq(revenueSchedules.companyId, companyId)];
    if (query.status) filters.push(eq(revenueSchedules.status, query.status));
    if (query.method) filters.push(eq(revenueSchedules.method, query.method));
    if (query.customerId) filters.push(eq(revenueSchedules.customerId, query.customerId));
    if (query.invoiceId) filters.push(eq(revenueSchedules.invoiceId, query.invoiceId));
    if (query.policyId) filters.push(eq(revenueSchedules.policyId, query.policyId));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(invoices.documentDate), desc(revenueSchedules.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, revenueSchedules, where),
    ]);
    return toPaginatedResult(items.map(toView), total, query);
  }

  async forInvoice(companyId: string, invoiceId: string): Promise<RevenueScheduleDetail[]> {
    const rows = await this.viewQuery(this.db)
      .where(
        and(eq(revenueSchedules.companyId, companyId), eq(revenueSchedules.invoiceId, invoiceId)),
      )
      .orderBy(asc(revenueSchedules.createdAt));
    return Promise.all(rows.map(async (r) => ({ ...toView(r), lines: await this.lines(r.s.id) })));
  }

  async get(companyId: string, id: string): Promise<RevenueScheduleDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(revenueSchedules.companyId, companyId), eq(revenueSchedules.id, id)),
    );
    if (!row) throw new NotFoundError('Revenue schedule', id);
    return { ...toView(row), lines: await this.lines(id) };
  }

  /** Marks a milestone complete so the next run recognizes it (dated `completedOn`, default today). */
  async completeMilestone(
    companyId: string,
    actor: AuthenticatedUser,
    scheduleId: string,
    lineId: string,
    input: CompleteMilestoneInput,
  ): Promise<RevenueScheduleDetail> {
    await this.db.transaction(async (tx) => {
      const [schedule] = await tx
        .select()
        .from(revenueSchedules)
        .where(and(eq(revenueSchedules.id, scheduleId), eq(revenueSchedules.companyId, companyId)))
        .for('update');
      if (!schedule) throw new NotFoundError('Revenue schedule', scheduleId);
      if (schedule.method !== 'MILESTONE' || schedule.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          'Only active milestone schedules have milestones to complete.',
        );
      const [line] = await tx
        .select()
        .from(revenueScheduleLines)
        .where(
          and(eq(revenueScheduleLines.id, lineId), eq(revenueScheduleLines.scheduleId, scheduleId)),
        )
        .for('update');
      if (!line) throw new NotFoundError('Milestone', lineId);
      if (line.status !== 'PENDING' || line.completedAt)
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          `Milestone "${line.milestoneName}" is already ${line.completedAt ? 'completed' : line.status.toLowerCase()}.`,
        );
      const completedOn = input.completedOn ?? businessToday();
      await tx
        .update(revenueScheduleLines)
        .set({
          completedAt: new Date(),
          completedBy: actor.id,
          completionNote: input.note ?? null,
          recognitionDate: completedOn,
        })
        .where(eq(revenueScheduleLines.id, lineId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'RevenueSchedule',
          entityId: scheduleId,
          previousValue: { milestone: line.milestoneName, completed: false },
          newValue: { milestone: line.milestoneName, completed: true, completedOn },
          metadata: { reason: input.note ?? 'milestone completed', lineId },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, scheduleId);
  }

  // ---------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    const deferred = alias(accounts, 'deferred');
    const revenue = alias(accounts, 'revenue');
    return executor
      .select({
        s: revenueSchedules,
        documentNumber: invoices.documentNumber,
        documentDate: invoices.documentDate,
        customerCode: customers.code,
        customerName: customers.name,
        policyCode: revenuePolicies.code,
        policyName: revenuePolicies.name,
        deferredAccountCode: deferred.code,
        revenueAccountCode: revenue.code,
        nextRecognitionDate: sql<string | null>`(
          select min(l.recognition_date) from revenue_schedule_lines l
          where l.schedule_id = ${revenueSchedules.id} and l.status = 'PENDING'
        )`,
      })
      .from(revenueSchedules)
      .innerJoin(invoices, eq(invoices.id, revenueSchedules.invoiceId))
      .innerJoin(customers, eq(customers.id, revenueSchedules.customerId))
      .innerJoin(revenuePolicies, eq(revenuePolicies.id, revenueSchedules.policyId))
      .innerJoin(deferred, eq(deferred.id, revenueSchedules.deferredAccountId))
      .innerJoin(revenue, eq(revenue.id, revenueSchedules.revenueAccountId))
      .$dynamic();
  }

  private async lines(scheduleId: string): Promise<RevenueScheduleLineView[]> {
    const rows = await this.db
      .select({
        l: revenueScheduleLines,
        runNumber: revenueRecognitionRuns.documentNumber,
        journalNumber: journalEntries.documentNumber,
      })
      .from(revenueScheduleLines)
      .leftJoin(revenueRecognitionRuns, eq(revenueRecognitionRuns.id, revenueScheduleLines.runId))
      .leftJoin(journalEntries, eq(journalEntries.id, revenueScheduleLines.journalEntryId))
      .where(eq(revenueScheduleLines.scheduleId, scheduleId))
      .orderBy(asc(revenueScheduleLines.sequence));
    return rows.map((r) => ({ ...r.l, runNumber: r.runNumber, journalNumber: r.journalNumber }));
  }
}

function toView(row: {
  s: RevenueSchedule;
  documentNumber: string;
  documentDate: string;
  customerCode: string;
  customerName: string;
  policyCode: string;
  policyName: string;
  deferredAccountCode: string;
  revenueAccountCode: string;
  nextRecognitionDate: string | null;
}): RevenueScheduleView {
  const { s, ...rest } = row;
  return {
    ...s,
    ...rest,
    remainingAmount: Money.of(s.totalAmount, s.currency)
      .subtract(Money.of(s.recognizedAmount, s.currency))
      .toString(),
  };
}
