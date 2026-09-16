import { and, eq } from 'drizzle-orm';
import {
  NORMAL_BALANCE_BY_TYPE,
  type AccountMappingKey,
  type AccountSubtype,
  type AccountType,
  type NormalBalance,
} from '@accounting/types';
import * as schema from '../schema';
import type { Tx } from './seed';
import { insertEntry } from './seed-ledger';
import { seedAccountingCore } from './accounting-core.seed';
import { seedAssetsBanking } from './assets-banking.seed';
import { seedBudgetingTax } from './budgeting-tax.seed';
import { seedInventory } from './inventory.seed';
import { seedOrders } from './orders.seed';
import { seedSubledgers } from './subledger.seed';

type Log = (m: string) => void;

interface CoaRow {
  code: string;
  name: string;
  type: AccountType;
  parent?: string;
  subtype?: AccountSubtype;
  normalBalance?: NormalBalance;
  header?: boolean;
  system?: boolean;
  /** Eliminated in consolidated reports (Phase 8). */
  intercompany?: boolean;
  /** Reconciled against an external source (bank, subledger, authority). */
  reconciliation?: boolean;
}

/** A compact Philippine SME chart of accounts. Codes are stable identifiers. */
const CHART: CoaRow[] = [
  { code: '1000', name: 'Assets', type: 'ASSET', header: true },
  { code: '1100', name: 'Current Assets', type: 'ASSET', parent: '1000', header: true },
  { code: '1110', name: 'Cash on Hand', type: 'ASSET', parent: '1100', subtype: 'CASH' },
  { code: '1120', name: 'Petty Cash', type: 'ASSET', parent: '1100', subtype: 'CASH' },
  { code: '1130', name: 'Cash in Bank - BDO', type: 'ASSET', parent: '1100', subtype: 'BANK' },
  {
    code: '1200',
    name: 'Accounts Receivable',
    type: 'ASSET',
    parent: '1100',
    subtype: 'ACCOUNTS_RECEIVABLE',
  },
  {
    code: '1250',
    name: 'Allowance for Doubtful Accounts',
    type: 'ASSET',
    parent: '1100',
    normalBalance: 'CREDIT',
  },
  {
    code: '1290',
    name: 'Due from Affiliates',
    type: 'ASSET',
    parent: '1100',
    subtype: 'OTHER_ASSET',
    intercompany: true,
  },
  { code: '1300', name: 'Inventory', type: 'ASSET', parent: '1100', subtype: 'INVENTORY' },
  {
    code: '1900',
    name: 'Suspense / Clearing',
    type: 'ASSET',
    parent: '1100',
    subtype: 'SUSPENSE',
    reconciliation: true,
  },
  { code: '1400', name: 'Prepaid Expenses', type: 'ASSET', parent: '1100', subtype: 'PREPAID' },
  {
    code: '1460',
    name: 'Creditable Withholding Tax',
    type: 'ASSET',
    parent: '1100',
    subtype: 'OTHER_ASSET',
  },
  { code: '1450', name: 'Input VAT', type: 'ASSET', parent: '1100', subtype: 'OTHER_ASSET' },
  { code: '1500', name: 'Non-current Assets', type: 'ASSET', parent: '1000', header: true },
  {
    code: '1510',
    name: 'Property and Equipment',
    type: 'ASSET',
    parent: '1500',
    subtype: 'FIXED_ASSET',
  },
  {
    code: '1590',
    name: 'Fixed Asset Clearing',
    type: 'ASSET',
    parent: '1500',
    subtype: 'OTHER_ASSET',
  },
  {
    code: '1520',
    name: 'Accumulated Depreciation',
    type: 'ASSET',
    parent: '1500',
    subtype: 'ACCUMULATED_DEPRECIATION',
    normalBalance: 'CREDIT',
  },
  { code: '2000', name: 'Liabilities', type: 'LIABILITY', header: true },
  { code: '2100', name: 'Current Liabilities', type: 'LIABILITY', parent: '2000', header: true },
  {
    code: '2110',
    name: 'Accounts Payable',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'ACCOUNTS_PAYABLE',
  },
  {
    code: '2120',
    name: 'Accrued Expenses',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'ACCRUED_LIABILITY',
  },
  { code: '2130', name: 'Output VAT', type: 'LIABILITY', parent: '2100', subtype: 'TAX_PAYABLE' },
  {
    code: '2140',
    name: 'Withholding Tax Payable',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'TAX_PAYABLE',
  },
  {
    code: '2150',
    name: 'Income Tax Payable',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'TAX_PAYABLE',
  },
  {
    code: '2180',
    name: 'Due to Affiliates',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'OTHER_LIABILITY',
    intercompany: true,
  },
  {
    code: '2170',
    name: 'Due to Employees',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'OTHER_LIABILITY',
  },
  {
    code: '2160',
    name: 'Goods Received Not Invoiced',
    type: 'LIABILITY',
    parent: '2100',
    subtype: 'ACCRUED_LIABILITY',
  },
  {
    code: '2200',
    name: 'Non-current Liabilities',
    type: 'LIABILITY',
    parent: '2000',
    header: true,
  },
  { code: '2210', name: 'Loans Payable', type: 'LIABILITY', parent: '2200', subtype: 'LOAN' },
  { code: '3000', name: 'Equity', type: 'EQUITY', header: true },
  { code: '3100', name: 'Share Capital', type: 'EQUITY', parent: '3000', subtype: 'SHARE_CAPITAL' },
  {
    code: '3300',
    name: 'Revaluation Surplus',
    type: 'EQUITY',
    parent: '3000',
    subtype: 'OTHER_EQUITY',
  },
  {
    code: '3200',
    name: 'Retained Earnings',
    type: 'EQUITY',
    parent: '3000',
    subtype: 'RETAINED_EARNINGS',
    system: true,
  },
  {
    code: '3900',
    name: 'Opening Balance Equity',
    type: 'EQUITY',
    parent: '3000',
    subtype: 'OTHER_EQUITY',
    system: true,
  },
  { code: '4000', name: 'Revenue', type: 'REVENUE', header: true },
  { code: '4100', name: 'Sales Revenue', type: 'REVENUE', parent: '4000', subtype: 'SALES' },
  { code: '4200', name: 'Service Revenue', type: 'REVENUE', parent: '4000', subtype: 'SALES' },
  { code: '4900', name: 'Other Income', type: 'REVENUE', parent: '4000', subtype: 'OTHER_INCOME' },
  {
    code: '4910',
    name: 'Realized FX Gain',
    type: 'REVENUE',
    parent: '4000',
    subtype: 'OTHER_INCOME',
  },
  {
    code: '4930',
    name: 'Unrealized FX Gain',
    type: 'REVENUE',
    parent: '4000',
    subtype: 'OTHER_INCOME',
  },
  {
    code: '4920',
    name: 'Gain / (Loss) on Asset Disposal',
    type: 'REVENUE',
    parent: '4000',
    subtype: 'OTHER_INCOME',
  },
  { code: '5000', name: 'Cost of Sales', type: 'COST_OF_SALES', header: true },
  {
    code: '5100',
    name: 'Cost of Goods Sold',
    type: 'COST_OF_SALES',
    parent: '5000',
    subtype: 'COST_OF_GOODS_SOLD',
  },
  {
    code: '5200',
    name: 'Inventory Adjustments',
    type: 'COST_OF_SALES',
    parent: '5000',
    subtype: 'COST_OF_GOODS_SOLD',
  },
  {
    code: '5300',
    name: 'Purchase Price Variance',
    type: 'COST_OF_SALES',
    parent: '5000',
    subtype: 'COST_OF_GOODS_SOLD',
  },
  { code: '6000', name: 'Operating Expenses', type: 'EXPENSE', header: true },
  {
    code: '6100',
    name: 'Salaries and Wages',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6200',
    name: 'Rent Expense',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6300',
    name: 'Utilities Expense',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6400',
    name: 'Office Supplies Expense',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6500',
    name: 'Depreciation Expense',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'DEPRECIATION_EXPENSE',
  },
  {
    code: '6600',
    name: 'Bank Charges',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6700',
    name: 'Professional Fees',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OPERATING_EXPENSE',
  },
  {
    code: '6800',
    name: 'Taxes and Licenses',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'TAX_EXPENSE',
  },
  {
    code: '6910',
    name: 'Realized FX Loss',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OTHER_EXPENSE',
  },
  {
    code: '6960',
    name: 'Unrealized FX Loss',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OTHER_EXPENSE',
  },
  {
    code: '6950',
    name: 'Impairment Loss',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OTHER_EXPENSE',
  },
  {
    code: '6900',
    name: 'Miscellaneous Expense',
    type: 'EXPENSE',
    parent: '6000',
    subtype: 'OTHER_EXPENSE',
  },
  { code: '7000', name: 'Other Income', type: 'OTHER_INCOME', header: true },
  { code: '7100', name: 'Interest Income', type: 'OTHER_INCOME', parent: '7000', subtype: 'OTHER_INCOME' },
  { code: '8000', name: 'Other Expenses', type: 'OTHER_EXPENSE', header: true },
  {
    code: '8100',
    name: 'Interest Expense',
    type: 'OTHER_EXPENSE',
    parent: '8000',
    subtype: 'OTHER_EXPENSE',
  },
  { code: '6150', name: 'Project Consulting Fees', type: 'EXPENSE', parent: '6000' },
];

