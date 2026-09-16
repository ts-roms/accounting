import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { AccountMappingKey } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  bankTransfers,
  paymentFileLines,
  paymentFiles,
  pettyCashFunds,
  pettyCashVouchers,
  vendorPayments,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { BankingService } from '@/modules/banking/banking.service';
import { CashPositionService } from './cash-position.service';
import { TreasuryConfigService } from './treasury-config.service';

const TREASURY_MAPPINGS: Array<{ key: AccountMappingKey; required: boolean }> = [
  { key: 'CASH_IN_TRANSIT', required: false },
  { key: 'BANK_CHARGES', required: false },
  { key: 'FX_GAIN', required: false },
  { key: 'FX_LOSS', required: false },
];

/**
 * Treasury integrity checks (Prompt #8). Read-only assertions that the
 * cash records agree with the ledger: in-transit balances net to the open
 * transfers, petty cash funds reconcile to their imprest, payment files
 * equal the payments they carry and statements do not drift from the books.
 */
@Injectable()
export class TreasuryIntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly banking: BankingService,
    private readonly positions: CashPositionService,
    private readonly config: TreasuryConfigService,
  ) {}

  async run(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.inTransitVsLedger(companyId, asOf, currency),
      this.transfersWithoutJournal(companyId),
      this.unsettledTransfers(companyId, asOf),
      this.pettyCashVsImprest(companyId, currency),
      this.vouchersWithoutJournal(companyId),
      this.pettyCashLedgerDrift(companyId, asOf, currency),
      this.paymentFileTotals(companyId, currency),
      this.paymentsInSeveralFiles(companyId),
      this.filesWithNonPostedPayments(companyId),
      this.statementDrift(companyId, asOf),
      this.accountsBelowMinimum(companyId, asOf),
      this.accountMappings(companyId),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  /** CASH_IN_TRANSIT balance must equal the base amount of SENT (unsettled) transfers. */
  private async inTransitVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const [mapping] = await this.db
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(
        and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, 'CASH_IN_TRANSIT')),
      );
    if (!mapping)
      return finding(
        'IN_TRANSIT_VS_LEDGER',
        'CRITICAL',
        'Cash in transit equals open transfers',
        0,
        [],
        'No CASH_IN_TRANSIT mapping yet.',
      );
    const ledger = Money.of(
      await this.banking.ledgerBalance(companyId, mapping.accountId, currency, asOf),
      currency,
    );
    const open = await this.db
      .select({
        documentNumber: bankTransfers.documentNumber,
        baseAmount: bankTransfers.baseAmount,
      })
      .from(bankTransfers)
      .where(
        and(
          eq(bankTransfers.companyId, companyId),
          sql`${bankTransfers.transferDate} <= ${asOf}`,
          or(
            eq(bankTransfers.status, 'SENT'),
            and(
              eq(bankTransfers.status, 'SETTLED'),
              sql`${bankTransfers.settlementDate} > ${asOf}`,
            ),
          ),
        ),
      );
    const expected = open.reduce(
      (m, t) => m.add(Money.of(t.baseAmount, currency)),
      Money.zero(currency),
    );
    const variance = ledger.subtract(expected);
    return finding(
      'IN_TRANSIT_VS_LEDGER',
      'CRITICAL',
      'Cash in transit equals open transfers',
      variance.isZero() ? 0 : 1,
      variance.isZero()
        ? []
        : [
            {
              ledger: ledger.toString(),
              openTransfers: expected.toString(),
              variance: variance.toString(),
              transfers: open.map((t) => t.documentNumber),
            },
          ],
      `Ledger ${ledger.toString()} vs ${open.length} unsettled transfer(s) ${expected.toString()}.`,
    );
  }

  private async transfersWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: bankTransfers.documentNumber,
        status: bankTransfers.status,
        out: bankTransfers.outJournalEntryId,
        inn: bankTransfers.inJournalEntryId,
      })
      .from(bankTransfers)
      .where(
        and(
          eq(bankTransfers.companyId, companyId),
          inArray(bankTransfers.status, ['SENT', 'SETTLED']),
        ),
      );
    const bad = rows.filter((r) => !r.out || (r.status === 'SETTLED' && !r.inn));
    return finding(
      'TRANSFERS_WITHOUT_JOURNAL',
      'CRITICAL',
      'Sent / settled transfers have both journal legs',
      bad.length,
      bad.slice(0, 20).map((r) => ({ documentNumber: r.documentNumber, status: r.status })),
    );
  }

  private async unsettledTransfers(companyId: string, asOf: string): Promise<IntegrityFinding> {
    const settings = await this.config.settings(companyId);
    const rows = await this.db
      .select({
        documentNumber: bankTransfers.documentNumber,
        expected: bankTransfers.expectedSettlementDate,
        amount: bankTransfers.amount,
        currency: bankTransfers.fromCurrency,
      })
      .from(bankTransfers)
      .where(
        and(
          eq(bankTransfers.companyId, companyId),
          eq(bankTransfers.status, 'SENT'),
          sql`${bankTransfers.expectedSettlementDate} < ${asOf}::date - ${settings.unsettledTransferWarnDays}::int`,
        ),
      );
    return finding(
      'UNSETTLED_TRANSFERS',
      'WARNING',
      `Transfers settle within ${settings.unsettledTransferWarnDays} day(s) of the expected date`,
      rows.length,
      rows.slice(0, 20),
    );
  }

  /** imprest = expected cash on hand + posted unreimbursed vouchers, by construction; the GL must agree. */
  private async pettyCashVsImprest(companyId: string, currency: string): Promise<IntegrityFinding> {
    const funds = await this.db
      .select()
      .from(pettyCashFunds)
      .where(and(eq(pettyCashFunds.companyId, companyId), eq(pettyCashFunds.status, 'ACTIVE')));
    const bad: Array<Record<string, unknown>> = [];
    for (const f of funds) {
      const [agg] = await this.db
        .select({ open: sql<string>`coalesce(sum(${pettyCashVouchers.total}), 0)` })
        .from(pettyCashVouchers)
        .where(
          and(
            eq(pettyCashVouchers.fundId, f.id),
            eq(pettyCashVouchers.status, 'POSTED'),
            isNull(pettyCashVouchers.replenishmentId),
          ),
        );
      const onHand = Money.of(f.imprestAmount, currency).subtract(
        Money.of(agg?.open ?? '0', currency),
      );
      if (onHand.isNegative())
        bad.push({
          fund: f.code,
          imprest: f.imprestAmount,
          openVouchers: agg?.open,
          expectedCashOnHand: onHand.toString(),
        });
    }
    return finding(
      'PETTY_CASH_OVERSPENT',
      'CRITICAL',
      'Petty cash vouchers never exceed the imprest',
      bad.length,
      bad,
    );
  }

  private async vouchersWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ documentNumber: pettyCashVouchers.documentNumber })
      .from(pettyCashVouchers)
      .where(
        and(
          eq(pettyCashVouchers.companyId, companyId),
          eq(pettyCashVouchers.status, 'POSTED'),
          isNull(pettyCashVouchers.journalEntryId),
        ),
      );
    return finding(
      'VOUCHERS_WITHOUT_JOURNAL',
      'CRITICAL',
      'Posted petty cash vouchers have a journal',
      rows.length,
      rows.slice(0, 20),
    );
  }

  /** Fund GL balance must equal imprest minus unreimbursed vouchers (nothing else may touch the fund account). */
  private async pettyCashLedgerDrift(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const funds = await this.db
      .select()
      .from(pettyCashFunds)
      .where(and(eq(pettyCashFunds.companyId, companyId), eq(pettyCashFunds.status, 'ACTIVE')));
    const bad: Array<Record<string, unknown>> = [];
    for (const f of funds) {
      const ledger = Money.of(
        await this.banking.ledgerBalance(companyId, f.glAccountId, currency, asOf),
        currency,
      );
      const [agg] = await this.db
        .select({ open: sql<string>`coalesce(sum(${pettyCashVouchers.total}), 0)` })
        .from(pettyCashVouchers)
        .where(
          and(
            eq(pettyCashVouchers.fundId, f.id),
            eq(pettyCashVouchers.status, 'POSTED'),
            isNull(pettyCashVouchers.replenishmentId),
            sql`${pettyCashVouchers.voucherDate} <= ${asOf}`,
          ),
        );
      const expected = Money.of(f.imprestAmount, currency).subtract(
        Money.of(agg?.open ?? '0', currency),
      );
      // A fund that was never funded (no opening transfer yet) is reported once as a warning-level sample.
      if (!ledger.equals(expected))
        bad.push({
          fund: f.code,
          ledger: ledger.toString(),
          expected: expected.toString(),
          variance: ledger.subtract(expected).toString(),
        });
    }
    return finding(
      'PETTY_CASH_LEDGER_DRIFT',
      'WARNING',
      'Petty cash GL equals imprest less unreimbursed vouchers',
      bad.length,
      bad,
      'Fund the account with a bank withdrawal or replenish to clear.',
    );
  }

  private async paymentFileTotals(companyId: string, currency: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: paymentFiles.documentNumber,
        totalAmount: paymentFiles.totalAmount,
        paymentCount: paymentFiles.paymentCount,
        lineTotal: sql<string>`coalesce(sum(${paymentFileLines.amount}), 0)`,
        lineCount: sql<number>`count(${paymentFileLines.id})`,
      })
      .from(paymentFiles)
      .leftJoin(paymentFileLines, eq(paymentFileLines.fileId, paymentFiles.id))
      .where(eq(paymentFiles.companyId, companyId))
      .groupBy(paymentFiles.id);
    const bad = rows.filter(
      (r) =>
        !Money.of(r.totalAmount, currency).equals(Money.of(r.lineTotal, currency)) ||
        Number(r.lineCount) !== r.paymentCount,
    );
    return finding(
      'PAYMENT_FILE_TOTALS',
      'CRITICAL',
      'Payment file totals equal their lines',
      bad.length,
      bad.slice(0, 20),
    );
  }

  private async paymentsInSeveralFiles(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ paymentId: paymentFileLines.paymentId, files: sql<number>`count(*)` })
      .from(paymentFileLines)
      .innerJoin(paymentFiles, eq(paymentFiles.id, paymentFileLines.fileId))
      .where(
        and(
          eq(paymentFiles.companyId, companyId),
          inArray(paymentFiles.status, ['GENERATED', 'TRANSMITTED', 'ACKNOWLEDGED']),
        ),
      )
      .groupBy(paymentFileLines.paymentId)
      .having(sql`count(*) > 1`);
    return finding(
      'PAYMENT_IN_SEVERAL_FILES',
      'CRITICAL',
      'A payment sits in at most one live payment file',
      rows.length,
      rows.slice(0, 20),
    );
  }

  private async filesWithNonPostedPayments(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        file: paymentFiles.documentNumber,
        payment: vendorPayments.documentNumber,
        status: vendorPayments.status,
      })
      .from(paymentFileLines)
      .innerJoin(paymentFiles, eq(paymentFiles.id, paymentFileLines.fileId))
      .innerJoin(vendorPayments, eq(vendorPayments.id, paymentFileLines.paymentId))
      .where(
        and(
          eq(paymentFiles.companyId, companyId),
          inArray(paymentFiles.status, ['GENERATED', 'TRANSMITTED', 'ACKNOWLEDGED']),
          sql`${vendorPayments.status} <> 'POSTED'`,
        ),
      );
    return finding(
      'FILE_PAYMENT_NOT_POSTED',
      'CRITICAL',
      'Live payment files carry only posted payments',
      rows.length,
      rows.slice(0, 20),
    );
  }

  /** Statement closing balance vs book balance beyond the unreconciled lines. */
  private async statementDrift(companyId: string, asOf: string): Promise<IntegrityFinding> {
    const position = await this.positions.position(companyId, { asOf });
    const bad = position.accounts
      .filter((a) => a.statementBalance !== null)
      .map((a) => {
        const stmt = Money.of(a.statementBalance!, a.currency);
        // Book + (unreconciled in - out) should equal the bank's balance once statement lines are all matched.
        const explained = Money.of(a.bookBalance, a.currency)
          .add(Money.of(a.unreconciledIn, a.currency))
          .subtract(Money.of(a.unreconciledOut, a.currency));
        return {
          account: a.code,
          statementDate: a.statementDate,
          statementBalance: stmt.toString(),
          bookBalance: a.bookBalance,
          explained: explained.toString(),
          variance: stmt.subtract(explained).toString(),
        };
      })
      .filter((r) => Number(r.variance) !== 0);
    return finding(
      'STATEMENT_DRIFT',
      'WARNING',
      'Statement balances are explained by the books plus unmatched lines',
      bad.length,
      bad.slice(0, 20),
      'Timing differences (cheques not yet cleared) are expected between statements.',
    );
  }

  private async accountsBelowMinimum(companyId: string, asOf: string): Promise<IntegrityFinding> {
    const position = await this.positions.position(companyId, { asOf });
    const bad = position.accounts
      .filter((a) => a.belowMinimum && !a.excludeFromPosition)
      .map((a) => ({
        account: a.code,
        bookBalance: a.bookBalance,
        minimumBalance: a.minimumBalance,
        currency: a.currency,
      }));
    return finding(
      'ACCOUNTS_BELOW_MINIMUM',
      'WARNING',
      'Bank accounts hold their minimum balance',
      bad.length,
      bad,
    );
  }

  private async accountMappings(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ key: accountMappings.key })
      .from(accountMappings)
      .where(eq(accountMappings.companyId, companyId));
    const have = new Set(rows.map((r) => r.key));
    const missing = TREASURY_MAPPINGS.filter((m) => !have.has(m.key));
    const required = missing.filter((m) => m.required);
    return finding(
      'TREASURY_ACCOUNT_MAPPINGS',
      required.length ? 'CRITICAL' : 'WARNING',
      'Treasury account mappings are configured',
      missing.length,
      missing.map((m) => ({ key: m.key, required: m.required })),
      missing.length
        ? 'Map CASH_IN_TRANSIT before sending transfers; BANK_CHARGES / FX_GAIN / FX_LOSS before fees or cross-currency transfers.'
        : undefined,
    );
  }
}

function finding(
  check: string,
  severity: IntegrityFinding['severity'],
  title: string,
  count: number,
  samples: Array<Record<string, unknown>>,
  detail?: string,
): IntegrityFinding {
  return { check, severity, title, count, samples: samples.slice(0, 20), detail };
}
