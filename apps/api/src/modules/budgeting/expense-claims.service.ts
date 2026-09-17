import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type ExpenseClaimStatus, type PaginatedResult } from '@accounting/types';
import type {
  CreateExpenseClaimInput,
  ListExpenseClaimsQuery,
  PayExpenseClaimInput,
  UpdateExpenseClaimInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  expenseClaimLines,
  expenseClaims,
  users,
  type ExpenseClaim,
  type ExpenseClaimLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { SodService } from '@/modules/rbac/sod.service';
import { TaxEngineService } from '@/modules/tax/tax-engine.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { AuthorityService } from '@/modules/delegations/authority.service';

const MODULE = 'EXPENSE_CLAIMS';

export interface ExpenseClaimView extends ExpenseClaim {
  claimantName: string;
  claimantEmail: string;
  journalNumber: string | null;
  paymentJournalNumber: string | null;
  lineCount: number;
}

export interface ExpenseClaimLineView extends ExpenseClaimLine {
  accountCode: string;
  accountName: string;
  taxCode: string | null;
}

export interface ExpenseClaimDetail extends ExpenseClaimView {
  lines: ExpenseClaimLineView[];
}

/**
 * Employee expense claims. The approver must differ from the claimant; posting
 * books Dr expense (net) / Dr input tax / Cr employee payable, and payment
 * books Dr employee payable / Cr bank. Every step is audited.
 */
@Injectable()
export class ExpenseClaimsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly tax: TaxEngineService,
    private readonly banking: BankingService,
    private readonly sod: SodService,
    private readonly approvals: ApprovalsService,
    private readonly authority: AuthorityService,
  ) {}

  async list(
    companyId: string,
    query: ListExpenseClaimsQuery,
  ): Promise<PaginatedResult<ExpenseClaimView>> {
    const filters: SQL[] = [eq(expenseClaims.companyId, companyId)];
    if (query.status) filters.push(eq(expenseClaims.status, query.status));
    if (query.claimantUserId) filters.push(eq(expenseClaims.claimantUserId, query.claimantUserId));
    if (query.from) filters.push(gte(expenseClaims.claimDate, query.from));
    if (query.to) filters.push(lte(expenseClaims.claimDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          sql`${expenseClaims.claimNumber} ilike ${term}`,
          sql`${expenseClaims.purpose} ilike ${term}`,
          sql`${users.lastName} ilike ${term}`,
        )!,
      );
    }
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(expenseClaims.claimDate), desc(expenseClaims.claimNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(expenseClaims)
        .innerJoin(users, eq(users.id, expenseClaims.claimantUserId))
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<ExpenseClaimDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Expense claim', id);
    const lines = await this.db
      .select({
        line: expenseClaimLines,
        accountCode: accounts.code,
        accountName: accounts.name,
        taxCode: sql<
          string | null
        >`(select t.code from tax_codes t where t.id = ${sql.raw('"expense_claim_lines"."tax_code_id"')})`,
      })
      .from(expenseClaimLines)
      .innerJoin(accounts, eq(accounts.id, expenseClaimLines.accountId))
      .where(eq(expenseClaimLines.claimId, id))
      .orderBy(asc(expenseClaimLines.lineNumber));
    return {
      ...row,
      lines: lines.map((l) => ({
        ...l.line,
        accountCode: l.accountCode,
        accountName: l.accountName,
        taxCode: l.taxCode,
      })),
    };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateExpenseClaimInput,
  ): Promise<ExpenseClaimDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: expenseClaims.id })
          .from(expenseClaims)
          .where(
            and(
              eq(expenseClaims.companyId, companyId),
              eq(expenseClaims.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const claimantUserId = input.claimantUserId ?? actor.id;
      const [claimant] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.id, claimantUserId));
      if (!claimant) throw new NotFoundError('User', claimantUserId);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const computed = await this.computeLines(
        tx,
        companyId,
        currency,
        input.claimDate,
        input.lines,
      );
      const claimNumber = await this.numbering.allocate(
        companyId,
        'EXP',
        Number(input.claimDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(expenseClaims)
        .values({
          companyId,
          claimNumber,
          claimantUserId,
          branchId: input.branchId ?? null,
          claimDate: input.claimDate,
          purpose: input.purpose,
          notes: input.notes ?? null,
          currency,
          total: computed.total.toString(),
          taxTotal: computed.taxTotal.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx
        .insert(expenseClaimLines)
        .values(computed.lines.map((l) => ({ ...l, claimId: created!.id })));
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: created!.id,
          newValue: { claimNumber, claimantUserId, total: computed.total.toString() },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateExpenseClaimInput,
  ): Promise<ExpenseClaimDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['DRAFT', 'REJECTED'], 'edited');
      const claimDate = input.claimDate ?? existing.claimDate;
      let totals = { total: existing.total, taxTotal: existing.taxTotal };
      if (input.lines) {
        const computed = await this.computeLines(
          tx,
          companyId,
          existing.currency,
          claimDate,
          input.lines,
        );
        await tx.delete(expenseClaimLines).where(eq(expenseClaimLines.claimId, id));
        await tx
          .insert(expenseClaimLines)
          .values(computed.lines.map((l) => ({ ...l, claimId: id })));
        totals = { total: computed.total.toString(), taxTotal: computed.taxTotal.toString() };
      }
      await tx
        .update(expenseClaims)
        .set({
          claimDate,
          purpose: input.purpose ?? existing.purpose,
          notes: input.notes === undefined ? existing.notes : input.notes,
          branchId: input.branchId === undefined ? existing.branchId : input.branchId,
          status: 'DRAFT',
          rejectionReason: null,
          ...totals,
        })
        .where(eq(expenseClaims.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          previousValue: { status: existing.status, total: existing.total },
          newValue: { status: 'DRAFT', ...totals },
          metadata: { actor: actor.email, claimNumber: existing.claimNumber },
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
      this.assertStatus(existing, ['DRAFT', 'REJECTED'], 'deleted');
      await tx.delete(expenseClaims).where(eq(expenseClaims.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          previousValue: { claimNumber: existing.claimNumber },
          companyId,
        },
        tx,
      );
    });
  }

  async submit(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ExpenseClaimDetail> {
    await this.transition(companyId, actor, id, ['DRAFT', 'REJECTED'], 'SUBMITTED', 'SUBMIT', {
      submittedAt: new Date(),
      rejectionReason: null,
    });
    const claim = await this.get(companyId, id);
    await this.db.transaction((tx) =>
      this.approvals.open(tx, {
        companyId,
        documentType: 'EXPENSE_CLAIM',
        documentId: id,
        documentNumber: claim.claimNumber,
        amount: claim.total,
        currency: claim.currency,
        requestedBy: actor.id,
        branchId: claim.branchId,
      }),
    );
    return claim;
  }

  /** The approver may not be the claimant; the seeded SoD policy also flags creator = approver. */
  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ExpenseClaimDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, ['SUBMITTED'], 'approved');
      if (existing.claimantUserId === actor.id) {
        throw new BusinessRuleError(
          ErrorCodes.SOD_VIOLATION,
          'You cannot approve your own expense claim.',
        );
      }
      await this.sod.checkActorSeparation(
        actor.organizationId,
        ['expense-claim.create', 'expense-claim.approve'],
        existing.createdBy,
        actor.id,
        tx,
      );
      await this.approvals.assertApproved(tx, {
        companyId,
        documentType: 'EXPENSE_CLAIM',
        documentId: id,
        documentNumber: existing.claimNumber,
        amount: existing.total,
        currency: existing.currency,
        requestedBy: existing.claimantUserId,
        branchId: existing.branchId,
      });
      const authority = await this.authority.assert(tx, actor, P['expense-claim.approve'], {
        companyId,
        amount: existing.total,
        currency: existing.currency,
        documentType: 'EXPENSE_CLAIM',
        documentId: id,
        documentNumber: existing.claimNumber,
        createdBy: existing.claimantUserId,
        action: 'Approved expense claim',
      });
      await tx
        .update(expenseClaims)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(expenseClaims.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: { status: 'APPROVED' },
          metadata: { actor: actor.email, claimNumber: existing.claimNumber, ...authority.audit },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async reject(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<ExpenseClaimDetail> {
    await this.transition(companyId, actor, id, ['SUBMITTED'], 'REJECTED', 'REJECT', {
      rejectionReason: reason,
    });
    return this.get(companyId, id);
  }

  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<ExpenseClaimDetail> {
    await this.transition(
      companyId,
      actor,
      id,
      ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED'],
      'CANCELLED',
      'VOID',
      { rejectionReason: reason },
    );
    return this.get(companyId, id);
  }

  /** Dr expense (net of tax) per line, Dr input tax, Cr employee payable for the gross total. Idempotent. */
  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<ExpenseClaimDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'POSTED' || existing.status === 'PAID') return;
      this.assertStatus(existing, ['APPROVED'], 'posted');
      const payable = await this.accounts.resolveMapped(companyId, 'EMPLOYEE_PAYABLE', tx);
      const lines = await tx
        .select()
        .from(expenseClaimLines)
        .where(eq(expenseClaimLines.claimId, id))
        .orderBy(asc(expenseClaimLines.lineNumber));
      const claimant = await this.claimant(tx, existing.claimantUserId);
      const currency = existing.currency;
      const taxLines = await this.tax.postingLines(
        tx,
        companyId,
        'PURCHASES',
        currency,
        lines.map((l) => ({
          id: l.id,
          amount: Money.of(l.amount, currency).subtract(Money.of(l.taxAmount, currency)).toString(),
          branchId: null,
          taxCodeId: l.taxCodeId,
          taxRate: l.taxRate,
          taxAmount: l.taxAmount,
          withholdingTaxCodeId: null,
          withholdingRate: '0',
          withholdingAmount: '0',
        })),
        false,
      );
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.claimDate,
          description: `Expense claim ${existing.claimNumber} - ${claimant.name}: ${existing.purpose}`,
          reference: existing.claimNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'EXPENSE_CLAIM',
          sourceId: existing.id,
          actor,
          lines: [
            ...lines.map((l) => ({
              accountId: l.accountId,
              debit: Money.of(l.amount, currency)
                .subtract(Money.of(l.taxAmount, currency))
                .toString(),
              credit: '0',
              description: l.description,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
            ...taxLines,
            {
              accountId: payable.id,
              debit: '0',
              credit: existing.total,
              description: `${existing.claimNumber} due to ${claimant.name}`,
            },
          ],
        },
        { permission: P['expense-claim.post'] },
      );
      await this.tax.record(
        tx,
        {
          companyId,
          side: 'PURCHASES',
          sourceType: 'EXPENSE_CLAIM',
          sourceId: existing.id,
          documentNumber: existing.claimNumber,
          journalEntryId: entry.id,
          transactionDate: existing.claimDate,
          party: { id: claimant.id, name: claimant.name, taxNumber: null },
          negate: false,
        },
        lines.map((l) => ({
          id: l.id,
          amount: Money.of(l.amount, currency).subtract(Money.of(l.taxAmount, currency)).toString(),
          branchId: null,
          taxCodeId: l.taxCodeId,
          taxRate: l.taxRate,
          taxAmount: l.taxAmount,
          withholdingTaxCodeId: null,
          withholdingRate: '0',
          withholdingAmount: '0',
        })),
        currency,
      );
      await tx
        .update(expenseClaims)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(expenseClaims.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          newValue: { status: 'POSTED', journalEntryId: entry.id },
          metadata: {
            actor: actor.email,
            claimNumber: existing.claimNumber,
            journalNumber: entry.documentNumber,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /** Dr employee payable / Cr bank GL account for the gross total. */
  async pay(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: PayExpenseClaimInput,
  ): Promise<ExpenseClaimDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'PAID') return;
      this.assertStatus(existing, ['POSTED'], 'paid');
      if (input.paymentDate < existing.claimDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Payment cannot precede the claim date.',
        );
      const bank = await this.banking.bankAccount(companyId, input.bankAccountId, tx);
      const payable = await this.accounts.resolveMapped(companyId, 'EMPLOYEE_PAYABLE', tx);
      const claimant = await this.claimant(tx, existing.claimantUserId);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.paymentDate,
          description: `Reimburse ${existing.claimNumber} - ${claimant.name}`,
          reference: input.reference ?? existing.claimNumber,
          journalType: 'GENERAL',
          branchId: existing.branchId,
          sourceType: 'EXPENSE_CLAIM_PAYMENT',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: payable.id,
              debit: existing.total,
              credit: '0',
              description: `${existing.claimNumber} settled`,
            },
            {
              accountId: bank.glAccountId,
              debit: '0',
              credit: existing.total,
              description: `Reimbursement ${existing.claimNumber}`,
            },
          ],
        },
        { permission: P['expense-claim.post'] },
      );
      await tx
        .update(expenseClaims)
        .set({
          status: 'PAID',
          paymentJournalEntryId: entry.id,
          paymentBankAccountId: bank.id,
          paymentDate: input.paymentDate,
          paymentReference: input.reference ?? null,
          paidBy: actor.id,
          paidAt: new Date(),
        })
        .where(eq(expenseClaims.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'PAID', paymentJournalEntryId: entry.id, bankAccount: bank.code },
          metadata: { actor: actor.email, claimNumber: existing.claimNumber },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // ------------------------------------------------------------ payroll hooks

  /** Posted (unpaid) claims of these users, for reimbursement through a pay run (Prompt #11). */
  async postedClaimsForUsers(
    tx: DbExecutor,
    companyId: string,
    userIds: readonly string[],
  ): Promise<Array<{ id: string; claimNumber: string; claimantUserId: string; total: string }>> {
    if (userIds.length === 0) return [];
    return tx
      .select({
        id: expenseClaims.id,
        claimNumber: expenseClaims.claimNumber,
        claimantUserId: expenseClaims.claimantUserId,
        total: expenseClaims.total,
      })
      .from(expenseClaims)
      .where(
        and(
          eq(expenseClaims.companyId, companyId),
          eq(expenseClaims.status, 'POSTED'),
          inArray(expenseClaims.claimantUserId, [...userIds]),
        ),
      )
      .orderBy(asc(expenseClaims.claimDate));
  }

  /**
   * Marks claims settled by a pay run's payment journal (which debited the
   * employee payable for them). Refuses when a claim is no longer POSTED -
   * it was paid or cancelled since the run was calculated.
   */
  async settleThroughPayroll(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    claimIds: readonly string[],
    payment: {
      journalEntryId: string;
      bankAccountId: string;
      paymentDate: string;
      reference: string;
    },
  ): Promise<void> {
    if (claimIds.length === 0) return;
    const rows = await tx
      .select({
        id: expenseClaims.id,
        claimNumber: expenseClaims.claimNumber,
        status: expenseClaims.status,
      })
      .from(expenseClaims)
      .where(and(eq(expenseClaims.companyId, companyId), inArray(expenseClaims.id, [...claimIds])))
      .for('update');
    const stale = rows.filter((r) => r.status !== 'POSTED');
    if (stale.length || rows.length !== claimIds.length)
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `Expense claim(s) ${stale.map((r) => r.claimNumber).join(', ') || 'missing'} are no longer awaiting payment - recalculate the pay run.`,
      );
    await tx
      .update(expenseClaims)
      .set({
        status: 'PAID',
        paymentJournalEntryId: payment.journalEntryId,
        paymentBankAccountId: payment.bankAccountId,
        paymentDate: payment.paymentDate,
        paymentReference: payment.reference,
        paidBy: actor.id,
        paidAt: new Date(),
      })
      .where(inArray(expenseClaims.id, [...claimIds]));
    for (const r of rows)
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: r.id,
          previousValue: { status: 'POSTED' },
          newValue: {
            status: 'PAID',
            paymentJournalEntryId: payment.journalEntryId,
            via: 'PAYROLL',
          },
          metadata: {
            actor: actor.email,
            claimNumber: r.claimNumber,
            reference: payment.reference,
          },
          companyId,
        },
        tx,
      );
  }

  // ----------------------------------------------------------------- helpers

  private async computeLines(
    tx: DbExecutor,
    companyId: string,
    currency: string,
    claimDate: string,
    lines: CreateExpenseClaimInput['lines'],
  ) {
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const chart = await this.accounts.findByIds(companyId, accountIds, tx);
    for (const id of accountIds) {
      const account = chart.find((a) => a.id === id);
      if (!account) throw new NotFoundError('Account', id);
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used for postings.`,
        );
      if (account.type !== 'EXPENSE' && account.type !== 'ASSET')
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${account.code} is not an expense or asset account.`,
        );
    }
    await this.dimensions.validateRefs(tx, companyId, lines, claimDate);
    for (const l of lines) {
      if (l.expenseDate > claimDate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'An expense cannot be dated after the claim.',
        );
    }
    const split = await this.tax.splitInclusive(
      tx,
      companyId,
      claimDate,
      currency,
      lines.map((l) => ({ amount: l.amount, taxCodeId: l.taxCodeId ?? null })),
    );
    let total = Money.zero(currency);
    let taxTotal = Money.zero(currency);
    const computed = lines.map((l, i) => {
      const gross = Money.parse(l.amount, currency);
      total = total.add(gross);
      taxTotal = taxTotal.add(Money.of(split[i]!.taxAmount, currency));
      return {
        lineNumber: i + 1,
        expenseDate: l.expenseDate,
        description: l.description,
        merchant: l.merchant ?? null,
        receiptReference: l.receiptReference ?? null,
        accountId: l.accountId,
        departmentId: l.departmentId ?? null,
        costCenterId: l.costCenterId ?? null,
        projectId: l.projectId ?? null,
        amount: gross.toString(),
        taxCodeId: split[i]!.taxCodeId,
        taxRate: split[i]!.taxRate,
        taxAmount: split[i]!.taxAmount,
      };
    });
    return { lines: computed, total, taxTotal };
  }

  private async transition(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    from: ExpenseClaimStatus[],
    to: ExpenseClaimStatus,
    action: 'SUBMIT' | 'REJECT' | 'VOID',
    extra: Partial<typeof expenseClaims.$inferInsert>,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      this.assertStatus(existing, from, to.toLowerCase());
      await tx
        .update(expenseClaims)
        .set({ status: to, ...extra })
        .where(eq(expenseClaims.id, id));
      if (to === 'REJECTED' || to === 'CANCELLED')
        await this.approvals.cancelFor(tx, 'EXPENSE_CLAIM', id);
      await this.audit.record(
        {
          action,
          module: MODULE,
          entityType: 'ExpenseClaim',
          entityId: id,
          previousValue: { status: existing.status },
          newValue: {
            status: to,
            ...('rejectionReason' in extra ? { reason: extra.rejectionReason } : {}),
          },
          metadata: { actor: actor.email, claimNumber: existing.claimNumber },
          companyId,
        },
        tx,
      );
    });
  }

  private assertStatus(claim: ExpenseClaim, allowed: ExpenseClaimStatus[], verb: string): void {
    if (!allowed.includes(claim.status)) {
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${claim.claimNumber} is ${claim.status.toLowerCase()} and cannot be ${verb}.`,
        { status: claim.status },
      );
    }
  }

  private async claimant(tx: DbExecutor, userId: string): Promise<{ id: string; name: string }> {
    const [u] = await tx
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) throw new NotFoundError('User', userId);
    return { id: u.id, name: `${u.firstName} ${u.lastName}` };
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<ExpenseClaim> {
    const [row] = await tx
      .select()
      .from(expenseClaims)
      .where(and(eq(expenseClaims.id, id), eq(expenseClaims.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Expense claim', id);
    return row;
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(expenseClaims),
        claimantName: sql<string>`${users.firstName} || ' ' || ${users.lastName}`,
        claimantEmail: users.email,
        journalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${expenseClaims.journalEntryId})`,
        paymentJournalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${expenseClaims.paymentJournalEntryId})`,
        lineCount: sql<number>`(select count(*)::int from expense_claim_lines l where l.claim_id = ${expenseClaims.id})`,
      })
      .from(expenseClaims)
      .innerJoin(users, eq(users.id, expenseClaims.claimantUserId));
  }
}