const MAPPINGS: Array<[AccountMappingKey, string]> = [
  ['RETAINED_EARNINGS', '3200'],
  ['ACCOUNTS_RECEIVABLE', '1200'],
  ['ACCOUNTS_PAYABLE', '2110'],
  ['INVENTORY', '1300'],
  ['COST_OF_GOODS_SOLD', '5100'],
  ['INVENTORY_ADJUSTMENT', '5200'],
  ['FIXED_ASSET_COST', '1510'],
  ['ACCUMULATED_DEPRECIATION', '1520'],
  ['DEPRECIATION_EXPENSE', '6500'],
  ['FIXED_ASSET_CLEARING', '1590'],
  ['GAIN_LOSS_ON_DISPOSAL', '4920'],
  ['IMPAIRMENT_LOSS', '6950'],
  ['REVALUATION_SURPLUS', '3300'],
  ['EMPLOYEE_PAYABLE', '2170'],
  ['FX_GAIN', '4910'],
  ['FX_LOSS', '6910'],
  ['UNREALIZED_FX_GAIN', '4930'],
  ['UNREALIZED_FX_LOSS', '6960'],
  ['INTERCOMPANY_RECEIVABLE', '1290'],
  ['INTERCOMPANY_PAYABLE', '2180'],
  ['GOODS_RECEIVED_NOT_INVOICED', '2160'],
  ['PURCHASE_PRICE_VARIANCE', '5300'],
  ['SALES_REVENUE', '4100'],
  ['DEFAULT_EXPENSE', '6900'],
  ['OUTPUT_VAT', '2130'],
  ['INPUT_VAT', '1450'],
  ['WITHHOLDING_TAX_PAYABLE', '2140'],
  ['BANK_CHARGES', '6600'],
  ['OPENING_BALANCE_EQUITY', '3900'],
  ['SUSPENSE', '1900'],
];

