import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES, type SuspenseStatus } from '@accounting/types';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accountMappings,
  accountingPolicies,
  accounts,
  journalEntries,
  journalLines,
  users,
} from '@/database/schema';
import { GeneralLedgerService } from '../ledger/general-ledger.service';

export interface SuspenseLine {
  journalEntryId: string;
  documentNumber: string;
  entryDate: string;
  description: string | null;
  reference: string | null;
  sourceType: string | null;
  sourceId: string | null;
  debit: string;
  credit: string;
  ageDays: number;
}

export interface SuspenseAccountView {
  accountId: string;
  code: string;
  name: string;
  /** Signed by the account's normal side, base currency. */
  balance: string;
  /** Posted lines up to the date. */
  transactions: number;
  /** Lines since the balance was last zero - what still has to be explained. */
  openTransactions: number;
  /** Date of the first open line; null when clear. */
  openSince: string | null;
  /** Days the balance has been open as of the date. */
  ageDays: number;
  status: SuspenseStatus;
  /** Why the status is what it is. */
  reasons: string[];
  ownerUserId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  /** The open items, oldest first. */
  lines: SuspenseLine[];
}

export interface SuspenseMonitor {
  asOf: string;
  currency: string;
  /** Policy: absolute balance above which investigation is required (0 = any balance). */
  materiality: string;
  /** Policy: days a balance may stay open. */
  maxAgeDays: number;
  /** Sum of absolute balances. */
  totalBalance: string;
  requiresInvestigation: number;
  accounts: SuspenseAccountView[];
}

/**
 * Suspense / clearing account control. Accounts of subtype SUSPENSE and the
 * SUSPENSE / FIXED_ASSET_CLEARING / GOODS_RECEIVED_NOT_INVOICED mappings are
 * expected to return to zero. The monitor reports how much is parked in them,
 * since when, who owns them and whether the company policy
 * (`accounting_policies.suspense_materiality`, `suspense_max_age_days`)
 * requires investigation. Read-only: balances are the ledger's, and clearing
 * is a RECLASSIFICATION journal through the posting engine. Feeds
 * `GET /accounting/suspense`, the integrity check `SUSPENSE_BALANCE`, the
 * close task `SUSPENSE_BALANCES` and the control dashboard.
 */
@Injectable()
export class SuspenseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async monitor(
    companyId: string,
    asOf: string,
    executor: DbExecutor = this.db,
  ): Promise<SuspenseMonitor> {
    const currency = await this.ledger.currency(companyId, executor);
    const [policy] = await executor
      .select({
        suspenseMateriality: accountingPolicies.suspenseMateriality,
        suspenseMaxAgeDays: accountingPolicies.suspenseMaxAgeDays,
      })
      .from(accountingPolicies)
      .where(eq(accountingPolicies.companyId, companyId));
    const materiality = Money.of(policy?.suspenseMateriality ?? '0', currency);
    const maxAgeDays = policy?.suspenseMaxAgeDays ?? 30;

    const watched = executor
      .select({ id: accountMappings.accountId })
      .from(accountMappings)
      .where(
        and(
          eq(accountMappings.companyId, companyId),
          inArray(accountMappings.key, [
            'SUSPENSE',
            'FIXED_ASSET_CLEARING',
            'GOODS_RECEIVED_NOT_INVOICED',
          ]),
        ),
      );
    const rows = await executor
      .select({
        id: accounts.id,
        code: accounts.code,
        name: accounts.name,
        normalBalance: accounts.normalBalance,
        ownerUserId: accounts.ownerUserId,
        ownerEmail: users.email,
        ownerFirst: users.firstName,
        ownerLast: users.lastName,
      })
      .from(accounts)
      .leftJoin(users, eq(users.id, accounts.ownerUserId))
      .where(
        and(
          eq(accounts.companyId, companyId),
          eq(accounts.isHeader, false),
          eq(accounts.status, 'ACTIVE'),
          or(eq(accounts.subtype, 'SUSPENSE'), inArray(accounts.id, watched)),
        ),
      )
      .orderBy(asc(accounts.code));

    const views: SuspenseAccountView[] = [];
    let total = Money.zero(currency);
    for (const account of rows) {
      const lines = await executor
        .select({
          journalEntryId: journalEntries.id,
          documentNumber: journalEntries.documentNumber,
          entryDate: journalEntries.entryDate,
          description: journalLines.description,
          headerDescription: journalEntries.description,
          reference: journalEntries.reference,
          sourceType: journalEntries.sourceType,
          sourceId: journalEntries.sourceId,
          debit: journalLines.debit,
          credit: journalLines.credit,
        })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.accountId, account.id),
            inArray(journalEntries.status, [...LEDGER_STATUSES]),
            lte(journalEntries.entryDate, asOf),
          ),
        )
        .orderBy(
          asc(journalEntries.entryDate),
          asc(journalEntries.documentNumber),
          asc(journalLines.lineNumber),
        );

      const open = openItems(lines, currency);
      const openLines = lines.slice(lines.length - open.count).map((l) => ({
        journalEntryId: l.journalEntryId,
        documentNumber: l.documentNumber,
        entryDate: l.entryDate,
        description: l.description ?? l.headerDescription,
        reference: l.reference,
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        debit: l.debit,
        credit: l.credit,
        ageDays: daysBetween(l.entryDate, asOf),
      }));
      const ageDays = open.since ? daysBetween(open.since, asOf) : 0;
      const reasons: string[] = [];
      if (!open.balance.isZero()) {
        if (open.balance.abs().greaterThan(materiality))
          reasons.push(`Balance exceeds materiality of ${materiality.toString()}`);
        if (ageDays > maxAgeDays) reasons.push(`Open for ${ageDays} days (limit ${maxAgeDays})`);
      }
      const status: SuspenseStatus = open.balance.isZero()
        ? 'CLEAR'
        : reasons.length > 0
          ? 'REQUIRES_INVESTIGATION'
          : 'WITHIN_POLICY';
      total = total.add(open.balance.abs());
      views.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        balance: (account.normalBalance === 'DEBIT'
          ? open.balance
          : open.balance.negate()
        ).toString(),
        transactions: lines.length,
        openTransactions: open.count,
        openSince: open.since,
        ageDays,
        status,
        reasons,
        ownerUserId: account.ownerUserId,
        ownerEmail: account.ownerEmail,
        ownerName: account.ownerEmail ? `${account.ownerFirst} ${account.ownerLast}`.trim() : null,
        lines: openLines,
      });
    }
    return {
      asOf,
      currency,
      materiality: materiality.toString(),
      maxAgeDays,
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
  lines: ReadonlyArray<{ entryDate: string; debit: string; credit: string }>,
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
