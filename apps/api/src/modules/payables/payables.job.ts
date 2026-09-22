import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, gt, inArray } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import { companies, vendorBills, vendors } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { QUEUES } from '@/modules/jobs/queue.service';
import { addDays } from '@/modules/subledger/subledger.logic';
import { businessToday } from '@/common/time/clock';
import { ApAccrualsService } from './ap-accruals.service';
import { ApConfigService } from './ap-config.service';
import { discountAvailable } from './payables.logic';

const JOB_NAME = 'payables-sweep';

export interface PayablesSweepResult {
  companyId: string;
  asOf: string;
  dueSoon: number;
  discountsExpiring: number;
  overdue: number;
  agedGrniLines: number;
}

/**
 * Daily payables sweep (Prompt #7): bills falling due within the configured
 * window, early-payment discounts about to lapse and aged received-not-billed
 * lines - per active company. Every step is idempotent (deduped events and
 * notifications) and nothing here posts to the ledger or pays anything.
 */
@Injectable()
export class PayablesSweepJob implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jobs: JobRunnerService,
    private readonly logger: PinoLogger,
    private readonly accounts: AccountsService,
    private readonly config: ApConfigService,
    private readonly accruals: ApAccrualsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {
    this.logger.setContext(PayablesSweepJob.name);
  }

  onModuleInit(): void {
    this.jobs.register(QUEUES.MAINTENANCE, JOB_NAME, () => this.run());
    void this.jobs.schedule(
      QUEUES.MAINTENANCE,
      JOB_NAME,
      { every: 24 * 60 * 60_000 },
      {},
      'Daily payables sweep: bills due soon, lapsing early-payment discounts, overdue bills and aged GRNI lines',
    );
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
        this.logger.error({ err, companyId: c.id }, 'Payables sweep failed');
      }
    }
    return { companies: rows.length };
  }

  /** On-demand sweep for one company (also what the API endpoint runs). */
  async sweep(companyId: string, asOf = businessToday()): Promise<PayablesSweepResult> {
    const settings = await this.config.settings(companyId);
    const currency = await this.accounts.companyCurrency(companyId);
    const [company] = await this.db
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    const open = await this.db
      .select({ bill: vendorBills, vendorName: vendors.name })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
          inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
          gt(vendorBills.total, vendorBills.allocatedAmount),
          eq(vendorBills.onHold, false),
        ),
      );
    const dueSoonEnd = addDays(asOf, settings.dueSoonDays);
    const discountEnd = addDays(asOf, settings.discountWarnDays);
    const result: PayablesSweepResult = {
      companyId,
      asOf,
      dueSoon: 0,
      discountsExpiring: 0,
      overdue: 0,
      agedGrniLines: 0,
    };
    let dueSoonTotal = Money.zero(currency);
    let discountTotal = Money.zero(currency);

    await this.db.transaction(async (tx) => {
      for (const { bill, vendorName } of open) {
        const openAmount = Money.of(bill.total, bill.currency).subtract(
          Money.of(bill.allocatedAmount, bill.currency),
        );
        if (bill.dueDate < asOf) {
          result.overdue += 1;
          continue;
        }
        if (bill.dueDate <= dueSoonEnd) {
          result.dueSoon += 1;
          dueSoonTotal = dueSoonTotal.add(openAmount.convert(currency, bill.exchangeRate));
          await this.outbox.enqueue(tx, {
            eventType: 'bill.due_soon',
            companyId,
            dedupeKey: `bill.due_soon:${bill.id}:${bill.dueDate}`,
            payload: {
              billId: bill.id,
              documentNumber: bill.documentNumber,
              vendorId: bill.vendorId,
              vendorName,
              dueDate: bill.dueDate,
              openAmount: openAmount.toString(),
              currency: bill.currency,
            },
          });
        }
        const discount = discountAvailable(bill, asOf, bill.currency);
        if (discount.isPositive() && bill.discountDate && bill.discountDate <= discountEnd) {
          result.discountsExpiring += 1;
          discountTotal = discountTotal.add(discount.convert(currency, bill.exchangeRate));
        }
      }
      if (!company) return;
      if (result.dueSoon > 0)
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'BILL_DUE_SOON',
            severity: 'INFO',
            title: `${result.dueSoon} bill(s) fall due within ${settings.dueSoonDays} days`,
            body: `${currency} ${dueSoonTotal.toString()} to pay by ${dueSoonEnd}${result.overdue ? `; ${result.overdue} bill(s) already overdue` : ''}.`,
            link: '/payables/cash-requirements',
            entityType: 'ApSweep',
            entityId: companyId,
            permission: 'payment-run.create',
            companyId,
            dedupeKey: `bills-due-soon:${companyId}:${asOf}`,
          },
          tx,
        );
      if (result.discountsExpiring > 0)
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'DISCOUNT_EXPIRING',
            severity: 'WARNING',
            title: `${currency} ${discountTotal.toString()} of early-payment discounts lapse within ${settings.discountWarnDays} days`,
            body: `${result.discountsExpiring} bill(s) can still be paid with a discount; propose a payment run.`,
            link: '/payables/payment-runs',
            entityType: 'ApSweep',
            entityId: companyId,
            permission: 'payment-run.create',
            companyId,
            dedupeKey: `discounts-expiring:${companyId}:${asOf}`,
          },
          tx,
        );
      const grni = await this.accruals.grni(
        companyId,
        { asOf, minAgeDays: settings.grniAgeWarnDays },
        tx,
      );
      result.agedGrniLines = grni.rows.length;
      if (grni.rows.length > 0)
        await this.notifications.notify(
          {
            organizationId: company.organizationId,
            eventType: 'GRNI_AGED',
            severity: 'WARNING',
            title: `${grni.rows.length} receipt line(s) unbilled for over ${settings.grniAgeWarnDays} days`,
            body: `${currency} ${grni.totals.aged} received but not billed; chase the vendors or accrue at period end.`,
            link: '/payables/grni',
            entityType: 'ApSweep',
            entityId: companyId,
            permission: 'ap-accrual.view',
            companyId,
            dedupeKey: `grni-aged:${companyId}:${asOf.slice(0, 7)}`,
          },
          tx,
        );
    });
    return result;
  }
}
