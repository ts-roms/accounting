import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type { CreateDepreciationRunInput, ListDepreciationRunsQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  assetEvents,
  companies,
  depreciationRuns,
  fiscalPeriods,
  fiscalYears,
  fixedAssets,
  journalEntries,
  type DepreciationRun,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { monthlyDepreciation } from './depreciation';
import { FixedAssetsService } from './fixed-assets.service';

const MODULE = 'FIXED_ASSETS';

export interface RunLine {
  assetId: string;
  assetNumber: string;
  name: string;
  amount: string;
  accumulatedAfter: string;
  bookValueAfter: string;
  fullyDepreciated: boolean;
}

export interface DepreciationRunView extends DepreciationRun {
  periodName: string;
  periodStart: string;
  periodEnd: string;
  journalNumber: string | null;
}

export interface DepreciationRunDetail extends DepreciationRunView {
  lines: RunLine[];
}

/**
 * One depreciation posting per fiscal period. A draft run is a live preview;
 * posting computes each active asset's monthly charge, writes the asset events,
 * updates the register and posts a single journal (Dr depreciation expense /
 * Cr accumulated depreciation, aggregated per account pair). Runs post in
 * period order; only the latest posted run can be reversed.
 */
@Injectable()
export class DepreciationRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly assets: FixedAssetsService,
  ) {}

  async list(
    companyId: string,
    query: ListDepreciationRunsQuery,
  ): Promise<PaginatedResult<DepreciationRunView>> {
    const filters: SQL[] = [eq(depreciationRuns.companyId, companyId)];
    if (query.status) filters.push(eq(depreciationRuns.status, query.status));
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(fiscalPeriods.startDate), desc(depreciationRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(depreciationRuns)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<DepreciationRunDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(depreciationRuns.id, id), eq(depreciationRuns.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Depreciation run', id);
    const lines =
      row.status === 'DRAFT'
        ? await this.preview(companyId, row.fiscalPeriodId, this.db)
        : await this.postedLines(id);
    return { ...row, lines };
  }

  previewForCompany(companyId: string, fiscalPeriodId: string): Promise<RunLine[]> {
    return this.preview(companyId, fiscalPeriodId, this.db);
  }

  /** Assets that would depreciate in the period and the amounts they would take. */
  async preview(
    companyId: string,
    fiscalPeriodId: string,
    executor: DbExecutor,
  ): Promise<RunLine[]> {
    const period = await this.period(companyId, fiscalPeriodId, executor);
    const candidates = await executor
      .select()
      .from(fixedAssets)
      .where(
        and(
          eq(fixedAssets.companyId, companyId),
          eq(fixedAssets.status, 'ACTIVE'),
          lte(fixedAssets.inServiceDate, period.endDate),
        ),
      )
      .orderBy(asc(fixedAssets.assetNumber));
    if (candidates.length === 0) return [];
    // Skip assets already depreciated in this period (or later).
    const done = await executor
      .select({ assetId: assetEvents.assetId })
      .from(assetEvents)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, assetEvents.fiscalPeriodId))
      .where(
        and(
          inArray(
            assetEvents.assetId,
            candidates.map((a) => a.id),
          ),
          eq(assetEvents.eventType, 'DEPRECIATION'),
          sql`${fiscalPeriods.startDate} >= ${period.startDate}`,
          sql`${assetEvents.amount} > 0`,
        ),
      );
    const skip = new Set(done.map((d) => d.assetId));
    const lines: RunLine[] = [];
    for (const asset of candidates) {
      if (skip.has(asset.id)) continue;
      const amount = monthlyDepreciation(asset, asset.currency);
      if (!amount.isPositive()) continue;
      const accumulated = Money.of(asset.accumulatedDepreciation, asset.currency).add(amount);
      const bookValue = Money.of(asset.cost, asset.currency).subtract(accumulated);
      lines.push({
        assetId: asset.id,
        assetNumber: asset.assetNumber,
        name: asset.name,
        amount: amount.toString(),
        accumulatedAfter: accumulated.toString(),
        bookValueAfter: bookValue.toString(),
        fullyDepreciated: bookValue.equals(Money.of(asset.salvageValue, asset.currency)),
      });
    }
    return lines;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateDepreciationRunInput,
  ): Promise<DepreciationRunDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: depreciationRuns.id })
          .from(depreciationRuns)
          .where(
            and(
              eq(depreciationRuns.companyId, companyId),
              eq(depreciationRuns.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const period = await this.period(companyId, input.fiscalPeriodId, tx);
      if (period.status !== 'OPEN')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNTING_PERIOD_CLOSED,
          `${period.name} is closed.`,
        );
      const [open] = await tx
        .select({ id: depreciationRuns.id })
        .from(depreciationRuns)
        .where(
          and(eq(depreciationRuns.companyId, companyId), eq(depreciationRuns.status, 'DRAFT')),
        );
      if (open)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Post or discard the existing draft run first.',
        );
      const [dup] = await tx
        .select({ id: depreciationRuns.id })
        .from(depreciationRuns)
        .where(
          and(
            eq(depreciationRuns.companyId, companyId),
            eq(depreciationRuns.fiscalPeriodId, period.id),
            ne(depreciationRuns.status, 'REVERSED'),
          ),
        );
      if (dup)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${period.name} already has a depreciation run.`,
        );
      // Period order: no posted run may sit after this period.
      const [later] = await tx
        .select({ id: depreciationRuns.id })
        .from(depreciationRuns)
        .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, depreciationRuns.fiscalPeriodId))
        .where(
          and(
            eq(depreciationRuns.companyId, companyId),
            eq(depreciationRuns.status, 'POSTED'),
            sql`${fiscalPeriods.startDate} > ${period.startDate}`,
          ),
        );
      if (later)
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_SEQUENCE_VIOLATION,
          'Depreciation has already been posted for a later period.',
        );
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const lines = await this.preview(companyId, period.id, tx);
      const runNumber = await this.numbering.allocate(
        companyId,
        'DEP',
        Number(period.endDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(depreciationRuns)
        .values({
          companyId,
          runNumber,
          fiscalPeriodId: period.id,
          runDate: period.endDate,
          currency,
          totalAmount: Money.sum(
            lines.map((l) => Money.of(l.amount, currency)),
            currency,
          ).toString(),
          assetCount: lines.length,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'DepreciationRun',
          entityId: created!.id,
          newValue: { runNumber, period: period.name, assets: lines.length },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      if (run.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${run.runNumber} is ${run.status}.`,
        );
      await tx.delete(depreciationRuns).where(eq(depreciationRuns.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'DepreciationRun',
          entityId: id,
          previousValue: { runNumber: run.runNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /** Computes, records and posts the period's depreciation. Idempotent on a posted run. */
  async post(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<DepreciationRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      if (run.status === 'POSTED') return;
      if (run.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${run.runNumber} is ${run.status}.`,
        );
      const period = await this.period(companyId, run.fiscalPeriodId, tx);
      await this.posting.resolvePeriod(tx, companyId, period.endDate, { draft: true });
      const lines = await this.preview(companyId, period.id, tx);
      if (lines.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `No active asset depreciates in ${period.name}.`,
        );
      const currency = run.currency;
      const byPair = new Map<string, { expense: string; accumulated: string; amount: Money }>();
      const eventRows: Array<typeof assetEvents.$inferInsert> = [];
      for (const line of lines) {
        const asset = await this.assets.lock(tx, companyId, line.assetId);
        const accts = await this.assets.resolveAccounts(companyId, asset.categoryId, tx);
        const key = `${accts.expense}:${accts.accumulated}`;
        const bucket = byPair.get(key) ?? {
          expense: accts.expense,
          accumulated: accts.accumulated,
          amount: Money.zero(currency),
        };
        bucket.amount = bucket.amount.add(Money.of(line.amount, currency));
        byPair.set(key, bucket);
        await tx
          .update(fixedAssets)
          .set({
            accumulatedDepreciation: line.accumulatedAfter,
            depreciatedMonths: asset.depreciatedMonths + 1,
            status: line.fullyDepreciated ? 'FULLY_DEPRECIATED' : asset.status,
          })
          .where(eq(fixedAssets.id, asset.id));
        eventRows.push({
          assetId: asset.id,
          eventType: 'DEPRECIATION',
          eventDate: period.endDate,
          amount: line.amount,
          bookValueAfter: line.bookValueAfter,
          depreciationRunId: run.id,
          fiscalPeriodId: period.id,
          createdBy: actor.id,
        });
      }
      const postingLines: PostingLine[] = [];
      for (const b of byPair.values()) {
        postingLines.push(
          {
            accountId: b.expense,
            debit: b.amount.toString(),
            credit: '0',
            description: `Depreciation ${period.name}`,
          },
          {
            accountId: b.accumulated,
            debit: '0',
            credit: b.amount.toString(),
            description: `Accumulated depreciation ${period.name}`,
          },
        );
      }
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: period.endDate,
          description: `Depreciation run ${run.runNumber} - ${period.name}`,
          reference: run.runNumber,
          journalType: 'ADJUSTING',
          branchId: null,
          sourceType: 'DEPRECIATION_RUN',
          sourceId: run.id,
          actor,
          lines: postingLines,
        },
        { permission: P['depreciation.run'] },
      );
      await tx
        .insert(assetEvents)
        .values(eventRows.map((e) => ({ ...e, journalEntryId: entry.id })));
      const total = Money.sum(
        lines.map((l) => Money.of(l.amount, currency)),
        currency,
      );
      await tx
        .update(depreciationRuns)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          totalAmount: total.toString(),
          assetCount: lines.length,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(depreciationRuns.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'DepreciationRun',
          entityId: id,
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            total: total.toString(),
            assets: lines.length,
          },
          metadata: { runNumber: run.runNumber, period: period.name },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Reverses the latest posted run: mirror journal, negative events, register restored. */
  async reverse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<DepreciationRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      if (run.status !== 'POSTED' || !run.journalEntryId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${run.runNumber} is not posted.`,
        );
      const period = await this.period(companyId, run.fiscalPeriodId, tx);
      const [later] = await tx
        .select({ id: depreciationRuns.id })
        .from(depreciationRuns)
        .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, depreciationRuns.fiscalPeriodId))
        .where(
          and(
            eq(depreciationRuns.companyId, companyId),
            eq(depreciationRuns.status, 'POSTED'),
            sql`${fiscalPeriods.startDate} > ${period.startDate}`,
          ),
        );
      if (later)
        throw new BusinessRuleError(
          ErrorCodes.PERIOD_SEQUENCE_VIOLATION,
          'Reverse later runs first.',
        );
      const events = await tx
        .select()
        .from(assetEvents)
        .where(and(eq(assetEvents.depreciationRunId, id), sql`${assetEvents.amount} > 0`));
      for (const e of events) {
        const asset = await this.assets.lock(tx, companyId, e.assetId);
        const accumulated = Money.of(asset.accumulatedDepreciation, asset.currency).subtract(
          Money.of(e.amount, asset.currency),
        );
        await tx
          .update(fixedAssets)
          .set({
            accumulatedDepreciation: accumulated.toString(),
            depreciatedMonths: Math.max(0, asset.depreciatedMonths - 1),
            status: asset.status === 'FULLY_DEPRECIATED' ? 'ACTIVE' : asset.status,
          })
          .where(eq(fixedAssets.id, asset.id));
      }
      const originalLines = await tx.query.journalLines.findMany({
        where: (l, ops) => ops.eq(l.journalEntryId, run.journalEntryId!),
        orderBy: (l, ops) => ops.asc(l.lineNumber),
      });
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: period.endDate,
          description: `Reverse depreciation run ${run.runNumber}: ${reason}`,
          reference: run.runNumber,
          journalType: 'REVERSAL',
          branchId: null,
          sourceType: 'DEPRECIATION_RUN_REVERSAL',
          sourceId: run.id,
          reversalOfId: run.journalEntryId,
          actor,
          lines: originalLines.map((l) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description,
            branchId: l.branchId,
          })),
        },
        { permission: P['depreciation.run'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, run.journalEntryId));
      await tx.insert(assetEvents).values(
        events.map((e) => ({
          assetId: e.assetId,
          eventType: 'DEPRECIATION' as const,
          eventDate: period.endDate,
          amount: Money.of(e.amount, run.currency).negate().toString(),
          bookValueAfter: Money.of(e.bookValueAfter, run.currency)
            .add(Money.of(e.amount, run.currency))
            .toString(),
          depreciationRunId: run.id,
          fiscalPeriodId: period.id,
          journalEntryId: reversal.id,
          notes: `Reversal: ${reason}`,
          createdBy: actor.id,
        })),
      );
      await tx
        .update(depreciationRuns)
        .set({ status: 'REVERSED', reversalJournalEntryId: reversal.id })
        .where(eq(depreciationRuns.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'DepreciationRun',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'REVERSED', reversalJournalEntryId: reversal.id },
          metadata: { runNumber: run.runNumber, reason },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Scheduled job entry point: for every company, draft (and, when configured,
   * post) the run for the fiscal period that ended before `asOf`.
   */
  async runScheduled(
    asOf: string,
    actor: AuthenticatedUser,
  ): Promise<
    Array<{ companyId: string; runId: string | null; posted: boolean; skipped?: string }>
  > {
    const results: Array<{
      companyId: string;
      runId: string | null;
      posted: boolean;
      skipped?: string;
    }> = [];
    const companyRows = await this.db.select({ id: companies.id }).from(companies);
    for (const { id: companyId } of companyRows) {
      const [fp] = await this.db
        .select({ ...getTableColumns(fiscalPeriods) })
        .from(fiscalPeriods)
        .innerJoin(fiscalYears, eq(fiscalYears.id, fiscalPeriods.fiscalYearId))
        .where(
          and(
            eq(fiscalYears.companyId, companyId),
            sql`${fiscalPeriods.endDate} < ${asOf}`,
            eq(fiscalPeriods.status, 'OPEN'),
          ),
        )
        .orderBy(desc(fiscalPeriods.endDate))
        .limit(1);
      if (!fp) {
        results.push({
          companyId,
          runId: null,
          posted: false,
          skipped: 'no open period before the run date',
        });
        continue;
      }
      const [existing] = await this.db
        .select({ id: depreciationRuns.id, status: depreciationRuns.status })
        .from(depreciationRuns)
        .where(
          and(
            eq(depreciationRuns.companyId, companyId),
            eq(depreciationRuns.fiscalPeriodId, fp.id),
            ne(depreciationRuns.status, 'REVERSED'),
          ),
        );
      if (existing) {
        results.push({
          companyId,
          runId: existing.id,
          posted: existing.status === 'POSTED',
          skipped: 'run already exists',
        });
        continue;
      }
      try {
        const preview = await this.preview(companyId, fp.id, this.db);
        if (preview.length === 0) {
          results.push({ companyId, runId: null, posted: false, skipped: 'nothing to depreciate' });
          continue;
        }
        const run = await this.create(companyId, actor, {
          fiscalPeriodId: fp.id,
          idempotencyKey: `auto:${companyId}:${fp.id}`,
        });
        const settings = await this.assets.settings(companyId);
        if (settings.autoPostDepreciation) {
          await this.post(companyId, actor, run.id);
          results.push({ companyId, runId: run.id, posted: true });
        } else {
          results.push({ companyId, runId: run.id, posted: false });
        }
      } catch (err) {
        results.push({
          companyId,
          runId: null,
          posted: false,
          skipped: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  // ----------------------------------------------------------------- helpers

  private async postedLines(runId: string): Promise<RunLine[]> {
    const rows = await this.db
      .select({
        event: assetEvents,
        assetNumber: fixedAssets.assetNumber,
        name: fixedAssets.name,
        salvage: fixedAssets.salvageValue,
        currency: fixedAssets.currency,
      })
      .from(assetEvents)
      .innerJoin(fixedAssets, eq(fixedAssets.id, assetEvents.assetId))
      .where(and(eq(assetEvents.depreciationRunId, runId), sql`${assetEvents.amount} > 0`))
      .orderBy(asc(fixedAssets.assetNumber));
    return rows.map((r) => ({
      assetId: r.event.assetId,
      assetNumber: r.assetNumber,
      name: r.name,
      amount: r.event.amount,
      accumulatedAfter: '',
      bookValueAfter: r.event.bookValueAfter,
      fullyDepreciated: Money.of(r.event.bookValueAfter, r.currency).equals(
        Money.of(r.salvage, r.currency),
      ),
    }));
  }

  private async period(companyId: string, id: string, executor: DbExecutor) {
    const [row] = await executor
      .select({ ...getTableColumns(fiscalPeriods) })
      .from(fiscalPeriods)
      .innerJoin(fiscalYears, eq(fiscalYears.id, fiscalPeriods.fiscalYearId))
      .where(and(eq(fiscalPeriods.id, id), eq(fiscalYears.companyId, companyId)));
    if (!row) throw new NotFoundError('Fiscal period', id);
    return row;
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<DepreciationRun> {
    const [row] = await tx
      .select()
      .from(depreciationRuns)
      .where(and(eq(depreciationRuns.id, id), eq(depreciationRuns.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Depreciation run', id);
    return row;
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(depreciationRuns),
        periodName: fiscalPeriods.name,
        periodStart: fiscalPeriods.startDate,
        periodEnd: fiscalPeriods.endDate,
        journalNumber: sql<
          string | null
        >`(select je.document_number from journal_entries je where je.id = ${depreciationRuns.journalEntryId})`,
      })
      .from(depreciationRuns)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, depreciationRuns.fiscalPeriodId))
      .$dynamic();
  }
}
