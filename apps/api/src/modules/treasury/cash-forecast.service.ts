import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  OPEN_DOCUMENT_STATUSES,
  type ForecastScenario,
  type PaginatedResult,
} from '@accounting/types';
import type {
  CashForecastQuery,
  CreateForecastItemInput,
  UpdateForecastItemInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { NotFoundError } from '@/common/errors/app-error';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  bankTransfers,
  cashForecastItems,
  cashForecastSnapshots,
  invoices,
  paymentRuns,
  promisesToPay,
  recurringJournals,
  vendorBills,
  type CashForecastItem,
  type CashForecastSnapshot,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { nextOccurrence } from '@/modules/accounting/recurring/recurring.logic';
import { AuditService } from '@/modules/audit/audit.service';
import { ArConfigService } from '@/modules/receivables/ar-config.service';
import { addDays } from '@/modules/subledger/subledger.logic';
import { CashPositionService } from './cash-position.service';
import { TreasuryConfigService } from './treasury-config.service';
import {
  collectionProbabilityFor,
  expandPlannedItem,
  expectedReceiptDate,
  forecastBuckets,
  rollForecast,
  type ForecastBucket,
  type ForecastFlow,
} from './treasury.logic';

const MODULE = 'TREASURY';

export interface CashForecast {
  asOf: string;
  currency: string;
  horizonDays: number;
  granularity: CashForecastQuery['granularity'];
  scenario: ForecastScenario;
  openingCash: string;
  minimumCash: string;
  buckets: ForecastBucket[];
  totals: {
    inflows: string;
    outflows: string;
    closing: string;
    minimumClosing: string;
    breaches: number;
  };
  /** Source totals over the whole horizon. */
  bySource: Array<{
    source: string;
    direction: 'INFLOW' | 'OUTFLOW';
    amount: string;
    items: number;
  }>;
  /** Largest individual flows for drill-down. */
  topFlows: ForecastFlow[];
  snapshotId: string | null;
}

/**
 * Rolling cash forecast (Prompt #8). Opening cash is the cash position
 * (GL); inflows and outflows are derived from open AR / AP documents,
 * approved payment runs, promises to pay, in-flight transfers, recurring
 * journals with a cash line and treasury's planned items - then rolled
 * through configurable buckets under a scenario. Nothing here posts.
 */
@Injectable()
export class CashForecastService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly config: TreasuryConfigService,
    private readonly position: CashPositionService,
    private readonly arConfig: ArConfigService,
  ) {}

  async forecast(
    companyId: string,
    query: CashForecastQuery,
    actor?: AuthenticatedUser,
  ): Promise<CashForecast> {
    const asOf = query.asOf ?? new Date().toISOString().slice(0, 10);
    const settings = await this.config.settings(companyId);
    const horizonDays = query.horizonDays ?? settings.forecastHorizonDays;
    const granularity = query.granularity ?? settings.forecastGranularity;
    const scenario = settings.scenarios[query.scenario] ?? settings.scenarios.BASE;
    const currency = await this.accounts.companyCurrency(companyId);
    const horizonEnd = addDays(asOf, horizonDays);
    const buckets = forecastBuckets(asOf, horizonDays, granularity);

    const position = await this.position.position(companyId, { asOf });
    const accountFilter = query.bankAccountId ?? null;
    const opening = accountFilter
      ? (position.accounts.find((a) => a.bankAccountId === accountFilter)?.baseBalance ?? '0')
      : position.totals.bookBalance;

    const flows: ForecastFlow[] = [
      ...(await this.arFlows(companyId, asOf, horizonEnd, currency, scenario)),
      ...(await this.promiseFlows(companyId, asOf, horizonEnd, currency, scenario)),
      ...(await this.apFlows(companyId, asOf, horizonEnd, currency)),
      ...(await this.runFlows(companyId, asOf, horizonEnd, currency)),
      ...(await this.transferFlows(companyId, asOf, horizonEnd, currency)),
      ...(await this.recurringFlows(companyId, asOf, horizonEnd, currency)),
      ...(await this.plannedFlows(companyId, asOf, horizonEnd, currency)),
    ].filter(
      (f) => !accountFilter || f.bankAccountId === null || f.bankAccountId === accountFilter,
    );

    // Minimum cash = the liquidity floor (days of average outflow) or the sum of account minimums, whichever is higher.
    const burn = await this.averageDailyOutflow(companyId, asOf, settings.burnWindowDays, currency);
    const floorFromDays = burn.multiply(settings.minimumDaysCashOnHand);
    const floorFromAccounts = position.accounts
      .filter((a) => !a.excludeFromPosition && a.minimumBalance)
      .reduce(
        (m, a) => m.add(Money.of(a.minimumBalance!, a.currency).convert(currency, a.exchangeRate)),
        Money.zero(currency),
      );
    const minimumCash = floorFromDays.greaterThan(floorFromAccounts)
      ? floorFromDays
      : floorFromAccounts;

    const rolled = rollForecast(
      opening,
      flows,
      buckets,
      scenario,
      minimumCash.toString(),
      currency,
    );
    const bySource = new Map<
      string,
      { direction: 'INFLOW' | 'OUTFLOW'; amount: Money; items: number }
    >();
    for (const f of flows) {
      const key = `${f.direction}:${f.source}`;
      const cur = bySource.get(key) ?? {
        direction: f.direction,
        amount: Money.zero(currency),
        items: 0,
      };
      cur.amount = cur.amount.add(Money.of(f.amount, currency));
      cur.items += 1;
      bySource.set(key, cur);
    }
    let snapshotId: string | null = null;
    // Saved on request or by the daily sweep (no actor: a system snapshot).
    if (query.save) {
      const [snap] = await this.db
        .insert(cashForecastSnapshots)
        .values({
          companyId,
          asOf,
          horizonDays,
          granularity,
          scenario: query.scenario,
          currency,
          openingCash: opening,
          closingCash: rolled.closing,
          minimumCash: minimumCash.toString(),
          totalInflows: rolled.totalInflows,
          totalOutflows: rolled.totalOutflows,
          buckets: rolled.buckets,
          breaches: rolled.breaches,
          createdBy: actor?.id ?? null,
        })
        .returning({ id: cashForecastSnapshots.id });
      snapshotId = snap!.id;
      await this.audit.record({
        action: 'CREATE',
        module: MODULE,
        entityType: 'CashForecastSnapshot',
        entityId: snapshotId,
        newValue: {
          asOf,
          horizonDays,
          scenario: query.scenario,
          closing: rolled.closing,
          breaches: rolled.breaches,
        },
        metadata: { editor: actor?.email ?? 'treasury-sweep' },
        companyId,
      });
    }
    return {
      asOf,
      currency,
      horizonDays,
      granularity,
      scenario: query.scenario,
      openingCash: Money.of(opening, currency).toString(),
      minimumCash: minimumCash.toString(),
      buckets: rolled.buckets,
      totals: {
        inflows: rolled.totalInflows,
        outflows: rolled.totalOutflows,
        closing: rolled.closing,
        minimumClosing: rolled.minimumClosing,
        breaches: rolled.breaches,
      },
      bySource: [...bySource.entries()]
        .map(([key, v]) => ({
          source: key.split(':')[1]!,
          direction: v.direction,
          amount: v.amount.toString(),
          items: v.items,
        }))
        .sort((a, b) => Number(b.amount) - Number(a.amount)),
      topFlows: [...flows].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 25),
      snapshotId,
    };
  }

  async snapshots(companyId: string, limit = 12): Promise<CashForecastSnapshot[]> {
    return this.db
      .select()
      .from(cashForecastSnapshots)
      .where(eq(cashForecastSnapshots.companyId, companyId))
      .orderBy(desc(cashForecastSnapshots.createdAt))
      .limit(limit);
  }

  // ------------------------------------------------------------ planned items

  async listItems(
    companyId: string,
    query: { page: number; pageSize: number; activeOnly?: boolean },
  ): Promise<PaginatedResult<CashForecastItem>> {
    const filters: SQL[] = [eq(cashForecastItems.companyId, companyId)];
    if (query.activeOnly) filters.push(eq(cashForecastItems.active, true));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(cashForecastItems)
        .where(where)
        .orderBy(
          asc(cashForecastItems.direction),
          asc(cashForecastItems.startDate),
          asc(cashForecastItems.name),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query as never)),
      countWhere(this.db, cashForecastItems, where),
    ]);
    return toPaginatedResult(rows, total, query as never);
  }

  async createItem(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateForecastItemInput,
  ): Promise<CashForecastItem> {
    return this.db.transaction(async (tx) => {
      if (input.bankAccountId) await this.assertBankAccount(companyId, input.bankAccountId, tx);
      const [row] = await tx
        .insert(cashForecastItems)
        .values({
          companyId,
          name: input.name,
          direction: input.direction,
          amount: input.amount,
          currency: input.currency ?? (await this.accounts.companyCurrency(companyId, tx)),
          frequency: input.frequency,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          bankAccountId: input.bankAccountId ?? null,
          category: input.category ?? null,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'CashForecastItem',
          entityId: row!.id,
          newValue: row,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateItem(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateForecastItemInput,
  ): Promise<CashForecastItem> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(cashForecastItems)
        .where(and(eq(cashForecastItems.id, id), eq(cashForecastItems.companyId, companyId)));
      if (!existing) throw new NotFoundError('Forecast item', id);
      if (input.bankAccountId) await this.assertBankAccount(companyId, input.bankAccountId, tx);
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
      const [row] = await tx
        .update(cashForecastItems)
        .set(patch)
        .where(eq(cashForecastItems.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CashForecastItem',
          entityId: id,
          previousValue: existing,
          newValue: row,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async removeItem(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(cashForecastItems)
        .where(and(eq(cashForecastItems.id, id), eq(cashForecastItems.companyId, companyId)))
        .returning({ id: cashForecastItems.id });
      if (!deleted.length) throw new NotFoundError('Forecast item', id);
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'CashForecastItem',
          entityId: id,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------------ sources

  /** Open posted invoices / debit notes weighted by collection probability, less open credit notes. */
  private async arFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
    scenario: { inflowDelayDays: number; inflowFactor: string; outflowFactor: string },
  ): Promise<ForecastFlow[]> {
    const [buckets, probabilities] = await Promise.all([
      this.arConfig.agingBuckets(companyId),
      this.config.settings(companyId).then((s) => s.collectionProbabilities),
    ]);
    const rows = await this.db
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, [...OPEN_DOCUMENT_STATUSES]),
          sql`${invoices.total} > ${invoices.allocatedAmount}`,
          lte(invoices.dueDate, horizonEnd),
        ),
      );
    return rows.map((inv) => {
      const open = Money.of(inv.total, inv.currency)
        .subtract(Money.of(inv.allocatedAmount, inv.currency))
        .convert(currency, inv.exchangeRate);
      const isCredit = inv.documentType === 'CREDIT_NOTE';
      const p = isCredit ? 1 : collectionProbabilityFor(asOf, inv.dueDate, buckets, probabilities);
      return {
        date: isCredit ? asOf : expectedReceiptDate(asOf, inv.dueDate, scenario),
        source: 'AR_INVOICES' as const,
        direction: isCredit ? ('OUTFLOW' as const) : ('INFLOW' as const),
        amount: open.multiply(p).toString(),
        bankAccountId: null,
        reference: inv.documentNumber,
        label: `${inv.documentNumber} due ${inv.dueDate}${isCredit ? '' : ` (${Math.round(p * 100)}% likely)`}`,
      };
    });
  }

  /** Pending promises to pay on their promise date (at face value - already the customer's word). */
  private async promiseFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
    scenario: { inflowDelayDays: number },
  ): Promise<ForecastFlow[]> {
    const rows = await this.db
      .select({ p: promisesToPay })
      .from(promisesToPay)
      .where(
        and(
          eq(promisesToPay.companyId, companyId),
          eq(promisesToPay.status, 'PENDING'),
          lte(promisesToPay.promiseDate, horizonEnd),
        ),
      );
    return rows.map((r) => ({
      date: addDays(r.p.promiseDate < asOf ? asOf : r.p.promiseDate, scenario.inflowDelayDays),
      source: 'AR_PROMISES' as const,
      direction: 'INFLOW' as const,
      amount: Money.of(r.p.amount, r.p.currency)
        .subtract(Money.of(r.p.settledAmount, r.p.currency))
        .toString(),
      bankAccountId: null,
      reference: r.p.id,
      label: `Promise to pay by ${r.p.promiseDate}`,
    }));
  }

  /** Open posted bills by due date (discount date when a discount is still open), less vendor credits; bills already in a live run are excluded. */
  private async apFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
  ): Promise<ForecastFlow[]> {
    const rows = await this.db
      .select()
      .from(vendorBills)
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
          sql`${vendorBills.total} > ${vendorBills.allocatedAmount}`,
          eq(vendorBills.onHold, false),
          lte(vendorBills.dueDate, horizonEnd),
          sql`not exists (select 1 from payment_run_lines l join payment_runs r on r.id = l.run_id where l.bill_id = ${vendorBills.id} and l.status = 'SELECTED' and r.status in ('SUBMITTED', 'APPROVED', 'EXECUTING'))`,
        ),
      );
    return rows.map((b) => {
      const open = Money.of(b.total, b.currency)
        .subtract(Money.of(b.allocatedAmount, b.currency))
        .convert(currency, b.exchangeRate);
      const isCredit = b.documentType === 'CREDIT_NOTE';
      const payDate = b.discountDate && b.discountDate >= asOf ? b.discountDate : b.dueDate;
      return {
        date: payDate < asOf ? asOf : payDate,
        source: 'AP_BILLS' as const,
        direction: isCredit ? ('INFLOW' as const) : ('OUTFLOW' as const),
        amount: open.toString(),
        bankAccountId: null,
        reference: b.documentNumber,
        label: `${b.documentNumber} due ${b.dueDate}`,
      };
    });
  }

  private async runFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
  ): Promise<ForecastFlow[]> {
    const rows = await this.db
      .select({ run: paymentRuns, glAccountId: bankAccounts.id, rate: sql<string>`'1'` })
      .from(paymentRuns)
      .leftJoin(bankAccounts, eq(bankAccounts.glAccountId, paymentRuns.cashAccountId))
      .where(
        and(
          eq(paymentRuns.companyId, companyId),
          inArray(paymentRuns.status, ['SUBMITTED', 'APPROVED', 'EXECUTING']),
          lte(paymentRuns.paymentDate, horizonEnd),
        ),
      );
    return rows.map((r) => ({
      date: r.run.paymentDate < asOf ? asOf : r.run.paymentDate,
      source: 'AP_PAYMENT_RUNS' as const,
      direction: 'OUTFLOW' as const,
      amount:
        r.run.currency === currency
          ? Money.of(r.run.totalAmount, currency).toString()
          : Money.of(r.run.totalAmount, r.run.currency).convert(currency, '1').toString(),
      bankAccountId: r.glAccountId ?? null,
      reference: r.run.documentNumber,
      label: `Payment run ${r.run.documentNumber} (${r.run.status.toLowerCase()})`,
    }));
  }

  /** Approved transfers still to be sent and sent transfers still to land: the receiving side is an inflow to that account, the sending side an outflow. */
  private async transferFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
  ): Promise<ForecastFlow[]> {
    const rows = await this.db
      .select()
      .from(bankTransfers)
      .where(
        and(
          eq(bankTransfers.companyId, companyId),
          inArray(bankTransfers.status, ['APPROVED', 'SENT']),
          lte(bankTransfers.expectedSettlementDate, horizonEnd),
        ),
      );
    const out: ForecastFlow[] = [];
    for (const t of rows) {
      const date = t.expectedSettlementDate < asOf ? asOf : t.expectedSettlementDate;
      if (t.status === 'APPROVED')
        out.push({
          date: t.transferDate < asOf ? asOf : t.transferDate,
          source: 'TRANSFERS',
          direction: 'OUTFLOW',
          amount: Money.of(t.amount, t.fromCurrency)
            .convert(currency, t.fromCurrency === currency ? '1' : t.exchangeRate)
            .toString(),
          bankAccountId: t.fromBankAccountId,
          reference: t.documentNumber,
          label: `Transfer ${t.documentNumber} out`,
        });
      out.push({
        date,
        source: 'TRANSFERS',
        direction: 'INFLOW',
        amount: Money.of(t.baseAmount, currency).toString(),
        bankAccountId: t.toBankAccountId,
        reference: t.documentNumber,
        label: `Transfer ${t.documentNumber} in`,
      });
    }
    return out;
  }

  /** Active recurring journals whose template touches a bank GL account: the cash line decides direction. */
  private async recurringFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
  ): Promise<ForecastFlow[]> {
    const accountsRows = await this.db
      .select({ id: bankAccounts.id, glAccountId: bankAccounts.glAccountId })
      .from(bankAccounts)
      .where(eq(bankAccounts.companyId, companyId));
    const byGl = new Map(accountsRows.map((a) => [a.glAccountId, a.id]));
    const templates = await this.db
      .select()
      .from(recurringJournals)
      .where(
        and(eq(recurringJournals.companyId, companyId), eq(recurringJournals.status, 'ACTIVE')),
      );
    const out: ForecastFlow[] = [];
    for (const t of templates) {
      const cashLines = t.lines.filter((l) => byGl.has(l.accountId));
      if (!cashLines.length || !t.nextRunDate) continue;
      let d = t.nextRunDate;
      let guard = 0;
      while (d <= horizonEnd && (!t.endDate || d <= t.endDate) && guard < 400) {
        for (const l of cashLines) {
          const debit = Money.of(l.debit, currency);
          const credit = Money.of(l.credit, currency);
          const net = debit.subtract(credit);
          if (net.isZero()) continue;
          out.push({
            date: d < asOf ? asOf : d,
            source: 'RECURRING',
            direction: net.isNegative() ? 'OUTFLOW' : 'INFLOW',
            amount: net.abs().toString(),
            bankAccountId: byGl.get(l.accountId) ?? null,
            reference: t.name,
            label: `${t.name} (recurring)`,
          });
        }
        d = nextOccurrence(d, t.frequency, t.interval);
        guard += 1;
      }
    }
    return out;
  }

  private async plannedFlows(
    companyId: string,
    asOf: string,
    horizonEnd: string,
    currency: string,
  ): Promise<ForecastFlow[]> {
    const items = await this.db
      .select()
      .from(cashForecastItems)
      .where(and(eq(cashForecastItems.companyId, companyId), eq(cashForecastItems.active, true)));
    const out: ForecastFlow[] = [];
    for (const item of items) {
      for (const date of expandPlannedItem(item, asOf, horizonEnd))
        out.push({
          date,
          source: 'PLANNED',
          direction: item.direction,
          amount:
            item.currency === currency
              ? Money.of(item.amount, currency).toString()
              : Money.of(item.amount, item.currency).convert(currency, '1').toString(),
          bankAccountId: item.bankAccountId,
          reference: item.name,
          label: `${item.name}${item.category ? ` (${item.category})` : ''}`,
        });
    }
    return out;
  }

  /** Posted vendor payments plus posted bank withdrawals / fees over the window, per day. */
  private async averageDailyOutflow(
    companyId: string,
    asOf: string,
    windowDays: number,
    currency: string,
  ): Promise<Money> {
    const from = addDays(asOf, -windowDays);
    const result = await this.db.execute<{ total: string }>(sql`
      select coalesce(sum(x.amount), 0)::text as total from (
        select base_amount as amount from vendor_payments where company_id = ${companyId} and status = 'POSTED' and payment_type = 'PAYMENT' and payment_date > ${from} and payment_date <= ${asOf}
        union all
        select amount from bank_transactions where company_id = ${companyId} and status = 'POSTED' and transaction_type in ('WITHDRAWAL', 'BANK_FEE') and transaction_date > ${from} and transaction_date <= ${asOf}
      ) x`);
    const row =
      (result as unknown as { rows?: Array<{ total: string }> }).rows?.[0] ??
      (result as unknown as Array<{ total: string }>)[0];
    const total = Money.of(row?.total ?? '0', currency);
    return windowDays > 0 ? total.multiply(1 / windowDays) : Money.zero(currency);
  }

  private async assertBankAccount(companyId: string, id: string, tx: DbExecutor): Promise<void> {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
    if (!row) throw new NotFoundError('Bank account', id);
  }
}
