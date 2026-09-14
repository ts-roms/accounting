import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { FxSide, PaginatedResult } from '@accounting/types';
import type { CreateFxRevaluationInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  fxAdjustments,
  fxRevaluations,
  invoices,
  journalEntries,
  journalLines,
  vendorBills,
  type FxRevaluation,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ExchangeRatesService } from './exchange-rates.service';
import { realizedFx } from './fx.logic';

const MODULE = 'FX';

export interface RealizedFxInput {
  companyId: string;
  side: FxSide;
  entryDate: string;
  /** Settled amount in the document currency. */
  amount: Money;
  documentRate: string;
  settlementRate: string;
  baseCurrency: string;
  description: string;
  sourceType: string;
  sourceId: string;
  actorId: string;
  branchId?: string | null;
}

export interface FxRevaluationView extends FxRevaluation {
  journalNumber: string | null;
  reversalJournalNumber: string | null;
}

/**
 * Foreign-exchange effects on the receivable / payable controls.
 *
 * Realized: when a payment settles a document booked at another rate, the
 * difference is posted against the control (so the control carries exactly the
 * settled base amount) with the other side on realized FX gain / loss.
 *
 * Unrealized: a period-end revaluation restates every open foreign-currency
 * document at the closing rate (ADJUSTING entry) and reverses itself on the
 * next day, so the control never drifts from Σ open x document rate.
 * Every effect is recorded in `fx_adjustments`, which the subledger
 * reconciliation adds to document / payment base amounts.
 */
