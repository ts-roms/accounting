import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  lte,
  ne,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PermissionKey, type FxSide, type PaginatedResult } from '@accounting/types';
import type { CreateFxRevaluationInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  fxAdjustments,
  fxRevaluations,
  invoices,
  journalEntries,
  journalLines,
  leases,
  vendorBills,
  type FxRevaluation,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingActor,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ExchangeRatesService } from './exchange-rates.service';
import { realizedFx } from './fx.logic';

const MODULE = 'FX';

/** One revalued monetary item, as stored on the run. */
type RevaluationLine = NonNullable<(typeof fxRevaluations.$inferSelect)['lines']>[number];

/** Realized differences arise on settling receivables or payables. */
export type SettlementSide = Extract<FxSide, 'AR' | 'AP'>;

export interface RealizedFxInput {
  companyId: string;
  side: SettlementSide;
  entryDate: string;
  /** Settled amount in the document currency. */
  amount: Money;
  documentRate: string;
  settlementRate: string;
  baseCurrency: string;
  description: string;
  /** The settled document / payment (what a void later reverses). */
  sourceType: string;
  sourceId: string;
  /**
   * Unique id of this settlement event (an allocation row). Several
   * allocations of one payment each post their own FX entry, so the journal
   * identity must not be the payment.
   */
  eventId: string;
  actor: PostingActor;
  /** Posting authority of the calling module (e.g. customer-payment.post). */
  permission: PermissionKey;
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
    private readonly ledger: GeneralLedgerService,
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
    side: SettlementSide,
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
    const entry = await this.posting.postEvent(
      tx,
      {
        companyId: input.companyId,
        entryDate: input.entryDate,
        description: input.description,
        reference: null,
        journalType: 'GENERAL',
        branchId: input.branchId ?? null,
        sourceType: 'FX_REALIZED',
        sourceId: input.eventId,
        actor: input.actor,
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
      },
      { permission: input.permission },
    );
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
    actor: PostingActor,
    permission: PermissionKey,
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
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate,
          description: 'Reversal of realized FX',
          reference: null,
          journalType: 'REVERSAL',
          // One reversal per realized entry: keyed by the entry it reverses.
          sourceType: 'FX_REALIZED_VOID',
          sourceId: row.journalEntryId,
          reversalOfId: row.journalEntryId,
          actor,
          lines: originalLines.map((l) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description,
            branchId: l.branchId,
          })),
        },
        { permission },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, row.journalEntryId));
      await tx.insert(fxAdjustments).values({
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
    const lines: RevaluationLine[] = [];
    const closingRates = new Map<string, string>();
    const closingRate = async (currency: string) => {
      if (!closingRates.has(currency))
        closingRates.set(
          currency,
          await this.rates.rateFor(
            ctx.organizationId,
            currency,
            ctx.baseCurrency,
            asOfDate,
            executor,
          ),
        );
      return closingRates.get(currency)!;
    };
    for (const item of open) {
      const rate = await closingRate(item.currency);
      const openAmount = Money.of(item.open, item.currency);
      const adjustment = openAmount
        .convert(ctx.baseCurrency, rate)
        .subtract(openAmount.convert(ctx.baseCurrency, item.exchangeRate));
      if (adjustment.isZero()) continue;
      lines.push({
        side: item.side,
        documentId: item.id,
        documentNumber: item.documentNumber,
        currency: item.currency,
        openAmount: openAmount.toString(),
        documentRate: item.exchangeRate,
        closingRate: rate,
        /** Signed change in the base value of the open item (positive = worth more base). */
        adjustment: adjustment.toString(),
      });
    }
    // Foreign-currency bank balances and lease liabilities: carried at the base of their
    // history, restated to foreign balance x closing rate.
    for (const item of await this.foreignBalances(
      executor,
      companyId,
      ctx.baseCurrency,
      asOfDate,
    )) {
      const rate = await closingRate(item.currency);
      const foreign = Money.of(item.foreign, item.currency);
      const carrying = Money.of(item.base, ctx.baseCurrency);
      const adjustment = foreign.convert(ctx.baseCurrency, rate).subtract(carrying);
      if (adjustment.isZero()) continue;
      lines.push({
        side: item.side,
        documentId: item.id,
        documentNumber: item.documentNumber,
        accountId: item.accountId,
        currency: item.currency,
        openAmount: foreign.toString(),
        documentRate: foreign.isZero()
          ? rate
          : Money.of(carrying.toString(), ctx.baseCurrency, 8)
              .divide(foreign.toString())
              .toString(),
        closingRate: rate,
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
      // Asset (BANK) and liability (LEASE) balances, per GL account: value change in base.
      const assetEffects = new Map<string, { amount: Money; currency: string; label: string }>();
      const liabilityEffects = new Map<string, { amount: Money; label: string }>();
      for (const l of lines) {
        const adj = Money.of(l.adjustment, baseCurrency);
        if (l.side === 'AR') {
          arEffect = arEffect.add(adj);
          if (adj.isPositive()) gain = gain.add(adj);
          else loss = loss.add(adj.abs());
        } else if (l.side === 'AP') {
          apEffect = apEffect.add(adj); // positive = liability grew (credit AP)
          if (adj.isPositive()) loss = loss.add(adj);
          else gain = gain.add(adj.abs());
        } else if (l.side === 'BANK') {
          const cur = assetEffects.get(l.accountId!) ?? {
            amount: Money.zero(baseCurrency),
            currency: l.currency,
            label: l.documentNumber,
          };
          assetEffects.set(l.accountId!, { ...cur, amount: cur.amount.add(adj) });
          if (adj.isPositive()) gain = gain.add(adj);
          else loss = loss.add(adj.abs());
        } else {
          const cur = liabilityEffects.get(l.accountId!) ?? {
            amount: Money.zero(baseCurrency),
            label: 'lease liabilities',
          };
          liabilityEffects.set(l.accountId!, { ...cur, amount: cur.amount.add(adj) });
          if (adj.isPositive()) loss = loss.add(adj);
          else gain = gain.add(adj.abs());
        }
      }
      const build = (sign: 1 | -1) => {
        const out: PostingLine[] = [];
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
        for (const [accountId, e] of assetEffects) {
          const amt = sign === 1 ? e.amount : e.amount.negate();
          // The bank account is bound to its currency: the line carries a zero foreign
          // amount (the balance in that currency does not move, only its base value).
          out.push({
            accountId,
            debit: amt.isPositive() ? amt.toString() : '0',
            credit: amt.isNegative() ? amt.abs().toString() : '0',
            description: `Revaluation of ${e.label} (${e.currency})`,
            foreignDebit: '0',
            foreignCredit: '0',
            foreignCurrency: e.currency,
          });
        }
        for (const [accountId, e] of liabilityEffects) {
          const amt = sign === 1 ? e.amount : e.amount.negate();
          out.push({
            accountId,
            debit: amt.isNegative() ? amt.abs().toString() : '0',
            credit: amt.isPositive() ? amt.toString() : '0',
            description: `Revaluation of ${e.label}`,
          });
        }
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
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.asOfDate,
          description: `FX revaluation ${runNumber} at ${input.asOfDate} closing rates`,
          reference: runNumber,
          journalType: 'ADJUSTING',
          sourceType: 'FX_REVALUATION',
          sourceId: run!.id,
          actor,
          lines: build(1),
        },
        { permission: P['fx.revalue'] },
      );
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: reversalDate,
          description: `Reversal of FX revaluation ${runNumber}`,
          reference: runNumber,
          journalType: 'REVERSAL',
          sourceType: 'FX_REVALUATION_REVERSAL',
          sourceId: run!.id,
          reversalOfId: entry.id,
          actor,
          lines: build(-1),
        },
        { permission: P['fx.revalue'] },
      );
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
      const bankEffect = [...assetEffects.values()].reduce(
        (acc, e) => acc.add(e.amount),
        Money.zero(baseCurrency),
      );
      if (!bankEffect.isZero()) {
        adjRows.push(
          {
            side: 'BANK' as const,
            adjustmentType: 'REVALUATION' as const,
            adjustmentDate: input.asOfDate,
            amount: bankEffect.toString(),
            journalEntryId: entry.id,
          },
          {
            side: 'BANK' as const,
            adjustmentType: 'REVALUATION_REVERSAL' as const,
            adjustmentDate: reversalDate,
            amount: bankEffect.negate().toString(),
            journalEntryId: reversal.id,
          },
        );
      }
      const leaseEffect = [...liabilityEffects.values()].reduce(
        (acc, e) => acc.add(e.amount),
        Money.zero(baseCurrency),
      );
      if (!leaseEffect.isZero()) {
        // Recorded as the change in the credit balance (a bigger liability = positive), the
        // figure the lease integrity check subtracts from the ledger.
        adjRows.push(
          {
            side: 'LEASE' as const,
            adjustmentType: 'REVALUATION' as const,
            adjustmentDate: input.asOfDate,
            amount: leaseEffect.toString(),
            journalEntryId: entry.id,
          },
          {
            side: 'LEASE' as const,
            adjustmentType: 'REVALUATION_REVERSAL' as const,
            adjustmentDate: reversalDate,
            amount: leaseEffect.negate().toString(),
            journalEntryId: reversal.id,
          },
        );
      }
      await tx.insert(fxAdjustments).values(
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

  /**
   * Foreign-currency balances carried at historical base: bank GL accounts bound
   * to a currency (foreign balance = sum of the foreign amounts on their lines)
   * and active finance leases in a foreign currency (the register's balances).
   */
  private async foreignBalances(
    executor: DbExecutor,
    companyId: string,
    baseCurrency: string,
    asOf: string,
  ): Promise<
    Array<{
      side: 'BANK' | 'LEASE';
      id: string;
      documentNumber: string;
      accountId: string;
      currency: string;
      foreign: string;
      base: string;
    }>
  > {
    const out: Array<{
      side: 'BANK' | 'LEASE';
      id: string;
      documentNumber: string;
      accountId: string;
      currency: string;
      foreign: string;
      base: string;
    }> = [];
    const bound = await executor
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        currency: accounts.currency,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.companyId, companyId),
          isNotNull(accounts.currency),
          ne(accounts.currency, baseCurrency),
          eq(accounts.status, 'ACTIVE'),
        ),
      );
    if (bound.length) {
      const ids = bound.map((a) => a.id);
      const [base, foreign] = await Promise.all([
        this.ledger.activity({ companyId, to: asOf, accountIds: ids }, executor),
        this.ledger.foreignActivity({ companyId, to: asOf, accountIds: ids }, executor),
      ]);
      // Revaluations reverse the next day, but one dated on or before asOf that has not yet
      // reversed sits in the base balance: take it out so the carrying is the settled base.
      for (const a of bound) {
        const b = base.find((x) => x.accountId === a.id);
        const f = foreign.find((x) => x.accountId === a.id && x.currency === a.currency);
        const foreignBalance = Money.of(f?.foreignDebit ?? '0', a.currency!).subtract(
          Money.of(f?.foreignCredit ?? '0', a.currency!),
        );
        const baseBalance = Money.of(b?.debit ?? '0', baseCurrency).subtract(
          Money.of(b?.credit ?? '0', baseCurrency),
        );
        if (foreignBalance.isZero() && baseBalance.isZero()) continue;
        out.push({
          side: 'BANK',
          id: a.id,
          documentNumber: `${a.code} ${a.name}`,
          accountId: a.id,
          currency: a.currency!,
          foreign: foreignBalance.toString(),
          base: baseBalance.toString(),
        });
      }
    }
    const fxLeases = await executor
      .select({
        id: leases.id,
        leaseNumber: leases.leaseNumber,
        currency: leases.currency,
        liabilityBalance: leases.liabilityBalance,
        liabilityBalanceBase: leases.liabilityBalanceBase,
        liabilityAccountId: leases.liabilityAccountId,
      })
      .from(leases)
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          eq(leases.classification, 'FINANCE'),
          ne(leases.currency, baseCurrency),
          lte(leases.commencementDate, asOf),
        ),
      );
    if (fxLeases.length) {
      const mapped = await this.accounts.resolveMapped(companyId, 'LEASE_LIABILITY', executor);
      for (const l of fxLeases) {
        if (Money.of(l.liabilityBalance, l.currency).isZero()) continue;
        out.push({
          side: 'LEASE',
          id: l.id,
          documentNumber: l.leaseNumber,
          accountId: l.liabilityAccountId ?? mapped.id,
          currency: l.currency,
          foreign: l.liabilityBalance,
          base: l.liabilityBalanceBase,
        });
      }
    }
    return out;
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
