import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { buildLeaseSchedule, type LeaseSchedule } from '@/modules/leases/lease.logic';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (message: string) => void;

/**
 * Lease accounting demo (Prompt #13) for ACME: the head-office premises as
 * a 36-month finance lease commenced 1 May 2026 (right-of-use asset +
 * liability, May - August lease runs posted, instalments paid through
 * August, September's instalment still due), a short-term forklift rental
 * expensed as paid, and a draft vehicle hire awaiting commencement. Dated
 * May onwards only (the accounting e2e suite pins January - April) and
 * nothing touches the tax register. Everything is written the way the
 * services write it so the register agrees with the ledger.
 */
export async function seedLeases(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [existing] = await tx
    .select({ id: schema.leases.id })
    .from(schema.leases)
    .where(eq(schema.leases.companyId, company.id));
  if (existing) return;

  const currency = company.baseCurrency;
  const gl = {
    rou: codeToId.get('1530')!,
    rouAccumulated: codeToId.get('1540')!,
    liability: codeToId.get('2220')!,
    interest: codeToId.get('8110')!,
    depreciation: codeToId.get('6500')!,
    leaseExpense: codeToId.get('6210')!,
    bank: codeToId.get('1130')!,
  };
  const [bdo] = await tx
    .select({ id: schema.bankAccounts.id })
    .from(schema.bankAccounts)
    .where(
      and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, 'BDO-MAIN')),
    );
  if (!bdo) throw new Error('Seed leases: BDO-MAIN bank account is missing');

  await tx
    .insert(schema.leaseSettings)
    .values({
      companyId: company.id,
      shortTermThresholdMonths: 12,
      lowValueThreshold: '250000',
      autoPostRuns: false,
      defaultDiscountRate: '8',
    })
    .onConflictDoNothing();

  // ------------------------------------------------------------------ lessor
  const lessor = await ensureVendor(tx, company, codeToId, {
    code: 'VEND-011',
    name: 'Butuan Realty Holdings',
    legalName: 'Butuan Realty Holdings, Inc.',
    taxIdentificationNumber: '321-654-987-000',
    email: 'leasing@butuanrealty.ph',
    city: 'Butuan City',
    province: 'Agusan del Norte',
    paymentTermsDays: 0,
  });
  const [freight] = await tx
    .select({ id: schema.vendors.id })
    .from(schema.vendors)
    .where(and(eq(schema.vendors.companyId, company.id), eq(schema.vendors.code, 'VEND-005')));

  // ------------------------------------------------- head office (finance)
  const officeTerms = {
    commencementDate: '2026-05-01',
    termMonths: 36,
    paymentAmount: '45000',
    paymentFrequency: 'MONTHLY' as const,
    paymentTiming: 'IN_ADVANCE' as const,
    annualDiscountRate: '8',
  };
  const office = buildLeaseSchedule(officeTerms, currency);
  const officeId = await insertLease(tx, company, adminUserId, {
    name: 'Head office - 3F Butuan Commerce Center',
    description: '36-month office premises lease; rent payable monthly in advance.',
    vendorId: lessor,
    classification: 'FINANCE',
    ...officeTerms,
    reference: 'BRH-2026-0412',
    bankAccountId: bdo.id,
    location: 'Butuan Commerce Center, 3rd floor',
    currency,
    schedule: office,
  });
  const officeLines = await tx
    .select()
    .from(schema.leaseScheduleLines)
    .where(eq(schema.leaseScheduleLines.leaseId, officeId))
    .orderBy(schema.leaseScheduleLines.sequence);

  // Commencement: Dr right-of-use asset / Cr lease liability at present value.
  const commencementEntry = await insertEntry(
    tx,
    company,
    {
      date: '2026-05-01',
      description: 'Lease commencement LSE-2026-000001 Head office - 3F Butuan Commerce Center',
      reference: 'BRH-2026-0412',
      sourceType: 'LEASE_COMMENCEMENT',
      sourceId: officeId,
      status: 'POSTED',
      lines: [
        { accountId: gl.rou, debit: office.rouCost, memo: 'LSE-2026-000001 right-of-use asset' },
        {
          accountId: gl.liability,
          credit: office.initialLiability,
          memo: 'LSE-2026-000001 lease liability',
        },
      ],
    },
    adminUserId,
  );
  await tx
    .update(schema.leases)
    .set({
      commencementJournalEntryId: commencementEntry,
      commencedAt: new Date('2026-05-01T01:00:00Z'),
    })
    .where(eq(schema.leases.id, officeId));
  await tx.insert(schema.leaseEvents).values({
    companyId: company.id,
    leaseId: officeId,
    eventType: 'COMMENCEMENT',
    eventDate: '2026-05-01',
    liabilityChange: office.initialLiability,
    rouChange: office.rouCost,
    liabilityChangeBase: office.initialLiability,
    rouChangeBase: office.rouCost,
    liabilityAfter: office.initialLiability,
    rouCarryingAfter: office.rouCost,
    journalEntryId: commencementEntry,
    notes: 'Discounted at 8% p.a.',
    createdBy: adminUserId,
  });

  let liability = Money.of(office.initialLiability, currency);
  let accumulated = Money.zero(currency);
  const rouCost = Money.of(office.rouCost, currency);
  const paidThrough = 4; // May - August instalments paid; September is due
  const runsThrough = 4; // May - August runs posted
  for (const line of officeLines) {
    const seq = line.sequence;
    const payment = Money.of(line.payment, currency);
    // In advance: the instalment is paid on the period start, before the month's run.
    if (seq <= paidThrough && !payment.isZero()) {
      liability = liability.subtract(payment);
      const paymentEntry = await insertEntry(
        tx,
        company,
        {
          date: line.paymentDate!,
          description: `Lease payment LSE-2026-000001 month ${seq}`,
          reference: 'BRH-2026-0412',
          sourceType: 'LEASE_PAYMENT',
          sourceId: line.id,
          status: 'POSTED',
          lines: [
            {
              accountId: gl.liability,
              debit: payment.toString(),
              memo: 'LSE-2026-000001 liability settled',
            },
            {
              accountId: gl.bank,
              credit: payment.toString(),
              memo: 'Lease payment LSE-2026-000001',
            },
          ],
        },
        adminUserId,
      );
      await tx
        .update(schema.leaseScheduleLines)
        .set({
          paidAt: new Date(`${line.paymentDate}T02:00:00Z`),
          paidDate: line.paymentDate,
          paidBankAccountId: bdo.id,
          paymentJournalEntryId: paymentEntry,
        })
        .where(eq(schema.leaseScheduleLines.id, line.id));
      await tx.insert(schema.leaseEvents).values({
        companyId: company.id,
        leaseId: officeId,
        eventType: 'PAYMENT',
        eventDate: line.paymentDate!,
        liabilityChange: payment.negate().toString(),
        rouChange: '0',
        liabilityChangeBase: payment.negate().toString(),
        rouChangeBase: '0',
        liabilityAfter: liability.toString(),
        rouCarryingAfter: rouCost.subtract(accumulated).toString(),
        journalEntryId: paymentEntry,
        notes: `Month ${seq} from BDO-MAIN`,
        createdBy: adminUserId,
      });
    }
    if (seq <= runsThrough) {
      const interest = Money.of(line.interest, currency);
      const depreciation = Money.of(line.depreciation, currency);
      liability = liability.add(interest);
      accumulated = accumulated.add(depreciation);
      const runNumber = await allocateNumber(tx, company.id, 'LRN', line.periodEnd);
      const [run] = await tx
        .insert(schema.leaseRuns)
        .values({
          companyId: company.id,
          documentNumber: runNumber,
          periodEnd: line.periodEnd,
          description: `Month-end lease run ${line.periodEnd.slice(0, 7)}`,
          currency,
          interestTotal: interest.toString(),
          depreciationTotal: depreciation.toString(),
          lineCount: 1,
          leaseCount: 1,
          createdBy: adminUserId,
        })
        .returning({ id: schema.leaseRuns.id });
      const runEntry = await insertEntry(
        tx,
        company,
        {
          date: line.periodEnd,
          description: `Lease run ${runNumber} - Month-end lease run ${line.periodEnd.slice(0, 7)}`,
          reference: runNumber,
          journalType: 'ADJUSTING',
          sourceType: 'LEASE_RUN',
          sourceId: run!.id,
          status: 'POSTED',
          lines: [
            {
              accountId: gl.interest,
              debit: interest.toString(),
              memo: 'LSE-2026-000001 - lease interest',
            },
            {
              accountId: gl.liability,
              credit: interest.toString(),
              memo: 'LSE-2026-000001 - interest accreted',
            },
            {
              accountId: gl.depreciation,
              debit: depreciation.toString(),
              memo: 'LSE-2026-000001 - right-of-use depreciation',
            },
            {
              accountId: gl.rouAccumulated,
              credit: depreciation.toString(),
              memo: 'LSE-2026-000001 - accumulated depreciation',
            },
          ],
        },
        adminUserId,
      );
      await tx
        .update(schema.leaseRuns)
        .set({ journalEntryId: runEntry })
        .where(eq(schema.leaseRuns.id, run!.id));
      await tx
        .update(schema.leaseScheduleLines)
        .set({
          status: 'POSTED',
          runId: run!.id,
          journalEntryId: runEntry,
          interestBase: interest.toString(),
          postedAt: new Date(`${line.periodEnd}T10:00:00Z`),
        })
        .where(eq(schema.leaseScheduleLines.id, line.id));
      const carrying = rouCost.subtract(accumulated).toString();
      await tx.insert(schema.leaseEvents).values([
        {
          companyId: company.id,
          leaseId: officeId,
          eventType: 'INTEREST',
          eventDate: line.periodEnd,
          liabilityChange: interest.toString(),
          rouChange: '0',
          liabilityChangeBase: interest.toString(),
          rouChangeBase: '0',
          liabilityAfter: liability.toString(),
          rouCarryingAfter: carrying,
          runId: run!.id,
          journalEntryId: runEntry,
          notes: `${runNumber} month ${seq}`,
          createdBy: adminUserId,
        },
        {
          companyId: company.id,
          leaseId: officeId,
          eventType: 'DEPRECIATION',
          eventDate: line.periodEnd,
          liabilityChange: '0',
          rouChange: depreciation.negate().toString(),
          liabilityChangeBase: '0',
          rouChangeBase: depreciation.negate().toString(),
          liabilityAfter: liability.toString(),
          rouCarryingAfter: carrying,
          runId: run!.id,
          journalEntryId: runEntry,
          notes: `${runNumber} month ${seq}`,
          createdBy: adminUserId,
        },
      ]);
    }
  }
  await tx
    .update(schema.leases)
    .set({
      liabilityBalance: liability.toString(),
      rouAccumulatedDepreciation: accumulated.toString(),
      liabilityBalanceBase: liability.toString(),
      rouAccumulatedDepreciationBase: accumulated.toString(),
    })
    .where(eq(schema.leases.id, officeId));

  // ------------------------------------------- forklift rental (short-term)
  const forkliftTerms = {
    commencementDate: '2026-06-01',
    termMonths: 6,
    paymentAmount: '8000',
    paymentFrequency: 'MONTHLY' as const,
    paymentTiming: 'IN_ADVANCE' as const,
    annualDiscountRate: '8',
  };
  const forklift = buildLeaseSchedule(forkliftTerms, currency, { exempt: true });
  const forkliftId = await insertLease(tx, company, adminUserId, {
    name: 'Warehouse forklift rental',
    description: 'Six-month equipment hire - short-term exemption, expensed as paid.',
    vendorId: freight?.id ?? null,
    classification: 'SHORT_TERM',
    ...forkliftTerms,
    reference: 'CFF-HIRE-0906',
    bankAccountId: bdo.id,
    location: 'Butuan warehouse',
    currency,
    schedule: forklift,
  });
  await tx.insert(schema.leaseEvents).values({
    companyId: company.id,
    leaseId: forkliftId,
    eventType: 'COMMENCEMENT',
    eventDate: '2026-06-01',
    liabilityChange: '0',
    rouChange: '0',
    liabilityChangeBase: '0',
    rouChangeBase: '0',
    liabilityAfter: '0',
    rouCarryingAfter: '0',
    notes: 'short-term exemption - payments are expensed when paid',
    createdBy: adminUserId,
  });
  const forkliftLines = await tx
    .select()
    .from(schema.leaseScheduleLines)
    .where(eq(schema.leaseScheduleLines.leaseId, forkliftId))
    .orderBy(schema.leaseScheduleLines.sequence);
  for (const line of forkliftLines) {
    if (line.sequence > 4) break; // June - September paid
    const payment = Money.of(line.payment, currency);
    const paymentEntry = await insertEntry(
      tx,
      company,
      {
        date: line.paymentDate!,
        description: `Lease payment LSE-2026-000002 month ${line.sequence}`,
        reference: 'CFF-HIRE-0906',
        sourceType: 'LEASE_PAYMENT',
        sourceId: line.id,
        status: 'POSTED',
        lines: [
          {
            accountId: gl.leaseExpense,
            debit: payment.toString(),
            memo: 'LSE-2026-000002 lease expense',
          },
          { accountId: gl.bank, credit: payment.toString(), memo: 'Lease payment LSE-2026-000002' },
        ],
      },
      adminUserId,
    );
    await tx
      .update(schema.leaseScheduleLines)
      .set({
        status: 'POSTED',
        postedAt: new Date(`${line.paymentDate}T02:00:00Z`),
        paidAt: new Date(`${line.paymentDate}T02:00:00Z`),
        paidDate: line.paymentDate,
        paidBankAccountId: bdo.id,
        paymentJournalEntryId: paymentEntry,
      })
      .where(eq(schema.leaseScheduleLines.id, line.id));
    await tx.insert(schema.leaseEvents).values({
      companyId: company.id,
      leaseId: forkliftId,
      eventType: 'PAYMENT',
      eventDate: line.paymentDate!,
      liabilityChange: '0',
      rouChange: '0',
      liabilityChangeBase: '0',
      rouChangeBase: '0',
      liabilityAfter: '0',
      rouCarryingAfter: '0',
      journalEntryId: paymentEntry,
      notes: `Month ${line.sequence} from BDO-MAIN`,
      createdBy: adminUserId,
    });
  }

  // ----------------------------------------------- delivery van (draft)
  await tx.insert(schema.leases).values({
    companyId: company.id,
    leaseNumber: await allocateNumber(tx, company.id, 'LSE', '2026-10-01'),
    name: 'Delivery van - long-term hire',
    description: 'Two-year vehicle hire starting October; awaiting signed contract.',
    vendorId: freight?.id ?? null,
    status: 'DRAFT',
    classification: 'FINANCE',
    commencementDate: '2026-10-01',
    termMonths: 24,
    paymentAmount: '18000',
    paymentFrequency: 'MONTHLY',
    paymentTiming: 'IN_ARREARS',
    annualDiscountRate: '9',
    underlyingAssetValue: '1450000',
    currency,
    bankAccountId: bdo.id,
    reference: 'CFF-VAN-2026',
    createdBy: adminUserId,
  });

  log(`leases seeded for ${company.code} (finance lease with 4 runs, short-term hire, draft)`);
}

