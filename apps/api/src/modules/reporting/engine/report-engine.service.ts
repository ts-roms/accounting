import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { DimensionType, PaginatedResult, ReportBasis } from '@accounting/types';
import type {
  CreateReportDefinitionInput,
  ListReportDefinitionsQuery,
  ReportColumnInput,
  ReportLayoutInput,
  ReportRowInput,
  RunReportInput,
  UpdateReportDefinitionInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  budgetLines,
  budgetVersions,
  budgets,
  dimensions,
  fiscalPeriods,
  fiscalYears,
  reportDefinitions,
  type ReportDefinition,
} from '@/database/schema';
import {
  GeneralLedgerService,
  type BalanceFilter,
} from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import {
  columnWindow,
  evaluateFormula,
  evaluationOrder,
  present,
  selectAccounts,
  SOURCE_COLUMN_KINDS,
  variance,
  variancePct,
  type DateWindow,
} from './report-engine.logic';
import { SYSTEM_REPORT_DEFINITIONS } from './system-reports';

const MODULE = 'REPORTING';

export interface ReportColumnResult {
  key: string;
  label: string;
  kind: ReportColumnInput['kind'];
  /** Ledger window read for source columns; null for variances. */
  from: string | null;
  to: string | null;
}

export interface ReportLineResult {
  key: string;
  label: string;
  kind: ReportRowInput['kind'] | 'ACCOUNT' | 'DIMENSION_VALUE';
  level: number;
  bold: boolean;
  /** Column key -> decimal string (variance % columns carry a percentage or null). */
  values: Record<string, string | null>;
  accountId?: string;
  dimensionId?: string;
}

export interface ReportResult {
  definition: { id: string | null; code: string | null; name: string; basis: ReportBasis };
  currency: string;
  params: RunReportInput;
  columns: ReportColumnResult[];
  rows: ReportLineResult[];
  generatedAt: string;
}

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  normalBalance: 'DEBIT' | 'CREDIT';
  isHeader: boolean;
}

type Activity = Map<string, { debit: Money; credit: Money }>;

/**
 * Reporting engine (hardening H7): runs stored or ad-hoc report definitions.
 * Every figure comes from the ledger through `GeneralLedgerService.activity`
 * (movement in a window or balance as of its end) or from approved budget
 * lines; formulas and variances are pure arithmetic over those figures. The
 * engine stores nothing and re-derives no balance itself.
 */
