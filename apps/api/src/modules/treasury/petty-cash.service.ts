import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreatePettyCashFundInput,
  CreatePettyCashVoucherInput,
  ListPettyCashVouchersQuery,
  ReplenishPettyCashInput,
  UpdatePettyCashFundInput,
  UpdatePettyCashVoucherInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  bankAccounts,
  companies,
  journalEntries,
  pettyCashFunds,
  pettyCashVoucherLines,
  pettyCashVouchers,
  users,
  type PettyCashFund,
  type PettyCashVoucher,
  type PettyCashVoucherLine,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { TreasuryConfigService } from './treasury-config.service';
import { pettyCashOnHand, replenishmentDue } from './treasury.logic';

const MODULE = 'TREASURY';

export interface PettyCashFundView extends PettyCashFund {
  glAccountCode: string;
  custodianName: string | null;
  currency: string;
  /** GL balance of the fund account (what the books say is in the box). */
  bookBalance: string;
  /** Posted vouchers not yet replenished. */
  unreplenished: string;
  unreplenishedCount: number;
  /** imprest - unreplenished vouchers (what should be in the box). */
  expectedCashOnHand: string;
  replenishmentDue: boolean;
  draftCount: number;
}

export interface PettyCashVoucherView extends PettyCashVoucher {
  fundCode: string;
  fundName: string;
  journalNumber: string | null;
}

export interface PettyCashVoucherDetail extends PettyCashVoucherView {
  lines: Array<PettyCashVoucherLine & { accountCode: string; accountName: string }>;
}

/**
 * Petty cash (Prompt #8): imprest funds each with a dedicated cash-on-hand
 * GL account. Vouchers post Dr expense lines / Cr fund account; replenishment
 * is a bank withdrawal to the fund account (Dr fund / Cr bank) that brings
 * the fund back to its imprest and marks the vouchers reimbursed. The fund's
 * book balance is always the GL - never stored.
 */
