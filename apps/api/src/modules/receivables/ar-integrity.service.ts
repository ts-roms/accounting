import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, OPEN_DOCUMENT_STATUSES, type AccountMappingKey } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  customerPayments,
  customers,
  fiscalPeriods,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  paymentAllocations,
  writeOffRequests,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
  IntegritySeverity,
} from '@/modules/accounting/integrity/integrity.service';
import { ArConfigService } from './ar-config.service';
import { ArReportsService } from './ar-reports.service';

/** Mappings the AR platform needs; the first is required, the others are needed only when the feature is used. */
const AR_MAPPINGS: Array<{ key: AccountMappingKey; required: boolean }> = [
  { key: 'ACCOUNTS_RECEIVABLE', required: true },
  { key: 'SALES_REVENUE', required: false },
  { key: 'BAD_DEBT_EXPENSE', required: false },
  { key: 'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS', required: false },
  { key: 'AR_WRITE_OFF', required: false },
  { key: 'BAD_DEBT_RECOVERY', required: false },
];

/**
 * AR integrity checks (Prompt #6 section 41). Read-only assertions over the
 * receivables subledger; the AR/GL reconciliation itself is shared with the
 * accounting integrity checker through ArReportsService.
 */
@Injectable()
export class ArIntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly reports: ArReportsService,
    private readonly config: ArConfigService,
  ) {}

  async run(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.invoicesWithoutJournal(companyId),
      this.paymentsWithoutJournal(companyId),
      this.writeOffsWithoutJournal(companyId),
      this.duplicateInvoices(companyId),
      this.duplicatePayments(companyId),
      this.unallocatedPayments(companyId, asOf, currency),
      this.invalidCustomers(companyId),
      this.closedPeriodPostings(companyId),
      this.accountMappings(companyId),
      this.controlAccountUsage(companyId),
      this.subledgerVsLedger(companyId, asOf, currency),
      this.invoicesWithoutLines(companyId),
      this.allocationDrift(companyId),
      this.negativeBalances(companyId, currency),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  private async invoicesWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: invoices.id,
        documentNumber: invoices.documentNumber,
        accountingStatus: invoices.accountingStatus,
        journalStatus: journalEntries.status,
      })
      .from(invoices)
      .leftJoin(journalEntries, eq(journalEntries.id, invoices.journalEntryId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.accountingStatus, 'POSTED'),
          sql`(${journalEntries.id} IS NULL OR ${journalEntries.status} NOT IN ('POSTED', 'REVERSED'))`,
        ),
      )
      .limit(20);
    return finding(
      'INVOICE_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted invoice / credit note has a posted journal entry',
      rows,
    );
  }

  private async paymentsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: customerPayments.id,
        documentNumber: customerPayments.documentNumber,
        journalStatus: journalEntries.status,
      })
      .from(customerPayments)
      .leftJoin(journalEntries, eq(journalEntries.id, customerPayments.journalEntryId))
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.status, 'POSTED'),
          sql`(${journalEntries.id} IS NULL OR ${journalEntries.status} NOT IN ('POSTED', 'REVERSED'))`,
        ),
      )
      .limit(20);
    return finding(
      'PAYMENT_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted customer payment has a posted journal entry',
      rows,
    );
  }

  private async writeOffsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: writeOffRequests.id, documentNumber: writeOffRequests.documentNumber })
      .from(writeOffRequests)
      .where(
        and(
          eq(writeOffRequests.companyId, companyId),
          inArray(writeOffRequests.status, ['POSTED', 'RECOVERED']),
          isNull(writeOffRequests.journalEntryId),
        ),
      )
      .limit(20);
    return finding(
      'WRITE_OFF_WITHOUT_JOURNAL',
      'CRITICAL',
      'Every posted write-off has a journal entry',
      rows,
    );
  }

  private async duplicateInvoices(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        customerId: invoices.customerId,
        reference: invoices.reference,
        total: invoices.total,
        documentDate: invoices.documentDate,
        count: sql<number>`count(*)::int`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.documentType, 'INVOICE'),
          ne(invoices.status, 'VOID'),
          isNotNull(invoices.reference),
        ),
      )
      .groupBy(invoices.customerId, invoices.reference, invoices.total, invoices.documentDate)
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'DUPLICATE_INVOICE',
      'WARNING',
      'No customer is invoiced twice for the same reference, date and amount',
      rows,
    );
  }

  private async duplicatePayments(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        customerId: customerPayments.customerId,
        amount: customerPayments.amount,
        paymentDate: customerPayments.paymentDate,
        reference: customerPayments.reference,
        count: sql<number>`count(*)::int`,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          ne(customerPayments.status, 'VOID'),
          eq(customerPayments.paymentType, 'PAYMENT'),
        ),
      )
      .groupBy(
        customerPayments.customerId,
        customerPayments.amount,
        customerPayments.paymentDate,
        customerPayments.reference,
      )
      .having(sql`count(*) > 1`)
      .limit(20);
    return finding(
      'DUPLICATE_PAYMENT',
      'WARNING',
      'No customer receipt is recorded twice (same amount, date and reference)',
      rows,
    );
  }

  private async unallocatedPayments(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const settings = await this.config.settings(companyId);
    const rows = await this.db
      .select({
        id: customerPayments.id,
        documentNumber: customerPayments.documentNumber,
        paymentDate: customerPayments.paymentDate,
        amount: customerPayments.amount,
        allocatedAmount: customerPayments.allocatedAmount,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.status, 'POSTED'),
          eq(customerPayments.paymentType, 'PAYMENT'),
          sql`${customerPayments.allocatedAmount} < ${customerPayments.amount}`,
          sql`${customerPayments.paymentDate} < (${asOf}::date - ${settings.unappliedCashWarnDays}::int)`,
        ),
      )
      .limit(20);
    return finding(
      'UNALLOCATED_PAYMENT',
      'WARNING',
      `No receipt stays unapplied for more than ${settings.unappliedCashWarnDays} days`,
      rows.map((r) => ({
        ...r,
        unallocated: Money.of(r.amount, currency)
          .subtract(Money.of(r.allocatedAmount, currency))
          .toString(),
      })),
    );
  }

  private async invalidCustomers(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: invoices.id,
        documentNumber: invoices.documentNumber,
        customerId: invoices.customerId,
        problem: sql<string>`case when ${customers.id} is null then 'missing customer' when ${customers.companyId} <> ${invoices.companyId} then 'customer of another company' else 'inactive customer with open balance' end`,
      })
      .from(invoices)
      .leftJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
          eq(invoices.accountingStatus, 'POSTED'),
          sql`(${customers.id} IS NULL OR ${customers.companyId} <> ${invoices.companyId} OR ${customers.status} <> 'ACTIVE')`,
        ),
      )
      .limit(20);
    return finding(
      'INVALID_CUSTOMER',
      'WARNING',
      'Open documents belong to active customers of the company',
      rows,
    );
  }

  private async closedPeriodPostings(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        invoice: invoices.documentNumber,
        journal: journalEntries.documentNumber,
        period: fiscalPeriods.name,
        postedAt: journalEntries.postedAt,
        closedAt: fiscalPeriods.closedAt,
      })
      .from(invoices)
      .innerJoin(journalEntries, eq(journalEntries.id, invoices.journalEntryId))
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, journalEntries.fiscalPeriodId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          inArray(fiscalPeriods.status, ['CLOSED', 'LOCKED']),
          isNotNull(fiscalPeriods.closedAt),
          sql`${journalEntries.postedAt} > ${fiscalPeriods.closedAt}`,
          sql`(${fiscalPeriods.reopenedAt} IS NULL OR ${fiscalPeriods.reopenedAt} < ${fiscalPeriods.closedAt})`,
        ),
      )
      .limit(20);
    return finding(
      'CLOSED_PERIOD_POSTING',
      'CRITICAL',
      'No AR document was posted into a period after it was closed',
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
    for (const m of AR_MAPPINGS) {
      const r = present.get(m.key);
      if (!r) {
        if (m.required) samples.push({ key: m.key, problem: 'missing' });
        continue;
      }
      if (r.isHeader) samples.push({ key: m.key, problem: 'mapped to a header account' });
      else if (r.accountStatus !== 'ACTIVE')
        samples.push({ key: m.key, problem: 'mapped to an inactive account' });
      else if (m.key === 'ACCOUNTS_RECEIVABLE' && r.type !== 'ASSET')
        samples.push({ key: m.key, problem: 'control account is not an asset' });
    }
    return finding(
      'AR_ACCOUNT_MAPPING',
      'CRITICAL',
      'AR account mappings resolve to postable accounts of the right type',
      samples,
      'Bad-debt / write-off mappings are only needed once those features are used.',
    );
  }

  /** Every AR document / payment journal must hit the AR control account. */
  private async controlAccountUsage(companyId: string): Promise<IntegrityFinding> {
    const control = await this.accounts
      .resolveMapped(companyId, 'ACCOUNTS_RECEIVABLE')
      .catch(() => null);
    if (!control)
      return finding(
        'AR_CONTROL_USAGE',
        'CRITICAL',
        'AR journals post to the mapped control account',
        [{ problem: 'ACCOUNTS_RECEIVABLE mapping missing' }],
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
          inArray(journalEntries.sourceType, ['AR_DOCUMENT', 'AR_PAYMENT', 'AR_WRITE_OFF']),
          sql`not exists (select 1 from ${journalLines} l where l.journal_entry_id = ${journalEntries.id} and l.account_id = ${control.id})`,
        ),
      )
      .limit(20);
    return finding(
      'AR_CONTROL_USAGE',
      'CRITICAL',
      'AR journals post to the mapped control account',
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
        'AR_GL_MISMATCH',
        'CRITICAL',
        'AR subledger equals the AR control account balance',
        samples,
      );
    } catch (err) {
      return finding(
        'AR_GL_MISMATCH',
        'CRITICAL',
        'AR subledger equals the AR control account balance',
        [{ error: (err as Error).message }],
      );
    }
  }

  private async invoicesWithoutLines(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: invoices.id, documentNumber: invoices.documentNumber })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          ne(invoices.status, 'VOID'),
          sql`not exists (select 1 from ${invoiceLines} l where l.invoice_id = ${invoices.id})`,
        ),
      )
      .limit(20);
    return finding(
      'ORPHANED_INVOICE_LINES',
      'CRITICAL',
      'Every invoice has at least one line and every line an invoice',
      rows,
    );
  }

  /** allocated_amount on invoices and payments must equal the sum of their allocation rows. */
  private async allocationDrift(companyId: string): Promise<IntegrityFinding> {
    const invoiceRows = await this.db
      .select({
        documentNumber: invoices.documentNumber,
        allocatedAmount: invoices.allocatedAmount,
        allocations: sql<string>`coalesce((select sum(a.amount) from ${paymentAllocations} a where a.invoice_id = ${invoices.id}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.allocatedAmount} <> coalesce((select sum(a.amount) from ${paymentAllocations} a where a.invoice_id = ${invoices.id}), 0)`,
        ),
      )
      .limit(10);
    const paymentRows = await this.db
      .select({
        documentNumber: customerPayments.documentNumber,
        allocatedAmount: customerPayments.allocatedAmount,
        allocations: sql<string>`coalesce((select sum(a.amount) from ${paymentAllocations} a where a.payment_id = ${customerPayments.id}), 0)`,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.status, 'POSTED'),
          sql`${customerPayments.allocatedAmount} <> coalesce((select sum(a.amount) from ${paymentAllocations} a where a.payment_id = ${customerPayments.id}), 0)`,
        ),
      )
      .limit(10);
    return finding(
      'ALLOCATION_DRIFT',
      'CRITICAL',
      'Allocated amounts equal the sum of allocation rows',
      [...invoiceRows, ...paymentRows],
    );
  }

  private async negativeBalances(companyId: string, currency: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        code: customers.code,
        name: customers.name,
        unappliedCredit: sql<string>`coalesce((select sum(p.amount - p.allocated_amount) from ${customerPayments} p where p.customer_id = ${customers.id} and p.status = 'POSTED' and p.payment_type = 'PAYMENT'), 0) + coalesce((select sum(i.total - i.allocated_amount) from ${invoices} i where i.customer_id = ${customers.id} and i.document_type = 'CREDIT_NOTE' and i.accounting_status = 'POSTED' and i.status in ('APPROVED', 'PARTIALLY_PAID')), 0)`,
        outstanding: sql<string>`coalesce((select sum(i.total - i.allocated_amount) from ${invoices} i where i.customer_id = ${customers.id} and i.document_type in ('INVOICE', 'DEBIT_NOTE') and i.accounting_status = 'POSTED' and i.status in ('APPROVED', 'PARTIALLY_PAID')), 0)`,
      })
      .from(customers)
      .where(eq(customers.companyId, companyId));
    const samples = rows
      .filter(
        (r) =>
          Money.of(r.unappliedCredit, currency).greaterThan(Money.of(r.outstanding, currency)) &&
          Money.of(r.unappliedCredit, currency).isPositive(),
      )
      .map((r) => ({
        code: r.code,
        name: r.name,
        creditBalance: Money.of(r.unappliedCredit, currency)
          .subtract(Money.of(r.outstanding, currency))
          .toString(),
      }))
      .slice(0, 20);
    return finding(
      'NEGATIVE_BALANCE',
      'WARNING',
      'Customers with a net credit balance are reviewed (refund or apply the credit)',
      samples,
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
