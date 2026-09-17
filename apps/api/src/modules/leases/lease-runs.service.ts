import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateLeaseRunInput,
  ListLeaseRunsQuery,
  ReverseLeaseRunInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  journalEntries,
  leaseEvents,
  leaseRuns,
  leaseScheduleLines,
  leases,
  users,
  type Lease,
  type LeaseRun,
  type LeaseScheduleLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingActor,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { LeasesConfigService } from './leases-config.service';
import { LeasesService } from './leases.service';

const MODULE = 'LEASES';

export interface LeaseRunView extends LeaseRun {
  journalNumber: string | null;
  reversalJournalNumber: string | null;
  createdByName: string | null;
}

export interface LeaseRunLineView {
  leaseId: string;
  leaseNumber: string;
  leaseName: string;
  lineId: string;
  sequence: number;
  periodStart: string;
  periodEnd: string;
  interest: string;
  depreciation: string;
  closingLiability: string;
}

export interface LeaseRunDetail extends LeaseRunView {
  lines: LeaseRunLineView[];
}

export interface LeaseRunPreview {
  periodEnd: string;
  currency: string;
  leases: number;
  lines: number;
  interest: string;
  depreciation: string;
  byLease: Array<{
    leaseId: string;
    leaseNumber: string;
    leaseName: string;
    months: number;
    interest: string;
    depreciation: string;
  }>;
}

export interface LeaseRunSummary {
  runId: string | null;
  documentNumber: string | null;
  periodEnd: string;
  lines: number;
}

/**
 * Lease runs (Prompt #13): one ADJUSTING journal per run dated `periodEnd`
 * that accretes the interest of every pending schedule month up to that
 * date (Dr lease interest expense / Cr lease liability) and depreciates the
 * right-of-use asset (Dr depreciation expense / Cr ROU accumulated
 * depreciation), one pair of lines per lease. The run is the journal's
 * source identity; reversing it mirrors the journal and reopens the months.
 * Exempt leases never take part - their months close when they are paid.
 */
