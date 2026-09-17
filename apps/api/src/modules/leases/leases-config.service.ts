import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AccountMappingKey } from '@accounting/types';
import type { UpdateLeaseSettingsInput } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { leaseSettings, type Lease, type LeaseSettings } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'LEASES';

export interface ResolvedLeaseAccounts {
  rouAsset: string;
  rouAccumulated: string;
  liability: string;
  interestExpense: string;
  depreciationExpense: string;
  leaseExpense: string;
}

/**
 * Lease policy is data (Prompt #13): the exemption thresholds, the default
 * incremental borrowing rate and whether the month-end job posts runs by
 * itself. Accounts resolve lease override -> company mapping, never by id.
 */
@Injectable()
export class LeasesConfigService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async settings(companyId: string, executor: DbExecutor = this.db): Promise<LeaseSettings> {
    const [row] = await executor
      .select()
      .from(leaseSettings)
      .where(eq(leaseSettings.companyId, companyId));
    if (row) return row;
    const [created] = await executor
      .insert(leaseSettings)
      .values({ companyId })
      .onConflictDoNothing()
      .returning();
    if (created) return created;
    const [again] = await executor
      .select()
      .from(leaseSettings)
      .where(eq(leaseSettings.companyId, companyId));
    return again!;
  }

  async updateSettings(
    companyId: string,
    actor: AuthenticatedUser,
    input: UpdateLeaseSettingsInput,
  ): Promise<LeaseSettings> {
    return this.db.transaction(async (tx) => {
      const existing = await this.settings(companyId, tx);
      const patch: Partial<LeaseSettings> = {};
      if (input.shortTermThresholdMonths !== undefined)
        patch.shortTermThresholdMonths = input.shortTermThresholdMonths;
      if (input.lowValueThreshold !== undefined) patch.lowValueThreshold = input.lowValueThreshold;
      if (input.autoPostRuns !== undefined) patch.autoPostRuns = input.autoPostRuns;
      if (input.defaultDiscountRate !== undefined)
        patch.defaultDiscountRate = input.defaultDiscountRate;
      const [updated] = await tx
        .update(leaseSettings)
        .set(patch)
        .where(eq(leaseSettings.companyId, companyId))
        .returning();
      const { previous, next } = shallowDiff(existing, updated!);
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'LeaseSettings',
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

  /** Lease override first, then the company mapping. */
  async resolveAccounts(
    companyId: string,
    lease: Pick<
      Lease,
      | 'rouAssetAccountId'
      | 'rouAccumulatedAccountId'
      | 'liabilityAccountId'
      | 'interestExpenseAccountId'
      | 'depreciationExpenseAccountId'
      | 'leaseExpenseAccountId'
    >,
    tx: DbExecutor,
  ): Promise<ResolvedLeaseAccounts> {
    const mapped = async (key: AccountMappingKey) =>
      (await this.accounts.resolveMapped(companyId, key, tx)).id;
    return {
      rouAsset: lease.rouAssetAccountId ?? (await mapped('RIGHT_OF_USE_ASSET')),
      rouAccumulated:
        lease.rouAccumulatedAccountId ?? (await mapped('ROU_ACCUMULATED_DEPRECIATION')),
      liability: lease.liabilityAccountId ?? (await mapped('LEASE_LIABILITY')),
      interestExpense: lease.interestExpenseAccountId ?? (await mapped('LEASE_INTEREST_EXPENSE')),
      depreciationExpense:
        lease.depreciationExpenseAccountId ?? (await mapped('DEPRECIATION_EXPENSE')),
      leaseExpense: lease.leaseExpenseAccountId ?? (await mapped('LEASE_EXPENSE')),
    };
  }

  /** Account overrides must exist, be active and postable. */
  async assertAccounts(
    companyId: string,
    ids: Array<string | null | undefined>,
    tx: DbExecutor,
  ): Promise<void> {
    const wanted = [...new Set(ids.filter((x): x is string => Boolean(x)))];
    if (wanted.length === 0) return;
    const rows = await this.accounts.findByIds(companyId, wanted, tx);
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const id of wanted) {
      const account = byId.get(id);
      if (!account)
        throw new BusinessRuleError(ErrorCodes.NOT_FOUND, 'An account override does not exist.');
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be used for postings.`,
        );
    }
  }
}
