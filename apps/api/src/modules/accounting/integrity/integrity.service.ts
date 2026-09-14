import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type AccountMappingKey } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  assetCategories,
  fiscalPeriods,
  fixedAssets,
  journalEntries,
  journalLines,
  inventoryBalances,
  inventorySettings,
  vendorBills,
  vendorPayments,
  warehouses,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { ApReportsService } from '@/modules/payables/ap-reports.service';
import { ArReportsService } from '@/modules/receivables/ar-reports.service';
import { InventoryReportsService } from '@/modules/inventory/inventory-reports.service';

export type IntegritySeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface IntegrityFinding {
  /** Stable key, e.g. `UNBALANCED_JOURNAL`. */
  check: string;
  severity: IntegritySeverity;
  title: string;
  /** Number of offending rows / items (0 = passed). */
  count: number;
  /** Up to 20 samples for drill-down. */
  samples: Array<Record<string, unknown>>;
  detail?: string;
}

export interface IntegrityReport {
  asOf: string;
  currency: string;
  ranAt: string;
  status: 'OK' | 'WARNING' | 'CRITICAL';
  findings: IntegrityFinding[];
}

/** Mappings every company needs before the subledgers can post. */
const REQUIRED_MAPPINGS: readonly AccountMappingKey[] = [
  'RETAINED_EARNINGS',
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'INVENTORY',
  'COST_OF_GOODS_SOLD',
  'FIXED_ASSET_COST',
  'ACCUMULATED_DEPRECIATION',
  'DEPRECIATION_EXPENSE',
  'EMPLOYEE_PAYABLE',
  'OUTPUT_VAT',
  'INPUT_VAT',
];

/**
 * Financial integrity checker: the accounting invariants of
 * docs/accounting-controls.md as executable checks over live data. Every
 * check is read-only; the same assertions run in the e2e suites.
 */
