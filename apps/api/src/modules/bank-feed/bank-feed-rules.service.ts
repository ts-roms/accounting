import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  CreateBankMatchingRuleInput,
  TestBankMatchingRuleInput,
  UpdateBankFeedSettingsInput,
  UpdateBankMatchingRuleInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  bankAccounts,
  bankFeedSettings,
  bankMatchingRules,
  bankStatementLines,
  bankStatements,
  customers,
  vendors,
  type BankFeedSettings,
  type BankMatchingRule,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { ruleMatches, type FeedLine, type RuleDef } from './bank-feed.logic';

const MODULE = 'BANK_FEED';

export interface BankMatchingRuleView extends BankMatchingRule {
  bankAccountCode: string | null;
  counterpartyAccountCode: string | null;
  partyName: string | null;
}

/**
 * Bank feed policy is data (Prompt #12): matching rules (what a feed line
 * looks like -> what explains it) and the company settings that say what
 * may post without a person confirming.
 */
@Injectable()
export class BankFeedRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<BankFeedSettings> {
    const [row] = await executor
      .select()
      .from(bankFeedSettings)
      .where(eq(bankFeedSettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(bankFeedSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(bankFeedSettings)
      .where(eq(bankFeedSettings.companyId, companyId));
    return again!;
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: UpdateBankFeedSettingsInput,
  ): Promise<BankFeedSettings> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      const patch: Partial<BankFeedSettings> = {};
      for (const [k, v] of Object.entries(input))
        if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      const [updated] = await tx
        .update(bankFeedSettings)
        .set(patch)
        .where(eq(bankFeedSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankFeedSettings',
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

  // -------------------------------------------------------------------- rules

  async list(companyId: string, executor: DbExecutor = this.db): Promise<BankMatchingRuleView[]> {
    const rows = await executor
      .select({
        rule: bankMatchingRules,
        bankAccountCode: bankAccounts.code,
        counterpartyAccountCode: accounts.code,
      })
      .from(bankMatchingRules)
      .leftJoin(bankAccounts, eq(bankAccounts.id, bankMatchingRules.bankAccountId))
      .leftJoin(accounts, eq(accounts.id, bankMatchingRules.counterpartyAccountId))
      .where(eq(bankMatchingRules.companyId, companyId))
      .orderBy(asc(bankMatchingRules.priority), asc(bankMatchingRules.name));
    const partyNames = await this.partyNames(
      executor,
      companyId,
      rows.map((r) => r.rule),
    );
    return rows.map((r) => ({
      ...r.rule,
      bankAccountCode: r.bankAccountCode,
      counterpartyAccountCode: r.counterpartyAccountCode,
      partyName: r.rule.partyId ? (partyNames.get(r.rule.partyId) ?? null) : null,
    }));
  }

  /** Active rules as the engine sees them. */
  async activeRules(companyId: string, executor: DbExecutor = this.db): Promise<RuleDef[]> {
    const rows = await executor
      .select()
      .from(bankMatchingRules)
      .where(
        and(eq(bankMatchingRules.companyId, companyId), eq(bankMatchingRules.status, 'ACTIVE')),
      )
      .orderBy(asc(bankMatchingRules.priority));
    return rows.map(toDef);
  }

  async get(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<BankMatchingRule> {
    const [row] = await executor
      .select()
      .from(bankMatchingRules)
      .where(and(eq(bankMatchingRules.companyId, companyId), eq(bankMatchingRules.id, id)));
    if (!row) throw new NotFoundError('Bank matching rule', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBankMatchingRuleInput,
  ): Promise<BankMatchingRuleView> {
    const id = await this.db.transaction(async (tx) => {
      await this.assertTargets(tx, companyId, input);
      const [created] = await tx
        .insert(bankMatchingRules)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          priority: input.priority,
          bankAccountId: input.bankAccountId ?? null,
          direction: input.direction,
          descriptionPattern: input.descriptionPattern ?? null,
          descriptionMode: input.descriptionMode,
          referencePattern: input.referencePattern ?? null,
          referenceMode: input.referenceMode,
          amountMin: input.amountMin ?? null,
          amountMax: input.amountMax ?? null,
          action: input.action,
          transactionType:
            input.action === 'POST_TRANSACTION' ? (input.transactionType ?? null) : null,
          counterpartyAccountId:
            input.action === 'POST_TRANSACTION' ? (input.counterpartyAccountId ?? null) : null,
          partyId:
            input.action === 'RECEIVE_CUSTOMER' || input.action === 'PAY_VENDOR'
              ? (input.partyId ?? null)
              : null,
          memo: input.memo ?? null,
          departmentId: input.departmentId ?? null,
          costCenterId: input.costCenterId ?? null,
          projectId: input.projectId ?? null,
          autoApply: input.autoApply,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BankMatchingRule',
          entityId: created!.id,
          newValue: {
            name: input.name,
            action: input.action,
            autoApply: input.autoApply,
            priority: input.priority,
          },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return (await this.list(companyId)).find((r) => r.id === id)!;
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBankMatchingRuleInput,
  ): Promise<BankMatchingRuleView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.get(companyId, id, tx);
      const merged = { ...existing, ...input };
      await this.assertTargets(tx, companyId, merged as CreateBankMatchingRuleInput);
      const patch: Partial<BankMatchingRule> = {};
      for (const [k, v] of Object.entries(input))
        if (v !== undefined) (patch as Record<string, unknown>)[k] = v;
      const [updated] = await tx
        .update(bankMatchingRules)
        .set(patch)
        .where(eq(bankMatchingRules.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankMatchingRule',
          entityId: id,
          previousValue: previous,
          newValue: next,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return (await this.list(companyId)).find((r) => r.id === id)!;
  }

  async remove(companyId: string, actor: AuthenticatedUser, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.get(companyId, id, tx);
      await tx.delete(bankMatchingRules).where(eq(bankMatchingRules.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'BankMatchingRule',
          entityId: id,
          previousValue: { name: existing.name, hitCount: existing.hitCount },
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
    });
  }

  /** Dry run: which unexplained lines of the open statements a (draft) rule would match. */
  async test(
    companyId: string,
    input: TestBankMatchingRuleInput,
  ): Promise<{
    matched: number;
    total: number;
    lines: Array<FeedLine & { statementNumber: string }>;
  }> {
    const currency =
      (
        await this.db
          .select({ c: bankAccounts.currency })
          .from(bankAccounts)
          .where(eq(bankAccounts.companyId, companyId))
          .limit(1)
      )[0]?.c ?? 'PHP';
    const rows = await this.db
      .select({
        line: bankStatementLines,
        bankAccountId: bankStatements.bankAccountId,
        statementNumber: bankStatements.statementNumber,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .where(
        and(
          eq(bankStatements.companyId, companyId),
          eq(bankStatements.status, 'OPEN'),
          inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
        ),
      );
    const def: RuleDef = {
      id: 'test',
      name: input.name ?? 'test',
      priority: input.priority ?? 100,
      bankAccountId: input.bankAccountId ?? null,
      direction: input.direction,
      descriptionPattern: input.descriptionPattern ?? null,
      descriptionMode: input.descriptionMode,
      referencePattern: input.referencePattern ?? null,
      referenceMode: input.referenceMode,
      amountMin: input.amountMin ?? null,
      amountMax: input.amountMax ?? null,
      action: input.action ?? 'IGNORE',
      transactionType: input.transactionType ?? null,
      counterpartyAccountId: input.counterpartyAccountId ?? null,
      partyId: input.partyId ?? null,
      memo: input.memo ?? null,
      departmentId: input.departmentId ?? null,
      costCenterId: input.costCenterId ?? null,
      projectId: input.projectId ?? null,
      autoApply: input.autoApply ?? false,
    };
    const lines = rows.map((r) => ({
      id: r.line.id,
      bankAccountId: r.bankAccountId,
      lineDate: r.line.lineDate,
      amount: r.line.amount,
      description: r.line.description,
      reference: r.line.reference,
      statementNumber: r.statementNumber,
    }));
    const matched = lines.filter((l) => ruleMatches(def, l, currency));
    return { matched: matched.length, total: lines.length, lines: matched.slice(0, 50) };
  }

  // ---------------------------------------------------------------- internals

  private async assertTargets(
    tx: DbExecutor,
    companyId: string,
    input: Pick<
      CreateBankMatchingRuleInput,
      'action' | 'bankAccountId' | 'counterpartyAccountId' | 'partyId'
    >,
  ) {
    if (input.bankAccountId) {
      const [b] = await tx
        .select({ id: bankAccounts.id })
        .from(bankAccounts)
        .where(
          and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.id, input.bankAccountId)),
        );
      if (!b) throw new NotFoundError('Bank account', input.bankAccountId);
    }
    if (input.action === 'POST_TRANSACTION') {
      if (!input.counterpartyAccountId)
        throw new BusinessRuleError(
          ErrorCodes.BANK_RULE_INVALID,
          'Choose the counterparty account.',
        );
      const [a] = await tx
        .select({ id: accounts.id, isHeader: accounts.isHeader, status: accounts.status })
        .from(accounts)
        .where(
          and(eq(accounts.companyId, companyId), eq(accounts.id, input.counterpartyAccountId)),
        );
      if (!a) throw new NotFoundError('Account', input.counterpartyAccountId);
      if (a.isHeader || a.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.BANK_RULE_INVALID,
          'The counterparty must be an active detail account.',
        );
    }
    if (input.action === 'RECEIVE_CUSTOMER') {
      if (!input.partyId)
        throw new BusinessRuleError(ErrorCodes.BANK_RULE_INVALID, 'Choose the customer.');
      const [c] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.companyId, companyId), eq(customers.id, input.partyId)));
      if (!c) throw new NotFoundError('Customer', input.partyId);
    }
    if (input.action === 'PAY_VENDOR') {
      if (!input.partyId)
        throw new BusinessRuleError(ErrorCodes.BANK_RULE_INVALID, 'Choose the vendor.');
      const [v] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.companyId, companyId), eq(vendors.id, input.partyId)));
      if (!v) throw new NotFoundError('Vendor', input.partyId);
    }
  }

  private async partyNames(
    executor: DbExecutor,
    companyId: string,
    rules: BankMatchingRule[],
  ): Promise<Map<string, string>> {
    const ids = [...new Set(rules.map((r) => r.partyId).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (ids.length === 0) return names;
    for (const r of await executor
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.companyId, companyId), inArray(customers.id, ids))))
      names.set(r.id, r.name);
    for (const r of await executor
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), inArray(vendors.id, ids))))
      names.set(r.id, r.name);
    return names;
  }
}

export function toDef(r: BankMatchingRule): RuleDef {
  return {
    id: r.id,
    name: r.name,
    priority: r.priority,
    bankAccountId: r.bankAccountId,
    direction: r.direction,
    descriptionPattern: r.descriptionPattern,
    descriptionMode: r.descriptionMode,
    referencePattern: r.referencePattern,
    referenceMode: r.referenceMode,
    amountMin: r.amountMin,
    amountMax: r.amountMax,
    action: r.action,
    transactionType: r.transactionType,
    counterpartyAccountId: r.counterpartyAccountId,
    partyId: r.partyId,
    memo: r.memo,
    departmentId: r.departmentId,
    costCenterId: r.costCenterId,
    projectId: r.projectId,
    autoApply: r.autoApply,
  };
}
