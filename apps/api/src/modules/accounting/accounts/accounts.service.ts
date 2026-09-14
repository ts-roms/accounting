import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import { NORMAL_BALANCE_BY_TYPE, type AccountMappingKey } from '@accounting/types';
import type {
  CreateAccountInput,
  ListAccountsQuery,
  SetAccountMappingInput,
  UpdateAccountInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { shallowDiff } from '@/common/utils/diff';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  companies,
  journalLines,
  type Account,
} from '@/database/schema';

const MODULE = 'ACCOUNTING';

export interface AccountNode extends Account {
  level: number;
  hasChildren: boolean;
}

@Injectable()
export class AccountsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  /** Flat list ordered as a depth-first tree (parents before children) with a computed level. */
  async list(companyId: string, query: ListAccountsQuery = {}): Promise<AccountNode[]> {
    const filters: SQL[] = [eq(accounts.companyId, companyId)];
    if (query.type) filters.push(eq(accounts.type, query.type));
    if (query.status) filters.push(eq(accounts.status, query.status));
    if (query.postableOnly) filters.push(eq(accounts.isHeader, false));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(or(ilike(accounts.code, term), ilike(accounts.name, term))!);
    }
    const rows = await this.db
      .select()
      .from(accounts)
      .where(and(...filters))
      .orderBy(asc(accounts.code));
    return toTree(rows);
  }

  async getOrThrow(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<Account> {
    const [row] = await executor
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), eq(accounts.companyId, companyId)));
    if (!row) throw new NotFoundError('Account', id);
    return row;
  }

  async findByIds(
    companyId: string,
    ids: string[],
    executor: DbExecutor = this.db,
  ): Promise<Account[]> {
    if (ids.length === 0) return [];
    return executor
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids)));
  }

  async create(companyId: string, input: CreateAccountInput): Promise<Account> {
    return this.db.transaction(async (tx) => {
      const parent = input.parentId ? await this.getOrThrow(companyId, input.parentId, tx) : null;
      if (parent) this.assertParentCompatible(parent, input.type);

      let created: Account | undefined;
      try {
        [created] = await tx
          .insert(accounts)
          .values({
            companyId,
            code: input.code,
            name: input.name,
            type: input.type,
            subtype: input.subtype ?? null,
            normalBalance: input.normalBalance ?? NORMAL_BALANCE_BY_TYPE[input.type],
            parentId: parent?.id ?? null,
            currency: input.currency ?? null,
            isHeader: input.isHeader,
            description: input.description ?? null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'accounts_company_code_uq'))
          throw new DuplicateError('Account', 'code', input.code);
        throw err;
      }
      if (!created) throw new Error('Insert returned no row');

      // A parent that receives children becomes a header account.
      if (parent && !parent.isHeader) {
        const activity = await this.hasActivity(parent.id, tx);
        if (activity) {
          throw new BusinessRuleError(
            ErrorCodes.ACCOUNT_HAS_ACTIVITY,
            `Account ${parent.code} has posted activity and cannot become a header account.`,
          );
        }
        await tx.update(accounts).set({ isHeader: true }).where(eq(accounts.id, parent.id));
      }

      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Account',
          entityId: created.id,
          newValue: created,
          companyId,
        },
        tx,
      );
      return created;
    });
  }

  async update(companyId: string, id: string, input: UpdateAccountInput): Promise<Account> {
    return this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);

      if (input.parentId !== undefined && input.parentId !== existing.parentId) {
        if (input.parentId) {
          const parent = await this.getOrThrow(companyId, input.parentId, tx);
          this.assertParentCompatible(parent, existing.type);
          if (await this.isDescendant(parent.id, existing.id, tx)) {
            throw new BusinessRuleError(
              ErrorCodes.ACCOUNT_HIERARCHY_INVALID,
              'An account cannot be moved under its own descendant.',
            );
          }
        }
      }

      if (input.status === 'INACTIVE') {
        if (existing.isSystem) {
          throw new BusinessRuleError(
            ErrorCodes.FORBIDDEN,
            'System accounts cannot be deactivated.',
          );
        }
        if (await this.isMapped(existing.id, tx)) {
          throw new BusinessRuleError(
            ErrorCodes.ACCOUNT_MAPPING_MISSING,
            'Remove the account mapping before deactivating this account.',
          );
        }
      }

      const [updated] = await tx
        .update(accounts)
        .set({
          name: input.name ?? existing.name,
          subtype: input.subtype === undefined ? existing.subtype : input.subtype,
          parentId: input.parentId === undefined ? existing.parentId : input.parentId,
          description: input.description === undefined ? existing.description : input.description,
          status: input.status ?? existing.status,
        })
        .where(eq(accounts.id, id))
        .returning();
      if (!updated) throw new Error('Update returned no row');

      const { previous, next } = shallowDiff(existing, updated);
      await this.audit.record(
        {
          action:
            input.status && input.status !== existing.status
              ? input.status === 'ACTIVE'
                ? 'ACTIVATE'
                : 'DEACTIVATE'
              : 'UPDATE',
          module: MODULE,
          entityType: 'Account',
          entityId: id,
          previousValue: previous,
          newValue: next,
          companyId,
        },
        tx,
      );
      return updated;
    });
  }

  /** Accounts are never deleted once they carry activity; this is for mistakes made before any posting. */
  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.getOrThrow(companyId, id, tx);
      if (existing.isSystem)
        throw new BusinessRuleError(ErrorCodes.FORBIDDEN, 'System accounts cannot be deleted.');
      if (await this.hasActivity(id, tx)) {
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_HAS_ACTIVITY,
          'This account has journal activity. Deactivate it instead of deleting it.',
        );
      }
      const [child] = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.parentId, id))
        .limit(1);
      if (child)
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_HIERARCHY_INVALID,
          'Remove or move child accounts first.',
        );
      if (await this.isMapped(id, tx)) {
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_MAPPING_MISSING,
          'Remove the account mapping before deleting this account.',
        );
      }
      await tx.delete(accounts).where(eq(accounts.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Account',
          entityId: id,
          previousValue: existing,
          companyId,
        },
        tx,
      );
    });
  }

  // ------------------------------------------------------------- mappings

  async listMappings(
    companyId: string,
  ): Promise<
    Array<{ key: AccountMappingKey; accountId: string; accountCode: string; accountName: string }>
  > {
    return this.db
      .select({
        key: accountMappings.key,
        accountId: accountMappings.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
      })
      .from(accountMappings)
      .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
      .where(eq(accountMappings.companyId, companyId))
      .orderBy(asc(accountMappings.key));
  }

  async setMapping(companyId: string, input: SetAccountMappingInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(accountMappings)
        .where(and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, input.key)));
      if (input.accountId === null) {
        if (existing) await tx.delete(accountMappings).where(eq(accountMappings.id, existing.id));
      } else {
        const account = await this.getOrThrow(companyId, input.accountId, tx);
        if (account.isHeader)
          throw new BusinessRuleError(
            ErrorCodes.ACCOUNT_NOT_POSTABLE,
            'Mappings must point to a postable account.',
          );
        await tx
          .insert(accountMappings)
          .values({ companyId, key: input.key, accountId: input.accountId })
          .onConflictDoUpdate({
            target: [accountMappings.companyId, accountMappings.key],
            set: { accountId: input.accountId, updatedAt: new Date() },
          });
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AccountMapping',
          entityId: input.key,
          previousValue: { accountId: existing?.accountId ?? null },
          newValue: { accountId: input.accountId },
          companyId,
        },
        tx,
      );
    });
  }

  /** Resolves a mapped account or fails loudly - business modules must never guess account ids. */
  async resolveMapped(
    companyId: string,
    key: AccountMappingKey,
    executor: DbExecutor = this.db,
  ): Promise<Account> {
    const [row] = await executor
      .select({ account: accounts })
      .from(accountMappings)
      .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
      .where(and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, key)));
    if (!row) {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_MAPPING_MISSING,
        `No account is mapped for ${key}. Configure it in the chart of accounts.`,
        { key },
      );
    }
    return row.account;
  }

  async companyCurrency(companyId: string, executor: DbExecutor = this.db): Promise<string> {
    const [row] = await executor
      .select({ currency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new NotFoundError('Company', companyId);
    return row.currency;
  }

  // ------------------------------------------------------------- internals

  private assertParentCompatible(parent: Account, type: Account['type']): void {
    if (parent.type !== type) {
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_HIERARCHY_INVALID,
        `Parent account ${parent.code} is of type ${parent.type}, not ${type}.`,
      );
    }
  }

  async hasActivity(accountId: string, executor: DbExecutor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ one: sql<number>`1` })
      .from(journalLines)
      .where(eq(journalLines.accountId, accountId))
      .limit(1);
    return Boolean(row);
  }

  private async isMapped(accountId: string, executor: DbExecutor): Promise<boolean> {
    const [row] = await executor
      .select({ id: accountMappings.id })
      .from(accountMappings)
      .where(eq(accountMappings.accountId, accountId))
      .limit(1);
    return Boolean(row);
  }

  private async isDescendant(
    candidateId: string,
    ancestorId: string,
    executor: DbExecutor,
  ): Promise<boolean> {
    let current: string | null = candidateId;
    for (let depth = 0; current && depth < 32; depth += 1) {
      if (current === ancestorId) return true;
      const [row] = await executor
        .select({ parentId: accounts.parentId })
        .from(accounts)
        .where(eq(accounts.id, current));
      current = row?.parentId ?? null;
    }
    return false;
  }
}

/** Orders a flat account list depth-first and annotates each node with its level. */
export function toTree(rows: Account[]): AccountNode[] {
  const byParent = new Map<string | null, Account[]>();
  const ids = new Set(rows.map((r) => r.id));
  for (const row of rows) {
    // Treat filtered-out parents as roots so partial lists still render.
    const key = row.parentId && ids.has(row.parentId) ? row.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), row]);
  }
  const out: AccountNode[] = [];
  const visit = (parentId: string | null, level: number) => {
    for (const row of (byParent.get(parentId) ?? []).sort((a, b) => a.code.localeCompare(b.code))) {
      out.push({ ...row, level, hasChildren: byParent.has(row.id) });
      visit(row.id, level + 1);
    }
  };
  visit(null, 0);
  return out;
}
