import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { TaxSide, TaxSourceType } from '@accounting/types';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { taxCodes, taxRates, taxTransactions, type TaxCode, type TaxRate } from '@/database/schema';
import type { PostingLine } from '@/modules/accounting/journals/posting.service';
import { extractInclusiveTax, resolveRate, taxOn } from './tax.logic';

/** What a document line needs to carry for the engine. */
export interface TaxableLine {
  amount: string;
  taxCodeId?: string | null;
  withholdingTaxCodeId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}

export interface TaxedLine {
  taxCodeId: string | null;
  taxRate: string;
  taxAmount: string;
  withholdingTaxCodeId: string | null;
  withholdingRate: string;
  withholdingAmount: string;
}

export interface TaxTotals {
  taxTotal: Money;
  withholdingTotal: Money;
}

/** Stored line fields the posting step needs. */
export interface StoredTaxedLine extends TaxedLine {
  id: string;
  amount: string;
  branchId: string | null;
}

export interface TaxRecordContext {
  companyId: string;
  side: TaxSide;
  sourceType: TaxSourceType;
  sourceId: string;
  documentNumber: string;
  journalEntryId: string;
  transactionDate: string;
  party: { id: string | null; name: string | null; taxNumber: string | null };
  /** Credit notes negate every amount. */
  negate: boolean;
}

/**
 * The tax engine. Computes per-line tax from effective-dated rates, hands the
 * posting service the balancing tax lines and records every posted amount in
 * `tax_transactions` (append-only; reversals insert negated rows).
 */
