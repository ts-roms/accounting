import { eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

/**
 * Prompt #9 demo data: Acme Trading (parent) acquired 80% of Acme Services
 * on 2026-01-05 through a share swap (Dr investment / Cr share capital - no
 * cash moves, so bank-driven suites stay untouched). Acme Services then
 * trades May-August, pays Acme Trading a management fee through the
 * intercompany register, and settles it in cash so the intercompany accounts
 * net to zero. The ACME-GROUP consolidation group holds both with the
 * default elimination rules. Idempotent: skipped when the group exists.
 * Nothing is dated in September 2026, nothing P&L-affecting before May.
 */
export async function seedConsolidation(
  tx: Tx,
  organizationId: string,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const [existing] = await tx
    .select({ id: schema.consolidationGroups.id })
    .from(schema.consolidationGroups)
    .where(eq(schema.consolidationGroups.organizationId, organizationId))
    .limit(1);
  if (existing) return;
  const companyRows = await tx
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.organizationId, organizationId));
  const parent = companyRows.find((c) => c.code === 'ACME');
  const sub = companyRows.find((c) => c.code === 'ACMS');
  if (!parent || !sub) return;

  const chart = async (companyId: string) => {
    const rows = await tx
      .select({ code: schema.accounts.code, id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.companyId, companyId));
    return new Map(rows.map((r) => [r.code, r.id]));
  };
  const parentChart = await chart(parent.id);
  const subChart = await chart(sub.id);
  const gl = (map: Map<string, string>, code: string) => {
    const id = map.get(code);
    if (!id) throw new Error(`Seed consolidation: account ${code} missing`);
    return id;
  };
  const now = new Date();

  // ------------------------------------------------ acquisition (share swap)
  await insertEntry(
    tx,
    parent,
    {
      date: '2026-01-05',
      description: 'Acquisition of 80% of Acme Services Inc. - share-for-share exchange',
      reference: 'ACQ-ACMS-2026',
      status: 'POSTED',
      lines: [
        { accountId: gl(parentChart, '1700'), debit: '180000', memo: '80% of Acme Services' },
        {
          accountId: gl(parentChart, '3100'),
          credit: '180000',
          memo: 'Shares issued to Acme Services shareholders',
        },
      ],
    },
    adminUserId,
  );

  // ---------------------------------------------- subsidiary books (ACMS)
  const subEntries: Array<{
    date: string;
    description: string;
    reference: string;
    lines: Array<{ code: string; debit?: string; credit?: string }>;
  }> = [
    {
      date: '2026-01-05',
      description: 'Share capital paid in',
      reference: 'ACMS-CAP-01',
      lines: [
        { code: '1130', debit: '200000' },
        { code: '3100', credit: '200000' },
      ],
    },
    {
      date: '2026-05-15',
      description: 'Facilities management services billed - May',
      reference: 'ACMS-REV-05',
      lines: [
        { code: '1130', debit: '110000' },
        { code: '4200', credit: '110000' },
      ],
    },
    {
      date: '2026-05-31',
      description: 'Office rent - May',
      reference: 'ACMS-RENT-05',
      lines: [
        { code: '6200', debit: '20000' },
        { code: '1130', credit: '20000' },
      ],
    },
    {
      date: '2026-06-15',
      description: 'Facilities management services billed - June',
      reference: 'ACMS-REV-06',
      lines: [
        { code: '1130', debit: '120000' },
        { code: '4200', credit: '120000' },
      ],
    },
    {
      date: '2026-06-30',
      description: 'Office rent and utilities - June',
      reference: 'ACMS-OPEX-06',
      lines: [
        { code: '6200', debit: '20000' },
        { code: '6300', debit: '6000' },
        { code: '1130', credit: '26000' },
      ],
    },
    {
      date: '2026-07-15',
      description: 'Facilities management services billed - July',
      reference: 'ACMS-REV-07',
      lines: [
        { code: '1130', debit: '125000' },
        { code: '4200', credit: '125000' },
      ],
    },
    {
      date: '2026-07-31',
      description: 'Office rent and utilities - July',
      reference: 'ACMS-OPEX-07',
      lines: [
        { code: '6200', debit: '20000' },
        { code: '6300', debit: '6000' },
        { code: '1130', credit: '26000' },
      ],
    },
    {
      date: '2026-08-14',
      description: 'Facilities management services billed - August',
      reference: 'ACMS-REV-08',
      lines: [
        { code: '1130', debit: '135000' },
        { code: '4200', credit: '135000' },
      ],
    },
    {
      date: '2026-08-31',
      description: 'Office rent and utilities - August',
      reference: 'ACMS-OPEX-08',
      lines: [
        { code: '6200', debit: '20000' },
        { code: '6300', debit: '6000' },
        { code: '1130', credit: '26000' },
      ],
    },
  ];
  for (const e of subEntries)
    await insertEntry(
      tx,
      sub,
      {
        date: e.date,
        description: e.description,
        reference: e.reference,
        status: 'POSTED',
        lines: e.lines.map((l) => ({
          accountId: gl(subChart, l.code),
          debit: l.debit,
          credit: l.credit,
        })),
      },
      adminUserId,
    );

  // ------------------------------------ intercompany management fee + settlement
  const fee = Money.parse('60000', sub.baseCurrency);
  const icNumber = await allocateNumber(tx, sub.id, 'ICT', '2026-06-30');
  const [ic] = await tx
    .insert(schema.intercompanyTransactions)
    .values({
      organizationId,
      documentNumber: icNumber,
      fromCompanyId: sub.id,
      toCompanyId: parent.id,
      transactionDate: '2026-06-30',
      description: 'Group management fee - H1 2026',
      reference: 'MGMT-FEE-H1',
      currency: sub.baseCurrency,
      amount: fee.toString(),
      fromAccountId: gl(subChart, '6970'),
      toAccountId: gl(parentChart, '4980'),
      status: 'DRAFT',
      createdBy: adminUserId,
    })
    .returning({ id: schema.intercompanyTransactions.id });
  const fromEntry = await insertEntry(
    tx,
    sub,
    {
      date: '2026-06-30',
      description: `Intercompany ${icNumber} to ACME: Group management fee - H1 2026`,
      reference: 'MGMT-FEE-H1',
      sourceType: 'INTERCOMPANY',
      sourceId: ic!.id,
      status: 'POSTED',
      lines: [
        { accountId: gl(subChart, '6970'), debit: fee.toString(), memo: 'Group management fee' },
        { accountId: gl(subChart, '2180'), credit: fee.toString(), memo: 'Due to ACME' },
      ],
    },
    adminUserId,
  );
  const toEntry = await insertEntry(
    tx,
    parent,
    {
      date: '2026-06-30',
      description: `Intercompany ${icNumber} from ACMS: Group management fee - H1 2026`,
      reference: 'MGMT-FEE-H1',
      sourceType: 'INTERCOMPANY',
      sourceId: ic!.id,
      status: 'POSTED',
      lines: [
        { accountId: gl(parentChart, '1290'), debit: fee.toString(), memo: 'Due from ACMS' },
        {
          accountId: gl(parentChart, '4980'),
          credit: fee.toString(),
          memo: 'Group management fee',
        },
      ],
    },
    adminUserId,
  );
  const settleFrom = await insertEntry(
    tx,
    sub,
    {
      date: '2026-07-10',
      description: `Settle intercompany ${icNumber} to ACME`,
      reference: 'MGMT-FEE-H1',
      sourceType: 'INTERCOMPANY_SETTLEMENT',
      sourceId: ic!.id,
      status: 'POSTED',
      lines: [
        { accountId: gl(subChart, '2180'), debit: fee.toString(), memo: 'Due to ACME settled' },
        { accountId: gl(subChart, '1130'), credit: fee.toString(), memo: 'Paid from BDO-MAIN' },
      ],
    },
    adminUserId,
  );
  const settleTo = await insertEntry(
    tx,
    parent,
    {
      date: '2026-07-10',
      description: `Settle intercompany ${icNumber} from ACMS`,
      reference: 'MGMT-FEE-H1',
      sourceType: 'INTERCOMPANY_SETTLEMENT',
      sourceId: ic!.id,
      status: 'POSTED',
      lines: [
        {
          accountId: gl(parentChart, '1130'),
          debit: fee.toString(),
          memo: 'Received into BDO-MAIN',
        },
        {
          accountId: gl(parentChart, '1290'),
          credit: fee.toString(),
          memo: 'Due from ACMS settled',
        },
      ],
    },
    adminUserId,
  );
  await tx
    .update(schema.intercompanyTransactions)
    .set({
      status: 'SETTLED',
      fromJournalEntryId: fromEntry,
      toJournalEntryId: toEntry,
      postedBy: adminUserId,
      postedAt: now,
      settlementDate: '2026-07-10',
      settlementFromJournalEntryId: settleFrom,
      settlementToJournalEntryId: settleTo,
      settledBy: adminUserId,
      settledAt: now,
    })
    .where(eq(schema.intercompanyTransactions.id, ic!.id));

  // -------------------------------------------------------------- the group
  const [group] = await tx
    .insert(schema.consolidationGroups)
    .values({
      organizationId,
      code: 'ACME-GROUP',
      name: 'Acme Group',
      parentCompanyId: parent.id,
      presentationCurrency: parent.baseCurrency,
      translationMethod: 'CURRENT_RATE',
      intercompanyTolerance: '0',
      // Demo periods stay open; the group close still runs. Tighten per organization.
      requirePeriodsClosed: false,
      accounts: {
        cumulativeTranslationAdjustment: '3500',
        nonControllingInterest: '3400',
        goodwill: '1710',
        retainedEarnings: '3200',
        intercompanyDifference: '6980',
        shareOfAssociateProfit: '4950',
        investment: '1700',
      },
      notes: 'Acme Trading Corporation and its 80%-owned services subsidiary.',
      createdBy: adminUserId,
    })
    .returning({ id: schema.consolidationGroups.id });
  await tx.insert(schema.consolidationGroupMembers).values([
    {
      groupId: group!.id,
      companyId: parent.id,
      method: 'FULL',
      ownershipPercent: '100',
      sortOrder: 0,
    },
    {
      groupId: group!.id,
      companyId: sub.id,
      method: 'FULL',
      ownershipPercent: '80',
      acquisitionDate: '2026-01-05',
      acquisitionEquity: '200000',
      investmentCost: '180000',
      sortOrder: 10,
      notes: 'Acquired through a share swap; 20% held by the founders.',
    },
  ]);
  await tx.insert(schema.eliminationRules).values([
    {
      groupId: group!.id,
      code: 'IC-BALANCES',
      name: 'Intercompany receivables and payables',
      type: 'INTERCOMPANY_BALANCES',
      description:
        'Eliminates every balance-sheet account flagged intercompany; residuals go to 6980.',
      config: {},
      createdBy: adminUserId,
    },
    {
      groupId: group!.id,
      code: 'IC-FEES',
      name: 'Intercompany management fees',
      type: 'INTERCOMPANY_PROFIT_LOSS',
      description: 'Group management fees charged between members (4980 revenue vs 6970 expense).',
      config: { revenueCodes: ['4980'], expenseCodes: ['6970'] },
      createdBy: adminUserId,
    },
    {
      groupId: group!.id,
      code: 'INVESTMENT',
      name: 'Investment against subsidiary equity',
      type: 'INVESTMENT_EQUITY',
      description:
        'Parent investment vs equity at acquisition, goodwill, non-controlling interest, equity pickups.',
      config: {},
      createdBy: adminUserId,
    },
  ]);
  log(
    'consolidation demo seeded: ACME-GROUP (ACME 100%, ACMS 80%), management fee charged and settled, 3 elimination rules',
  );
}