@Injectable()
export class LeaseRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly config: LeasesConfigService,
    private readonly leasesService: LeasesService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LeaseRunsService.name);
  }

  // ------------------------------------------------------------------ queries

  async list(companyId: string, query: ListLeaseRunsQuery): Promise<PaginatedResult<LeaseRunView>> {
    const filters: SQL[] = [eq(leaseRuns.companyId, companyId)];
    if (query.status) filters.push(eq(leaseRuns.status, query.status));
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(desc(leaseRuns.periodEnd), desc(leaseRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, leaseRuns, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async get(companyId: string, id: string): Promise<LeaseRunDetail> {
    const [run] = await this.viewQuery().where(
      and(eq(leaseRuns.companyId, companyId), eq(leaseRuns.id, id)),
    );
    if (!run) throw new NotFoundError('Lease run', id);
    const lines = await this.db
      .select({
        leaseId: leases.id,
        leaseNumber: leases.leaseNumber,
        leaseName: leases.name,
        lineId: leaseScheduleLines.id,
        sequence: leaseScheduleLines.sequence,
        periodStart: leaseScheduleLines.periodStart,
        periodEnd: leaseScheduleLines.periodEnd,
        interest: leaseScheduleLines.interest,
        depreciation: leaseScheduleLines.depreciation,
        closingLiability: leaseScheduleLines.closingLiability,
      })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(eq(leaseScheduleLines.runId, id))
      .orderBy(asc(leases.leaseNumber), asc(leaseScheduleLines.sequence));
    return { ...run, lines };
  }

  /** What the next run would post up to `periodEnd`. */
  async preview(companyId: string, periodEnd: string): Promise<LeaseRunPreview> {
    const currency = await this.accounts.companyCurrency(companyId);
    const due = await this.dueLines(this.db, companyId, periodEnd, {});
    const byLease = new Map<
      string,
      {
        leaseId: string;
        leaseNumber: string;
        leaseName: string;
        months: number;
        interest: Money;
        depreciation: Money;
      }
    >();
    for (const d of due) {
      const bucket = byLease.get(d.lease.id) ?? {
        leaseId: d.lease.id,
        leaseNumber: d.lease.leaseNumber,
        leaseName: d.lease.name,
        months: 0,
        interest: Money.zero(currency),
        depreciation: Money.zero(currency),
      };
      bucket.months += 1;
      bucket.interest = bucket.interest.add(Money.of(d.line.interest, currency));
      bucket.depreciation = bucket.depreciation.add(Money.of(d.line.depreciation, currency));
      byLease.set(d.lease.id, bucket);
    }
    const groups = [...byLease.values()];
    return {
      periodEnd,
      currency,
      leases: groups.length,
      lines: due.length,
      interest: Money.sum(
        groups.map((g) => g.interest),
        currency,
      ).toString(),
      depreciation: Money.sum(
        groups.map((g) => g.depreciation),
        currency,
      ).toString(),
      byLease: groups.map((g) => ({
        ...g,
        interest: g.interest.toString(),
        depreciation: g.depreciation.toString(),
      })),
    };
  }

  // ----------------------------------------------------------------- commands

  /** Posts a run for every due month; returns null when nothing is due. */
  async create(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: CreateLeaseRunInput,
  ): Promise<LeaseRunDetail | null> {
    const runId = await this.db.transaction(async (tx) => {
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const due = await this.dueLines(tx, companyId, input.periodEnd, {
        leaseIds: input.leaseIds,
        lock: true,
      });
      if (due.length === 0) return null;
      await this.posting.resolvePeriod(tx, companyId, input.periodEnd, { draft: true });
      const documentNumber = await this.numbering.allocate(
        companyId,
        'LRN',
        Number(input.periodEnd.slice(0, 4)),
        tx,
      );
      const [run] = await tx
        .insert(leaseRuns)
        .values({
          companyId,
          documentNumber,
          periodEnd: input.periodEnd,
          description: input.description ?? null,
          currency,
          createdBy: actor?.id ?? null,
        })
        .returning();
      const postingLines: PostingLine[] = [];
      const eventRows: Array<typeof leaseEvents.$inferInsert> = [];
      let interestTotal = Money.zero(currency);
      let depreciationTotal = Money.zero(currency);
      const leaseIds = [...new Set(due.map((d) => d.lease.id))];
      for (const leaseId of leaseIds) {
        const lease = await this.leasesService.lock(tx, companyId, leaseId);
        const mine = due.filter((d) => d.lease.id === leaseId).map((d) => d.line);
        const interest = Money.sum(
          mine.map((l) => Money.of(l.interest, currency)),
          currency,
        );
        const depreciation = Money.sum(
          mine.map((l) => Money.of(l.depreciation, currency)),
          currency,
        );
        const accts = await this.config.resolveAccounts(companyId, lease, tx);
        const dims = this.leasesService.dims(lease);
        const label = `${lease.leaseNumber} ${lease.name}`;
        if (!interest.isZero())
          postingLines.push(
            {
              accountId: accts.interestExpense,
              debit: interest.toString(),
              credit: '0',
              description: `${label} - lease interest`,
              ...dims,
            },
            {
              accountId: accts.liability,
              debit: '0',
              credit: interest.toString(),
              description: `${label} - interest accreted`,
              ...dims,
            },
          );
        if (!depreciation.isZero())
          postingLines.push(
            {
              accountId: accts.depreciationExpense,
              debit: depreciation.toString(),
              credit: '0',
              description: `${label} - right-of-use depreciation`,
              ...dims,
            },
            {
              accountId: accts.rouAccumulated,
              debit: '0',
              credit: depreciation.toString(),
              description: `${label} - accumulated depreciation`,
              ...dims,
            },
          );
        const liabilityAfter = Money.of(lease.liabilityBalance, currency).add(interest);
        const accumulatedAfter = Money.of(lease.rouAccumulatedDepreciation, currency).add(
          depreciation,
        );
        const carryingAfter = Money.of(lease.rouCost, currency).subtract(accumulatedAfter);
        await tx
          .update(leases)
          .set({
            liabilityBalance: liabilityAfter.toString(),
            rouAccumulatedDepreciation: accumulatedAfter.toString(),
          })
          .where(eq(leases.id, leaseId));
        const months = `month${mine.length > 1 ? 's' : ''} ${mine[0]!.sequence}${mine.length > 1 ? `-${mine[mine.length - 1]!.sequence}` : ''}`;
        eventRows.push(
          {
            companyId,
            leaseId,
            eventType: 'INTEREST',
            eventDate: input.periodEnd,
            liabilityChange: interest.toString(),
            rouChange: '0',
            liabilityAfter: liabilityAfter.toString(),
            rouCarryingAfter: carryingAfter.toString(),
            runId: run!.id,
            notes: `${documentNumber} ${months}`,
            createdBy: actor?.id ?? null,
          },
          {
            companyId,
            leaseId,
            eventType: 'DEPRECIATION',
            eventDate: input.periodEnd,
            liabilityChange: '0',
            rouChange: depreciation.negate().toString(),
            liabilityAfter: liabilityAfter.toString(),
            rouCarryingAfter: carryingAfter.toString(),
            runId: run!.id,
            notes: `${documentNumber} ${months}`,
            createdBy: actor?.id ?? null,
          },
        );
        interestTotal = interestTotal.add(interest);
        depreciationTotal = depreciationTotal.add(depreciation);
      }
      if (postingLines.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_RUN_INVALID_STATE,
          'Nothing to post: the due months carry no interest or depreciation.',
        );
      const postingActor: PostingActor = actor
        ? { id: actor.id, permissions: actor.permissions, system: actor.system }
        : { id: null, system: true };
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.periodEnd,
          description: `Lease run ${documentNumber}${input.description ? ` - ${input.description}` : ''}`,
          reference: documentNumber,
          journalType: 'ADJUSTING',
          sourceType: 'LEASE_RUN',
          sourceId: run!.id,
          actor: postingActor,
          lines: postingLines,
        },
        { permission: P['lease.post'] },
      );
      const now = new Date();
      await tx
        .update(leaseScheduleLines)
        .set({ status: 'POSTED', runId: run!.id, journalEntryId: entry.id, postedAt: now })
        .where(
          inArray(
            leaseScheduleLines.id,
            due.map((d) => d.line.id),
          ),
        );
      await tx
        .insert(leaseEvents)
        .values(eventRows.map((e) => ({ ...e, journalEntryId: entry.id })));
      await tx
        .update(leaseRuns)
        .set({
          journalEntryId: entry.id,
          interestTotal: interestTotal.toString(),
          depreciationTotal: depreciationTotal.toString(),
          lineCount: due.length,
          leaseCount: leaseIds.length,
        })
        .where(eq(leaseRuns.id, run!.id));
      for (const leaseId of leaseIds) await this.leasesService.refresh(tx, leaseId);
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'LeaseRun',
          entityId: run!.id,
          newValue: {
            documentNumber,
            periodEnd: input.periodEnd,
            leases: leaseIds.length,
            lines: due.length,
            interest: interestTotal.toString(),
            depreciation: depreciationTotal.toString(),
            journalEntryId: entry.id,
          },
          companyId,
          userId: actor?.id ?? null,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'lease.run_posted',
        companyId,
        dedupeKey: `lease.run_posted:${run!.id}`,
        payload: {
          runId: run!.id,
          documentNumber,
          periodEnd: input.periodEnd,
          interest: interestTotal.toString(),
          depreciation: depreciationTotal.toString(),
          currency,
          leases: leaseIds.length,
          journalEntryId: entry.id,
        },
      });
      return run!.id;
    });
    return runId ? this.get(companyId, runId) : null;
  }

  /** Mirrors the run's journal, restores the carrying figures and reopens its months. */
  async reverse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ReverseLeaseRunInput,
  ): Promise<LeaseRunDetail> {
    await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(leaseRuns)
        .where(and(eq(leaseRuns.id, id), eq(leaseRuns.companyId, companyId)))
        .for('update');
      if (!run) throw new NotFoundError('Lease run', id);
      if (run.status !== 'POSTED' || !run.journalEntryId)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_RUN_INVALID_STATE,
          `Run ${run.documentNumber} is already ${run.status.toLowerCase()}.`,
        );
      const [later] = await tx
        .select({ id: leaseRuns.id })
        .from(leaseRuns)
        .where(
          and(
            eq(leaseRuns.companyId, companyId),
            eq(leaseRuns.status, 'POSTED'),
            sql`${leaseRuns.periodEnd} > ${run.periodEnd}`,
          ),
        )
        .limit(1);
      if (later)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_RUN_INVALID_STATE,
          'Reverse later lease runs first - runs are reversed latest first.',
        );
      const lines = await tx
        .select()
        .from(leaseScheduleLines)
        .where(eq(leaseScheduleLines.runId, id))
        .for('update');
      const currency = run.currency;
      const leaseIds = [...new Set(lines.map((l) => l.leaseId))];
      for (const leaseId of leaseIds) {
        const lease = await this.leasesService.lock(tx, companyId, leaseId);
        if (lease.status !== 'ACTIVE' && lease.status !== 'COMPLETED')
          throw new BusinessRuleError(
            ErrorCodes.LEASE_RUN_INVALID_STATE,
            `${lease.leaseNumber} has been ${lease.status.toLowerCase()}; its run cannot be reversed.`,
          );
        const mine = lines.filter((l) => l.leaseId === leaseId);
        const interest = Money.sum(
          mine.map((l) => Money.of(l.interest, currency)),
          currency,
        );
        const depreciation = Money.sum(
          mine.map((l) => Money.of(l.depreciation, currency)),
          currency,
        );
        const liabilityAfter = Money.of(lease.liabilityBalance, currency).subtract(interest);
        const accumulatedAfter = Money.of(lease.rouAccumulatedDepreciation, currency).subtract(
          depreciation,
        );
        if (liabilityAfter.isNegative() || accumulatedAfter.isNegative())
          throw new BusinessRuleError(
            ErrorCodes.LEASE_RUN_INVALID_STATE,
            `${lease.leaseNumber} has moved on since ${run.documentNumber}; remeasure instead of reversing.`,
          );
        await tx
          .update(leases)
          .set({
            liabilityBalance: liabilityAfter.toString(),
            rouAccumulatedDepreciation: accumulatedAfter.toString(),
          })
          .where(eq(leases.id, leaseId));
        const carryingAfter = Money.of(lease.rouCost, currency).subtract(accumulatedAfter);
        await tx.insert(leaseEvents).values([
          {
            companyId,
            leaseId,
            eventType: 'INTEREST',
            eventDate: run.periodEnd,
            liabilityChange: interest.negate().toString(),
            rouChange: '0',
            liabilityAfter: liabilityAfter.toString(),
            rouCarryingAfter: carryingAfter.toString(),
            runId: run.id,
            notes: `Reversal of ${run.documentNumber}`,
            createdBy: actor.id,
          },
          {
            companyId,
            leaseId,
            eventType: 'DEPRECIATION',
            eventDate: run.periodEnd,
            liabilityChange: '0',
            rouChange: depreciation.toString(),
            liabilityAfter: liabilityAfter.toString(),
            rouCarryingAfter: carryingAfter.toString(),
            runId: run.id,
            notes: `Reversal of ${run.documentNumber}`,
            createdBy: actor.id,
          },
        ]);
      }
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, run.journalEntryId))
        .for('update');
      if (!entry) throw new NotFoundError('Journal entry', run.journalEntryId);
      const reversal = await this.posting.reverseEntry(tx, entry, {
        reversalDate: run.periodEnd,
        description: `Reverse lease run ${run.documentNumber}: ${input.reason}`,
        actor: { id: actor.id, permissions: actor.permissions, system: actor.system },
        permission: P['lease.post'],
      });
      await tx
        .update(leaseEvents)
        .set({ journalEntryId: reversal.id })
        .where(and(eq(leaseEvents.runId, id), sql`${leaseEvents.journalEntryId} is null`));
      await tx
        .update(leaseScheduleLines)
        .set({ status: 'PENDING', runId: null, journalEntryId: null, postedAt: null })
        .where(eq(leaseScheduleLines.runId, id));
      for (const leaseId of leaseIds) await this.leasesService.refresh(tx, leaseId);
      await tx
        .update(leaseRuns)
        .set({
          status: 'REVERSED',
          reversalJournalEntryId: reversal.id,
          reversedAt: new Date(),
          reversalReason: input.reason,
        })
        .where(eq(leaseRuns.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'LeaseRun',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'REVERSED', reversalJournalEntryId: reversal.id },
          metadata: { reason: input.reason, documentNumber: run.documentNumber },
          companyId,
          userId: actor.id,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'lease.run_reversed',
        companyId,
        dedupeKey: `lease.run_reversed:${id}`,
        payload: { runId: id, documentNumber: run.documentNumber, reason: input.reason },
      });
    });
    return this.get(companyId, id);
  }

  /** Scheduler entry point: one run per company that opted in, plus reminders for the rest. */
  async runAllCompanies(asOf: string): Promise<LeaseRunSummary[]> {
    const rows = await this.db
      .select({ id: companies.id, organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    const summaries: LeaseRunSummary[] = [];
    for (const c of rows) {
      try {
        const settings = await this.config.settings(c.id);
        const due = await this.dueLines(this.db, c.id, asOf, {});
        if (due.length === 0) continue;
        if (settings.autoPostRuns) {
          const run = await this.create(c.id, null, {
            periodEnd: asOf,
            description: 'Automatic month-end lease run',
          });
          summaries.push({
            runId: run?.id ?? null,
            documentNumber: run?.documentNumber ?? null,
            periodEnd: asOf,
            lines: run?.lineCount ?? 0,
          });
        } else {
          await this.notifications.notify({
            organizationId: c.organizationId,
            eventType: 'LEASE_RUN_DUE',
            severity: 'WARNING',
            title: `${due.length} lease month(s) waiting for a lease run`,
            body: `Interest and depreciation through ${asOf} are not yet posted for ${new Set(due.map((d) => d.lease.id)).size} lease(s).`,
            link: '/leases/runs',
            entityType: 'LeaseRun',
            entityId: c.id,
            permission: 'lease.view',
            companyId: c.id,
            dedupeKey: `lease-run-due:${c.id}:${asOf.slice(0, 7)}`,
          });
          summaries.push({ runId: null, documentNumber: null, periodEnd: asOf, lines: due.length });
        }
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Automatic lease run failed');
      }
    }
    return summaries;
  }

  // ---------------------------------------------------------------- internals

  /** Pending months of active finance leases ending on or before `periodEnd`, in schedule order. */
  async dueLines(
    executor: DbExecutor,
    companyId: string,
    periodEnd: string,
    options: { leaseIds?: string[]; lock?: boolean },
  ): Promise<Array<{ lease: Lease; line: LeaseScheduleLine }>> {
    const filters: SQL[] = [
      eq(leases.companyId, companyId),
      eq(leases.status, 'ACTIVE'),
      eq(leases.classification, 'FINANCE'),
      eq(leaseScheduleLines.status, 'PENDING'),
      lte(leaseScheduleLines.periodEnd, periodEnd),
    ];
    if (options.leaseIds?.length) filters.push(inArray(leases.id, options.leaseIds));
    const query = executor
      .select({ lease: leases, line: leaseScheduleLines })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(and(...filters))
      .orderBy(asc(leases.leaseNumber), asc(leaseScheduleLines.sequence))
      .$dynamic();
    return options.lock ? query.for('update', { of: leaseScheduleLines }) : query;
  }

  private viewQuery() {
    const reversal = sql<string | null>`(
      select r.document_number from journal_entries r where r.id = ${leaseRuns.reversalJournalEntryId}
    )`;
    return this.db
      .select({
        id: leaseRuns.id,
        companyId: leaseRuns.companyId,
        documentNumber: leaseRuns.documentNumber,
        periodEnd: leaseRuns.periodEnd,
        description: leaseRuns.description,
        status: leaseRuns.status,
        currency: leaseRuns.currency,
        interestTotal: leaseRuns.interestTotal,
        depreciationTotal: leaseRuns.depreciationTotal,
        lineCount: leaseRuns.lineCount,
        leaseCount: leaseRuns.leaseCount,
        journalEntryId: leaseRuns.journalEntryId,
        reversalJournalEntryId: leaseRuns.reversalJournalEntryId,
        reversedAt: leaseRuns.reversedAt,
        reversalReason: leaseRuns.reversalReason,
        createdBy: leaseRuns.createdBy,
        createdAt: leaseRuns.createdAt,
        updatedAt: leaseRuns.updatedAt,
        journalNumber: journalEntries.documentNumber,
        reversalJournalNumber: reversal,
        createdByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(leaseRuns)
      .leftJoin(journalEntries, eq(journalEntries.id, leaseRuns.journalEntryId))
      .leftJoin(users, eq(users.id, leaseRuns.createdBy))
      .$dynamic();
  }
}
