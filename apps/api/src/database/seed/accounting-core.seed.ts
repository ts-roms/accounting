import { and, eq } from 'drizzle-orm';
import type { PostingRuleLine } from '../schema';
import * as schema from '../schema';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Accounting core extensions: posting rules for the common transaction
 * types, a dimension rule, a recurring accrual template and a draft
 * prepayment. Nothing here posts to the ledger - the templates are run and
 * the prepayment activated through the API, so the seeded statements stay
 * exactly as the other seeds leave them.
 */

const POSTING_RULES: Array<{
  transactionType: string;
  name: string;
  description: string;
  lines: PostingRuleLine[];
}> = [
  {
    transactionType: 'CUSTOMER_INVOICE',
    name: 'Customer invoice',
    description: 'Dr receivable for the gross amount; Cr revenue (line account) and output tax.',
    lines: [
      {
        side: 'DEBIT',
        accountSource: 'MAPPING',
        mappingKey: 'ACCOUNTS_RECEIVABLE',
        amountKey: 'GROSS',
      },
      { side: 'CREDIT', accountSource: 'CONTEXT', accountKey: 'REVENUE', amountKey: 'NET' },
      { side: 'CREDIT', accountSource: 'MAPPING', mappingKey: 'OUTPUT_VAT', amountKey: 'TAX' },
    ],
  },
  {
    transactionType: 'VENDOR_BILL',
    name: 'Vendor bill',
    description: 'Dr expense (line account) and input tax; Cr payable for the gross amount.',
    lines: [
      { side: 'DEBIT', accountSource: 'CONTEXT', accountKey: 'EXPENSE', amountKey: 'NET' },
      { side: 'DEBIT', accountSource: 'MAPPING', mappingKey: 'INPUT_VAT', amountKey: 'TAX' },
      {
        side: 'CREDIT',
        accountSource: 'MAPPING',
        mappingKey: 'ACCOUNTS_PAYABLE',
        amountKey: 'GROSS',
      },
    ],
  },
  {
    transactionType: 'CUSTOMER_RECEIPT',
    name: 'Customer receipt',
    description: 'Dr bank (context); Cr receivable.',
    lines: [
      { side: 'DEBIT', accountSource: 'CONTEXT', accountKey: 'BANK', amountKey: 'AMOUNT' },
      {
        side: 'CREDIT',
        accountSource: 'MAPPING',
        mappingKey: 'ACCOUNTS_RECEIVABLE',
        amountKey: 'AMOUNT',
      },
    ],
  },
  {
    transactionType: 'VENDOR_PAYMENT',
    name: 'Vendor payment',
    description: 'Dr payable; Cr bank (context), with withholding tax retained.',
    lines: [
      {
        side: 'DEBIT',
        accountSource: 'MAPPING',
        mappingKey: 'ACCOUNTS_PAYABLE',
        amountKey: 'GROSS',
      },
      { side: 'CREDIT', accountSource: 'CONTEXT', accountKey: 'BANK', amountKey: 'NET' },
      {
        side: 'CREDIT',
        accountSource: 'MAPPING',
        mappingKey: 'WITHHOLDING_TAX_PAYABLE',
        amountKey: 'WITHHOLDING',
      },
    ],
  },
];

export async function seedAccountingCore(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  let created = 0;
  for (const rule of POSTING_RULES) {
    const result = await tx
      .insert(schema.postingRules)
      .values({ companyId: company.id, ...rule })
      .onConflictDoNothing({
        target: [schema.postingRules.companyId, schema.postingRules.transactionType],
      })
      .returning({ id: schema.postingRules.id });
    created += result.length;
  }
  if (created) log(`posting rules seeded for ${company.code} (${created})`);

  // 6150 Project Consulting Fees must always carry a project.
  const consulting = codeToId.get('6150');
  if (consulting) {
    const [existing] = await tx
      .select({ id: schema.dimensionRules.id })
      .from(schema.dimensionRules)
      .where(
        and(
          eq(schema.dimensionRules.companyId, company.id),
          eq(schema.dimensionRules.accountId, consulting),
        ),
      );
    if (!existing) {
      await tx.insert(schema.dimensionRules).values({
        companyId: company.id,
        name: 'Consulting fees need a project',
        scope: 'ACCOUNT',
        accountId: consulting,
        dimensionType: 'PROJECT',
      });
      log(`dimension rule seeded for ${company.code}`);
    }
  }

  if (company.code !== 'ACME') return;

  const rent = codeToId.get('6200');
  const accrued = codeToId.get('2120');
  if (rent && accrued) {
    await tx
      .insert(schema.recurringJournals)
      .values({
        companyId: company.id,
        name: 'Monthly rent accrual',
        description: 'Accrue office rent for the month',
        reference: 'LEASE-HQ',
        journalType: 'ACCRUAL',
        frequency: 'MONTHLY',
        interval: 1,
        startDate: '2026-01-31',
        nextRunDate: '2026-01-31',
        mode: 'DRAFT',
        autoReverse: true,
        lines: [
          { accountId: rent, debit: '25000', credit: '0', description: 'Rent - current month' },
          { accountId: accrued, debit: '0', credit: '25000', description: 'Accrued rent' },
        ],
        createdBy: adminUserId,
      })
      .onConflictDoNothing({
        target: [schema.recurringJournals.companyId, schema.recurringJournals.name],
      });
  }

  const prepaid = codeToId.get('1400');
  const insurance = codeToId.get('6300');
  const bank = codeToId.get('1130');
  if (prepaid && insurance && bank) {
    const [existing] = await tx
      .select({ id: schema.prepayments.id })
      .from(schema.prepayments)
      .where(
        and(
          eq(schema.prepayments.companyId, company.id),
          eq(schema.prepayments.name, 'Annual insurance premium'),
        ),
      );
    if (!existing) {
      const [row] = await tx
        .insert(schema.prepayments)
        .values({
          companyId: company.id,
          name: 'Annual insurance premium',
          description: 'Fire and property insurance, 12 months from January',
          reference: 'POL-2026-0142',
          prepaidAccountId: prepaid,
          expenseAccountId: insurance,
          creditAccountId: bank,
          currency: company.baseCurrency,
          amount: '120000.0000',
          startDate: '2026-01-01',
          months: 12,
          createdBy: adminUserId,
        })
        .returning({ id: schema.prepayments.id });
      const schedule = Array.from({ length: 12 }, (_, i) => {
        const month = i + 1;
        const last = new Date(Date.UTC(2026, month, 0)).toISOString().slice(0, 10);
        return {
          prepaymentId: row!.id,
          companyId: company.id,
          sequence: month,
          recognitionDate: last,
          amount: '10000.0000',
        };
      });
      await tx.insert(schema.prepaymentSchedules).values(schedule);
      log(`prepayment schedule seeded for ${company.code}`);
    }
  }
}
