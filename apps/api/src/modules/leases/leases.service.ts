import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type LeaseClassification, type PaginatedResult } from '@accounting/types';
import type {
  CommenceLeaseInput,
  CreateLeaseInput,
  ListLeasesQuery,
  PayLeaseLineInput,
  PreviewLeaseScheduleInput,
  RemeasureLeaseInput,
  TerminateLeaseInput,
  UpdateLeaseInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  assetCategories,
  bankAccounts,
  companies,
  journalEntries,
  leaseEvents,
  leaseScheduleLines,
  leases,
  vendors,
  type Lease,
  type LeaseEvent,
  type LeaseScheduleLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { foreignLineFields } from '@/modules/accounting/journals/foreign-line';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { FxService } from '@/modules/fx/fx.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import {
  FREQUENCY_MONTHS,
  baseRelieved,
  buildLeaseSchedule,
  classify,
  convertSeriesAtRate,
  presentValue,
  type LeaseSchedule,
} from './lease.logic';
import { LeasesConfigService } from './leases-config.service';

const MODULE = 'LEASES';

export interface LeaseView extends Lease {
  vendorName: string | null;
  categoryName: string | null;
  bankAccountCode: string | null;
  rouCarrying: string;
  endDate: string;
  commencementJournalNumber: string | null;
  terminationJournalNumber: string | null;
}

export interface LeaseLineView extends LeaseScheduleLine {
  journalNumber: string | null;
  paymentJournalNumber: string | null;
  runNumber: string | null;
}

export interface LeaseDetail extends LeaseView {
  lines: LeaseLineView[];
  events: Array<LeaseEvent & { journalNumber: string | null }>;
  nextPayment: { lineId: string; date: string; amount: string } | null;
  remainingMonths: number;
  paidTotal: string;
  remainingPayments: string;
  /** The schedule the lease would get if commenced today (drafts only). */
  preview: LeaseSchedule | null;
}

/**
 * Lease contracts and their lifecycle (Prompt #13). Carrying figures on the
 * register (liability, right-of-use cost and accumulated depreciation) move
 * only inside transactions that post the matching journal through the
 * posting gateway; the schedule lines are the truth for what is still due.
 */
