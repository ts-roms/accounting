import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { BankAccountProfileInput, TreasurySettingsInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { NotFoundError } from '@/common/errors/app-error';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccountProfiles,
  bankAccounts,
  treasurySettings,
  type BankAccountProfile,
  type TreasurySettingsRow,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'TREASURY';

/**
 * Treasury policy (Prompt #8): the per-company settings row (forecast
 * horizon, collection probabilities, scenarios, liquidity floor, transfer
 * approval threshold, default payment file format) and the treasury profile
 * of each bank account (type, minimum / target balance, payment file
 * details). Business logic reads policy from here and never hard-codes it.
 */
@Injectable()
export class TreasuryConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<TreasurySettingsRow> {
    const [row] = await executor
      .select()
      .from(treasurySettings)
      .where(eq(treasurySettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(treasurySettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(treasurySettings)
      .where(eq(treasurySettings.companyId, companyId));
    return again!;
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: TreasurySettingsInput,
  ): Promise<TreasurySettingsRow> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      const patch = definedOnly(input) as Partial<TreasurySettingsRow>;
      if (input.scenarios)
        patch.scenarios = {
          ...existing.scenarios,
          ...(input.scenarios as TreasurySettingsRow['scenarios']),
        };
      if (input.collectionProbabilities)
        patch.collectionProbabilities = {
          ...existing.collectionProbabilities,
          ...input.collectionProbabilities,
        };
      const [updated] = await tx
        .update(treasurySettings)
        .set(patch)
        .where(eq(treasurySettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'TreasurySettings',
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

  /** Profile row for a bank account, created with defaults on first read. */
  async profile(
    companyId: string,
    bankAccountId: string,
    executor: DbExecutor = this.db,
  ): Promise<BankAccountProfile> {
    const [account] = await executor
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, companyId)));
    if (!account) throw new NotFoundError('Bank account', bankAccountId);
    const [row] = await executor
      .select()
      .from(bankAccountProfiles)
      .where(eq(bankAccountProfiles.bankAccountId, bankAccountId));
    if (row) return row;
    const [created] = await executor
      .insert(bankAccountProfiles)
      .values({ bankAccountId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(bankAccountProfiles)
      .where(eq(bankAccountProfiles.bankAccountId, bankAccountId));
    return again!;
  }

  /** All profiles of a company keyed by bank account (missing rows are not materialised). */
  async profiles(
    companyId: string,
    executor: DbExecutor = this.db,
  ): Promise<Map<string, BankAccountProfile>> {
    const rows = await executor
      .select({ profile: bankAccountProfiles })
      .from(bankAccountProfiles)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankAccountProfiles.bankAccountId))
      .where(eq(bankAccounts.companyId, companyId));
    return new Map(rows.map((r) => [r.profile.bankAccountId, r.profile]));
  }

  async updateProfile(
    companyId: string,
    actor: AuthenticatedUser,
    bankAccountId: string,
    input: BankAccountProfileInput,
  ): Promise<BankAccountProfile> {
    return this.db.transaction(async (tx) => {
      const existing = await this.profile(companyId, bankAccountId, tx);
      // Only one default receipts / payments account per company.
      if (input.isDefaultReceipts || input.isDefaultPayments) {
        const ids = (
          await tx
            .select({ id: bankAccounts.id })
            .from(bankAccounts)
            .where(eq(bankAccounts.companyId, companyId))
        ).map((r) => r.id);
        for (const id of ids) {
          if (id === bankAccountId) continue;
          await tx
            .update(bankAccountProfiles)
            .set({
              ...(input.isDefaultReceipts ? { isDefaultReceipts: false } : {}),
              ...(input.isDefaultPayments ? { isDefaultPayments: false } : {}),
            })
            .where(eq(bankAccountProfiles.bankAccountId, id));
        }
      }
      const [updated] = await tx
        .update(bankAccountProfiles)
        .set(definedOnly(input))
        .where(eq(bankAccountProfiles.bankAccountId, bankAccountId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankAccountProfile',
          entityId: bankAccountId,
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
