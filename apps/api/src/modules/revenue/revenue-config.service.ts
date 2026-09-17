import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type {
  CreateRevenuePolicyInput,
  UpdateRevenuePolicyInput,
  UpdateRevenueSettingsInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  products,
  revenuePolicies,
  revenueSettings,
  type RevenuePolicy,
  type RevenueSettings,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'REVENUE';

/**
 * Revenue recognition policy is data (Prompt #10): per-company policies
 * (method + default term) and the settings row that says whether the
 * month-end job posts by itself and which policy applies by default. An
 * invoice line's policy is resolved line -> product -> company default;
 * no policy (or POINT_IN_TIME) means the invoice earns the revenue when it
 * posts, exactly as before.
 */
@Injectable()
export class RevenueConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ----------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<RevenueSettings> {
    const [row] = await executor
      .select()
      .from(revenueSettings)
      .where(eq(revenueSettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(revenueSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(revenueSettings)
      .where(eq(revenueSettings.companyId, companyId));
    return again!;
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: UpdateRevenueSettingsInput,
  ): Promise<RevenueSettings> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      if (input.defaultPolicyId) await this.getPolicy(companyId, input.defaultPolicyId, tx);
      const patch: Partial<RevenueSettings> = {};
      if (input.autoRecognize !== undefined) patch.autoRecognize = input.autoRecognize;
      if (input.overdueGraceDays !== undefined) patch.overdueGraceDays = input.overdueGraceDays;
      if (input.defaultPolicyId !== undefined) patch.defaultPolicyId = input.defaultPolicyId;
      const [updated] = await tx
        .update(revenueSettings)
        .set(patch)
        .where(eq(revenueSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'RevenueSettings',
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

  // ----------------------------------------------------------------- policies

  async listPolicies(companyId: string, executor: DbExecutor = this.db): Promise<RevenuePolicy[]> {
    return executor
      .select()
      .from(revenuePolicies)
      .where(eq(revenuePolicies.companyId, companyId))
      .orderBy(asc(revenuePolicies.code));
  }

  async getPolicy(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<RevenuePolicy> {
    const [row] = await executor
      .select()
      .from(revenuePolicies)
      .where(and(eq(revenuePolicies.id, id), eq(revenuePolicies.companyId, companyId)));
    if (!row) throw new NotFoundError('Revenue policy', id);
    return row;
  }

  async createPolicy(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateRevenuePolicyInput,
  ): Promise<RevenuePolicy> {
    return this.db.transaction(async (tx) => {
      const [clash] = await tx
        .select({ id: revenuePolicies.id })
        .from(revenuePolicies)
        .where(and(eq(revenuePolicies.companyId, companyId), eq(revenuePolicies.code, input.code)));
      if (clash) throw new DuplicateError('Revenue policy', 'code', input.code);
      const [created] = await tx
        .insert(revenuePolicies)
        .values({
          companyId,
          code: input.code,
          name: input.name,
          method: input.method,
          description: input.description ?? null,
          defaultTermMonths: input.method === 'RATABLE' ? (input.defaultTermMonths ?? null) : null,
          autoRecognize: input.autoRecognize,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'RevenuePolicy',
          entityId: created!.id,
          newValue: { code: created!.code, method: created!.method },
          companyId,
        },
        tx,
      );
      return created!;
    });
  }

  async updatePolicy(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateRevenuePolicyInput,
  ): Promise<RevenuePolicy> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getPolicy(companyId, id, tx);
      if (input.defaultTermMonths && existing.method !== 'RATABLE')
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Only ratable policies carry a default term.',
        );
      const patch: Partial<RevenuePolicy> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description ?? null;
      if (input.defaultTermMonths !== undefined) patch.defaultTermMonths = input.defaultTermMonths;
      if (input.autoRecognize !== undefined) patch.autoRecognize = input.autoRecognize;
      if (input.status !== undefined) patch.status = input.status;
      const [updated] = await tx
        .update(revenuePolicies)
        .set(patch)
        .where(eq(revenuePolicies.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'RevenuePolicy',
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

  // --------------------------------------------------------------- resolution

  /**
   * Policy for each invoice line: the line's explicit policy, else the
   * product's, else the company default. Returns null where the line earns
   * its revenue at posting. Inactive policies are refused on explicit use.
   */
  async resolveLinePolicies(
    tx: DbExecutor,
    companyId: string,
    lines: ReadonlyArray<{ id: string; revenuePolicyId: string | null; productId: string | null }>,
  ): Promise<Map<string, RevenuePolicy>> {
    const result = new Map<string, RevenuePolicy>();
    if (lines.length === 0) return result;
    const settings = await this.settings(companyId, tx);
    const productIds = [...new Set(lines.map((l) => l.productId).filter(Boolean))] as string[];
    const productPolicy = new Map<string, string | null>();
    if (productIds.length > 0) {
      const rows = await tx
        .select({ id: products.id, policyId: products.revenuePolicyId })
        .from(products)
        .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)));
      for (const r of rows) productPolicy.set(r.id, r.policyId);
    }
    const wanted = new Map<string, string>();
    for (const line of lines) {
      const policyId =
        line.revenuePolicyId ??
        (line.productId ? productPolicy.get(line.productId) : null) ??
        settings.defaultPolicyId;
      if (policyId) wanted.set(line.id, policyId);
    }
    if (wanted.size === 0) return result;
    const policies = await tx
      .select()
      .from(revenuePolicies)
      .where(
        and(
          eq(revenuePolicies.companyId, companyId),
          inArray(revenuePolicies.id, [...new Set(wanted.values())]),
        ),
      );
    const byId = new Map(policies.map((p) => [p.id, p]));
    for (const [lineId, policyId] of wanted) {
      const policy = byId.get(policyId);
      if (!policy) throw new NotFoundError('Revenue policy', policyId);
      const line = lines.find((l) => l.id === lineId)!;
      if (policy.status !== 'ACTIVE' && line.revenuePolicyId === policyId)
        throw new BusinessRuleError(
          ErrorCodes.REVENUE_SCHEDULE_INVALID,
          `Revenue policy ${policy.code} is inactive.`,
        );
      if (policy.status === 'ACTIVE' && policy.method !== 'POINT_IN_TIME')
        result.set(lineId, policy);
    }
    return result;
  }
}
