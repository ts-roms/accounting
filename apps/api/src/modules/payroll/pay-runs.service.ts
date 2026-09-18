import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import {
  P,
  type AccountMappingKey,
  type PaginatedResult,
  type PayItemType,
} from '@accounting/types';
import type {
  CreatePayRunInput,
  ListPayRunsQuery,
  PayPayRunInput,
  ReversePayRunInput,
  SetPayRunInputsInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  companies,
  employeePayItems,
  employees,
  journalEntries,
  payItems,
  payRunInputs,
  payRuns,
  payslipLines,
  payslips,
  users,
  type Employee,
  type PayItem,
  type PayRun,
  type PayRunInput,
  type Payslip,
  type PayslipLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { ExpenseClaimsService } from '@/modules/budgeting/expense-claims.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { PayrollConfigService } from './payroll-config.service';
import { activeOn, buildPayslip, type AppliedItem, type PayItemDef } from './payroll.logic';

const MODULE = 'PAYROLL';

export interface PayRunView extends PayRun {
  journalNumber: string | null;
  paymentJournalNumber: string | null;
  bankAccountCode: string | null;
  createdByName: string | null;
  approvedByName: string | null;
}

export interface PayslipView extends Payslip {
  lines: PayslipLine[];
}

export interface PayRunDetail extends PayRunView {
  payslips: PayslipView[];
  inputs: Array<
    PayRunInput & { employeeNumber: string; employeeName: string; payItemCode: string }
  >;
}

/**
 * Pay runs (Prompt #11). One run per frequency and period: calculate builds
 * a payslip per employee from the pure engine, approval is four-eyes,
 * posting writes one journal (expense and liabilities aggregated by account
 * and dimension, the net owed to EMPLOYEE_PAYABLE), payment settles that
 * payable from a bank account (and any expense claims reimbursed through
 * the run), and reversal mirrors the posting journal. Payslips are the
 * subledger of the employee payable; nothing here keeps a running total.
 */
@Injectable()
export class PayRunsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly banking: BankingService,
    private readonly claims: ExpenseClaimsService,
    private readonly authority: AuthorityService,
    private readonly sod: SodService,
    private readonly approvals: ApprovalsService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: PayrollConfigService,
  ) {}

  // ------------------------------------------------------------------ queries

  async list(companyId: string, query: ListPayRunsQuery): Promise<PaginatedResult<PayRunView>> {
    const filters: SQL[] = [eq(payRuns.companyId, companyId)];
    if (query.status) filters.push(eq(payRuns.status, query.status));
    if (query.payFrequency) filters.push(eq(payRuns.payFrequency, query.payFrequency));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(payRuns.periodEnd), desc(payRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, payRuns, where),
    ]);
    return toPaginatedResult(rows.map(toView), total, query);
  }

  async get(companyId: string, id: string): Promise<PayRunDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(payRuns.companyId, companyId), eq(payRuns.id, id)),
    );
    if (!row) throw new NotFoundError('Pay run', id);
    const slips = await this.db
      .select()
      .from(payslips)
      .where(eq(payslips.payRunId, id))
      .orderBy(asc(payslips.employeeNumber));
    const lines = slips.length
      ? await this.db
          .select()
          .from(payslipLines)
          .where(
            inArray(
              payslipLines.payslipId,
              slips.map((s) => s.id),
            ),
          )
          .orderBy(asc(payslipLines.sequence))
      : [];
    const inputs = await this.db
      .select({
        i: payRunInputs,
        employeeNumber: employees.employeeNumber,
        employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
        payItemCode: payItems.code,
      })
      .from(payRunInputs)
      .innerJoin(employees, eq(employees.id, payRunInputs.employeeId))
      .innerJoin(payItems, eq(payItems.id, payRunInputs.payItemId))
      .where(eq(payRunInputs.payRunId, id))
      .orderBy(asc(employees.employeeNumber), asc(payItems.sortOrder));
    return {
      ...toView(row),
      payslips: slips.map((s) => ({ ...s, lines: lines.filter((l) => l.payslipId === s.id) })),
      inputs: inputs.map((r) => ({
        ...r.i,
        employeeNumber: r.employeeNumber,
        employeeName: r.employeeName,
        payItemCode: r.payItemCode,
      })),
    };
  }

  async payslip(companyId: string, payslipId: string): Promise<PayslipView & { run: PayRunView }> {
    const [slip] = await this.db
      .select({ s: payslips, run: payRuns })
      .from(payslips)
      .innerJoin(payRuns, eq(payRuns.id, payslips.payRunId))
      .where(and(eq(payslips.id, payslipId), eq(payRuns.companyId, companyId)));
    if (!slip) throw new NotFoundError('Payslip', payslipId);
    const lines = await this.db
      .select()
      .from(payslipLines)
      .where(eq(payslipLines.payslipId, payslipId))
      .orderBy(asc(payslipLines.sequence));
    const [run] = await this.viewQuery(this.db).where(eq(payRuns.id, slip.run.id));
    return { ...slip.s, lines, run: toView(run!) };
  }

  // ----------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePayRunInput,
  ): Promise<PayRunDetail> {
    const id = await this.db.transaction(async (tx) => {
      const [overlap] = await tx
        .select({ documentNumber: payRuns.documentNumber })
        .from(payRuns)
        .where(
          and(
            eq(payRuns.companyId, companyId),
            eq(payRuns.payFrequency, input.payFrequency),
            sql`${payRuns.status} <> 'REVERSED'`,
            lte(payRuns.periodStart, input.periodEnd),
            sql`${payRuns.periodEnd} >= ${input.periodStart}`,
          ),
        );
      if (overlap)
        throw new BusinessRuleError(
          ErrorCodes.PAY_RUN_INVALID_STATE,
          `Pay run ${overlap.documentNumber} already covers part of this period.`,
        );
      await this.posting.resolvePeriod(tx, companyId, input.periodEnd, { draft: true });
      const settings = await this.config.settings(companyId, tx);
      const bankAccountId = input.bankAccountId ?? settings.payrollBankAccountId ?? null;
      if (bankAccountId) await this.banking.bankAccount(companyId, bankAccountId, tx);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PYR',
        Number(input.periodEnd.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(payRuns)
        .values({
          companyId,
          documentNumber,
          payFrequency: input.payFrequency,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payDate: input.payDate,
          description: input.description ?? null,
          currency,
          bankAccountId,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: created!.id,
          newValue: {
            documentNumber,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            payDate: input.payDate,
          },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  /** Replaces the run's one-off inputs (overtime, bonuses, unpaid leave); the run must be recalculated afterwards. */
  async setInputs(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: SetPayRunInputsInput,
  ): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT', 'CALCULATED'], 'edited');
      const employeeIds = [...new Set(input.inputs.map((i) => i.employeeId))];
      const itemIds = [...new Set(input.inputs.map((i) => i.payItemId))];
      if (employeeIds.length) {
        const found = await tx
          .select({ id: employees.id })
          .from(employees)
          .where(and(eq(employees.companyId, companyId), inArray(employees.id, employeeIds)));
        const missing = employeeIds.find((e) => !found.some((f) => f.id === e));
        if (missing) throw new NotFoundError('Employee', missing);
      }
      if (itemIds.length) {
        const found = await tx
          .select({ id: payItems.id, calculation: payItems.calculation, status: payItems.status })
          .from(payItems)
          .where(and(eq(payItems.companyId, companyId), inArray(payItems.id, itemIds)));
        for (const itemId of itemIds) {
          const item = found.find((f) => f.id === itemId);
          if (!item) throw new NotFoundError('Pay item', itemId);
          if (item.status !== 'ACTIVE' || item.calculation === 'BASE_SALARY')
            throw new BusinessRuleError(
              ErrorCodes.PAY_ITEM_INVALID,
              'Inputs need an active, non-base pay item.',
            );
        }
      }
      await tx.delete(payRunInputs).where(eq(payRunInputs.payRunId, id));
      if (input.inputs.length)
        await tx.insert(payRunInputs).values(
          input.inputs.map((i) => ({
            payRunId: id,
            employeeId: i.employeeId,
            payItemId: i.payItemId,
            amount: i.amount,
            note: i.note ?? null,
          })),
        );
      if (run.status === 'CALCULATED') {
        await tx
          .update(payRuns)
          .set({ status: 'DRAFT', calculatedAt: null })
          .where(eq(payRuns.id, id));
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { inputs: null },
          newValue: { inputs: input.inputs.length },
          metadata: { reason: 'run inputs replaced', editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Builds (or rebuilds) every payslip of the run from master data, assignments, inputs and posted claims. */
  async calculate(companyId: string, actor: AuthenticatedUser, id: string): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT', 'CALCULATED'], 'calculated');
      const settings = await this.config.settings(companyId, tx);
      const staff = await tx
        .select()
        .from(employees)
        .where(
          and(
            eq(employees.companyId, companyId),
            eq(employees.payFrequency, run.payFrequency),
            eq(employees.status, 'ACTIVE'),
            lte(employees.hireDate, run.periodEnd),
            or(
              sql`${employees.terminationDate} is null`,
              sql`${employees.terminationDate} >= ${run.periodStart}`,
            )!,
          ),
        )
        .orderBy(asc(employees.employeeNumber));
      if (staff.length === 0)
        throw new BusinessRuleError(
          ErrorCodes.EMPLOYEE_INACTIVE,
          `No active ${run.payFrequency.toLowerCase().replace('_', '-')} employees for this period.`,
        );
      const items = await tx
        .select()
        .from(payItems)
        .where(and(eq(payItems.companyId, companyId), eq(payItems.status, 'ACTIVE')));
      const base = items.find((i) => i.calculation === 'BASE_SALARY');
      if (!base)
        throw new BusinessRuleError(
          ErrorCodes.PAY_ITEM_INVALID,
          'Define an active BASE_SALARY earning before calculating pay runs.',
        );
      const assignments = await tx
        .select()
        .from(employeePayItems)
        .where(
          inArray(
            employeePayItems.employeeId,
            staff.map((e) => e.id),
          ),
        );
      const inputs = await tx.select().from(payRunInputs).where(eq(payRunInputs.payRunId, id));
      const claims = settings.reimburseExpenseClaims
        ? await this.claims.postedClaimsForUsers(
            tx,
            companyId,
            staff.map((e) => e.userId).filter(Boolean) as string[],
          )
        : [];
      const resolver = this.accountResolver(tx, companyId);

      await tx.delete(payslips).where(eq(payslips.payRunId, id));
      const totals = {
        gross: Money.zero(run.currency),
        taxable: Money.zero(run.currency),
        withholding: Money.zero(run.currency),
        deductions: Money.zero(run.currency),
        employer: Money.zero(run.currency),
        reimbursements: Money.zero(run.currency),
        net: Money.zero(run.currency),
      };
      for (const e of staff) {
        const applied = this.appliedFor(e, run, items, assignments, inputs);
        const reimbursements = claims
          .filter((c) => c.claimantUserId === e.userId)
          .map((c) => ({ expenseClaimId: c.id, claimNumber: c.claimNumber, amount: c.total }));
        let draft;
        try {
          draft = buildPayslip({
            currency: run.currency,
            baseSalary: e.baseSalary,
            applied,
            reimbursements,
          });
        } catch (err) {
          throw new BusinessRuleError(
            ErrorCodes.PAY_RUN_INVALID_STATE,
            `${e.employeeNumber} ${e.firstName} ${e.lastName}: ${(err as Error).message}.`,
          );
        }
        const [slip] = await tx
          .insert(payslips)
          .values({
            payRunId: id,
            employeeId: e.id,
            employeeNumber: e.employeeNumber,
            employeeName: `${e.firstName} ${e.lastName}`,
            branchId: e.branchId,
            departmentId: e.departmentId,
            costCenterId: e.costCenterId,
            projectId: e.projectId,
            baseSalary: e.baseSalary,
            gross: draft.gross,
            taxable: draft.taxable,
            withholding: draft.withholding,
            deductions: draft.deductions,
            employerContributions: draft.employerContributions,
            reimbursements: draft.reimbursements,
            net: draft.net,
            paymentMethod: e.paymentMethod,
            bankName: e.bankName,
            bankAccountNumber: e.bankAccountNumber,
          })
          .returning();
        const lineRows = [];
        for (const l of draft.lines) {
          const item = l.payItemId ? items.find((i) => i.id === l.payItemId)! : null;
          const resolved = item ? await resolver(item) : await resolver(null);
          lineRows.push({
            payslipId: slip!.id,
            sequence: l.sequence,
            payItemId: l.payItemId,
            expenseClaimId: l.expenseClaimId,
            type: l.type,
            code: l.code,
            description: l.description,
            amount: l.amount,
            taxable: l.taxable,
            accountId: resolved.accountId,
            offsetAccountId: resolved.offsetAccountId,
            source: l.source,
          });
        }
        await tx.insert(payslipLines).values(lineRows);
        totals.gross = totals.gross.add(Money.of(draft.gross, run.currency));
        totals.taxable = totals.taxable.add(Money.of(draft.taxable, run.currency));
        totals.withholding = totals.withholding.add(Money.of(draft.withholding, run.currency));
        totals.deductions = totals.deductions.add(Money.of(draft.deductions, run.currency));
        totals.employer = totals.employer.add(Money.of(draft.employerContributions, run.currency));
        totals.reimbursements = totals.reimbursements.add(
          Money.of(draft.reimbursements, run.currency),
        );
        totals.net = totals.net.add(Money.of(draft.net, run.currency));
      }
      await tx
        .update(payRuns)
        .set({
          status: 'CALCULATED',
          employeeCount: staff.length,
          grossTotal: totals.gross.toString(),
          taxableTotal: totals.taxable.toString(),
          withholdingTotal: totals.withholding.toString(),
          deductionTotal: totals.deductions.toString(),
          employerTotal: totals.employer.toString(),
          reimbursementTotal: totals.reimbursements.toString(),
          netTotal: totals.net.toString(),
          calculatedAt: new Date(),
        })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: run.status },
          newValue: {
            status: 'CALCULATED',
            employees: staff.length,
            gross: totals.gross.toString(),
            net: totals.net.toString(),
          },
          metadata: { reason: 'calculated', editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Opens the approval workflow (when configured) and tells approvers. */
  async submit(companyId: string, actor: AuthenticatedUser, id: string): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['CALCULATED'], 'submitted');
      await this.approvals.open(tx, this.workflowRef(companyId, run, actor.id));
      await tx.update(payRuns).set({ submittedAt: new Date() }).where(eq(payRuns.id, id));
      const organizationId = await this.organizationOf(tx, companyId);
      if (organizationId)
        await this.notifications.notify(
          {
            organizationId,
            eventType: 'PAY_RUN_APPROVAL_REQUIRED',
            severity: 'INFO',
            title: `Pay run ${run.documentNumber} awaits approval`,
            body: `${run.employeeCount} employee(s), net ${run.currency} ${run.netTotal}, pay date ${run.payDate}; submitted by ${actor.email}.`,
            link: `/payroll/runs/${id}`,
            entityType: 'PayRun',
            entityId: id,
            permission: 'payroll.approve',
            companyId,
            dedupeKey: `pay-run-approval:${id}`,
          },
          tx,
        );
      await this.audit.record(
        {
          action: 'SUBMIT',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          newValue: { submitted: true },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Four-eyes approval: delegable, SoD-checked against the preparer, workflow-gated when configured. */
  async approve(companyId: string, actor: AuthenticatedUser, id: string): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['CALCULATED'], 'approved');
      await this.approvals.assertApproved(
        tx,
        this.workflowRef(companyId, run, run.createdBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['payroll.approve'], {
        companyId,
        branchId: null,
        amount: run.netTotal,
        currency: run.currency,
        documentType: 'PAY_RUN',
        documentId: id,
        documentNumber: run.documentNumber,
        createdBy: run.createdBy,
        action: 'Approved pay run',
      });
      await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['payroll.manage'], P['payroll.approve']],
        run.createdBy,
        actor.id,
        tx,
        {
          companyId,
          entityType: 'PayRun',
          entityId: id,
          documentNumber: run.documentNumber,
        },
      );
      await tx
        .update(payRuns)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: 'CALCULATED' },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: run.documentNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'pay_run.approved',
        companyId,
        dedupeKey: `pay_run.approved:${id}`,
        payload: this.eventPayload(run, 'APPROVED'),
      });
    });
    return this.get(companyId, id);
  }

  /** Back to CALCULATED so inputs can change; cancels any open approval request. */
  async reopen(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['APPROVED'], 'reopened');
      await this.approvals.cancelFor(tx, 'PAY_RUN', id);
      await tx
        .update(payRuns)
        .set({ status: 'CALCULATED', approvedBy: null, approvedAt: null, submittedAt: null })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: 'APPROVED' },
          newValue: { status: 'CALCULATED' },
          metadata: { reason, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Posts the payroll journal dated on the period end: Dr expenses, Cr liabilities and the net owed. */
  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['APPROVED'], 'posted');
      const detail = await this.get(companyId, id);
      const payable = await this.accounts.resolveMapped(companyId, 'EMPLOYEE_PAYABLE', tx);
      const c = run.currency;
      type Key = string;
      const agg = new Map<Key, PostingLine & { debitM: Money; creditM: Money }>();
      const add = (
        accountId: string,
        side: 'debit' | 'credit',
        amount: string,
        description: string,
        slip: Payslip,
      ) => {
        const key = [
          accountId,
          side,
          slip.branchId,
          slip.departmentId,
          slip.costCenterId,
          slip.projectId,
          description,
        ].join('|');
        let row = agg.get(key);
        if (!row) {
          row = {
            accountId,
            debit: '0',
            credit: '0',
            description,
            branchId: slip.branchId,
            departmentId: slip.departmentId,
            costCenterId: slip.costCenterId,
            projectId: slip.projectId,
            debitM: Money.zero(c),
            creditM: Money.zero(c),
          };
          agg.set(key, row);
        }
        if (side === 'debit') row.debitM = row.debitM.add(Money.of(amount, c));
        else row.creditM = row.creditM.add(Money.of(amount, c));
      };
      for (const slip of detail.payslips) {
        for (const l of slip.lines) {
          const label = `${run.documentNumber} - ${l.description.split(' - ')[0]}`;
          switch (l.type) {
            case 'EARNING':
              if (l.expenseClaimId) break; // the claim's own posting already carries the expense and the payable
              add(l.accountId, 'debit', l.amount, label, slip);
              break;
            case 'DEDUCTION':
            case 'WITHHOLDING_TAX':
              add(l.accountId, 'credit', l.amount, label, slip);
              break;
            case 'EMPLOYER_CONTRIBUTION':
              add(l.accountId, 'debit', l.amount, label, slip);
              add(l.offsetAccountId!, 'credit', l.amount, label, slip);
              break;
          }
        }
        const owed = Money.of(slip.net, c).subtract(Money.of(slip.reimbursements, c));
        if (owed.isPositive())
          add(payable.id, 'credit', owed.toString(), `${run.documentNumber} - net pay`, slip);
      }
      const lines: PostingLine[] = [...agg.values()]
        .filter((r) => !r.debitM.isZero() || !r.creditM.isZero())
        .map(({ debitM, creditM, ...r }) => ({
          ...r,
          debit: debitM.toString(),
          credit: creditM.toString(),
        }));
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: run.periodEnd,
          description: `Payroll ${run.documentNumber} - ${run.periodStart} to ${run.periodEnd}${run.description ? ` - ${run.description}` : ''}`,
          reference: run.documentNumber,
          journalType: 'GENERAL',
          sourceType: 'PAY_RUN',
          sourceId: id,
          actor,
          lines,
        },
        { permission: P['payroll.post'] },
      );
      await tx
        .update(payRuns)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: 'APPROVED' },
          newValue: {
            status: 'POSTED',
            journalEntryId: entry.id,
            gross: run.grossTotal,
            net: run.netTotal,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'pay_run.posted',
        companyId,
        dedupeKey: `pay_run.posted:${id}`,
        payload: { ...this.eventPayload(run, 'POSTED'), journalEntryId: entry.id },
      });
    });
    return this.get(companyId, id);
  }

  /** Settles the net pay (and reimbursed claims) from a bank account: Dr EMPLOYEE_PAYABLE / Cr bank. */
  async pay(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PayPayRunInput,
  ): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['POSTED'], 'paid');
      const settings = await this.config.settings(companyId, tx);
      const bankAccountId =
        input.bankAccountId ?? run.bankAccountId ?? settings.payrollBankAccountId;
      if (!bankAccountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Choose the bank account the payroll is paid from.',
        );
      const bank = await this.banking.bankAccount(companyId, bankAccountId, tx);
      const paymentDate = input.paymentDate ?? run.payDate;
      if (paymentDate < run.periodStart)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Payment cannot precede the pay period.',
        );
      const payable = await this.accounts.resolveMapped(companyId, 'EMPLOYEE_PAYABLE', tx);
      const net = Money.of(run.netTotal, run.currency);
      if (!net.isPositive())
        throw new BusinessRuleError(
          ErrorCodes.PAY_RUN_INVALID_STATE,
          'Nothing to pay - the run has no net pay.',
        );
      const reference = input.reference ?? run.documentNumber;
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: paymentDate,
          description: `Payroll payment ${run.documentNumber} (${run.employeeCount} employee(s))`,
          reference,
          journalType: 'GENERAL',
          sourceType: 'PAY_RUN_PAYMENT',
          sourceId: id,
          actor,
          lines: [
            {
              accountId: payable.id,
              debit: net.toString(),
              credit: '0',
              description: `${run.documentNumber} net pay settled`,
            },
            {
              accountId: bank.glAccountId,
              debit: '0',
              credit: net.toString(),
              description: `Payroll ${run.documentNumber}`,
            },
          ],
        },
        { permission: P['payroll.post'] },
      );
      const claimIds = await tx
        .select({ id: payslipLines.expenseClaimId })
        .from(payslipLines)
        .innerJoin(payslips, eq(payslips.id, payslipLines.payslipId))
        .where(and(eq(payslips.payRunId, id), sql`${payslipLines.expenseClaimId} is not null`));
      await this.claims.settleThroughPayroll(
        tx,
        companyId,
        actor,
        claimIds.map((r) => r.id!),
        {
          journalEntryId: entry.id,
          bankAccountId: bank.id,
          paymentDate,
          reference,
        },
      );
      await tx
        .update(payRuns)
        .set({
          status: 'PAID',
          paymentJournalEntryId: entry.id,
          bankAccountId: bank.id,
          paymentDate,
          paymentReference: reference,
          paidBy: actor.id,
          paidAt: new Date(),
        })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: {
            status: 'PAID',
            paymentJournalEntryId: entry.id,
            bankAccount: bank.code,
            net: net.toString(),
            claimsSettled: claimIds.length,
          },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'pay_run.paid',
        companyId,
        dedupeKey: `pay_run.paid:${id}`,
        payload: {
          ...this.eventPayload(run, 'PAID'),
          paymentJournalEntryId: entry.id,
          bankAccountId: bank.id,
          paymentDate,
        },
      });
    });
    return this.get(companyId, id);
  }

  /** Mirrors the payroll journal; only unpaid runs can be reversed (a paid run's bank payment is a separate document). */
  async reverse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ReversePayRunInput,
  ): Promise<PayRunDetail> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      if (run.status === 'PAID')
        throw new BusinessRuleError(
          ErrorCodes.PAY_RUN_INVALID_STATE,
          `Pay run ${run.documentNumber} has been paid; it cannot be reversed.`,
        );
      this.assertStatus(run, ['POSTED'], 'reversed');
      const [entry] = await tx
        .select()
        .from(journalEntries)
        .where(eq(journalEntries.id, run.journalEntryId!))
        .for('update');
      if (!entry) throw new NotFoundError('Journal entry', run.journalEntryId ?? '');
      const reversal = await this.posting.reverseEntry(tx, entry, {
        reversalDate: input.reversalDate ?? run.periodEnd,
        description: `Reverse payroll ${run.documentNumber}: ${input.reason}`,
        actor,
        permission: P['payroll.post'],
      });
      await tx
        .update(payRuns)
        .set({
          status: 'REVERSED',
          reversalJournalEntryId: reversal.id,
          reversalReason: input.reason,
          reversedAt: new Date(),
        })
        .where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'REVERSED', reversalJournalEntryId: reversal.id },
          metadata: { reason: input.reason },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'pay_run.reversed',
        companyId,
        dedupeKey: `pay_run.reversed:${id}`,
        payload: { ...this.eventPayload(run, 'REVERSED'), reason: input.reason },
      });
    });
    return this.get(companyId, id);
  }

  /** Drafts and calculated runs can be discarded; nothing has reached the ledger. */
  async remove(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const run = await this.lock(tx, companyId, id);
      this.assertStatus(run, ['DRAFT', 'CALCULATED'], 'deleted');
      await this.approvals.cancelFor(tx, 'PAY_RUN', id);
      await tx.delete(payRuns).where(eq(payRuns.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'PayRun',
          entityId: id,
          previousValue: { documentNumber: run.documentNumber, status: run.status },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- internals

  /** INPUT beats ASSIGNMENT beats COMPANY for the same item; the base salary item always applies once. */
  private appliedFor(
    e: Employee,
    run: PayRun,
    items: PayItem[],
    assignments: Array<{
      employeeId: string;
      payItemId: string;
      amount: string | null;
      rate: string | null;
      effectiveFrom: string;
      effectiveTo: string | null;
      notes: string | null;
    }>,
    inputs: PayRunInput[],
  ): AppliedItem[] {
    const def = (i: PayItem): PayItemDef => ({
      id: i.id,
      code: i.code,
      name: i.name,
      type: i.type,
      calculation: i.calculation,
      amount: i.amount,
      rate: i.rate,
      maxBase: i.maxBase,
      brackets: i.brackets,
      taxable: i.taxable,
      sortOrder: i.sortOrder,
    });
    const applied = new Map<string, AppliedItem>();
    for (const i of items) {
      if (i.calculation === 'BASE_SALARY') applied.set(i.id, { item: def(i), source: 'BASE' });
      else if (i.appliesToAll) applied.set(i.id, { item: def(i), source: 'COMPANY' });
    }
    for (const a of assignments) {
      if (
        a.employeeId !== e.id ||
        !activeOn(a.effectiveFrom, a.effectiveTo, run.periodStart, run.periodEnd)
      )
        continue;
      const i = items.find((x) => x.id === a.payItemId);
      if (i)
        applied.set(i.id, {
          item: def(i),
          source: 'ASSIGNMENT',
          amount: a.amount,
          rate: a.rate,
          note: a.notes,
        });
    }
    const extra: AppliedItem[] = [];
    for (const inp of inputs) {
      if (inp.employeeId !== e.id) continue;
      const i = items.find((x) => x.id === inp.payItemId);
      if (!i) continue;
      const entry: AppliedItem = {
        item: def(i),
        source: 'INPUT',
        amount: inp.amount,
        note: inp.note,
      };
      // A one-off input replaces a recurring amount of the same item; several inputs of one item add up as separate lines.
      if (applied.has(i.id) && applied.get(i.id)!.source !== 'INPUT') applied.set(i.id, entry);
      else extra.push(entry);
    }
    return [...applied.values(), ...extra];
  }

  /** Accounts a payslip line posts to: the item's own accounts, else the company mappings. */
  private accountResolver(tx: DbExecutor, companyId: string) {
    const cache = new Map<AccountMappingKey, string>();
    const mapped = async (key: AccountMappingKey) => {
      let id = cache.get(key);
      if (!id) {
        id = (await this.accounts.resolveMapped(companyId, key, tx)).id;
        cache.set(key, id);
      }
      return id;
    };
    return async (
      item: PayItem | null,
    ): Promise<{ accountId: string; offsetAccountId: string | null }> => {
      if (!item) return { accountId: await mapped('EMPLOYEE_PAYABLE'), offsetAccountId: null };
      const type: PayItemType = item.type;
      switch (type) {
        case 'EARNING':
          return {
            accountId: item.expenseAccountId ?? (await mapped('SALARY_EXPENSE')),
            offsetAccountId: null,
          };
        case 'DEDUCTION':
          return {
            accountId: item.liabilityAccountId ?? (await mapped('STATUTORY_CONTRIBUTIONS_PAYABLE')),
            offsetAccountId: null,
          };
        case 'WITHHOLDING_TAX':
          return {
            accountId: item.liabilityAccountId ?? (await mapped('WITHHOLDING_TAX_PAYABLE')),
            offsetAccountId: null,
          };
        case 'EMPLOYER_CONTRIBUTION':
          return {
            accountId: item.expenseAccountId ?? (await mapped('EMPLOYER_CONTRIBUTION_EXPENSE')),
            offsetAccountId:
              item.liabilityAccountId ?? (await mapped('STATUTORY_CONTRIBUTIONS_PAYABLE')),
          };
      }
    };
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<PayRun> {
    const [row] = await tx
      .select()
      .from(payRuns)
      .where(and(eq(payRuns.companyId, companyId), eq(payRuns.id, id)))
      .for('update');
    if (!row) throw new NotFoundError('Pay run', id);
    return row;
  }

  private assertStatus(run: PayRun, allowed: PayRun['status'][], verb: string) {
    if (!allowed.includes(run.status))
      throw new BusinessRuleError(
        ErrorCodes.PAY_RUN_INVALID_STATE,
        `A ${run.status.toLowerCase()} pay run cannot be ${verb}.`,
      );
  }

  private workflowRef(companyId: string, run: PayRun, requestedBy: string) {
    return {
      companyId,
      documentType: 'PAY_RUN' as const,
      documentId: run.id,
      documentNumber: run.documentNumber,
      amount: run.netTotal,
      currency: run.currency,
      requestedBy,
    };
  }

  private eventPayload(run: PayRun, status: string) {
    return {
      payRunId: run.id,
      documentNumber: run.documentNumber,
      status,
      periodStart: run.periodStart,
      periodEnd: run.periodEnd,
      payDate: run.payDate,
      employees: run.employeeCount,
      gross: run.grossTotal,
      net: run.netTotal,
      currency: run.currency,
    };
  }

  private async organizationOf(tx: DbExecutor, companyId: string): Promise<string | null> {
    const [row] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row?.organizationId ?? null;
  }

  private viewQuery(executor: DbExecutor) {
    const paymentJournal = sql<
      string | null
    >`(select j.document_number from journal_entries j where j.id = ${payRuns.paymentJournalEntryId})`;
    const approvedByName = sql<
      string | null
    >`(select u.first_name || ' ' || u.last_name from users u where u.id = ${payRuns.approvedBy})`;
    return executor
      .select({
        run: payRuns,
        journalNumber: journalEntries.documentNumber,
        paymentJournalNumber: paymentJournal,
        bankAccountCode: bankAccounts.code,
        createdByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
        approvedByName,
      })
      .from(payRuns)
      .leftJoin(journalEntries, eq(journalEntries.id, payRuns.journalEntryId))
      .leftJoin(bankAccounts, eq(bankAccounts.id, payRuns.bankAccountId))
      .leftJoin(users, eq(users.id, payRuns.createdBy))
      .$dynamic();
  }
}

function toView(row: {
  run: PayRun;
  journalNumber: string | null;
  paymentJournalNumber: string | null;
  bankAccountCode: string | null;
  createdByName: string | null;
  approvedByName: string | null;
}): PayRunView {
  const { run, ...rest } = row;
  return { ...run, ...rest };
}
