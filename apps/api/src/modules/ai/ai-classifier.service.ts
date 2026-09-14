import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AccountType } from '@accounting/types';
import type { AiClassifyInput } from '@accounting/validation';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  billLines,
  expenseClaimLines,
  expenseClaims,
  invoiceLines,
  invoices,
  journalEntries,
  journalLines,
  vendorBills,
} from '@/database/schema';
import { classifyByHistory, type AccountSuggestion, type HistoryRow } from './ai.logic';

/**
 * Suggests posting accounts (and the tax code that usually goes with them)
 * from what the company posted before. Purely advisory: the caller shows the
 * suggestion and the person picks. Nothing is learned from unposted drafts.
 */
@Injectable()
export class AiClassifierService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async classify(
    companyId: string,
    input: AiClassifyInput,
    executor: DbExecutor = this.db,
  ): Promise<AccountSuggestion[]> {
    const history = await this.history(companyId, input.side, executor);
    const ranked = classifyByHistory(history, input, input.limit);
    if (ranked.length) return ranked;
    // No history at all: fall back to the most generic postable account for the side.
    const fallbackType = input.side === 'SALE' ? 'REVENUE' : 'EXPENSE';
    const [acc] = await executor
      .select({ id: accounts.id, code: accounts.code, name: accounts.name })
      .from(accounts)
      .where(
        and(
          eq(accounts.companyId, companyId),
          eq(accounts.type, fallbackType),
          eq(accounts.isHeader, false),
          eq(accounts.status, 'ACTIVE'),
        ),
      )
      .orderBy(accounts.code)
      .limit(1);
    return acc
      ? [
          {
            accountId: acc.id,
            accountCode: acc.code,
            accountName: acc.name,
            taxCodeId: null,
            confidence: 0.2,
            rationale: `no posting history yet; first ${fallbackType.toLowerCase()} account`,
          },
        ]
      : [];
  }

  /** Aggregated line history per (account, description, party, tax code) for the side. */
  private async history(
    companyId: string,
    side: AiClassifyInput['side'],
    executor: DbExecutor,
  ): Promise<HistoryRow[]> {
    const rows: HistoryRow[] = [];
    if (side === 'PURCHASE' || side === 'EXPENSE') {
      const bills = await executor
        .select({
          accountId: billLines.accountId,
          accountCode: accounts.code,
          accountName: accounts.name,
          description: billLines.description,
          partyId: vendorBills.vendorId,
          taxCodeId: billLines.taxCodeId,
          uses: sql<number>`count(*)::int`,
        })
        .from(billLines)
        .innerJoin(vendorBills, eq(vendorBills.id, billLines.billId))
        .innerJoin(accounts, eq(accounts.id, billLines.accountId))
        .where(and(eq(vendorBills.companyId, companyId), ne(vendorBills.status, 'VOID')))
        .groupBy(
          billLines.accountId,
          accounts.code,
          accounts.name,
          billLines.description,
          vendorBills.vendorId,
          billLines.taxCodeId,
        )
        .orderBy(desc(sql`count(*)`))
        .limit(2000);
      rows.push(...bills);
      const claims = await executor
        .select({
          accountId: expenseClaimLines.accountId,
          accountCode: accounts.code,
          accountName: accounts.name,
          description: expenseClaimLines.description,
          partyId: sql<string | null>`null`,
          taxCodeId: expenseClaimLines.taxCodeId,
          uses: sql<number>`count(*)::int`,
        })
        .from(expenseClaimLines)
        .innerJoin(expenseClaims, eq(expenseClaims.id, expenseClaimLines.claimId))
        .innerJoin(accounts, eq(accounts.id, expenseClaimLines.accountId))
        .where(and(eq(expenseClaims.companyId, companyId), ne(expenseClaims.status, 'CANCELLED')))
        .groupBy(
          expenseClaimLines.accountId,
          accounts.code,
          accounts.name,
          expenseClaimLines.description,
          expenseClaimLines.taxCodeId,
        )
        .orderBy(desc(sql`count(*)`))
        .limit(1000);
      rows.push(...claims);
    } else {
      const sales = await executor
        .select({
          accountId: invoiceLines.accountId,
          accountCode: accounts.code,
          accountName: accounts.name,
          description: invoiceLines.description,
          partyId: invoices.customerId,
          taxCodeId: invoiceLines.taxCodeId,
          uses: sql<number>`count(*)::int`,
        })
        .from(invoiceLines)
        .innerJoin(invoices, eq(invoices.id, invoiceLines.invoiceId))
        .innerJoin(accounts, eq(accounts.id, invoiceLines.accountId))
        .where(and(eq(invoices.companyId, companyId), ne(invoices.status, 'VOID')))
        .groupBy(
          invoiceLines.accountId,
          accounts.code,
          accounts.name,
          invoiceLines.description,
          invoices.customerId,
          invoiceLines.taxCodeId,
        )
        .orderBy(desc(sql`count(*)`))
        .limit(2000);
      rows.push(...sales);
    }
    // Manual journals teach the classifier too, but only posted ones and only for the right account types.
    const types: AccountType[] =
      side === 'SALE' ? ['REVENUE'] : ['EXPENSE', 'COST_OF_SALES', 'ASSET'];
    const journals = await executor
      .select({
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        description: sql<string>`coalesce(${journalLines.description}, ${journalEntries.description})`,
        partyId: sql<string | null>`null`,
        taxCodeId: sql<string | null>`null`,
        uses: sql<number>`count(*)::int`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.status, 'POSTED'),
          isNull(journalEntries.sourceType),
          inArray(accounts.type, types),
        ),
      )
      .groupBy(
        journalLines.accountId,
        accounts.code,
        accounts.name,
        sql`coalesce(${journalLines.description}, ${journalEntries.description})`,
      )
      .orderBy(desc(sql`count(*)`))
      .limit(1000);
    rows.push(...journals);
    return rows;
  }
}
