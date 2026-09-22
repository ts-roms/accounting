import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { BankAccountType } from '@accounting/types';
import type { CashPositionQuery } from '@accounting/validation';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  bankStatementLines,
  bankStatements,
  bankTransfers,
  companies,
  pettyCashFunds,
  type BankAccountProfile,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { BankingService } from '@/modules/banking/banking.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { businessToday } from '@/common/time/clock';
import { TreasuryConfigService } from './treasury-config.service';

export interface CashPositionAccount {
  bankAccountId: string;
  code: string;
  name: string;
  bankName: string | null;
  currency: string;
  accountType: BankAccountType;
  purpose: string | null;
  /** GL balance of the bank account in the account currency. */
  bookBalance: string;
  /** Closing balance of the latest statement on or before asOf, in the account currency. */
  statementBalance: string | null;
  statementDate: string | null;
  /** Statement lines not yet matched to the ledger (bank knows, books do not). */
  unreconciledIn: string;
  unreconciledOut: string;
  unreconciledCount: number;
  /** Money leaving this account in transfers not yet settled. */
  inTransitOut: string;
  /** Money arriving in this account in transfers not yet settled. */
  inTransitIn: string;
  minimumBalance: string | null;
  targetBalance: string | null;
  overdraftLimit: string | null;
  /** Book balance plus overdraft limit. */
  availableBalance: string;
  /** Negative when the book balance is under the minimum. */
  headroom: string | null;
  belowMinimum: boolean;
  /** Book balance converted to the company base currency at the asOf rate. */
  baseBalance: string;
  exchangeRate: string;
  excludeFromPosition: boolean;
}

export interface CashPosition {
  asOf: string;
  baseCurrency: string;
  accounts: CashPositionAccount[];
  byCurrency: Array<{ currency: string; balance: string; baseBalance: string; accounts: number }>;
  byBank: Array<{ bankName: string; baseBalance: string; accounts: number }>;
  totals: {
    bookBalance: string;
    availableBalance: string;
    inTransit: string;
    pettyCash: string;
    unreconciledCount: number;
    belowMinimum: number;
    excluded: number;
  };
}

/**
 * Cash position (Prompt #8): every bank account's book balance (the GL,
 * never stored), the latest statement balance, unreconciled statement
 * lines, transfers in flight and the treasury profile limits - converted to
 * base at the asOf rate and grouped by currency and bank.
 */