@Injectable()
export class ReportEngineService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ definitions

  async list(
    companyId: string,
    query: ListReportDefinitionsQuery,
  ): Promise<PaginatedResult<ReportDefinition>> {
    await this.ensureSystemDefinitions(companyId);
    const filters: SQL[] = [eq(reportDefinitions.companyId, companyId)];
    if (query.category) filters.push(eq(reportDefinitions.category, query.category));
    if (query.status) filters.push(eq(reportDefinitions.status, query.status));
    if (query.search)
      filters.push(
        sql`(${reportDefinitions.name} ilike ${`%${query.search}%`} or ${reportDefinitions.code} ilike ${`%${query.search}%`})`,
      );
    const where = and(...filters);
    const [items, total] = await Promise.all([
      this.db
        .select()
        .from(reportDefinitions)
        .where(where)
        .orderBy(
          desc(reportDefinitions.isSystem),
          asc(reportDefinitions.category),
          asc(reportDefinitions.name),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, reportDefinitions, where),
    ]);
    return toPaginatedResult(items, total, query);
  }

  async get(companyId: string, id: string): Promise<ReportDefinition> {
    const [row] = await this.db
      .select()
      .from(reportDefinitions)
      .where(and(eq(reportDefinitions.id, id), eq(reportDefinitions.companyId, companyId)));
    if (!row) throw new NotFoundError('Report definition', id);
    return row;
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateReportDefinitionInput,
  ): Promise<ReportDefinition> {
    return this.db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: reportDefinitions.id })
        .from(reportDefinitions)
        .where(
          and(eq(reportDefinitions.companyId, companyId), eq(reportDefinitions.code, input.code)),
        );
      if (dup) throw new DuplicateError('Report definition', 'code', input.code);
      const [row] = await tx
        .insert(reportDefinitions)
        .values({
          companyId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          category: input.category,
          basis: input.basis,
          layout: input.layout,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'ReportDefinition',
          entityId: row!.id,
          newValue: {
            code: input.code,
            name: input.name,
            rows: input.layout.rows.length,
            columns: input.layout.columns.length,
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateReportDefinitionInput,
  ): Promise<ReportDefinition> {
    return this.db.transaction(async (tx) => {
      const existing = await this.get(companyId, id);
      if (existing.isSystem && input.layout)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'System report definitions cannot be re-laid out; copy them into a custom report instead.',
        );
      const [row] = await tx
        .update(reportDefinitions)
        .set({
          name: input.name ?? existing.name,
          description: input.description === undefined ? existing.description : input.description,
          category: input.category ?? existing.category,
          basis: input.basis ?? existing.basis,
          layout: input.layout ?? existing.layout,
          status: input.status ?? existing.status,
        })
        .where(eq(reportDefinitions.id, id))
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'ReportDefinition',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status, basis: existing.basis },
          newValue: { name: row!.name, status: row!.status, basis: row!.basis },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  /** Copies a (system) definition into an editable custom one. */
  async copy(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    code: string,
    name: string,
  ): Promise<ReportDefinition> {
    const source = await this.get(companyId, id);
    return this.create(companyId, actor, {
      code,
      name,
      description: source.description ?? undefined,
      category: 'CUSTOM',
      basis: source.basis,
      layout: source.layout,
    });
  }

  /** Seeds the built-in definitions once per company (idempotent by code). */
  async ensureSystemDefinitions(companyId: string): Promise<void> {
    const existing = await this.db
      .select({ code: reportDefinitions.code })
      .from(reportDefinitions)
      .where(and(eq(reportDefinitions.companyId, companyId), eq(reportDefinitions.isSystem, true)));
    const have = new Set(existing.map((e) => e.code));
    const missing = SYSTEM_REPORT_DEFINITIONS.filter((d) => !have.has(d.code));
    if (missing.length === 0) return;
    await this.db
      .insert(reportDefinitions)
      .values(
        missing.map((d) => ({
          companyId,
          code: d.code,
          name: d.name,
          description: d.description,
          category: d.category,
          basis: d.basis,
          layout: d.layout,
          isSystem: true,
        })),
      )
      .onConflictDoNothing();
  }

  // -------------------------------------------------------------------- runs

  async run(companyId: string, id: string, params: RunReportInput): Promise<ReportResult> {
    const definition = await this.get(companyId, id);
    if (definition.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        'This report definition is inactive.',
      );
    return this.execute(
      companyId,
      { id: definition.id, code: definition.code, name: definition.name, basis: definition.basis },
      definition.layout,
      params,
    );
  }

  async runAdHoc(
    companyId: string,
    basis: ReportBasis,
    layout: ReportLayoutInput,
    params: RunReportInput,
  ): Promise<ReportResult> {
    return this.execute(
      companyId,
      { id: null, code: null, name: 'Ad-hoc report', basis },
      layout,
      params,
    );
  }

  private async execute(
    companyId: string,
    definition: ReportResult['definition'],
    layout: ReportLayoutInput,
    params: RunReportInput,
  ): Promise<ReportResult> {
    const currency = await this.ledger.currency(companyId);
    const fiscalYearStart = await this.fiscalYearStart(companyId, params.to);
    const filters = {
      branchId: params.branchId ?? layout.filters?.branchId ?? undefined,
      departmentId: params.departmentId ?? layout.filters?.departmentId ?? undefined,
      costCenterId: params.costCenterId ?? layout.filters?.costCenterId ?? undefined,
      projectId: params.projectId ?? layout.filters?.projectId ?? undefined,
    };
    const [chart, mappings] = await Promise.all([
      this.db
        .select({
          id: accounts.id,
          code: accounts.code,
          name: accounts.name,
          type: accounts.type,
          subtype: accounts.subtype,
          normalBalance: accounts.normalBalance,
          isHeader: accounts.isHeader,
        })
        .from(accounts)
        .where(eq(accounts.companyId, companyId))
        .orderBy(asc(accounts.code)),
      this.db
        .select({ key: accountMappings.key, accountId: accountMappings.accountId })
        .from(accountMappings)
        .where(eq(accountMappings.companyId, companyId)),
    ]);
    const mapped = new Map(mappings.map((m) => [m.key as string, m.accountId]));

    // Resolve every source column's window once; identical windows share one ledger read.
    const columns: ReportColumnResult[] = [];
    const windows = new Map<string, DateWindow | null>();
    for (const c of layout.columns) {
      const w = columnWindow(
        c,
        { from: params.from, to: params.to, fiscalYearStart },
        definition.basis,
      );
      windows.set(c.key, w);
      columns.push({
        key: c.key,
        label: c.label,
        kind: c.kind,
        from: w?.from ?? null,
        to: w?.to ?? null,
      });
    }
    const activityCache = new Map<string, Promise<Activity>>();
    const activityFor = (w: DateWindow, dims: Partial<BalanceFilter>): Promise<Activity> => {
      const cacheKey = JSON.stringify([w, dims]);
      let p = activityCache.get(cacheKey);
      if (!p) {
        p = this.ledger
          .activity({ companyId, from: w.from, to: w.to, ...filters, ...dims })
          .then(
            (rows) =>
              new Map(
                rows.map((r) => [
                  r.accountId,
                  { debit: Money.of(r.debit, currency), credit: Money.of(r.credit, currency) },
                ]),
              ),
          );
        activityCache.set(cacheKey, p);
      }
      return p;
    };
    const budgetCache = new Map<string, Promise<Map<string, Money>>>();
    const budgetFor = (
      w: DateWindow,
      dims: Partial<BalanceFilter>,
    ): Promise<Map<string, Money>> => {
      const cacheKey = JSON.stringify([w, dims]);
      let p = budgetCache.get(cacheKey);
      if (!p) {
        p = this.budgetAmounts(companyId, currency, w, { ...filters, ...dims }, params.budgetId);
        budgetCache.set(cacheKey, p);
      }
      return p;
    };

    const dimensionValues = new Map<
      DimensionType,
      Array<{ id: string; code: string; name: string }>
    >();
    for (const row of layout.rows) {
      if (
        row.kind === 'DIMENSION_GROUP' &&
        row.dimensionType &&
        !dimensionValues.has(row.dimensionType)
      ) {
        dimensionValues.set(
          row.dimensionType,
          await this.db
            .select({ id: dimensions.id, code: dimensions.code, name: dimensions.name })
            .from(dimensions)
            .where(
              and(
                eq(dimensions.companyId, companyId),
                eq(dimensions.dimensionType, row.dimensionType),
                eq(dimensions.status, 'ACTIVE'),
              ),
            )
            .orderBy(asc(dimensions.code)),
        );
      }
    }

    // Source-column figures per row (and per account / dimension value for expansions).
    const rowValues = new Map<string, Map<string, Money>>(); // rowKey -> colKey -> value
    const byRow = new Map<string, ReportRowInput>(layout.rows.map((r) => [r.key, r]));
    const lines: ReportLineResult[] = [];
    const sourceColumns = layout.columns.filter((c) => SOURCE_COLUMN_KINDS.includes(c.kind));

    const figure = async (
      col: ReportColumnInput,
      accts: AccountRow[],
      sign: ReportRowInput['sign'],
      dims: Partial<BalanceFilter>,
    ): Promise<Money> => {
      const w = windows.get(col.key);
      if (!w) return Money.zero(currency);
      if (col.kind === 'BUDGET') {
        const b = await budgetFor(w, dims);
        return accts.reduce((sum, a) => {
          const amount = b.get(a.id) ?? Money.zero(currency);
          // Budget amounts are stored on the account's natural side.
          const side = sign === 'NATURAL' ? a.normalBalance : sign;
          return sum.add(side === a.normalBalance ? amount : amount.negate());
        }, Money.zero(currency));
      }
      const act = await activityFor(w, dims);
      return accts.reduce((sum, a) => {
        const row = act.get(a.id);
        if (!row) return sum;
        return sum.add(present(row.debit, row.credit, a.normalBalance, sign));
      }, Money.zero(currency));
    };

    // Pass 1 - compute every row's figures in dependency order (formulas after their inputs).
    const emitted = new Map<string, ReportLineResult[]>(); // rowKey -> printed lines (row + expansions)
    for (const key of evaluationOrder(layout.rows)) {
      const row = byRow.get(key)!;
      const values = new Map<string, Money>();
      rowValues.set(key, values);
      const printed: ReportLineResult[] = [];
      emitted.set(key, printed);
      if (row.kind === 'HEADER') {
        printed.push({ key, label: row.label, kind: 'HEADER', level: 0, bold: true, values: {} });
        continue;
      }
      if (row.kind === 'FORMULA') {
        for (const c of sourceColumns) {
          const inputs = new Map<string, Money>();
          for (const [rk, rv] of rowValues) inputs.set(rk, rv.get(c.key) ?? Money.zero(currency));
          values.set(c.key, evaluateFormula(row.formula!, inputs, currency));
        }
        printed.push(this.line(row, values, layout.columns, 0));
        continue;
      }
      const accts = selectAccounts(chart, row.accounts!, mapped);
      if (row.kind === 'DIMENSION_GROUP') {
        const children: ReportLineResult[] = [];
        for (const dv of dimensionValues.get(row.dimensionType!) ?? []) {
          const dims = { [dimensionField(row.dimensionType!)]: dv.id } as Partial<BalanceFilter>;
          const dvValues = new Map<string, Money>();
          for (const c of sourceColumns)
            dvValues.set(c.key, await figure(c, accts, row.sign, dims));
          for (const [ck, v] of dvValues)
            values.set(ck, (values.get(ck) ?? Money.zero(currency)).add(v));
          if (params.includeZero || [...dvValues.values()].some((v) => !v.isZero()))
            children.push({
              ...this.line(
                { ...row, label: `${dv.code} ${dv.name}`, bold: false },
                dvValues,
                layout.columns,
                1,
              ),
              kind: 'DIMENSION_VALUE',
              dimensionId: dv.id,
            });
        }
        printed.push(
          { ...this.line(row, values, layout.columns, 0), kind: 'DIMENSION_GROUP' },
          ...children,
        );
        continue;
      }
      // ACCOUNTS
      const perAccount = new Map<string, Map<string, Money>>();
      for (const c of sourceColumns) {
        let total = Money.zero(currency);
        for (const a of accts) {
          const v = await figure(c, [a], row.sign, {});
          total = total.add(v);
          if (row.showAccounts) {
            if (!perAccount.has(a.id)) perAccount.set(a.id, new Map());
            perAccount.get(a.id)!.set(c.key, v);
          }
        }
        values.set(c.key, total);
      }
      printed.push(this.line(row, values, layout.columns, 0));
      if (row.showAccounts)
        for (const a of accts) {
          const av = perAccount.get(a.id) ?? new Map<string, Money>();
          if (!params.includeZero && [...av.values()].every((v) => v.isZero())) continue;
          printed.push({
            ...this.line(
              { ...row, label: `${a.code} ${a.name}`, bold: false },
              av,
              layout.columns,
              1,
            ),
            kind: 'ACCOUNT',
            accountId: a.id,
          });
        }
    }
    // Pass 2 - print in the layout's order, skipping hidden helper rows.
    for (const row of layout.rows) if (!row.hidden) lines.push(...(emitted.get(row.key) ?? []));
    return {
      definition,
      currency,
      params,
      columns,
      rows: lines,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Renders one printed line including variance columns. */
  private line(
    row: Pick<ReportRowInput, 'key' | 'label' | 'kind' | 'bold'>,
    values: Map<string, Money>,
    columns: ReportColumnInput[],
    level: number,
  ): ReportLineResult {
    const out: Record<string, string | null> = {};
    for (const c of columns) {
      if (c.kind === 'VARIANCE') {
        const base = values.get(c.base!);
        const against = values.get(c.against!);
        out[c.key] = base && against ? variance(base, against).toString() : null;
      } else if (c.kind === 'VARIANCE_PCT') {
        const base = values.get(c.base!);
        const against = values.get(c.against!);
        out[c.key] = base && against ? variancePct(base, against) : null;
      } else out[c.key] = values.get(c.key)?.toString() ?? null;
    }
    return { key: row.key, label: row.label, kind: row.kind, level, bold: row.bold, values: out };
  }

  /** Approved budget amounts per account whose fiscal period starts inside the window. */
  private async budgetAmounts(
    companyId: string,
    currency: string,
    w: DateWindow,
    filters: Partial<BalanceFilter>,
    budgetId?: string,
  ): Promise<Map<string, Money>> {
    const conditions: SQL[] = [
      eq(budgets.companyId, companyId),
      eq(budgetVersions.status, 'APPROVED'),
      lte(fiscalPeriods.startDate, w.to),
    ];
    if (w.from) conditions.push(gte(fiscalPeriods.startDate, w.from));
    if (budgetId) conditions.push(eq(budgets.id, budgetId));
    if (filters.departmentId) conditions.push(eq(budgetLines.departmentId, filters.departmentId));
    if (filters.costCenterId) conditions.push(eq(budgetLines.costCenterId, filters.costCenterId));
    if (filters.projectId) conditions.push(eq(budgetLines.projectId, filters.projectId));
    const rows = await this.db
      .select({
        accountId: budgetLines.accountId,
        amount: sql<string>`coalesce(sum(${budgetLines.amount}), 0)`,
      })
      .from(budgetLines)
      .innerJoin(budgetVersions, eq(budgetVersions.id, budgetLines.versionId))
      .innerJoin(budgets, eq(budgets.id, budgetVersions.budgetId))
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, budgetLines.fiscalPeriodId))
      .where(and(...conditions))
      .groupBy(budgetLines.accountId);
    return new Map(rows.map((r) => [r.accountId, Money.of(r.amount, currency)]));
  }

  private async fiscalYearStart(companyId: string, to: string): Promise<string> {
    const [year] = await this.db
      .select({ startDate: fiscalYears.startDate })
      .from(fiscalYears)
      .where(
        and(
          eq(fiscalYears.companyId, companyId),
          lte(fiscalYears.startDate, to),
          gte(fiscalYears.endDate, to),
        ),
      );
    return year?.startDate ?? `${to.slice(0, 4)}-01-01`;
  }
}

function dimensionField(type: DimensionType): 'departmentId' | 'costCenterId' | 'projectId' {
  return type === 'DEPARTMENT'
    ? 'departmentId'
    : type === 'COST_CENTER'
      ? 'costCenterId'
      : 'projectId';
}