@Injectable()
export class FxService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly rates: ExchangeRatesService,
  ) {}

  /**
   * Posts the realized difference for one settlement (no-op when rates agree).
   * Returns the signed effect on the control account in base (positive = debit).
   */
  async postRealized(tx: DbExecutor, input: RealizedFxInput): Promise<Money> {
    const gain = realizedFx(
      input.amount,
      input.documentRate,
      input.settlementRate,
      input.baseCurrency,
      input.side,
    );
    return this.postRealizedGain(tx, { ...input, gain });
  }

  /**
   * Total realized gain (signed base) of settling allocations booked at their
   * document rates with a payment / credit at `settlementRate`.
   */
  settlementGain(
    allocations: ReadonlyArray<{ amount: string; documentRate: string; currency: string }>,
    settlementRate: string,
    baseCurrency: string,
    side: FxSide,
  ): Money {
    return Money.sum(
      allocations.map((a) =>
        realizedFx(
          Money.of(a.amount, a.currency),
          a.documentRate,
          settlementRate,
          baseCurrency,
          side,
        ),
      ),
      baseCurrency,
    );
  }

  /** Journal lines for a realized gain / loss (the control side is carried by the caller's entry). */
  async realizedLines(tx: DbExecutor, companyId: string, gain: Money): Promise<PostingLine[]> {
    if (gain.isZero()) return [];
    const fxAccount = await this.accounts.resolveMapped(
      companyId,
      gain.isPositive() ? 'FX_GAIN' : 'FX_LOSS',
      tx,
    );
    const magnitude = gain.abs().toString();
    return [
      {
        accountId: fxAccount.id,
        debit: gain.isNegative() ? magnitude : '0',
        credit: gain.isPositive() ? magnitude : '0',
        description: gain.isPositive() ? 'Realized FX gain' : 'Realized FX loss',
      },
    ];
  }

  /** Posts a standalone realized-FX entry against the control and records the adjustment. */
  async postRealizedGain(
    tx: DbExecutor,
    input: Omit<RealizedFxInput, 'amount' | 'documentRate' | 'settlementRate'> & { gain: Money },
  ): Promise<Money> {
    const gain = input.gain;
    if (gain.isZero()) return Money.zero(input.baseCurrency);
    const control = await this.accounts.resolveMapped(
      input.companyId,
      input.side === 'AR' ? 'ACCOUNTS_RECEIVABLE' : 'ACCOUNTS_PAYABLE',
      tx,
    );
    const fxAccount = await this.accounts.resolveMapped(
      input.companyId,
      gain.isPositive() ? 'FX_GAIN' : 'FX_LOSS',
      tx,
    );
    const magnitude = gain.abs().toString();
    // A gain always debits the control (more receivable / less payable in base); a loss credits it.
    const controlDebit = gain.isPositive();
    const entry = await this.posting.postEvent(tx, {
      companyId: input.companyId,
      entryDate: input.entryDate,
      description: input.description,
      reference: null,
      journalType: 'GENERAL',
      branchId: input.branchId ?? null,
      sourceType: 'FX_REALIZED',
      sourceId: input.sourceId,
      actorId: input.actorId,
      lines: [
        {
          accountId: control.id,
          debit: controlDebit ? magnitude : '0',
          credit: controlDebit ? '0' : magnitude,
          description: `Realized FX on ${input.side === 'AR' ? 'receivable' : 'payable'} settlement`,
        },
        {
          accountId: fxAccount.id,
          debit: controlDebit ? '0' : magnitude,
          credit: controlDebit ? magnitude : '0',
          description: gain.isPositive() ? 'Realized FX gain' : 'Realized FX loss',
        },
      ],
    });
    const effect = controlDebit ? gain.abs() : gain.abs().negate();
    await tx.insert(fxAdjustments).values({
      companyId: input.companyId,
      side: input.side,
      adjustmentType: 'REALIZED',
      adjustmentDate: input.entryDate,
      amount: effect.toString(),
      journalEntryId: entry.id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    });
    return effect;
  }

  /** Reverses every realized adjustment of a source (payment / credit application void). */
  async reverseRealized(
    tx: DbExecutor,
    companyId: string,
    sourceType: string,
    sourceId: string,
    entryDate: string,
    actorId: string,
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(fxAdjustments)
      .where(
        and(
          eq(fxAdjustments.companyId, companyId),
          eq(fxAdjustments.sourceType, sourceType),
          eq(fxAdjustments.sourceId, sourceId),
          eq(fxAdjustments.adjustmentType, 'REALIZED'),
        ),
      );
    for (const row of rows) {
      const originalLines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, row.journalEntryId))
        .orderBy(asc(journalLines.lineNumber));
      const reversal = await this.posting.postEvent(tx, {
        companyId,
        entryDate,
        description: 'Reversal of realized FX',
        reference: null,
        journalType: 'REVERSAL',
        sourceType: `${sourceType}_VOID`,
        sourceId,
        reversalOfId: row.journalEntryId,
        actorId,
        lines: originalLines.map((l) => ({
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
          description: l.description,
          branchId: l.branchId,
        })),
      });
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, row.journalEntryId));
      await tx
        .insert(fxAdjustments)
        .values({
          companyId,
          side: row.side,
          adjustmentType: 'REALIZED',
          adjustmentDate: entryDate,
          amount: Money.of(row.amount, 'BASE').negate().toString(),
          journalEntryId: reversal.id,
          sourceType: `${sourceType}_VOID`,
          sourceId,
        });
    }
  }

  /** Signed control effect of all adjustments on one side up to a date (for reconciliation). */
  async adjustmentsAsOf(
    companyId: string,
    side: FxSide,
    asOf: string,
    executor: DbExecutor = this.db,
  ): Promise<string> {
    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${fxAdjustments.amount}), 0)` })
      .from(fxAdjustments)
      .where(
        and(
          eq(fxAdjustments.companyId, companyId),
          eq(fxAdjustments.side, side),
          lte(fxAdjustments.adjustmentDate, asOf),
        ),
      );
    return row?.total ?? '0';
  }

  // ------------------------------------------------------------ revaluation

  async list(
    companyId: string,
    query: { page: number; pageSize: number },
  ): Promise<PaginatedResult<FxRevaluationView>> {
    const where = eq(fxRevaluations.companyId, companyId);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(fxRevaluations.asOfDate), desc(fxRevaluations.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(fxRevaluations)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<FxRevaluationView> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(fxRevaluations.id, id), eq(fxRevaluations.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('FX revaluation', id);
    return row;
  }

  /** Preview of what a revaluation would post, without posting. */
  async preview(companyId: string, asOfDate: string, executor: DbExecutor = this.db) {
    const ctx = await this.rates.companyContext(companyId, executor);
    const open = await this.openForeignItems(executor, companyId, ctx.baseCurrency, asOfDate);
    const lines = [];
    for (const item of open) {
      const closingRate = await this.rates.rateFor(
        ctx.organizationId,
        item.currency,
        ctx.baseCurrency,
        asOfDate,
        executor,
      );
      const openAmount = Money.of(item.open, item.currency);
      const adjustment = openAmount
        .convert(ctx.baseCurrency, closingRate)
        .subtract(openAmount.convert(ctx.baseCurrency, item.exchangeRate));
      if (adjustment.isZero()) continue;
      lines.push({
        side: item.side,
        documentId: item.id,
        documentNumber: item.documentNumber,
        currency: item.currency,
        openAmount: openAmount.toString(),
        documentRate: item.exchangeRate,
        closingRate,
        /** Signed change in the base value of the open item (positive = worth more base). */
        adjustment: adjustment.toString(),
      });
    }
    return { baseCurrency: ctx.baseCurrency, lines };
  }

  /**
   * Posts the revaluation as one ADJUSTING entry on `asOfDate` plus its
   * reversal on `reversalDate` (default: the next day), both in one transaction.
   */
  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateFxRevaluationInput,
  ): Promise<FxRevaluationView> {
    const id = await this.db.transaction(async (tx) => {
      const { baseCurrency, lines } = await this.preview(companyId, input.asOfDate, tx);
      if (lines.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `No open foreign-currency item moves at ${input.asOfDate} closing rates.`,
        );
      const reversalDate = input.reversalDate ?? nextDay(input.asOfDate);
      if (reversalDate <= input.asOfDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The reversal must be dated after the revaluation.',
        );
      const [existing] = await tx
        .select({ id: fxRevaluations.id })
        .from(fxRevaluations)
        .where(
          and(eq(fxRevaluations.companyId, companyId), eq(fxRevaluations.asOfDate, input.asOfDate)),
        );
      if (existing)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `A revaluation already exists for ${input.asOfDate}.`,
        );

      const ar = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE', tx);
      const ap = await this.accounts.resolveMapped(companyId, 'ACCOUNTS_PAYABLE', tx);
      const gainAcct = await this.accounts.resolveMapped(companyId, 'UNREALIZED_FX_GAIN', tx);
      const lossAcct = await this.accounts.resolveMapped(companyId, 'UNREALIZED_FX_LOSS', tx);
      // Control effect: AR moves with the item's value; AP moves against it (a bigger liability is a loss).
      let arEffect = Money.zero(baseCurrency);
      let apEffect = Money.zero(baseCurrency);
      let gain = Money.zero(baseCurrency);
      let loss = Money.zero(baseCurrency);
      for (const l of lines) {
        const adj = Money.of(l.adjustment, baseCurrency);
        if (l.side === 'AR') {
          arEffect = arEffect.add(adj);
          if (adj.isPositive()) gain = gain.add(adj);
          else loss = loss.add(adj.abs());
        } else {
          apEffect = apEffect.add(adj); // positive = liability grew (credit AP)
          if (adj.isPositive()) loss = loss.add(adj);
          else gain = gain.add(adj.abs());
        }
      }
      const build = (sign: 1 | -1) => {
        const out = [];
        const arAmt = sign === 1 ? arEffect : arEffect.negate();
        const apAmt = sign === 1 ? apEffect : apEffect.negate();
        const g = sign === 1 ? gain : gain.negate();
        const lo = sign === 1 ? loss : loss.negate();
        if (!arAmt.isZero())
          out.push({
            accountId: ar.id,
            debit: arAmt.isPositive() ? arAmt.toString() : '0',
            credit: arAmt.isNegative() ? arAmt.abs().toString() : '0',
            description: 'Revaluation of open receivables',
          });
        if (!apAmt.isZero())
          out.push({
            accountId: ap.id,
            debit: apAmt.isNegative() ? apAmt.abs().toString() : '0',
            credit: apAmt.isPositive() ? apAmt.toString() : '0',
            description: 'Revaluation of open payables',
          });
        if (!g.isZero())
          out.push({
            accountId: gainAcct.id,
            debit: g.isNegative() ? g.abs().toString() : '0',
            credit: g.isPositive() ? g.toString() : '0',
            description: 'Unrealized FX gain',
          });
        if (!lo.isZero())
          out.push({
            accountId: lossAcct.id,
            debit: lo.isPositive() ? lo.toString() : '0',
            credit: lo.isNegative() ? lo.abs().toString() : '0',
            description: 'Unrealized FX loss',
          });
        return out;
      };
      const runNumber = await this.numbering.allocate(
        companyId,
        'FXR',
        Number(input.asOfDate.slice(0, 4)),
        tx,
      );
      const [run] = await tx
        .insert(fxRevaluations)
        .values({
          companyId,
          runNumber,
          asOfDate: input.asOfDate,
          reversalDate,
          currency: baseCurrency,
          lines,
          unrealizedGain: gain.toString(),
          unrealizedLoss: loss.toString(),
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning();
      const entry = await this.posting.postEvent(tx, {
        companyId,
        entryDate: input.asOfDate,
        description: `FX revaluation ${runNumber} at ${input.asOfDate} closing rates`,
        reference: runNumber,
        journalType: 'ADJUSTING',
        sourceType: 'FX_REVALUATION',
        sourceId: run!.id,
        actorId: actor.id,
        lines: build(1),
      });
      const reversal = await this.posting.postEvent(tx, {
        companyId,
        entryDate: reversalDate,
        description: `Reversal of FX revaluation ${runNumber}`,
        reference: runNumber,
        journalType: 'REVERSAL',
        sourceType: 'FX_REVALUATION_REVERSAL',
        sourceId: run!.id,
        reversalOfId: entry.id,
        actorId: actor.id,
        lines: build(-1),
      });
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, entry.id));
      await tx
        .update(fxRevaluations)
        .set({ journalEntryId: entry.id, reversalJournalEntryId: reversal.id })
        .where(eq(fxRevaluations.id, run!.id));
      const adjRows = [];
      if (!arEffect.isZero()) {
        adjRows.push({
          side: 'AR' as const,
          adjustmentType: 'REVALUATION' as const,
          adjustmentDate: input.asOfDate,
          amount: arEffect.toString(),
          journalEntryId: entry.id,
        });
        adjRows.push({
          side: 'AR' as const,
          adjustmentType: 'REVALUATION_REVERSAL' as const,
          adjustmentDate: reversalDate,
          amount: arEffect.negate().toString(),
          journalEntryId: reversal.id,
        });
      }
      if (!apEffect.isZero()) {
        // AP effect is expressed as a credit; the control-effect convention is positive = debit.
        adjRows.push({
          side: 'AP' as const,
          adjustmentType: 'REVALUATION' as const,
          adjustmentDate: input.asOfDate,
          amount: apEffect.negate().toString(),
          journalEntryId: entry.id,
        });
        adjRows.push({
          side: 'AP' as const,
          adjustmentType: 'REVALUATION_REVERSAL' as const,
          adjustmentDate: reversalDate,
          amount: apEffect.toString(),
          journalEntryId: reversal.id,
        });
      }
      await tx
        .insert(fxAdjustments)
        .values(
          adjRows.map((r) => ({
            ...r,
            companyId,
            sourceType: 'FX_REVALUATION',
            sourceId: run!.id,
          })),
        );
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'FxRevaluation',
          entityId: run!.id,
          newValue: {
            runNumber,
            asOfDate: input.asOfDate,
            gain: gain.toString(),
            loss: loss.toString(),
            items: lines.length,
          },
          metadata: { actor: actor.email, journalNumber: entry.documentNumber },
          companyId,
        },
        tx,
      );
      return run!.id;
    });
    return this.get(companyId, id);
  }

  // ----------------------------------------------------------------- helpers

  private async openForeignItems(
    executor: DbExecutor,
    companyId: string,
    baseCurrency: string,
    asOf: string,
  ) {
    const docFilters = (t: typeof invoices | typeof vendorBills): SQL[] => [
      eq(t.companyId, companyId),
      ne(t.currency, baseCurrency),
      eq(t.accountingStatus, 'POSTED'),
      inArray(t.status, ['APPROVED', 'PARTIALLY_PAID']),
      lte(t.documentDate, asOf),
      inArray(t.documentType, ['INVOICE', 'DEBIT_NOTE']),
    ];
    const ar = await executor
      .select({
        id: invoices.id,
        documentNumber: invoices.documentNumber,
        currency: invoices.currency,
        exchangeRate: invoices.exchangeRate,
        total: invoices.total,
        allocated: invoices.allocatedAmount,
      })
      .from(invoices)
      .where(and(...docFilters(invoices)));
    const ap = await executor
      .select({
        id: vendorBills.id,
        documentNumber: vendorBills.documentNumber,
        currency: vendorBills.currency,
        exchangeRate: vendorBills.exchangeRate,
        total: vendorBills.total,
        allocated: vendorBills.allocatedAmount,
      })
      .from(vendorBills)
      .where(and(...docFilters(vendorBills)));
    const openOf = (r: { total: string; allocated: string; currency: string }) =>
      Money.of(r.total, r.currency).subtract(Money.of(r.allocated, r.currency)).toString();
    return [
      ...ar.map((r) => ({ side: 'AR' as const, ...r, open: openOf(r) })),
      ...ap.map((r) => ({ side: 'AP' as const, ...r, open: openOf(r) })),
    ].filter((r) => Number(r.open) > 0);
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(fxRevaluations),
        journalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${sql.raw('"fx_revaluations"."journal_entry_id"')})`,
        reversalJournalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${sql.raw('"fx_revaluations"."reversal_journal_entry_id"')})`,
      })
      .from(fxRevaluations);
  }
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
