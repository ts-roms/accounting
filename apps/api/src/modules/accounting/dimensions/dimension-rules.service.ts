import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type {
  DimensionRefs,
  DimensionRuleInput,
  UpdateDimensionRuleInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { accounts, dimensionRules, type DimensionRule } from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { findDimensionRuleViolations, type RuleAccount } from './dimension-rules.logic';

const MODULE = 'ACCOUNTING';

export interface DimensionRuleView extends DimensionRule {
  accountCode: string | null;
}

/**
 * "Account X requires dimension Y" rules. The posting engine calls
 * `assertLines` before any ledger row is written; the integrity checker runs
 * the same matcher over posted lines.
 */
@Injectable()
export class DimensionRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(companyId: string): Promise<DimensionRuleView[]> {
    return this.db
      .select({
        id: dimensionRules.id,
        companyId: dimensionRules.companyId,
        name: dimensionRules.name,
        scope: dimensionRules.scope,
        accountId: dimensionRules.accountId,
        accountType: dimensionRules.accountType,
        codePrefix: dimensionRules.codePrefix,
        dimensionType: dimensionRules.dimensionType,
        status: dimensionRules.status,
        createdAt: dimensionRules.createdAt,
        updatedAt: dimensionRules.updatedAt,
        accountCode: accounts.code,
      })
      .from(dimensionRules)
      .leftJoin(accounts, eq(accounts.id, dimensionRules.accountId))
      .where(eq(dimensionRules.companyId, companyId))
      .orderBy(asc(dimensionRules.name));
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: DimensionRuleInput,
  ): Promise<DimensionRuleView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.scope === 'ACCOUNT') {
        const [account] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.id, input.accountId!), eq(accounts.companyId, companyId)));
        if (!account) throw new NotFoundError('Account', input.accountId!);
      }
      const [row] = await tx
        .insert(dimensionRules)
        .values({
          companyId,
          name: input.name,
          scope: input.scope,
          accountId: input.scope === 'ACCOUNT' ? input.accountId : null,
          accountType: input.scope === 'ACCOUNT_TYPE' ? input.accountType : null,
          codePrefix: input.scope === 'CODE_PREFIX' ? input.codePrefix : null,
          dimensionType: input.dimensionType,
          status: input.status,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'DimensionRule',
          entityId: row.id,
          newValue: input,
          companyId,
          userId: actor.id,
        },
        tx,
      );
      return row.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateDimensionRuleInput,
  ): Promise<DimensionRuleView> {
    await this.db.transaction(async (tx) => {
      const before = await this.get(companyId, id, tx);
      await tx
        .update(dimensionRules)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(dimensionRules.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'DimensionRule',
          entityId: id,
          previousValue: { name: before.name, status: before.status },
          newValue: input,
          companyId,
          userId: actor.id,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async get(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<DimensionRuleView> {
    const [row] = await executor
      .select({
        id: dimensionRules.id,
        companyId: dimensionRules.companyId,
        name: dimensionRules.name,
        scope: dimensionRules.scope,
        accountId: dimensionRules.accountId,
        accountType: dimensionRules.accountType,
        codePrefix: dimensionRules.codePrefix,
        dimensionType: dimensionRules.dimensionType,
        status: dimensionRules.status,
        createdAt: dimensionRules.createdAt,
        updatedAt: dimensionRules.updatedAt,
        accountCode: accounts.code,
      })
      .from(dimensionRules)
      .leftJoin(accounts, eq(accounts.id, dimensionRules.accountId))
      .where(and(eq(dimensionRules.id, id), eq(dimensionRules.companyId, companyId)));
    if (!row) throw new NotFoundError('DimensionRule', id);
    return row;
  }

  async activeRules(companyId: string, executor: DbExecutor = this.db): Promise<DimensionRule[]> {
    return executor
      .select()
      .from(dimensionRules)
      .where(and(eq(dimensionRules.companyId, companyId), eq(dimensionRules.status, 'ACTIVE')));
  }

  /** Throws `DIMENSION_REQUIRED` when any line misses a dimension its account requires. */
  async assertLines(
    tx: DbExecutor,
    companyId: string,
    lines: readonly (DimensionRefs & { accountId: string })[],
    accountsById: ReadonlyMap<string, RuleAccount>,
  ): Promise<void> {
    const rules = await this.activeRules(companyId, tx);
    const violations = findDimensionRuleViolations(rules, lines, accountsById);
    if (violations.length === 0) return;
    const first = violations[0]!;
    throw new BusinessRuleError(
      ErrorCodes.DIMENSION_REQUIRED,
      `Line ${first.line}: account ${first.accountCode} requires a ${first.dimensionType.toLowerCase().replace('_', ' ')} (${first.ruleName}).`,
      { violations },
    );
  }
}
