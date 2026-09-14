import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type SuspenseStatus } from '@accounting/types';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import { accounts, journalEntries, journalLines } from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { ReconciliationsService } from './reconciliations.service';

export interface SuspenseAccountView {
  accountId: string;
  code: string;
  name: string;
  /** Debit-positive balance as of the date, base currency. */
  balance: string;
  /** Posted lines up to the date. */
  transactions: number;
  /** Lines since the balance was last zero (the open items). */
  openTransactions: number;
  /** Date of the first line since the balance was last zero; null when clear. */
  openSince: string | null;
  /** Days the balance has been open as of the date. */
  ageDays: number;
  status: SuspenseStatus;
  /** Why the status is what it is. */
  reasons: string[];
}

export interface SuspenseMonitor {
  asOf: string;
  currency: string;
  materiality: string;
  maxAgeDays: number;
  /** Sum of absolute balances. */
  totalBalance: string;
  requiresInvestigation: number;
  accounts: SuspenseAccountView[];
}

/**
 * Suspense / clearing account control (hardening phase 5). Accounts flagged
 * `is_suspense` are expected to return to zero; this service reports how much
 * is parked in them, since when, and whether the company policy
 * (`suspense_materiality`, `suspense_max_age_days`) requires investigation.
 * Balances are the ledger's - nothing is stored.
 */
@Injectable()
export class SuspenseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly policies: ReconciliationsService,
  ) {}

  async monitor(
    companyId: string,
    asOf: string,
    executor: DbExecutor = this.db,
  ): Promise<SuspenseMonitor> {
    const currency = await this.accounts.companyCurrency(companyId);
    const policy = await this.policies.policy(companyId, executor);
    const materiality = Money.of(policy.suspenseMateriality, currency);
    const watched = await executor
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
      })
      .from(accounts)
      .where(
        and(
          eq(accounts.companyId, companyId),
          eq(accounts.isSuspense, true),
          eq(accounts.status, 'ACTIVE'),
        ),
      )
      .orderBy(asc(accounts.code));
    const views: SuspenseAccountView[] = [];
    for (const account of watched) {
      const lines = await executor
        .select({
          entryDate: journalEntries.entryDate,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.accountId, account.id),
            eq(journalEntries.companyId, companyId),
            inArray(journalEntries.status, [...LEDGER_STATUSES]),
            lte(journalEntries.entryDate, asOf),
          ),
        )
        .orderBy(
          asc(journalEntries.entryDate),
          asc(journalEntries.createdAt),
          asc(journalLines.lineNumber),
        );
      const open = openItems(lines, currency);
      const balance = open.balance;
      const ageDays = open.since ? daysBetween(open.since, asOf) : 0;
      const reasons: string[] = [];
      if (!balance.isZero()) {
        if (balance.abs().greaterThan(materiality))
          reasons.push(`Balance exceeds materiality of ${materiality.toString()}`);
        if (ageDays > policy.suspenseMaxAgeDays)
          reasons.push(`Open for ${ageDays} days (limit ${policy.suspenseMaxAgeDays})`);
      }
      const status: SuspenseStatus = balance.isZero()
        ? 'CLEAR'
        : reasons.length > 0
          ? 'REQUIRES_INVESTIGATION'
          : 'WITHIN_POLICY';
      views.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        balance: balance.toString(),
        transactions: lines.length,
        openTransactions: open.count,
        openSince: open.since,
        ageDays,
        status,
        reasons,
      });
    }
    const total = views.reduce(
      (sum, v) => sum.add(Money.of(v.balance, currency).abs()),
      Money.zero(currency),
    );
    return {
      asOf,
      currency,
      materiality: materiality.toString(),
      maxAgeDays: policy.suspenseMaxAgeDays,
      totalBalance: total.toString(),
      requiresInvestigation: views.filter((v) => v.status === 'REQUIRES_INVESTIGATION').length,
      accounts: views,
    };
  }
}

/**
 * Walks the posted lines in date order and finds the open items: everything
 * after the last date on which the running balance returned to zero.
 */
export function openItems(
  lines: Array<{ entryDate: string; debit: string; credit: string }>,
  currency: string,
): { balance: Money; since: string | null; count: number } {
  let running = Money.zero(currency);
  let since: string | null = null;
  let count = 0;
  for (const line of lines) {
    running = running.add(Money.of(line.debit, currency)).subtract(Money.of(line.credit, currency));
    count += 1;
    if (since === null) since = line.entryDate;
    if (running.isZero()) {
      since = null;
      count = 0;
    }
  }
  return { balance: running, since, count };
}

function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.max(0, Math.floor(ms / 86_400_000));
}
