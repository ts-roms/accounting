import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PaginatedResult, TaxKind, TaxReportingCategory, TaxSide } from '@accounting/types';
import type { ListTaxTransactionsQuery, TaxReportQuery } from '@accounting/validation';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import { journalEntries, taxCodes, taxTransactions, type TaxTransaction } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';

export interface TaxTransactionView extends TaxTransaction {
  taxCode: string;
  taxName: string;
  kind: TaxKind;
  journalNumber: string;
}

export interface TaxSummaryRow {
  taxCodeId: string;
  code: string;
  name: string;
  kind: TaxKind;
  side: TaxSide;
  reportingCategory: TaxReportingCategory;
  transactionCount: number;
  baseAmount: string;
  taxAmount: string;
}

export interface TaxSummaryReport {
  from: string;
  to: string;
  currency: string;
  rows: TaxSummaryRow[];
  totals: {
    outputTax: string;
    inputTax: string;
    /** Output - input: positive = payable. */
    netTaxPayable: string;
    withholdingReceivable: string;
    withholdingPayable: string;
  };
}

export interface WithholdingByPartyRow {
  partyId: string | null;
  partyName: string | null;
  partyTaxNumber: string | null;
  side: TaxSide;
  code: string;
  ratePercent: string;
  transactionCount: number;
  baseAmount: string;
  taxAmount: string;
}

/** Tax returns are sums over `tax_transactions`; nothing here is stored separately. */
@Injectable()
export class TaxReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
  ) {}

  async transactions(
    companyId: string,
    query: ListTaxTransactionsQuery,
  ): Promise<PaginatedResult<TaxTransactionView>> {
    const filters: SQL[] = [eq(taxTransactions.companyId, companyId)];
    if (query.from) filters.push(gte(taxTransactions.transactionDate, query.from));
    if (query.to) filters.push(lte(taxTransactions.transactionDate, query.to));
    if (query.taxCodeId) filters.push(eq(taxTransactions.taxCodeId, query.taxCodeId));
    if (query.side) filters.push(eq(taxTransactions.side, query.side));
    if (query.sourceType) filters.push(eq(taxTransactions.sourceType, query.sourceType));
    if (query.partyId) filters.push(eq(taxTransactions.partyId, query.partyId));
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.db
        .select({
          tx: taxTransactions,
          taxCode: taxCodes.code,
          taxName: taxCodes.name,
          kind: taxCodes.kind,
          journalNumber: journalEntries.documentNumber,
        })
        .from(taxTransactions)
        .innerJoin(taxCodes, eq(taxCodes.id, taxTransactions.taxCodeId))
        .innerJoin(journalEntries, eq(journalEntries.id, taxTransactions.journalEntryId))
        .where(where)
        .orderBy(desc(taxTransactions.transactionDate), desc(taxTransactions.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(taxTransactions)
        .where(where),
    ]);
    return toPaginatedResult(
      rows.map((r) => ({
        ...r.tx,
        taxCode: r.taxCode,
        taxName: r.taxName,
        kind: r.kind,
        journalNumber: r.journalNumber,
      })),
      Number(countRows[0]?.total ?? 0),
      query,
    );
  }

  /** Per tax code and side: base and tax for the window, plus VAT-style totals. */
  async summary(companyId: string, query: TaxReportQuery): Promise<TaxSummaryReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const filters: SQL[] = [
      eq(taxTransactions.companyId, companyId),
      gte(taxTransactions.transactionDate, query.from),
      lte(taxTransactions.transactionDate, query.to),
    ];
    if (query.side) filters.push(eq(taxTransactions.side, query.side));
    const rows = await this.db
      .select({
        taxCodeId: taxTransactions.taxCodeId,
        code: taxCodes.code,
        name: taxCodes.name,
        kind: taxCodes.kind,
        side: taxTransactions.side,
        reportingCategory: taxCodes.reportingCategory,
        transactionCount: sql<number>`count(*)::int`,
        baseAmount: sql<string>`coalesce(sum(${taxTransactions.baseAmount}), 0)`,
        taxAmount: sql<string>`coalesce(sum(${taxTransactions.taxAmount}), 0)`,
      })
      .from(taxTransactions)
      .innerJoin(taxCodes, eq(taxCodes.id, taxTransactions.taxCodeId))
      .where(and(...filters))
      .groupBy(
        taxTransactions.taxCodeId,
        taxCodes.code,
        taxCodes.name,
        taxCodes.kind,
        taxTransactions.side,
        taxCodes.reportingCategory,
      )
      .orderBy(taxCodes.kind, taxTransactions.side, taxCodes.code);
    const sum = (pred: (r: (typeof rows)[number]) => boolean) =>
      Money.sum(
        rows.filter(pred).map((r) => Money.of(r.taxAmount, currency)),
        currency,
      );
    const outputTax = sum((r) => r.kind === 'SALES_TAX' && r.side === 'SALES');
    const inputTax = sum((r) => r.kind === 'SALES_TAX' && r.side === 'PURCHASES');
    return {
      from: query.from,
      to: query.to,
      currency,
      rows: rows.map((r) => ({
        ...r,
        baseAmount: Money.of(r.baseAmount, currency).toString(),
        taxAmount: Money.of(r.taxAmount, currency).toString(),
      })),
      totals: {
        outputTax: outputTax.toString(),
        inputTax: inputTax.toString(),
        netTaxPayable: outputTax.subtract(inputTax).toString(),
        withholdingReceivable: sum(
          (r) => r.kind === 'WITHHOLDING' && r.side === 'SALES',
        ).toString(),
        withholdingPayable: sum(
          (r) => r.kind === 'WITHHOLDING' && r.side === 'PURCHASES',
        ).toString(),
      },
    };
  }

  /** Withholding grouped by counterparty and rate - the shape certificates and alphalists need. */
  async withholdingByParty(
    companyId: string,
    query: TaxReportQuery,
  ): Promise<WithholdingByPartyRow[]> {
    const currency = await this.accounts.companyCurrency(companyId);
    const filters: SQL[] = [
      eq(taxTransactions.companyId, companyId),
      eq(taxCodes.kind, 'WITHHOLDING'),
      gte(taxTransactions.transactionDate, query.from),
      lte(taxTransactions.transactionDate, query.to),
    ];
    if (query.side) filters.push(eq(taxTransactions.side, query.side));
    const rows = await this.db
      .select({
        partyId: taxTransactions.partyId,
        partyName: taxTransactions.partyName,
        partyTaxNumber: taxTransactions.partyTaxNumber,
        side: taxTransactions.side,
        code: taxCodes.code,
        ratePercent: taxTransactions.ratePercent,
        transactionCount: sql<number>`count(*)::int`,
        baseAmount: sql<string>`coalesce(sum(${taxTransactions.baseAmount}), 0)`,
        taxAmount: sql<string>`coalesce(sum(${taxTransactions.taxAmount}), 0)`,
      })
      .from(taxTransactions)
      .innerJoin(taxCodes, eq(taxCodes.id, taxTransactions.taxCodeId))
      .where(and(...filters))
      .groupBy(
        taxTransactions.partyId,
        taxTransactions.partyName,
        taxTransactions.partyTaxNumber,
        taxTransactions.side,
        taxCodes.code,
        taxTransactions.ratePercent,
      )
      .orderBy(taxTransactions.side, taxTransactions.partyName, taxCodes.code);
    return rows.map((r) => ({
      ...r,
      ratePercent: Money.of(r.ratePercent, currency).toString(),
      baseAmount: Money.of(r.baseAmount, currency).toString(),
      taxAmount: Money.of(r.taxAmount, currency).toString(),
    }));
  }
}
