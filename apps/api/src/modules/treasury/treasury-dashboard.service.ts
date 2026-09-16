import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { CashForecastQuery } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  bankAccounts,
  bankStatementLines,
  bankStatements,
  bankTransfers,
  paymentFiles,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { BankTransfersService, type BankTransferView } from './bank-transfers.service';
import { CashForecastService, type CashForecast } from './cash-forecast.service';
import { CashPositionService, type CashPosition } from './cash-position.service';
import { PettyCashService, type PettyCashFundView } from './petty-cash.service';
import { TreasuryConfigService } from './treasury-config.service';
import { daysCashOnHand } from './treasury.logic';

export interface TreasuryDashboard {
  asOf: string;
  currency: string;
  kpis: {
    totalCash: string;
    availableCash: string;
    inTransit: string;
    pettyCash: string;
    /** Cash / average daily outflow over the burn window (null when nothing left the bank). */
    daysCashOnHand: number | null;
    minimumDaysCashOnHand: number;
    net30: string;
    net90: string;
    /** Lowest forecast closing over the horizon. */
    minimumClosing: string;
    breaches: number;
    accountsBelowMinimum: number;
  };
  position: CashPosition;
  forecast: CashForecast;
  unreconciled: {
    count: number;
    total: string;
    aging: Array<{ bucket: string; count: number; amount: string }>;
  };
  transfers: { pendingApproval: number; inTransit: number; unsettled: BankTransferView[] };
  paymentFiles: { generated: number; transmitted: number; rejected: number };
  pettyCash: { funds: PettyCashFundView[]; needingReplenishment: number; pendingVouchers: number };
}

/**
 * Treasury dashboard (Prompt #8): composes the cash position, the base-case
 * forecast, bank reconciliation backlog, transfers and petty cash into KPIs.
 * Read-only - everything comes from the composed services, nothing is stored.
 */
