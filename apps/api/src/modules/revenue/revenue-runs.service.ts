import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateRevenueRunInput,
  ListRevenueRunsQuery,
  ReverseRevenueRunInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  journalEntries,
  revenuePolicies,
  revenueRecognitionRuns,
  revenueScheduleLines,
  revenueSchedules,
  users,
  type RevenueRecognitionRun,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingActor,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { RevenueConfigService } from './revenue-config.service';

const MODULE = 'REVENUE';

export interface RevenueRunView extends RevenueRecognitionRun {
  journalNumber: string | null;
  reversalJournalNumber: string | null;
  createdByName: string | null;
}

export interface RevenueRunLineView {
  scheduleId: string;
  lineId: string;
  scheduleDescription: string;
  customerId: string;
  sequence: number;
  recognitionDate: string | null;
  milestoneName: string | null;
  amount: string;
}

export interface RevenueRunDetail extends RevenueRunView {
  lines: RevenueRunLineView[];
}

export interface RecognitionSummary {
  runId: string | null;
  documentNumber: string | null;
  periodEnd: string;
  lines: number;
  amount: string;
}

/**
 * Revenue recognition runs (Prompt #10). A run takes every pending schedule
 * line due on or before `periodEnd` (milestones only once completed) and
 * posts one ADJUSTING journal dated `periodEnd`: Dr deferred revenue / Cr
 * the line's revenue account, carrying the invoice line's dimensions. The
 * run is the journal's source identity; reversing a run mirrors the journal
 * and re-opens its lines. Runs are the only path from deferred to earned.
 */
