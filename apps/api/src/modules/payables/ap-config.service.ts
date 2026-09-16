import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DEFAULT_AGING_BUCKETS, type AgingBucketDefinition } from '@accounting/types';
import type {
  ApSettingsInput,
  CreateVendorGroupInput,
  UpdateVendorGroupInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  apSettings,
  paymentTerms,
  taxCodes,
  vendorGroups,
  type ApSettingsRow,
  type PaymentTerm,
  type VendorGroup,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'PAYABLES';

/**
 * AP configuration (Prompt #7): vendor groups and the per-company settings
 * row (aging buckets, DPO window, cash-requirement horizons, approval and
 * duplicate policies). Payment terms are shared with AR (`payment_terms`).
 * Business logic reads policy from here and never hard-codes it.
 */
@Injectable()
export class ApConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<ApSettingsRow> {
    const [row] = await executor
      .select()
      .from(apSettings)
      .where(eq(apSettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(apSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(apSettings)
      .where(eq(apSettings.companyId, companyId));
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
    input: ApSettingsInput,
  ): Promise<ApSettingsRow> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      if (input.defaultPaymentTermId)
        await this.paymentTerm(companyId, input.defaultPaymentTermId, tx);
      if (input.defaultCashAccountId) await this.account(companyId, input.defaultCashAccountId, tx);
      const [updated] = await tx
        .update(apSettings)
        .set(definedOnly(input))
        .where(eq(apSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ApSettings',
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

  // ------------------------------------------------------------ vendor groups

  async listVendorGroups(companyId: string): Promise<VendorGroup[]> {
    return this.db
      .select()
      .from(vendorGroups)
      .where(eq(vendorGroups.companyId, companyId))
      .orderBy(asc(vendorGroups.code));
  }

  async vendorGroup(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<VendorGroup> {
    const [row] = await executor
      .select()
      .from(vendorGroups)
      .where(and(eq(vendorGroups.id, id), eq(vendorGroups.companyId, companyId)));
    if (!row) throw new NotFoundError('Vendor group', id);
    return row;
  }

  async createVendorGroup(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateVendorGroupInput,
  ): Promise<VendorGroup> {
    return this.db.transaction(async (tx) => {
      await this.assertRefs(companyId, input, tx);
      let created: VendorGroup | undefined;
      try {
        [created] = await tx
          .insert(vendorGroups)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            defaultPaymentTermId: input.defaultPaymentTermId ?? null,
            defaultWithholdingTaxCodeId: input.defaultWithholdingTaxCodeId ?? null,
            defaultExpenseAccountId: input.defaultExpenseAccountId ?? null,
            requireBillApproval: input.requireBillApproval,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'vendor_groups_company_code_uq'))
          throw new DuplicateError('Vendor group', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'VendorGroup',
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

  async updateVendorGroup(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateVendorGroupInput,
  ): Promise<VendorGroup> {
    return this.db.transaction(async (tx) => {
      const existing = await this.vendorGroup(companyId, id, tx);
      await this.assertRefs(companyId, input, tx);
      const [updated] = await tx
        .update(vendorGroups)
        .set(definedOnly(input))
        .where(eq(vendorGroups.id, id))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'VendorGroup',
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

  private async assertRefs(
    companyId: string,
    input: Partial<CreateVendorGroupInput>,
    tx: DbExecutor,
  ): Promise<void> {
    if (input.defaultPaymentTermId)
      await this.paymentTerm(companyId, input.defaultPaymentTermId, tx);
    if (input.defaultExpenseAccountId)
      await this.account(companyId, input.defaultExpenseAccountId, tx);
    if (input.defaultWithholdingTaxCodeId) {
      const [code] = await tx
        .select({ id: taxCodes.id })
        .from(taxCodes)
        .where(
          and(
            eq(taxCodes.id, input.defaultWithholdingTaxCodeId),
            eq(taxCodes.companyId, companyId),
          ),
        );
      if (!code) throw new NotFoundError('Tax code', input.defaultWithholdingTaxCodeId);
    }
  }

  private async account(companyId: string, id: string, tx: DbExecutor): Promise<void> {
    const [row] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.companyId, companyId)));
    if (!row) throw new NotFoundError('Account', id);
  }
}

function definedOnly<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
