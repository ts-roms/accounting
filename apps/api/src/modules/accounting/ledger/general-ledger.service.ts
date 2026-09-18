import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type AccountType, type JournalType } from '@accounting/types';
import type { GeneralLedgerQuery } from '@accounting/validation';
import { NotFoundError } from '@/common/errors/app-error';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { accounts, companies, journalEntries, journalLines, type Account } from '@/database/schema';

export interface LedgerLine {
  journalEntryId: string;
  documentNumber: string;
  entryDate: string;
  journalType: string;
  status: string;
  entryDescription: string;
  reference: string | null;
  lineDescription: string | null;
  debit: string;
  credit: string;
  /** Running balance signed by the account's normal balance side. */
  balance: string;
  branchId: string | null;
}

export interface LedgerResult {
  account: Pick<Account, 'id' | 'code' | 'name' | 'type' | 'normalBalance'>;
  currency: string;
  from: string;
  to: string;
  openingBalance: string;
  periodDebit: string;
  periodCredit: string;
  closingBalance: string;
  lines: LedgerLine[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AccountActivity {
  accountId: string;
  debit: string;
  credit: string;
}

/** Foreign-amount totals of one account in one currency (currency-bound accounts). */
export interface ForeignAccountActivity {
  accountId: string;
  currency: string;
  foreignDebit: string;
  foreignCredit: string;
}

export interface MonthlyAccountActivity extends AccountActivity {
  /** First day of the month (ISO date). */
  month: string;
}

export interface BalanceFilter {
  companyId: string;
  /** Inclusive lower bound (omit for all history). */
  from?: string;
  /** Inclusive upper bound. */
  to: string;
  branchId?: string;
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
  accountTypes?: readonly AccountType[];
  /**
   * Restrict to these accounts. Callers that need one control or bank balance
   * must pass it: the ledger then reads that account's lines through the
   * (company, account) index instead of aggregating the whole company.
   */
  accountIds?: readonly string[];
  /** Leave out engine journals (e.g. year-end CLOSING for the cash-flow statement). */
  excludeJournalTypes?: readonly JournalType[];
}

/** Sign a (debit - credit) net amount according to the account's normal side. */
export function signedBalance(net: Money, normalBalance: Account['normalBalance']): Money {
  return normalBalance === 'DEBIT' ? net : net.negate();
}

/** Optional dimension filters shared by every ledger read. */
export function dimensionConditions(filter: {
  departmentId?: string | null;
  costCenterId?: string | null;
  projectId?: string | null;
}): SQL[] {
  const out: SQL[] = [];
  if (filter.departmentId) out.push(eq(journalLines.departmentId, filter.departmentId));
  if (filter.costCenterId) out.push(eq(journalLines.costCenterId, filter.costCenterId));
  if (filter.projectId) out.push(eq(journalLines.projectId, filter.projectId));
  return out;
}

/**
 * Read model over posted journal lines. Every figure in every report starts
 * from `activity()`; nothing here is cached or maintained separately.
 */
@Injectable()
export class GeneralLedgerService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** WHERE clauses shared by every aggregate read; `null` when the filter can match nothing. */
  private conditions(filter: BalanceFilter): SQL[] | null {
    const conditions: SQL[] = [
      eq(journalEntries.companyId, filter.companyId),
      // Repeated on the line side so the (company, account) index applies.
      eq(journalLines.companyId, filter.companyId),
      inArray(journalEntries.status, [...LEDGER_STATUSES]),
      lte(journalEntries.entryDate, filter.to),
    ];
    if (filter.from) conditions.push(gte(journalEntries.entryDate, filter.from));
    if (filter.accountIds) {
      if (filter.accountIds.length === 0) return null;
      conditions.push(inArray(journalLines.accountId, [...filter.accountIds]));
    }
    if (filter.branchId) conditions.push(eq(journalLines.branchId, filter.branchId));
    conditions.push(...dimensionConditions(filter));
    if (filter.accountTypes) conditions.push(inArray(accounts.type, [...filter.accountTypes]));
    if (filter.excludeJournalTypes?.length)
      conditions.push(notInArray(journalEntries.journalType, [...filter.excludeJournalTypes]));
    return conditions;
  }

  /** Debit/credit totals per account for the filter window, from posted lines only. */
  async activity(
    filter: BalanceFilter,
    executor: DbExecutor = this.db,
  ): Promise<AccountActivity[]> {
    const conditions = this.conditions(filter);
    if (!conditions) return [];
    const rows = await executor
      .select({
        accountId: journalLines.accountId,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(...conditions))
      .groupBy(journalLines.accountId);
    return rows;
  }

  /**
   * Foreign-currency totals of the given accounts: the sum of the foreign amounts
   * carried by their posted lines, per currency. For an account bound to a
   * currency this is its balance in that currency (every line on it carries one).
   */
  async foreignActivity(
    filter: BalanceFilter & { accountIds: readonly string[] },
    executor: DbExecutor = this.db,
  ): Promise<ForeignAccountActivity[]> {
    const conditions = this.conditions(filter);
    if (!conditions) return [];
    conditions.push(isNotNull(journalLines.foreignCurrency));
    return executor
      .select({
        accountId: journalLines.accountId,
        currency: sql<string>`${journalLines.foreignCurrency}`,
        foreignDebit: sql<string>`coalesce(sum(${journalLines.foreignDebit}), 0)`,
        foreignCredit: sql<string>`coalesce(sum(${journalLines.foreignCredit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(...conditions))
      .groupBy(journalLines.accountId, journalLines.foreignCurrency);
  }

  /**
   * `activity()` split by calendar month of the entry date: one query for a
   * trend chart instead of one report per month.
   */
  async activityByMonth(
    filter: BalanceFilter,
    executor: DbExecutor = this.db,
  ): Promise<MonthlyAccountActivity[]> {
    const conditions = this.conditions(filter);
    if (!conditions) return [];
    const month = sql<string>`to_char(date_trunc('month', ${journalEntries.entryDate}), 'YYYY-MM-DD')`;
    const rows = await executor
      .select({
        month,
        accountId: journalLines.accountId,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(and(...conditions))
      .groupBy(month, journalLines.accountId);
    return rows;
  }

  async ledger(companyId: string, query: GeneralLedgerQuery): Promise<LedgerResult> {
    const [account] = await this.db
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        type: accounts.type,
        normalBalance: accounts.normalBalance,
        companyId: accounts.companyId,
      })
      .from(accounts)
      .where(and(eq(accounts.id, query.accountId), eq(accounts.companyId, companyId)));
    if (!account) throw new NotFoundError('Account', query.accountId);
    const currency = await this.currency(companyId);

    const base: SQL[] = [
      eq(journalEntries.companyId, companyId),
      eq(journalLines.companyId, companyId),
      eq(journalLines.accountId, account.id),
      inArray(journalEntries.status, [...LEDGER_STATUSES]),
    ];
    if (query.branchId) base.push(eq(journalLines.branchId, query.branchId));
    base.push(...dimensionConditions(query));

    const [opening] = await this.db
      .select({
        net: sql<string>`coalesce(sum(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(...base, lt(journalEntries.entryDate, query.from)));
    const openingNet = Money.of(opening?.net ?? '0', currency);

    const inRange = and(
      ...base,
      gte(journalEntries.entryDate, query.from),
      lte(journalEntries.entryDate, query.to),
    );
    const [totals] = await this.db
      .select({
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(inRange);

    const rows = await this.db
      .select({
        journalEntryId: journalEntries.id,
        documentNumber: journalEntries.documentNumber,
        entryDate: journalEntries.entryDate,
        journalType: journalEntries.journalType,
        status: journalEntries.status,
        entryDescription: journalEntries.description,
        reference: journalEntries.reference,
        lineDescription: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
        branchId: journalLines.branchId,
        // Cumulative net over the whole range (ordering is deterministic), independent of the page.
        running: sql<string>`sum(${journalLines.debit} - ${journalLines.credit}) over (order by ${journalEntries.entryDate}, ${journalEntries.documentNumber}, ${journalLines.lineNumber} rows between unbounded preceding and current row)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(inRange)
      .orderBy(
        asc(journalEntries.entryDate),
        asc(journalEntries.documentNumber),
        asc(journalLines.lineNumber),
      )
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const periodDebit = Money.of(totals?.debit ?? '0', currency);
    const periodCredit = Money.of(totals?.credit ?? '0', currency);
    const closingNet = openingNet.add(periodDebit).subtract(periodCredit);

    return {
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        type: account.type,
        normalBalance: account.normalBalance,
      },
      currency,
      from: query.from,
      to: query.to,
      openingBalance: signedBalance(openingNet, account.normalBalance).toString(),
      periodDebit: periodDebit.toString(),
      periodCredit: periodCredit.toString(),
      closingBalance: signedBalance(closingNet, account.normalBalance).toString(),
      lines: rows.map((r) => ({
        journalEntryId: r.journalEntryId,
        documentNumber: r.documentNumber,
        entryDate: r.entryDate,
        journalType: r.journalType,
        status: r.status,
        entryDescription: r.entryDescription,
        reference: r.reference,
        lineDescription: r.lineDescription,
        debit: Money.of(r.debit, currency).toString(),
        credit: Money.of(r.credit, currency).toString(),
        balance: signedBalance(
          openingNet.add(Money.of(r.running, currency)),
          account.normalBalance,
        ).toString(),
        branchId: r.branchId,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total: Number(totals?.count ?? 0),
    };
  }

  async currency(companyId: string, executor: DbExecutor = this.db): Promise<string> {
    const [row] = await executor
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new NotFoundError('Company', companyId);
    return row.baseCurrency;
  }
}