@Injectable()
export class IntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
    private readonly ar: ArReportsService,
    private readonly ap: ApReportsService,
    private readonly inventory: InventoryReportsService,
  ) {}

  async run(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.unbalancedJournals(companyId),
      this.periodMismatch(companyId),
      this.postedInClosedPeriods(companyId),
      this.linesOnBadAccounts(companyId),
      this.orphanLines(companyId),
      this.missingMappings(companyId),
      this.subledger('AR', companyId, asOf, currency),
      this.subledger('AP', companyId, asOf, currency),
      this.inventoryVariance(companyId, asOf, currency),
      this.fixedAssetVariance(companyId, asOf, currency),
      this.duplicateVendorInvoices(companyId),
      this.duplicatePayments(companyId),
      this.negativeStock(companyId),
    ]);
    const worst = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status: worst, findings };
  }

  // ------------------------------------------------------------- journals

  /** Every ledger entry: SUM(debit) = SUM(credit) on its lines and on its header. */
  private async unbalancedJournals(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: journalEntries.id,
        documentNumber: journalEntries.documentNumber,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        headerDebit: journalEntries.totalDebit,
        headerCredit: journalEntries.totalCredit,
      })
      .from(journalEntries)
      .leftJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
        ),
      )
      .groupBy(journalEntries.id)
      .having(
        sql`coalesce(sum(${journalLines.debit}), 0) <> coalesce(sum(${journalLines.credit}), 0) OR coalesce(sum(${journalLines.debit}), 0) <> ${journalEntries.totalDebit} OR coalesce(sum(${journalLines.credit}), 0) <> ${journalEntries.totalCredit}`,
      )
      .limit(20);
    return finding('UNBALANCED_JOURNAL', 'CRITICAL', 'Posted journals balance', rows);
  }

  /** The period on the entry must cover its entry date. */
  private async periodMismatch(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: journalEntries.id,
        documentNumber: journalEntries.documentNumber,
        entryDate: journalEntries.entryDate,
        period: fiscalPeriods.name,
      })
      .from(journalEntries)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, journalEntries.fiscalPeriodId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          sql`(${journalEntries.entryDate} < ${fiscalPeriods.startDate} OR ${journalEntries.entryDate} > ${fiscalPeriods.endDate})`,
        ),
      )
      .limit(20);
    return finding(
      'PERIOD_MISMATCH',
      'CRITICAL',
      'Journals sit in the period covering their date',
      rows,
    );
  }

  /** Nothing may have been posted after its period was closed (except the year-end routine). */
  private async postedInClosedPeriods(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: journalEntries.id,
        documentNumber: journalEntries.documentNumber,
        postedAt: journalEntries.postedAt,
        period: fiscalPeriods.name,
        closedAt: fiscalPeriods.closedAt,
      })
      .from(journalEntries)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, journalEntries.fiscalPeriodId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          inArray(fiscalPeriods.status, ['CLOSED', 'LOCKED']),
          isNotNull(fiscalPeriods.closedAt),
          ne(journalEntries.journalType, 'CLOSING'),
          sql`${journalEntries.postedAt} > ${fiscalPeriods.closedAt}`,
          // A reopen resets the clock: only postings after the latest close count.
          sql`(${fiscalPeriods.reopenedAt} IS NULL OR ${fiscalPeriods.reopenedAt} < ${fiscalPeriods.closedAt})`,
        ),
      )
      .limit(20);
    return finding('POSTED_AFTER_CLOSE', 'CRITICAL', 'No postings after a period was closed', rows);
  }

  /** Lines must sit on postable, active accounts of the same company. */
  private async linesOnBadAccounts(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        journalEntryId: journalLines.journalEntryId,
        documentNumber: journalEntries.documentNumber,
        lineNumber: journalLines.lineNumber,
        account: accounts.code,
        isHeader: accounts.isHeader,
        accountStatus: accounts.status,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .leftJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalLines.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          sql`(${accounts.id} IS NULL OR ${accounts.companyId} <> ${journalLines.companyId} OR ${accounts.isHeader} = true)`,
        ),
      )
      .limit(20);
    return finding(
      'LINE_ACCOUNT_INVALID',
      'CRITICAL',
      'Ledger lines reference postable accounts of the company',
      rows,
      'Accounts deactivated after posting keep their history and are not flagged.',
    );
  }

  private async orphanLines(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: journalLines.id, journalEntryId: journalLines.journalEntryId })
      .from(journalLines)
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(eq(journalLines.companyId, companyId), sql`${journalEntries.id} IS NULL`))
      .limit(20);
    return finding('ORPHAN_LINE', 'CRITICAL', 'Every journal line belongs to an entry', rows);
  }

  private async missingMappings(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        key: accountMappings.key,
        accountStatus: accounts.status,
        isHeader: accounts.isHeader,
      })
      .from(accountMappings)
      .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
      .where(eq(accountMappings.companyId, companyId));
    const present = new Map(rows.map((r) => [r.key, r]));
    const samples = REQUIRED_MAPPINGS.filter((k) => !present.has(k)).map((key) => ({
      key,
      problem: 'missing',
    }));
    for (const [key, r] of present) {
      if (r.isHeader) samples.push({ key, problem: 'mapped to a header account' });
      else if (r.accountStatus !== 'ACTIVE')
        samples.push({ key, problem: 'mapped to an inactive account' });
    }
    return finding(
      'ACCOUNT_MAPPING',
      'CRITICAL',
      'Required account mappings resolve to postable accounts',
      samples,
    );
  }

  // ----------------------------------------------------------- subledgers

  private async subledger(
    side: 'AR' | 'AP',
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const report = await (side === 'AR' ? this.ar : this.ap).reconciliation(companyId, { asOf });
    const diff = Money.of(report.difference, currency);
    return finding(
      `${side}_CONTROL_VARIANCE`,
      'CRITICAL',
      `${side === 'AR' ? 'Receivables' : 'Payables'} subledger equals its control account`,
      diff.isZero()
        ? []
        : [
            {
              subledger: report.subledgerBalance,
              ledger: report.ledgerBalance,
              difference: report.difference,
              control: report.controlAccount.code,
            },
          ],
    );
  }

  private async inventoryVariance(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const report = await this.inventory.valuation(companyId, { asOf });
    const samples = report.reconciled
      ? []
      : report.accounts
          .filter((r) => !r.reconciled)
          .map((r) => ({
            account: r.code,
            subledger: r.subledgerValue,
            ledger: r.ledgerBalance,
            difference: r.difference,
          }));
    if (!report.reconciled && !samples.length)
      samples.push({
        account: 'TOTAL',
        subledger: report.totalSubledger,
        ledger: report.totalLedger,
        difference: currency,
      });
    return finding(
      'INVENTORY_VARIANCE',
      'CRITICAL',
      'Inventory valuation equals the inventory accounts',
      samples,
    );
  }

  /**
   * Register cost / accumulated depreciation per resolved account versus the
   * ledger. The mapped cost and accumulated accounts are always compared, so
   * balances that reached them without a registered asset are flagged too.
   */
  private async fixedAssetVariance(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
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
      this.accounts.resolveMapped(companyId, 'FIXED_ASSET_COST').catch(() => null),
      this.accounts.resolveMapped(companyId, 'ACCUMULATED_DEPRECIATION').catch(() => null),
    ]);
    const cost = new Map<string, Money>();
    const accumulated = new Map<string, Money>();
    if (costMap) cost.set(costMap.id, Money.zero(currency));
    if (accMap) accumulated.set(accMap.id, Money.zero(currency));
    for (const r of registered) {
      const costId = r.assetAccountId ?? costMap?.id;
      const accId = r.accumulatedAccountId ?? accMap?.id;
      if (costId)
        cost.set(
          costId,
          (cost.get(costId) ?? Money.zero(currency)).add(Money.of(r.cost, currency)),
        );
      if (accId)
        accumulated.set(
          accId,
          (accumulated.get(accId) ?? Money.zero(currency)).add(Money.of(r.accumulated, currency)),
        );
    }
    const activity = await this.ledger.activity({ companyId, to: asOf });
    const ledgerOf = (accountId: string) => {
      const a = activity.find((x) => x.accountId === accountId);
      return Money.of(a?.debit ?? '0', currency).subtract(Money.of(a?.credit ?? '0', currency));
    };
    const samples: Record<string, unknown>[] = [];
    // Cost accounts carry a debit balance; accumulated depreciation a credit balance.
    for (const [accountId, sum] of cost) {
      const ledger = ledgerOf(accountId);
      if (!ledger.equals(sum))
        samples.push({
          side: 'cost',
          accountId,
          register: sum.toString(),
          ledger: ledger.toString(),
          difference: ledger.subtract(sum).toString(),
        });
    }
    for (const [accountId, sum] of accumulated) {
      const ledger = ledgerOf(accountId);
      const expected = sum.negate();
      if (!ledger.equals(expected))
        samples.push({
          side: 'accumulated',
          accountId,
          register: expected.toString(),
          ledger: ledger.toString(),
          difference: ledger.subtract(expected).toString(),
        });
    }
    return finding(
      'FIXED_ASSET_VARIANCE',
      'CRITICAL',
      'Fixed asset register equals the asset accounts',
      samples,
    );
  }

  // -------------------------------------------------------------- controls

  private async duplicateVendorInvoices(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        vendorId: vendorBills.vendorId,
        vendorInvoiceNumber: vendorBills.vendorInvoiceNumber,
        count: sql<number>`count(*)::int`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          ne(vendorBills.status, 'VOID'),
          isNotNull(vendorBills.vendorInvoiceNumber),
        ),
      )
      .groupBy(vendorBills.vendorId, vendorBills.vendorInvoiceNumber)
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'DUPLICATE_VENDOR_INVOICE',
      'WARNING',
      'No vendor invoice number is billed twice',
      rows,
    );
  }

  private async duplicatePayments(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        vendorId: vendorPayments.vendorId,
        amount: vendorPayments.amount,
        paymentDate: vendorPayments.paymentDate,
        reference: vendorPayments.reference,
        count: sql<number>`count(*)::int`,
      })
      .from(vendorPayments)
      .where(and(eq(vendorPayments.companyId, companyId), ne(vendorPayments.status, 'VOID')))
      .groupBy(
        vendorPayments.vendorId,
        vendorPayments.amount,
        vendorPayments.paymentDate,
        vendorPayments.reference,
      )
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'DUPLICATE_PAYMENT',
      'WARNING',
      'No vendor is paid the same amount twice on one day with the same reference',
      rows,
    );
  }

  private async negativeStock(companyId: string): Promise<IntegrityFinding> {
    const [settings] = await this.db
      .select({ allowNegativeStock: inventorySettings.allowNegativeStock })
      .from(inventorySettings)
      .where(eq(inventorySettings.companyId, companyId));
    if (settings?.allowNegativeStock)
      return finding(
        'NEGATIVE_STOCK',
        'WARNING',
        'No negative stock (company allows it - check skipped)',
        [],
      );
    const rows = await this.db
      .select({
        productId: inventoryBalances.productId,
        warehouse: warehouses.code,
        quantity: inventoryBalances.quantityOnHand,
      })
      .from(inventoryBalances)
      .innerJoin(warehouses, eq(warehouses.id, inventoryBalances.warehouseId))
      .where(
        and(
          eq(inventoryBalances.companyId, companyId),
          sql`${inventoryBalances.quantityOnHand} < 0`,
        ),
      )
      .limit(20);
    return finding(
      'NEGATIVE_STOCK',
      'WARNING',
      'No negative stock where the company forbids it',
      rows,
    );
  }
}

function finding(
  check: string,
  severity: IntegritySeverity,
  title: string,
  samples: Array<Record<string, unknown>>,
  detail?: string,
): IntegrityFinding {
  return { check, severity, title, count: samples.length, samples: samples.slice(0, 20), detail };
}