@Injectable()
export class CashPositionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly banking: BankingService,
    private readonly rates: ExchangeRatesService,
    private readonly config: TreasuryConfigService,
  ) {}

  async position(
    companyId: string,
    query: CashPositionQuery,
    executor: DbExecutor = this.db,
  ): Promise<CashPosition> {
    const asOf = query.asOf ?? businessToday();
    const baseCurrency = await this.accounts.companyCurrency(companyId, executor);
    const profiles = await this.config.profiles(companyId, executor);
    const rows = await executor
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.status, 'ACTIVE')))
      .orderBy(bankAccounts.code);
    const filtered = query.currency ? rows.filter((r) => r.currency === query.currency) : rows;
    const ids = filtered.map((r) => r.id);

    const [statements, unreconciled, transfers] = await Promise.all([
      this.latestStatements(ids, asOf, executor),
      this.unreconciledLines(ids, asOf, executor),
      this.inTransit(companyId, asOf, executor),
    ]);

    const organizationId = await this.organizationId(companyId, executor);
    const accounts: CashPositionAccount[] = [];
    for (const r of filtered) {
      const profile: Partial<BankAccountProfile> = profiles.get(r.id) ?? {};
      // Journal lines are in base: the GL balance is the base figure, re-expressed in the account currency at the asOf rate.
      const baseBook = Money.of(
        await this.banking.ledgerBalance(companyId, r.glAccountId, baseCurrency, asOf, executor),
        baseCurrency,
      );
      const rate = await this.rates.rateFor(
        organizationId,
        r.currency,
        baseCurrency,
        asOf,
        executor,
      );
      const book =
        r.currency === baseCurrency
          ? baseBook
          : baseBook.convert(r.currency, (1 / Number(rate)).toString());
      const overdraft = profile.overdraftLimit
        ? Money.of(profile.overdraftLimit, r.currency)
        : Money.zero(r.currency);
      const minimum = profile.minimumBalance ? Money.of(profile.minimumBalance, r.currency) : null;
      const stmt = statements.get(r.id);
      const un = unreconciled.get(r.id) ?? {
        in: Money.zero(r.currency),
        out: Money.zero(r.currency),
        count: 0,
      };
      const tr = transfers.get(r.id) ?? { in: Money.zero(r.currency), out: Money.zero(r.currency) };
      accounts.push({
        bankAccountId: r.id,
        code: r.code,
        name: r.name,
        bankName: r.bankName,
        currency: r.currency,
        accountType: profile.accountType ?? 'CURRENT',
        purpose: profile.purpose ?? null,
        bookBalance: book.toString(),
        statementBalance: stmt?.closingBalance ?? null,
        statementDate: stmt?.statementDate ?? null,
        unreconciledIn: un.in.toString(),
        unreconciledOut: un.out.toString(),
        unreconciledCount: un.count,
        inTransitOut: tr.out.toString(),
        inTransitIn: tr.in.toString(),
        minimumBalance: profile.minimumBalance ?? null,
        targetBalance: profile.targetBalance ?? null,
        overdraftLimit: profile.overdraftLimit ?? null,
        availableBalance: book.add(overdraft).toString(),
        headroom: minimum ? book.subtract(minimum).toString() : null,
        belowMinimum: minimum ? book.lessThan(minimum) : false,
        baseBalance: baseBook.toString(),
        exchangeRate: rate,
        excludeFromPosition: profile.excludeFromPosition ?? false,
      });
    }

    const included = accounts.filter((a) => !a.excludeFromPosition);
    const byCurrency = new Map<string, { balance: Money; base: Money; n: number }>();
    const byBank = new Map<string, { base: Money; n: number }>();
    let totalBook = Money.zero(baseCurrency);
    let totalAvailable = Money.zero(baseCurrency);
    let totalTransit = Money.zero(baseCurrency);
    let unreconciledCount = 0;
    for (const a of included) {
      const base = Money.of(a.baseBalance, baseCurrency);
      totalBook = totalBook.add(base);
      totalAvailable = totalAvailable.add(
        Money.of(a.availableBalance, a.currency).convert(baseCurrency, a.exchangeRate),
      );
      totalTransit = totalTransit.add(
        Money.of(a.inTransitIn, a.currency).convert(baseCurrency, a.exchangeRate),
      );
      unreconciledCount += a.unreconciledCount;
      const c = byCurrency.get(a.currency) ?? {
        balance: Money.zero(a.currency),
        base: Money.zero(baseCurrency),
        n: 0,
      };
      c.balance = c.balance.add(Money.of(a.bookBalance, a.currency));
      c.base = c.base.add(base);
      c.n += 1;
      byCurrency.set(a.currency, c);
      const bankKey = a.bankName ?? 'Unspecified bank';
      const b = byBank.get(bankKey) ?? { base: Money.zero(baseCurrency), n: 0 };
      b.base = b.base.add(base);
      b.n += 1;
      byBank.set(bankKey, b);
    }
    const [petty] = await executor
      .select({ total: sql<string>`coalesce(sum(${pettyCashFunds.imprestAmount}), 0)` })
      .from(pettyCashFunds)
      .where(and(eq(pettyCashFunds.companyId, companyId), eq(pettyCashFunds.status, 'ACTIVE')));

    return {
      asOf,
      baseCurrency,
      accounts,
      byCurrency: [...byCurrency.entries()].map(([currency, c]) => ({
        currency,
        balance: c.balance.toString(),
        baseBalance: c.base.toString(),
        accounts: c.n,
      })),
      byBank: [...byBank.entries()]
        .map(([bankName, b]) => ({ bankName, baseBalance: b.base.toString(), accounts: b.n }))
        .sort((x, y) => Number(y.baseBalance) - Number(x.baseBalance)),
      totals: {
        bookBalance: totalBook.toString(),
        availableBalance: totalAvailable.toString(),
        inTransit: totalTransit.toString(),
        pettyCash: Money.of(petty?.total ?? '0', baseCurrency).toString(),
        unreconciledCount,
        belowMinimum: included.filter((a) => a.belowMinimum).length,
        excluded: accounts.length - included.length,
      },
    };
  }

  private async latestStatements(ids: string[], asOf: string, executor: DbExecutor) {
    const out = new Map<string, { closingBalance: string; statementDate: string }>();
    if (!ids.length) return out;
    const rows = await executor
      .select({
        bankAccountId: bankStatements.bankAccountId,
        closingBalance: bankStatements.closingBalance,
        statementDate: bankStatements.statementDate,
      })
      .from(bankStatements)
      .where(
        and(inArray(bankStatements.bankAccountId, ids), lte(bankStatements.statementDate, asOf)),
      )
      .orderBy(desc(bankStatements.statementDate));
    for (const r of rows) if (!out.has(r.bankAccountId)) out.set(r.bankAccountId, r);
    return out;
  }

  private async unreconciledLines(ids: string[], asOf: string, executor: DbExecutor) {
    const out = new Map<string, { in: Money; out: Money; count: number }>();
    if (!ids.length) return out;
    const rows = await executor
      .select({
        bankAccountId: bankStatements.bankAccountId,
        currency: bankAccounts.currency,
        inflow: sql<string>`coalesce(sum(case when ${bankStatementLines.amount} > 0 then ${bankStatementLines.amount} else 0 end), 0)`,
        outflow: sql<string>`coalesce(sum(case when ${bankStatementLines.amount} < 0 then -${bankStatementLines.amount} else 0 end), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(
        and(
          inArray(bankStatements.bankAccountId, ids),
          inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          lte(bankStatementLines.lineDate, asOf),
        ),
      )
      .groupBy(bankStatements.bankAccountId, bankAccounts.currency);
    for (const r of rows)
      out.set(r.bankAccountId, {
        in: Money.of(r.inflow, r.currency),
        out: Money.of(r.outflow, r.currency),
        count: Number(r.count),
      });
    return out;
  }

  /** Transfers that had left the source but not reached the destination on asOf. */
  private async inTransit(companyId: string, asOf: string, executor: DbExecutor) {
    const out = new Map<string, { in: Money; out: Money }>();
    const rows = await executor
      .select()
      .from(bankTransfers)
      .where(
        and(
          eq(bankTransfers.companyId, companyId),
          lte(bankTransfers.transferDate, asOf),
          or(
            eq(bankTransfers.status, 'SENT'),
            and(eq(bankTransfers.status, 'SETTLED'), gt(bankTransfers.settlementDate, asOf)),
          ),
        ),
      );
    for (const t of rows) {
      const from = out.get(t.fromBankAccountId) ?? {
        in: Money.zero(t.fromCurrency),
        out: Money.zero(t.fromCurrency),
      };
      from.out = from.out.add(Money.of(t.amount, t.fromCurrency));
      out.set(t.fromBankAccountId, from);
      const to = out.get(t.toBankAccountId) ?? {
        in: Money.zero(t.toCurrency),
        out: Money.zero(t.toCurrency),
      };
      to.in = to.in.add(Money.of(t.receivedAmount, t.toCurrency));
      out.set(t.toBankAccountId, to);
    }
    return out;
  }

  private async organizationId(companyId: string, executor: DbExecutor): Promise<string> {
    const [row] = await executor
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    return row!.organizationId;
  }
}
