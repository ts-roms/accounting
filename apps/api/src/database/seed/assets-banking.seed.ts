import { and, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Phase 6 sample master data: asset categories and bank accounts bound to the
 * cash / bank GL accounts. The Phase 2 sample journals already hold a
 * depreciated equipment balance (1510 / 1520); no asset records are seeded
 * for it so the register only contains assets created through the API.
 */
const CATEGORIES = [
  { code: 'IT', name: 'IT Equipment', usefulLifeMonths: 36, depreciationMethod: 'STRAIGHT_LINE' as const },
  { code: 'FURN', name: 'Furniture & Fixtures', usefulLifeMonths: 60, depreciationMethod: 'STRAIGHT_LINE' as const },
  { code: 'VEH', name: 'Vehicles', usefulLifeMonths: 60, depreciationMethod: 'DECLINING_BALANCE' as const, decliningRatePercent: '40' },
];

const BANK_ACCOUNTS = [
  { code: 'BDO-MAIN', name: 'BDO Current Account', bankName: 'BDO Unibank', accountNumber: '****4471', glCode: '1130' },
  { code: 'CASH', name: 'Cash on Hand', bankName: null, accountNumber: null, glCode: '1110' },
];

export async function seedAssetsBanking(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  log: Log,
): Promise<void> {
  for (const c of CATEGORIES) {
    const [existing] = await tx
      .select({ id: schema.assetCategories.id })
      .from(schema.assetCategories)
      .where(and(eq(schema.assetCategories.companyId, company.id), eq(schema.assetCategories.code, c.code)));
    if (existing) continue;
    await tx.insert(schema.assetCategories).values({ companyId: company.id, ...c });
  }
  for (const b of BANK_ACCOUNTS) {
    const glAccountId = codeToId.get(b.glCode);
    if (!glAccountId) continue;
    const [existing] = await tx
      .select({ id: schema.bankAccounts.id })
      .from(schema.bankAccounts)
      .where(and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, b.code)));
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
}
