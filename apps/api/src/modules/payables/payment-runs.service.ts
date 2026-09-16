import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { OPEN_DOCUMENT_STATUSES, P, type PaginatedResult } from '@accounting/types';
import type {
  CreatePaymentRunInput,
  ListPaymentRunsQuery,
  PaymentRunDecisionInput,
  RemittanceQuery,
  UpdatePaymentRunLinesInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  paymentRunLines,
  paymentRuns,
  users,
  vendorBills,
  vendorPayments,
  vendorProfiles,
  vendors,
  type PaymentRun,
  type PaymentRunLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { ApConfigService } from './ap-config.service';
import {
  discountAvailable,
  proposePaymentRun,
  remittanceCsv,
  type RemittanceRow,
  type RunCandidate,
} from './payables.logic';
import { VendorPaymentsService } from './vendor-payments.service';
import { VendorsService } from './vendors.service';

const MODULE = 'PAYABLES';

export interface PaymentRunLineView extends PaymentRunLine {
  billNumber: string;
  vendorInvoiceNumber: string | null;
  vendorCode: string;
  vendorName: string;
  paymentNumber: string | null;
  /** Why the proposal left the bill out (only on excluded lines). */
  skipReason: string | null;
}

export interface PaymentRunView extends PaymentRun {
  cashAccountCode: string;
  cashAccountName: string;
  createdByName: string | null;
  approvedByName: string | null;
}

export interface PaymentRunDetail extends PaymentRunView {
  lines: PaymentRunLineView[];
  /** Selected cash per vendor - what execution will pay. */
  vendorTotals: Array<{
    vendorId: string;
    vendorCode: string;
    vendorName: string;
    amount: string;
    discount: string;
    bills: number;
  }>;
}

/**
 * Payment runs (Prompt #7): a proposal of open, unheld bills (by due date and
 * / or discount window), an approval that locks the selection, and an
 * execution that creates and posts one vendor payment per vendor through
 * `VendorPaymentsService` - the run itself never touches the ledger.
 */
@Injectable()
export class PaymentRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly numbering: DocumentNumberingService,
    private readonly authority: AuthorityService,
    private readonly approvals: ApprovalsService,
    private readonly sod: SodService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: ApConfigService,
    private readonly vendorsService: VendorsService,
    private readonly payments: VendorPaymentsService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(
    companyId: string,
    query: ListPaymentRunsQuery,
  ): Promise<PaginatedResult<PaymentRunView>> {
    const filters: SQL[] = [eq(paymentRuns.companyId, companyId)];
    if (query.status) filters.push(eq(paymentRuns.status, query.status));
    if (query.from) filters.push(gte(paymentRuns.paymentDate, query.from));
    if (query.to) filters.push(lte(paymentRuns.paymentDate, query.to));
    if (query.cashAccountId) filters.push(eq(paymentRuns.cashAccountId, query.cashAccountId));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(paymentRuns.paymentDate), desc(paymentRuns.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, paymentRuns, where),
    ]);
    return toPaginatedResult(rows.map(decorateRun), total, query);
  }

  async get(companyId: string, id: string): Promise<PaymentRunDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(paymentRuns.id, id), eq(paymentRuns.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Payment run', id);
    const lines = await this.db
      .select({
        line: paymentRunLines,
        billNumber: vendorBills.documentNumber,
        vendorInvoiceNumber: vendorBills.vendorInvoiceNumber,
        vendorCode: vendors.code,
        vendorName: vendors.name,
        paymentNumber: vendorPayments.documentNumber,
      })
      .from(paymentRunLines)
      .innerJoin(vendorBills, eq(vendorBills.id, paymentRunLines.billId))
      .innerJoin(vendors, eq(vendors.id, paymentRunLines.vendorId))
      .leftJoin(vendorPayments, eq(vendorPayments.id, paymentRunLines.paymentId))
      .where(eq(paymentRunLines.runId, id))
      .orderBy(asc(vendors.name), asc(paymentRunLines.dueDate), asc(vendorBills.documentNumber));
    const currency = row.run.currency;
    const totals = new Map<
      string,
      { vendorCode: string; vendorName: string; amount: Money; discount: Money; bills: number }
    >();
    for (const l of lines) {
      if (l.line.status !== 'SELECTED' && l.line.status !== 'PAID') continue;
      const t = totals.get(l.line.vendorId) ?? {
        vendorCode: l.vendorCode,
        vendorName: l.vendorName,
        amount: Money.zero(currency),
        discount: Money.zero(currency),
        bills: 0,
      };
      t.amount = t.amount.add(Money.of(l.line.amount, currency));
      t.discount = t.discount.add(Money.of(l.line.discountTaken, currency));
      t.bills += 1;
      totals.set(l.line.vendorId, t);
    }
    return {
      ...decorateRun(row),
      lines: lines.map((l) => ({
        ...l.line,
        billNumber: l.billNumber,
        vendorInvoiceNumber: l.vendorInvoiceNumber,
        vendorCode: l.vendorCode,
        vendorName: l.vendorName,
        paymentNumber: l.paymentNumber,
        skipReason: l.line.status === 'EXCLUDED' ? l.line.note : null,
      })),
      vendorTotals: [...totals.entries()].map(([vendorId, t]) => ({
        vendorId,
        vendorCode: t.vendorCode,
        vendorName: t.vendorName,
        amount: t.amount.toString(),
        discount: t.discount.toString(),
        bills: t.bills,
      })),
    };
  }

  // ----------------------------------------------------------------- commands

  /** Propose a run: selects candidate bills under the AP policy and stores every decision. */
  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentRunInput,
  ): Promise<PaymentRunDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: paymentRuns.id })
          .from(paymentRuns)
          .where(
            and(
              eq(paymentRuns.companyId, companyId),
              eq(paymentRuns.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const cash = await this.accounts.getOrThrow(companyId, input.cashAccountId, tx);
      if (cash.isHeader || cash.status !== 'ACTIVE' || cash.type !== 'ASSET')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${cash.code} ${cash.name} is not a usable cash or bank account.`,
        );
      const currency =
        input.currency ?? cash.currency ?? (await this.accounts.companyCurrency(companyId, tx));
      if (input.vendorGroupId) await this.config.vendorGroup(companyId, input.vendorGroupId, tx);
      const payThroughDate = input.payThroughDate ?? input.paymentDate;
      if (input.selectionMode === 'MANUAL' && !(input.billIds && input.billIds.length))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A manual run needs at least one bill.',
        );

      const candidates = await this.candidates(tx, companyId, {
        currency,
        paymentDate: input.paymentDate,
        vendorIds: input.vendorIds,
        vendorGroupId: input.vendorGroupId ?? null,
        branchId: input.branchId ?? null,
        billIds: input.selectionMode === 'MANUAL' ? input.billIds : undefined,
      });
      const proposal = proposePaymentRun(candidates.rows, {
        mode: input.selectionMode,
        payThroughDate,
        maximumAmount: input.maximumAmount ?? null,
        currency,
      });
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PMR',
        Number(input.paymentDate.slice(0, 4)),
        tx,
      );
      const [run] = await tx
        .insert(paymentRuns)
        .values({
          companyId,
          branchId: input.branchId ?? null,
          documentNumber,
          cashAccountId: cash.id,
          currency,
          paymentDate: input.paymentDate,
          payThroughDate,
          selectionMode: input.selectionMode,
          method: input.method,
          vendorGroupId: input.vendorGroupId ?? null,
          filters: { vendorIds: input.vendorIds, billIds: input.billIds },
          maximumAmount: input.maximumAmount ?? null,
          description: input.description ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (proposal.length)
        await tx.insert(paymentRunLines).values(
          proposal.map((l) => ({
            runId: run!.id,
            billId: l.billId,
            vendorId: l.vendorId,
            status: l.skipped ? ('EXCLUDED' as const) : ('SELECTED' as const),
            openAmount: l.openAmount,
            discountAvailable: l.discountAvailable,
            discountTaken: l.discountTaken,
            amount: l.amount,
            dueDate: l.dueDate,
            discountDate: l.discountDate,
            note: l.skipped ?? null,
          })),
        );
      await this.recomputeTotals(tx, run!.id, currency);
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: run!.id,
          newValue: {
            documentNumber,
            paymentDate: input.paymentDate,
            selectionMode: input.selectionMode,
            proposed: proposal.filter((l) => !l.skipped).length,
            excluded: proposal.filter((l) => l.skipped).length,
          },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return run!.id;
    });
    return this.get(companyId, id);
  }

  /** Adjust the proposal: exclude / re-include bills, pay partially, drop a discount. */
  async updateLines(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePaymentRunLinesInput,
  ): Promise<PaymentRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT'], 'edited');
      const lines = await tx.select().from(paymentRunLines).where(eq(paymentRunLines.runId, id));
      const byBill = new Map(lines.map((l) => [l.billId, l]));
      for (const change of input.lines) {
        const line = byBill.get(change.billId);
        if (!line) throw new NotFoundError('Payment run line', change.billId);
        if (change.excluded) {
          await tx
            .update(paymentRunLines)
            .set({ status: 'EXCLUDED', amount: '0', discountTaken: '0', note: 'MANUAL' })
            .where(eq(paymentRunLines.id, line.id));
          continue;
        }
        // Re-including a bill the policy skipped for a hold is not allowed; other skips may be overridden.
        if (
          line.status === 'EXCLUDED' &&
          (line.note === 'ON_HOLD' || line.note === 'VENDOR_ON_HOLD')
        )
          throw new BusinessRuleError(
            ErrorCodes.BILL_ON_HOLD,
            'A held bill cannot be added to a payment run; release the hold first.',
          );
        const open = Money.of(line.openAmount, run.currency);
        const discount =
          change.takeDiscount === false
            ? Money.zero(run.currency)
            : Money.of(line.discountAvailable, run.currency);
        const amount = change.amount
          ? Money.parse(change.amount, run.currency)
          : open.subtract(discount);
        if (!amount.isPositive() || amount.add(discount).greaterThan(open))
          throw new BusinessRuleError(
            ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
            `Amount plus discount must be positive and within the open balance ${open.toString()}.`,
            { billId: change.billId, open: open.toString() },
          );
        await tx
          .update(paymentRunLines)
          .set({
            status: 'SELECTED',
            amount: amount.toString(),
            discountTaken: discount.toString(),
            note: null,
          })
          .where(eq(paymentRunLines.id, line.id));
      }
      await this.recomputeTotals(tx, id, run.currency);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: id,
          newValue: { lines: input.lines },
          metadata: { documentNumber: run.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<PaymentRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT'], 'submitted');
      if (run.lineCount === 0)
        throw new BusinessRuleError(
          ErrorCodes.PAYMENT_RUN_INVALID,
          'The run has no selected bills.',
        );
      await this.approvals.open(tx, this.workflowRef(companyId, run, actor.id));
      await tx
        .update(paymentRuns)
        .set({ status: 'SUBMITTED', submittedBy: actor.id, submittedAt: new Date() })
        .where(eq(paymentRuns.id, id));
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'SUBMITTED', totalAmount: run.totalAmount },
          metadata: { documentNumber: run.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment_run.submitted',
        companyId,
        dedupeKey: 'payment_run.submitted:' + id,
        payload: this.eventPayload(run, 'SUBMITTED'),
      });
      await this.notify(tx, companyId, run, {
        eventType: 'PAYMENT_RUN_APPROVAL_REQUIRED',
        title: `Payment run ${run.documentNumber} awaits approval`,
        body: `${run.currency} ${run.totalAmount} to ${run.vendorCount} vendor(s), payment date ${run.paymentDate}.`,
        permission: P['payment-run.approve'],
      });
    });
    return this.get(companyId, id);
  }

  /** Delegable `payment-run.approve`; SoD against the proposer; workflow must be complete. */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PaymentRunDecisionInput,
  ): Promise<PaymentRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT', 'SUBMITTED'], 'approved');
      if (run.lineCount === 0)
        throw new BusinessRuleError(
          ErrorCodes.PAYMENT_RUN_INVALID,
          'The run has no selected bills.',
        );
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, run, run.createdBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['payment-run.approve'], {
        companyId,
        branchId: run.branchId,
        amount: run.totalAmount,
        currency: run.currency,
        documentType: 'PAYMENT_RUN',
        documentId: id,
        documentNumber: run.documentNumber,
        createdBy: run.createdBy,
        action: 'Approved payment run',
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['payment-run.create'], P['payment-run.approve']],
        run.createdBy,
        actor.id,
        tx,
        { companyId, entityType: 'PaymentRun', entityId: id, documentNumber: run.documentNumber },
      );
      // Re-check holds at approval time: a hold placed after the proposal drops the bill.
      const dropped = await this.dropHeldLines(tx, id, run.currency);
      await tx
        .update(paymentRuns)
        .set({
          status: 'APPROVED',
          approvedBy: actor.id,
          approvedAt: new Date(),
          approvalNote: input.note ?? null,
        })
        .where(eq(paymentRuns.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: id,
          previousValue: { status: run.status },
          newValue: { status: 'APPROVED', droppedHeldBills: dropped },
          metadata: {
            documentNumber: run.documentNumber,
            note: input.note ?? null,
            ...authority.audit,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment_run.approved',
        companyId,
        dedupeKey: 'payment_run.approved:' + id,
        payload: this.eventPayload(run, 'APPROVED'),
      });
    });
    return this.get(companyId, id);
  }

  /**
   * Execute: one vendor payment per vendor, created and posted through the
   * payments service (Dr AP / Cr cash / Cr purchase discount). Each vendor is
   * its own transaction so one failure never blocks the other vendors.
   */
  async execute(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<PaymentRunDetail> {
    const run = await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      const settings = await this.config.settings(companyId, tx);
      if (settings.requireRunApproval) this.assertStatus(run, ['APPROVED'], 'executed');
      else this.assertStatus(run, ['DRAFT', 'SUBMITTED', 'APPROVED'], 'executed');
      if (run.status !== 'APPROVED')
        await this.approvals.assertApproved(
          tx,
          this.workflowRef(companyId, run, run.createdBy ?? actor.id),
        );
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['payment-run.approve'], P['payment-run.execute']],
        run.approvedBy,
        actor.id,
        tx,
        { companyId, entityType: 'PaymentRun', entityId: id, documentNumber: run.documentNumber },
      );
      await tx.update(paymentRuns).set({ status: 'EXECUTING' }).where(eq(paymentRuns.id, id));
      return run;
    });

    const selected = await this.db
      .select()
      .from(paymentRunLines)
      .where(and(eq(paymentRunLines.runId, id), eq(paymentRunLines.status, 'SELECTED')));
    const byVendor = new Map<string, PaymentRunLine[]>();
    for (const l of selected) byVendor.set(l.vendorId, [...(byVendor.get(l.vendorId) ?? []), l]);

    let paid = 0;
    let failed = 0;
    for (const [vendorId, lines] of byVendor) {
      try {
        await this.db.transaction(async (tx) => {
          const profile = await this.vendorsService.profile(vendorId, tx);
          const amount = lines.reduce(
            (m, l) => m.add(Money.of(l.amount, run.currency)),
            Money.zero(run.currency),
          );
          const paymentId = await this.payments.createInTx(
            tx,
            companyId,
            actor,
            {
              partyId: vendorId,
              paymentType: 'PAYMENT',
              paymentDate: run.paymentDate,
              amount: amount.toString(),
              method: profile?.paymentMethod ?? run.method,
              cashAccountId: run.cashAccountId,
              reference: run.documentNumber,
              memo: `Payment run ${run.documentNumber}`,
              branchId: run.branchId,
              allocations: lines.map((l) => ({
                documentId: l.billId,
                amount: l.amount,
                discount: Number(l.discountTaken) > 0 ? l.discountTaken : undefined,
              })),
              idempotencyKey: `payment-run:${id}:${vendorId}`,
            },
            { paymentRunId: id },
          );
          // The run carried the approval; the payments inherit it.
          await tx
            .update(vendorPayments)
            .set({ approvedBy: run.approvedBy, approvedAt: run.approvedAt })
            .where(eq(vendorPayments.id, paymentId));
          await this.payments.postInTx(tx, companyId, actor, paymentId, { approvedUpstream: true });
          await tx
            .update(paymentRunLines)
            .set({ status: 'PAID', paymentId, failureReason: null })
            .where(
              inArray(
                paymentRunLines.id,
                lines.map((l) => l.id),
              ),
            );
        });
        paid += lines.length;
      } catch (err) {
        failed += lines.length;
        const reason = err instanceof Error ? err.message : String(err);
        await this.db
          .update(paymentRunLines)
          .set({ status: 'FAILED', failureReason: reason.slice(0, 500) })
          .where(
            inArray(
              paymentRunLines.id,
              lines.map((l) => l.id),
            ),
          );
      }
    }

    await this.db.transaction(async (tx) => {
      const status = failed === 0 ? 'COMPLETED' : paid === 0 ? 'APPROVED' : 'PARTIALLY_COMPLETED';
      await tx
        .update(paymentRuns)
        .set({ status, executedBy: actor.id, executedAt: new Date() })
        .where(eq(paymentRuns.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: id,
          previousValue: { status: run.status },
          newValue: { status, paidLines: paid, failedLines: failed },
          metadata: { documentNumber: run.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'payment_run.executed',
        companyId,
        dedupeKey: `payment_run.executed:${id}:${Date.now()}`,
        payload: { ...this.eventPayload(run, status), paidLines: paid, failedLines: failed },
      });
      await this.notify(tx, companyId, run, {
        eventType: 'PAYMENT_RUN_EXECUTED',
        title: `Payment run ${run.documentNumber} ${status === 'COMPLETED' ? 'completed' : 'partially completed'}`,
        body: `${paid} bill(s) paid${failed ? `, ${failed} failed` : ''}.`,
        permission: P['payment-run.view'],
      });
    });
    return this.get(companyId, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<PaymentRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT', 'SUBMITTED', 'APPROVED'], 'cancelled');
      await this.approvals.cancelFor(tx, 'PAYMENT_RUN', id);
      await tx
        .update(paymentRuns)
        .set({
          status: 'CANCELLED',
          cancelledBy: actor.id,
          cancelledAt: new Date(),
          cancelReason: reason,
        })
        .where(eq(paymentRuns.id, id));
      await this.audit.record(
        {
          action: 'CANCEL',
          module: MODULE,
          entityType: 'PaymentRun',
          entityId: id,
          previousValue: { status: run.status },
          newValue: { status: 'CANCELLED' },
          metadata: { documentNumber: run.documentNumber, reason, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Remittance / bank file for an executed run. Account numbers are written in full. */
  async remittance(
    companyId: string,
    id: string,
    query: RemittanceQuery,
  ): Promise<{ filename: string; content: string }> {
    const run = await this.get(companyId, id);
    if (!['COMPLETED', 'PARTIALLY_COMPLETED'].includes(run.status))
      throw new BusinessRuleError(
        ErrorCodes.PAYMENT_RUN_INVALID,
        'Only executed runs have a remittance file.',
      );
    const paidLines = run.lines.filter((l) => l.status === 'PAID' && l.paymentId);
    const byPayment = new Map<string, PaymentRunLineView[]>();
    for (const l of paidLines)
      byPayment.set(l.paymentId!, [...(byPayment.get(l.paymentId!) ?? []), l]);
    const rows: RemittanceRow[] = [];
    for (const [paymentId, lines] of byPayment) {
      const payment = await this.payments.get(companyId, paymentId);
      const bank = await this.vendorsService.remittanceBankAccount(lines[0]!.vendorId);
      rows.push({
        vendorCode: lines[0]!.vendorCode,
        vendorName: lines[0]!.vendorName,
        paymentNumber: payment.documentNumber,
        paymentDate: payment.paymentDate,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        bankName: bank?.bankName ?? null,
        accountName: bank?.accountName ?? null,
        accountNumber: bank?.accountNumber ?? null,
        routingCode: bank?.routingCode ?? null,
        bills: lines.map((l) => l.vendorInvoiceNumber ?? l.billNumber).join(';'),
      });
    }
    if (query.format === 'REMITTANCE_ADVICE') {
      const text = rows
        .map(
          (r) =>
            `${r.vendorName} (${r.vendorCode})\nPayment ${r.paymentNumber} on ${r.paymentDate}: ${r.currency} ${r.amount} by ${r.method}\nSettles: ${r.bills}\n`,
        )
        .join('\n');
      return { filename: `${run.documentNumber}-remittance.txt`, content: text };
    }
    return { filename: `${run.documentNumber}.csv`, content: remittanceCsv(rows) };
  }

  // ---------------------------------------------------------------- internals

  /** Open, posted, unheld bills in the run currency matching the filters, with their discounts on the payment date. */
  private async candidates(
    tx: DbExecutor,
    companyId: string,
    filter: {
      currency: string;
      paymentDate: string;
      vendorIds?: string[];
      vendorGroupId: string | null;
      branchId: string | null;
      billIds?: string[];
    },
  ): Promise<{ rows: RunCandidate[] }> {
    const where: SQL[] = [
      eq(vendorBills.companyId, companyId),
      eq(vendorBills.accountingStatus, 'POSTED'),
      inArray(vendorBills.status, [...OPEN_DOCUMENT_STATUSES]),
      inArray(vendorBills.documentType, ['INVOICE', 'DEBIT_NOTE']),
      eq(vendorBills.currency, filter.currency),
    ];
    if (filter.vendorIds?.length) where.push(inArray(vendorBills.vendorId, filter.vendorIds));
    if (filter.vendorGroupId) where.push(eq(vendors.vendorGroupId, filter.vendorGroupId));
    if (filter.branchId) where.push(eq(vendorBills.branchId, filter.branchId));
    if (filter.billIds?.length) where.push(inArray(vendorBills.id, filter.billIds));
    const rows = await tx
      .select({
        bill: vendorBills,
        vendorStatus: vendors.vendorStatus,
        minimumPaymentAmount: vendorProfiles.minimumPaymentAmount,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .leftJoin(vendorProfiles, eq(vendorProfiles.vendorId, vendors.id))
      .where(and(...where));
    return {
      rows: rows.map((r) => ({
        billId: r.bill.id,
        vendorId: r.bill.vendorId,
        dueDate: r.bill.dueDate,
        discountDate: r.bill.discountDate,
        openAmount: Money.of(r.bill.total, filter.currency)
          .subtract(Money.of(r.bill.allocatedAmount, filter.currency))
          .toString(),
        discountAvailable: discountAvailable(
          r.bill,
          filter.paymentDate,
          filter.currency,
        ).toString(),
        onHold: r.bill.onHold || r.bill.matchStatus === 'EXCEPTION',
        vendorOnHold: r.vendorStatus === 'ON_HOLD' || r.vendorStatus === 'BLOCKED',
        minimumPaymentAmount: r.minimumPaymentAmount,
      })),
    };
  }

  private async dropHeldLines(tx: DbExecutor, runId: string, currency: string): Promise<number> {
    const held = await tx
      .select({ id: paymentRunLines.id })
      .from(paymentRunLines)
      .innerJoin(vendorBills, eq(vendorBills.id, paymentRunLines.billId))
      .innerJoin(vendors, eq(vendors.id, paymentRunLines.vendorId))
      .where(
        and(
          eq(paymentRunLines.runId, runId),
          eq(paymentRunLines.status, 'SELECTED'),
          sql`(${vendorBills.onHold} or ${vendors.vendorStatus} in ('ON_HOLD', 'BLOCKED') or ${vendorBills.status} not in ('APPROVED', 'PARTIALLY_PAID'))`,
        ),
      );
    if (held.length) {
      await tx
        .update(paymentRunLines)
        .set({ status: 'EXCLUDED', amount: '0', discountTaken: '0', note: 'ON_HOLD' })
        .where(
          inArray(
            paymentRunLines.id,
            held.map((h) => h.id),
          ),
        );
      await this.recomputeTotals(tx, runId, currency);
    }
    return held.length;
  }

  private async recomputeTotals(tx: DbExecutor, runId: string, currency: string): Promise<void> {
    const [agg] = await tx
      .select({
        amount: sql<string>`coalesce(sum(${paymentRunLines.amount}), 0)`,
        discount: sql<string>`coalesce(sum(${paymentRunLines.discountTaken}), 0)`,
        lines: sql<number>`count(*)`,
        vendorsCount: sql<number>`count(distinct ${paymentRunLines.vendorId})`,
      })
      .from(paymentRunLines)
      .where(
        and(
          eq(paymentRunLines.runId, runId),
          inArray(paymentRunLines.status, ['SELECTED', 'PAID']),
        ),
      );
    await tx
      .update(paymentRuns)
      .set({
        totalAmount: Money.of(agg?.amount ?? '0', currency).toString(),
        totalDiscount: Money.of(agg?.discount ?? '0', currency).toString(),
        lineCount: Number(agg?.lines ?? 0),
        vendorCount: Number(agg?.vendorsCount ?? 0),
      })
      .where(eq(paymentRuns.id, runId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<PaymentRun> {
    const [row] = await tx
      .select()
      .from(paymentRuns)
      .where(and(eq(paymentRuns.id, id), eq(paymentRuns.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Payment run', id);
    return row;
  }

  private assertStatus(run: PaymentRun, allowed: PaymentRun['status'][], verb: string): void {
    if (!allowed.includes(run.status))
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${run.documentNumber} cannot be ${verb} from status ${run.status}.`,
        { status: run.status, allowed },
      );
  }

  private workflowRef(companyId: string, run: PaymentRun, requestedBy: string) {
    return {
      companyId,
      documentType: 'PAYMENT_RUN' as const,
      documentId: run.id,
      documentNumber: run.documentNumber,
      amount: run.totalAmount,
      currency: run.currency,
      requestedBy,
      branchId: run.branchId,
    };
  }

  private eventPayload(run: PaymentRun, status: string) {
    return {
      paymentRunId: run.id,
      documentNumber: run.documentNumber,
      paymentDate: run.paymentDate,
      currency: run.currency,
      totalAmount: run.totalAmount,
      totalDiscount: run.totalDiscount,
      lineCount: run.lineCount,
      vendorCount: run.vendorCount,
      status,
    };
  }

  private async notify(
    tx: DbExecutor,
    companyId: string,
    run: PaymentRun,
    input: {
      eventType: 'PAYMENT_RUN_APPROVAL_REQUIRED' | 'PAYMENT_RUN_EXECUTED';
      title: string;
      body: string;
      permission: string;
    },
  ): Promise<void> {
    const [company] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) return;
    await this.notifications.notify(
      {
        organizationId: company.organizationId,
        eventType: input.eventType,
        title: input.title,
        body: input.body,
        link: `/payables/payment-runs/${run.id}`,
        entityType: 'PaymentRun',
        entityId: run.id,
        permission: input.permission,
        companyId,
        dedupeKey: `${input.eventType}:${run.id}:${run.status}`,
      },
      tx,
    );
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        run: paymentRuns,
        cashAccountCode: accounts.code,
        cashAccountName: accounts.name,
        createdByName: sql<
          string | null
        >`(select email from users u where u.id = ${paymentRuns.createdBy})`,
        approvedByName: users.email,
      })
      .from(paymentRuns)
      .innerJoin(accounts, eq(accounts.id, paymentRuns.cashAccountId))
      .leftJoin(users, eq(users.id, paymentRuns.approvedBy));
  }
}

function decorateRun(row: {
  run: PaymentRun;
  cashAccountCode: string;
  cashAccountName: string;
  createdByName: string | null;
  approvedByName: string | null;
}): PaymentRunView {
  return {
    ...row.run,
    cashAccountCode: row.cashAccountCode,
    cashAccountName: row.cashAccountName,
    createdByName: row.createdByName,
    approvedByName: row.approvedByName,
  };
}
