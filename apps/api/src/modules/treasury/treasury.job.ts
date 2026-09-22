import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { businessToday } from '@/common/time/clock';
import { BankTransfersService } from './bank-transfers.service';
import { CashForecastService } from './cash-forecast.service';
import { CashPositionService } from './cash-position.service';
import { PettyCashService } from './petty-cash.service';
import { TreasuryConfigService } from './treasury-config.service';

const JOB_NAME = 'treasury-sweep';

export interface TreasurySweepResult {
  companyId: string;
  asOf: string;
  belowMinimum: number;
  forecastBreaches: number;
  unsettledTransfers: number;
  pettyCashLow: number;
  snapshotId: string | null;
}

/**
 * Daily treasury sweep (Prompt #8): saves the base-case forecast snapshot,
 * then raises deduped events / notifications for bank accounts under their
 * minimum, forecast shortfalls, transfers overdue for settlement and petty
 * cash funds due for replenishment. Nothing here posts or moves money.
 */
@Injectable()
export class TreasurySweepJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly logger: PinoLogger,
    private readonly accounts: AccountsService,
    private readonly config: TreasuryConfigService,
    private readonly positions: CashPositionService,
    private readonly forecasts: CashForecastService,
    private readonly transfers: BankTransfersService,
    private readonly pettyCash: PettyCashService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {
    this.logger.setContext(TreasurySweepJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(QUEUES.MAINTENANCE, JOB_NAME, { every: 24 * 60 * 60_000 });
  }

  async run(): Promise<{ companies: number }> {
    const rows = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    for (const c of rows) {
      try {
        await this.sweep(c.id);
      } catch (err) {
        this.logger.error({ err, companyId: c.id }, 'Treasury sweep failed');
      }
    }
    return { companies: rows.length };
  }

  /** On-demand sweep for one company (also what the API endpoint runs). */
  async sweep(companyId: string, asOf = businessToday()): Promise<TreasurySweepResult> {
    const settings = await this.config.settings(companyId);
    const currency = await this.accounts.companyCurrency(companyId);
    const [company] = await this.db
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    const organizationId = company!.organizationId;

    const position = await this.positions.position(companyId, { asOf });
    const forecast = await this.forecasts.forecast(companyId, {
      asOf,
      horizonDays: settings.forecastHorizonDays,
      granularity: settings.forecastGranularity,
      scenario: 'BASE',
      save: true,
    });
    const unsettled = await this.transfers.unsettled(
      companyId,
      asOf,
      settings.unsettledTransferWarnDays,
    );
    const funds = (await this.pettyCash.listFunds(companyId)).filter(
      (f) => f.status === 'ACTIVE' && f.replenishmentDue,
    );
    const below = position.accounts.filter((a) => a.belowMinimum && !a.excludeFromPosition);
    const breaches = forecast.buckets.filter((b) => b.breach);

    await this.db.transaction(async (tx) => {
      for (const a of below) {
        await this.outbox.enqueue(tx, {
          eventType: 'cash.below_minimum',
          companyId,
          dedupeKey: `cash.below_minimum:${a.bankAccountId}:${asOf}`,
          payload: {
            bankAccountId: a.bankAccountId,
            code: a.code,
            currency: a.currency,
            bookBalance: a.bookBalance,
            minimumBalance: a.minimumBalance,
            headroom: a.headroom,
          },
        });
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'CASH_BELOW_MINIMUM',
            severity: 'WARNING',
            title: `${a.code} ${a.name} is below its minimum balance`,
            body: `${a.currency} ${a.bookBalance} on the books against a minimum of ${a.minimumBalance}; consider a funding transfer.`,
            link: '/treasury',
            entityType: 'BankAccount',
            entityId: a.bankAccountId,
            permission: 'bank-transfer.create',
            companyId,
            dedupeKey: `cash-below-minimum:${a.bankAccountId}:${asOf}`,
          },
          tx,
        );
      }
      if (breaches.length) {
        const first = breaches[0]!;
        await this.outbox.enqueue(tx, {
          eventType: 'cash.forecast_shortfall',
          companyId,
          dedupeKey: `cash.forecast_shortfall:${companyId}:${asOf}`,
          payload: {
            asOf,
            firstBreach: first.start,
            minimumClosing: forecast.totals.minimumClosing,
            minimumCash: forecast.minimumCash,
            breaches: breaches.length,
            currency,
          },
        });
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'FORECAST_SHORTFALL',
            severity: 'ERROR',
            title: `Cash forecast drops below the ${currency} ${forecast.minimumCash} floor from ${first.label}`,
            body: `Lowest projected closing ${currency} ${forecast.totals.minimumClosing} over the next ${forecast.horizonDays} days (${breaches.length} period(s) breached).`,
            link: '/treasury/forecast',
            entityType: 'CashForecast',
            entityId: companyId,
            permission: 'treasury.forecast-manage',
            companyId,
            dedupeKey: `forecast-shortfall:${companyId}:${asOf}`,
          },
          tx,
        );
      }
      for (const t of unsettled) {
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'BANK_TRANSFER_UNSETTLED',
            severity: 'WARNING',
            title: `Transfer ${t.documentNumber} has not settled`,
            body: `${t.fromCurrency} ${t.amount} sent ${t.transferDate}, expected ${t.expectedSettlementDate}; confirm with the bank or settle it.`,
            link: `/treasury/transfers/${t.id}`,
            entityType: 'BankTransfer',
            entityId: t.id,
            permission: 'bank-transfer.post',
            companyId,
            dedupeKey: `transfer-unsettled:${t.id}:${asOf}`,
          },
          tx,
        );
      }
      for (const f of funds) {
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'PETTY_CASH_LOW',
            severity: 'WARNING',
            title: `Petty cash fund ${f.code} needs replenishment`,
            body: `${currency} ${f.expectedCashOnHand} expected on hand against an imprest of ${f.imprestAmount}.`,
            link: '/treasury/petty-cash',
            entityType: 'PettyCashFund',
            entityId: f.id,
            userIds: [f.custodianId],
            permission: 'petty-cash.post',
            companyId,
            dedupeKey: `petty-cash-low:${f.id}:${asOf.slice(0, 7)}`,
          },
          tx,
        );
      }
    });

    const result: TreasurySweepResult = {
      companyId,
      asOf,
      belowMinimum: below.length,
      forecastBreaches: breaches.length,
      unsettledTransfers: unsettled.length,
      pettyCashLow: funds.length,
      snapshotId: forecast.snapshotId,
    };
    this.logger.info(result, 'Treasury sweep complete');
    return result;
  }
}
