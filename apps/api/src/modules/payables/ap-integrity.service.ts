import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, OPEN_DOCUMENT_STATUSES, type AccountMappingKey } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  apAccruals,
  billHolds,
  billLines,
  journalEntries,
  journalLines,
  paymentRunLines,
  paymentRuns,
  vendorBills,
  vendorPaymentAllocations,
  vendorPayments,
  vendors,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
  IntegritySeverity,
} from '@/modules/accounting/integrity/integrity.service';
import { ApAccrualsService } from './ap-accruals.service';
import { ApReportsService } from './ap-reports.service';

/** Mappings the AP platform needs; the first is required, the others only once the feature is used. */
const AP_MAPPINGS: Array<{ key: AccountMappingKey; required: boolean }> = [
  { key: 'ACCOUNTS_PAYABLE', required: true },
  { key: 'GOODS_RECEIVED_NOT_INVOICED', required: false },
  { key: 'PURCHASE_PRICE_VARIANCE', required: false },
  { key: 'PURCHASE_DISCOUNT', required: false },
  { key: 'ACCRUED_EXPENSE', required: false },
];

/**
 * AP integrity checks (Prompt #7). Read-only assertions over the payables
 * subledger, payment runs and accruals; the AP/GL reconciliation itself is
 * shared with the accounting integrity checker through ApReportsService.
 */
