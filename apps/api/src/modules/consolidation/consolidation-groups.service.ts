import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  AutoMapInput,
  CreateConsolidationAdjustmentInput,
  CreateConsolidationGroupInput,
  GroupAccountInput,
  GroupMappingsInput,
  UpdateConsolidationGroupInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  consolidationAdjustmentLines,
  consolidationAdjustments,
  consolidationGroupMembers,
  consolidationGroups,
  groupAccountMappings,
  groupAccounts,
  type ConsolidationAdjustment,
  type ConsolidationAdjustmentLine,
  type ConsolidationGroup,
  type GroupAccount,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';

export interface GroupMemberView {
  companyId: string;
  code: string;
  name: string;
  baseCurrency: string;
  ownershipPct: string;
  method: 'FULL' | 'PROPORTIONATE';
  isParent: boolean;
}

export interface ConsolidationGroupView extends ConsolidationGroup {
  members: GroupMemberView[];
  groupAccountCount: number;
}

export interface MappingRow {
  accountId: string;
  code: string;
  name: string;
  type: string;
  isHeader: boolean;
  groupAccountId: string | null;
}

export interface AdjustmentView extends ConsolidationAdjustment {
  lines: Array<
    ConsolidationAdjustmentLine & { groupAccountCode: string; groupAccountName: string }
  >;
  total: string;
}

const MODULE = 'consolidation';

/**
 * Consolidation groups, the group chart of accounts, member-account mappings
 * and manual adjustments (hardening H9). Everything is organization-level
 * master data for the group engine; none of it touches a company ledger.
 */