@Injectable()
export class RevenueRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly config: RevenueConfigService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RevenueRunsService.name);
  }

  // ------------------------------------------------------------------ queries

  async list(
    companyId: string,
    query: ListRevenueRunsQuery,
  ): Promise<PaginatedResult<RevenueRunView>> {
    const filters: SQL[] = [eq(revenueRecognitionRuns.companyId, companyId)];
    if (query.status) filters.push(eq(revenueRecognitionRuns.status, query.status));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(desc(revenueRecognitionRuns.periodEnd), desc(revenueRecognitionRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, revenueRecognitionRuns, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async get(companyId: string, id: string): Promise<RevenueRunDetail> {
    const [run] = await this.viewQuery().where(
      and(eq(revenueRecognitionRuns.companyId, companyId), eq(revenueRecognitionRuns.id, id)),
    );
    if (!run) throw new NotFoundError('Revenue recognition run', id);
    const lines = await this.db
      .select({
        scheduleId: revenueSchedules.id,
        lineId: revenueScheduleLines.id,
        scheduleDescription: revenueSchedules.description,
        customerId: revenueSchedules.customerId,
        sequence: revenueScheduleLines.sequence,
        recognitionDate: revenueScheduleLines.recognitionDate,
        milestoneName: revenueScheduleLines.milestoneName,
        amount: revenueScheduleLines.amount,
      })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .where(eq(revenueScheduleLines.runId, id))
      .orderBy(asc(revenueSchedules.description), asc(revenueScheduleLines.sequence));
    return { ...run, lines };
  }

  /** What the next run would recognize up to `periodEnd` - the preview behind the Recognize button. */
  async preview(
    companyId: string,
    periodEnd: string,
  ): Promise<{
    periodEnd: string;
    currency: string;
    lines: number;
    amount: string;
    schedules: number;
  }> {
    const currency = await this.accounts.companyCurrency(companyId);
    const due = await this.dueLines(this.db, companyId, periodEnd, {});
    return {
      periodEnd,
      currency,
      lines: due.length,
      amount: Money.sum(
        due.map((d) => Money.of(d.line.amount, currency)),
        currency,
      ).toString(),
      schedules: new Set(due.map((d) => d.schedule.id)).size,
    };
  }

  // ----------------------------------------------------------------- commands

  /** Posts a run for everything due; returns null (no run) when nothing is due. */
  async create(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: CreateRevenueRunInput,
    options: { autoOnly?: boolean } = {},
  ): Promise<RevenueRunDetail | null> {
    const runId = await this.db.transaction(async (tx) => {
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const due = await this.dueLines(tx, companyId, input.periodEnd, {
        scheduleIds: input.scheduleIds,
        autoOnly: options.autoOnly,
        lock: true,
      });
      if (due.length === 0) return null;
      const total = Money.sum(
        due.map((d) => Money.of(d.line.amount, currency)),
        currency,
      );
      const documentNumber = await this.numbering.allocate(
        companyId,
        'RRN',
        Number(input.periodEnd.slice(0, 4)),
        tx,
      );
      const [run] = await tx
        .insert(revenueRecognitionRuns)
        .values({
          companyId,
          documentNumber,
          periodEnd: input.periodEnd,
          description: input.description ?? null,
          currency,
          totalAmount: total.toString(),
          lineCount: due.length,
          createdBy: actor?.id ?? null,
        })
        .returning();
      const postingActor: PostingActor = actor
        ? { id: actor.id, permissions: actor.permissions, system: actor.system }
        : { id: null, system: true };
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.periodEnd,
          description: `Revenue recognition ${documentNumber}${input.description ? ` - ${input.description}` : ''}`,
          reference: documentNumber,
          journalType: 'ADJUSTING',
          sourceType: 'REVENUE_RECOGNITION_RUN',
          sourceId: run!.id,
          actor: postingActor,
          lines: due.flatMap((d) => [
            {
              accountId: d.schedule.deferredAccountId,
              debit: d.line.amount,
              credit: '0',
              description: d.schedule.description,
              branchId: d.schedule.branchId,
              departmentId: d.schedule.departmentId,
              costCenterId: d.schedule.costCenterId,
              projectId: d.schedule.projectId,
            },
            {
              accountId: d.schedule.revenueAccountId,
              debit: '0',
              credit: d.line.amount,
              description: d.line.milestoneName
                ? `${d.schedule.description} - ${d.line.milestoneName}`
                : d.schedule.description,
              branchId: d.schedule.branchId,
              departmentId: d.schedule.departmentId,
              costCenterId: d.schedule.costCenterId,
              projectId: d.schedule.projectId,
            },
          ]),
        },
        { permission: P['revenue.recognize'] },
      );
      await tx
        .update(revenueRecognitionRuns)
        .set({ journalEntryId: entry.id })
        .where(eq(revenueRecognitionRuns.id, run!.id));
      const now = new Date();
      await tx
        .update(revenueScheduleLines)
        .set({ status: 'RECOGNIZED', runId: run!.id, journalEntryId: entry.id, recognizedAt: now })
        .where(
          inArray(
            revenueScheduleLines.id,
            due.map((d) => d.line.id),
          ),
        );
      await this.refreshSchedules(tx, [...new Set(due.map((d) => d.schedule.id))], currency);
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'RevenueRecognitionRun',
          entityId: run!.id,
          newValue: {
            documentNumber,
            periodEnd: input.periodEnd,
            lines: due.length,
            amount: total.toString(),
            journalEntryId: entry.id,
          },
          companyId,
          userId: actor?.id ?? null,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'revenue.recognized',
        companyId,
        dedupeKey: `revenue.recognized:${run!.id}`,
        payload: {
          runId: run!.id,
          documentNumber,
          periodEnd: input.periodEnd,
          amount: total.toString(),
          currency,
          lines: due.length,
          journalEntryId: entry.id,
        },
      });
      const organizationId = await this.organizationOf(tx, companyId);
      if (organizationId)
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'REVENUE_RUN_POSTED',
            severity: 'INFO',
            title: `Revenue recognition ${documentNumber} posted`,
            body: `${currency} ${total.toString()} recognized across ${due.length} schedule line(s) up to ${input.periodEnd}.`,
            link: `/revenue/runs/${run!.id}`,
            entityType: 'RevenueRecognitionRun',
            entityId: run!.id,
            permission: 'revenue.view',
            companyId,
            dedupeKey: `revenue-run:${run!.id}`,
          },
          tx,
        );
      return run!.id;
    });
    return runId ? this.get(companyId, runId) : null;
  }

  /** Mirrors the run's journal and re-opens its schedule lines. */
  async reverse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ReverseRevenueRunInput,
  ): Promise<RevenueRunDetail> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(revenueRecognitionRuns)
        .where(
          and(eq(revenueRecognitionRuns.id, id), eq(revenueRecognitionRuns.companyId, companyId)),
        )
        .for('update');
      if (!run) throw new NotFoundError('Revenue recognition run', id);
      if (run.status !== 'POSTED' || !run.journalEntryId)
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_RUN_INVALID_STATE,
          `Run ${run.documentNumber} is already ${run.status.toLowerCase()}.`,
        );
      const [later] = await tx
        .select({ id: revenueRecognitionRuns.id })
        .from(revenueRecognitionRuns)
        .where(
          and(
            eq(revenueRecognitionRuns.companyId, companyId),
            eq(revenueRecognitionRuns.status, 'POSTED'),
            sql`${revenueRecognitionRuns.periodEnd} > ${run.periodEnd}`,
          ),
        )
        .limit(1);
      if (later)
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_RUN_INVALID_STATE,
          'Reverse later recognition runs first - runs are reversed latest first.',
        );
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, run.journalEntryId))
        .for('update');
      if (!entry) throw new NotFoundError('Journal entry', run.journalEntryId);
      const reversal = await this.posting.reverseEntry(tx, entry, {
        reversalDate: run.periodEnd,
        description: `Reverse revenue recognition ${run.documentNumber}: ${input.reason}`,
        actor: { id: actor.id, permissions: actor.permissions, system: actor.system },
        permission: P['revenue.recognize'],
      });
      const lines = await tx
        .select({ id: revenueScheduleLines.id, scheduleId: revenueScheduleLines.scheduleId })
        .from(revenueScheduleLines)
        .where(eq(revenueScheduleLines.runId, id))
        .for('update');
      await tx
        .update(revenueScheduleLines)
        .set({ status: 'PENDING', runId: null, journalEntryId: null, recognizedAt: null })
        .where(eq(revenueScheduleLines.runId, id));
      await this.refreshSchedules(tx, [...new Set(lines.map((l) => l.scheduleId))], run.currency);
      await tx
        .update(revenueRecognitionRuns)
        .set({
          status: 'REVERSED',
          reversalJournalEntryId: reversal.id,
          reversedAt: new Date(),
          reversalReason: input.reason,
        })
        .where(eq(revenueRecognitionRuns.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'RevenueRecognitionRun',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: {
            status: 'REVERSED',
            reversalJournalEntryId: reversal.id,
            reason: input.reason,
          },
          metadata: { reason: input.reason },
          companyId,
          userId: actor.id,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'revenue.run_reversed',
        companyId,
        dedupeKey: `revenue.run_reversed:${id}`,
        payload: { runId: id, documentNumber: run.documentNumber, reason: input.reason },
      });
    });
    return this.get(companyId, id);
  }

  /** Scheduler entry point: one run per company that opted into automatic recognition. */
  async recognizeAllCompanies(asOf: string): Promise<RecognitionSummary[]> {
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    const summaries: RecognitionSummary[] = [];
    for (const c of rows) {
      try {
        const settings = await this.config.settings(c.id);
        if (!settings.autoRecognize) continue;
        const run = await this.create(
          c.id,
          null,
          { periodEnd: asOf, description: 'Automatic month-end recognition' },
          { autoOnly: true },
        );
        summaries.push({
          runId: run?.id ?? null,
          documentNumber: run?.documentNumber ?? null,
          periodEnd: asOf,
          lines: run?.lineCount ?? 0,
          amount: run?.totalAmount ?? '0',
        });
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Automatic revenue recognition failed');
      }
    }
    return summaries;
  }

  // ---------------------------------------------------------------- internals

  /** Pending lines due on or before `periodEnd`; milestones only once completed. */
  private async dueLines(
    executor: DbExecutor,
    companyId: string,
    periodEnd: string,
    options: { scheduleIds?: string[]; autoOnly?: boolean; lock?: boolean },
  ) {
    const filters: SQL[] = [
      eq(revenueSchedules.companyId, companyId),
      eq(revenueSchedules.status, 'ACTIVE'),
      eq(revenueScheduleLines.status, 'PENDING'),
      lte(revenueScheduleLines.recognitionDate, periodEnd),
      or(
        sql`${revenueSchedules.method} <> 'MILESTONE'`,
        isNotNull(revenueScheduleLines.completedAt),
      )!,
    ];
    if (options.scheduleIds?.length)
      filters.push(inArray(revenueSchedules.id, options.scheduleIds));
    if (options.autoOnly) filters.push(eq(revenuePolicies.autoRecognize, true));
    const query = executor
      .select({ line: revenueScheduleLines, schedule: revenueSchedules })
      .from(revenueScheduleLines)
      .innerJoin(revenueSchedules, eq(revenueSchedules.id, revenueScheduleLines.scheduleId))
      .innerJoin(revenuePolicies, eq(revenuePolicies.id, revenueSchedules.policyId))
      .where(and(...filters))
      .orderBy(asc(revenueSchedules.createdAt), asc(revenueScheduleLines.sequence))
      .$dynamic();
    return options.lock ? query.for('update', { of: revenueScheduleLines }) : query;
  }

  /** Recomputes recognized totals and completion from the lines (the lines are the truth). */
  private async refreshSchedules(tx: DbExecutor, scheduleIds: string[], currency: string) {
    for (const scheduleId of scheduleIds) {
      const [agg] = await tx
        .select({
          recognized: sql<string>`coalesce(sum(case when ${revenueScheduleLines.status} = 'RECOGNIZED' then ${revenueScheduleLines.amount} else 0 end), 0)`,
          pending: sql<number>`count(*) filter (where ${revenueScheduleLines.status} = 'PENDING')::int`,
        })
        .from(revenueScheduleLines)
        .where(eq(revenueScheduleLines.scheduleId, scheduleId));
      const recognized = Money.of(agg?.recognized ?? '0', currency);
      const completed = (agg?.pending ?? 0) === 0;
      await tx
        .update(revenueSchedules)
        .set({
          recognizedAmount: recognized.toString(),
          status: completed ? 'COMPLETED' : 'ACTIVE',
          completedAt: completed ? new Date() : null,
        })
        .where(eq(revenueSchedules.id, scheduleId));
    }
  }

  private viewQuery() {
    const reversal = sql<string | null>`(
      select r.document_number from journal_entries r
      where r.id = ${revenueRecognitionRuns.reversalJournalEntryId}
    )`;
    return this.db
      .select({
        id: revenueRecognitionRuns.id,
        companyId: revenueRecognitionRuns.companyId,
        documentNumber: revenueRecognitionRuns.documentNumber,
        periodEnd: revenueRecognitionRuns.periodEnd,
        description: revenueRecognitionRuns.description,
        status: revenueRecognitionRuns.status,
        currency: revenueRecognitionRuns.currency,
        totalAmount: revenueRecognitionRuns.totalAmount,
        lineCount: revenueRecognitionRuns.lineCount,
        journalEntryId: revenueRecognitionRuns.journalEntryId,
        reversalJournalEntryId: revenueRecognitionRuns.reversalJournalEntryId,
        reversedAt: revenueRecognitionRuns.reversedAt,
        reversalReason: revenueRecognitionRuns.reversalReason,
        createdBy: revenueRecognitionRuns.createdBy,
        createdAt: revenueRecognitionRuns.createdAt,
        updatedAt: revenueRecognitionRuns.updatedAt,
        journalNumber: journalEntries.documentNumber,
        reversalJournalNumber: reversal,
        createdByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(revenueRecognitionRuns)
      .leftJoin(journalEntries, eq(journalEntries.id, revenueRecognitionRuns.journalEntryId))
      .leftJoin(users, eq(users.id, revenueRecognitionRuns.createdBy))
      .$dynamic();
  }

  private async organizationOf(tx: DbExecutor, companyId: string): Promise<string | null> {
    const [row] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row?.organizationId ?? null;
  }
}