@Injectable()
export class ApIntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly reports: ApReportsService,
    private readonly accruals: ApAccrualsService,
  ) {}

  async run(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.billsWithoutJournal(companyId),
      this.paymentsWithoutJournal(companyId),
      this.accrualsWithoutJournal(companyId),
      this.duplicateVendorInvoices(companyId),
      this.duplicatePayments(companyId),
      this.unallocatedPayments(companyId, asOf, currency),
      this.heldBillsSettled(companyId),
      this.holdFlagDrift(companyId),
      this.invalidVendors(companyId),
      this.closedPeriodPostings(companyId),
      this.accountMappings(companyId),
      this.controlAccountUsage(companyId),
      this.subledgerVsLedger(companyId, asOf, currency),
      this.grniVsLedger(companyId, asOf, currency),
      this.billsWithoutLines(companyId),
      this.allocationDrift(companyId),
      this.discountDrift(companyId),
      this.runLinesVsPayments(companyId),
      this.negativeBalances(companyId, currency),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  private async billsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: vendorBills.id,
        documentNumber: vendorBills.documentNumber,
        journalStatus: journalEntries.status,
      })
      .from(vendorBills)
      .leftJoin(journalEntries, eq(journalEntries.id, vendorBills.journalEntryId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          sql`(${journalEntries.id} IS NULL OR ${journalEntries.status} NOT IN ('POSTED', 'REVERSED'))`,
        ),
      )
      .limit(20);
    return finding(
      'BILL_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted bill / vendor credit has a posted journal entry',
      rows,
    );
  }

  private async paymentsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: vendorPayments.id,
        documentNumber: vendorPayments.documentNumber,
        journalStatus: journalEntries.status,
      })
      .from(vendorPayments)
      .leftJoin(journalEntries, eq(journalEntries.id, vendorPayments.journalEntryId))
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          eq(vendorPayments.status, 'POSTED'),
          sql`(${journalEntries.id} IS NULL OR ${journalEntries.status} NOT IN ('POSTED', 'REVERSED'))`,
        ),
      )
      .limit(20);
    return finding(
      'VENDOR_PAYMENT_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted vendor payment has a posted journal entry',
      rows,
    );
  }

  private async accrualsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: apAccruals.id, documentNumber: apAccruals.documentNumber })
      .from(apAccruals)
      .where(
        and(
          eq(apAccruals.companyId, companyId),
          eq(apAccruals.status, 'POSTED'),
          sql`(${apAccruals.journalEntryId} IS NULL OR ${apAccruals.reversalJournalEntryId} IS NULL)`,
        ),
      )
      .limit(20);
    return finding(
      'AP_ACCRUAL_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted AP accrual has its accrual and reversal journals',
      rows,
    );
  }

  private async duplicateVendorInvoices(companyId: string): Promise<IntegrityFinding> {
    // The unique index covers exact matches; this looks for the same vendor + amount + date recorded twice.
    const rows = await this.db
      .select({
        vendorId: vendorBills.vendorId,
        documentDate: vendorBills.documentDate,
        total: vendorBills.total,
        count: sql<number>`count(*)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.documentType, 'INVOICE'),
          sql`${vendorBills.status} <> 'VOID'`,
        ),
      )
      .groupBy(vendorBills.vendorId, vendorBills.documentDate, vendorBills.total)
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'POSSIBLE_DUPLICATE_BILL',
      'WARNING',
      'No vendor has two live bills with the same date and amount',
      rows.map((r) => ({ ...r, count: Number(r.count) })),
    );
  }

  private async duplicatePayments(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        vendorId: vendorPayments.vendorId,
        paymentDate: vendorPayments.paymentDate,
        amount: vendorPayments.amount,
        reference: vendorPayments.reference,
        count: sql<number>`count(*)`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          eq(vendorPayments.status, 'POSTED'),
          sql`${vendorPayments.reference} IS NOT NULL`,
        ),
      )
      .groupBy(
        vendorPayments.vendorId,
        vendorPayments.paymentDate,
        vendorPayments.amount,
        vendorPayments.reference,
      )
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'POSSIBLE_DUPLICATE_VENDOR_PAYMENT',
      'WARNING',
      'No vendor was paid twice with the same date, amount and reference',
      rows.map((r) => ({ ...r, count: Number(r.count) })),
    );
  }

  private async unallocatedPayments(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: vendorPayments.documentNumber,
        paymentDate: vendorPayments.paymentDate,
        unallocated: sql<string>`${vendorPayments.amount} - ${vendorPayments.allocatedAmount}`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          eq(vendorPayments.status, 'POSTED'),
          eq(vendorPayments.paymentType, 'PAYMENT'),
          sql`${vendorPayments.amount} > ${vendorPayments.allocatedAmount}`,
          sql`${vendorPayments.paymentDate} <= ${asOf}`,
        ),
      )
      .limit(20);
    return finding(
      'UNAPPLIED_VENDOR_PAYMENTS',
      'WARNING',
      'Posted vendor payments are fully applied to bills (advances aside)',
      rows.map((r) => ({ ...r, unallocated: Money.of(r.unallocated, currency).toString() })),
      'Vendor advances are expected here until the bill arrives.',
    );
  }

  private async heldBillsSettled(companyId: string): Promise<IntegrityFinding> {
    // A settlement dated after an active hold was placed means the hold was bypassed.
    const rows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        placedAt: billHolds.placedAt,
      })
      .from(billHolds)
      .innerJoin(vendorBills, eq(vendorBills.id, billHolds.billId))
      .where(
        and(
          eq(billHolds.companyId, companyId),
          eq(billHolds.status, 'ACTIVE'),
          sql`exists (select 1 from ${vendorPaymentAllocations} a join ${vendorPayments} p on p.id = a.payment_id where a.bill_id = ${vendorBills.id} and p.status = 'POSTED' and p.posted_at > ${billHolds.placedAt})`,
        ),
      )
      .limit(20);
    return finding(
      'HELD_BILL_SETTLED',
      'CRITICAL',
      'No bill was paid while a payment hold was active',
      rows,
    );
  }

  private async holdFlagDrift(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ documentNumber: vendorBills.documentNumber, onHold: vendorBills.onHold })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          sql`${vendorBills.onHold} <> exists (select 1 from ${billHolds} h where h.bill_id = ${vendorBills.id} and h.status = 'ACTIVE')`,
        ),
      )
      .limit(20);
    return finding(
      'BILL_HOLD_FLAG_DRIFT',
      'CRITICAL',
      'vendor_bills.on_hold mirrors the active holds',
      rows,
    );
  }

  private async invalidVendors(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        vendorCode: vendors.code,
        vendorStatus: vendors.vendorStatus,
        status: vendors.status,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.status, 'DRAFT'),
          sql`(${vendors.status} <> 'ACTIVE' OR ${vendors.vendorStatus} IN ('BLOCKED', 'INACTIVE'))`,
        ),
      )
      .limit(20);
    return finding(
      'DRAFT_BILL_FOR_BLOCKED_VENDOR',
      'WARNING',
      'Draft bills belong to active, usable vendors',
      rows,
    );
  }

  private async closedPeriodPostings(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        documentDate: vendorBills.documentDate,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.status, 'DRAFT'),
          sql`exists (select 1 from fiscal_periods fp where fp.company_id = ${vendorBills.companyId} and ${vendorBills.documentDate} between fp.start_date and fp.end_date and fp.status in ('CLOSED', 'LOCKED'))`,
        ),
      )
      .limit(20);
    return finding(
      'DRAFT_BILL_IN_CLOSED_PERIOD',
      'WARNING',
      'Draft bills are not dated in closed or locked periods',
      rows,
    );
  }

  private async accountMappings(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        key: accountMappings.key,
        accountStatus: accounts.status,
        isHeader: accounts.isHeader,
        type: accounts.type,
      })
      .from(accountMappings)
      .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
      .where(eq(accountMappings.companyId, companyId));
    const present = new Map(rows.map((r) => [r.key, r]));
    const samples: Array<Record<string, unknown>> = [];
    for (const m of AP_MAPPINGS) {
      const r = present.get(m.key);
      if (!r) {
        if (m.required) samples.push({ key: m.key, problem: 'missing' });
        continue;
      }
      if (r.isHeader) samples.push({ key: m.key, problem: 'mapped to a header account' });
      else if (r.accountStatus !== 'ACTIVE')
        samples.push({ key: m.key, problem: 'mapped to an inactive account' });
      else if (m.key === 'ACCOUNTS_PAYABLE' && r.type !== 'LIABILITY')
        samples.push({ key: m.key, problem: 'control account is not a liability' });
    }
    return finding(
      'AP_ACCOUNT_MAPPING',
      'CRITICAL',
      'AP account mappings resolve to postable accounts of the right type',
      samples,
      'Discount / accrual mappings are only needed once those features are used.',
    );
  }

  private async controlAccountUsage(companyId: string): Promise<IntegrityFinding> {
    const control = await this.accounts
      .resolveMapped(companyId, 'ACCOUNTS_PAYABLE')
      .catch(() => null);
    if (!control)
      return finding(
        'AP_CONTROL_USAGE',
        'CRITICAL',
        'AP journals post to the mapped control account',
        [{ problem: 'ACCOUNTS_PAYABLE mapping missing' }],
      );
    const rows = await this.db
      .select({
        journal: journalEntries.documentNumber,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      })
      .from(journalEntries)
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          inArray(journalEntries.sourceType, ['AP_DOCUMENT', 'AP_PAYMENT']),
          sql`not exists (select 1 from ${journalLines} l where l.journal_entry_id = ${journalEntries.id} and l.account_id = ${control.id})`,
        ),
      )
      .limit(20);
    return finding(
      'AP_CONTROL_USAGE',
      'CRITICAL',
      'AP journals post to the mapped control account',
      rows,
    );
  }

  private async subledgerVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    try {
      const r = await this.reports.reconciliation(companyId, { asOf });
      const samples = Money.of(r.difference, currency).isZero()
        ? []
        : [
            {
              subledger: r.subledgerBalance,
              ledger: r.ledgerBalance,
              difference: r.difference,
              controlAccount: r.controlAccount.code,
            },
          ];
      return finding(
        'AP_GL_MISMATCH',
        'CRITICAL',
        'AP subledger equals the AP control account balance',
        samples,
      );
    } catch (err) {
      return finding(
        'AP_GL_MISMATCH',
        'CRITICAL',
        'AP subledger equals the AP control account balance',
        [{ error: err instanceof Error ? err.message : String(err) }],
      );
    }
  }

  private async grniVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    try {
      const r = await this.accruals.grni(companyId, { asOf });
      const samples = Money.of(r.difference, currency).isZero()
        ? []
        : [
            {
              receivedNotBilled: r.totals.stocked,
              grniAccount: r.grniAccountBalance,
              difference: r.difference,
            },
          ];
      return finding(
        'GRNI_MISMATCH',
        'WARNING',
        'Stocked received-not-billed value equals the GRNI clearing account',
        samples,
        'Differences arise from price variances on billing or receipts in foreign currency.',
      );
    } catch (err) {
      return finding(
        'GRNI_MISMATCH',
        'WARNING',
        'Stocked received-not-billed value equals the GRNI clearing account',
        [{ error: err instanceof Error ? err.message : String(err) }],
      );
    }
  }

  private async billsWithoutLines(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ documentNumber: vendorBills.documentNumber })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          sql`${vendorBills.status} <> 'VOID'`,
          sql`not exists (select 1 from ${billLines} l where l.bill_id = ${vendorBills.id})`,
        ),
      )
      .limit(20);
    return finding('BILL_WITHOUT_LINES', 'CRITICAL', 'Every live bill has at least one line', rows);
  }

  private async allocationDrift(companyId: string): Promise<IntegrityFinding> {
    const billRows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        allocatedAmount: vendorBills.allocatedAmount,
        allocations: sql<string>`coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.bill_id = ${vendorBills.id}), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${vendorBills.allocatedAmount} <> coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.bill_id = ${vendorBills.id}), 0)`,
        ),
      )
      .limit(10);
    const paymentRows = await this.db
      .select({
        documentNumber: vendorPayments.documentNumber,
        allocatedAmount: vendorPayments.allocatedAmount,
        allocations: sql<string>`coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.payment_id = ${vendorPayments.id}), 0)`,
      })
      .from(vendorPayments)
      .where(
        and(
          eq(vendorPayments.companyId, companyId),
          eq(vendorPayments.status, 'POSTED'),
          sql`${vendorPayments.allocatedAmount} <> coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.payment_id = ${vendorPayments.id}), 0)`,
        ),
      )
      .limit(10);
    return finding(
      'AP_ALLOCATION_DRIFT',
      'CRITICAL',
      'Allocated amounts on bills and payments equal their allocation rows',
      [...billRows, ...paymentRows],
    );
  }

  private async discountDrift(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        discountTakenAmount: vendorBills.discountTakenAmount,
        discountRows: sql<string>`coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.bill_id = ${vendorBills.id} and a.discount_payment_id is not null), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          sql`${vendorBills.discountTakenAmount} <> coalesce((select sum(a.amount) from ${vendorPaymentAllocations} a where a.bill_id = ${vendorBills.id} and a.discount_payment_id is not null), 0)`,
        ),
      )
      .limit(20);
    return finding(
      'DISCOUNT_DRIFT',
      'CRITICAL',
      'Discounts taken on bills equal their discount allocation rows',
      rows,
    );
  }

  private async runLinesVsPayments(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        runNumber: paymentRuns.documentNumber,
        billId: paymentRunLines.billId,
        paymentStatus: vendorPayments.status,
      })
      .from(paymentRunLines)
      .innerJoin(paymentRuns, eq(paymentRuns.id, paymentRunLines.runId))
      .leftJoin(vendorPayments, eq(vendorPayments.id, paymentRunLines.paymentId))
      .where(
        and(
          eq(paymentRuns.companyId, companyId),
          eq(paymentRunLines.status, 'PAID'),
          sql`(${vendorPayments.id} IS NULL OR ${vendorPayments.status} <> 'POSTED')`,
        ),
      )
      .limit(20);
    return finding(
      'PAYMENT_RUN_LINE_UNPAID',
      'CRITICAL',
      'Every PAID payment-run line points at a posted vendor payment',
      rows,
    );
  }

  private async negativeBalances(companyId: string, currency: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: vendorBills.documentNumber,
        total: vendorBills.total,
        allocatedAmount: vendorBills.allocatedAmount,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
          sql`${vendorBills.allocatedAmount} > ${vendorBills.total}`,
        ),
      )
      .limit(20);
    return finding(
      'BILL_OVER_ALLOCATED',
      'CRITICAL',
      'No open bill is settled beyond its total',
      rows.map((r) => ({
        ...r,
        over: Money.of(r.allocatedAmount, currency)
          .subtract(Money.of(r.total, currency))
          .toString(),
      })),
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
