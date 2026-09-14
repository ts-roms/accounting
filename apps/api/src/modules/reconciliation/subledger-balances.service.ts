import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type ReconciliationArea } from '@accounting/types';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  assetCategories,
  fixedAssets,
  journalEntries,
  journalLines,
  taxCodes,
  taxTransactions,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { InventoryReportsService } from '@/modules/inventory/inventory-reports.service';
import { ApReportsService } from '@/modules/payables/ap-reports.service';
import { ArReportsService } from '@/modules/receivables/ar-reports.service';

export interface BalanceLine {
  accountId: string;
  code: string;
  name: string;
  /** Subledger-derived balance, signed as a debit balance (credit balances negative). */
  expected: string;
  /** General ledger balance of the account (or the comparable part of it). */
  actual: string;
  difference: string;
  /** Extra context per area (breakdown, other movements, ...). */
  note?: string;
}

export interface SubledgerBalance {
  area: ReconciliationArea;
  asOf: string;
  currency: string;
  controlAccountId: string;
  expected: string;
  actual: string;
  variance: string;
  lines: BalanceLine[];
  /** Area-specific breakdown kept with the reconciliation record. */
  detail: Record<string, unknown>;
}

/** Journal sources whose tax lines the tax engine records; manual journals are outside the tax subledger. */
const TAX_DOCUMENT_SOURCES = [
  'AR_DOCUMENT',
  'AR_DOCUMENT_VOID',
  'AP_DOCUMENT',
  'AP_DOCUMENT_VOID',
  'EXPENSE_CLAIM',
];

/**
 * One place that knows how every subledger derives the balance its control
 * account should carry. Read-only; used by reconciliation records and by the
 * integrity checker so both agree by construction.
 */
