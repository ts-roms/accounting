import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { renderPesonetCsv, sha256 } from '@/modules/treasury/treasury.logic';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

/**
 * Prompt #8 demo data: treasury settings, bank account profiles (limits,
 * payment file details), a settled and an in-flight inter-account transfer,
 * planned forecast items, a transmitted PESONet file for a posted vendor
 * payment and an imprest petty cash fund with posted / approved / draft
 * vouchers. Idempotent: skipped when the company already has a petty cash
 * fund. Nothing is dated in September 2026 (the tax e2e asserts on that
 * month) and nothing P&L-affecting lands before May 2026 (accounting e2e).
 */
export async function seedTreasury(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [anyFund] = await tx
    .select({ id: schema.pettyCashFunds.id })
    .from(schema.pettyCashFunds)
    .where(eq(schema.pettyCashFunds.companyId, company.id))
    .limit(1);
  if (anyFund) return;

  const currency = company.baseCurrency;
  const now = new Date();
  const gl = {
    bdo: codeToId.get('1130')!,
    bpi: codeToId.get('1180')!,
    transit: codeToId.get('1190')!,
    petty: codeToId.get('1120')!,
    supplies: codeToId.get('6400')!,
    misc: codeToId.get('6900') ?? codeToId.get('6400')!,
    utilities: codeToId.get('6300')!,
  };
  const bankByCode = async (code: string) => {
    const [row] = await tx
      .select()
      .from(schema.bankAccounts)
      .where(
        and(eq(schema.bankAccounts.companyId, company.id), eq(schema.bankAccounts.code, code)),
      );
    if (!row) throw new Error(`Seed treasury: bank account ${code} missing`);
    return row;
  };
  const bdo = await bankByCode('BDO-MAIN');
  const bpi = await bankByCode('BPI-SAVE');
  const till = await bankByCode('CASH');
  const userByEmail = async (email: string) => {
    const [row] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    return row?.id ?? adminUserId;
  };
  const financeUserId = await userByEmail('finance@acme.local');
  const accountantUserId = await userByEmail('accountant@acme.local');

  // ---------------------------------------------------------------- settings
  await tx
    .insert(schema.treasurySettings)
    .values({
      companyId: company.id,
      forecastHorizonDays: 90,
      forecastGranularity: 'WEEK',
      minimumDaysCashOnHand: 30,
      burnWindowDays: 90,
      transferApprovalThreshold: '100000',
      unsettledTransferWarnDays: 2,
      defaultPaymentFileFormat: 'PESONET_CSV',
      originatorName: company.name,
      pettyCashVoucherLimit: '5000',
    })
    .onConflictDoNothing();

  // ---------------------------------------------------------------- profiles
  const profiles: Array<typeof schema.bankAccountProfiles.$inferInsert> = [
    {
      bankAccountId: bdo.id,
      accountType: 'CURRENT',
      purpose: 'Operating account - collections and vendor payments',
      minimumBalance: '250000',
      targetBalance: '600000',
      overdraftLimit: '0',
      routingCode: 'BNORPHMM',
      paymentFileFormat: 'PESONET_CSV',
      originatorId: 'ACME0001',
      isDefaultReceipts: true,
      isDefaultPayments: true,
      signatories: 'Any two of: CFO, Finance Manager, Treasurer',
    },
    {
      bankAccountId: bpi.id,
      accountType: 'SAVINGS',
      purpose: 'Reserve - surplus cash parked for interest',
      minimumBalance: '100000',
      targetBalance: '400000',
      routingCode: 'BOPIPHMM',
      paymentFileFormat: 'ISO20022_PAIN001',
      originatorId: 'ACME0002',
      signatories: 'CFO and Finance Manager jointly',
    },
    {
      bankAccountId: till.id,
      accountType: 'CURRENT',
      purpose: 'Cashier till',
      minimumBalance: null,
    },
  ];
  for (const p of profiles)
    await tx.insert(schema.bankAccountProfiles).values(p).onConflictDoNothing();

  // ---------------------------------------------------------------- transfers
  const transfer = async (input: {
    date: string;
    expected: string;
    amount: string;
    purpose: 'FUNDING' | 'SWEEP';
    settle: boolean;
    reference: string;
  }) => {
    const amount = Money.parse(input.amount, currency);
    const documentNumber = await allocateNumber(tx, company.id, 'BTR', input.date);
    const [row] = await tx
      .insert(schema.bankTransfers)
      .values({
        companyId: company.id,
        documentNumber,
        status: 'APPROVED',
        purpose: input.purpose,
        fromBankAccountId: bdo.id,
        toBankAccountId: bpi.id,
        transferDate: input.date,
        expectedSettlementDate: input.expected,
        amount: amount.toString(),
        fromCurrency: currency,
        receivedAmount: amount.toString(),
        toCurrency: currency,
        baseAmount: amount.toString(),
        exchangeRate: '1',
        reference: input.reference,
        memo:
          input.purpose === 'SWEEP'
            ? 'Sweep surplus operating cash to the reserve account'
            : 'Fund the reserve account',
        approvedBy: financeUserId,
        approvedAt: new Date(`${input.date}T02:00:00Z`),
        createdBy: accountantUserId,
      })
      .returning({ id: schema.bankTransfers.id });
    const outEntry = await insertEntry(
      tx,
      company,
      {
        date: input.date,
        description: `Bank transfer ${documentNumber} sent - BDO-MAIN to BPI-SAVE`,
        reference: input.reference,
        sourceType: 'BANK_TRANSFER_OUT',
        sourceId: row!.id,
        status: 'POSTED',
        lines: [
          { accountId: gl.transit, debit: amount.toString(), memo: `${documentNumber} in transit` },
          { accountId: gl.bdo, credit: amount.toString(), memo: `${documentNumber} sent` },
        ],
      },
      adminUserId,
    );
    let inEntry: string | null = null;
    if (input.settle) {
      inEntry = await insertEntry(
        tx,
        company,
        {
          date: input.expected,
          description: `Bank transfer ${documentNumber} settled - BPI-SAVE`,
          reference: input.reference,
          sourceType: 'BANK_TRANSFER_IN',
          sourceId: row!.id,
          status: 'POSTED',
          lines: [
            { accountId: gl.bpi, debit: amount.toString(), memo: `${documentNumber} received` },
            { accountId: gl.transit, credit: amount.toString(), memo: `${documentNumber} cleared` },
          ],
        },
        adminUserId,
      );
    }
    await tx
      .update(schema.bankTransfers)
      .set({
        status: input.settle ? 'SETTLED' : 'SENT',
        outJournalEntryId: outEntry,
        inJournalEntryId: inEntry,
        settlementDate: input.settle ? input.expected : null,
        sentBy: financeUserId,
        sentAt: new Date(`${input.date}T03:00:00Z`),
        settledBy: input.settle ? financeUserId : null,
        settledAt: input.settle ? new Date(`${input.expected}T08:00:00Z`) : null,
        bankReference: input.settle ? `BPI-${input.reference}` : null,
      })
      .where(eq(schema.bankTransfers.id, row!.id));
    return row!.id;
  };
  await transfer({
    date: '2026-05-05',
    expected: '2026-05-06',
    amount: '300000',
    purpose: 'FUNDING',
    settle: true,
    reference: 'TRF-2605-01',
  });
  // Sent at the end of August and still not confirmed by the bank: shows up in transit and on the unsettled list.
  await transfer({
    date: '2026-08-28',
    expected: '2026-08-31',
    amount: '50000',
    purpose: 'SWEEP',
    settle: false,
    reference: 'TRF-2608-02',
  });

  // ------------------------------------------------------ planned forecast items
  const items: Array<Omit<typeof schema.cashForecastItems.$inferInsert, 'companyId' | 'currency'>> =
    [
      {
        name: 'Payroll',
        direction: 'OUTFLOW',
        amount: '185000',
        frequency: 'BIWEEKLY',
        startDate: '2026-10-15',
        category: 'Payroll',
        bankAccountId: bdo.id,
      },
      {
        name: 'Office rent',
        direction: 'OUTFLOW',
        amount: '45000',
        frequency: 'MONTHLY',
        startDate: '2026-10-01',
        category: 'Facilities',
        bankAccountId: bdo.id,
      },
      {
        name: 'Term loan amortisation',
        direction: 'OUTFLOW',
        amount: '60000',
        frequency: 'MONTHLY',
        startDate: '2026-10-05',
        endDate: '2028-10-05',
        category: 'Financing',
        bankAccountId: bdo.id,
      },
      {
        name: 'VAT remittance',
        direction: 'OUTFLOW',
        amount: '35000',
        frequency: 'MONTHLY',
        startDate: '2026-10-20',
        category: 'Tax',
        bankAccountId: bdo.id,
      },
      {
        name: 'Managed services retainer',
        direction: 'INFLOW',
        amount: '120000',
        frequency: 'MONTHLY',
        startDate: '2026-10-10',
        category: 'Contracted revenue',
        bankAccountId: bdo.id,
      },
      {
        name: 'Warehouse racking purchase',
        direction: 'OUTFLOW',
        amount: '250000',
        frequency: 'ONCE',
        startDate: '2026-11-16',
        category: 'Capital',
        bankAccountId: bdo.id,
        notes: 'Approved capex; supplier quote valid to end of November.',
      },
      {
        name: 'Time deposit maturity',
        direction: 'INFLOW',
        amount: '200000',
        frequency: 'ONCE',
        startDate: '2026-12-01',
        category: 'Investments',
        bankAccountId: bpi.id,
      },
    ];
  await tx
    .insert(schema.cashForecastItems)
    .values(
      items.map((i) => ({ ...i, companyId: company.id, currency, createdBy: financeUserId })),
    );

  // ------------------------------------------------------------- payment file
  const [payment] = await tx
    .select({ payment: schema.vendorPayments, vendor: schema.vendors })
    .from(schema.vendorPayments)
    .innerJoin(schema.vendors, eq(schema.vendors.id, schema.vendorPayments.vendorId))
    .where(
      and(
        eq(schema.vendorPayments.companyId, company.id),
        eq(schema.vendorPayments.reference, 'PAY-LFM-06'),
        eq(schema.vendorPayments.status, 'POSTED'),
      ),
    );
  if (payment) {
    const [vb] = await tx
      .select()
      .from(schema.vendorBankAccounts)
      .where(
        and(
          eq(schema.vendorBankAccounts.vendorId, payment.vendor.id),
          eq(schema.vendorBankAccounts.isPrimary, true),
        ),
      );
    const valueDate = payment.payment.paymentDate;
    const documentNumber = await allocateNumber(tx, company.id, 'PMF', valueDate);
    const entries = [
      {
        sequence: 1,
        paymentNumber: payment.payment.documentNumber,
        amount: Money.of(payment.payment.amount, currency).toString(),
        beneficiaryName: vb?.accountName ?? payment.vendor.name,
        beneficiaryBank: vb?.bankName ?? null,
        beneficiaryAccount: vb?.accountNumber ?? null,
        beneficiaryRouting: vb?.routingCode ?? null,
        remittanceInfo: payment.payment.reference ?? payment.payment.documentNumber,
      },
    ];
    const content = renderPesonetCsv(
      {
        fileNumber: documentNumber,
        valueDate,
        currency,
        originatorName: company.name,
        originatorId: 'ACME0001',
        originatorAccount: bdo.accountNumber,
        originatorRouting: 'BNORPHMM',
        totalAmount: entries[0]!.amount,
        count: 1,
      },
      entries,
    );
    const [file] = await tx
      .insert(schema.paymentFiles)
      .values({
        companyId: company.id,
        documentNumber,
        status: 'ACKNOWLEDGED',
        format: 'PESONET_CSV',
        bankAccountId: bdo.id,
        valueDate,
        currency,
        totalAmount: entries[0]!.amount,
        paymentCount: 1,
        filename: `${documentNumber}.csv`,
        content,
        checksum: sha256(content),
        description: 'Contractor progress billing',
        bankReference: 'BDO-BATCH-260820-01',
        transmittedBy: financeUserId,
        transmittedAt: new Date(`${valueDate}T04:00:00Z`),
        acknowledgedAt: new Date(`${valueDate}T06:30:00Z`),
        createdBy: financeUserId,
      })
      .returning({ id: schema.paymentFiles.id });
    await tx.insert(schema.paymentFileLines).values({
      fileId: file!.id,
      paymentId: payment.payment.id,
      sequence: 1,
      amount: entries[0]!.amount,
      beneficiaryName: entries[0]!.beneficiaryName,
      beneficiaryBank: entries[0]!.beneficiaryBank,
      beneficiaryAccount: entries[0]!.beneficiaryAccount,
      beneficiaryRouting: entries[0]!.beneficiaryRouting,
      remittanceInfo: entries[0]!.remittanceInfo,
    });
  }

  // --------------------------------------------------------------- petty cash
  const imprest = Money.parse('20000', currency);
  const [fund] = await tx
    .insert(schema.pettyCashFunds)
    .values({
      companyId: company.id,
      code: 'PCF-HO',
      name: 'Head office petty cash',
      glAccountId: gl.petty,
      imprestAmount: imprest.toString(),
      custodianId: accountantUserId,
      voucherApprovalLimit: '3000',
      replenishAtPercent: '25',
      notes: 'Imprest fund kept in the finance office safe; replenished against posted vouchers.',
      lastReplenishedAt: '2026-05-04',
    })
    .returning({ id: schema.pettyCashFunds.id });
  // Establishing the fund is a bank withdrawal to the petty cash account (Dr 1120 / Cr 1130).
  const withdrawalNumber = await allocateNumber(tx, company.id, 'BTX', '2026-05-04');
  const [withdrawal] = await tx
    .insert(schema.bankTransactions)
    .values({
      companyId: company.id,
      documentNumber: withdrawalNumber,
      bankAccountId: bdo.id,
      transactionType: 'WITHDRAWAL',
      status: 'DRAFT',
      transactionDate: '2026-05-04',
      amount: imprest.toString(),
      currency,
      counterpartyAccountId: gl.petty,
      reference: 'Establish PCF-HO',
      memo: 'Petty cash fund set up at imprest',
      createdBy: adminUserId,
    })
    .returning({ id: schema.bankTransactions.id });
  const withdrawalEntry = await insertEntry(
    tx,
    company,
    {
      date: '2026-05-04',
      description: `Bank withdrawal ${withdrawalNumber} - establish petty cash fund PCF-HO`,
      reference: 'Establish PCF-HO',
      sourceType: 'BANK_TRANSACTION',
      sourceId: withdrawal!.id,
      status: 'POSTED',
      lines: [
        { accountId: gl.petty, debit: imprest.toString() },
        { accountId: gl.bdo, credit: imprest.toString() },
      ],
    },
    adminUserId,
  );
  await tx
    .update(schema.bankTransactions)
    .set({
      status: 'POSTED',
      journalEntryId: withdrawalEntry,
      postedBy: adminUserId,
      postedAt: now,
    })
    .where(eq(schema.bankTransactions.id, withdrawal!.id));

  const voucher = async (input: {
    date: string;
    payee: string;
    description: string;
    receipt: string;
    status: 'DRAFT' | 'APPROVED' | 'POSTED';
    lines: Array<{ description: string; accountId: string; amount: string }>;
  }) => {
    const total = input.lines.reduce(
      (m, l) => m.add(Money.parse(l.amount, currency)),
      Money.zero(currency),
    );
    const documentNumber = await allocateNumber(tx, company.id, 'PCV', input.date);
    const approved = input.status !== 'DRAFT';
    const [row] = await tx
      .insert(schema.pettyCashVouchers)
      .values({
        companyId: company.id,
        fundId: fund!.id,
        documentNumber,
        status: input.status,
        voucherDate: input.date,
        payee: input.payee,
        description: input.description,
        receiptReference: input.receipt,
        total: total.toString(),
        approvedBy: approved ? financeUserId : null,
        approvedAt: approved ? new Date(`${input.date}T05:00:00Z`) : null,
        createdBy: accountantUserId,
      })
      .returning({ id: schema.pettyCashVouchers.id });
    await tx.insert(schema.pettyCashVoucherLines).values(
      input.lines.map((l, i) => ({
        voucherId: row!.id,
        lineNumber: i + 1,
        description: l.description,
        accountId: l.accountId,
        amount: Money.parse(l.amount, currency).toString(),
      })),
    );
    if (input.status === 'POSTED') {
      const entryId = await insertEntry(
        tx,
        company,
        {
          date: input.date,
          description: `Petty cash ${documentNumber} - ${input.payee} - ${input.description}`,
          reference: input.receipt,
          sourceType: 'PETTY_CASH_VOUCHER',
          sourceId: row!.id,
          status: 'POSTED',
          lines: [
            ...input.lines.map((l) => ({
              accountId: l.accountId,
              debit: Money.parse(l.amount, currency).toString(),
              memo: l.description,
            })),
            {
              accountId: gl.petty,
              credit: total.toString(),
              memo: `${documentNumber} paid from PCF-HO`,
            },
          ],
        },
        adminUserId,
      );
      await tx
        .update(schema.pettyCashVouchers)
        .set({
          journalEntryId: entryId,
          postedBy: financeUserId,
          postedAt: new Date(`${input.date}T06:00:00Z`),
        })
        .where(eq(schema.pettyCashVouchers.id, row!.id));
    }
  };
  await voucher({
    date: '2026-06-10',
    payee: 'National Book Store',
    description: 'Printer paper and toner',
    receipt: 'OR-118842',
    status: 'POSTED',
    lines: [
      { description: 'A4 paper (5 reams) and toner', accountId: gl.supplies, amount: '1850' },
    ],
  });
  await voucher({
    date: '2026-07-15',
    payee: 'Grab / taxi',
    description: 'Messenger fares - BIR and bank runs',
    receipt: 'PCV-JUL-01',
    status: 'POSTED',
    lines: [
      { description: 'Taxi fares 6-10 July', accountId: gl.misc, amount: '1400' },
      { description: 'Courier fees', accountId: gl.misc, amount: '1800' },
    ],
  });
  await voucher({
    date: '2026-08-20',
    payee: 'Meralco kiosk',
    description: 'Prepaid meter top-up - warehouse annex',
    receipt: 'MER-55219',
    status: 'APPROVED',
    lines: [{ description: 'Electricity prepaid load', accountId: gl.utilities, amount: '950' }],
  });
  await voucher({
    date: '2026-08-27',
    payee: 'Office pantry',
    description: 'Coffee, water and cleaning supplies',
    receipt: 'SM-9920371',
    status: 'DRAFT',
    lines: [
      { description: 'Pantry and cleaning supplies', accountId: gl.supplies, amount: '2400' },
    ],
  });

  log(
    `treasury demo data seeded for ${company.code} (profiles, transfers, forecast items, payment file, petty cash)`,
  );
}
