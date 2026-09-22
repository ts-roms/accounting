import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES } from '@accounting/types';
import type { CashRequirementsQuery } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import { paymentRuns, vendorBills, vendorPayments, vendors } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { addDays } from '@/modules/subledger/subledger.logic';
import { businessToday } from '@/common/time/clock';
import { ApAccrualsService } from './ap-accruals.service';
import { ApConfigService } from './ap-config.service';
import { ApReportsService } from './ap-reports.service';
import {
  cashRequirements,
  daysPayableOutstanding,
  discountAvailable,
  discountCaptureRate,
  type CashRequirementBucket,
} from './payables.logic';

export interface ApDashboard {
  asOf: string;
  currency: string;
  totals: {
    totalPayables: string;
    current: string;
    overdue: string;
    dueSoon: string;
    dueSoonDays: number;
    onHold: string;
    onHoldCount: number;
    unappliedCredits: string;
    discountsAvailable: string;
    discountsExpiring: string;
    discountsExpiringCount: number;
    discountCaptureRate: number;
    dpo: number;
    dpoWindowDays: number;
    grni: string;
    grniAged: string;
    vendorsOnHold: number;
    vendorsPendingApproval: number;
    billsAwaitingApproval: number;
    pendingPaymentRuns: number;
    pendingPaymentRunsAmount: string;
  };
  aging: Array<{ key: string; label: string; amount: string }>;
  cashRequirements: CashRequirementBucket[];
  paymentsTrend: Array<{ month: string; paid: string; billed: string; discountsTaken: string }>;
  dpoTrend: Array<{ month: string; dpo: number }>;
  topVendors: Array<{
    vendorId: string;
    code: string;
    name: string;
    outstanding: string;
    overdue: string;
    oldestDueDate: string | null;
  }>;
}

export interface CashRequirementsReport {
  asOf: string;
  currency: string;
  horizons: number[];
  buckets: CashRequirementBucket[];
  onHold: string;
  bills: Array<{
    billId: string;
    documentNumber: string;
    vendorInvoiceNumber: string | null;
    vendorId: string;
    vendorName: string;
    dueDate: string;
    discountDate: string | null;
    openAmount: string;
    discountAvailable: string;
    onHold: boolean;
  }>;
}

/**
 * Executive AP dashboard (Prompt #7). Every figure comes from posted
 * subledger data through the same services the reports use - there is no
 * separately maintained KPI store.
 */