interface SampleLine {
  code: string;
  debit?: string;
  credit?: string;
  memo?: string;
}
interface SampleEntry {
  date: string;
  description: string;
  reference?: string;
  status: 'POSTED' | 'SUBMITTED';
  lines: SampleLine[];
}

/**
 * Journal-only sample entries (capital, expenses, accruals, depreciation).
 * Sales, purchases and their settlements are seeded as AR/AP documents in
 * subledger.seed.ts so that the subledgers reconcile to the ledger.
 */
const SAMPLE_ENTRIES: SampleEntry[] = [
  {
    date: '2026-01-02',
    description: 'Initial capital contribution',
    reference: 'CAP-001',
    status: 'POSTED',
    lines: [
      { code: '1130', debit: '1000000' },
      { code: '3100', credit: '1000000' },
    ],
  },
  {
    date: '2026-01-15',
    description: 'Cost of goods sold for INV-2026-000001',
    reference: 'INV-2026-000001',
    status: 'POSTED',
    lines: [
      { code: '5100', debit: '60000', memo: 'COGS' },
      { code: '1300', credit: '60000', memo: 'Inventory relieved' },
    ],
  },
  {
    date: '2026-01-31',
    description: 'Office rent for January',
    reference: 'CV-0002',
    status: 'POSTED',
    lines: [
      { code: '6200', debit: '25000' },
      { code: '1130', credit: '25000' },
    ],
  },
  {
    date: '2026-02-15',
    description: 'Salaries for February net of withholding tax',
    reference: 'PAY-2026-02',
    status: 'POSTED',
    lines: [
      { code: '6100', debit: '80000' },
      { code: '1130', credit: '76000' },
      { code: '2140', credit: '4000' },
    ],
  },
  {
    date: '2026-02-28',
    description: 'Accrual of February utilities',
    status: 'POSTED',
    lines: [
      { code: '6300', debit: '8500' },
      { code: '2120', credit: '8500' },
    ],
  },
  {
    date: '2026-03-10',
    description: 'Consulting services rendered, paid in cash',
    reference: 'OR-0002',
    status: 'POSTED',
    lines: [
      { code: '1130', debit: '44800' },
      { code: '4200', credit: '40000' },
      { code: '2130', credit: '4800' },
    ],
  },
  {
    date: '2026-03-31',
    // Accrual: depreciation itself only ever comes from the asset register (Phase 6).
    description: 'Accrued electricity for March',
    status: 'POSTED',
    lines: [
      { code: '6300', debit: '2000' },
      { code: '2120', credit: '2000' },
    ],
  },
  {
    date: '2026-04-02',
    description: 'Office supplies purchased from petty cash',
    reference: 'PCV-0007',
    status: 'SUBMITTED',
    lines: [
      { code: '6400', debit: '2500' },
      { code: '1120', credit: '2500' },
    ],
  },
];

