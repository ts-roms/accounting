import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { PaginatedResult } from '@accounting/types';
import type { CustomerStatementsQuery, ListCustomerStatementsQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { NotFoundError } from '@/common/errors/app-error';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  collectionCases,
  customerCreditProfiles,
  customerPayments,
  customerStatements,
  customers,
  invoiceDisputes,
  invoices,
  paymentAllocations,
  promisesToPay,
  type CustomerStatement,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { addDays } from '@/modules/subledger/subledger.logic';
import { businessToday } from '@/common/time/clock';
import { ArConfigService } from './ar-config.service';
import { ArReportsService, type StatementReport } from './ar-reports.service';
import { CustomersService } from './customers.service';
import {
  collectionRate,
  daysSalesOutstanding,
  summarizeCredit,
  unappliedAge,
} from './receivables.logic';

export interface ArDashboard {
  asOf: string;
  currency: string;
  totals: {
    totalReceivables: string;
    current: string;
    overdue: string;
    unappliedCash: string;
    unappliedCashStale: string;
    unappliedCashStaleCount: number;
    dso: number;
    dsoWindowDays: number;
    collectionRate: number;
    creditExposure: string;
    creditLimitTotal: string;
    customersOverLimit: number;
    customersOnHold: number;
    openCases: number;
    openDisputes: number;
    pendingPromises: number;
    brokenPromises: number;
  };
  aging: Array<{ key: string; label: string; amount: string }>;
  collectionsTrend: Array<{ month: string; collected: string; invoiced: string }>;
  revenueVsReceivables: Array<{ month: string; revenue: string; receivables: string }>;
  dsoTrend: Array<{ month: string; dso: number }>;
  topOverdue: Array<{
    customerId: string;
    code: string;
    name: string;
    overdue: string;
    outstanding: string;
    oldestDueDate: string | null;
  }>;
}

/**
 * Executive AR dashboard and statement snapshots (Prompt #6). Every number is
 * derived from posted subledger data through the same services the reports
 * use - there is no separately maintained KPI store.
 */
@Injectable()
export class ArDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly reports: ArReportsService,
    private readonly config: ArConfigService,
    private readonly customersService: CustomersService,
    private readonly numbering: DocumentNumberingService,
    private readonly audit: AuditService,
  ) {}

  async dashboard(companyId: string, asOf = businessToday()): Promise<ArDashboard> {
    const currency = await this.accounts.companyCurrency(companyId);
    const settings = await this.config.settings(companyId);
    const aging = await this.reports.aging(companyId, { asOf });
    const outstanding = Money.of(aging.totals.outstanding, currency);
    const currentKey = aging.buckets[0]!.key;
    const current = Money.of(aging.totals[currentKey] ?? '0', currency);
    const overdue = outstanding.subtract(current);

    // Unapplied cash: posted receipts with an unallocated remainder, aged from the payment date.
    const unapplied = await this.db
      .select({
        amount: customerPayments.amount,
        allocatedAmount: customerPayments.allocatedAmount,
        currency: customerPayments.currency,
        exchangeRate: customerPayments.exchangeRate,
        paymentDate: customerPayments.paymentDate,
      })
      .from(customerPayments)
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.status, 'POSTED'),
          eq(customerPayments.paymentType, 'PAYMENT'),
          lte(customerPayments.paymentDate, asOf),
          sql`${customerPayments.allocatedAmount} < ${customerPayments.amount}`,
        ),
      );
    let unappliedCash = Money.zero(currency);
    let stale = Money.zero(currency);
    let staleCount = 0;
    for (const p of unapplied) {
      const rem = Money.of(p.amount, p.currency)
        .subtract(Money.of(p.allocatedAmount, p.currency))
        .convert(currency, p.exchangeRate);
      unappliedCash = unappliedCash.add(rem);
      if (unappliedAge(p.paymentDate, asOf) > settings.unappliedCashWarnDays) {
        stale = stale.add(rem);
        staleCount += 1;
      }
    }

    // DSO (countback over the configured window) and collection rate (last 30 days).
    const windowStart = addDays(asOf, -settings.dsoWindowDays);
    const revenueInWindow = await this.creditSales(companyId, windowStart, asOf, currency);
    const dso = daysSalesOutstanding(
      outstanding.toString(),
      revenueInWindow.toString(),
      settings.dsoWindowDays,
      currency,
    );
    const rateStart = addDays(asOf, -30);
    const [collected] = await this.db
      .select({ total: sql<string>`coalesce(sum(${paymentAllocations.amount}), 0)` })
      .from(paymentAllocations)
      .where(
        and(
          eq(paymentAllocations.companyId, companyId),
          gt(paymentAllocations.allocationDate, rateStart),
          lte(paymentAllocations.allocationDate, asOf),
          sql`${paymentAllocations.paymentId} is not null`,
        ),
      );
    const [due] = await this.db
      .select({ total: sql<string>`coalesce(sum(${invoices.total}), 0)` })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.status} <> 'VOID'`,
          gt(invoices.dueDate, rateStart),
          lte(invoices.dueDate, asOf),
        ),
      );
    const rate = collectionRate(collected?.total ?? '0', due?.total ?? '0', currency);

    // Credit exposure across active customers with a limit.
    const customerRows = await this.db
      .select({
        id: customers.id,
        creditLimit: customers.creditLimit,
        creditHold: sql<boolean>`coalesce(${customerCreditProfiles.creditHold}, false)`,
      })
      .from(customers)
      .leftJoin(customerCreditProfiles, eq(customerCreditProfiles.customerId, customers.id))
      .where(and(eq(customers.companyId, companyId), eq(customers.status, 'ACTIVE')));
    const balances = await this.customersService.balances(
      companyId,
      customerRows.map((c) => c.id),
    );
    const pendingByCustomer = await this.db
      .select({
        customerId: invoices.customerId,
        total: sql<string>`coalesce(sum(${invoices.total}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.accountingStatus, 'UNPOSTED'),
          inArray(invoices.documentType, ['INVOICE', 'DEBIT_NOTE']),
          sql`${invoices.status} <> 'VOID'`,
        ),
      )
      .groupBy(invoices.customerId);
    const pendingMap = new Map(pendingByCustomer.map((r) => [r.customerId, r.total]));
    let exposure = Money.zero(currency);
    let limitTotal = Money.zero(currency);
    let overLimit = 0;
    let onHold = 0;
    for (const c of customerRows) {
      const b = balances.get(c.id)!;
      const summary = summarizeCredit(
        {
          creditLimit: c.creditLimit,
          netBalance: b.net,
          pendingDocuments: pendingMap.get(c.id) ?? '0',
          openOrders: '0',
          overdue: b.overdue,
          oldestOverdueDays: 0,
          creditHold: c.creditHold,
        },
        currency,
      );
      exposure = exposure.add(Money.of(summary.creditUsed, currency));
      if (c.creditLimit) limitTotal = limitTotal.add(Money.of(c.creditLimit, currency));
      if (summary.status === 'OVER_LIMIT') overLimit += 1;
      if (c.creditHold) onHold += 1;
    }

    const [cases] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(collectionCases)
      .where(
        and(
          eq(collectionCases.companyId, companyId),
          inArray(collectionCases.status, [
            'NEW',
            'CONTACTED',
            'PROMISED',
            'ESCALATED',
            'DISPUTED',
          ]),
        ),
      );
    const [disputes] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(invoiceDisputes)
      .where(
        and(
          eq(invoiceDisputes.companyId, companyId),
          inArray(invoiceDisputes.status, ['OPEN', 'INVESTIGATING']),
        ),
      );
    const promiseRows = await this.db
      .select({ status: promisesToPay.status, n: sql<number>`count(*)::int` })
      .from(promisesToPay)
      .where(eq(promisesToPay.companyId, companyId))
      .groupBy(promisesToPay.status);

    // Six month-end trend points.
    const months = monthEnds(asOf, 6);
    const collectionsTrend: ArDashboard['collectionsTrend'] = [];
    const revenueVsReceivables: ArDashboard['revenueVsReceivables'] = [];
    const dsoTrend: ArDashboard['dsoTrend'] = [];
    for (const m of months) {
      const [rc] = await this.db
        .select({ total: sql<string>`coalesce(sum(${customerPayments.baseAmount}), 0)` })
        .from(customerPayments)
        .where(
          and(
            eq(customerPayments.companyId, companyId),
            eq(customerPayments.status, 'POSTED'),
            eq(customerPayments.paymentType, 'PAYMENT'),
            gte(customerPayments.paymentDate, m.start),
            lte(customerPayments.paymentDate, m.end),
          ),
        );
      const invoiced = await this.creditSales(companyId, addDays(m.start, -1), m.end, currency);
      const monthAging =
        m.end === asOf ? aging : await this.reports.aging(companyId, { asOf: m.end });
      const open = Money.of(monthAging.totals.outstanding, currency);
      const windowRevenue = await this.creditSales(
        companyId,
        addDays(m.end, -settings.dsoWindowDays),
        m.end,
        currency,
      );
      collectionsTrend.push({
        month: m.label,
        collected: Money.of(rc?.total ?? '0', currency).toString(),
        invoiced: invoiced.toString(),
      });
      revenueVsReceivables.push({
        month: m.label,
        revenue: invoiced.toString(),
        receivables: open.toString(),
      });
      dsoTrend.push({
        month: m.label,
        dso: daysSalesOutstanding(
          open.toString(),
          windowRevenue.toString(),
          settings.dsoWindowDays,
          currency,
        ),
      });
    }

    const topOverdue = aging.rows
      .map((r) => ({
        customerId: r.partyId,
        code: r.code,
        name: r.name,
        overdue: Money.of(r.outstanding, currency)
          .subtract(Money.of(r.buckets[currentKey] ?? '0', currency))
          .toString(),
        outstanding: r.outstanding,
        oldestDueDate: r.oldestDueDate,
      }))
      .filter((r) => Money.of(r.overdue, currency).isPositive())
      .sort((a, b) => Number(b.overdue) - Number(a.overdue))
      .slice(0, 8);

    return {
      asOf,
      currency,
      totals: {
        totalReceivables: outstanding.toString(),
        current: current.toString(),
        overdue: overdue.toString(),
        unappliedCash: unappliedCash.toString(),
        unappliedCashStale: stale.toString(),
        unappliedCashStaleCount: staleCount,
        dso,
        dsoWindowDays: settings.dsoWindowDays,
        collectionRate: rate,
        creditExposure: exposure.toString(),
        creditLimitTotal: limitTotal.toString(),
        customersOverLimit: overLimit,
        customersOnHold: onHold,
        openCases: cases?.n ?? 0,
        openDisputes: disputes?.n ?? 0,
        pendingPromises: promiseRows.find((p) => p.status === 'PENDING')?.n ?? 0,
        brokenPromises: promiseRows.find((p) => p.status === 'BROKEN')?.n ?? 0,
      },
      aging: aging.buckets.map((b) => ({
        key: b.key,
        label: b.label,
        amount: aging.totals[b.key] ?? '0.0000',
      })),
      collectionsTrend,
      revenueVsReceivables,
      dsoTrend,
      topOverdue,
    };
  }

  /** Unapplied receipts with their age (the unapplied-cash monitor). */
  async unappliedCash(companyId: string, asOf = businessToday()) {
    const settings = await this.config.settings(companyId);
    const rows = await this.db
      .select({
        id: customerPayments.id,
        documentNumber: customerPayments.documentNumber,
        customerId: customerPayments.customerId,
        customerCode: customers.code,
        customerName: customers.name,
        paymentDate: customerPayments.paymentDate,
        amount: customerPayments.amount,
        allocatedAmount: customerPayments.allocatedAmount,
        currency: customerPayments.currency,
        reference: customerPayments.reference,
      })
      .from(customerPayments)
      .innerJoin(customers, eq(customers.id, customerPayments.customerId))
      .where(
        and(
          eq(customerPayments.companyId, companyId),
          eq(customerPayments.status, 'POSTED'),
          eq(customerPayments.paymentType, 'PAYMENT'),
          lte(customerPayments.paymentDate, asOf),
          sql`${customerPayments.allocatedAmount} < ${customerPayments.amount}`,
        ),
      )
      .orderBy(customerPayments.paymentDate);
    return {
      asOf,
      warnDays: settings.unappliedCashWarnDays,
      items: rows.map((r) => ({
        ...r,
        unallocated: Money.of(r.amount, r.currency)
          .subtract(Money.of(r.allocatedAmount, r.currency))
          .toString(),
        ageDays: unappliedAge(r.paymentDate, asOf),
        stale: unappliedAge(r.paymentDate, asOf) > settings.unappliedCashWarnDays,
      })),
    };
  }

  // ---------------------------------------------------------------- statements

  /** Generates a statement (optionally persisting the snapshot that was issued to the customer). */
  async statement(
    companyId: string,
    actor: AuthenticatedUser,
    query: CustomerStatementsQuery,
  ): Promise<StatementReport & { snapshotId: string | null; snapshotNumber: string | null }> {
    const report = await this.reports.statement(companyId, query.customerId, {
      from: query.from,
      to: query.to,
    });
    if (!query.save) return { ...report, snapshotId: null, snapshotNumber: null };
    const snapshot = await this.db.transaction(async (tx) => {
      const documentNumber = await this.numbering.allocate(
        companyId,
        'STMT',
        Number(query.to.slice(0, 4)),
        tx,
      );
      const [row] = await tx
        .insert(customerStatements)
        .values({
          companyId,
          documentNumber,
          customerId: query.customerId,
          branchId: query.branchId ?? null,
          fromDate: query.from,
          toDate: query.to,
          currency: report.currency,
          openingBalance: report.openingBalance,
          closingBalance: report.closingBalance,
          lines: report.lines as unknown as Record<string, unknown>[],
          generatedBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: 'RECEIVABLES',
          entityType: 'CustomerStatement',
          entityId: row!.id,
          newValue: {
            documentNumber,
            customerId: query.customerId,
            from: query.from,
            to: query.to,
            closingBalance: report.closingBalance,
          },
          companyId,
        },
        tx,
      );
      return row!;
    });
    return { ...report, snapshotId: snapshot.id, snapshotNumber: snapshot.documentNumber };
  }

  async listStatements(
    companyId: string,
    query: ListCustomerStatementsQuery,
  ): Promise<PaginatedResult<CustomerStatement & { customerCode: string; customerName: string }>> {
    const where = and(
      eq(customerStatements.companyId, companyId),
      query.customerId ? eq(customerStatements.customerId, query.customerId) : undefined,
    );
    const [rows, count] = await Promise.all([
      this.db
        .select({
          s: customerStatements,
          customerCode: customers.code,
          customerName: customers.name,
        })
        .from(customerStatements)
        .innerJoin(customers, eq(customers.id, customerStatements.customerId))
        .where(where)
        .orderBy(desc(customerStatements.generatedAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(customerStatements)
        .where(where),
    ]);
    return toPaginatedResult(
      rows.map((r) => ({ ...r.s, customerCode: r.customerCode, customerName: r.customerName })),
      Number(count[0]?.n ?? 0),
      query,
    );
  }

  async getStatement(
    companyId: string,
    id: string,
  ): Promise<CustomerStatement & { customerCode: string; customerName: string }> {
    const [row] = await this.db
      .select({ s: customerStatements, customerCode: customers.code, customerName: customers.name })
      .from(customerStatements)
      .innerJoin(customers, eq(customers.id, customerStatements.customerId))
      .where(and(eq(customerStatements.id, id), eq(customerStatements.companyId, companyId)));
    if (!row) throw new NotFoundError('Customer statement', id);
    return { ...row.s, customerCode: row.customerCode, customerName: row.customerName };
  }

  // ---------------------------------------------------------------- internals

  /** Posted credit sales in (from, to]: invoices + debit notes - credit notes, in base currency. */
  private async creditSales(
    companyId: string,
    fromExclusive: string,
    to: string,
    currency: string,
  ): Promise<Money> {
    const rows = await this.db
      .select({
        documentType: invoices.documentType,
        total: sql<string>`coalesce(sum(${invoices.baseTotal}), 0)`,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          inArray(invoices.accountingStatus, ['POSTED', 'REVERSED']),
          sql`${invoices.status} <> 'VOID'`,
          gt(invoices.documentDate, fromExclusive),
          lte(invoices.documentDate, to),
        ),
      )
      .groupBy(invoices.documentType);
    let sum = Money.zero(currency);
    for (const r of rows)
      sum =
        r.documentType === 'CREDIT_NOTE'
          ? sum.subtract(Money.of(r.total, currency))
          : sum.add(Money.of(r.total, currency));
    return sum;
  }
}

/** The last `n` month-ends up to and including the month of `asOf` (the final point is `asOf` itself). */
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