@Injectable()
export class TreasuryDashboardService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly config: TreasuryConfigService,
    private readonly positions: CashPositionService,
    private readonly forecasts: CashForecastService,
    private readonly transfers: BankTransfersService,
    private readonly pettyCash: PettyCashService,
  ) {}

  async dashboard(
    companyId: string,
    asOf = new Date().toISOString().slice(0, 10),
  ): Promise<TreasuryDashboard> {
    const currency = await this.accounts.companyCurrency(companyId);
    const settings = await this.config.settings(companyId);
    const query: CashForecastQuery = {
      asOf,
      horizonDays: Math.max(settings.forecastHorizonDays, 90),
      granularity: 'WEEK',
      scenario: 'BASE',
      save: false,
    };
    const [position, forecast, unsettled, funds, unreconciled, transferCounts, fileCounts, burn] =
      await Promise.all([
        this.positions.position(companyId, { asOf }),
        this.forecasts.forecast(companyId, query),
        this.transfers.unsettled(companyId, asOf, settings.unsettledTransferWarnDays),
        this.pettyCash.listFunds(companyId),
        this.unreconciledAging(companyId, asOf, currency),
        this.transferCounts(companyId),
        this.fileCounts(companyId),
        this.outflowsInWindow(companyId, asOf, settings.burnWindowDays, currency),
      ]);

    const net = (days: number) =>
      forecast.buckets
        .filter((b) => b.start <= addDays(asOf, days))
        .reduce((m, b) => m.add(Money.of(b.net, currency)), Money.zero(currency))
        .toString();

    return {
      asOf,
      currency,
      kpis: {
        totalCash: position.totals.bookBalance,
        availableCash: position.totals.availableBalance,
        inTransit: position.totals.inTransit,
        pettyCash: position.totals.pettyCash,
        daysCashOnHand: daysCashOnHand(
          position.totals.bookBalance,
          burn,
          settings.burnWindowDays,
          currency,
        ),
        minimumDaysCashOnHand: settings.minimumDaysCashOnHand,
        net30: net(30),
        net90: net(90),
        minimumClosing: forecast.totals.minimumClosing,
        breaches: forecast.totals.breaches,
        accountsBelowMinimum: position.totals.belowMinimum,
      },
      position,
      forecast,
      unreconciled,
      transfers: {
        pendingApproval: transferCounts.pendingApproval,
        inTransit: transferCounts.inTransit,
        unsettled,
      },
      paymentFiles: fileCounts,
      pettyCash: {
        funds,
        needingReplenishment: funds.filter((f) => f.status === 'ACTIVE' && f.replenishmentDue)
          .length,
        pendingVouchers: funds.reduce((n, f) => n + f.draftCount, 0),
      },
    };
  }

  /** Unmatched statement lines by age, in base currency at par (statement lines carry the account currency). */
  private async unreconciledAging(companyId: string, asOf: string, currency: string) {
    const rows = await this.db
      .select({
        age: sql<number>`(${asOf}::date - ${bankStatementLines.lineDate})`,
        amount: sql<string>`abs(${bankStatementLines.amount})`,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(
        and(
          eq(bankAccounts.companyId, companyId),
          inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          sql`${bankStatementLines.lineDate} <= ${asOf}`,
        ),
      );
    const buckets = [
      { bucket: '0-7 days', min: 0, max: 7 },
      { bucket: '8-30 days', min: 8, max: 30 },
      { bucket: '31-60 days', min: 31, max: 60 },
      { bucket: '60+ days', min: 61, max: Number.POSITIVE_INFINITY },
    ];
    let total = Money.zero(currency);
    const aging = buckets.map((b) => ({
      bucket: b.bucket,
      count: 0,
      amount: Money.zero(currency),
    }));
    for (const r of rows) {
      const age = Number(r.age);
      const idx = buckets.findIndex((b) => age >= b.min && age <= b.max);
      const target = aging[idx < 0 ? 0 : idx]!;
      const m = Money.of(r.amount, currency);
      target.count += 1;
      target.amount = target.amount.add(m);
      total = total.add(m);
    }
    return {
      count: rows.length,
      total: total.toString(),
      aging: aging.map((a) => ({ bucket: a.bucket, count: a.count, amount: a.amount.toString() })),
    };
  }

  private async transferCounts(companyId: string) {
    const [row] = await this.db
      .select({
        pendingApproval: sql<number>`count(*) filter (where ${bankTransfers.status} = 'DRAFT')`,
        inTransit: sql<number>`count(*) filter (where ${bankTransfers.status} = 'SENT')`,
      })
      .from(bankTransfers)
      .where(eq(bankTransfers.companyId, companyId));
    return {
      pendingApproval: Number(row?.pendingApproval ?? 0),
      inTransit: Number(row?.inTransit ?? 0),
    };
  }

  private async fileCounts(companyId: string) {
    const [row] = await this.db
      .select({
        generated: sql<number>`count(*) filter (where ${paymentFiles.status} = 'GENERATED')`,
        transmitted: sql<number>`count(*) filter (where ${paymentFiles.status} = 'TRANSMITTED')`,
        rejected: sql<number>`count(*) filter (where ${paymentFiles.status} = 'REJECTED')`,
      })
      .from(paymentFiles)
      .where(eq(paymentFiles.companyId, companyId));
    return {
      generated: Number(row?.generated ?? 0),
      transmitted: Number(row?.transmitted ?? 0),
      rejected: Number(row?.rejected ?? 0),
    };
  }

  /** Credits to bank GL accounts over the trailing window - the burn rate denominator. */
  private async outflowsInWindow(
    companyId: string,
    asOf: string,
    windowDays: number,
    currency: string,
  ): Promise<string> {
    const from = addDays(asOf, -windowDays);
    const result = await this.db.execute(sql`
      select coalesce(sum(jl.credit), 0) as total
      from journal_lines jl
      join journal_entries je on je.id = jl.journal_entry_id
      join bank_accounts ba on ba.gl_account_id = jl.account_id and ba.company_id = je.company_id
      where je.company_id = ${companyId}
        and je.status = 'POSTED'
        and je.entry_date > ${from}
        and je.entry_date <= ${asOf}
        and je.journal_type <> 'REVERSAL'
    `);
    const rows =
      (result as unknown as { rows?: Array<{ total: string }> }).rows ??
      (result as unknown as Array<{ total: string }>);
    return Money.of(String(rows[0]?.total ?? '0'), currency).toString();
  }
}

function addDays(date: string, days: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