@Injectable()
export class PettyCashService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly banking: BankingService,
    private readonly authority: AuthorityService,
    private readonly sod: SodService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
    private readonly config: TreasuryConfigService,
    private readonly approvals: ApprovalsService,
  ) {}

  // -------------------------------------------------------------------- funds

  async listFunds(companyId: string): Promise<PettyCashFundView[]> {
    const rows = await this.fundQuery(this.db)
      .where(eq(pettyCashFunds.companyId, companyId))
      .orderBy(asc(pettyCashFunds.code));
    return Promise.all(rows.map((r) => this.decorateFund(companyId, r)));
  }

  async getFund(companyId: string, id: string): Promise<PettyCashFundView> {
    const [row] = await this.fundQuery(this.db).where(
      and(eq(pettyCashFunds.id, id), eq(pettyCashFunds.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Petty cash fund', id);
    return this.decorateFund(companyId, row);
  }

  async createFund(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePettyCashFundInput,
  ): Promise<PettyCashFundView> {
    const id = await this.db.transaction(async (tx) => {
      const gl = await this.accounts.getOrThrow(companyId, input.glAccountId, tx);
      if (gl.isHeader || gl.status !== 'ACTIVE' || gl.type !== 'ASSET')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${gl.code} ${gl.name} is not a usable cash account.`,
        );
      const [custodian] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, input.custodianId));
      if (!custodian) throw new NotFoundError('User', input.custodianId);
      let row: PettyCashFund | undefined;
      try {
        [row] = await tx
          .insert(pettyCashFunds)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            glAccountId: gl.id,
            imprestAmount: input.imprestAmount,
            custodianId: input.custodianId,
            branchId: input.branchId ?? null,
            voucherApprovalLimit: input.voucherApprovalLimit ?? null,
            replenishAtPercent: input.replenishAtPercent ?? '25',
            notes: input.notes ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'petty_cash_funds_company_code_uq'))
          throw new DuplicateError('Petty cash fund', 'code', input.code);
        if (isUniqueViolation(err, 'petty_cash_funds_gl_account_uq'))
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            'That GL account already belongs to another fund.',
          );
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PettyCashFund',
          entityId: row!.id,
          newValue: row,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!.id;
    });
    return this.getFund(companyId, id);
  }

  async updateFund(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePettyCashFundInput,
  ): Promise<PettyCashFundView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(pettyCashFunds)
        .where(and(eq(pettyCashFunds.id, id), eq(pettyCashFunds.companyId, companyId)));
      if (!existing) throw new NotFoundError('Petty cash fund', id);
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) if (v !== undefined) patch[k] = v;
      const [row] = await tx
        .update(pettyCashFunds)
        .set(patch)
        .where(eq(pettyCashFunds.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PettyCashFund',
          entityId: id,
          previousValue: existing,
          newValue: row,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getFund(companyId, id);
  }

  // ----------------------------------------------------------------- vouchers

  async listVouchers(
    companyId: string,
    query: ListPettyCashVouchersQuery,
  ): Promise<PaginatedResult<PettyCashVoucherView>> {
    const filters: SQL[] = [eq(pettyCashVouchers.companyId, companyId)];
    if (query.fundId) filters.push(eq(pettyCashVouchers.fundId, query.fundId));
    if (query.status) filters.push(eq(pettyCashVouchers.status, query.status));
    if (query.from) filters.push(gte(pettyCashVouchers.voucherDate, query.from));
    if (query.to) filters.push(lte(pettyCashVouchers.voucherDate, query.to));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.voucherQuery(this.db)
        .where(where)
        .orderBy(desc(pettyCashVouchers.voucherDate), desc(pettyCashVouchers.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, pettyCashVouchers, where),
    ]);
    return toPaginatedResult(rows.map(decorateVoucher), total, query);
  }

  async getVoucher(companyId: string, id: string): Promise<PettyCashVoucherDetail> {
    const [row] = await this.voucherQuery(this.db).where(
      and(eq(pettyCashVouchers.id, id), eq(pettyCashVouchers.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Petty cash voucher', id);
    const lines = await this.db
      .select({
        line: pettyCashVoucherLines,
        accountCode: accounts.code,
        accountName: accounts.name,
      })
      .from(pettyCashVoucherLines)
      .innerJoin(accounts, eq(accounts.id, pettyCashVoucherLines.accountId))
      .where(eq(pettyCashVoucherLines.voucherId, id))
      .orderBy(asc(pettyCashVoucherLines.lineNumber));
    return {
      ...decorateVoucher(row),
      lines: lines.map((l) => ({
        ...l.line,
        accountCode: l.accountCode,
        accountName: l.accountName,
      })),
    };
  }

  async createVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePettyCashVoucherInput,
  ): Promise<PettyCashVoucherDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: pettyCashVouchers.id })
          .from(pettyCashVouchers)
          .where(
            and(
              eq(pettyCashVouchers.companyId, companyId),
              eq(pettyCashVouchers.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const fund = await this.lockFund(tx, companyId, input.fundId);
      if (fund.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `Fund ${fund.code} is ${fund.status.toLowerCase()}.`,
        );
      const currency = await this.accounts.companyCurrency(companyId, tx);
      await this.posting.resolvePeriod(tx, companyId, input.voucherDate, { draft: true });
      for (const l of input.lines) {
        const acct = await this.accounts.getOrThrow(companyId, l.accountId, tx);
        if (acct.isHeader || acct.status !== 'ACTIVE')
          throw new BusinessRuleError(
            ErrorCodes.ACCOUNT_NOT_POSTABLE,
            `${acct.code} is not postable.`,
          );
      }
      await this.dimensions.validateRefs(
        tx,
        companyId,
        input.lines.map((l) => ({ ...l.dimensions })),
        input.voucherDate,
      );
      const total = input.lines.reduce(
        (m, l) => m.add(Money.parse(l.amount, currency)),
        Money.zero(currency),
      );
      // A voucher may never exceed what should be in the box.
      const onHand = await this.expectedOnHand(companyId, fund, currency, tx);
      if (total.greaterThan(onHand))
        throw new BusinessRuleError(
          ErrorCodes.ALLOCATION_EXCEEDS_BALANCE,
          `Voucher ${total.toString()} exceeds the ${onHand.toString()} expected in the fund; replenish first.`,
          { expectedCashOnHand: onHand.toString() },
        );
      const documentNumber = await this.numbering.allocate(
        companyId,
        'PCV',
        Number(input.voucherDate.slice(0, 4)),
        tx,
      );
      const [row] = await tx
        .insert(pettyCashVouchers)
        .values({
          companyId,
          fundId: fund.id,
          documentNumber,
          voucherDate: input.voucherDate,
          payee: input.payee,
          description: input.description ?? null,
          receiptReference: input.receiptReference ?? null,
          total: total.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await tx.insert(pettyCashVoucherLines).values(
        input.lines.map((l, i) => ({
          voucherId: row!.id,
          lineNumber: i + 1,
          description: l.description,
          accountId: l.accountId,
          amount: Money.parse(l.amount, currency).toString(),
          taxCodeId: l.taxCodeId ?? null,
          ...l.dimensions,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: row!.id,
          newValue: {
            documentNumber,
            fund: fund.code,
            payee: input.payee,
            total: total.toString(),
          },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!.id;
    });
    return this.getVoucher(companyId, id);
  }

  async updateVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePettyCashVoucherInput,
  ): Promise<PettyCashVoucherDetail> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, companyId, id);
      if (v.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only draft vouchers can be edited.',
        );
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const patch: Record<string, unknown> = {};
      if (input.voucherDate) patch.voucherDate = input.voucherDate;
      if (input.payee) patch.payee = input.payee;
      if (input.description !== undefined) patch.description = input.description ?? null;
      if (input.receiptReference !== undefined)
        patch.receiptReference = input.receiptReference ?? null;
      if (input.lines) {
        await this.dimensions.validateRefs(
          tx,
          companyId,
          input.lines.map((l) => ({ ...l.dimensions })),
          input.voucherDate ?? v.voucherDate,
        );
        await tx.delete(pettyCashVoucherLines).where(eq(pettyCashVoucherLines.voucherId, id));
        await tx.insert(pettyCashVoucherLines).values(
          input.lines.map((l, i) => ({
            voucherId: id,
            lineNumber: i + 1,
            description: l.description,
            accountId: l.accountId,
            amount: Money.parse(l.amount, currency).toString(),
            taxCodeId: l.taxCodeId ?? null,
            ...l.dimensions,
          })),
        );
        patch.total = input.lines
          .reduce((m, l) => m.add(Money.parse(l.amount, currency)), Money.zero(currency))
          .toString();
      }
      await tx.update(pettyCashVouchers).set(patch).where(eq(pettyCashVouchers.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: id,
          previousValue: { total: v.total, payee: v.payee },
          newValue: patch,
          metadata: { documentNumber: v.documentNumber, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getVoucher(companyId, id);
  }

  /** Delegable approval; the custodian / creator may not approve above the fund's limit. */
  /** Submit for approval: opens the workflow (when one is configured for vouchers) and tells approvers. */
  async submitVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<PettyCashVoucherDetail> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, companyId, id);
      if (v.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${v.documentNumber} is ${v.status}.`,
        );
      const fund = await this.lockFund(tx, companyId, v.fundId);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const request = await this.approvals.open(
        tx,
        this.voucherRef(companyId, v, fund.branchId, currency, actor.id),
      );
      const [company] = await tx
        .select({ organizationId: companies.organizationId })
        .from(companies)
        .where(eq(companies.id, companyId));
      await this.notifications.notify(
        {
          organizationId: company!.organizationId,
          eventType: 'PETTY_CASH_APPROVAL_REQUIRED',
          severity: 'INFO',
          title: `Petty cash voucher ${v.documentNumber} awaits approval`,
          body: `${currency} ${v.total} from ${fund.code}, submitted by ${actor.email}.`,
          link: `/treasury/petty-cash`,
          entityType: 'PettyCashVoucher',
          entityId: id,
          permission: 'petty-cash.approve',
          companyId,
          dedupeKey: `petty-cash-approval:${id}`,
        },
        tx,
      );
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: id,
          newValue: { submitted: true, approvalRequestId: request?.id ?? null },
          metadata: { reason: 'submitted for approval', documentNumber: v.documentNumber },
          companyId,
        },
        tx,
      );
    });
    return this.getVoucher(companyId, id);
  }

  async approveVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<PettyCashVoucherDetail> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, companyId, id);
      if (v.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${v.documentNumber} is ${v.status}.`,
        );
      const fund = await this.lockFund(tx, companyId, v.fundId);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      // A configured workflow must have run its course before anyone approves.
      await this.approvals.assertApproved(
        tx,
        this.voucherRef(companyId, v, fund.branchId, currency, v.createdBy ?? actor.id),
      );
      const authority = await this.authority.assert(tx, actor, P['petty-cash.approve'], {
        companyId,
        branchId: fund.branchId,
        amount: v.total,
        currency,
        documentType: 'PETTY_CASH_VOUCHER',
        documentId: id,
        documentNumber: v.documentNumber,
        createdBy: v.createdBy,
        action: 'Approved petty cash voucher',
      });
      const limit =
        fund.voucherApprovalLimit ??
        (await this.config.settings(companyId, tx)).pettyCashVoucherLimit;
      const aboveLimit =
        limit !== null && Money.of(v.total, currency).greaterThan(Money.of(limit, currency));
      if (aboveLimit)
        await this.sod.checkActorSeparation(
          actor.organizationId,
          [P['petty-cash.manage'], P['petty-cash.approve']],
          v.createdBy,
          actor.id,
          tx,
          {
            companyId,
            entityType: 'PettyCashVoucher',
            entityId: id,
            documentNumber: v.documentNumber,
          },
        );
      await tx
        .update(pettyCashVouchers)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(pettyCashVouchers.id, id));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'APPROVED' },
          metadata: { documentNumber: v.documentNumber, aboveLimit, ...authority.audit },
          companyId,
        },
        tx,
      );
    });
    return this.getVoucher(companyId, id);
  }

  /** Dr expense lines / Cr fund cash account. */
  async postVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<PettyCashVoucherDetail> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, companyId, id);
      if (v.status !== 'APPROVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${v.documentNumber} must be approved before posting.`,
        );
      const fund = await this.lockFund(tx, companyId, v.fundId);
      const lines = await tx
        .select()
        .from(pettyCashVoucherLines)
        .where(eq(pettyCashVoucherLines.voucherId, id))
        .orderBy(asc(pettyCashVoucherLines.lineNumber));
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: v.voucherDate,
          description: `Petty cash ${v.documentNumber} - ${v.payee}${v.description ? ` - ${v.description}` : ''}`,
          reference: v.receiptReference ?? v.documentNumber,
          branchId: fund.branchId,
          sourceType: 'PETTY_CASH_VOUCHER',
          sourceId: v.id,
          actor,
          lines: [
            ...lines.map((l) => ({
              accountId: l.accountId,
              debit: l.amount,
              credit: '0',
              description: l.description,
              branchId: fund.branchId,
              departmentId: l.departmentId,
              costCenterId: l.costCenterId,
              projectId: l.projectId,
            })),
            {
              accountId: fund.glAccountId,
              debit: '0',
              credit: v.total,
              description: `${v.documentNumber} paid from ${fund.code}`,
            },
          ],
        },
        { permission: P['petty-cash.post'] },
      );
      await tx
        .update(pettyCashVouchers)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(pettyCashVouchers.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: id,
          newValue: { status: 'POSTED', journalEntryId: entry.id },
          metadata: { documentNumber: v.documentNumber, journalNumber: entry.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'petty_cash.voucher_posted',
        companyId,
        dedupeKey: 'petty_cash.voucher_posted:' + id,
        payload: {
          voucherId: id,
          documentNumber: v.documentNumber,
          fundId: fund.id,
          fundCode: fund.code,
          payee: v.payee,
          total: v.total,
          journalNumber: entry.documentNumber,
        },
      });
      // Custodian nudge when the box runs low.
      const currency = await this.accounts.companyCurrency(companyId, tx);
      const onHand = await this.expectedOnHand(companyId, fund, currency, tx);
      if (replenishmentDue(fund.imprestAmount, onHand, fund.replenishAtPercent, currency)) {
        const [company] = await tx
          .select({ organizationId: companies.organizationId })
          .from(companies)
          .where(eq(companies.id, companyId));
        await this.notifications.notify(
          {
            organizationId: company!.organizationId,
            eventType: 'PETTY_CASH_LOW',
            severity: 'WARNING',
            title: `Petty cash fund ${fund.code} needs replenishment`,
            body: `${currency} ${onHand.toString()} expected on hand against an imprest of ${fund.imprestAmount}.`,
            link: '/treasury/petty-cash',
            entityType: 'PettyCashFund',
            entityId: fund.id,
            userIds: [fund.custodianId],
            permission: 'petty-cash.post',
            companyId,
            dedupeKey: `petty-cash-low:${fund.id}:${v.voucherDate.slice(0, 7)}`,
          },
          tx,
        );
      }
    });
    return this.getVoucher(companyId, id);
  }

  private voucherRef(
    companyId: string,
    v: PettyCashVoucher,
    branchId: string | null,
    currency: string,
    requestedBy: string,
  ) {
    return {
      companyId,
      documentType: 'PETTY_CASH_VOUCHER' as const,
      documentId: v.id,
      documentNumber: v.documentNumber,
      amount: v.total,
      currency,
      branchId,
      requestedBy,
    };
  }

  async voidVoucher(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
    voidDate?: string,
  ): Promise<PettyCashVoucherDetail> {
    await this.db.transaction(async (tx) => {
      const v = await this.lockVoucher(tx, companyId, id);
      if (v.status === 'VOID') return;
      if (v.replenishmentId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${v.documentNumber} was already reimbursed; record a receipt instead.`,
        );
      let reversalId: string | null = null;
      if (v.status === 'POSTED' && v.journalEntryId) {
        const originalLines = await tx.query.journalLines.findMany({
          where: (l, ops) => ops.eq(l.journalEntryId, v.journalEntryId!),
          orderBy: (l, ops) => ops.asc(l.lineNumber),
        });
        const reversal = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: voidDate ?? new Date().toISOString().slice(0, 10),
            description: `Void ${v.documentNumber}: ${reason}`,
            reference: v.documentNumber,
            journalType: 'REVERSAL',
            sourceType: 'PETTY_CASH_VOUCHER_VOID',
            sourceId: v.id,
            reversalOfId: v.journalEntryId,
            actor,
            lines: originalLines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              description: l.description,
              branchId: l.branchId,
            })),
          },
          { permission: P['petty-cash.post'] },
        );
        await tx
          .update(journalEntries)
          .set({ status: 'REVERSED', reversedById: reversal.id })
          .where(eq(journalEntries.id, v.journalEntryId));
        reversalId = reversal.id;
      }
      await tx
        .update(pettyCashVouchers)
        .set({
          status: 'VOID',
          reversalJournalEntryId: reversalId,
          voidReason: reason,
          voidedBy: actor.id,
          voidedAt: new Date(),
        })
        .where(eq(pettyCashVouchers.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'PettyCashVoucher',
          entityId: id,
          previousValue: { status: v.status },
          newValue: { status: 'VOID', reversalJournalEntryId: reversalId },
          metadata: { documentNumber: v.documentNumber, reason, editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getVoucher(companyId, id);
  }

  // ------------------------------------------------------------- replenishment

  /**
   * Bank withdrawal to the fund (Dr fund cash / Cr bank) for the posted,
   * unreimbursed vouchers (or the amount given); those vouchers are then
   * marked reimbursed so the fund reconciles back to its imprest.
   */
  async replenish(
    companyId: string,
    actor: AuthenticatedUser,
    fundId: string,
    input: ReplenishPettyCashInput,
  ): Promise<PettyCashFundView> {
    const fund = await this.getFund(companyId, fundId);
    if (fund.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `Fund ${fund.code} is ${fund.status.toLowerCase()}.`,
      );
    const currency = fund.currency;
    const amount = input.amount
      ? Money.parse(input.amount, currency)
      : Money.of(fund.unreplenished, currency);
    if (!amount.isPositive())
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'Nothing to replenish.');
    const [bank] = await this.db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, companyId)));
    if (!bank) throw new NotFoundError('Bank account', input.bankAccountId);
    // The bank transaction is the posting document (Dr fund cash / Cr bank), created and posted through banking.
    const created = await this.banking.createTransaction(companyId, actor, {
      bankAccountId: bank.id,
      transactionType: 'WITHDRAWAL',
      transactionDate: input.replenishmentDate,
      amount: amount.toString(),
      counterpartyAccountId: fund.glAccountId,
      reference: input.reference ?? `Replenish ${fund.code}`,
      memo: `Petty cash replenishment ${fund.code}`,
      idempotencyKey: `petty-cash:${fund.id}:${input.replenishmentDate}:${amount.toString()}`,
    });
    const posted = await this.banking.postTransaction(companyId, actor, created.id);
    await this.db.transaction(async (tx) => {
      await tx
        .update(pettyCashVouchers)
        .set({ replenishmentId: posted.id })
        .where(
          and(
            eq(pettyCashVouchers.fundId, fundId),
            eq(pettyCashVouchers.status, 'POSTED'),
            isNull(pettyCashVouchers.replenishmentId),
            lte(pettyCashVouchers.voucherDate, input.replenishmentDate),
          ),
        );
      await tx
        .update(pettyCashFunds)
        .set({ lastReplenishedAt: input.replenishmentDate })
        .where(eq(pettyCashFunds.id, fundId));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'PettyCashFund',
          entityId: fundId,
          newValue: { replenished: amount.toString(), bankTransactionId: posted.id },
          metadata: { editor: actor.email, documentNumber: posted.documentNumber },
          companyId,
        },
        tx,
      );
      await this.outbox.enqueue(tx, {
        eventType: 'petty_cash.replenished',
        companyId,
        dedupeKey: 'petty_cash.replenished:' + posted.id,
        payload: {
          fundId,
          fundCode: fund.code,
          amount: amount.toString(),
          currency,
          bankAccountId: bank.id,
          bankTransactionNumber: posted.documentNumber,
        },
      });
    });
    return this.getFund(companyId, fundId);
  }

  // ---------------------------------------------------------------- internals

  private async expectedOnHand(
    companyId: string,
    fund: PettyCashFund,
    currency: string,
    tx: DbExecutor,
  ): Promise<Money> {
    const [agg] = await tx
      .select({ total: sql<string>`coalesce(sum(${pettyCashVouchers.total}), 0)` })
      .from(pettyCashVouchers)
      .where(
        and(
          eq(pettyCashVouchers.fundId, fund.id),
          eq(pettyCashVouchers.status, 'POSTED'),
          isNull(pettyCashVouchers.replenishmentId),
        ),
      );
    return pettyCashOnHand(fund.imprestAmount, agg?.total ?? '0', currency);
  }

  private async decorateFund(
    companyId: string,
    row: { fund: PettyCashFund; glAccountCode: string; custodianName: string | null },
  ): Promise<PettyCashFundView> {
    const currency = await this.accounts.companyCurrency(companyId);
    const [agg] = await this.db
      .select({
        total: sql<string>`coalesce(sum(case when ${pettyCashVouchers.status} = 'POSTED' and ${pettyCashVouchers.replenishmentId} is null then ${pettyCashVouchers.total} else 0 end), 0)`,
        count: sql<number>`count(*) filter (where ${pettyCashVouchers.status} = 'POSTED' and ${pettyCashVouchers.replenishmentId} is null)`,
        drafts: sql<number>`count(*) filter (where ${pettyCashVouchers.status} in ('DRAFT', 'APPROVED'))`,
      })
      .from(pettyCashVouchers)
      .where(eq(pettyCashVouchers.fundId, row.fund.id));
    const book = await this.banking.ledgerBalance(
      companyId,
      row.fund.glAccountId,
      currency,
      '9999-12-31',
    );
    const onHand = pettyCashOnHand(row.fund.imprestAmount, agg?.total ?? '0', currency);
    return {
      ...row.fund,
      glAccountCode: row.glAccountCode,
      custodianName: row.custodianName,
      currency,
      bookBalance: book,
      unreplenished: Money.of(agg?.total ?? '0', currency).toString(),
      unreplenishedCount: Number(agg?.count ?? 0),
      expectedCashOnHand: onHand.toString(),
      replenishmentDue: replenishmentDue(
        row.fund.imprestAmount,
        onHand,
        row.fund.replenishAtPercent,
        currency,
      ),
      draftCount: Number(agg?.drafts ?? 0),
    };
  }

  private fundQuery(executor: DbExecutor) {
    return executor
      .select({ fund: pettyCashFunds, glAccountCode: accounts.code, custodianName: users.email })
      .from(pettyCashFunds)
      .innerJoin(accounts, eq(accounts.id, pettyCashFunds.glAccountId))
      .leftJoin(users, eq(users.id, pettyCashFunds.custodianId));
  }

  private voucherQuery(executor: DbExecutor) {
    return executor
      .select({
        voucher: pettyCashVouchers,
        fundCode: pettyCashFunds.code,
        fundName: pettyCashFunds.name,
        journalNumber: journalEntries.documentNumber,
      })
      .from(pettyCashVouchers)
      .innerJoin(pettyCashFunds, eq(pettyCashFunds.id, pettyCashVouchers.fundId))
      .leftJoin(journalEntries, eq(journalEntries.id, pettyCashVouchers.journalEntryId));
  }

  private async lockFund(tx: DbExecutor, companyId: string, id: string): Promise<PettyCashFund> {
    const [row] = await tx
      .select()
      .from(pettyCashFunds)
      .where(and(eq(pettyCashFunds.id, id), eq(pettyCashFunds.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Petty cash fund', id);
    return row;
  }

  private async lockVoucher(
    tx: DbExecutor,
    companyId: string,
    id: string,
  ): Promise<PettyCashVoucher> {
    const [row] = await tx
      .select()
      .from(pettyCashVouchers)
      .where(and(eq(pettyCashVouchers.id, id), eq(pettyCashVouchers.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Petty cash voucher', id);
    return row;
  }
}

function decorateVoucher(row: {
  voucher: PettyCashVoucher;
  fundCode: string;
  fundName: string;
  journalNumber: string | null;
}): PettyCashVoucherView {
  return {
    ...row.voucher,
    fundCode: row.fundCode,
    fundName: row.fundName,
    journalNumber: row.journalNumber,
  };
}
