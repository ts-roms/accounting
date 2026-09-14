import { and, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

/**
 * Phase 6 sample master data: asset categories and bank accounts bound to the
 * cash / bank GL accounts. The Phase 2 sample journals already hold a
 * equipment purchase in the clearing account; `seedSampleAsset` capitalises
 * it into the register so the books and the register agree.
 */
const CATEGORIES = [
  {
    code: 'IT',
    name: 'IT Equipment',
    usefulLifeMonths: 36,
    depreciationMethod: 'STRAIGHT_LINE' as const,
  },
  {
    code: 'FURN',
    name: 'Furniture & Fixtures',
    usefulLifeMonths: 60,
    depreciationMethod: 'STRAIGHT_LINE' as const,
  },
  {
    code: 'VEH',
    name: 'Vehicles',
    usefulLifeMonths: 60,
    depreciationMethod: 'DECLINING_BALANCE' as const,
    decliningRatePercent: '40',
  },
];

const BANK_ACCOUNTS = [
  {
    code: 'BDO-MAIN',
    name: 'BDO Current Account',
    bankName: 'BDO Unibank',
    accountNumber: '****4471',
    glCode: '1130',
  },
  { code: 'CASH', name: 'Cash on Hand', bankName: null, accountNumber: null, glCode: '1110' },
];

export async function seedAssetsBanking(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  for (const c of CATEGORIES) {
    const [existing] = await tx
      .select({ id: schema.assetCategories.id })
      .from(schema.assetCategories)
      .where(
        and(
          eq(schema.assetCategories.companyId, company.id),
          eq(schema.assetCategories.code, c.code),
        ),
      );
    if (existing) continue;
    await tx.insert(schema.assetCategories).values({ companyId: company.id, ...c });
  }
  for (const b of BANK_ACCOUNTS) {
    const glAccountId = codeToId.get(b.glCode);
    if (!glAccountId) continue;
    const [existing] = await tx
      .select({ id: schema.bankAccounts.id })
      .from(schema.bankAccounts)
      .where(
        and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, b.code)),
      );
    if (existing) continue;
    await tx.insert(schema.bankAccounts).values({
      companyId: company.id,
      code: b.code,
      name: b.name,
      bankName: b.bankName,
      accountNumber: b.accountNumber,
      currency: company.baseCurrency,
      glAccountId,
    });
  }
  log(`asset categories and bank accounts ensured for ${company.code}`);
  await seedSampleAsset(tx, company, codeToId, adminUserId, log);
}

/**
 * The sample equipment bill (OS-4471) lands in the fixed-asset clearing
 * account; the register capitalises it here the way `FixedAssetsService`
 * does (Dr asset cost / Cr clearing) so the clearing account clears and the
 * suspense monitor starts clean. Runs once per company that has the bill.
 */
async function seedSampleAsset(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const [bill] = await tx
    .select({
      id: schema.vendorBills.id,
      vendorId: schema.vendorBills.vendorId,
      documentDate: schema.vendorBills.documentDate,
      total: schema.vendorBills.total,
    })
    .from(schema.vendorBills)
    .where(
      and(
        eq(schema.vendorBills.companyId, company.id),
        eq(schema.vendorBills.vendorInvoiceNumber, 'OS-4471'),
      ),
    );
  if (!bill) return;
  const [existing] = await tx
    .select({ id: schema.fixedAssets.id })
    .from(schema.fixedAssets)
    .where(
      and(
        eq(schema.fixedAssets.companyId, company.id),
        eq(schema.fixedAssets.reference, 'OS-4471'),
      ),
    );
  if (existing) return;
  const [category] = await tx
    .select({ id: schema.assetCategories.id })
    .from(schema.assetCategories)
    .where(
      and(eq(schema.assetCategories.companyId, company.id), eq(schema.assetCategories.code, 'IT')),
    );
  const assetAccountId = codeToId.get('1510');
  const clearingAccountId = codeToId.get('1590');
  if (!category || !assetAccountId || !clearingAccountId) return;
  const assetNumber = await allocateNumber(tx, company.id, 'FA', bill.documentDate);
  const [asset] = await tx
    .insert(schema.fixedAssets)
    .values({
      companyId: company.id,
      assetNumber,
      name: 'Workstation set (4 units)',
      description: 'Office workstations purchased on OS-4471',
      categoryId: category.id,
      status: 'DRAFT',
      acquisitionDate: bill.documentDate,
      inServiceDate: bill.documentDate,
      acquisitionCost: bill.total,
      cost: bill.total,
      usefulLifeMonths: 36,
      depreciationMethod: 'STRAIGHT_LINE',
      currency: company.baseCurrency,
      vendorId: bill.vendorId,
      reference: 'OS-4471',
      createdBy: adminUserId,
    })
    .returning({ id: schema.fixedAssets.id });
  const entryId = await insertEntry(
    tx,
    company,
    {
      date: bill.documentDate,
      description: `Capitalise ${assetNumber} Workstation set (4 units)`,
      reference: 'OS-4471',
      sourceType: 'FIXED_ASSET_CAPITALIZATION',
      sourceId: asset!.id,
      status: 'POSTED',
      lines: [
        { accountId: assetAccountId, debit: bill.total, memo: `${assetNumber} acquisition cost` },
        { accountId: clearingAccountId, credit: bill.total, memo: `${assetNumber} capitalised` },
      ],
    },
    adminUserId,
  );
  await tx
    .update(schema.fixedAssets)
    .set({ status: 'ACTIVE', capitalizationJournalEntryId: entryId, capitalizedAt: new Date() })
    .where(eq(schema.fixedAssets.id, asset!.id));
  await tx.insert(schema.assetEvents).values({
    assetId: asset!.id,
    eventType: 'CAPITALIZATION',
    eventDate: bill.documentDate,
    amount: bill.total,
    bookValueAfter: bill.total,
    journalEntryId: entryId,
    notes: 'Credited to 1590 Fixed Asset Clearing',
    createdBy: adminUserId,
  });
  log(`sample asset ${assetNumber} capitalised for ${company.code}`);
}
