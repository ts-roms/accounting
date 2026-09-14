import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, inArray, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type AccountType, type PaginatedResult } from '@accounting/types';
import type {
  BudgetLineInput,
  CreateBudgetInput,
  CreateBudgetVersionInput,
  ListBudgetsQuery,
  ReplaceBudgetLinesInput,
  UpdateBudgetInput,
  VarianceQuery,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  budgetLines,
  budgetVersions,
  budgets,
  fiscalPeriods,
  fiscalYears,
  journalEntries,
  journalLines,
  type Budget,
  type BudgetLine,
  type BudgetVersion,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { DimensionsService } from '@/modules/accounting/dimensions/dimensions.service';
import { dimensionConditions } from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import { SodService } from '@/modules/rbac/sod.service';

const MODULE = 'BUDGETING';
const DEFAULT_TYPES: AccountType[] = ['REVENUE', 'EXPENSE'];

export interface BudgetView extends Budget {
  fiscalYearName: string;
  versionCount: number;
  approvedVersionId: string | null;
  approvedVersionName: string | null;
  approvedTotal: string;
}

export interface BudgetVersionView extends BudgetVersion {
  lineCount: number;
  total: string;
}

export interface BudgetDetail extends BudgetView {
  versions: BudgetVersionView[];
  periods: Array<{
    id: string;
    name: string;
    periodNumber: number;
    startDate: string;
    endDate: string;
    status: string;
  }>;
}

export interface BudgetLineView extends BudgetLine {
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  periodNumber: number;
}

export interface VarianceCell {
  periodId: string;
  budget: string;
  actual: string;
  variance: string;
}

export interface VarianceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  cells: VarianceCell[];
  budget: string;
  actual: string;
  /** actual - budget, in the account's natural direction (positive = over budget). */
  variance: string;
  variancePercent: string | null;
}

export interface VarianceReport {
  budgetId: string;
  versionId: string;
  versionName: string;
  currency: string;
  periods: Array<{ id: string; name: string; periodNumber: number }>;
  rows: VarianceRow[];
  totals: {
    revenue: { budget: string; actual: string; variance: string };
    expense: { budget: string; actual: string; variance: string };
    net: { budget: string; actual: string; variance: string };
  };
}

/**
 * Budgets hold planned amounts per account and fiscal period (optionally per
 * dimension); actuals always come from posted journal lines, never from a
 * maintained total. Versions are immutable once approved.
 */
