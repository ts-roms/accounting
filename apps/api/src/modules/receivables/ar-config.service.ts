import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DEFAULT_AGING_BUCKETS, type AgingBucketDefinition } from '@accounting/types';
import type {
  ArSettingsInput,
  CreateCreditRuleInput,
  CreateCustomerGroupInput,
  CreateDunningPolicyInput,
  CreatePaymentTermInput,
  UpdateCreditRuleInput,
  UpdateCustomerGroupInput,
  UpdateDunningPolicyInput,
  UpdatePaymentTermInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  arSettings,
  creditRules,
  customerGroups,
  dunningPolicies,
  paymentTerms,
  type ArSettings,
  type CreditRule,
  type CustomerGroup,
  type DunningPolicy,
  type PaymentTerm,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'RECEIVABLES';

/**
 * AR configuration: payment terms, customer groups, credit rules, dunning
 * policies and the per-company settings row (aging buckets, DSO window,
 * approval / allowance policies). Business logic reads policy from here and
 * never hard-codes it.
 */
@Injectable()
export class ArConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<ArSettings> {
    const [row] = await executor
      .select()
      .from(arSettings)
      .where(eq(arSettings.companyId, companyId));
    if (row) return row;
    // Defaults are the table defaults; materialise the row so later updates are plain UPDATEs.
    const [created] = await executor
      .insert(arSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(arSettings)
      .where(eq(arSettings.companyId, companyId));
    return again!;
  }

  async agingBuckets(
    companyId: string,
    executor: DbExecutor = this.db,
  ): Promise<AgingBucketDefinition[]> {
    const s = await this.settings(companyId, executor);
    return s.agingBuckets.length ? s.agingBuckets : [...DEFAULT_AGING_BUCKETS];
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: ArSettingsInput,
  ): Promise<ArSettings> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      if (input.defaultDunningPolicyId)
        await this.dunningPolicy(companyId, input.defaultDunningPolicyId, tx);
      if (input.defaultPaymentTermId)
        await this.paymentTerm(companyId, input.defaultPaymentTermId, tx);
      const [updated] = await tx
        .update(arSettings)
        .set(definedOnly(input))
        .where(eq(arSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ArSettings',
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

  // ------------------------------------------------------------ payment terms

  async listPaymentTerms(companyId: string): Promise<PaymentTerm[]> {
    return this.db
      .select()
      .from(paymentTerms)
      .where(eq(paymentTerms.companyId, companyId))
      .orderBy(asc(paymentTerms.days), asc(paymentTerms.code));
  }

  async paymentTerm(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<PaymentTerm> {
    const [row] = await executor
      .select()
      .from(paymentTerms)
      .where(and(eq(paymentTerms.id, id), eq(paymentTerms.companyId, companyId)));
    if (!row) throw new NotFoundError('Payment term', id);
    return row;
  }

  async createPaymentTerm(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreatePaymentTermInput,
  ): Promise<PaymentTerm> {
    return this.db.transaction(async (tx) => {
      let created: PaymentTerm | undefined;
      try {
        [created] = await tx
          .insert(paymentTerms)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            basis: input.basis,
            days: input.days,
            dayOfMonth: input.dayOfMonth ?? null,
            discountPercent: input.discountPercent,
            discountDays: input.discountDays,
            description: input.description ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'payment_terms_company_code_uq'))
          throw new DuplicateError('Payment term', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PaymentTerm',
          entityId: created!.id,
          newValue: created,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updatePaymentTerm(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdatePaymentTermInput,
  ): Promise<PaymentTerm> {
    return this.db.transaction(async (tx) => {
      const existing = await this.paymentTerm(companyId, id, tx);
      const [updated] = await tx
        .update(paymentTerms)
        .set(definedOnly(input))
        .where(eq(paymentTerms.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PaymentTerm',
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

  // ---------------------------------------------------------- customer groups

  async listCustomerGroups(companyId: string): Promise<CustomerGroup[]> {
    return this.db
      .select()
      .from(customerGroups)
      .where(eq(customerGroups.companyId, companyId))
      .orderBy(asc(customerGroups.code));
  }

  async customerGroup(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<CustomerGroup> {
    const [row] = await executor
      .select()
      .from(customerGroups)
      .where(and(eq(customerGroups.id, id), eq(customerGroups.companyId, companyId)));
    if (!row) throw new NotFoundError('Customer group', id);
    return row;
  }

  async createCustomerGroup(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateCustomerGroupInput,
  ): Promise<CustomerGroup> {
    return this.db.transaction(async (tx) => {
      if (input.paymentTermId) await this.paymentTerm(companyId, input.paymentTermId, tx);
      if (input.dunningPolicyId) await this.dunningPolicy(companyId, input.dunningPolicyId, tx);
      let created: CustomerGroup | undefined;
      try {
        [created] = await tx
          .insert(customerGroups)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            paymentTermId: input.paymentTermId ?? null,
            defaultCreditLimit: input.defaultCreditLimit ?? null,
            taxCodeId: input.taxCodeId ?? null,
            priceDiscountPercent: input.priceDiscountPercent,
            dunningPolicyId: input.dunningPolicyId ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'customer_groups_company_code_uq'))
          throw new DuplicateError('Customer group', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'CustomerGroup',
          entityId: created!.id,
          newValue: created,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updateCustomerGroup(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateCustomerGroupInput,
  ): Promise<CustomerGroup> {
    return this.db.transaction(async (tx) => {
      const existing = await this.customerGroup(companyId, id, tx);
      if (input.paymentTermId) await this.paymentTerm(companyId, input.paymentTermId, tx);
      if (input.dunningPolicyId) await this.dunningPolicy(companyId, input.dunningPolicyId, tx);
      const [updated] = await tx
        .update(customerGroups)
        .set(definedOnly(input))
        .where(eq(customerGroups.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CustomerGroup',
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

  // -------------------------------------------------------------- credit rules

  async listCreditRules(companyId: string): Promise<CreditRule[]> {
    return this.db
      .select()
      .from(creditRules)
      .where(eq(creditRules.companyId, companyId))
      .orderBy(asc(creditRules.scope), asc(creditRules.priority));
  }

  /** Active rules only - what the credit check evaluates. */
  async activeCreditRules(
    companyId: string,
    executor: DbExecutor = this.db,
  ): Promise<CreditRule[]> {
    return executor
      .select()
      .from(creditRules)
      .where(and(eq(creditRules.companyId, companyId), eq(creditRules.status, 'ACTIVE')))
      .orderBy(asc(creditRules.priority));
  }

  async creditRule(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<CreditRule> {
    const [row] = await executor
      .select()
      .from(creditRules)
      .where(and(eq(creditRules.id, id), eq(creditRules.companyId, companyId)));
    if (!row) throw new NotFoundError('Credit rule', id);
    return row;
  }

  async createCreditRule(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateCreditRuleInput,
  ): Promise<CreditRule> {
    return this.db.transaction(async (tx) => {
      if (input.customerGroupId) await this.customerGroup(companyId, input.customerGroupId, tx);
      const [created] = await tx
        .insert(creditRules)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          scope: input.scope,
          trigger: input.trigger,
          action: input.action,
          thresholdAmount: input.thresholdAmount ?? null,
          thresholdPercent: input.thresholdPercent ?? null,
          thresholdDays: input.thresholdDays ?? null,
          customerGroupId: input.customerGroupId ?? null,
          priority: input.priority,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'CreditRule',
          entityId: created!.id,
          newValue: created,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updateCreditRule(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateCreditRuleInput,
  ): Promise<CreditRule> {
    return this.db.transaction(async (tx) => {
      const existing = await this.creditRule(companyId, id, tx);
      if (input.customerGroupId) await this.customerGroup(companyId, input.customerGroupId, tx);
      const [updated] = await tx
        .update(creditRules)
        .set(definedOnly(input))
        .where(eq(creditRules.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'CreditRule',
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

  // ----------------------------------------------------------- dunning policy

  async listDunningPolicies(companyId: string): Promise<DunningPolicy[]> {
    return this.db
      .select()
      .from(dunningPolicies)
      .where(eq(dunningPolicies.companyId, companyId))
      .orderBy(asc(dunningPolicies.name));
  }

  async dunningPolicy(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<DunningPolicy> {
    const [row] = await executor
      .select()
      .from(dunningPolicies)
      .where(and(eq(dunningPolicies.id, id), eq(dunningPolicies.companyId, companyId)));
    if (!row) throw new NotFoundError('Dunning policy', id);
    return row;
  }

  async createDunningPolicy(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateDunningPolicyInput,
  ): Promise<DunningPolicy> {
    return this.db.transaction(async (tx) => {
      if (input.isDefault)
        await tx
          .update(dunningPolicies)
          .set({ isDefault: false })
          .where(eq(dunningPolicies.companyId, companyId));
      const [created] = await tx
        .insert(dunningPolicies)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          steps: input.steps,
          minimumAmount: input.minimumAmount,
          isDefault: input.isDefault,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'DunningPolicy',
          entityId: created!.id,
          newValue: created,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updateDunningPolicy(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDunningPolicyInput,
  ): Promise<DunningPolicy> {
    return this.db.transaction(async (tx) => {
      const existing = await this.dunningPolicy(companyId, id, tx);
      if (input.isDefault)
        await tx
          .update(dunningPolicies)
          .set({ isDefault: false })
          .where(eq(dunningPolicies.companyId, companyId));
      const [updated] = await tx
        .update(dunningPolicies)
        .set(definedOnly(input))
        .where(eq(dunningPolicies.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'DunningPolicy',
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
}

function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
