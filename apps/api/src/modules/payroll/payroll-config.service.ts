import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type {
  CreatePayItemInput,
  UpdatePayItemInput,
  UpdatePayrollSettingsInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  bankAccounts,
  payItems,
  payrollSettings,
  type PayItem,
  type PayrollSettings,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'PAYROLL';

export interface PayItemView extends PayItem {
  expenseAccountCode: string | null;
  liabilityAccountCode: string | null;
}

/**
 * Payroll policy is data (Prompt #11): pay items (what an amount is, how
 * it is calculated and which accounts it posts to) and the company
 * settings row. Business logic never hard-codes a rate, a bracket or an
 * account - a missing account falls back to the company's mappings.
 */
@Injectable()
export class PayrollConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<PayrollSettings> {
    const [row] = await executor
      .select()
      .from(payrollSettings)
      .where(eq(payrollSettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(payrollSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(payrollSettings)
      .where(eq(payrollSettings.companyId, companyId));
    return again!;
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: UpdatePayrollSettingsInput,
  ): Promise<PayrollSettings> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      if (input.payrollBankAccountId) {
        const [bank] = await tx
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(
            and(
              eq(bankAccounts.companyId, companyId),
              eq(bankAccounts.id, input.payrollBankAccountId),
            ),
          );
        if (!bank) throw new NotFoundError('Bank account', input.payrollBankAccountId);
      }
      const patch: Partial<PayrollSettings> = {};
      if (input.defaultPayFrequency !== undefined)
        patch.defaultPayFrequency = input.defaultPayFrequency;
      if (input.payrollBankAccountId !== undefined)
        patch.payrollBankAccountId = input.payrollBankAccountId;
      if (input.reimburseExpenseClaims !== undefined)
        patch.reimburseExpenseClaims = input.reimburseExpenseClaims;
      if (input.payDateReminderDays !== undefined)
        patch.payDateReminderDays = input.payDateReminderDays;
      const [updated] = await tx
        .update(payrollSettings)
        .set(patch)
        .where(eq(payrollSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PayrollSettings',
          entityId: companyId,
          previousValue: previous,
          newValue: next,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return updated!;
    });
  }

  // ---------------------------------------------------------------- pay items

  async listPayItems(companyId: string, executor: DbExecutor = this.db): Promise<PayItemView[]> {
    const rows = await executor
      .select({ item: payItems, expenseCode: accounts.code })
      .from(payItems)
      .leftJoin(accounts, eq(accounts.id, payItems.expenseAccountId))
      .where(eq(payItems.companyId, companyId))
      .orderBy(asc(payItems.sortOrder), asc(payItems.code));
    const liabilityIds = [
      ...new Set(rows.map((r) => r.item.liabilityAccountId).filter(Boolean)),
    ] as string[];
    const liabilityCodes = new Map<string, string>();
    if (liabilityIds.length) {
      const chart = await executor
        .select({ id: accounts.id, code: accounts.code })
        .from(accounts)
        .where(eq(accounts.companyId, companyId));
      for (const a of chart) if (liabilityIds.includes(a.id)) liabilityCodes.set(a.id, a.code);
    }
    return rows.map((r) => ({
      ...r.item,
      expenseAccountCode: r.expenseCode,
      liabilityAccountCode: r.item.liabilityAccountId
        ? (liabilityCodes.get(r.item.liabilityAccountId) ?? null)
        : null,
    }));
  }

  async getPayItem(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<PayItem> {
    const [row] = await executor
      .select()
      .from(payItems)
      .where(and(eq(payItems.companyId, companyId), eq(payItems.id, id)));
    if (!row) throw new NotFoundError('Pay item', id);
    return row;
  }

  async createPayItem(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePayItemInput,
  ): Promise<PayItem> {
    return this.db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: payItems.id })
        .from(payItems)
        .where(and(eq(payItems.companyId, companyId), eq(payItems.code, input.code)));
      if (clash) throw new DuplicateError('Pay item', 'code', input.code);
      if (input.calculation === 'BASE_SALARY') {
        const [existing] = await tx
          .select({ id: payItems.id })
          .from(payItems)
          .where(
            and(
              eq(payItems.companyId, companyId),
              eq(payItems.calculation, 'BASE_SALARY'),
              eq(payItems.status, 'ACTIVE'),
            ),
          );
        if (existing)
          throw new BusinessRuleError(
            ErrorCodes.PAY_ITEM_INVALID,
            'The company already has an active base salary item.',
          );
      }
      await this.assertAccounts(
        tx,
        companyId,
        input.expenseAccountId ?? null,
        input.liabilityAccountId ?? null,
      );
      const [created] = await tx
        .insert(payItems)
        .values({
          companyId,
          code: input.code,
          name: input.name,
          type: input.type,
          calculation: input.calculation,
          description: input.description ?? null,
          amount: input.amount ?? null,
          rate: input.rate ?? null,
          maxBase: input.maxBase ?? null,
          brackets: input.brackets ?? [],
          taxable: input.type === 'EARNING' ? input.taxable : false,
          appliesToAll: input.calculation === 'BASE_SALARY' ? true : input.appliesToAll,
          expenseAccountId: input.expenseAccountId ?? null,
          liabilityAccountId: input.liabilityAccountId ?? null,
          sortOrder: input.sortOrder,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PayItem',
          entityId: created!.id,
          newValue: { code: created!.code, type: created!.type, calculation: created!.calculation },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updatePayItem(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePayItemInput,
  ): Promise<PayItem> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getPayItem(companyId, id, tx);
      await this.assertAccounts(
        tx,
        companyId,
        input.expenseAccountId === undefined ? null : input.expenseAccountId,
        input.liabilityAccountId === undefined ? null : input.liabilityAccountId,
      );
      if (existing.calculation === 'BRACKET' && input.brackets && input.brackets.length === 0)
        throw new BusinessRuleError(ErrorCodes.PAY_ITEM_INVALID, 'Bracket items need brackets.');
      const patch: Partial<PayItem> = {};
      for (const [k, v] of Object.entries(input))
        if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      if (existing.type !== 'EARNING') delete patch.taxable;
      const [updated] = await tx.update(payItems).set(patch).where(eq(payItems.id, id)).returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PayItem',
          entityId: id,
          previousValue: previous,
          newValue: next,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return updated!;
    });
  }

  private async assertAccounts(tx: DbExecutor, companyId: string, ...ids: Array<string | null>) {
    for (const id of ids) {
      if (!id) continue;
      const [a] = await tx
        .select({ id: accounts.id, isHeader: accounts.isHeader, status: accounts.status })
        .from(accounts)
        .where(and(eq(accounts.companyId, companyId), eq(accounts.id, id)));
      if (!a) throw new NotFoundError('Account', id);
      if (a.isHeader || a.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.PAY_ITEM_INVALID,
          'Pay items must post to active detail accounts.',
        );
    }
  }
}
