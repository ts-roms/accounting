import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { VendorType } from '@accounting/types';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

/**
 * Prompt #7 demo data: discount payment terms, vendor groups, AP settings,
 * seven more vendors with contacts / addresses / bank accounts / profiles
 * (one on hold, one pending approval), bills across every aging bucket with
 * early-payment windows, a vendor credit, a partial payment, a payment that
 * took a discount, a payment hold, a submitted payment run and a draft
 * accrual. Idempotent: skipped when the company already has vendor groups.
 * Nothing is dated in September 2026 (the tax e2e asserts on that month).
 */
export async function seedPayables(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [anyGroup] = await tx
    .select({ id: schema.vendorGroups.id })
    .from(schema.vendorGroups)
    .where(eq(schema.vendorGroups.companyId, company.id))
    .limit(1);
  if (anyGroup) return;

  const currency = company.baseCurrency;
  const now = new Date();
  const ap = codeToId.get('2110')!;
  const inputVat = codeToId.get('1450')!;
  const bank = codeToId.get('1130')!;
  const discountAccount = codeToId.get('5400')!;
  const expense = {
    rent: codeToId.get('6200')!,
    utilities: codeToId.get('6300')!,
    supplies: codeToId.get('6400')!,
    professional: codeToId.get('6700')!,
    misc: codeToId.get('6900') ?? codeToId.get('6400')!,
    /** Goods bills without a stocked product line expense to cost of sales (1300 is reserved for the stock subledger). */
    merchandise: codeToId.get('5100')!,
  };

  // ------------------------------------------------------------ payment terms
  const termId = async (code: string): Promise<string> => {
    const [row] = await tx
      .select({ id: schema.paymentTerms.id })
      .from(schema.paymentTerms)
      .where(
        and(eq(schema.paymentTerms.companyId, company.id), eq(schema.paymentTerms.code, code)),
      );
    return row!.id;
  };
  const [t2n10] = await tx
    .insert(schema.paymentTerms)
    .values({
      companyId: company.id,
      code: '2-10N30',
      name: '2% 10 days, net 30',
      basis: 'NET_DAYS',
      days: 30,
      discountPercent: '2',
      discountDays: 10,
      description: 'Two percent off when settled within ten days.',
    })
    .returning({ id: schema.paymentTerms.id });
  const [t2n20] = await tx
    .insert(schema.paymentTerms)
    .values({
      companyId: company.id,
      code: '2-20N45',
      name: '2% 20 days, net 45',
      basis: 'NET_DAYS',
      days: 45,
      discountPercent: '2',
      discountDays: 20,
      description: 'Two percent off when settled within twenty days.',
    })
    .returning({ id: schema.paymentTerms.id });
  const terms = {
    NET15: await termId('NET15'),
    NET30: await termId('NET30'),
    NET45: await termId('NET45'),
    NET60: await termId('NET60'),
    D2N10: t2n10!.id,
    D2N20: t2n20!.id,
  };

  // ------------------------------------------------------------- vendor groups
  const [ewt2] = await tx
    .select({ id: schema.taxCodes.id })
    .from(schema.taxCodes)
    .where(and(eq(schema.taxCodes.companyId, company.id), eq(schema.taxCodes.code, 'EWT2')));
  const GROUPS = [
    {
      code: 'SUPPLIES',
      name: 'Goods suppliers',
      term: terms.D2N10,
      expense: expense.merchandise,
      wht: null,
      approval: false,
    },
    {
      code: 'SERVICES',
      name: 'Service providers',
      term: terms.NET30,
      expense: expense.professional,
      wht: ewt2?.id ?? null,
      approval: true,
    },
    {
      code: 'UTILITIES',
      name: 'Utilities',
      term: terms.NET15,
      expense: expense.utilities,
      wht: null,
      approval: false,
    },
    {
      code: 'CONTRACTORS',
      name: 'Contractors',
      term: terms.NET45,
      expense: expense.professional,
      wht: ewt2?.id ?? null,
      approval: true,
    },
    {
      code: 'LOGISTICS',
      name: 'Logistics',
      term: terms.D2N20,
      expense: expense.misc,
      wht: null,
      approval: false,
    },
  ];
  const groupIds = new Map<string, string>();
  for (const g of GROUPS) {
    const [row] = await tx
      .insert(schema.vendorGroups)
      .values({
        companyId: company.id,
        code: g.code,
        name: g.name,
        defaultPaymentTermId: g.term,
        defaultExpenseAccountId: g.expense,
        defaultWithholdingTaxCodeId: g.wht,
        requireBillApproval: g.approval,
      })
      .returning({ id: schema.vendorGroups.id });
    groupIds.set(g.code, row!.id);
  }

  await tx
    .insert(schema.apSettings)
    .values({
      companyId: company.id,
      dueSoonDays: 7,
      discountWarnDays: 3,
      grniAgeWarnDays: 30,
      requireRunApproval: true,
      billApprovalThreshold: '250000',
      blockDuplicateVendorInvoice: false,
      defaultPaymentTermId: terms.NET30,
      defaultCashAccountId: bank,
    })
    .onConflictDoNothing();

  // ----------------------------------------------------------------- vendors
  const buyers = await tx
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.organizationId, company.organizationId));
  const buyer = buyers.find((u) => u.email === 'accountant@acme.local')?.id ?? null;

  const NEW_VENDORS: Array<{
    code: string;
    name: string;
    legalName: string;
    type: VendorType;
    group: string;
    term: string;
    tin: string;
    email: string;
    city: string;
    province: string;
    industry: string;
    region: string;
    contact: { name: string; title: string; email: string; phone: string };
    bank: { name: string; account: string; number: string; routing: string };
    status?: 'ON_HOLD' | 'PENDING';
    holdReason?: 'QUALITY' | 'COMPLIANCE';
    minimum?: string;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  }> = [
    {
      code: 'VEND-004',
      name: 'Davao Packaging Industries',
      legalName: 'Davao Packaging Industries, Inc.',
      type: 'SUPPLIER',
      group: 'SUPPLIES',
      term: terms.D2N10,
      tin: '201-333-444-000',
      email: 'billing@davaopackaging.ph',
      city: 'Davao City',
      province: 'Davao del Sur',
      industry: 'Packaging',
      region: 'Mindanao',
      contact: {
        name: 'Marites Uy',
        title: 'Accounts Receivable',
        email: 'marites@davaopackaging.ph',
        phone: '+63 917 555 0204',
      },
      bank: {
        name: 'BPI',
        account: 'Davao Packaging Industries Inc',
        number: '1234567890',
        routing: 'BOPIPHMM',
      },
    },
    {
      code: 'VEND-005',
      name: 'Cebu Freight Forwarders',
      legalName: 'Cebu Freight Forwarders Corporation',
      type: 'SERVICE_PROVIDER',
      group: 'LOGISTICS',
      term: terms.D2N20,
      tin: '202-444-555-000',
      email: 'ar@cebufreight.ph',
      city: 'Cebu City',
      province: 'Cebu',
      industry: 'Logistics',
      region: 'Visayas',
      contact: {
        name: 'Ramon Dela Cruz',
        title: 'Billing Supervisor',
        email: 'ramon@cebufreight.ph',
        phone: '+63 917 555 0205',
      },
      bank: {
        name: 'Metrobank',
        account: 'Cebu Freight Forwarders Corp',
        number: '2233445566',
        routing: 'MBTCPHMM',
      },
    },
    {
      code: 'VEND-006',
      name: 'Luzon Facilities Management',
      legalName: 'Luzon Facilities Management Services, Inc.',
      type: 'CONTRACTOR',
      group: 'CONTRACTORS',
      term: terms.NET45,
      tin: '203-555-666-000',
      email: 'finance@luzonfm.ph',
      city: 'Quezon City',
      province: 'Metro Manila',
      industry: 'Facilities',
      region: 'Luzon',
      contact: {
        name: 'Grace Tan',
        title: 'Finance Manager',
        email: 'grace@luzonfm.ph',
        phone: '+63 917 555 0206',
      },
      bank: {
        name: 'BDO',
        account: 'Luzon Facilities Management Services',
        number: '3344556677',
        routing: 'BNORPHMM',
      },
      risk: 'MEDIUM',
    },
    {
      code: 'VEND-007',
      name: 'Mindanao Water District',
      legalName: 'Butuan City Water District',
      type: 'UTILITY',
      group: 'UTILITIES',
      term: terms.NET15,
      tin: '204-666-777-000',
      email: 'billing@bcwd.gov.ph',
      city: 'Butuan City',
      province: 'Agusan del Norte',
      industry: 'Utilities',
      region: 'Mindanao',
      contact: {
        name: 'Nelson Abad',
        title: 'Collections Officer',
        email: 'nelson@bcwd.gov.ph',
        phone: '+63 917 555 0207',
      },
      bank: {
        name: 'Landbank',
        account: 'Butuan City Water District',
        number: '4455667788',
        routing: 'TLBPPHMM',
      },
      minimum: '5000',
    },
    {
      code: 'VEND-008',
      name: 'Pacific IT Consulting',
      legalName: 'Pacific IT Consulting Partners',
      type: 'SERVICE_PROVIDER',
      group: 'SERVICES',
      term: terms.NET30,
      tin: '205-777-888-000',
      email: 'invoices@pacificit.ph',
      city: 'Makati City',
      province: 'Metro Manila',
      industry: 'IT Services',
      region: 'Luzon',
      contact: {
        name: 'Jose Lim',
        title: 'Managing Partner',
        email: 'jose@pacificit.ph',
        phone: '+63 917 555 0208',
      },
      bank: {
        name: 'UnionBank',
        account: 'Pacific IT Consulting Partners',
        number: '5566778899',
        routing: 'UBPHPHMM',
      },
    },
    {
      code: 'VEND-009',
      name: 'Iloilo Steel Fabricators',
      legalName: 'Iloilo Steel Fabricators, Inc.',
      type: 'SUPPLIER',
      group: 'SUPPLIES',
      term: terms.NET30,
      tin: '206-888-999-000',
      email: 'accounts@iloilosteel.ph',
      city: 'Iloilo City',
      province: 'Iloilo',
      industry: 'Fabrication',
      region: 'Visayas',
      contact: {
        name: 'Ana Reyes',
        title: 'Accounting Head',
        email: 'ana@iloilosteel.ph',
        phone: '+63 917 555 0209',
      },
      bank: {
        name: 'RCBC',
        account: 'Iloilo Steel Fabricators Inc',
        number: '6677889900',
        routing: 'RCBCPHMM',
      },
      status: 'ON_HOLD',
      holdReason: 'QUALITY',
      risk: 'HIGH',
    },
    {
      code: 'VEND-010',
      name: 'Bicol Organic Farms',
      legalName: 'Bicol Organic Farms Cooperative',
      type: 'SUPPLIER',
      group: 'SUPPLIES',
      term: terms.D2N10,
      tin: '207-999-000-000',
      email: 'coop@bicolorganic.ph',
      city: 'Legazpi City',
      province: 'Albay',
      industry: 'Agriculture',
      region: 'Luzon',
      contact: {
        name: 'Bong Salazar',
        title: 'Cooperative Chair',
        email: 'bong@bicolorganic.ph',
        phone: '+63 917 555 0210',
      },
      bank: {
        name: 'Landbank',
        account: 'Bicol Organic Farms Cooperative',
        number: '7788990011',
        routing: 'TLBPPHMM',
      },
      status: 'PENDING',
    },
  ];

  const vendorIds = new Map<string, string>();
  for (const v of ['VEND-001', 'VEND-002', 'VEND-003']) {
    const [row] = await tx
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(and(eq(schema.vendors.companyId, company.id), eq(schema.vendors.code, v)));
    if (row) vendorIds.set(v, row.id);
  }
  for (const v of NEW_VENDORS) {
    const group = GROUPS.find((g) => groupIds.get(g.code) && g.code === v.group)!;
    const [row] = await tx
      .insert(schema.vendors)
      .values({
        companyId: company.id,
        code: v.code,
        name: v.name,
        legalName: v.legalName,
        displayName: v.name,
        vendorType: v.type,
        vendorStatus: v.status ?? 'APPROVED',
        vendorGroupId: groupIds.get(v.group)!,
        paymentTermId: v.term,
        paymentTermsDays: 30,
        defaultWithholdingTaxCodeId: group.wht,
        defaultExpenseAccountId: group.expense,
        taxIdentificationNumber: v.tin,
        email: v.email,
        city: v.city,
        province: v.province,
        industry: v.industry,
        region: v.region,
        buyerId: buyer,
        currency,
      })
      .returning({ id: schema.vendors.id });
    vendorIds.set(v.code, row!.id);
    await tx.insert(schema.vendorContacts).values({
      vendorId: row!.id,
      name: v.contact.name,
      title: v.contact.title,
      email: v.contact.email,
      phone: v.contact.phone,
      isPrimary: true,
      receivesRemittance: true,
    });
    await tx.insert(schema.vendorAddresses).values([
      {
        vendorId: row!.id,
        addressType: 'REMIT_TO',
        label: 'Head office',
        addressLine1: `${v.name} Building`,
        city: v.city,
        province: v.province,
        country: 'PH',
        isDefault: true,
      },
      {
        vendorId: row!.id,
        addressType: 'ORDER_FROM',
        label: 'Sales office',
        addressLine1: 'Sales desk, main plant',
        city: v.city,
        province: v.province,
        country: 'PH',
        isDefault: true,
      },
    ]);
    await tx.insert(schema.vendorBankAccounts).values({
      vendorId: row!.id,
      bankName: v.bank.name,
      label: 'Settlement account',
      accountName: v.bank.account,
      accountNumber: v.bank.number,
      routingCode: v.bank.routing,
      currency,
      isPrimary: true,
      verifiedBy: v.status ? null : adminUserId,
      verifiedAt: v.status ? null : now,
    });
    await tx.insert(schema.vendorProfiles).values({
      vendorId: row!.id,
      riskRating: v.risk ?? 'LOW',
      minimumPaymentAmount: v.minimum ?? null,
      requireBillApproval: group.approval,
      holdReason: v.status === 'ON_HOLD' ? (v.holdReason ?? 'OTHER') : null,
      holdNote:
        v.status === 'ON_HOLD'
          ? 'Two rejected deliveries in Q2; awaiting corrective action plan.'
          : null,
      holdBy: v.status === 'ON_HOLD' ? adminUserId : null,
      holdAt: v.status === 'ON_HOLD' ? new Date('2026-07-01T02:00:00Z') : null,
      approvedBy: v.status ? null : adminUserId,
      approvedAt: v.status ? null : now,
      reviewDate: '2026-12-31',
    });
  }
  for (const v of ['VEND-001', 'VEND-002', 'VEND-003'])
    if (vendorIds.get(v))
      await tx
        .insert(schema.vendorProfiles)
        .values({ vendorId: vendorIds.get(v)! })
        .onConflictDoNothing();
  log(
    `AP master data seeded for ${company.code} (${GROUPS.length} groups, ${NEW_VENDORS.length} vendors)`,
  );

  // -------------------------------------------------------------------- bills
  const postBill = async (input: {
    vendor: string;
    type?: 'INVOICE' | 'CREDIT_NOTE';
    date: string;
    due: string;
    vendorInvoice: string;
    description: string;
    net: string;
    account: string;
    termId?: string | null;
    discountDate?: string | null;
    discountPercent?: string;
  }): Promise<{ id: string; number: string; total: Money }> => {
    const type = input.type ?? 'INVOICE';
    const net = Money.parse(input.net, currency);
    const tax = net.multiply('0.12');
    const total = net.add(tax);
    const documentNumber = await allocateNumber(
      tx,
      company.id,
      type === 'INVOICE' ? 'BILL' : 'VCN',
      input.date,
    );
    const vendorId = vendorIds.get(input.vendor)!;
    const discountAmount =
      input.discountDate && input.discountPercent
        ? total.multiply(Number(input.discountPercent) / 100)
        : Money.zero(currency);
    const [row] = await tx
      .insert(schema.vendorBills)
      .values({
        companyId: company.id,
        vendorId,
        documentType: type,
        documentNumber,
        documentDate: input.date,
        dueDate: input.due,
        reference: input.vendorInvoice,
        vendorInvoiceNumber: type === 'INVOICE' ? input.vendorInvoice : null,
        description: input.description,
        currency,
        subtotal: total.toString(),
        taxTotal: '0',
        total: total.toString(),
        baseTotal: total.toString(),
        status: 'APPROVED',
        accountingStatus: 'UNPOSTED',
        paymentTermId: input.termId ?? null,
        discountDate: input.discountDate ?? null,
        discountAmount: discountAmount.toString(),
        createdBy: adminUserId,
        approvedBy: adminUserId,
        approvedAt: now,
      })
      .returning({ id: schema.vendorBills.id });
    await tx.insert(schema.billLines).values([
      {
        billId: row!.id,
        lineNumber: 1,
        description: input.description,
        quantity: '1',
        unitPrice: net.toString(),
        amount: net.toString(),
        accountId: input.account,
      },
      {
        billId: row!.id,
        lineNumber: 2,
        description: 'Input VAT 12%',
        quantity: '1',
        unitPrice: tax.toString(),
        amount: tax.toString(),
        accountId: inputVat,
      },
    ]);
    const debitDoc = type === 'INVOICE';
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: input.date,
        description: `${debitDoc ? 'Bill' : 'Vendor credit'} ${documentNumber} - ${input.description}`,
        reference: input.vendorInvoice,
        sourceType: 'AP_DOCUMENT',
        sourceId: row!.id,
        status: 'POSTED',
        lines: [
          {
            accountId: input.account,
            debit: debitDoc ? net.toString() : '0',
            credit: debitDoc ? '0' : net.toString(),
            memo: input.description,
          },
          {
            accountId: inputVat,
            debit: debitDoc ? tax.toString() : '0',
            credit: debitDoc ? '0' : tax.toString(),
            memo: 'Input VAT 12%',
          },
          {
            accountId: ap,
            debit: debitDoc ? '0' : total.toString(),
            credit: debitDoc ? total.toString() : '0',
            memo: `${documentNumber} - vendor payable`,
          },
        ],
      },
      adminUserId,
    );
    await tx
      .update(schema.vendorBills)
      .set({
        accountingStatus: 'POSTED',
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
      })
      .where(eq(schema.vendorBills.id, row!.id));
    return { id: row!.id, number: documentNumber, total };
  };

  const payBill = async (input: {
    vendor: string;
    date: string;
    reference: string;
    allocate: Array<{ bill: { id: string; total: Money }; amount: string; discount?: string }>;
  }): Promise<string> => {
    const vendorId = vendorIds.get(input.vendor)!;
    let cash = Money.zero(currency);
    let discount = Money.zero(currency);
    for (const a of input.allocate) {
      cash = cash.add(Money.parse(a.amount, currency));
      if (a.discount) discount = discount.add(Money.parse(a.discount, currency));
    }
    const documentNumber = await allocateNumber(tx, company.id, 'PAY', input.date);
    const [pay] = await tx
      .insert(schema.vendorPayments)
      .values({
        companyId: company.id,
        vendorId,
        documentNumber,
        paymentType: 'PAYMENT',
        status: 'APPROVED',
        paymentDate: input.date,
        amount: cash.toString(),
        baseAmount: cash.toString(),
        controlBaseAmount: cash.add(discount).toString(),
        discountAmount: discount.toString(),
        method: 'BANK_TRANSFER',
        cashAccountId: bank,
        reference: input.reference,
        externalReference: `BDO-${input.reference}`,
        currency,
        createdBy: adminUserId,
        approvedBy: adminUserId,
        approvedAt: now,
      })
      .returning({ id: schema.vendorPayments.id });
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: input.date,
        description: `Vendor payment ${documentNumber}`,
        reference: input.reference,
        sourceType: 'AP_PAYMENT',
        sourceId: pay!.id,
        status: 'POSTED',
        lines: [
          {
            accountId: ap,
            debit: cash.add(discount).toString(),
            memo: `${documentNumber} - vendor payable`,
          },
          { accountId: bank, credit: cash.toString(), memo: `${documentNumber} bank transfer` },
          ...(discount.isPositive()
            ? [
                {
                  accountId: discountAccount,
                  credit: discount.toString(),
                  memo: `${documentNumber} - early-payment discount taken`,
                },
              ]
            : []),
        ],
      },
      adminUserId,
    );
    for (const a of input.allocate) {
      const amt = Money.parse(a.amount, currency);
      const disc = a.discount ? Money.parse(a.discount, currency) : Money.zero(currency);
      await tx.insert(schema.vendorPaymentAllocations).values({
        companyId: company.id,
        billId: a.bill.id,
        paymentId: pay!.id,
        amount: amt.toString(),
        allocationDate: input.date,
        createdBy: adminUserId,
      });
      if (disc.isPositive())
        await tx.insert(schema.vendorPaymentAllocations).values({
          companyId: company.id,
          billId: a.bill.id,
          discountPaymentId: pay!.id,
          amount: disc.toString(),
          allocationDate: input.date,
          createdBy: adminUserId,
        });
      const [bill] = await tx
        .select({
          allocatedAmount: schema.vendorBills.allocatedAmount,
          total: schema.vendorBills.total,
          taken: schema.vendorBills.discountTakenAmount,
        })
        .from(schema.vendorBills)
        .where(eq(schema.vendorBills.id, a.bill.id));
      const newAllocated = Money.of(bill!.allocatedAmount, currency).add(amt).add(disc);
      await tx
        .update(schema.vendorBills)
        .set({
          allocatedAmount: newAllocated.toString(),
          discountTakenAmount: Money.of(bill!.taken, currency).add(disc).toString(),
          status: newAllocated.lessThan(Money.of(bill!.total, currency))
            ? 'PARTIALLY_PAID'
            : 'PAID',
        })
        .where(eq(schema.vendorBills.id, a.bill.id));
    }
    await tx
      .update(schema.vendorPayments)
      .set({
        status: 'POSTED',
        allocatedAmount: cash.toString(),
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
      })
      .where(eq(schema.vendorPayments.id, pay!.id));
    return pay!.id;
  };

  // Dates are relative to the demo "today" (2026-09-14) so every aging bucket is populated.
  // Nothing is dated in September: the tax e2e suite asserts on that month's tax register.
  const b004a = await postBill({
    vendor: 'VEND-004',
    date: '2026-08-25',
    due: '2026-09-24',
    vendorInvoice: 'DPI-2026-0781',
    description: 'Corrugated cartons, 5,000 pcs',
    net: '150000',
    account: expense.merchandise,
    termId: terms.D2N10,
    discountDate: '2026-09-04',
    discountPercent: '2',
  });
  // Paid inside the discount window: 2% taken.
  await payBill({
    vendor: 'VEND-004',
    date: '2026-08-31',
    reference: 'PAY-DPI-0781',
    allocate: [
      {
        bill: b004a,
        amount: b004a.total.multiply('0.98').toString(),
        discount: b004a.total.multiply('0.02').toString(),
      },
    ],
  });
  await postBill({
    vendor: 'VEND-004',
    date: '2026-08-30',
    due: '2026-09-29',
    vendorInvoice: 'DPI-2026-0802',
    description: 'Stretch film and pallets',
    net: '80000',
    account: expense.merchandise,
    termId: terms.D2N10,
    discountDate: '2026-09-09',
    discountPercent: '2',
  });
  // Discount still open on the demo date (2% until 2026-09-20).
  await postBill({
    vendor: 'VEND-005',
    date: '2026-08-31',
    due: '2026-10-15',
    vendorInvoice: 'CFF-88213',
    description: 'Inter-island freight, August',
    net: '120000',
    account: expense.misc,
    termId: terms.D2N20,
    discountDate: '2026-09-20',
    discountPercent: '2',
  });
  const b006a = await postBill({
    vendor: 'VEND-006',
    date: '2026-06-30',
    due: '2026-08-14',
    vendorInvoice: 'LFM-2026-06',
    description: 'Facilities management, June',
    net: '95000',
    account: expense.professional,
    termId: terms.NET45,
  });
  await payBill({
    vendor: 'VEND-006',
    date: '2026-08-20',
    reference: 'PAY-LFM-06',
    allocate: [{ bill: b006a, amount: '50000' }],
  });
  const b006b = await postBill({
    vendor: 'VEND-006',
    date: '2026-07-31',
    due: '2026-08-31',
    vendorInvoice: 'LFM-2026-07',
    description: 'Facilities management, July',
    net: '95000',
    account: expense.professional,
    termId: terms.NET45,
  });
  await postBill({
    vendor: 'VEND-007',
    date: '2026-08-20',
    due: '2026-08-31',
    vendorInvoice: 'BCWD-08-2026',
    description: 'Water, August',
    net: '18500',
    account: expense.utilities,
    termId: terms.NET15,
  });
  await postBill({
    vendor: 'VEND-008',
    date: '2026-05-15',
    due: '2026-06-14',
    vendorInvoice: 'PIT-0419',
    description: 'ERP implementation - phase 2 milestone',
    net: '450000',
    account: expense.professional,
    termId: terms.NET30,
  });
  await postBill({
    vendor: 'VEND-008',
    date: '2026-05-05',
    due: '2026-05-05',
    vendorInvoice: 'PIT-0377',
    description: 'ERP implementation - phase 1 milestone',
    net: '300000',
    account: expense.professional,
  });
  await postBill({
    vendor: 'VEND-008',
    type: 'CREDIT_NOTE',
    date: '2026-05-20',
    due: '2026-05-20',
    vendorInvoice: 'PIT-CN-0012',
    description: 'Credit for rework on phase 1',
    net: '30000',
    account: expense.professional,
  });
  const b009 = await postBill({
    vendor: 'VEND-009',
    date: '2026-06-05',
    due: '2026-07-05',
    vendorInvoice: 'ISF-5521',
    description: 'Steel racking, batch 3',
    net: '260000',
    account: expense.merchandise,
    termId: terms.NET30,
  });
  await postBill({
    vendor: 'VEND-002',
    date: '2026-08-28',
    due: '2026-09-12',
    vendorInvoice: 'BOS-2026-0910',
    description: 'Office supplies, Q3 replenishment',
    net: '24000',
    account: expense.supplies,
    termId: terms.NET15,
  });

  // Payment hold on the disputed steel racking (vendor also on hold).
  await tx.insert(schema.billHolds).values({
    companyId: company.id,
    billId: b009.id,
    vendorId: vendorIds.get('VEND-009')!,
    reason: 'QUALITY_ISSUE',
    note: 'Batch 3 racking failed load test; awaiting replacement or credit.',
    placedBy: adminUserId,
    placedAt: new Date('2026-07-02T02:00:00Z'),
  });
  await tx
    .update(schema.vendorBills)
    .set({ onHold: true })
    .where(eq(schema.vendorBills.id, b009.id));

  // A submitted payment run waiting for approval: the two overdue facilities bills.
  const runNumber = await allocateNumber(tx, company.id, 'PMR', '2026-08-31');
  const b006aOpen = b006a.total.subtract(Money.of('50000', currency));
  const runTotal = b006aOpen.add(b006b.total);
  const [run] = await tx
    .insert(schema.paymentRuns)
    .values({
      companyId: company.id,
      documentNumber: runNumber,
      status: 'SUBMITTED',
      cashAccountId: bank,
      currency,
      paymentDate: '2026-08-31',
      payThroughDate: '2026-08-31',
      selectionMode: 'DUE',
      method: 'BANK_TRANSFER',
      vendorGroupId: groupIds.get('CONTRACTORS')!,
      filters: { vendorIds: [vendorIds.get('VEND-006')!] },
      description: 'Contractors due through end of August',
      totalAmount: runTotal.toString(),
      totalDiscount: '0',
      lineCount: 2,
      vendorCount: 1,
      submittedBy: adminUserId,
      submittedAt: new Date('2026-08-30T08:00:00Z'),
      createdBy: adminUserId,
    })
    .returning({ id: schema.paymentRuns.id });
  await tx.insert(schema.paymentRunLines).values([
    {
      runId: run!.id,
      billId: b006a.id,
      vendorId: vendorIds.get('VEND-006')!,
      status: 'SELECTED',
      openAmount: b006aOpen.toString(),
      discountAvailable: '0',
      discountTaken: '0',
      amount: b006aOpen.toString(),
      dueDate: '2026-08-14',
    },
    {
      runId: run!.id,
      billId: b006b.id,
      vendorId: vendorIds.get('VEND-006')!,
      status: 'SELECTED',
      openAmount: b006b.total.toString(),
      discountAvailable: '0',
      discountTaken: '0',
      amount: b006b.total.toString(),
      dueDate: '2026-08-31',
    },
  ]);

  // Draft period-end accrual for August services received but not billed.
  const accrualNumber = await allocateNumber(tx, company.id, 'ACR', '2026-08-31');
  const [accrual] = await tx
    .insert(schema.apAccruals)
    .values({
      companyId: company.id,
      documentNumber: accrualNumber,
      status: 'DRAFT',
      source: 'MANUAL',
      accrualDate: '2026-08-31',
      reversalDate: '2026-10-01',
      description: 'August facilities and IT services not yet billed',
      totalAmount: '145000',
      createdBy: adminUserId,
    })
    .returning({ id: schema.apAccruals.id });
  await tx.insert(schema.apAccrualLines).values([
    {
      accrualId: accrual!.id,
      lineNumber: 1,
      vendorId: vendorIds.get('VEND-006')!,
      description: 'Facilities management, August (bill not received)',
      accountId: expense.professional,
      amount: '95000',
    },
    {
      accrualId: accrual!.id,
      lineNumber: 2,
      vendorId: vendorIds.get('VEND-008')!,
      description: 'ERP support retainer, August',
      accountId: expense.professional,
      amount: '50000',
    },
  ]);
  log(`AP demo bills, payments, hold, payment run and accrual seeded for ${company.code}`);
}