@Injectable()
export class SubledgerBalancesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly ar: ArReportsService,
    private readonly ap: ApReportsService,
    private readonly inventory: InventoryReportsService,
  ) {}

  currency(companyId: string): Promise<string> {
    return this.accounts.companyCurrency(companyId);
  }

  async compute(
    companyId: string,
    area: ReconciliationArea,
    asOf: string,
  ): Promise<SubledgerBalance> {
    const currency = await this.accounts.companyCurrency(companyId);
    switch (area) {
      case 'AR':
      case 'AP':
        return this.receivablesPayables(companyId, area, asOf, currency);
      case 'INVENTORY':
        return this.inventoryBalance(companyId, asOf, currency);
      case 'FIXED_ASSETS':
        return this.fixedAssets(companyId, asOf, currency);
      case 'TAX':
        return this.tax(companyId, asOf, currency);
    }
  }

  private async receivablesPayables(
    companyId: string,
    area: 'AR' | 'AP',
    asOf: string,
    currency: string,
  ): Promise<SubledgerBalance> {
    const report = await (area === 'AR' ? this.ar : this.ap).reconciliation(companyId, { asOf });
    const expected = Money.of(report.subledgerBalance, currency);
    const actual = Money.of(report.ledgerBalance, currency);
    return {
      area,
      asOf,
      currency,
      controlAccountId: report.controlAccount.id,
      expected: expected.toString(),
      actual: actual.toString(),
      variance: actual.subtract(expected).toString(),
      lines: [
        {
          accountId: report.controlAccount.id,
          code: report.controlAccount.code,
          name: report.controlAccount.name,
          expected: expected.toString(),
          actual: actual.toString(),
          difference: actual.subtract(expected).toString(),
        },
      ],
      detail: { breakdown: report.breakdown },
    };
  }

  private async inventoryBalance(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<SubledgerBalance> {
    const report = await this.inventory.valuation(companyId, { asOf });
    const control = await this.accounts.resolveMapped(companyId, 'INVENTORY');
    const expected = Money.of(report.totalSubledger, currency);
    const actual = Money.of(report.totalLedger, currency);
    return {
      area: 'INVENTORY',
      asOf,
      currency,
      controlAccountId: control.id,
      expected: expected.toString(),
      actual: actual.toString(),
      variance: actual.subtract(expected).toString(),
      lines: report.accounts.map((a) => ({
        accountId: a.accountId,
        code: a.code,
        name: a.name,
        expected: a.subledgerValue,
        actual: a.ledgerBalance,
        difference: a.difference,
      })),
      detail: { byWarehouse: report.byWarehouse },
    };
  }

  /**
   * Register cost and accumulated depreciation per resolved account versus the
   * ledger. The mapped cost / accumulated accounts are always included, so a
   * balance that reached them without a registered asset is a variance too.
   */
  private async fixedAssets(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<SubledgerBalance> {
    const registered = await this.db
      .select({
        cost: sql<string>`coalesce(sum(${fixedAssets.cost}), 0)`,
        accumulated: sql<string>`coalesce(sum(${fixedAssets.accumulatedDepreciation}), 0)`,
        assetAccountId: assetCategories.assetAccountId,
        accumulatedAccountId: assetCategories.accumulatedDepreciationAccountId,
      })
      .from(fixedAssets)
      .innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
      .where(
        and(
          eq(fixedAssets.companyId, companyId),
          inArray(fixedAssets.status, ['ACTIVE', 'FULLY_DEPRECIATED']),
          sql`${fixedAssets.capitalizedAt} IS NOT NULL AND ${fixedAssets.capitalizedAt}::date <= ${asOf}`,
        ),
      )
      .groupBy(assetCategories.assetAccountId, assetCategories.accumulatedDepreciationAccountId);
    const [costMap, accMap] = await Promise.all([
      this.accounts.resolveMapped(companyId, 'FIXED_ASSET_COST'),
      this.accounts.resolveMapped(companyId, 'ACCUMULATED_DEPRECIATION'),
    ]);
    const expectedBy = new Map<string, Money>([
      [costMap.id, Money.zero(currency)],
      [accMap.id, Money.zero(currency)],
    ]);
    const add = (id: string, amount: Money) =>
      expectedBy.set(id, (expectedBy.get(id) ?? Money.zero(currency)).add(amount));
    for (const r of registered) {
      add(r.assetAccountId ?? costMap.id, Money.of(r.cost, currency));
      // Accumulated depreciation is a credit balance: negative in debit terms.
      add(r.accumulatedAccountId ?? accMap.id, Money.of(r.accumulated, currency).negate());
    }
    const lines = await this.compareToLedger(companyId, asOf, currency, expectedBy);
    return this.summarise('FIXED_ASSETS', asOf, currency, costMap.id, lines, {
      assets: registered.length,
    });
  }

  /**
   * Tax subledger = signed tax transactions per tax account, compared with the
   * document-driven movements on those accounts (journals whose source the tax
   * engine records). Manual journals - remittances, opening balances - are
   * reported as "other movements" and are not part of the comparison.
   */
  private async tax(companyId: string, asOf: string, currency: string): Promise<SubledgerBalance> {
    const codes = await this.db.select().from(taxCodes).where(eq(taxCodes.companyId, companyId));
    const outputVat = await this.accounts.resolveMapped(companyId, 'OUTPUT_VAT');
    const accountIds = new Set<string>([outputVat.id]);
    for (const c of codes) {
      if (c.salesAccountId) accountIds.add(c.salesAccountId);
      if (c.purchaseAccountId) accountIds.add(c.purchaseAccountId);
    }
    const expectedBy = new Map<string, Money>(
      [...accountIds].map((id) => [id, Money.zero(currency)]),
    );
    const sums = await this.db
      .select({
        taxCodeId: taxTransactions.taxCodeId,
        side: taxTransactions.side,
        amount: sql<string>`coalesce(sum(${taxTransactions.taxAmount}), 0)`,
      })
      .from(taxTransactions)
      .where(
        and(eq(taxTransactions.companyId, companyId), lte(taxTransactions.transactionDate, asOf)),
      )
      .groupBy(taxTransactions.taxCodeId, taxTransactions.side);
    const byId = new Map(codes.map((c) => [c.id, c]));
    for (const s of sums) {
      const code = byId.get(s.taxCodeId);
      if (!code) continue;
      const accountId = s.side === 'SALES' ? code.salesAccountId : code.purchaseAccountId;
      if (!accountId) continue;
      const amount = Money.of(s.amount, currency);
      // Output tax and withholding payable are credits; input tax and creditable withholding are debits.
      const debitNatural = (code.kind === 'SALES_TAX') === (s.side === 'PURCHASES');
      expectedBy.set(
        accountId,
        (expectedBy.get(accountId) ?? Money.zero(currency)).add(
          debitNatural ? amount : amount.negate(),
        ),
      );
    }
    // Actual: only document-driven journal lines on the tax accounts.
    const documentMoves = await this.db
      .select({
        accountId: journalLines.accountId,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          lte(journalEntries.entryDate, asOf),
          inArray(journalLines.accountId, [...accountIds]),
          inArray(journalEntries.sourceType, TAX_DOCUMENT_SOURCES),
        ),
      )
      .groupBy(journalLines.accountId);
    const activity = await this.ledger.activity({ companyId, to: asOf });
    const chart = await this.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(inArray(accounts.id, [...accountIds]));
    const lines: BalanceLine[] = [];
    for (const acc of chart.sort((a, b) => a.code.localeCompare(b.code))) {
      const expected = expectedBy.get(acc.id) ?? Money.zero(currency);
      const dm = documentMoves.find((m) => m.accountId === acc.id);
      const actual = Money.of(dm?.debit ?? '0', currency).subtract(
        Money.of(dm?.credit ?? '0', currency),
      );
      const a = activity.find((x) => x.accountId === acc.id);
      const total = Money.of(a?.debit ?? '0', currency).subtract(
        Money.of(a?.credit ?? '0', currency),
      );
      const other = total.subtract(actual);
      lines.push({
        accountId: acc.id,
        code: acc.code,
        name: acc.name,
        expected: expected.toString(),
        actual: actual.toString(),
        difference: actual.subtract(expected).toString(),
        note: other.isZero()
          ? undefined
          : `other (non-document) movements ${other.toString()}; ledger balance ${total.toString()}`,
      });
    }
    return this.summarise('TAX', asOf, currency, outputVat.id, lines, { taxCodes: codes.length });
  }

  private async compareToLedger(
    companyId: string,
    asOf: string,
    currency: string,
    expectedBy: Map<string, Money>,
  ): Promise<BalanceLine[]> {
    const ids = [...expectedBy.keys()];
    if (!ids.length)
      throw new BusinessRuleError(ErrorCodes.ACCOUNT_MAPPING_MISSING, 'No accounts to reconcile.');
    const [activity, chart] = await Promise.all([
      this.ledger.activity({ companyId, to: asOf }),
      this.db
        .select({ id: accounts.id, code: accounts.code, name: accounts.name })
        .from(accounts)
        .where(inArray(accounts.id, ids)),
    ]);
    return chart
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((acc) => {
        const a = activity.find((x) => x.accountId === acc.id);
        const actual = Money.of(a?.debit ?? '0', currency).subtract(
          Money.of(a?.credit ?? '0', currency),
        );
        const expected = expectedBy.get(acc.id)!;
        return {
          accountId: acc.id,
          code: acc.code,
          name: acc.name,
          expected: expected.toString(),
          actual: actual.toString(),
          difference: actual.subtract(expected).toString(),
        };
      });
  }

  private summarise(
    area: ReconciliationArea,
    asOf: string,
    currency: string,
    controlAccountId: string,
    lines: BalanceLine[],
    detail: Record<string, unknown>,
  ): SubledgerBalance {
    const expected = Money.sum(
      lines.map((l) => Money.of(l.expected, currency)),
      currency,
    );
    const actual = Money.sum(
      lines.map((l) => Money.of(l.actual, currency)),
      currency,
    );
    return {
      area,
      asOf,
      currency,
      controlAccountId,
      expected: expected.toString(),
      actual: actual.toString(),
      variance: actual.subtract(expected).toString(),
      lines,
      detail,
    };
  }
}
