import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  LEDGER_STATUSES,
  type AccountMappingKey,
  type ReconciliationArea,
} from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  fiscalPeriods,
  journalEntries,
  journalLines,
  inventoryBalances,
  inventorySettings,
  vendorBills,
  vendorPayments,
  warehouses,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { SubledgerBalancesService } from '@/modules/reconciliation/subledger-balances.service';

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
    private readonly balances: SubledgerBalancesService,
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
      this.subledger('INVENTORY', companyId, asOf, currency),
      this.subledger('FIXED_ASSETS', companyId, asOf, currency),
      this.subledger('TAX', companyId, asOf, currency),
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

  /** Every subledger derives its expected balance in SubledgerBalancesService; the variance is the finding. */
  private async subledger(
    area: ReconciliationArea,
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const titles: Record<ReconciliationArea, string> = {
      AR: 'Receivables subledger equals its control account',
      AP: 'Payables subledger equals its control account',
      INVENTORY: 'Inventory valuation equals the inventory accounts',
      FIXED_ASSETS: 'Fixed asset register equals the asset accounts',
      TAX: 'Tax register equals the document-driven movements on tax accounts',
    };
    const check = area === 'AR' || area === 'AP' ? `${area}_CONTROL_VARIANCE` : `${area}_VARIANCE`;
    try {
      const b = await this.balances.compute(companyId, area, asOf);
      const samples = b.lines
        .filter((l) => !Money.of(l.difference, currency).isZero())
        .map((l) => ({
          account: l.code,
          subledger: l.expected,
          ledger: l.actual,
          difference: l.difference,
          note: l.note,
        }));
      return finding(check, 'CRITICAL', titles[area], samples);
    } catch (err) {
      return finding(check, 'CRITICAL', titles[area], [{ error: (err as Error).message }]);
    }
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
