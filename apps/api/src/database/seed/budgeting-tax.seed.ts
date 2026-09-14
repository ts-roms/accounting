import { and, asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Phase 7 sample master data: cost dimensions, tax codes with effective-dated
 * rates (Philippine-flavoured defaults, all data) and a first budget for the
 * current fiscal year so the variance report has something to compare.
 */
const DIMENSIONS = [
  { dimensionType: 'DEPARTMENT' as const, code: 'ADMIN', name: 'Administration' },
  { dimensionType: 'DEPARTMENT' as const, code: 'SALES', name: 'Sales & Marketing' },
  { dimensionType: 'DEPARTMENT' as const, code: 'OPS', name: 'Operations' },
  { dimensionType: 'COST_CENTER' as const, code: 'CC-HQ', name: 'Head Office' },
  { dimensionType: 'COST_CENTER' as const, code: 'CC-WH', name: 'Warehouse' },
  {
    dimensionType: 'PROJECT' as const,
    code: 'PRJ-ERP',
    name: 'ERP Rollout',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
  },
];

const TAX_CODES = [
  {
    code: 'VAT12',
    name: 'VAT 12%',
    kind: 'SALES_TAX' as const,
    appliesTo: 'BOTH' as const,
    reportingCategory: 'TAXABLE' as const,
    salesCode: '2130',
    purchaseCode: '1450',
    isDefaultSales: true,
    isDefaultPurchases: true,
    rate: '12',
  },
  {
    code: 'VAT0',
    name: 'VAT zero-rated',
    kind: 'SALES_TAX' as const,
    appliesTo: 'BOTH' as const,
    reportingCategory: 'ZERO_RATED' as const,
    salesCode: '2130',
    purchaseCode: '1450',
    isDefaultSales: false,
    isDefaultPurchases: false,
    rate: '0',
  },
  {
    code: 'EXEMPT',
    name: 'VAT exempt',
    kind: 'SALES_TAX' as const,
    appliesTo: 'BOTH' as const,
    reportingCategory: 'EXEMPT' as const,
    salesCode: '2130',
    purchaseCode: '1450',
    isDefaultSales: false,
    isDefaultPurchases: false,
    rate: '0',
  },
  {
    code: 'EWT1',
    name: 'Expanded withholding 1% (goods)',
    kind: 'WITHHOLDING' as const,
    appliesTo: 'BOTH' as const,
    reportingCategory: 'WITHHOLDING' as const,
    salesCode: '1460',
    purchaseCode: '2140',
    isDefaultSales: false,
    isDefaultPurchases: false,
    rate: '1',
  },
  {
    code: 'EWT2',
    name: 'Expanded withholding 2% (services)',
    kind: 'WITHHOLDING' as const,
    appliesTo: 'BOTH' as const,
    reportingCategory: 'WITHHOLDING' as const,
    salesCode: '1460',
    purchaseCode: '2140',
    isDefaultSales: false,
    isDefaultPurchases: false,
    rate: '2',
  },
];

/** Monthly budget per account code for the sample budget (same amount every period). */
const BUDGET_LINES: Array<{ code: string; monthly: string }> = [
  { code: '4100', monthly: '250000' },
  { code: '4200', monthly: '60000' },
  { code: '5100', monthly: '120000' },
  { code: '6100', monthly: '85000' },
  { code: '6200', monthly: '25000' },
  { code: '6300', monthly: '9000' },
  { code: '6400', monthly: '5000' },
];

export async function seedBudgetingTax(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  for (const d of DIMENSIONS) {
    const [existing] = await tx
      .select({ id: schema.dimensions.id })
      .from(schema.dimensions)
      .where(
        and(
          eq(schema.dimensions.companyId, company.id),
          eq(schema.dimensions.dimensionType, d.dimensionType),
          eq(schema.dimensions.code, d.code),
        ),
      );
    if (existing) continue;
    await tx.insert(schema.dimensions).values({ companyId: company.id, ...d });
  }

  for (const t of TAX_CODES) {
    const [existing] = await tx
      .select({ id: schema.taxCodes.id })
      .from(schema.taxCodes)
      .where(and(eq(schema.taxCodes.companyId, company.id), eq(schema.taxCodes.code, t.code)));
    if (existing) continue;
    const salesAccountId = codeToId.get(t.salesCode);
    const purchaseAccountId = codeToId.get(t.purchaseCode);
    if (!salesAccountId || !purchaseAccountId) continue;
    const [code] = await tx
      .insert(schema.taxCodes)
      .values({
        companyId: company.id,
        code: t.code,
        name: t.name,
        kind: t.kind,
        appliesTo: t.appliesTo,
        reportingCategory: t.reportingCategory,
        salesAccountId,
        purchaseAccountId,
        isDefaultSales: t.isDefaultSales,
        isDefaultPurchases: t.isDefaultPurchases,
      })
      .returning();
    await tx.insert(schema.taxRates).values({
      taxCodeId: code!.id,
      ratePercent: t.rate,
      effectiveFrom: '2000-01-01',
      effectiveTo: null,
    });
  }

  // Sample budget on the earliest fiscal year, approved so variance works out of the box.
  const [year] = await tx
    .select()
    .from(schema.fiscalYears)
    .where(eq(schema.fiscalYears.companyId, company.id))
    .orderBy(asc(schema.fiscalYears.startDate))
    .limit(1);
  if (year) {
    const budgetCode = `OPEX-${year.name.replace(/[^A-Z0-9]/gi, '').toUpperCase()}`;
    const [existing] = await tx
      .select({ id: schema.budgets.id })
      .from(schema.budgets)
      .where(and(eq(schema.budgets.companyId, company.id), eq(schema.budgets.code, budgetCode)));
    if (!existing) {
      const periods = await tx
        .select({ id: schema.fiscalPeriods.id })
        .from(schema.fiscalPeriods)
        .where(eq(schema.fiscalPeriods.fiscalYearId, year.id))
        .orderBy(asc(schema.fiscalPeriods.periodNumber));
      const [budget] = await tx
        .insert(schema.budgets)
        .values({
          companyId: company.id,
          fiscalYearId: year.id,
          code: budgetCode,
          name: `Operating budget ${year.name}`,
          status: 'ACTIVE',
          currency: company.baseCurrency,
          createdBy: adminUserId,
        })
        .returning();
      const [version] = await tx
        .insert(schema.budgetVersions)
        .values({
          budgetId: budget!.id,
          versionNumber: 1,
          name: 'Original',
          status: 'APPROVED',
          approvedBy: adminUserId,
          approvedAt: new Date(),
          createdBy: adminUserId,
        })
        .returning();
      const lines = BUDGET_LINES.flatMap((l) => {
        const accountId = codeToId.get(l.code);
        if (!accountId) return [];
        return periods.map((p) => ({
          versionId: version!.id,
          accountId,
          fiscalPeriodId: p.id,
          amount: l.monthly,
        }));
      });
      if (lines.length) await tx.insert(schema.budgetLines).values(lines);
    }
  }
  await registerSeededDocumentTax(tx, company, codeToId, log);
  log(`dimensions, tax codes and sample budget ensured for ${company.code}`);
}

/**
 * The sample invoices and bills predate the tax engine: their VAT is an explicit
 * line on the output / input VAT account. Register those lines in the tax
 * subledger so it reconciles to the document-driven ledger movements, exactly
 * as documents posted through the engine do. Idempotent per document.
 */
async function registerSeededDocumentTax(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  log: Log,
): Promise<void> {
  const [vat] = await tx
    .select()
    .from(schema.taxCodes)
    .where(and(eq(schema.taxCodes.companyId, company.id), eq(schema.taxCodes.code, 'VAT12')));
  const outputVat = codeToId.get('2130');
  const inputVat = codeToId.get('1450');
  if (!vat || !outputVat || !inputVat) return;
  const [rate] = await tx
    .select({ rate: schema.taxRates.ratePercent })
    .from(schema.taxRates)
    .where(eq(schema.taxRates.taxCodeId, vat.id))
    .orderBy(asc(schema.taxRates.effectiveFrom))
    .limit(1);
  let registered = 0;
  const invoices = await tx
    .select({
      id: schema.invoices.id,
      documentNumber: schema.invoices.documentNumber,
      journalEntryId: schema.invoices.journalEntryId,
      documentType: schema.invoices.documentType,
      documentDate: schema.invoices.documentDate,
      partyId: schema.invoices.customerId,
      partyName: schema.customers.name,
      partyTaxNumber: schema.customers.taxIdentificationNumber,
    })
    .from(schema.invoices)
    .innerJoin(schema.customers, eq(schema.customers.id, schema.invoices.customerId))
    .where(
      and(
        eq(schema.invoices.companyId, company.id),
        eq(schema.invoices.accountingStatus, 'POSTED'),
      ),
    );
  for (const doc of invoices) {
    registered += await registerLines(
      tx,
      company.id,
      vat.id,
      rate?.rate ?? '12',
      'SALES',
      'AR_DOCUMENT',
      doc,
      outputVat,
      schema.invoiceLines,
      schema.invoiceLines.invoiceId,
    );
  }
  const bills = await tx
    .select({
      id: schema.vendorBills.id,
      documentNumber: schema.vendorBills.documentNumber,
      journalEntryId: schema.vendorBills.journalEntryId,
      documentType: schema.vendorBills.documentType,
      documentDate: schema.vendorBills.documentDate,
      partyId: schema.vendorBills.vendorId,
      partyName: schema.vendors.name,
      partyTaxNumber: schema.vendors.taxIdentificationNumber,
    })
    .from(schema.vendorBills)
    .innerJoin(schema.vendors, eq(schema.vendors.id, schema.vendorBills.vendorId))
    .where(
      and(
        eq(schema.vendorBills.companyId, company.id),
        eq(schema.vendorBills.accountingStatus, 'POSTED'),
      ),
    );
  for (const doc of bills) {
    registered += await registerLines(
      tx,
      company.id,
      vat.id,
      rate?.rate ?? '12',
      'PURCHASES',
      'AP_DOCUMENT',
      doc,
      inputVat,
      schema.billLines,
      schema.billLines.billId,
    );
  }
  if (registered) log(`tax register backfilled for ${registered} seeded document(s)`);
}

async function registerLines(
  tx: Tx,
  companyId: string,
  taxCodeId: string,
  ratePercent: string,
  side: 'SALES' | 'PURCHASES',
  sourceType: 'AR_DOCUMENT' | 'AP_DOCUMENT',
  doc: {
    id: string;
    documentNumber: string;
    journalEntryId: string | null;
    documentType: string;
    documentDate: string;
    partyId: string;
    partyName: string;
    partyTaxNumber: string | null;
  },
  taxAccountId: string,
  linesTable: typeof schema.invoiceLines | typeof schema.billLines,
  docColumn: typeof schema.invoiceLines.invoiceId | typeof schema.billLines.billId,
): Promise<number> {
  if (!doc.journalEntryId) return 0;
  const [already] = await tx
    .select({ id: schema.taxTransactions.id })
    .from(schema.taxTransactions)
    .where(
      and(
        eq(schema.taxTransactions.sourceType, sourceType),
        eq(schema.taxTransactions.sourceId, doc.id),
      ),
    )
    .limit(1);
  if (already) return 0;
  const lines = await tx.select().from(linesTable).where(eq(docColumn, doc.id));
  const taxLines = lines.filter((l) => l.accountId === taxAccountId);
  if (!taxLines.length) return 0;
  // Credit notes reduce the tax; the register keeps signed amounts.
  const sign = doc.documentType === 'CREDIT_NOTE' ? -1 : 1;
  const base = lines
    .filter((l) => l.accountId !== taxAccountId)
    .reduce((sum, l) => sum + Number(l.amount), 0);
  await tx.insert(schema.taxTransactions).values(
    taxLines.map((l) => ({
      companyId,
      taxCodeId,
      side,
      sourceType,
      sourceId: doc.id,
      sourceLineId: l.id,
      documentNumber: doc.documentNumber,
      journalEntryId: doc.journalEntryId!,
      partyId: doc.partyId,
      partyName: doc.partyName,
      partyTaxNumber: doc.partyTaxNumber,
      transactionDate: doc.documentDate,
      ratePercent,
      baseAmount: (sign * base).toFixed(4),
      taxAmount: (sign * Number(l.amount)).toFixed(4),
    })),
  );
  return 1;
}
