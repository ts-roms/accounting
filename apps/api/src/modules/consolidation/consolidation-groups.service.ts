import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { AccountMappingKey, ConsolidationGroupAccounts } from '@accounting/types';
import type {
  ConsolidationMemberInput,
  CreateConsolidationGroupInput,
  CreateEliminationRuleInput,
  UpdateConsolidationGroupInput,
  UpdateConsolidationMemberInput,
  UpdateEliminationRuleInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  consolidationGroupMembers,
  consolidationGroups,
  consolidationRuns,
  eliminationRules,
  type ConsolidationGroup,
  type ConsolidationGroupMember,
  type EliminationRule,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'CONSOLIDATION';

/** Mapping key behind each group account, resolved from the parent's chart when the group does not name a code. */
const ACCOUNT_KEYS: Record<keyof ConsolidationGroupAccounts, AccountMappingKey> = {
  cumulativeTranslationAdjustment: 'CUMULATIVE_TRANSLATION_ADJUSTMENT',
  nonControllingInterest: 'NON_CONTROLLING_INTEREST',
  goodwill: 'GOODWILL',
  retainedEarnings: 'RETAINED_EARNINGS',
  intercompanyDifference: 'INTERCOMPANY_DIFFERENCE',
  shareOfAssociateProfit: 'SHARE_OF_ASSOCIATE_PROFIT',
  investment: 'INVESTMENT_IN_SUBSIDIARIES',
};

export interface MemberView extends ConsolidationGroupMember {
  companyCode: string;
  companyName: string;
  currency: string;
  isParent: boolean;
}

export interface GroupView extends ConsolidationGroup {
  parentCompanyCode: string;
  parentCompanyName: string;
  members: MemberView[];
  rules: EliminationRule[];
  runCount: number;
}

/**
 * Group structure (Prompt #9): which entities consolidate, how (full /
 * proportional / equity, ownership, acquisition data), into which presentation
 * currency, and the elimination rules that run every consolidation. All of it
 * is data - the engine never hard-codes an account or a percentage.
 */
@Injectable()
export class ConsolidationGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async list(organizationId: string): Promise<GroupView[]> {
    const rows = await this.db
      .select()
      .from(consolidationGroups)
      .where(eq(consolidationGroups.organizationId, organizationId))
      .orderBy(asc(consolidationGroups.code));
    return Promise.all(rows.map((g) => this.decorate(g)));
  }

  async get(organizationId: string, id: string): Promise<GroupView> {
    return this.decorate(await this.load(this.db, organizationId, id));
  }

  async create(
    organizationId: string,
    actor: AuthenticatedUser,
    input: CreateConsolidationGroupInput,
  ): Promise<GroupView> {
    const id = await this.db.transaction(async (tx) => {
      const parent = await this.company(tx, organizationId, input.parentCompanyId);
      const groupAccounts = await this.resolveAccounts(parent.id, input.accounts ?? {}, tx);
      let row: ConsolidationGroup | undefined;
      try {
        [row] = await tx
          .insert(consolidationGroups)
          .values({
            organizationId,
            code: input.code,
            name: input.name,
            parentCompanyId: parent.id,
            presentationCurrency: input.presentationCurrency ?? parent.baseCurrency,
            translationMethod: input.translationMethod,
            intercompanyTolerance: input.intercompanyTolerance ?? '0',
            requirePeriodsClosed: input.requirePeriodsClosed,
            accounts: groupAccounts,
            notes: input.notes ?? null,
            createdBy: actor.id,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'consolidation_groups_org_code_uq'))
          throw new DuplicateError('Consolidation group', 'code', input.code);
        throw err;
      }
      // The parent is always a fully consolidated, 100% member.
      await tx
        .insert(consolidationGroupMembers)
        .values({
          groupId: row!.id,
          companyId: parent.id,
          method: 'FULL',
          ownershipPercent: '100',
          sortOrder: 0,
        });
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ConsolidationGroup',
          entityId: row!.id,
          newValue: { code: input.code, parent: parent.code, currency: row!.presentationCurrency },
          metadata: { editor: actor.email },
          organizationId,
          companyId: parent.id,
        },
        tx,
      );
      return row!.id;
    });
    return this.get(organizationId, id);
  }

  async update(
    organizationId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateConsolidationGroupInput,
  ): Promise<GroupView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.load(tx, organizationId, id);
      const patch: Partial<ConsolidationGroup> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.presentationCurrency !== undefined)
        patch.presentationCurrency = input.presentationCurrency;
      if (input.translationMethod !== undefined) patch.translationMethod = input.translationMethod;
      if (input.intercompanyTolerance !== undefined)
        patch.intercompanyTolerance = input.intercompanyTolerance;
      if (input.requirePeriodsClosed !== undefined)
        patch.requirePeriodsClosed = input.requirePeriodsClosed;
      if (input.status !== undefined) patch.status = input.status;
      if (input.notes !== undefined) patch.notes = input.notes ?? null;
      if (input.accounts)
        patch.accounts = await this.resolveAccounts(
          existing.parentCompanyId,
          { ...existing.accounts, ...input.accounts },
          tx,
        );
      const [row] = await tx
        .update(consolidationGroups)
        .set(patch)
        .where(eq(consolidationGroups.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ConsolidationGroup',
          entityId: id,
          previousValue: existing,
          newValue: row,
          metadata: { editor: actor.email },
          organizationId,
          companyId: existing.parentCompanyId,
        },
        tx,
      );
    });
    return this.get(organizationId, id);
  }

  // ------------------------------------------------------------------ members

  async addMember(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: ConsolidationMemberInput,
  ): Promise<GroupView> {
    await this.db.transaction(async (tx) => {
      const group = await this.load(tx, organizationId, groupId);
      const company = await this.company(tx, organizationId, input.companyId);
      if (company.id === group.parentCompanyId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The parent is already a member of its own group.',
        );
      await this.assertNoFinalizedRunAfter(tx, groupId, input.acquisitionDate ?? null);
      try {
        await tx.insert(consolidationGroupMembers).values({
          groupId,
          companyId: company.id,
          method: input.method,
          ownershipPercent: input.ownershipPercent,
          acquisitionDate: input.acquisitionDate ?? null,
          disposalDate: input.disposalDate ?? null,
          acquisitionEquity: input.acquisitionEquity ?? '0',
          investmentCost: input.investmentCost ?? '0',
          historicalRate: input.historicalRate ?? null,
          sortOrder: input.sortOrder ?? 10,
          notes: input.notes ?? null,
        });
      } catch (err) {
        if (isUniqueViolation(err, 'consolidation_group_members_uq'))
          throw new DuplicateError('Group member', 'company', company.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ConsolidationGroupMember',
          entityId: groupId,
          newValue: {
            company: company.code,
            method: input.method,
            ownershipPercent: input.ownershipPercent,
          },
          metadata: { editor: actor.email, group: group.code },
          organizationId,
          companyId: group.parentCompanyId,
        },
        tx,
      );
    });
    return this.get(organizationId, groupId);
  }

  async updateMember(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    memberId: string,
    input: UpdateConsolidationMemberInput,
  ): Promise<GroupView> {
    await this.db.transaction(async (tx) => {
      const group = await this.load(tx, organizationId, groupId);
      const [member] = await tx
        .select()
        .from(consolidationGroupMembers)
        .where(
          and(
            eq(consolidationGroupMembers.id, memberId),
            eq(consolidationGroupMembers.groupId, groupId),
          ),
        );
      if (!member) throw new NotFoundError('Group member', memberId);
      if (member.companyId === group.parentCompanyId && (input.method || input.ownershipPercent))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The parent is always fully consolidated at 100%.',
        );
      const patch: Partial<ConsolidationGroupMember> = {};
      for (const k of [
        'method',
        'ownershipPercent',
        'acquisitionDate',
        'disposalDate',
        'historicalRate',
        'sortOrder',
        'notes',
      ] as const)
        if (input[k] !== undefined) (patch as Record<string, unknown>)[k] = input[k];
      if (input.acquisitionEquity !== undefined)
        patch.acquisitionEquity = input.acquisitionEquity ?? '0';
      if (input.investmentCost !== undefined) patch.investmentCost = input.investmentCost ?? '0';
      const [row] = await tx
        .update(consolidationGroupMembers)
        .set(patch)
        .where(eq(consolidationGroupMembers.id, memberId))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ConsolidationGroupMember',
          entityId: memberId,
          previousValue: member,
          newValue: row,
          metadata: { editor: actor.email, group: group.code },
          organizationId,
          companyId: group.parentCompanyId,
        },
        tx,
      );
    });
    return this.get(organizationId, groupId);
  }

  async removeMember(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    memberId: string,
  ): Promise<GroupView> {
    await this.db.transaction(async (tx) => {
      const group = await this.load(tx, organizationId, groupId);
      const [member] = await tx
        .select()
        .from(consolidationGroupMembers)
        .where(
          and(
            eq(consolidationGroupMembers.id, memberId),
            eq(consolidationGroupMembers.groupId, groupId),
          ),
        );
      if (!member) throw new NotFoundError('Group member', memberId);
      if (member.companyId === group.parentCompanyId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The parent cannot leave its own group.',
        );
      await this.assertNoFinalizedRunAfter(tx, groupId, null);
      await tx.delete(consolidationGroupMembers).where(eq(consolidationGroupMembers.id, memberId));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ConsolidationGroupMember',
          entityId: memberId,
          previousValue: member,
          metadata: { editor: actor.email, group: group.code },
          organizationId,
          companyId: group.parentCompanyId,
        },
        tx,
      );
    });
    return this.get(organizationId, groupId);
  }

  // -------------------------------------------------------------------- rules

  async createRule(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: CreateEliminationRuleInput,
  ): Promise<EliminationRule> {
    return this.db.transaction(async (tx) => {
      const group = await this.load(tx, organizationId, groupId);
      let row: EliminationRule | undefined;
      try {
        [row] = await tx
          .insert(eliminationRules)
          .values({
            groupId,
            code: input.code,
            name: input.name,
            type: input.type,
            description: input.description ?? null,
            autoApply: input.autoApply,
            config: input.config,
            createdBy: actor.id,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'elimination_rules_group_code_uq'))
          throw new DuplicateError('Elimination rule', 'code', input.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'EliminationRule',
          entityId: row!.id,
          newValue: { code: input.code, type: input.type, config: input.config },
          metadata: { editor: actor.email, group: group.code },
          organizationId,
          companyId: group.parentCompanyId,
        },
        tx,
      );
      return row!;
    });
  }

  async updateRule(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    ruleId: string,
    input: UpdateEliminationRuleInput,
  ): Promise<EliminationRule> {
    return this.db.transaction(async (tx) => {
      const group = await this.load(tx, organizationId, groupId);
      const [existing] = await tx
        .select()
        .from(eliminationRules)
        .where(and(eq(eliminationRules.id, ruleId), eq(eliminationRules.groupId, groupId)));
      if (!existing) throw new NotFoundError('Elimination rule', ruleId);
      const patch: Partial<EliminationRule> = {};
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description ?? null;
      if (input.autoApply !== undefined) patch.autoApply = input.autoApply;
      if (input.active !== undefined) patch.active = input.active;
      if (input.config !== undefined) patch.config = { ...existing.config, ...input.config };
      const [row] = await tx
        .update(eliminationRules)
        .set(patch)
        .where(eq(eliminationRules.id, ruleId))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'EliminationRule',
          entityId: ruleId,
          previousValue: existing,
          newValue: row,
          metadata: { editor: actor.email, group: group.code },
          organizationId,
          companyId: group.parentCompanyId,
        },
        tx,
      );
      return row!;
    });
  }

  /** Default rule set for a new group: intercompany balances and the investment / NCI elimination. */
  async seedDefaultRules(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
  ): Promise<EliminationRule[]> {
    const existing = await this.db
      .select()
      .from(eliminationRules)
      .where(eq(eliminationRules.groupId, groupId));
    if (existing.length) return existing;
    const defaults: CreateEliminationRuleInput[] = [
      {
        code: 'IC-BALANCES',
        name: 'Intercompany receivables and payables',
        type: 'INTERCOMPANY_BALANCES',
        autoApply: true,
        config: {},
        description:
          'Eliminates every account flagged intercompany; the unmatched residual goes to the intercompany difference account.',
      },
      {
        code: 'INVESTMENT',
        name: 'Investment against subsidiary equity',
        type: 'INVESTMENT_EQUITY',
        autoApply: true,
        config: {},
        description:
          'Eliminates the parent investment against equity at acquisition, books goodwill and non-controlling interest, picks up equity-accounted results.',
      },
    ];
    const rows: EliminationRule[] = [];
    for (const d of defaults) rows.push(await this.createRule(organizationId, actor, groupId, d));
    return rows;
  }

  // ---------------------------------------------------------------- internals

  /** Resolve the group's posting codes: explicit code (must exist in the parent chart) or the parent's mapping. */
  async resolveAccounts(
    parentCompanyId: string,
    given: Partial<ConsolidationGroupAccounts>,
    tx: DbExecutor,
  ): Promise<ConsolidationGroupAccounts> {
    const out: Partial<ConsolidationGroupAccounts> = {};
    const missing: string[] = [];
    for (const key of Object.keys(ACCOUNT_KEYS) as Array<keyof ConsolidationGroupAccounts>) {
      const code = given[key];
      if (code) {
        const [acct] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.companyId, parentCompanyId), eq(accounts.code, code)));
        if (!acct)
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Account ${code} does not exist in the parent chart of accounts.`,
            { key, code },
          );
        out[key] = code;
        continue;
      }
      try {
        out[key] = (await this.accounts.resolveMapped(parentCompanyId, ACCOUNT_KEYS[key], tx)).code;
      } catch {
        missing.push(ACCOUNT_KEYS[key]);
      }
    }
    if (missing.length)
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_MAPPING_MISSING,
        `Map ${missing.join(', ')} in the parent chart of accounts or give the account codes explicitly.`,
        { missing },
      );
    return out as ConsolidationGroupAccounts;
  }

  async load(
    executor: DbExecutor,
    organizationId: string,
    id: string,
  ): Promise<ConsolidationGroup> {
    const [row] = await executor
      .select()
      .from(consolidationGroups)
      .where(
        and(eq(consolidationGroups.id, id), eq(consolidationGroups.organizationId, organizationId)),
      );
    if (!row) throw new NotFoundError('Consolidation group', id);
    return row;
  }

  async members(groupId: string, executor: DbExecutor = this.db): Promise<MemberView[]> {
    const [group] = await executor
      .select({ parentCompanyId: consolidationGroups.parentCompanyId })
      .from(consolidationGroups)
      .where(eq(consolidationGroups.id, groupId));
    const rows = await executor
      .select({
        member: consolidationGroupMembers,
        companyCode: companies.code,
        companyName: companies.name,
        currency: companies.baseCurrency,
      })
      .from(consolidationGroupMembers)
      .innerJoin(companies, eq(companies.id, consolidationGroupMembers.companyId))
      .where(eq(consolidationGroupMembers.groupId, groupId))
      .orderBy(asc(consolidationGroupMembers.sortOrder), asc(companies.code));
    return rows.map((r) => ({
      ...r.member,
      companyCode: r.companyCode,
      companyName: r.companyName,
      currency: r.currency,
      isParent: r.member.companyId === group?.parentCompanyId,
    }));
  }

  async rules(groupId: string, executor: DbExecutor = this.db): Promise<EliminationRule[]> {
    return executor
      .select()
      .from(eliminationRules)
      .where(eq(eliminationRules.groupId, groupId))
      .orderBy(asc(eliminationRules.code));
  }

  private async decorate(group: ConsolidationGroup): Promise<GroupView> {
    const [parent] = await this.db
      .select({ code: companies.code, name: companies.name })
      .from(companies)
      .where(eq(companies.id, group.parentCompanyId));
    const runs = await this.db
      .select({ id: consolidationRuns.id })
      .from(consolidationRuns)
      .where(eq(consolidationRuns.groupId, group.id));
    return {
      ...group,
      parentCompanyCode: parent?.code ?? '',
      parentCompanyName: parent?.name ?? '',
      members: await this.members(group.id),
      rules: await this.rules(group.id),
      runCount: runs.length,
    };
  }

  private async company(tx: DbExecutor, organizationId: string, id: string) {
    const [row] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
    if (!row) throw new NotFoundError('Company', id);
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Company ${row.code} is inactive.`);
    return row;
  }

  /** Structure changes never rewrite history: a finalized run covering the change date stays as it was, later runs must be reopened. */
  private async assertNoFinalizedRunAfter(
    tx: DbExecutor,
    groupId: string,
    effective: string | null,
  ): Promise<void> {
    const runs = await tx
      .select({
        documentNumber: consolidationRuns.documentNumber,
        periodEnd: consolidationRuns.periodEnd,
      })
      .from(consolidationRuns)
      .where(
        and(eq(consolidationRuns.groupId, groupId), eq(consolidationRuns.status, 'FINALIZED')),
      );
    const blocking = runs.filter((r) => !effective || r.periodEnd >= effective);
    if (blocking.length)
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `Reopen ${blocking.map((r) => r.documentNumber).join(', ')} before changing the group structure for that period.`,
        { runs: blocking.map((r) => r.documentNumber) },
      );
  }
}