@Injectable()
export class LeasesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly banking: BankingService,
    private readonly config: LeasesConfigService,
    private readonly outbox: OutboxService,
    private readonly rates: ExchangeRatesService,
    private readonly fx: FxService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(companyId: string, query: ListLeasesQuery): Promise<PaginatedResult<LeaseView>> {
    const filters: SQL[] = [eq(leases.companyId, companyId)];
    if (query.status) filters.push(eq(leases.status, query.status));
    if (query.classification) filters.push(eq(leases.classification, query.classification));
    if (query.vendorId) filters.push(eq(leases.vendorId, query.vendorId));
    if (query.search)
      filters.push(
        or(
          ilike(leases.leaseNumber, `%${query.search}%`),
          ilike(leases.name, `%${query.search}%`),
          ilike(leases.reference, `%${query.search}%`),
        )!,
      );
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(leases.commencementDate), asc(leases.leaseNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, leases, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async get(companyId: string, id: string): Promise<LeaseDetail> {
    const [lease] = await this.viewQuery(this.db).where(
      and(eq(leases.id, id), eq(leases.companyId, companyId)),
    );
    if (!lease) throw new NotFoundError('Lease', id);
    const lines = await this.lines(this.db, id);
    const events = await this.db
      .select({
        ...leaseEventColumns(),
        journalNumber: journalEntries.documentNumber,
      })
      .from(leaseEvents)
      .leftJoin(journalEntries, eq(journalEntries.id, leaseEvents.journalEntryId))
      .where(eq(leaseEvents.leaseId, id))
      .orderBy(asc(leaseEvents.eventDate), asc(leaseEvents.createdAt));
    const currency = lease.currency;
    const live = lines.filter((l) => l.status !== 'CANCELLED');
    const payLines = live.filter((l) => !Money.of(l.payment, currency).isZero());
    const paid = payLines.filter((l) => l.paidAt);
    const unpaid = payLines.filter((l) => !l.paidAt);
    const next = unpaid[0];
    const preview =
      lease.status === 'DRAFT'
        ? await this.previewFor(companyId, lease, this.db).catch(() => null)
        : null;
    return {
      ...lease,
      lines,
      events,
      nextPayment: next
        ? { lineId: next.id, date: next.paymentDate ?? next.periodStart, amount: next.payment }
        : null,
      remainingMonths: live.filter((l) => l.status === 'PENDING').length,
      paidTotal: Money.sum(
        paid.map((l) => Money.of(l.payment, currency)),
        currency,
      ).toString(),
      remainingPayments: Money.sum(
        unpaid.map((l) => Money.of(l.payment, currency)),
        currency,
      ).toString(),
      preview,
    };
  }

  /** Schedule for terms that are not saved yet (the form's live preview). */
  async preview(companyId: string, input: PreviewLeaseScheduleInput): Promise<LeaseSchedule> {
    const currency = await this.accounts.companyCurrency(companyId);
    const settings = await this.config.settings(companyId);
    return buildLeaseSchedule(
      {
        ...input,
        annualDiscountRate: input.annualDiscountRate ?? settings.defaultDiscountRate,
      },
      currency,
    );
  }

  // ----------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateLeaseInput,
  ): Promise<LeaseDetail> {
    const id = await this.db.transaction(async (tx) => {
      await this.assertRefs(companyId, input, tx);
      const settings = await this.config.settings(companyId, tx);
      const currency = input.currency ?? (await this.accounts.companyCurrency(companyId, tx));
      const leaseNumber = await this.numbering.allocate(
        companyId,
        'LSE',
        Number(input.commencementDate.slice(0, 4)),
        tx,
        { branchId: input.branchId ?? null },
      );
      const [created] = await tx
        .insert(leases)
        .values({
          companyId,
          leaseNumber,
          name: input.name,
          description: input.description ?? null,
          vendorId: input.vendorId ?? null,
          assetCategoryId: input.assetCategoryId ?? null,
          classification: classify(input, settings),
          classificationOverride: input.classificationOverride ?? null,
          commencementDate: input.commencementDate,
          termMonths: input.termMonths,
          paymentAmount: input.paymentAmount,
          paymentFrequency: input.paymentFrequency,
          paymentTiming: input.paymentTiming,
          annualDiscountRate: input.annualDiscountRate ?? null,
          initialDirectCosts: input.initialDirectCosts,
          leaseIncentives: input.leaseIncentives,
          underlyingAssetValue: input.underlyingAssetValue ?? null,
          currency,
          bankAccountId: input.bankAccountId ?? null,
          branchId: input.branchId ?? null,
          departmentId: input.departmentId ?? null,
          costCenterId: input.costCenterId ?? null,
          projectId: input.projectId ?? null,
          location: input.location ?? null,
          reference: input.reference ?? null,
          createdBy: actor.id,
        })
        .returning({ id: leases.id });
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Lease',
          entityId: created!.id,
          newValue: { leaseNumber, name: input.name, termMonths: input.termMonths },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  /** Drafts can change any term; active leases only descriptive fields, bank account and dimensions. */
  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateLeaseInput,
  ): Promise<LeaseDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'TERMINATED' || existing.status === 'COMPLETED')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${existing.leaseNumber} is ${existing.status.toLowerCase()} and cannot be edited.`,
        );
      const termKeys = [
        'commencementDate',
        'currency',
        'termMonths',
        'paymentAmount',
        'paymentFrequency',
        'paymentTiming',
        'annualDiscountRate',
        'initialDirectCosts',
        'leaseIncentives',
        'underlyingAssetValue',
        'classificationOverride',
      ] as const;
      if (existing.status !== 'DRAFT' && termKeys.some((k) => input[k] !== undefined))
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          'Terms of a commenced lease change only through a remeasurement.',
        );
      const merged = { ...existing, ...stripUndefined(input) };
      const step = FREQUENCY_MONTHS[merged.paymentFrequency];
      if (merged.termMonths % step !== 0)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `The term must be a whole number of ${merged.paymentFrequency.toLowerCase()} payment periods.`,
        );
      await this.assertRefs(companyId, merged, tx);
      const settings = await this.config.settings(companyId, tx);
      const patch: Partial<Lease> = {
        name: merged.name,
        description: merged.description ?? null,
        vendorId: merged.vendorId ?? null,
        assetCategoryId: merged.assetCategoryId ?? null,
        bankAccountId: merged.bankAccountId ?? null,
        branchId: merged.branchId ?? null,
        departmentId: merged.departmentId ?? null,
        costCenterId: merged.costCenterId ?? null,
        projectId: merged.projectId ?? null,
        location: merged.location ?? null,
        reference: merged.reference ?? null,
      };
      if (existing.status === 'DRAFT')
        Object.assign(patch, {
          commencementDate: merged.commencementDate,
          currency: merged.currency,
          termMonths: merged.termMonths,
          paymentAmount: merged.paymentAmount,
          paymentFrequency: merged.paymentFrequency,
          paymentTiming: merged.paymentTiming,
          annualDiscountRate: merged.annualDiscountRate ?? null,
          initialDirectCosts: merged.initialDirectCosts,
          leaseIncentives: merged.leaseIncentives,
          underlyingAssetValue: merged.underlyingAssetValue ?? null,
          classificationOverride: merged.classificationOverride ?? null,
          classification: classify(
            {
              termMonths: merged.termMonths,
              underlyingAssetValue: merged.underlyingAssetValue,
              classificationOverride: merged.classificationOverride,
            },
            settings,
          ),
        });
      await tx.update(leases).set(patch).where(eq(leases.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          previousValue: pick(existing, Object.keys(patch)),
          newValue: patch,
          metadata: { leaseNumber: existing.leaseNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${existing.leaseNumber} has commenced; terminate it instead.`,
        );
      await tx.delete(leases).where(eq(leases.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          previousValue: { leaseNumber: existing.leaseNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /**
   * Commencement. Finance leases post Dr right-of-use asset / Cr lease
   * liability for the present value, plus initial direct costs (Cr clearing)
   * and incentives (Dr clearing); the full schedule is written. Exempt leases
   * only get their payment schedule.
   */
  async commence(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CommenceLeaseInput,
  ): Promise<LeaseDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${existing.leaseNumber} has already commenced.`,
        );
      const settings = await this.config.settings(companyId, tx);
      const classification = classify(existing, settings);
      const exempt = classification !== 'FINANCE';
      if (!exempt && !existing.vendorId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A finance lease needs its lessor (vendor) before it can commence.',
        );
      const rate = existing.annualDiscountRate ?? settings.defaultDiscountRate;
      const schedule = buildLeaseSchedule(
        { ...existing, annualDiscountRate: rate },
        existing.currency,
        { exempt },
      );
      const postingDate = input.postingDate ?? existing.commencementDate;
      const currency = existing.currency;
      // Contract currency -> base at the commencement rate: the right-of-use asset keeps this
      // rate for life (non-monetary); the liability starts here and is remeasured as it settles.
      const { rate: fxRate, baseCurrency } = await this.rates.documentRate(
        companyId,
        currency,
        existing.commencementDate,
        input.exchangeRate,
        tx,
      );
      const toBase = (amount: string) => Money.of(amount, currency).convert(baseCurrency, fxRate);
      const liabilityBase = toBase(schedule.initialLiability);
      const rouCostBase = toBase(schedule.rouCost);
      const depreciationBase = convertSeriesAtRate(
        schedule.lines.map((l) => l.depreciation),
        currency,
        baseCurrency,
        fxRate,
      );
      let journalEntryId: string | null = null;
      if (!exempt) {
        await this.posting.resolvePeriod(tx, companyId, postingDate, { draft: true });
        const accts = await this.config.resolveAccounts(companyId, existing, tx);
        const idc = toBase(existing.initialDirectCosts);
        const incentives = toBase(existing.leaseIncentives);
        const lines: PostingLine[] = [
          {
            accountId: accts.rouAsset,
            debit: rouCostBase.toString(),
            credit: '0',
            description: `${existing.leaseNumber} right-of-use asset`,
            ...this.dims(existing),
          },
          {
            accountId: accts.liability,
            debit: '0',
            credit: liabilityBase.toString(),
            description: `${existing.leaseNumber} lease liability`,
            ...this.dims(existing),
          },
        ];
        if (!idc.isZero() || !incentives.isZero()) {
          const clearing = input.clearingAccountId
            ? (await this.accounts.findByIds(companyId, [input.clearingAccountId], tx))[0]
            : await this.accounts.resolveMapped(companyId, 'FIXED_ASSET_CLEARING', tx);
          if (!clearing || clearing.isHeader || clearing.status !== 'ACTIVE')
            throw new BusinessRuleError(
              ErrorCodes.ACCOUNT_NOT_POSTABLE,
              'The clearing account is not postable.',
            );
          // ROU base = liability base + costs - incentives exactly: the plug of the rounded
          // conversions lands on the clearing line.
          const net = rouCostBase.subtract(liabilityBase);
          if (!net.isZero())
            lines.push({
              accountId: clearing.id,
              debit: net.isNegative() ? net.abs().toString() : '0',
              credit: net.isPositive() ? net.toString() : '0',
              description: `${existing.leaseNumber} initial direct costs less incentives`,
              ...this.dims(existing),
            });
        } else if (!rouCostBase.equals(liabilityBase)) {
          throw new BusinessRuleError(
            ErrorCodes.LEASE_SCHEDULE_INVALID,
            'Right-of-use cost and liability disagree without initial direct costs or incentives.',
          );
        }
        const entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: postingDate,
            description: `Lease commencement ${existing.leaseNumber} ${existing.name}`,
            reference: existing.reference ?? existing.leaseNumber,
            journalType: 'GENERAL',
            branchId: existing.branchId,
            sourceType: 'LEASE_COMMENCEMENT',
            sourceId: existing.id,
            actor,
            lines,
          },
          { permission: P['lease.post'] },
        );
        journalEntryId = entry.id;
      }
      await tx
        .update(leases)
        .set({
          status: 'ACTIVE',
          classification,
          annualDiscountRate: rate,
          initialLiability: schedule.initialLiability,
          liabilityBalance: schedule.initialLiability,
          rouCost: schedule.rouCost,
          rouAccumulatedDepreciation: '0',
          exchangeRate: fxRate,
          liabilityBalanceBase: exempt ? '0' : liabilityBase.toString(),
          rouCostBase: exempt ? '0' : rouCostBase.toString(),
          rouAccumulatedDepreciationBase: '0',
          commencementJournalEntryId: journalEntryId,
          commencedAt: new Date(),
        })
        .where(eq(leases.id, id));
      await tx.insert(leaseScheduleLines).values(
        schedule.lines.map((l, i) => ({
          companyId,
          leaseId: id,
          sequence: l.sequence,
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
          openingLiability: l.openingLiability,
          interest: l.interest,
          depreciation: l.depreciation,
          depreciationBase: exempt ? '0' : depreciationBase[i]!,
          payment: l.payment,
          paymentDate: l.paymentDate,
          closingLiability: l.closingLiability,
        })),
      );
      await tx.insert(leaseEvents).values({
        companyId,
        leaseId: id,
        eventType: 'COMMENCEMENT',
        eventDate: postingDate,
        liabilityChange: schedule.initialLiability,
        rouChange: schedule.rouCost,
        liabilityChangeBase: exempt ? '0' : liabilityBase.toString(),
        rouChangeBase: exempt ? '0' : rouCostBase.toString(),
        liabilityAfter: schedule.initialLiability,
        rouCarryingAfter: schedule.rouCost,
        journalEntryId,
        notes: exempt
          ? `${classification.replace('_', '-').toLowerCase()} exemption - payments are expensed when paid`
          : `Discounted at ${Number(rate)}% p.a.`,
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: {
            status: 'ACTIVE',
            classification,
            liability: schedule.initialLiability,
            rouCost: schedule.rouCost,
            journalEntryId,
          },
          metadata: { leaseNumber: existing.leaseNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'lease.commenced',
        companyId,
        dedupeKey: `lease.commenced:${id}`,
        payload: {
          leaseId: id,
          leaseNumber: existing.leaseNumber,
          classification,
          liability: schedule.initialLiability,
          rouCost: schedule.rouCost,
          currency,
        },
      });
    });
    return this.get(companyId, id);
  }

  /**
   * Pays one schedule line from a bank account: finance leases post
   * Dr lease liability / Cr bank, exempt leases Dr lease expense / Cr bank.
   * Payments go in schedule order; an in-arrears payment needs its run first
   * (the interest it settles must already be on the liability).
   */
  async pay(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PayLeaseLineInput,
  ): Promise<LeaseDetail> {
    await this.db.transaction(async (tx) => {
      const lease = await this.lock(tx, companyId, id);
      if (lease.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${lease.leaseNumber} is ${lease.status.toLowerCase()}.`,
        );
      const currency = lease.currency;
      const lines = await this.lines(tx, id, { lock: true });
      const line = lines.find((l) => l.id === input.lineId);
      if (!line || line.status === 'CANCELLED')
        throw new NotFoundError('Lease schedule line', input.lineId);
      const payment = Money.of(line.payment, currency);
      if (payment.isZero())
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `Month ${line.sequence} carries no payment.`,
        );
      if (line.paidAt)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `Month ${line.sequence} is already paid.`,
        );
      const earlierUnpaid = lines.find(
        (l) =>
          l.status !== 'CANCELLED' &&
          l.sequence < line.sequence &&
          !l.paidAt &&
          !Money.of(l.payment, currency).isZero(),
      );
      if (earlierUnpaid)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `Pay month ${earlierUnpaid.sequence} (${earlierUnpaid.paymentDate}) first - payments go in schedule order.`,
        );
      const finance = lease.classification === 'FINANCE';
      if (finance && lease.paymentTiming === 'IN_ARREARS' && line.status !== 'POSTED')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `Post the lease run through ${line.periodEnd} before paying an in-arrears instalment.`,
        );
      const bank = await this.banking.bankAccount(companyId, input.bankAccountId, tx);
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      // Paid in the contract currency from an account in that currency, or in base from a base account.
      if (bank.currency !== currency && bank.currency !== baseCurrency)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Lease payments post in ${currency}; ${bank.code} is a ${bank.currency} account.`,
        );
      const accts = await this.config.resolveAccounts(companyId, lease, tx);
      const liabilityBefore = Money.of(lease.liabilityBalance, currency);
      const liabilityAfter = finance ? liabilityBefore.subtract(payment) : Money.zero(currency);
      if (liabilityAfter.isNegative())
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          'The payment exceeds the lease liability; post the lease run first.',
        );
      // Cash leaves at the rate of the day; the liability is relieved at its carrying base
      // (its share of the base the register carries) - the difference is realized FX.
      const { rate: payRate } = await this.rates.documentRate(
        companyId,
        currency,
        input.paymentDate,
        input.exchangeRate,
        tx,
      );
      const cashBase = payment.convert(baseCurrency, payRate);
      const liabilityBaseBefore = Money.of(lease.liabilityBalanceBase, baseCurrency);
      const relievedBase = finance
        ? baseRelieved(liabilityBefore, liabilityBaseBefore, payment)
        : cashBase;
      const liabilityBaseAfter = finance
        ? liabilityBaseBefore.subtract(relievedBase)
        : Money.zero(baseCurrency);
      // Settling for less base than carried is a gain (a smaller liability, same cash).
      const gain = finance ? relievedBase.subtract(cashBase) : Money.zero(baseCurrency);
      const fxLines = await this.fx.realizedLines(tx, companyId, gain);
      const [bankGl] = await this.accounts.findByIds(companyId, [bank.glAccountId], tx);
      const bankForeign = foreignLineFields(
        bankGl!,
        baseCurrency,
        { currency, amount: payment.toString(), exchangeRate: payRate },
        'credit',
      );
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.paymentDate,
          description: `Lease payment ${lease.leaseNumber} month ${line.sequence}`,
          reference: input.reference ?? lease.reference ?? lease.leaseNumber,
          journalType: 'GENERAL',
          branchId: lease.branchId,
          sourceType: 'LEASE_PAYMENT',
          sourceId: line.id,
          actor,
          lines: [
            {
              accountId: finance ? accts.liability : accts.leaseExpense,
              debit: relievedBase.toString(),
              credit: '0',
              description: finance
                ? `${lease.leaseNumber} liability settled`
                : `${lease.leaseNumber} lease expense`,
              ...this.dims(lease),
            },
            {
              accountId: bank.glAccountId,
              debit: '0',
              credit: cashBase.toString(),
              description: input.memo ?? `Lease payment ${lease.leaseNumber}`,
              ...this.dims(lease),
              ...bankForeign,
            },
            ...fxLines,
          ],
        },
        { permission: P['lease.post'] },
      );
      const now = new Date();
      await tx
        .update(leaseScheduleLines)
        .set({
          paidAt: now,
          paidDate: input.paymentDate,
          paidBankAccountId: bank.id,
          paymentJournalEntryId: entry.id,
          // Exempt leases have nothing else to post for the month.
          status: finance ? line.status : 'POSTED',
          postedAt: finance ? line.postedAt : now,
        })
        .where(eq(leaseScheduleLines.id, line.id));
      if (finance)
        await tx
          .update(leases)
          .set({
            liabilityBalance: liabilityAfter.toString(),
            liabilityBalanceBase: liabilityBaseAfter.toString(),
          })
          .where(eq(leases.id, id));
      await tx.insert(leaseEvents).values({
        companyId,
        leaseId: id,
        eventType: 'PAYMENT',
        eventDate: input.paymentDate,
        liabilityChange: finance ? payment.negate().toString() : '0',
        rouChange: '0',
        liabilityChangeBase: finance ? relievedBase.negate().toString() : '0',
        rouChangeBase: '0',
        liabilityAfter: liabilityAfter.toString(),
        rouCarryingAfter: this.carrying(lease).toString(),
        journalEntryId: entry.id,
        notes: `Month ${line.sequence} from ${bank.code}`,
        createdBy: actor.id,
      });
      await this.refresh(tx, id);
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          newValue: {
            event: 'PAYMENT',
            lineId: line.id,
            amount: payment.toString(),
            baseAmount: cashBase.toString(),
            realizedFx: gain.toString(),
            bankAccountId: bank.id,
            journalEntryId: entry.id,
          },
          metadata: { leaseNumber: lease.leaseNumber, sequence: line.sequence },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Remeasurement (modification of term, payment or rate). The pending lines
   * from the effective date are cancelled, the remaining payments are
   * re-discounted, the change in the liability adjusts the right-of-use
   * asset (Dr ROU / Cr liability or the reverse) and the remaining carrying
   * amount depreciates over the remaining term.
   */
  async remeasure(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RemeasureLeaseInput,
  ): Promise<LeaseDetail> {
    await this.db.transaction(async (tx) => {
      const lease = await this.lock(tx, companyId, id);
      if (lease.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${lease.leaseNumber} is ${lease.status.toLowerCase()}.`,
        );
      const currency = lease.currency;
      const lines = await this.lines(tx, id, { lock: true });
      const live = lines.filter((l) => l.status !== 'CANCELLED');
      const from = live.find((l) => l.periodStart === input.effectiveDate);
      if (!from)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          'The effective date must be the start of a schedule month.',
        );
      if (from.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `Month ${from.sequence} is already posted; remeasure from a later month.`,
        );
      const frequency = lease.paymentFrequency;
      const step = FREQUENCY_MONTHS[frequency];
      if ((from.sequence - 1) % step !== 0)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `The effective date must start a ${frequency.toLowerCase()} payment period.`,
        );
      const tail = live.filter((l) => l.sequence >= from.sequence);
      if (tail.some((l) => l.paidAt))
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          'A payment after the effective date has already been made.',
        );
      const termMonths = input.termMonths ?? lease.termMonths;
      const remaining = termMonths - (from.sequence - 1);
      if (remaining < 1 || remaining % step !== 0)
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          `The new term leaves ${remaining} month(s) from ${input.effectiveDate}; it must be a positive whole number of payment periods.`,
        );
      const paymentAmount = input.paymentAmount ?? lease.paymentAmount;
      const rate = input.annualDiscountRate ?? lease.annualDiscountRate ?? '0';
      const finance = lease.classification === 'FINANCE';
      const liabilityBefore = Money.of(lease.liabilityBalance, currency);
      const carryingBefore = this.carrying(lease);
      const newLiability = finance
        ? presentValue(paymentAmount, remaining, frequency, lease.paymentTiming, rate, currency)
        : Money.zero(currency);
      const delta = newLiability.subtract(liabilityBefore);
      const carryingAfter = carryingBefore.add(delta);
      if (carryingAfter.isNegative())
        throw new BusinessRuleError(
          ErrorCodes.LEASE_SCHEDULE_INVALID,
          'The reduction exceeds the right-of-use carrying amount; terminate the lease instead.',
        );
      const schedule = buildLeaseSchedule(
        {
          commencementDate: input.effectiveDate,
          termMonths: remaining,
          paymentAmount,
          paymentFrequency: frequency,
          paymentTiming: lease.paymentTiming,
          annualDiscountRate: rate,
        },
        currency,
        { firstSequence: from.sequence, exempt: !finance, rouCarrying: carryingAfter.toString() },
      );
      // The change in the liability is measured at the rate of the effective date and adjusts
      // the right-of-use asset at that same rate; the remaining carrying base then depreciates
      // over the remaining term.
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const { rate: fxRate } = await this.rates.documentRate(
        companyId,
        currency,
        input.effectiveDate,
        undefined,
        tx,
      );
      const deltaBase = finance ? delta.convert(baseCurrency, fxRate) : Money.zero(baseCurrency);
      const liabilityBaseAfter = Money.of(lease.liabilityBalanceBase, baseCurrency).add(deltaBase);
      const rouCostBaseAfter = Money.of(lease.rouCostBase, baseCurrency).add(deltaBase);
      const carryingBaseAfter = rouCostBaseAfter.subtract(
        Money.of(lease.rouAccumulatedDepreciationBase, baseCurrency),
      );
      const depreciationBase = finance
        ? allocateBaseDepreciation(
            schedule.lines.map((l) => l.depreciation),
            currency,
            carryingBaseAfter,
          )
        : schedule.lines.map(() => '0');
      const [event] = await tx
        .insert(leaseEvents)
        .values({
          companyId,
          leaseId: id,
          eventType: 'REMEASUREMENT',
          eventDate: input.effectiveDate,
          liabilityChange: delta.toString(),
          rouChange: delta.toString(),
          liabilityChangeBase: deltaBase.toString(),
          rouChangeBase: deltaBase.toString(),
          liabilityAfter: finance ? newLiability.toString() : '0',
          rouCarryingAfter: carryingAfter.toString(),
          notes:
            `${lease.termMonths} -> ${termMonths} months, ${Number(lease.paymentAmount)} -> ${Number(paymentAmount)} per period, ${Number(lease.annualDiscountRate ?? 0)}% -> ${Number(rate)}%` +
            (input.notes ? ` - ${input.notes}` : ''),
          createdBy: actor.id,
        })
        .returning({ id: leaseEvents.id });
      let journalEntryId: string | null = null;
      if (finance && !delta.isZero()) {
        await this.posting.resolvePeriod(tx, companyId, input.effectiveDate, { draft: true });
        const accts = await this.config.resolveAccounts(companyId, lease, tx);
        const entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: input.effectiveDate,
            description: `Lease remeasurement ${lease.leaseNumber} ${lease.name}`,
            reference: lease.reference ?? lease.leaseNumber,
            journalType: 'GENERAL',
            branchId: lease.branchId,
            sourceType: 'LEASE_REMEASUREMENT',
            sourceId: event!.id,
            actor,
            lines: [
              {
                accountId: accts.rouAsset,
                debit: deltaBase.isPositive() ? deltaBase.toString() : '0',
                credit: deltaBase.isNegative() ? deltaBase.abs().toString() : '0',
                description: `${lease.leaseNumber} right-of-use asset remeasured`,
                ...this.dims(lease),
              },
              {
                accountId: accts.liability,
                debit: deltaBase.isNegative() ? deltaBase.abs().toString() : '0',
                credit: deltaBase.isPositive() ? deltaBase.toString() : '0',
                description: `${lease.leaseNumber} lease liability remeasured`,
                ...this.dims(lease),
              },
            ],
          },
          { permission: P['lease.post'] },
        );
        journalEntryId = entry.id;
        await tx.update(leaseEvents).set({ journalEntryId }).where(eq(leaseEvents.id, event!.id));
      }
      await tx
        .update(leaseScheduleLines)
        .set({ status: 'CANCELLED' })
        .where(
          inArray(
            leaseScheduleLines.id,
            tail.map((l) => l.id),
          ),
        );
      await tx.insert(leaseScheduleLines).values(
        schedule.lines.map((l, i) => ({
          companyId,
          leaseId: id,
          sequence: l.sequence,
          periodStart: l.periodStart,
          periodEnd: l.periodEnd,
          openingLiability: l.openingLiability,
          interest: l.interest,
          depreciation: l.depreciation,
          depreciationBase: depreciationBase[i]!,
          payment: l.payment,
          paymentDate: l.paymentDate,
          closingLiability: l.closingLiability,
        })),
      );
      await tx
        .update(leases)
        .set({
          termMonths,
          paymentAmount,
          annualDiscountRate: rate,
          liabilityBalance: finance ? newLiability.toString() : '0',
          rouCost: finance
            ? Money.of(lease.rouCost, currency).add(delta).toString()
            : lease.rouCost,
          liabilityBalanceBase: finance ? liabilityBaseAfter.toString() : '0',
          rouCostBase: finance ? rouCostBaseAfter.toString() : lease.rouCostBase,
        })
        .where(eq(leases.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          previousValue: {
            termMonths: lease.termMonths,
            paymentAmount: lease.paymentAmount,
            annualDiscountRate: lease.annualDiscountRate,
            liabilityBalance: lease.liabilityBalance,
          },
          newValue: {
            termMonths,
            paymentAmount,
            annualDiscountRate: rate,
            liabilityBalance: finance ? newLiability.toString() : '0',
            journalEntryId,
          },
          metadata: {
            reason: input.notes ?? 'Lease remeasurement',
            leaseNumber: lease.leaseNumber,
            event: 'REMEASUREMENT',
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Termination: the right-of-use asset (cost and accumulated depreciation)
   * and the whole remaining liability leave the books; the difference is a
   * gain (liability released exceeds the carrying amount) or a loss.
   * Pending lines are cancelled. Settle any payment already due first.
   */
  async terminate(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: TerminateLeaseInput,
  ): Promise<LeaseDetail> {
    await this.db.transaction(async (tx) => {
      const lease = await this.lock(tx, companyId, id);
      if (lease.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.LEASE_INVALID_STATE,
          `${lease.leaseNumber} is ${lease.status.toLowerCase()}.`,
        );
      if (input.terminationDate < lease.commencementDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The termination date cannot precede commencement.',
        );
      const currency = lease.currency;
      const lines = await this.lines(tx, id, { lock: true });
      const finance = lease.classification === 'FINANCE';
      const liabilityFc = Money.of(lease.liabilityBalance, currency);
      const carryingFc = this.carrying(lease);
      // Everything leaves the books at its base carrying amount: the liability at the base the
      // register carries (settlements and revaluations kept it current), the asset at cost.
      const baseCurrency = await this.accounts.companyCurrency(companyId, tx);
      const liability = Money.of(lease.liabilityBalanceBase, baseCurrency);
      const cost = Money.of(lease.rouCostBase, baseCurrency);
      const accumulated = Money.of(lease.rouAccumulatedDepreciationBase, baseCurrency);
      const carrying = cost.subtract(accumulated);
      // Positive = gain (liability released exceeds the asset given up).
      const gainLoss = liability.subtract(carrying);
      let journalEntryId: string | null = null;
      if (finance) {
        await this.posting.resolvePeriod(tx, companyId, input.terminationDate, { draft: true });
        const accts = await this.config.resolveAccounts(companyId, lease, tx);
        const gainLossAccount = await this.accounts.resolveMapped(
          companyId,
          'GAIN_LOSS_ON_DISPOSAL',
          tx,
        );
        const postingLines: PostingLine[] = [];
        if (!liability.isZero())
          postingLines.push({
            accountId: accts.liability,
            debit: liability.toString(),
            credit: '0',
            description: `${lease.leaseNumber} lease liability derecognized`,
            ...this.dims(lease),
          });
        if (!accumulated.isZero())
          postingLines.push({
            accountId: accts.rouAccumulated,
            debit: accumulated.toString(),
            credit: '0',
            description: `${lease.leaseNumber} accumulated depreciation released`,
            ...this.dims(lease),
          });
        if (!cost.isZero())
          postingLines.push({
            accountId: accts.rouAsset,
            debit: '0',
            credit: cost.toString(),
            description: `${lease.leaseNumber} right-of-use asset derecognized`,
            ...this.dims(lease),
          });
        if (!gainLoss.isZero())
          postingLines.push({
            accountId: gainLossAccount.id,
            debit: gainLoss.isNegative() ? gainLoss.abs().toString() : '0',
            credit: gainLoss.isPositive() ? gainLoss.toString() : '0',
            description: `${lease.leaseNumber} ${gainLoss.isNegative() ? 'loss' : 'gain'} on termination`,
            ...this.dims(lease),
          });
        if (postingLines.length > 0) {
          const entry = await this.posting.postEvent(
            tx,
            {
              companyId,
              entryDate: input.terminationDate,
              description: `Lease termination ${lease.leaseNumber} ${lease.name}`,
              reference: lease.reference ?? lease.leaseNumber,
              journalType: 'GENERAL',
              branchId: lease.branchId,
              sourceType: 'LEASE_TERMINATION',
              sourceId: lease.id,
              actor,
              lines: postingLines,
            },
            { permission: P['lease.post'] },
          );
          journalEntryId = entry.id;
        }
      }
      const pending = lines.filter((l) => l.status === 'PENDING');
      if (pending.length > 0)
        await tx
          .update(leaseScheduleLines)
          .set({ status: 'CANCELLED' })
          .where(
            inArray(
              leaseScheduleLines.id,
              pending.map((l) => l.id),
            ),
          );
      await tx
        .update(leases)
        .set({
          status: 'TERMINATED',
          terminationDate: input.terminationDate,
          terminationGainLoss: finance ? gainLoss.toString() : '0',
          terminationJournalEntryId: journalEntryId,
          liabilityBalance: '0',
          rouCost: '0',
          rouAccumulatedDepreciation: '0',
          liabilityBalanceBase: '0',
          rouCostBase: '0',
          rouAccumulatedDepreciationBase: '0',
        })
        .where(eq(leases.id, id));
      await tx.insert(leaseEvents).values({
        companyId,
        leaseId: id,
        eventType: 'TERMINATION',
        eventDate: input.terminationDate,
        liabilityChange: liabilityFc.negate().toString(),
        rouChange: carryingFc.negate().toString(),
        liabilityChangeBase: finance ? liability.negate().toString() : '0',
        rouChangeBase: finance ? carrying.negate().toString() : '0',
        liabilityAfter: '0',
        rouCarryingAfter: '0',
        journalEntryId,
        notes: finance
          ? `${gainLoss.isNegative() ? 'Loss' : 'Gain'} ${gainLoss.abs().toString()}${input.notes ? ` - ${input.notes}` : ''}`
          : (input.notes ?? null),
        createdBy: actor.id,
      });
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'Lease',
          entityId: id,
          previousValue: {
            status: 'ACTIVE',
            liabilityBalance: lease.liabilityBalance,
            liabilityBalanceBase: lease.liabilityBalanceBase,
          },
          newValue: {
            status: 'TERMINATED',
            terminationDate: input.terminationDate,
            gainLoss: gainLoss.toString(),
            journalEntryId,
          },
          metadata: { reason: input.notes ?? 'Lease terminated', leaseNumber: lease.leaseNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'lease.terminated',
        companyId,
        dedupeKey: `lease.terminated:${id}`,
        payload: {
          leaseId: id,
          leaseNumber: lease.leaseNumber,
          terminationDate: input.terminationDate,
          gainLoss: gainLoss.toString(),
        },
      });
    });
    return this.get(companyId, id);
  }

  // ------------------------------------------------------- shared internals

  async lock(tx: DbExecutor, companyId: string, id: string): Promise<Lease> {
    const [row] = await tx
      .select()
      .from(leases)
      .where(and(eq(leases.id, id), eq(leases.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Lease', id);
    return row;
  }

  /** Marks a lease COMPLETED once every line is posted and every payment made. */
  async refresh(tx: DbExecutor, id: string): Promise<void> {
    const [agg] = await tx
      .select({
        pending: sql<number>`count(*) filter (where ${leaseScheduleLines.status} = 'PENDING')::int`,
        unpaid: sql<number>`count(*) filter (where ${leaseScheduleLines.status} <> 'CANCELLED' and ${leaseScheduleLines.payment} > 0 and ${leaseScheduleLines.paidAt} is null)::int`,
      })
      .from(leaseScheduleLines)
      .where(eq(leaseScheduleLines.leaseId, id));
    const done = (agg?.pending ?? 0) === 0 && (agg?.unpaid ?? 0) === 0;
    await tx
      .update(leases)
      .set(done ? { status: 'COMPLETED', completedAt: new Date() } : { status: 'ACTIVE' })
      .where(and(eq(leases.id, id), inArray(leases.status, ['ACTIVE', 'COMPLETED'])));
  }

  carrying(lease: Pick<Lease, 'rouCost' | 'rouAccumulatedDepreciation' | 'currency'>): Money {
    return Money.of(lease.rouCost, lease.currency).subtract(
      Money.of(lease.rouAccumulatedDepreciation, lease.currency),
    );
  }

  dims(
    lease: Pick<Lease, 'branchId' | 'departmentId' | 'costCenterId' | 'projectId'>,
  ): Pick<PostingLine, 'branchId' | 'departmentId' | 'costCenterId' | 'projectId'> {
    return {
      branchId: lease.branchId,
      departmentId: lease.departmentId,
      costCenterId: lease.costCenterId,
      projectId: lease.projectId,
    };
  }

  async lines(
    executor: DbExecutor,
    leaseId: string,
    options: { lock?: boolean } = {},
  ): Promise<LeaseLineView[]> {
    const runNumber = sql<string | null>`(
      select r.document_number from lease_runs r where r.id = ${leaseScheduleLines.runId}
    )`;
    const paymentJournal = sql<string | null>`(
      select je.document_number from journal_entries je
      where je.id = ${leaseScheduleLines.paymentJournalEntryId}
    )`;
    const query = executor
      .select({
        ...leaseLineColumns(),
        journalNumber: journalEntries.documentNumber,
        paymentJournalNumber: paymentJournal,
        runNumber,
      })
      .from(leaseScheduleLines)
      .leftJoin(journalEntries, eq(journalEntries.id, leaseScheduleLines.journalEntryId))
      .where(eq(leaseScheduleLines.leaseId, leaseId))
      .orderBy(asc(leaseScheduleLines.sequence), asc(leaseScheduleLines.createdAt))
      .$dynamic();
    return options.lock ? query.for('update', { of: leaseScheduleLines }) : query;
  }

  private async previewFor(
    companyId: string,
    lease: Lease,
    executor: DbExecutor,
  ): Promise<LeaseSchedule> {
    const settings = await this.config.settings(companyId, executor);
    const classification: LeaseClassification = classify(lease, settings);
    return buildLeaseSchedule(
      { ...lease, annualDiscountRate: lease.annualDiscountRate ?? settings.defaultDiscountRate },
      lease.currency,
      { exempt: classification !== 'FINANCE' },
    );
  }

  private async assertRefs(
    companyId: string,
    input: {
      vendorId?: string | null;
      assetCategoryId?: string | null;
      bankAccountId?: string | null;
      departmentId?: string | null;
      costCenterId?: string | null;
      projectId?: string | null;
      commencementDate: string;
    },
    tx: DbExecutor,
  ): Promise<void> {
    if (input.vendorId) {
      const [vendor] = await tx
        .select({ id: vendors.id, status: vendors.status })
        .from(vendors)
        .where(and(eq(vendors.id, input.vendorId), eq(vendors.companyId, companyId)));
      if (!vendor) throw new NotFoundError('Vendor', input.vendorId);
      if (vendor.status !== 'ACTIVE')
        throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, 'The lessor is inactive.');
    }
    if (input.assetCategoryId) {
      const [category] = await tx
        .select({ id: assetCategories.id })
        .from(assetCategories)
        .where(
          and(
            eq(assetCategories.id, input.assetCategoryId),
            eq(assetCategories.companyId, companyId),
          ),
        );
      if (!category) throw new NotFoundError('Asset category', input.assetCategoryId);
    }
    if (input.bankAccountId) await this.banking.bankAccount(companyId, input.bankAccountId, tx);
    await this.dimensions.validateRefs(tx, companyId, [input], input.commencementDate);
  }

  private viewQuery(executor: DbExecutor) {
    const termination = sql<string | null>`(
      select je.document_number from journal_entries je where je.id = ${leases.terminationJournalEntryId}
    )`;
    return executor
      .select({
        ...leaseColumns(),
        vendorName: vendors.name,
        categoryName: assetCategories.name,
        bankAccountCode: bankAccounts.code,
        rouCarrying: sql<string>`${leases.rouCost} - ${leases.rouAccumulatedDepreciation}`,
        endDate: sql<string>`to_char((${leases.commencementDate} + (${leases.termMonths} || ' months')::interval - interval '1 day')::date, 'YYYY-MM-DD')`,
        commencementJournalNumber: journalEntries.documentNumber,
        terminationJournalNumber: termination,
      })
      .from(leases)
      .leftJoin(vendors, eq(vendors.id, leases.vendorId))
      .leftJoin(assetCategories, eq(assetCategories.id, leases.assetCategoryId))
      .leftJoin(bankAccounts, eq(bankAccounts.id, leases.bankAccountId))
      .leftJoin(journalEntries, eq(journalEntries.id, leases.commencementJournalEntryId))
      .$dynamic();
  }

  /** Active leases whose next unpaid payment falls on or before `asOf` (reminders / forecast). */
  async duePayments(
    companyId: string,
    asOf: string,
  ): Promise<Array<{ lease: Lease; line: LeaseScheduleLine }>> {
    const rows = await this.db
      .select({ lease: leases, line: leaseScheduleLines })
      .from(leaseScheduleLines)
      .innerJoin(leases, eq(leases.id, leaseScheduleLines.leaseId))
      .where(
        and(
          eq(leases.companyId, companyId),
          eq(leases.status, 'ACTIVE'),
          ne(leaseScheduleLines.status, 'CANCELLED'),
          isNull(leaseScheduleLines.paidAt),
          sql`${leaseScheduleLines.payment} > 0`,
          sql`${leaseScheduleLines.paymentDate} <= ${asOf}`,
        ),
      )
      .orderBy(asc(leaseScheduleLines.paymentDate));
    return rows;
  }

  async organizationOf(executor: DbExecutor, companyId: string): Promise<string | null> {
    const [row] = await executor
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row?.organizationId ?? null;
  }
}

// ------------------------------------------------------------------ helpers

function stripUndefined<T extends object>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function pick(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = row[k];
  return out;
}

/** Base depreciation of a (re)built tail: the remaining carrying base spread like the contract-currency schedule. */
function allocateBaseDepreciation(
  depreciation: readonly string[],
  currency: string,
  carryingBase: Money,
): string[] {
  const total = depreciation.reduce(
    (acc, d) => acc.add(Money.of(d, currency)),
    Money.zero(currency),
  );
  if (total.isZero()) return depreciation.map(() => '0');
  // Convert at the implied carrying rate, plugging rounding into the last line.
  const rate = Money.of(carryingBase.toString(), carryingBase.currency, 20)
    .divide(total.toString())
    .toString();
  return convertSeriesAtRate(depreciation, currency, carryingBase.currency, rate).map(
    (v, i, arr) =>
      i === arr.length - 1
        ? carryingBase
            .subtract(
              arr
                .slice(0, -1)
                .reduce(
                  (acc, x) => acc.add(Money.of(x, carryingBase.currency)),
                  Money.zero(carryingBase.currency),
                ),
            )
            .toString()
        : v,
  );
}

function leaseColumns() {
  return {
    id: leases.id,
    companyId: leases.companyId,
    leaseNumber: leases.leaseNumber,
    name: leases.name,
    description: leases.description,
    vendorId: leases.vendorId,
    assetCategoryId: leases.assetCategoryId,
    status: leases.status,
    classification: leases.classification,
    classificationOverride: leases.classificationOverride,
    commencementDate: leases.commencementDate,
    termMonths: leases.termMonths,
    paymentAmount: leases.paymentAmount,
    paymentFrequency: leases.paymentFrequency,
    paymentTiming: leases.paymentTiming,
    annualDiscountRate: leases.annualDiscountRate,
    initialDirectCosts: leases.initialDirectCosts,
    leaseIncentives: leases.leaseIncentives,
    underlyingAssetValue: leases.underlyingAssetValue,
    currency: leases.currency,
    initialLiability: leases.initialLiability,
    liabilityBalance: leases.liabilityBalance,
    rouCost: leases.rouCost,
    rouAccumulatedDepreciation: leases.rouAccumulatedDepreciation,
    exchangeRate: leases.exchangeRate,
    liabilityBalanceBase: leases.liabilityBalanceBase,
    rouCostBase: leases.rouCostBase,
    rouAccumulatedDepreciationBase: leases.rouAccumulatedDepreciationBase,
    rouAssetAccountId: leases.rouAssetAccountId,
    rouAccumulatedAccountId: leases.rouAccumulatedAccountId,
    liabilityAccountId: leases.liabilityAccountId,
    interestExpenseAccountId: leases.interestExpenseAccountId,
    depreciationExpenseAccountId: leases.depreciationExpenseAccountId,
    leaseExpenseAccountId: leases.leaseExpenseAccountId,
    bankAccountId: leases.bankAccountId,
    branchId: leases.branchId,
    departmentId: leases.departmentId,
    costCenterId: leases.costCenterId,
    projectId: leases.projectId,
    location: leases.location,
    reference: leases.reference,
    commencementJournalEntryId: leases.commencementJournalEntryId,
    commencedAt: leases.commencedAt,
    terminationDate: leases.terminationDate,
    terminationGainLoss: leases.terminationGainLoss,
    terminationJournalEntryId: leases.terminationJournalEntryId,
    completedAt: leases.completedAt,
    createdBy: leases.createdBy,
    createdAt: leases.createdAt,
    updatedAt: leases.updatedAt,
  };
}

function leaseLineColumns() {
  return {
    id: leaseScheduleLines.id,
    companyId: leaseScheduleLines.companyId,
    leaseId: leaseScheduleLines.leaseId,
    sequence: leaseScheduleLines.sequence,
    periodStart: leaseScheduleLines.periodStart,
    periodEnd: leaseScheduleLines.periodEnd,
    openingLiability: leaseScheduleLines.openingLiability,
    interest: leaseScheduleLines.interest,
    depreciation: leaseScheduleLines.depreciation,
    depreciationBase: leaseScheduleLines.depreciationBase,
    interestBase: leaseScheduleLines.interestBase,
    payment: leaseScheduleLines.payment,
    paymentDate: leaseScheduleLines.paymentDate,
    closingLiability: leaseScheduleLines.closingLiability,
    status: leaseScheduleLines.status,
    runId: leaseScheduleLines.runId,
    journalEntryId: leaseScheduleLines.journalEntryId,
    postedAt: leaseScheduleLines.postedAt,
    paidAt: leaseScheduleLines.paidAt,
    paidDate: leaseScheduleLines.paidDate,
    paidBankAccountId: leaseScheduleLines.paidBankAccountId,
    paymentJournalEntryId: leaseScheduleLines.paymentJournalEntryId,
    createdAt: leaseScheduleLines.createdAt,
    updatedAt: leaseScheduleLines.updatedAt,
  };
}

function leaseEventColumns() {
  return {
    id: leaseEvents.id,
    companyId: leaseEvents.companyId,
    leaseId: leaseEvents.leaseId,
    eventType: leaseEvents.eventType,
    eventDate: leaseEvents.eventDate,
    liabilityChange: leaseEvents.liabilityChange,
    rouChange: leaseEvents.rouChange,
    liabilityChangeBase: leaseEvents.liabilityChangeBase,
    rouChangeBase: leaseEvents.rouChangeBase,
    liabilityAfter: leaseEvents.liabilityAfter,
    rouCarryingAfter: leaseEvents.rouCarryingAfter,
    runId: leaseEvents.runId,
    journalEntryId: leaseEvents.journalEntryId,
    notes: leaseEvents.notes,
    createdBy: leaseEvents.createdBy,
    createdAt: leaseEvents.createdAt,
  };
}