@Injectable()
export class ApDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly reports: ApReportsService,
    private readonly config: ApConfigService,
    private readonly accruals: ApAccrualsService,
  ) {}

  async dashboard(companyId: string, asOf = businessToday()): Promise<ApDashboard> {
    const currency = await this.accounts.companyCurrency(companyId);
    const settings = await this.config.settings(companyId);
    const aging = await this.reports.aging(companyId, { asOf });
    const outstanding = Money.of(aging.totals.outstanding, currency);
    const currentKey = aging.buckets[0]!.key;
    const current = Money.of(aging.totals[currentKey] ?? '0', currency);
    const overdue = outstanding.subtract(current);

    const open = await this.openBills(companyId, asOf);
    const dueSoonEnd = addDays(asOf, settings.dueSoonDays);
    const discountWarnEnd = addDays(asOf, settings.discountWarnDays);
    let dueSoon = Money.zero(currency);
    let onHold = Money.zero(currency);
    let onHoldCount = 0;
    let discountsAvailable = Money.zero(currency);
    let discountsExpiring = Money.zero(currency);
    let discountsExpiringCount = 0;
    for (const b of open) {
      const openAmount = Money.of(b.openAmount, currency);
      if (b.onHold) {
        onHold = onHold.add(openAmount);
        onHoldCount += 1;
        continue;
      }
      if (b.dueDate >= asOf && b.dueDate <= dueSoonEnd) dueSoon = dueSoon.add(openAmount);
      const disc = Money.of(b.discountAvailable, currency);
      if (disc.isPositive()) {
        discountsAvailable = discountsAvailable.add(disc);
        if (b.discountDate && b.discountDate <= discountWarnEnd) {
          discountsExpiring = discountsExpiring.add(disc);
          discountsExpiringCount += 1;
        }
      }
    }

    const [purchasesWindow, discountsWindow] = await Promise.all([
      this.purchases(companyId, addDays(asOf, -settings.dpoWindowDays), asOf, currency),
      this.discountsWindow(companyId, addDays(asOf, -settings.dpoWindowDays), asOf, currency),
    ]);
    const dpo = daysPayableOutstanding(
      outstanding.toString(),
      purchasesWindow.toString(),
      settings.dpoWindowDays,
      currency,
    );

    const grni = await this.accruals.grni(companyId, { asOf });
    const [vendorStates, awaiting, runs] = await Promise.all([
      this.db
        .select({ status: vendors.vendorStatus, count: sql<number>`count(*)` })
        .from(vendors)
        .where(eq(vendors.companyId, companyId))
        .groupBy(vendors.vendorStatus),
      this.db
        .select({ count: sql<number>`count(*)` })
        .from(vendorBills)
        .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.status, 'SUBMITTED'))),
      this.db
        .select({
          count: sql<number>`count(*)`,
          amount: sql<string>`coalesce(sum(${paymentRuns.totalAmount}), 0)`,
        })
        .from(paymentRuns)
        .where(
          and(
            eq(paymentRuns.companyId, companyId),
            inArray(paymentRuns.status, ['SUBMITTED', 'APPROVED']),
          ),
        ),
    ]);
    const stateCount = (s: string) => Number(vendorStates.find((v) => v.status === s)?.count ?? 0);

    // Six month-end trend points.
    const months = monthEnds(asOf, 6);
    const paymentsTrend: ApDashboard['paymentsTrend'] = [];
    const dpoTrend: ApDashboard['dpoTrend'] = [];
    for (const m of months) {
      const [paid] = await this.db
        .select({
          total: sql<string>`coalesce(sum(${vendorPayments.baseAmount}), 0)`,
          discounts: sql<string>`coalesce(sum(${vendorPayments.discountAmount} * ${vendorPayments.exchangeRate}), 0)`,
        })
        .from(vendorPayments)
        .where(
          and(
            eq(vendorPayments.companyId, companyId),
            eq(vendorPayments.status, 'POSTED'),
            eq(vendorPayments.paymentType, 'PAYMENT'),
            gte(vendorPayments.paymentDate, m.start),
            lte(vendorPayments.paymentDate, m.end),
          ),
        );
      const billed = await this.purchases(companyId, addDays(m.start, -1), m.end, currency);
      const monthAging =
        m.end === asOf ? aging : await this.reports.aging(companyId, { asOf: m.end });
      const monthOpen = Money.of(monthAging.totals.outstanding, currency);
      const windowPurchases = await this.purchases(
        companyId,
        addDays(m.end, -settings.dpoWindowDays),
        m.end,
        currency,
      );
      paymentsTrend.push({
        month: m.label,
        paid: Money.of(paid?.total ?? '0', currency).toString(),
        billed: billed.toString(),
        discountsTaken: Money.of(paid?.discounts ?? '0', currency).toString(),
      });
      dpoTrend.push({
        month: m.label,
        dpo: daysPayableOutstanding(
          monthOpen.toString(),
          windowPurchases.toString(),
          settings.dpoWindowDays,
          currency,
        ),
      });
    }

    const topVendors = aging.rows
      .map((r) => {
        const rowCurrent = Money.of(r.buckets[currentKey] ?? '0', currency);
        return {
          vendorId: r.partyId,
          code: r.code,
          name: r.name,
          outstanding: r.outstanding,
          overdue: Money.of(r.outstanding, currency).subtract(rowCurrent).toString(),
          oldestDueDate: r.oldestDueDate,
        };
      })
      .sort((a, b) => Number(b.outstanding) - Number(a.outstanding))
      .slice(0, 8);

    return {
      asOf,
      currency,
      totals: {
        totalPayables: outstanding.toString(),
        current: current.toString(),
        overdue: overdue.toString(),
        dueSoon: dueSoon.toString(),
        dueSoonDays: settings.dueSoonDays,
        onHold: onHold.toString(),
        onHoldCount,
        unappliedCredits: aging.totals.unappliedCredit,
        discountsAvailable: discountsAvailable.toString(),
        discountsExpiring: discountsExpiring.toString(),
        discountsExpiringCount,
        discountCaptureRate: discountCaptureRate(
          discountsWindow.taken.toString(),
          discountsWindow.offered.toString(),
          currency,
        ),
        dpo,
        dpoWindowDays: settings.dpoWindowDays,
        grni: grni.totals.total,
        grniAged: grni.totals.aged,
        vendorsOnHold: stateCount('ON_HOLD') + stateCount('BLOCKED'),
        vendorsPendingApproval: stateCount('PENDING'),
        billsAwaitingApproval: Number(awaiting[0]?.count ?? 0),
        pendingPaymentRuns: Number(runs[0]?.count ?? 0),
        pendingPaymentRunsAmount: Money.of(runs[0]?.amount ?? '0', currency).toString(),
      },
      aging: aging.buckets.map((b) => ({
        key: b.key,
        label: b.label,
        amount: aging.totals[b.key] ?? '0.0000',
      })),
      cashRequirements: cashRequirements(
        open.filter((b) => !b.onHold),
        asOf,
        settings.cashRequirementHorizons,
        currency,
      ),
      paymentsTrend,
      dpoTrend,
      topVendors,
    };
  }

  /** Cash needed by horizon plus the bill-level detail behind it. */
  async cashRequirements(
    companyId: string,
    query: CashRequirementsQuery,
  ): Promise<CashRequirementsReport> {
    const asOf = query.asOf ?? businessToday();
    const currency = await this.accounts.companyCurrency(companyId);
    const settings = await this.config.settings(companyId);
    const horizons = query.days ? [query.days] : settings.cashRequirementHorizons;
    const open = (await this.openBills(companyId, asOf, query.vendorId)).filter(
      (b) => !query.currency || b.currency === query.currency,
    );
    const held = open.filter((b) => b.onHold);
    return {
      asOf,
      currency,
      horizons: [...horizons],
      buckets: cashRequirements(
        open.filter((b) => !b.onHold),
        asOf,
        horizons,
        currency,
      ),
      onHold: held
        .reduce((m, b) => m.add(Money.of(b.openAmount, currency)), Money.zero(currency))
        .toString(),
      bills: open
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((b) => ({
          billId: b.billId,
          documentNumber: b.documentNumber,
          vendorInvoiceNumber: b.vendorInvoiceNumber,
          vendorId: b.vendorId,
          vendorName: b.vendorName,
          dueDate: b.dueDate,
          discountDate: b.discountDate,
          openAmount: b.openAmount,
          discountAvailable: b.discountAvailable,
          onHold: b.onHold,
        })),
    };
  }

  // ---------------------------------------------------------------- internals

  /** Open posted bills / debit notes with balances in base currency and today's discount. */
  private async openBills(companyId: string, asOf: string, vendorId?: string) {
    const rows = await this.db
      .select({
        bill: vendorBills,
        vendorName: vendors.name,
        activeHold: sql<boolean>`exists (select 1 from bill_holds h where h.bill_id = ${vendorBills.id} and h.status = 'ACTIVE')`,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
          inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
          gt(vendorBills.total, vendorBills.allocatedAmount),
          ...(vendorId ? [eq(vendorBills.vendorId, vendorId)] : []),
        ),
      )
      .orderBy(desc(vendorBills.dueDate));
    const base = await this.accounts.companyCurrency(companyId);
    return rows.map((r) => {
      const openDoc = Money.of(r.bill.total, r.bill.currency).subtract(
        Money.of(r.bill.allocatedAmount, r.bill.currency),
      );
      return {
        billId: r.bill.id,
        documentNumber: r.bill.documentNumber,
        vendorInvoiceNumber: r.bill.vendorInvoiceNumber,
        vendorId: r.bill.vendorId,
        vendorName: r.vendorName,
        currency: r.bill.currency,
        dueDate: r.bill.dueDate,
        discountDate: r.bill.discountDate,
        openAmount: openDoc.convert(base, r.bill.exchangeRate).toString(),
        discountAvailable: discountAvailable(r.bill, asOf, r.bill.currency)
          .convert(base, r.bill.exchangeRate)
          .toString(),
        onHold: r.bill.onHold || r.activeHold || r.bill.matchStatus === 'EXCEPTION',
      };
    });
  }

  /** Posted bills less vendor credits in a window (base currency) - the DPO denominator. */
  private async purchases(
    companyId: string,
    after: string,
    to: string,
    currency: string,
  ): Promise<Money> {
    const rows = await this.db
      .select({
        documentType: vendorBills.documentType,
        total: sql<string>`coalesce(sum(${vendorBills.baseTotal}), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          gt(vendorBills.documentDate, after),
          lte(vendorBills.documentDate, to),
        ),
      )
      .groupBy(vendorBills.documentType);
    let total = Money.zero(currency);
    for (const r of rows) {
      const amount = Money.of(r.total, currency);
      total = r.documentType === 'CREDIT_NOTE' ? total.subtract(amount) : total.add(amount);
    }
    return total;
  }

  /** Discounts offered on bills dated in the window versus discounts actually taken on them. */
  private async discountsWindow(companyId: string, after: string, to: string, currency: string) {
    const [row] = await this.db
      .select({
        offered: sql<string>`coalesce(sum(${vendorBills.discountAmount} * ${vendorBills.exchangeRate}), 0)`,
        taken: sql<string>`coalesce(sum(${vendorBills.discountTakenAmount} * ${vendorBills.exchangeRate}), 0)`,
      })
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          gt(vendorBills.documentDate, after),
          lte(vendorBills.documentDate, to),
          sql`${vendorBills.discountDate} < ${to}`,
        ),
      );
    return {
      offered: Money.of(row?.offered ?? '0', currency),
      taken: Money.of(row?.taken ?? '0', currency),
    };
  }
}

function monthEnds(asOf: string, n: number): Array<{ label: string; start: string; end: string }> {
  const [y, m] = asOf.split('-').map(Number) as [number, number, number];
  const out: Array<{ label: string; start: string; end: string }> = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const start = new Date(Date.UTC(y, m - 1 - i, 1));
    const end = new Date(Date.UTC(y, m - i, 0));
    const startIso = start.toISOString().slice(0, 10);
    const endIso = end.toISOString().slice(0, 10);
    out.push({ label: startIso.slice(0, 7), start: startIso, end: i === 0 ? asOf : endIso });
  }
  return out;
}