@Injectable()
export class BudgetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly dimensions: DimensionsService,
    private readonly sod: SodService,
  ) {}

  // ----------------------------------------------------------------- budgets

  async list(companyId: string, query: ListBudgetsQuery): Promise<PaginatedResult<BudgetView>> {
    const filters: SQL[] = [eq(budgets.companyId, companyId)];
    if (query.fiscalYearId) filters.push(eq(budgets.fiscalYearId, query.fiscalYearId));
    if (query.status) filters.push(eq(budgets.status, query.status));
    if (query.search)
      filters.push(
        sql`(${budgets.code} ilike ${`%${query.search}%`} or ${budgets.name} ilike ${`%${query.search}%`})`,
      );
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(fiscalYears.startDate), asc(budgets.code))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(budgets)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<BudgetDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(budgets.id, id), eq(budgets.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Budget', id);
    const [versions, periods] = await Promise.all([
      this.db
        .select({
          ...getTableColumns(budgetVersions),
          lineCount: sql<number>`(select count(*)::int from budget_lines l where l.version_id = ${sql.raw('"budget_versions"."id"')})`,
          total: sql<string>`(select coalesce(sum(l.amount), 0) from budget_lines l where l.version_id = ${sql.raw('"budget_versions"."id"')})`,
        })
        .from(budgetVersions)
        .where(eq(budgetVersions.budgetId, id))
        .orderBy(desc(budgetVersions.versionNumber)),
      this.db
        .select({
          id: fiscalPeriods.id,
          name: fiscalPeriods.name,
          periodNumber: fiscalPeriods.periodNumber,
          startDate: fiscalPeriods.startDate,
          endDate: fiscalPeriods.endDate,
          status: fiscalPeriods.status,
        })
        .from(fiscalPeriods)
        .where(eq(fiscalPeriods.fiscalYearId, row.fiscalYearId))
        .orderBy(asc(fiscalPeriods.periodNumber)),
    ]);
    return {
      ...row,
      versions: versions.map((v) => ({ ...v, total: Money.of(v.total, row.currency).toString() })),
      periods,
    };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBudgetInput,
  ): Promise<BudgetDetail> {
    const id = await this.db.transaction(async (tx) => {
      const [year] = await tx
        .select()
        .from(fiscalYears)
        .where(and(eq(fiscalYears.id, input.fiscalYearId), eq(fiscalYears.companyId, companyId)));
      if (!year) throw new NotFoundError('Fiscal year', input.fiscalYearId);
      const currency = await this.accounts.companyCurrency(companyId, tx);
      try {
        const [row] = await tx
          .insert(budgets)
          .values({
            companyId,
            fiscalYearId: year.id,
            code: input.code,
            name: input.name,
            description: input.description ?? null,
            currency,
            createdBy: actor.id,
          })
          .returning();
        // Every budget starts with an empty draft version.
        await tx
          .insert(budgetVersions)
          .values({ budgetId: row!.id, versionNumber: 1, name: 'Version 1', createdBy: actor.id });
        await this.audit.record(
          {
            action: 'CREATE',
            module: MODULE,
            entityType: 'Budget',
            entityId: row!.id,
            newValue: { code: input.code, name: input.name, fiscalYear: year.name },
            metadata: { actor: actor.email },
            companyId,
          },
          tx,
        );
        return row!.id;
      } catch (err) {
        if (isUniqueViolation(err, 'budgets_company_code_uq'))
          throw new DuplicateError('Budget', 'code', input.code);
        throw err;
      }
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBudgetInput,
  ): Promise<BudgetDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      try {
        await tx
          .update(budgets)
          .set({
            code: input.code ?? existing.code,
            name: input.name ?? existing.name,
            description: input.description === undefined ? existing.description : input.description,
            status: input.status ?? existing.status,
          })
          .where(eq(budgets.id, id));
      } catch (err) {
        if (isUniqueViolation(err, 'budgets_company_code_uq'))
          throw new DuplicateError('Budget', 'code', input.code ?? existing.code);
        throw err;
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'Budget',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email, code: existing.code },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      const [approved] = await tx
        .select({ id: budgetVersions.id })
        .from(budgetVersions)
        .where(
          and(
            eq(budgetVersions.budgetId, id),
            inArray(budgetVersions.status, ['APPROVED', 'SUPERSEDED']),
          ),
        );
      if (approved)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.code} has approved versions; archive it instead.`,
        );
      await tx.delete(budgets).where(eq(budgets.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'Budget',
          entityId: id,
          previousValue: { code: existing.code },
          companyId,
        },
        tx,
      );
    });
  }

  // ---------------------------------------------------------------- versions

  async createVersion(
    companyId: string,
    actor: AuthenticatedUser,
    budgetId: string,
    input: CreateBudgetVersionInput,
  ): Promise<BudgetVersionView & { lines: BudgetLineView[] }> {
    const versionId = await this.db.transaction(async (tx) => {
      const budget = await this.lock(tx, companyId, budgetId);
      if (budget.status === 'ARCHIVED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${budget.code} is archived.`,
        );
      const [{ max } = { max: 0 }] = await tx
        .select({ max: sql<number>`coalesce(max(${budgetVersions.versionNumber}), 0)::int` })
        .from(budgetVersions)
        .where(eq(budgetVersions.budgetId, budgetId));
      const [version] = await tx
        .insert(budgetVersions)
        .values({
          budgetId,
          versionNumber: max + 1,
          name: input.name,
          notes: input.notes ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (input.copyFromVersionId) {
        const source = await this.version(tx, budgetId, input.copyFromVersionId);
        const lines = await tx
          .select()
          .from(budgetLines)
          .where(eq(budgetLines.versionId, source.id));
        if (lines.length) {
          await tx
            .insert(budgetLines)
            .values(
              lines.map(({ id: _id, versionId: _v, ...l }) => ({ ...l, versionId: version!.id })),
            );
        }
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BudgetVersion',
          entityId: version!.id,
          newValue: {
            budgetId,
            versionNumber: max + 1,
            name: input.name,
            copiedFrom: input.copyFromVersionId ?? null,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return version!.id;
    });
    return this.getVersion(companyId, budgetId, versionId);
  }

  async getVersion(
    companyId: string,
    budgetId: string,
    versionId: string,
  ): Promise<BudgetVersionView & { lines: BudgetLineView[] }> {
    const budget = await this.get(companyId, budgetId);
    const version = budget.versions.find((v) => v.id === versionId);
    if (!version) throw new NotFoundError('Budget version', versionId);
    const lines = await this.db
      .select({
        ...getTableColumns(budgetLines),
        accountCode: accounts.code,
        accountName: accounts.name,
        accountType: accounts.type,
        periodNumber: fiscalPeriods.periodNumber,
      })
      .from(budgetLines)
      .innerJoin(accounts, eq(accounts.id, budgetLines.accountId))
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, budgetLines.fiscalPeriodId))
      .where(eq(budgetLines.versionId, versionId))
      .orderBy(asc(accounts.code), asc(fiscalPeriods.periodNumber));
    return { ...version, lines };
  }

  /** Replaces the whole grid of a draft version in one transaction. */
  async replaceLines(
    companyId: string,
    actor: AuthenticatedUser,
    budgetId: string,
    versionId: string,
    input: ReplaceBudgetLinesInput,
  ): Promise<BudgetVersionView & { lines: BudgetLineView[] }> {
    await this.db.transaction(async (tx) => {
      const budget = await this.lock(tx, companyId, budgetId);
      const version = await this.version(tx, budgetId, versionId, true);
      if (version.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${version.name} is ${version.status.toLowerCase()}; create a new version to change the numbers.`,
        );
      await this.validateLines(tx, companyId, budget, input.lines);
      await tx.delete(budgetLines).where(eq(budgetLines.versionId, versionId));
      const nonZero = input.lines.filter((l) => !Money.of(l.amount, budget.currency).isZero());
      if (nonZero.length) {
        await tx.insert(budgetLines).values(
          nonZero.map((l) => ({
            versionId,
            accountId: l.accountId,
            fiscalPeriodId: l.fiscalPeriodId,
            departmentId: l.departmentId ?? null,
            costCenterId: l.costCenterId ?? null,
            projectId: l.projectId ?? null,
            amount: Money.of(l.amount, budget.currency).toString(),
            notes: l.notes ?? null,
          })),
        );
      }
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BudgetVersion',
          entityId: versionId,
          newValue: { lineCount: nonZero.length },
          metadata: { actor: actor.email, budget: budget.code, version: version.name },
          companyId,
        },
        tx,
      );
    });
    return this.getVersion(companyId, budgetId, versionId);
  }

  /** Approving locks the lines, supersedes the previously approved version and activates the budget. */
  async approveVersion(
    companyId: string,
    actor: AuthenticatedUser,
    budgetId: string,
    versionId: string,
  ): Promise<BudgetDetail> {
    await this.db.transaction(async (tx) => {
      const budget = await this.lock(tx, companyId, budgetId);
      const version = await this.version(tx, budgetId, versionId, true);
      if (version.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${version.name} is already ${version.status.toLowerCase()}.`,
        );
      // No seeded policy pairs budget.manage with budget.approve, so this is a hook: a BLOCK policy would throw here.
      await this.sod.checkActorSeparation(
        actor.organizationId,
        ['budget.manage', 'budget.approve'],
        version.createdBy,
        actor.id,
        tx,
      );
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(budgetLines)
        .where(eq(budgetLines.versionId, versionId));
      if (count === 0)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'An empty version cannot be approved.',
        );
      await tx
        .update(budgetVersions)
        .set({ status: 'SUPERSEDED' })
        .where(and(eq(budgetVersions.budgetId, budgetId), eq(budgetVersions.status, 'APPROVED')));
      await tx
        .update(budgetVersions)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(budgetVersions.id, versionId));
      await tx.update(budgets).set({ status: 'ACTIVE' }).where(eq(budgets.id, budgetId));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'BudgetVersion',
          entityId: versionId,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'APPROVED' },
          metadata: { actor: actor.email, budget: budget.code, version: version.name },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, budgetId);
  }

  async removeVersion(companyId: string, budgetId: string, versionId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.lock(tx, companyId, budgetId);
      const version = await this.version(tx, budgetId, versionId, true);
      if (version.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only draft versions can be deleted.',
        );
      const [{ count } = { count: 0 }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(budgetVersions)
        .where(eq(budgetVersions.budgetId, budgetId));
      if (count <= 1)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'A budget keeps at least one version.',
        );
      await tx.delete(budgetVersions).where(eq(budgetVersions.id, versionId));
    });
  }

  // ---------------------------------------------------------------- variance

  /** Budget vs actual per account and period; actuals are posted journal lines in the year's periods. */
  async variance(
    companyId: string,
    budgetId: string,
    versionId: string | undefined,
    query: VarianceQuery,
  ): Promise<VarianceReport> {
    const budget = await this.get(companyId, budgetId);
    const version = versionId
      ? budget.versions.find((v) => v.id === versionId)
      : (budget.versions.find((v) => v.status === 'APPROVED') ?? budget.versions[0]);
    if (!version) throw new NotFoundError('Budget version', versionId ?? 'approved');
    const currency = budget.currency;
    let periods = budget.periods;
    if (query.toPeriodId) {
      const idx = periods.findIndex((p) => p.id === query.toPeriodId);
      if (idx < 0) throw new NotFoundError('Fiscal period', query.toPeriodId);
      periods = periods.slice(0, idx + 1);
    }
    const periodIds = periods.map((p) => p.id);
    if (periodIds.length === 0)
      throw new BusinessRuleError(ErrorCodes.VALIDATION_FAILED, 'The fiscal year has no periods.');

    // Budget side: lines of the version, filtered by the requested dimensions (unfiltered = all).
    const budgetFilters: SQL[] = [
      eq(budgetLines.versionId, version.id),
      inArray(budgetLines.fiscalPeriodId, periodIds),
    ];
    if (query.accountId) budgetFilters.push(eq(budgetLines.accountId, query.accountId));
    if (query.departmentId) budgetFilters.push(eq(budgetLines.departmentId, query.departmentId));
    if (query.costCenterId) budgetFilters.push(eq(budgetLines.costCenterId, query.costCenterId));
    if (query.projectId) budgetFilters.push(eq(budgetLines.projectId, query.projectId));
    const budgetRows = await this.db
      .select({
        accountId: budgetLines.accountId,
        periodId: budgetLines.fiscalPeriodId,
        amount: sql<string>`coalesce(sum(${budgetLines.amount}), 0)`,
      })
      .from(budgetLines)
      .where(and(...budgetFilters))
      .groupBy(budgetLines.accountId, budgetLines.fiscalPeriodId);

    // Actual side: posted journal lines in those periods.
    const actualFilters: SQL[] = [
      eq(journalEntries.companyId, companyId),
      inArray(journalEntries.status, [...LEDGER_STATUSES]),
      inArray(journalEntries.fiscalPeriodId, periodIds),
      ...dimensionConditions(query),
    ];
    if (query.accountId) actualFilters.push(eq(journalLines.accountId, query.accountId));
    else actualFilters.push(inArray(accounts.type, DEFAULT_TYPES));
    if (query.branchId) actualFilters.push(eq(journalLines.branchId, query.branchId));
    const actualRows = await this.db
      .select({
        accountId: journalLines.accountId,
        periodId: journalEntries.fiscalPeriodId,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(...actualFilters))
      .groupBy(journalLines.accountId, journalEntries.fiscalPeriodId);

    const accountIds = [
      ...new Set([...budgetRows.map((r) => r.accountId), ...actualRows.map((r) => r.accountId)]),
    ];
    const chart = accountIds.length ? await this.accounts.findByIds(companyId, accountIds) : [];
    const natural = (type: AccountType, debit: Money, credit: Money) =>
      type === 'ASSET' || type === 'EXPENSE' ? debit.subtract(credit) : credit.subtract(debit);

    const rows: VarianceRow[] = chart
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((account) => {
        const cells: VarianceCell[] = periods.map((p) => {
          const b = budgetRows.find((r) => r.accountId === account.id && r.periodId === p.id);
          const a = actualRows.find((r) => r.accountId === account.id && r.periodId === p.id);
          const budgetAmt = Money.of(b?.amount ?? '0', currency);
          const actualAmt = a
            ? natural(account.type, Money.of(a.debit, currency), Money.of(a.credit, currency))
            : Money.zero(currency);
          return {
            periodId: p.id,
            budget: budgetAmt.toString(),
            actual: actualAmt.toString(),
            variance: actualAmt.subtract(budgetAmt).toString(),
          };
        });
        const budgetTotal = Money.sum(
          cells.map((c) => Money.of(c.budget, currency)),
          currency,
        );
        const actualTotal = Money.sum(
          cells.map((c) => Money.of(c.actual, currency)),
          currency,
        );
        const variance = actualTotal.subtract(budgetTotal);
        return {
          accountId: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          cells,
          budget: budgetTotal.toString(),
          actual: actualTotal.toString(),
          variance: variance.toString(),
          variancePercent: budgetTotal.isZero()
            ? null
            : variance.divide(budgetTotal.abs().toString()).multiply('100').toString(),
        };
      });
    const total = (pred: (r: VarianceRow) => boolean) => {
      const budgetSum = Money.sum(
        rows.filter(pred).map((r) => Money.of(r.budget, currency)),
        currency,
      );
      const actualSum = Money.sum(
        rows.filter(pred).map((r) => Money.of(r.actual, currency)),
        currency,
      );
      return { budget: budgetSum, actual: actualSum, variance: actualSum.subtract(budgetSum) };
    };
    const revenue = total((r) => r.type === 'REVENUE');
    const expense = total((r) => r.type === 'EXPENSE');
    const str = (t: { budget: Money; actual: Money; variance: Money }) => ({
      budget: t.budget.toString(),
      actual: t.actual.toString(),
      variance: t.variance.toString(),
    });
    return {
      budgetId,
      versionId: version.id,
      versionName: version.name,
      currency,
      periods: periods.map((p) => ({ id: p.id, name: p.name, periodNumber: p.periodNumber })),
      rows,
      totals: {
        revenue: str(revenue),
        expense: str(expense),
        net: str({
          budget: revenue.budget.subtract(expense.budget),
          actual: revenue.actual.subtract(expense.actual),
          variance: revenue.variance.subtract(expense.variance),
        }),
      },
    };
  }

  // ----------------------------------------------------------------- helpers

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(budgets),
        fiscalYearName: fiscalYears.name,
        versionCount: sql<number>`(select count(*)::int from budget_versions v where v.budget_id = ${budgets.id})`,
        approvedVersionId: sql<
          string | null
        >`(select v.id from budget_versions v where v.budget_id = ${budgets.id} and v.status = 'APPROVED')`,
        approvedVersionName: sql<
          string | null
        >`(select v.name from budget_versions v where v.budget_id = ${budgets.id} and v.status = 'APPROVED')`,
        approvedTotal: sql<string>`(select coalesce(sum(l.amount), 0)::text from budget_lines l join budget_versions v on v.id = l.version_id where v.budget_id = ${budgets.id} and v.status = 'APPROVED')`,
      })
      .from(budgets)
      .innerJoin(fiscalYears, eq(fiscalYears.id, budgets.fiscalYearId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<Budget> {
    const [row] = await tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.id, id), eq(budgets.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Budget', id);
    return row;
  }

  private async version(
    tx: DbExecutor,
    budgetId: string,
    versionId: string,
    forUpdate = false,
  ): Promise<BudgetVersion> {
    const q = tx
      .select()
      .from(budgetVersions)
      .where(and(eq(budgetVersions.id, versionId), eq(budgetVersions.budgetId, budgetId)));
    const [row] = forUpdate ? await q.for('update') : await q;
    if (!row) throw new NotFoundError('Budget version', versionId);
    return row;
  }

  private async validateLines(
    tx: DbExecutor,
    companyId: string,
    budget: Budget,
    lines: readonly BudgetLineInput[],
  ): Promise<void> {
    if (lines.length === 0) return;
    const accountIds = [...new Set(lines.map((l) => l.accountId))];
    const chart = await this.accounts.findByIds(companyId, accountIds, tx);
    for (const id of accountIds) {
      const account = chart.find((a) => a.id === id);
      if (!account) throw new NotFoundError('Account', id);
      if (account.isHeader)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `${account.code} is a header account; budget postable accounts.`,
        );
    }
    const periodIds = [...new Set(lines.map((l) => l.fiscalPeriodId))];
    const periods = await tx
      .select({ id: fiscalPeriods.id })
      .from(fiscalPeriods)
      .where(
        and(
          eq(fiscalPeriods.fiscalYearId, budget.fiscalYearId),
          inArray(fiscalPeriods.id, periodIds),
        ),
      );
    if (periods.length !== periodIds.length)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'Every line must reference a period of the budget fiscal year.',
      );
    await this.dimensions.validateRefs(tx, companyId, lines);
    const seen = new Set<string>();
    for (const l of lines) {
      const key = [
        l.accountId,
        l.fiscalPeriodId,
        l.departmentId ?? '',
        l.costCenterId ?? '',
        l.projectId ?? '',
      ].join('|');
      if (seen.has(key))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'Duplicate budget cell (same account, period and dimensions).',
        );
      seen.add(key);
    }
  }
}