interface LeaseSeed {
  name: string;
  description: string;
  vendorId: string | null;
  classification: 'FINANCE' | 'SHORT_TERM' | 'LOW_VALUE';
  commencementDate: string;
  termMonths: number;
  paymentAmount: string;
  paymentFrequency: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  paymentTiming: 'IN_ADVANCE' | 'IN_ARREARS';
  annualDiscountRate: string;
  reference: string;
  bankAccountId: string;
  location: string;
  currency: string;
  schedule: LeaseSchedule;
}

async function insertLease(
  tx: Tx,
  company: schema.Company,
  adminUserId: string,
  input: LeaseSeed,
): Promise<string> {
  const leaseNumber = await allocateNumber(tx, company.id, 'LSE', input.commencementDate);
  const [lease] = await tx
    .insert(schema.leases)
    .values({
      companyId: company.id,
      leaseNumber,
      name: input.name,
      description: input.description,
      vendorId: input.vendorId,
      status: 'ACTIVE',
      classification: input.classification,
      commencementDate: input.commencementDate,
      termMonths: input.termMonths,
      paymentAmount: input.paymentAmount,
      paymentFrequency: input.paymentFrequency,
      paymentTiming: input.paymentTiming,
      annualDiscountRate: input.annualDiscountRate,
      currency: input.currency,
      initialLiability: input.schedule.initialLiability,
      liabilityBalance: input.schedule.initialLiability,
      rouCost: input.schedule.rouCost,
      rouAccumulatedDepreciation: '0',
      liabilityBalanceBase: input.schedule.initialLiability,
      rouCostBase: input.schedule.rouCost,
      rouAccumulatedDepreciationBase: '0',
      bankAccountId: input.bankAccountId,
      location: input.location,
      reference: input.reference,
      commencedAt: new Date(`${input.commencementDate}T01:00:00Z`),
      createdBy: adminUserId,
    })
    .returning({ id: schema.leases.id });
  await tx.insert(schema.leaseScheduleLines).values(
    input.schedule.lines.map((l) => ({
      companyId: company.id,
      leaseId: lease!.id,
      sequence: l.sequence,
      periodStart: l.periodStart,
      periodEnd: l.periodEnd,
      openingLiability: l.openingLiability,
      interest: l.interest,
      depreciation: l.depreciation,
      depreciationBase: l.depreciation,
      payment: l.payment,
      paymentDate: l.paymentDate,
      closingLiability: l.closingLiability,
    })),
  );
  return lease!.id;
}

async function ensureVendor(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  vendor: {
    code: string;
    name: string;
    legalName: string;
    taxIdentificationNumber: string;
    email: string;
    city: string;
    province: string;
    paymentTermsDays: number;
  },
): Promise<string> {
  const [existing] = await tx
    .select({ id: schema.vendors.id })
    .from(schema.vendors)
    .where(and(eq(schema.vendors.companyId, company.id), eq(schema.vendors.code, vendor.code)));
  if (existing) return existing.id;
  const [row] = await tx
    .insert(schema.vendors)
    .values({
      companyId: company.id,
      ...vendor,
      vendorType: 'SERVICE_PROVIDER',
      defaultExpenseAccountId: codeToId.get('6200') ?? null,
    })
    .returning({ id: schema.vendors.id });
  return row!.id;
}
