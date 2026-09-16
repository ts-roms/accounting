import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AccountMappingKey } from '@accounting/types';
import type {
  PostingRuleInput,
  SimulatePostingRuleInput,
  UpdatePostingRuleInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  postingRules,
  type PostingRule,
  type PostingRuleLine,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { AccountsService } from '../accounts/accounts.service';
import type { PostingLine } from '../journals/posting.service';
import {
  PostingRuleResolutionError,
  resolvePostingRule,
  ruleRequirements,
  type RuleContext,
} from './posting-rules.logic';

const MODULE = 'ACCOUNTING';

export interface PostingRuleView extends PostingRule {
  requirements: ReturnType<typeof ruleRequirements>;
}

export interface ResolvedRule {
  transactionType: string;
  journalType: PostingRule['journalType'];
  lines: PostingLine[];
  /** For previews: line -> account code / name. */
  accounts: Array<{ accountId: string; code: string; name: string }>;
}

/**
 * Declarative posting rules per transaction type. A module resolves the rule
 * for its transaction with its amounts and hands the lines to
 * AccountingPostingService; account ids never appear in business code.
 */
@Injectable()
export class PostingRulesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
  ) {}

  async list(companyId: string): Promise<PostingRuleView[]> {
    const rows = await this.db
      .select()
      .from(postingRules)
      .where(eq(postingRules.companyId, companyId))
      .orderBy(asc(postingRules.transactionType));
    return rows.map((r) => ({ ...r, requirements: ruleRequirements(r.lines) }));
  }

  async get(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<PostingRuleView> {
    const [row] = await executor
      .select()
      .from(postingRules)
      .where(and(eq(postingRules.id, id), eq(postingRules.companyId, companyId)));
    if (!row) throw new NotFoundError('PostingRule', id);
    return { ...row, requirements: ruleRequirements(row.lines) };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: PostingRuleInput,
  ): Promise<PostingRuleView> {
    const id = await this.db.transaction(async (tx) => {
      await this.validateLines(tx, companyId, input.lines);
      let row: PostingRule | undefined;
      try {
        [row] = await tx
          .insert(postingRules)
          .values({
            companyId,
            transactionType: input.transactionType,
            name: input.name,
            description: input.description ?? null,
            journalType: input.journalType,
            lines: input.lines.map(normalizeLine),
            status: input.status,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'posting_rules_company_type_uq'))
          throw new DuplicateError('PostingRule', 'transactionType', input.transactionType);
        throw err;
      }
      if (!row) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'PostingRule',
          entityId: row.id,
          newValue: { transactionType: row.transactionType, name: row.name, lines: row.lines },
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
    input: UpdatePostingRuleInput,
  ): Promise<PostingRuleView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.get(companyId, id, tx);
      if (input.lines) await this.validateLines(tx, companyId, input.lines);
      await tx
        .update(postingRules)
        .set({
          name: input.name ?? existing.name,
          description:
            input.description === undefined ? existing.description : (input.description ?? null),
          journalType: input.journalType ?? existing.journalType,
          lines: input.lines ? input.lines.map(normalizeLine) : existing.lines,
          status: input.status ?? existing.status,
          updatedAt: new Date(),
        })
        .where(eq(postingRules.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'PostingRule',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status, lines: existing.lines },
          newValue: {
            name: input.name ?? existing.name,
            status: input.status ?? existing.status,
            lines: input.lines ? input.lines.map(normalizeLine) : existing.lines,
          },
          companyId,
          userId: actor.id,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Resolves the ACTIVE rule of a transaction type into balanced posting
   * lines. This is the integration point for business modules:
   *
   *   const lines = await postingRules.resolve(tx, companyId, 'CUSTOMER_INVOICE',
   *     { amounts: { GROSS: '112', NET: '100', TAX: '12' } });
   *   await posting.postEvent(tx, { ..., lines, actor });
   */
  async resolve(
    executor: DbExecutor,
    companyId: string,
    transactionType: string,
    ctx: Omit<RuleContext, 'mapped'>,
  ): Promise<ResolvedRule> {
    const [rule] = await executor
      .select()
      .from(postingRules)
      .where(
        and(
          eq(postingRules.companyId, companyId),
          eq(postingRules.transactionType, transactionType),
          eq(postingRules.status, 'ACTIVE'),
        ),
      );
    if (!rule)
      throw new BusinessRuleError(
        ErrorCodes.POSTING_RULE_UNRESOLVED,
        `No active posting rule for ${transactionType}.`,
        { transactionType },
      );
    return this.resolveRule(executor, companyId, rule, ctx);
  }

  /** Preview a rule against sample amounts (UI + tests). */
  async simulate(
    companyId: string,
    id: string,
    input: SimulatePostingRuleInput,
  ): Promise<ResolvedRule> {
    const rule = await this.get(companyId, id);
    return this.resolveRule(this.db, companyId, rule, {
      amounts: input.amounts,
      accounts: input.accounts,
    });
  }

  // -------------------------------------------------------------- internals

  private async resolveRule(
    executor: DbExecutor,
    companyId: string,
    rule: PostingRule,
    ctx: Omit<RuleContext, 'mapped'>,
  ): Promise<ResolvedRule> {
    const { mappingKeys } = ruleRequirements(rule.lines);
    const mapped = new Map<string, string>();
    for (const key of mappingKeys) {
      const account = await this.accounts.resolveMapped(
        companyId,
        key as AccountMappingKey,
        executor,
      );
      mapped.set(key, account.id);
    }
    const [company] = await executor
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) throw new NotFoundError('Company', companyId);
    let lines: PostingLine[];
    try {
      lines = resolvePostingRule(rule.lines, company.baseCurrency, { ...ctx, mapped });
    } catch (err) {
      if (err instanceof PostingRuleResolutionError)
        throw new BusinessRuleError(ErrorCodes.POSTING_RULE_UNRESOLVED, err.message, {
          transactionType: rule.transactionType,
          reason: err.reason,
          ...err.details,
        });
      throw err;
    }
    const ids = [...new Set(lines.map((l) => l.accountId))];
    const rows = await executor
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      if (!byId.has(id))
        throw new BusinessRuleError(
          ErrorCodes.POSTING_RULE_UNRESOLVED,
          'A rule line resolved to an account outside this company.',
          { accountId: id },
        );
    }
    return {
      transactionType: rule.transactionType,
      journalType: rule.journalType,
      lines,
      accounts: lines.map((l) => {
        const a = byId.get(l.accountId)!;
        return { accountId: a.id, code: a.code, name: a.name };
      }),
    };
  }

  /** Fixed accounts must be postable accounts of the company. */
  private async validateLines(
    tx: DbExecutor,
    companyId: string,
    lines: PostingRuleInput['lines'],
  ): Promise<void> {
    const ids = [...new Set(lines.map((l) => l.accountId).filter((x): x is string => Boolean(x)))];
    if (!ids.length) return;
    const rows = await tx
      .select({ id: accounts.id, code: accounts.code, isHeader: accounts.isHeader })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of ids) {
      const account = byId.get(id);
      if (!account) throw new NotFoundError('Account', id);
      if (account.isHeader)
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} is a header account and cannot be used in a posting rule.`,
        );
    }
  }
}

function normalizeLine(line: PostingRuleInput['lines'][number]): PostingRuleLine {
  return {
    side: line.side,
    accountSource: line.accountSource,
    mappingKey: line.accountSource === 'MAPPING' ? line.mappingKey : null,
    accountId: line.accountSource === 'ACCOUNT' ? line.accountId : null,
    accountKey: line.accountSource === 'CONTEXT' ? line.accountKey : null,
    amountKey: line.amountKey,
    description: line.description ?? null,
  };
}
