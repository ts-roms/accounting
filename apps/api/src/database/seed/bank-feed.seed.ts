import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber } from './seed-ledger';

type Log = (message: string) => void;

/**
 * Bank feed demo (Prompt #12) for ACME: three matching rules (fees and
 * interest auto-apply, GCash settlements are suggested), default settings,
 * and one open statement on BDO-MAIN whose lines nothing in the ledger
 * explains yet - a fee, interest, a GCash settlement, a customer transfer
 * citing an open invoice, a cheque to a vendor for an open bill and a POS
 * purchase. Suggestions are generated the first time someone refreshes the
 * review queue (the seed never posts). The statement opens at the ledger
 * balance so the treasury drift check stays clean.
 */
export async function seedBankFeed(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [existing] = await tx
    .select({ id: schema.bankMatchingRules.id })
    .from(schema.bankMatchingRules)
    .where(eq(schema.bankMatchingRules.companyId, company.id));
  if (existing) return;
  const [bank] = await tx
    .select()
    .from(schema.bankAccounts)
    .where(
      and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, 'BDO-MAIN')),
    );
  if (!bank) return;
  const currency = company.baseCurrency;

  // ------------------------------------------------------------------- rules
  const RULES = [
    {
      name: 'Bank service fees',
      priority: 10,
      direction: 'OUT' as const,
      descriptionPattern: 'service fee',
      action: 'POST_TRANSACTION' as const,
      transactionType: 'BANK_FEE' as const,
      counterpartyAccountId: codeToId.get('6600')!,
      memo: 'Monthly bank service fee',
      autoApply: true,
    },
    {
      name: 'Interest credited',
      priority: 20,
      direction: 'IN' as const,
      descriptionPattern: 'interest',
      action: 'POST_TRANSACTION' as const,
      transactionType: 'INTEREST' as const,
      counterpartyAccountId: codeToId.get('4900')!,
      memo: 'Bank interest',
      autoApply: true,
    },
    {
      name: 'GCash settlements',
      priority: 30,
      direction: 'IN' as const,
      descriptionPattern: 'gcash',
      action: 'POST_TRANSACTION' as const,
      transactionType: 'DEPOSIT' as const,
      counterpartyAccountId: codeToId.get('4900')!,
      memo: 'GCash settlement (review the account)',
      autoApply: false,
    },
  ];
  for (const r of RULES)
    await tx.insert(schema.bankMatchingRules).values({
      companyId: company.id,
      name: r.name,
      priority: r.priority,
      bankAccountId: null,
      direction: r.direction,
      descriptionPattern: r.descriptionPattern,
      descriptionMode: 'CONTAINS',
      action: r.action,
      transactionType: r.transactionType,
      counterpartyAccountId: r.counterpartyAccountId,
      memo: r.memo,
      autoApply: r.autoApply,
      createdBy: adminUserId,
    });
  await tx.insert(schema.bankFeedSettings).values({ companyId: company.id }).onConflictDoNothing();

  // --------------------------------------------------------------- statement
  const [book] = await tx
    .select({
      balance: sql<string>`coalesce(sum(${schema.journalLines.debit} - ${schema.journalLines.credit}), 0)::text`,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.journalEntryId),
    )
    .where(
      and(
        eq(schema.journalLines.accountId, bank.glAccountId),
        inArray(schema.journalEntries.status, ['POSTED', 'LOCKED']),
      ),
    );
  const opening = Money.of(book?.balance ?? '0', currency);
  const [invoice] = await tx
    .select({
      number: schema.invoices.documentNumber,
      name: schema.customers.name,
      total: schema.invoices.total,
      allocated: schema.invoices.allocatedAmount,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(
      and(
        eq(schema.invoices.companyId, company.id),
        eq(schema.invoices.documentType, 'INVOICE'),
        eq(schema.invoices.accountingStatus, 'POSTED'),
        inArray(schema.invoices.status, ['APPROVED', 'PARTIALLY_PAID']),
        eq(schema.invoices.currency, currency),
      ),
    )
    .orderBy(schema.invoices.documentDate)
    .limit(1);
  const [bill] = await tx
    .select({
      number: schema.vendorBills.documentNumber,
      name: schema.vendors.name,
      total: schema.vendorBills.total,
      allocated: schema.vendorBills.allocatedAmount,
    })
    .from(schema.vendorBills)
    .innerJoin(schema.vendors, eq(schema.vendors.id, schema.vendorBills.vendorId))
    .where(
      and(
        eq(schema.vendorBills.companyId, company.id),
        eq(schema.vendorBills.documentType, 'INVOICE'),
        eq(schema.vendorBills.accountingStatus, 'POSTED'),
        inArray(schema.vendorBills.status, ['APPROVED', 'PARTIALLY_PAID']),
        eq(schema.vendorBills.currency, currency),
        eq(schema.vendorBills.onHold, false),
      ),
    )
    .orderBy(schema.vendorBills.documentDate)
    .limit(1);
  const open = (r: { total: string; allocated: string } | undefined) =>
    r ? Money.of(r.total, currency).subtract(Money.of(r.allocated, currency)).toString() : null;
  const LINES: Array<{
    date: string;
    description: string;
    reference: string | null;
    amount: string;
  }> = [
    {
      date: '2026-09-01',
      description: 'BANK SERVICE FEE SEP 2026',
      reference: null,
      amount: '-350',
    },
    {
      date: '2026-09-01',
      description: 'INTEREST CREDIT AUG 2026',
      reference: null,
      amount: '125.5',
    },
    {
      date: '2026-09-02',
      description: 'GCASH SETTLEMENT 20260902 REF 88213',
      reference: '88213',
      amount: '1200',
    },
    ...(invoice && open(invoice) && Number(open(invoice)) > 0
      ? [
          {
            date: '2026-09-03',
            description: `FUND TRANSFER FROM ${invoice.name.toUpperCase()} ${invoice.number}`,
            reference: invoice.number,
            amount: open(invoice)!,
          },
        ]
      : []),
    ...(bill && open(bill) && Number(open(bill)) > 0
      ? [
          {
            date: '2026-09-04',
            description: `CHECK 1042 ${bill.name.toUpperCase()}`,
            reference: '1042',
            amount: Money.of(open(bill)!, currency).negate().toString(),
          },
        ]
      : []),
    {
      date: '2026-09-04',
      description: 'POS PURCHASE 7-ELEVEN ORTIGAS',
      reference: null,
      amount: '-480',
    },
  ];
  const closing = LINES.reduce((m, l) => m.add(Money.of(l.amount, currency)), opening);
  const statementNumber = await allocateNumber(tx, company.id, 'STM', '2026-09-05');
  const [statement] = await tx
    .insert(schema.bankStatements)
    .values({
      companyId: company.id,
      statementNumber,
      bankAccountId: bank.id,
      statementDate: '2026-09-05',
      openingBalance: opening.toString(),
      closingBalance: closing.toString(),
      fileName: 'plaid:demo-feed-2026-09-05',
      importedBy: adminUserId,
    })
    .returning({ id: schema.bankStatements.id });
  let running = opening;
  await tx.insert(schema.bankStatementLines).values(
    LINES.map((l, i) => {
      running = running.add(Money.of(l.amount, currency));
      return {
        statementId: statement!.id,
        lineNumber: i + 1,
        lineDate: l.date,
        description: l.description,
        reference: l.reference,
        amount: Money.of(l.amount, currency).toString(),
        balance: running.toString(),
        status: 'UNMATCHED' as const,
        matchNote: 'No ledger line with this amount in the date window.',
      };
    }),
  );
  log(
    `Bank feed seeded for ${company.code} (${RULES.length} rules, statement ${statementNumber} with ${LINES.length} unexplained lines)`,
  );
}
