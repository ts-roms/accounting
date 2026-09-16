import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, lte, or } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { LEDGER_STATUSES } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import { accountMappings, accounts, journalEntries, journalLines, users } from '@/database/schema';
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
  /** Signed by the account's normal side. */
  balance: string;
  /** Lines since the balance was last zero - what still has to be explained. */
  unresolvedCount: number;
  oldestDate: string | null;
  oldestAgeDays: number;
  ownerUserId: string | null;
  ownerEmail: string | null;
  ownerName: string | null;
  lines: SuspenseLine[];
}

export interface SuspenseReport {
  asOf: string;
  currency: string;
  totalAbsoluteBalance: string;
  accounts: SuspenseAccountView[];
}

/**
 * Suspense monitor: accounts of subtype SUSPENSE (plus the SUSPENSE mapping)
 * with their balance, the postings that are still unexplained and their age.
 * Read-only - clearing is a RECLASSIFICATION journal through the engine.
 */
@Injectable()
export class SuspenseService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async report(companyId: string, asOf: string): Promise<SuspenseReport> {
    const currency = await this.ledger.currency(companyId);
    const mapped = this.db
      .select({ id: accountMappings.accountId })
      .from(accountMappings)
      .where(and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, 'SUSPENSE')));
    const rows = await this.db
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
          or(eq(accounts.subtype, 'SUSPENSE'), inArray(accounts.id, mapped)),
        ),
      )
      .orderBy(asc(accounts.code));

    const views: SuspenseAccountView[] = [];
    let totalAbs = Money.zero(currency);
    for (const account of rows) {
      const lines = await this.db
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

      // Walk the history: everything after the last zero balance is unresolved.
      let running = Money.zero(currency);
      let openFrom = 0;
      lines.forEach((line, index) => {
        running = running
          .add(Money.of(line.debit, currency))
          .subtract(Money.of(line.credit, currency));
        if (running.isZero()) openFrom = index + 1;
      });
      const open = lines.slice(openFrom).map((l) => ({
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
      const balance = account.normalBalance === 'DEBIT' ? running : running.negate();
      totalAbs = totalAbs.add(running.abs());
      const oldest = open[0]?.entryDate ?? null;
      views.push({
        accountId: account.id,
        code: account.code,
        name: account.name,
        balance: balance.toString(),
        unresolvedCount: open.length,
        oldestDate: oldest,
        oldestAgeDays: oldest ? daysBetween(oldest, asOf) : 0,
        ownerUserId: account.ownerUserId,
        ownerEmail: account.ownerEmail,
        ownerName: account.ownerEmail ? `${account.ownerFirst} ${account.ownerLast}`.trim() : null,
        lines: open,
      });
    }
    return { asOf, currency, totalAbsoluteBalance: totalAbs.toString(), accounts: views };
  }
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