@Injectable()
export class ConsolidationGroupsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ groups

  async list(organizationId: string): Promise<ConsolidationGroupView[]> {
    const rows = await this.db
      .select()
      .from(consolidationGroups)
      .where(eq(consolidationGroups.organizationId, organizationId))
      .orderBy(asc(consolidationGroups.code));
    return Promise.all(rows.map((g) => this.view(g)));
  }

  async get(organizationId: string, id: string): Promise<ConsolidationGroupView> {
    return this.view(await this.load(this.db, organizationId, id));
  }

  async create(
    organizationId: string,
    actor: AuthenticatedUser,
    input: CreateConsolidationGroupInput,
  ): Promise<ConsolidationGroupView> {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: consolidationGroups.id })
        .from(consolidationGroups)
        .where(
          and(
            eq(consolidationGroups.organizationId, organizationId),
            eq(consolidationGroups.code, input.code),
          ),
        );
      if (dup) throw new DuplicateError('Consolidation group', 'code', input.code);
      await this.assertCompanies(tx, organizationId, [
        input.parentCompanyId,
        ...input.members.map((m) => m.companyId),
      ]);
      const [group] = await tx
        .insert(consolidationGroups)
        .values({
          organizationId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          presentationCurrency: input.presentationCurrency,
          parentCompanyId: input.parentCompanyId,
          createdBy: actor.id,
        })
        .returning();
      await this.replaceMembers(tx, group!, input.members);
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ConsolidationGroup',
          entityId: group!.id,
          newValue: { code: input.code, name: input.name, members: input.members.length + 1 },
          organizationId,
        },
        tx,
      );
      return this.view(group!, tx);
    });
  }

  async update(
    organizationId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateConsolidationGroupInput,
  ): Promise<ConsolidationGroupView> {
    return this.db.transaction(async (tx) => {
      const existing = await this.load(tx, organizationId, id);
      const { members, ...patch } = input;
      const [updated] = await tx
        .update(consolidationGroups)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(consolidationGroups.id, id))
        .returning();
      if (members) {
        await this.assertCompanies(
          tx,
          organizationId,
          members.map((m) => m.companyId),
        );
        await this.replaceMembers(tx, updated!, members);
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ConsolidationGroup',
          entityId: id,
          previousValue: {
            name: existing.name,
            presentationCurrency: existing.presentationCurrency,
            status: existing.status,
          },
          newValue: {
            name: updated!.name,
            presentationCurrency: updated!.presentationCurrency,
            status: updated!.status,
          },
          metadata: {
            membersReplaced: Boolean(members),
            reason: 'Consolidation group updated',
            userId: actor.id,
          },
          organizationId,
        },
        tx,
      );
      return this.view(updated!, tx);
    });
  }

  /** The parent is always a FULL member at 100%; subsidiaries come from the input. */
  private async replaceMembers(
    tx: DbExecutor,
    group: ConsolidationGroup,
    members: CreateConsolidationGroupInput['members'],
  ): Promise<void> {
    const seen = new Set<string>();
    const rows = [
      {
        groupId: group.id,
        companyId: group.parentCompanyId,
        ownershipPct: '100',
        method: 'FULL' as const,
      },
      ...members
        .filter((m) => m.companyId !== group.parentCompanyId)
        .map((m) => ({
          groupId: group.id,
          companyId: m.companyId,
          ownershipPct: m.ownershipPct.toFixed(4),
          method: m.method,
        })),
    ].filter((r) => {
      if (seen.has(r.companyId)) return false;
      seen.add(r.companyId);
      return true;
    });
    await tx
      .delete(consolidationGroupMembers)
      .where(eq(consolidationGroupMembers.groupId, group.id));
    await tx.insert(consolidationGroupMembers).values(rows);
  }

  private async assertCompanies(
    tx: DbExecutor,
    organizationId: string,
    ids: string[],
  ): Promise<void> {
    if (ids.length === 0) return;
    const rows = await tx
      .select({ id: companies.id })
      .from(companies)
      .where(and(eq(companies.organizationId, organizationId), inArray(companies.id, ids)));
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.find((id) => !found.has(id));
    if (missing) throw new NotFoundError('Company', missing);
  }

  async load(tx: DbExecutor, organizationId: string, id: string): Promise<ConsolidationGroup> {
    const [group] = await tx
      .select()
      .from(consolidationGroups)
      .where(
        and(eq(consolidationGroups.id, id), eq(consolidationGroups.organizationId, organizationId)),
      );
    if (!group) throw new NotFoundError('Consolidation group', id);
    return group;
  }

  async members(groupId: string, tx: DbExecutor = this.db): Promise<GroupMemberView[]> {
    const [group] = await tx
      .select({ parentCompanyId: consolidationGroups.parentCompanyId })
      .from(consolidationGroups)
      .where(eq(consolidationGroups.id, groupId));
    const rows = await tx
      .select({
        companyId: consolidationGroupMembers.companyId,
        code: companies.code,
        name: companies.name,
        baseCurrency: companies.baseCurrency,
        ownershipPct: consolidationGroupMembers.ownershipPct,
        method: consolidationGroupMembers.method,
      })
      .from(consolidationGroupMembers)
      .innerJoin(companies, eq(companies.id, consolidationGroupMembers.companyId))
      .where(eq(consolidationGroupMembers.groupId, groupId))
      .orderBy(asc(companies.code));
    return rows.map((r) => ({ ...r, isParent: r.companyId === group?.parentCompanyId }));
  }

  private async view(
    group: ConsolidationGroup,
    tx: DbExecutor = this.db,
  ): Promise<ConsolidationGroupView> {
    const [members, [count]] = await Promise.all([
      this.members(group.id, tx),
      tx
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(groupAccounts)
        .where(eq(groupAccounts.groupId, group.id)),
    ]);
    return { ...group, members, groupAccountCount: count?.n ?? 0 };
  }

  // ------------------------------------------------------- group chart of accounts

  async groupAccounts(organizationId: string, groupId: string): Promise<GroupAccount[]> {
    await this.load(this.db, organizationId, groupId);
    return this.db
      .select()
      .from(groupAccounts)
      .where(eq(groupAccounts.groupId, groupId))
      .orderBy(asc(groupAccounts.sortOrder), asc(groupAccounts.code));
  }

  async createGroupAccount(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: GroupAccountInput,
  ): Promise<GroupAccount> {
    await this.load(this.db, organizationId, groupId);
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: groupAccounts.id })
        .from(groupAccounts)
        .where(and(eq(groupAccounts.groupId, groupId), eq(groupAccounts.code, input.code)));
      if (dup) throw new DuplicateError('Group account', 'code', input.code);
      const [row] = await tx
        .insert(groupAccounts)
        .values({ groupId, ...input })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'GroupAccount',
          entityId: row!.id,
          newValue: { groupId, ...input },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
      return row!;
    });
  }

  async updateGroupAccount(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    id: string,
    input: Partial<GroupAccountInput>,
  ): Promise<GroupAccount> {
    await this.load(this.db, organizationId, groupId);
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(groupAccounts)
        .where(and(eq(groupAccounts.id, id), eq(groupAccounts.groupId, groupId)));
      if (!existing) throw new NotFoundError('Group account', id);
      const [row] = await tx
        .update(groupAccounts)
        .set(input)
        .where(eq(groupAccounts.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'GroupAccount',
          entityId: id,
          previousValue: existing,
          newValue: row,
          metadata: { reason: 'Group account updated' },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
      return row!;
    });
  }

  /** Member accounts with their current group mapping (headers listed for context, never mapped). */
  async mappings(
    organizationId: string,
    groupId: string,
    companyId: string,
  ): Promise<MappingRow[]> {
    await this.load(this.db, organizationId, groupId);
    const rows = await this.db
      .select({
        accountId: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        isHeader: accounts.isHeader,
        groupAccountId: groupAccountMappings.groupAccountId,
      })
      .from(accounts)
      .leftJoin(
        groupAccountMappings,
        and(
          eq(groupAccountMappings.accountId, accounts.id),
          eq(groupAccountMappings.groupId, groupId),
        ),
      )
      .where(eq(accounts.companyId, companyId))
      .orderBy(asc(accounts.code));
    return rows;
  }

  async saveMappings(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: GroupMappingsInput,
  ): Promise<{ mapped: number; unmapped: number }> {
    await this.load(this.db, organizationId, groupId);
    return this.db.transaction(async (tx) => {
      const groupAccountIds = new Set(
        (
          await tx
            .select({ id: groupAccounts.id })
            .from(groupAccounts)
            .where(eq(groupAccounts.groupId, groupId))
        ).map((r) => r.id),
      );
      const accountIds = new Set(
        (
          await tx
            .select({ id: accounts.id })
            .from(accounts)
            .where(and(eq(accounts.companyId, input.companyId), eq(accounts.isHeader, false)))
        ).map((r) => r.id),
      );
      let mapped = 0;
      let unmapped = 0;
      for (const m of input.mappings) {
        if (!accountIds.has(m.accountId))
          throw new BusinessRuleError(
            ErrorCodes.VALIDATION_FAILED,
            `Account ${m.accountId} is not a postable account of the member company.`,
          );
        if (m.groupAccountId === null) {
          await tx
            .delete(groupAccountMappings)
            .where(
              and(
                eq(groupAccountMappings.groupId, groupId),
                eq(groupAccountMappings.accountId, m.accountId),
              ),
            );
          unmapped += 1;
          continue;
        }
        if (!groupAccountIds.has(m.groupAccountId))
          throw new NotFoundError('Group account', m.groupAccountId);
        await tx
          .insert(groupAccountMappings)
          .values({
            groupId,
            companyId: input.companyId,
            accountId: m.accountId,
            groupAccountId: m.groupAccountId,
          })
          .onConflictDoUpdate({
            target: [groupAccountMappings.groupId, groupAccountMappings.accountId],
            set: { groupAccountId: m.groupAccountId, companyId: input.companyId },
          });
        mapped += 1;
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'GroupAccountMapping',
          entityId: groupId,
          newValue: { companyId: input.companyId, mapped, unmapped },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
      return { mapped, unmapped };
    });
  }

  /**
   * Maps every unmapped postable member account to the group account with the
   * same code. With `createMissing`, group accounts are created from the
   * member's chart (code, name, type, intercompany flag) - the usual first
   * step when the group chart mirrors the parent's.
   */
  async autoMap(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: AutoMapInput,
  ): Promise<{ mapped: number; created: number; unmapped: string[] }> {
    const group = await this.load(this.db, organizationId, groupId);
    const members = await this.members(groupId);
    const targets = input.companyId
      ? members.filter((m) => m.companyId === input.companyId)
      : members;
    // The parent's accounts seed the group chart first so its codes win.
    targets.sort((a, b) =>
      a.companyId === group.parentCompanyId ? -1 : b.companyId === group.parentCompanyId ? 1 : 0,
    );
    return this.db.transaction(async (tx) => {
      const byCode = new Map(
        (await tx.select().from(groupAccounts).where(eq(groupAccounts.groupId, groupId))).map(
          (g) => [g.code, g],
        ),
      );
      let mapped = 0;
      let created = 0;
      const unmapped: string[] = [];
      for (const member of targets) {
        const chart = await tx
          .select({
            id: accounts.id,
            code: accounts.code,
            name: accounts.name,
            type: accounts.type,
            isIntercompany: accounts.isIntercompany,
            mapping: groupAccountMappings.groupAccountId,
          })
          .from(accounts)
          .leftJoin(
            groupAccountMappings,
            and(
              eq(groupAccountMappings.accountId, accounts.id),
              eq(groupAccountMappings.groupId, groupId),
            ),
          )
          .where(and(eq(accounts.companyId, member.companyId), eq(accounts.isHeader, false)))
          .orderBy(asc(accounts.code));
        for (const a of chart) {
          if (a.mapping) continue;
          let target = byCode.get(a.code);
          if (!target && input.createMissing) {
            const [row] = await tx
              .insert(groupAccounts)
              .values({
                groupId,
                code: a.code,
                name: a.name,
                type: a.type,
                isIntercompany: a.isIntercompany,
                sortOrder: Number.parseInt(a.code, 10) || 0,
              })
              .returning();
            target = row!;
            byCode.set(a.code, target);
            created += 1;
          }
          if (!target) {
            unmapped.push(`${member.code}:${a.code}`);
            continue;
          }
          if (target.type !== a.type) {
            unmapped.push(`${member.code}:${a.code} (type ${a.type} vs group ${target.type})`);
            continue;
          }
          await tx.insert(groupAccountMappings).values({
            groupId,
            companyId: member.companyId,
            accountId: a.id,
            groupAccountId: target.id,
          });
          mapped += 1;
        }
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'GroupAccountMapping',
          entityId: groupId,
          newValue: {
            autoMap: true,
            companyId: input.companyId ?? null,
            mapped,
            created,
            unmapped: unmapped.length,
          },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
      return { mapped, created, unmapped };
    });
  }

  // ------------------------------------------------------------- adjustments

  async adjustments(organizationId: string, groupId: string): Promise<AdjustmentView[]> {
    await this.load(this.db, organizationId, groupId);
    const heads = await this.db
      .select()
      .from(consolidationAdjustments)
      .where(eq(consolidationAdjustments.groupId, groupId))
      .orderBy(
        asc(consolidationAdjustments.effectiveDate),
        asc(consolidationAdjustments.createdAt),
      );
    return Promise.all(heads.map((h) => this.adjustmentView(h)));
  }

  /** Adjustments that apply to a window: effective inside it, or recurring across it. */
  async adjustmentsFor(groupId: string, from: string, to: string): Promise<AdjustmentView[]> {
    const heads = await this.db
      .select()
      .from(consolidationAdjustments)
      .where(
        and(
          eq(consolidationAdjustments.groupId, groupId),
          or(
            and(
              sql`${consolidationAdjustments.effectiveDate} >= ${from}`,
              sql`${consolidationAdjustments.effectiveDate} <= ${to}`,
            ),
            and(
              sql`${consolidationAdjustments.effectiveDate} <= ${to}`,
              or(
                isNull(consolidationAdjustments.recurringUntil),
                sql`${consolidationAdjustments.recurringUntil} >= ${from}`,
              ),
              sql`${consolidationAdjustments.recurringUntil} IS NOT NULL`,
            ),
          ),
        ),
      );
    return Promise.all(heads.map((h) => this.adjustmentView(h)));
  }

  private async adjustmentView(
    head: ConsolidationAdjustment,
    tx: DbExecutor = this.db,
  ): Promise<AdjustmentView> {
    const lines = await tx
      .select({
        line: consolidationAdjustmentLines,
        groupAccountCode: groupAccounts.code,
        groupAccountName: groupAccounts.name,
      })
      .from(consolidationAdjustmentLines)
      .innerJoin(groupAccounts, eq(groupAccounts.id, consolidationAdjustmentLines.groupAccountId))
      .where(eq(consolidationAdjustmentLines.adjustmentId, head.id))
      .orderBy(asc(consolidationAdjustmentLines.lineNumber));
    const total = lines.reduce((n, l) => n + Number(l.line.debit), 0).toFixed(4);
    return {
      ...head,
      lines: lines.map((l) => ({
        ...l.line,
        groupAccountCode: l.groupAccountCode,
        groupAccountName: l.groupAccountName,
      })),
      total,
    };
  }

  async createAdjustment(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    input: CreateConsolidationAdjustmentInput,
  ): Promise<AdjustmentView> {
    await this.load(this.db, organizationId, groupId);
    return this.db.transaction(async (tx) => {
      const ids = new Set(
        (
          await tx
            .select({ id: groupAccounts.id })
            .from(groupAccounts)
            .where(eq(groupAccounts.groupId, groupId))
        ).map((r) => r.id),
      );
      for (const l of input.lines)
        if (!ids.has(l.groupAccountId)) throw new NotFoundError('Group account', l.groupAccountId);
      const [head] = await tx
        .insert(consolidationAdjustments)
        .values({
          groupId,
          effectiveDate: input.effectiveDate,
          recurringUntil: input.recurringUntil ?? null,
          reference: input.reference ?? null,
          description: input.description,
          createdBy: actor.id,
        })
        .returning();
      await tx.insert(consolidationAdjustmentLines).values(
        input.lines.map((l, i) => ({
          adjustmentId: head!.id,
          lineNumber: i + 1,
          groupAccountId: l.groupAccountId,
          debit: l.debit,
          credit: l.credit,
          description: l.description ?? null,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ConsolidationAdjustment',
          entityId: head!.id,
          newValue: {
            groupId,
            effectiveDate: input.effectiveDate,
            description: input.description,
            lines: input.lines.length,
          },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
      const view = await this.adjustmentView(head!, tx);
      return view;
    });
  }

  async removeAdjustment(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    id: string,
  ): Promise<void> {
    await this.load(this.db, organizationId, groupId);
    await this.db.transaction(async (tx) => {
      const [head] = await tx
        .select()
        .from(consolidationAdjustments)
        .where(
          and(eq(consolidationAdjustments.id, id), eq(consolidationAdjustments.groupId, groupId)),
        );
      if (!head) throw new NotFoundError('Consolidation adjustment', id);
      await tx.delete(consolidationAdjustments).where(eq(consolidationAdjustments.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'ConsolidationAdjustment',
          entityId: id,
          previousValue: { effectiveDate: head.effectiveDate, description: head.description },
          organizationId,
          userId: actor.id,
        },
        tx,
      );
    });
  }
}