export async function seedAccounting(
  tx: Tx,
  organizationId: string,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const companyRows = await tx
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.organizationId, organizationId));
  for (const company of companyRows) {
    const codeToId = await ensureChart(tx, company.id, log);
    await ensureMappings(tx, company.id, codeToId);
    await ensureFiscalYear(tx, company.id, '2026-01-01', log);
    if (company.code === 'ACME') {
      await ensureSampleEntries(tx, company, codeToId, adminUserId, log);
    }
    await seedSubledgers(tx, company, codeToId, adminUserId, log);
    await seedOrders(tx, company, codeToId, adminUserId, log);
    await seedInventory(tx, company, adminUserId, log);
    await seedAssetsBanking(tx, company, codeToId, log);
    await seedBudgetingTax(tx, company, codeToId, adminUserId, log);
    await seedAccountingCore(tx, company, codeToId, adminUserId, log);
  }
  await seedExchangeRates(tx, organizationId, adminUserId, log);
}

/** Organization-wide sample rates (Phase 8): USD and EUR against the PHP base. */
async function seedExchangeRates(
  tx: Tx,
  organizationId: string,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const rates = [
    { fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-01-01', rate: '56.00000000' },
    { fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-07-01', rate: '57.50000000' },
    { fromCurrency: 'EUR', toCurrency: 'PHP', rateDate: '2026-01-01', rate: '61.00000000' },
  ];
  for (const r of rates) {
    await tx
      .insert(schema.exchangeRates)
      .values({ organizationId, ...r, source: 'SYSTEM', createdBy: adminUserId })
      .onConflictDoNothing();
  }
  log('exchange rates ensured');
}

async function ensureChart(tx: Tx, companyId: string, log: Log): Promise<Map<string, string>> {
  const existing = await tx
    .select({ id: schema.accounts.id, code: schema.accounts.code })
    .from(schema.accounts)
    .where(eq(schema.accounts.companyId, companyId));
  const codeToId = new Map(existing.map((a) => [a.code, a.id]));
  let created = 0;
  for (const row of CHART) {
    if (codeToId.has(row.code)) continue;
    const parentId = row.parent ? codeToId.get(row.parent) : null;
    if (row.parent && !parentId)
      throw new Error(`Seed chart: parent ${row.parent} must precede ${row.code}`);
    const [inserted] = await tx
      .insert(schema.accounts)
      .values({
        companyId,
        code: row.code,
        name: row.name,
        type: row.type,
        subtype: row.subtype ?? null,
        normalBalance: row.normalBalance ?? NORMAL_BALANCE_BY_TYPE[row.type],
        parentId: parentId ?? null,
        isHeader: row.header ?? false,
        isSystem: row.system ?? false,
        isIntercompany: row.intercompany ?? false,
        isReconciliation: row.reconciliation ?? false,
      })
      .returning({ id: schema.accounts.id });
    codeToId.set(row.code, inserted!.id);
    created += 1;
  }
  if (created > 0) log(`chart of accounts: ${created} accounts created`);
  return codeToId;
}

async function ensureMappings(
  tx: Tx,
  companyId: string,
  codeToId: Map<string, string>,
): Promise<void> {
  for (const [key, code] of MAPPINGS) {
    const accountId = codeToId.get(code);
    if (!accountId) continue;
    await tx
      .insert(schema.accountMappings)
      .values({ companyId, key, accountId })
      .onConflictDoNothing({
        target: [schema.accountMappings.companyId, schema.accountMappings.key],
      });
  }
}

async function ensureFiscalYear(
  tx: Tx,
  companyId: string,
  startDate: string,
  log: Log,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.fiscalYears.id })
    .from(schema.fiscalYears)
    .where(
      and(eq(schema.fiscalYears.companyId, companyId), eq(schema.fiscalYears.startDate, startDate)),
    );
  if (existing) return;
  const year = Number(startDate.slice(0, 4));
  const [fy] = await tx
    .insert(schema.fiscalYears)
    .values({ companyId, name: `FY${year}`, startDate, endDate: `${year}-12-31` })
    .returning({ id: schema.fiscalYears.id });
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  await tx.insert(schema.fiscalPeriods).values(
    months.map((name, i) => {
      const m = String(i + 1).padStart(2, '0');
      const lastDay = new Date(Date.UTC(year, i + 1, 0)).getUTCDate();
      return {
        fiscalYearId: fy!.id,
        companyId,
        periodNumber: i + 1,
        name: `${name} ${year}`,
        startDate: `${year}-${m}-01`,
        endDate: `${year}-${m}-${lastDay}`,
      };
    }),
  );
  log(`fiscal year FY${year} created with 12 periods`);
}

async function ensureSampleEntries(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const [any] = await tx
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.companyId, company.id))
    .limit(1);
  if (any) return;
  for (const sample of SAMPLE_ENTRIES) {
    await insertEntry(
      tx,
      company,
      {
        date: sample.date,
        description: sample.description,
        reference: sample.reference ?? null,
        status: sample.status,
        lines: sample.lines.map((l) => ({
          accountId: codeToId.get(l.code)!,
          debit: l.debit,
          credit: l.credit,
          memo: l.memo ?? null,
        })),
      },
      adminUserId,
    );
  }
  log(`sample journal entries created for ${company.code} (${SAMPLE_ENTRIES.length})`);
}