@Injectable()
export class TaxEngineService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Computes sales tax and withholding for each line on the document date. */
  async applyToLines(
    tx: DbExecutor,
    companyId: string,
    side: TaxSide,
    documentDate: string,
    currency: string,
    lines: readonly TaxableLine[],
  ): Promise<{ lines: TaxedLine[]; totals: TaxTotals }> {
    const codes = await this.loadCodes(tx, companyId, lines);
    let taxTotal = Money.zero(currency);
    let withholdingTotal = Money.zero(currency);
    const out: TaxedLine[] = lines.map((line) => {
      const base = Money.of(line.amount, currency);
      const tax = this.lineTax(codes, line.taxCodeId, 'SALES_TAX', side, documentDate, base);
      const wht = this.lineTax(
        codes,
        line.withholdingTaxCodeId,
        'WITHHOLDING',
        side,
        documentDate,
        base,
      );
      taxTotal = taxTotal.add(tax.amount);
      withholdingTotal = withholdingTotal.add(wht.amount);
      return {
        taxCodeId: line.taxCodeId ?? null,
        taxRate: tax.rate,
        taxAmount: tax.amount.toString(),
        withholdingTaxCodeId: line.withholdingTaxCodeId ?? null,
        withholdingRate: wht.rate,
        withholdingAmount: wht.amount.toString(),
      };
    });
    return { lines: out, totals: { taxTotal, withholdingTotal } };
  }

  /** Tax-inclusive variant (expense claims): the gross is split into base + tax. */
  async splitInclusive(
    tx: DbExecutor,
    companyId: string,
    documentDate: string,
    currency: string,
    lines: readonly TaxableLine[],
  ): Promise<
    Array<{ base: string; taxCodeId: string | null; taxRate: string; taxAmount: string }>
  > {
    const codes = await this.loadCodes(tx, companyId, lines);
    return lines.map((line) => {
      const gross = Money.of(line.amount, currency);
      if (!line.taxCodeId)
        return { base: gross.toString(), taxCodeId: null, taxRate: '0.0000', taxAmount: '0.0000' };
      const { code, rate } = this.codeAndRate(
        codes,
        line.taxCodeId,
        'SALES_TAX',
        'PURCHASES',
        documentDate,
      );
      const { base, tax } = extractInclusiveTax(gross, rate.ratePercent);
      return {
        base: base.toString(),
        taxCodeId: code.id,
        taxRate: Money.of(rate.ratePercent, currency).toString(),
        taxAmount: tax.toString(),
      };
    });
  }

  /**
   * Balancing journal lines for stored taxed lines, aggregated per tax account.
   * Sales: sales tax credits the output account, withholding debits the receivable.
   * Purchases: sales tax debits the input account, withholding credits the payable.
   * `negate` flips every side (credit notes).
   */
  async postingLines(
    tx: DbExecutor,
    companyId: string,
    side: TaxSide,
    currency: string,
    lines: readonly StoredTaxedLine[],
    negate: boolean,
  ): Promise<PostingLine[]> {
    const codes = await this.loadCodes(tx, companyId, lines);
    const buckets = new Map<
      string,
      { accountId: string; amount: Money; debitNormal: boolean; code: TaxCode }
    >();
    const add = (codeId: string | null, amount: string, kind: 'SALES_TAX' | 'WITHHOLDING') => {
      if (!codeId || Money.of(amount, currency).isZero()) return;
      const code = codes.get(codeId);
      if (!code) throw new NotFoundError('Tax code', codeId);
      const accountId = side === 'SALES' ? code.salesAccountId : code.purchaseAccountId;
      if (!accountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Tax code ${code.code} has no ${side.toLowerCase()} account.`,
        );
      // Debit-normal: purchase-side sales tax (input tax asset) and sales-side withholding (receivable).
      const debitNormal = side === 'SALES' ? kind === 'WITHHOLDING' : kind === 'SALES_TAX';
      const key = `${accountId}|${debitNormal}`;
      const bucket = buckets.get(key) ?? {
        accountId,
        amount: Money.zero(currency),
        debitNormal,
        code,
      };
      bucket.amount = bucket.amount.add(Money.of(amount, currency));
      buckets.set(key, bucket);
    };
    for (const line of lines) {
      add(line.taxCodeId, line.taxAmount, 'SALES_TAX');
      add(line.withholdingTaxCodeId, line.withholdingAmount, 'WITHHOLDING');
    }
    return [...buckets.values()].map((b) => {
      const debit = b.debitNormal !== negate;
      return {
        accountId: b.accountId,
        debit: debit ? b.amount.toString() : '0',
        credit: debit ? '0' : b.amount.toString(),
        description: `${b.code.code} ${b.code.name}`,
      };
    });
  }

  /** Records one tax transaction per line and tax code. Zero-rated lines are kept: their base feeds the return. */
  async record(
    tx: DbExecutor,
    ctx: TaxRecordContext,
    lines: readonly StoredTaxedLine[],
    currency: string,
  ): Promise<void> {
    const rows = [];
    const sign = (v: string) =>
      (ctx.negate ? Money.of(v, currency).negate() : Money.of(v, currency)).toString();
    for (const line of lines) {
      if (line.taxCodeId) {
        rows.push({
          taxCodeId: line.taxCodeId,
          sourceLineId: line.id,
          ratePercent: line.taxRate,
          baseAmount: sign(line.amount),
          taxAmount: sign(line.taxAmount),
        });
      }
      if (line.withholdingTaxCodeId) {
        rows.push({
          taxCodeId: line.withholdingTaxCodeId,
          sourceLineId: line.id,
          ratePercent: line.withholdingRate,
          baseAmount: sign(line.amount),
          taxAmount: sign(line.withholdingAmount),
        });
      }
    }
    if (rows.length === 0) return;
    await tx.insert(taxTransactions).values(
      rows.map((r) => ({
        companyId: ctx.companyId,
        side: ctx.side,
        sourceType: ctx.sourceType,
        sourceId: ctx.sourceId,
        documentNumber: ctx.documentNumber,
        journalEntryId: ctx.journalEntryId,
        partyId: ctx.party.id,
        partyName: ctx.party.name,
        partyTaxNumber: ctx.party.taxNumber,
        transactionDate: ctx.transactionDate,
        ...r,
      })),
    );
  }

  /** Mirrors every transaction of a source with negated amounts (document void / reversal). */
  async reverse(
    tx: DbExecutor,
    sourceType: TaxSourceType,
    sourceId: string,
    reversalJournalEntryId: string,
    transactionDate: string,
    currency: string,
  ): Promise<void> {
    const originals = await tx
      .select()
      .from(taxTransactions)
      .where(
        and(eq(taxTransactions.sourceType, sourceType), eq(taxTransactions.sourceId, sourceId)),
      );
    const live = originals.filter(
      (o) => !o.reversalOfId && !originals.some((r) => r.reversalOfId === o.id),
    );
    if (live.length === 0) return;
    await tx.insert(taxTransactions).values(
      live.map((o) => ({
        companyId: o.companyId,
        taxCodeId: o.taxCodeId,
        side: o.side,
        sourceType: o.sourceType,
        sourceId: o.sourceId,
        sourceLineId: o.sourceLineId,
        documentNumber: o.documentNumber,
        journalEntryId: reversalJournalEntryId,
        partyId: o.partyId,
        partyName: o.partyName,
        partyTaxNumber: o.partyTaxNumber,
        transactionDate,
        ratePercent: o.ratePercent,
        baseAmount: Money.of(o.baseAmount, currency).negate().toString(),
        taxAmount: Money.of(o.taxAmount, currency).negate().toString(),
        reversalOfId: o.id,
      })),
    );
  }

  /** Default tax code for a side, when the company configured one. */
  async defaultCode(tx: DbExecutor, companyId: string, side: TaxSide): Promise<TaxCode | null> {
    const [row] = await tx
      .select()
      .from(taxCodes)
      .where(
        and(
          eq(taxCodes.companyId, companyId),
          eq(taxCodes.status, 'ACTIVE'),
          side === 'SALES'
            ? eq(taxCodes.isDefaultSales, true)
            : eq(taxCodes.isDefaultPurchases, true),
        ),
      );
    return row ?? null;
  }

  // ------------------------------------------------------------------ helpers

  private lineTax(
    codes: Map<string, TaxCode & { rates: TaxRate[] }>,
    codeId: string | null | undefined,
    kind: 'SALES_TAX' | 'WITHHOLDING',
    side: TaxSide,
    documentDate: string,
    base: Money,
  ): { rate: string; amount: Money } {
    if (!codeId) return { rate: '0.0000', amount: Money.zero(base.currency) };
    const { rate } = this.codeAndRate(codes, codeId, kind, side, documentDate);
    return {
      rate: Money.of(rate.ratePercent, base.currency).toString(),
      amount: taxOn(base, rate.ratePercent),
    };
  }

  private codeAndRate(
    codes: Map<string, TaxCode & { rates: TaxRate[] }>,
    codeId: string,
    kind: 'SALES_TAX' | 'WITHHOLDING',
    side: TaxSide,
    documentDate: string,
  ): { code: TaxCode; rate: TaxRate } {
    const code = codes.get(codeId);
    if (!code) throw new NotFoundError('Tax code', codeId);
    if (code.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Tax code ${code.code} is inactive.`,
      );
    if (code.kind !== kind)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Tax code ${code.code} is a ${code.kind === 'SALES_TAX' ? 'sales tax' : 'withholding tax'} code.`,
      );
    if (code.appliesTo !== 'BOTH' && code.appliesTo !== side)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Tax code ${code.code} does not apply to ${side.toLowerCase()}.`,
      );
    const rate = resolveRate(code.rates, documentDate);
    if (!rate)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        `Tax code ${code.code} has no rate effective on ${documentDate}.`,
      );
    return { code, rate };
  }

  private async loadCodes(
    tx: DbExecutor,
    companyId: string,
    lines: readonly TaxableLine[],
  ): Promise<Map<string, TaxCode & { rates: TaxRate[] }>> {
    const ids = [
      ...new Set(
        lines
          .flatMap((l) => [l.taxCodeId, l.withholdingTaxCodeId])
          .filter((x): x is string => Boolean(x)),
      ),
    ];
    if (ids.length === 0) return new Map();
    const [codes, rates] = await Promise.all([
      tx
        .select()
        .from(taxCodes)
        .where(and(eq(taxCodes.companyId, companyId), inArray(taxCodes.id, ids))),
      tx
        .select()
        .from(taxRates)
        .where(inArray(taxRates.taxCodeId, ids))
        .orderBy(asc(taxRates.effectiveFrom)),
    ]);
    const map = new Map(
      codes.map((c) => [c.id, { ...c, rates: rates.filter((r) => r.taxCodeId === c.id) }]),
    );
    for (const id of ids) if (!map.has(id)) throw new NotFoundError('Tax code', id);
    return map;
  }
}
