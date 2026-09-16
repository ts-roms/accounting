import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { CustomerType, DunningStep, PaymentTermBasis } from '@accounting/types';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

/**
 * Prompt #6 demo data: payment terms, customer groups, credit rules, a
 * dunning policy, ten customers with contacts / addresses / credit profiles,
 * open sales orders, invoices across every aging bucket (current, partially
 * paid, overpaid, overdue, on hold), a credit note, collection cases,
 * promises to pay, a dispute and a pending write-off. Idempotent: skipped
 * when the company already has customer groups.
 */
export async function seedReceivables(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [anyGroup] = await tx
    .select({ id: schema.customerGroups.id })
    .from(schema.customerGroups)
    .where(eq(schema.customerGroups.companyId, company.id))
    .limit(1);
  if (anyGroup) return;

  const currency = company.baseCurrency;
  const now = new Date();
  const ar = codeToId.get('1200')!;
  const revenue = codeToId.get('4100')!;
  const service = codeToId.get('4200')!;
  const vat = codeToId.get('2130')!;
  const bank = codeToId.get('1130')!;

  // ---------------------------------------------------------- payment terms
  const TERMS: Array<{
    code: string;
    name: string;
    basis: PaymentTermBasis;
    days: number;
    dayOfMonth?: number;
  }> = [
    { code: 'COD', name: 'Cash on delivery', basis: 'DUE_ON_RECEIPT', days: 0 },
    { code: 'NET7', name: 'Net 7 days', basis: 'NET_DAYS', days: 7 },
    { code: 'NET15', name: 'Net 15 days', basis: 'NET_DAYS', days: 15 },
    { code: 'NET30', name: 'Net 30 days', basis: 'NET_DAYS', days: 30 },
    { code: 'NET45', name: 'Net 45 days', basis: 'NET_DAYS', days: 45 },
    { code: 'NET60', name: 'Net 60 days', basis: 'NET_DAYS', days: 60 },
    { code: 'NET90', name: 'Net 90 days', basis: 'NET_DAYS', days: 90 },
    { code: 'EOM15', name: 'End of month + 15', basis: 'END_OF_MONTH', days: 15 },
  ];
  const termIds = new Map<string, string>();
  for (const t of TERMS) {
    const [row] = await tx
      .insert(schema.paymentTerms)
      .values({ companyId: company.id, ...t, dayOfMonth: t.dayOfMonth ?? null })
      .returning({ id: schema.paymentTerms.id });
    termIds.set(t.code, row!.id);
  }

  // --------------------------------------------------------- dunning policy
  const steps: DunningStep[] = [
    { daysOverdue: 0, action: 'REMINDER', label: 'Payment due' },
    { daysOverdue: 7, action: 'REMINDER', label: 'First reminder' },
    { daysOverdue: 30, action: 'ESCALATION', label: 'Escalation to collections' },
    { daysOverdue: 120, action: 'CREDIT_HOLD', label: 'Credit hold' },
  ];
  const [policy] = await tx
    .insert(schema.dunningPolicies)
    .values({
      companyId: company.id,
      name: 'Standard dunning',
      description: 'Reminder on the due date and at 7 days, escalation at 30, credit hold at 120.',
      steps,
      minimumAmount: '1000',
      isDefault: true,
    })
    .returning({ id: schema.dunningPolicies.id });

  // -------------------------------------------------------- customer groups
  const GROUPS = [
    { code: 'RETAIL', name: 'Retail', term: 'NET15', limit: '150000', discount: '0' },
    { code: 'WHOLESALE', name: 'Wholesale', term: 'NET30', limit: '500000', discount: '5' },
    { code: 'CORPORATE', name: 'Corporate', term: 'NET45', limit: '1000000', discount: '3' },
    { code: 'GOVERNMENT', name: 'Government', term: 'NET60', limit: '2000000', discount: '0' },
    { code: 'INTL', name: 'International', term: 'NET30', limit: '750000', discount: '0' },
  ];
  const groupIds = new Map<string, string>();
  for (const g of GROUPS) {
    const [row] = await tx
      .insert(schema.customerGroups)
      .values({
        companyId: company.id,
        code: g.code,
        name: g.name,
        paymentTermId: termIds.get(g.term)!,
        defaultCreditLimit: g.limit,
        priceDiscountPercent: g.discount,
        dunningPolicyId: policy!.id,
      })
      .returning({ id: schema.customerGroups.id });
    groupIds.set(g.code, row!.id);
  }

  // ----------------------------------------------------------- credit rules
  await tx.insert(schema.creditRules).values([
    {
      companyId: company.id,
      name: 'Orders over the credit limit need approval',
      scope: 'SALES_ORDER',
      trigger: 'EXPOSURE_OVER_LIMIT',
      action: 'REQUIRE_APPROVAL',
      thresholdPercent: '0',
      priority: 10,
    },
    {
      companyId: company.id,
      name: 'Block new orders when overdue exceeds 250,000',
      scope: 'SALES_ORDER',
      trigger: 'OVERDUE_BALANCE',
      action: 'BLOCK',
      thresholdAmount: '250000',
      priority: 20,
    },
    {
      companyId: company.id,
      name: 'Orders for customers 90+ days overdue need approval',
      scope: 'SALES_ORDER',
      trigger: 'DAYS_OVERDUE',
      action: 'REQUIRE_APPROVAL',
      thresholdDays: 90,
      priority: 30,
    },
    {
      companyId: company.id,
      name: 'Invoices over the credit limit are flagged',
      scope: 'INVOICE',
      trigger: 'EXPOSURE_OVER_LIMIT',
      action: 'WARN',
      thresholdPercent: '0',
      priority: 10,
    },
    {
      companyId: company.id,
      name: 'Customers without a credit limit are flagged',
      scope: 'INVOICE',
      trigger: 'NO_CREDIT_LIMIT',
      action: 'WARN',
      priority: 40,
    },
  ]);

  // -------------------------------------------------------------- settings
  await tx
    .insert(schema.arSettings)
    .values({
      companyId: company.id,
      dsoWindowDays: 90,
      unappliedCashWarnDays: 30,
      smallBalanceThreshold: '500',
      autoCaseDaysOverdue: 30,
      provisionRates: {
        current: '0',
        days1to30: '1',
        days31to60: '5',
        days61to90: '10',
        days91to120: '25',
        over120: '50',
      },
      defaultDunningPolicyId: policy!.id,
      defaultPaymentTermId: termIds.get('NET30')!,
    })
    .onConflictDoUpdate({
      target: schema.arSettings.companyId,
      set: { defaultDunningPolicyId: policy!.id, defaultPaymentTermId: termIds.get('NET30')! },
    });

  // ------------------------------------------------------------- customers
  const salespeople = await tx
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.organizationId, company.organizationId));
  const sales = salespeople.find((u) => u.email === 'accountant@acme.local')?.id ?? null;
  const manager = salespeople.find((u) => u.email === 'finance@acme.local')?.id ?? null;

  // Existing demo customers join the master data.
  const upgrades: Array<[string, string, string, CustomerType]> = [
    ['CUST-001', 'WHOLESALE', 'NET30', 'BUSINESS'],
    ['CUST-002', 'RETAIL', 'NET15', 'BUSINESS'],
    ['CUST-003', 'CORPORATE', 'NET45', 'BUSINESS'],
  ];
  for (const [code, group, term, type] of upgrades) {
    await tx
      .update(schema.customers)
      .set({
        customerGroupId: groupIds.get(group)!,
        paymentTermId: termIds.get(term)!,
        customerType: type,
        salespersonId: sales,
        region: 'Mindanao',
      })
      .where(and(eq(schema.customers.companyId, company.id), eq(schema.customers.code, code)));
  }

  const NEW_CUSTOMERS: Array<{
    code: string;
    name: string;
    legalName: string;
    type: CustomerType;
    group: string;
    term: string;
    limit: string | null;
    tin: string;
    email: string;
    city: string;
    province: string;
    industry: string;
    region: string;
    hold?: string;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH';
    contact: { name: string; title: string; email: string; phone: string };
  }> = [
    {
      code: 'CUST-004',
      name: 'Iligan Steel Fabricators',
      legalName: 'Iligan Steel Fabricators Inc.',
      type: 'BUSINESS',
      group: 'WHOLESALE',
      term: 'NET30',
      limit: '400000',
      tin: '444-111-222-000',
      email: 'ap@iligansteel.ph',
      city: 'Iligan City',
      province: 'Lanao del Norte',
      industry: 'Manufacturing',
      region: 'Mindanao',
      risk: 'MEDIUM',
      contact: {
        name: 'Ramon Dela Cruz',
        title: 'Accounts Payable Supervisor',
        email: 'ramon@iligansteel.ph',
        phone: '+63 917 555 0104',
      },
    },
    {
      code: 'CUST-005',
      name: 'Sunrise Grocers',
      legalName: 'Sunrise Grocers Corporation',
      type: 'BUSINESS',
      group: 'RETAIL',
      term: 'NET15',
      limit: '120000',
      tin: '555-222-333-000',
      email: 'finance@sunrisegrocers.ph',
      city: 'Cagayan de Oro',
      province: 'Misamis Oriental',
      industry: 'Retail',
      region: 'Mindanao',
      contact: {
        name: 'Liza Mercado',
        title: 'Finance Officer',
        email: 'liza@sunrisegrocers.ph',
        phone: '+63 917 555 0105',
      },
    },
    {
      code: 'CUST-006',
      name: 'Visayas Logistics Corp',
      legalName: 'Visayas Logistics Corporation',
      type: 'BUSINESS',
      group: 'CORPORATE',
      term: 'NET45',
      limit: '900000',
      tin: '666-333-444-000',
      email: 'payables@vislog.ph',
      city: 'Cebu City',
      province: 'Cebu',
      industry: 'Logistics',
      region: 'Visayas',
      contact: {
        name: 'Antonio Reyes',
        title: 'Treasury Manager',
        email: 'antonio@vislog.ph',
        phone: '+63 917 555 0106',
      },
    },
    {
      code: 'CUST-007',
      name: 'Manila Bay Resorts',
      legalName: 'Manila Bay Resorts and Hotels Inc.',
      type: 'BUSINESS',
      group: 'CORPORATE',
      term: 'NET30',
      limit: '600000',
      tin: '777-444-555-000',
      email: 'ap@manilabayresorts.ph',
      city: 'Pasay City',
      province: 'Metro Manila',
      industry: 'Hospitality',
      region: 'Luzon',
      contact: {
        name: 'Carla Santos',
        title: 'Purchasing Head',
        email: 'carla@manilabayresorts.ph',
        phone: '+63 917 555 0107',
      },
    },
    {
      code: 'CUST-008',
      name: 'Province of Agusan del Norte',
      legalName: 'Provincial Government of Agusan del Norte',
      type: 'GOVERNMENT',
      group: 'GOVERNMENT',
      term: 'NET60',
      limit: '2000000',
      tin: '888-555-666-000',
      email: 'accounting@agusandelnorte.gov.ph',
      city: 'Butuan City',
      province: 'Agusan del Norte',
      industry: 'Government',
      region: 'Mindanao',
      contact: {
        name: 'Engr. Paolo Villanueva',
        title: 'Provincial Accountant',
        email: 'paolo@agusandelnorte.gov.ph',
        phone: '+63 85 555 0108',
      },
    },
    {
      code: 'CUST-009',
      name: 'Tagum Farm Supply',
      legalName: 'Tagum Farm Supply',
      type: 'BUSINESS',
      group: 'RETAIL',
      term: 'NET15',
      limit: '80000',
      tin: '999-666-777-000',
      email: 'owner@tagumfarm.ph',
      city: 'Tagum City',
      province: 'Davao del Norte',
      industry: 'Agriculture',
      region: 'Mindanao',
      hold: 'Invoice INV 120+ days overdue and no response to reminders',
      risk: 'HIGH',
      contact: {
        name: 'Benjie Lim',
        title: 'Owner',
        email: 'benjie@tagumfarm.ph',
        phone: '+63 917 555 0109',
      },
    },
    {
      code: 'CUST-010',
      name: 'Maria Clara Bautista',
      legalName: 'Maria Clara Bautista',
      type: 'INDIVIDUAL',
      group: 'RETAIL',
      term: 'NET7',
      limit: null,
      tin: '123-987-654-000',
      email: 'mcbautista@gmail.example',
      city: 'Davao City',
      province: 'Davao del Sur',
      industry: 'Individual',
      region: 'Mindanao',
      contact: {
        name: 'Maria Clara Bautista',
        title: 'Customer',
        email: 'mcbautista@gmail.example',
        phone: '+63 917 555 0110',
      },
    },
  ];
  const customerIds = new Map<string, string>();
  for (const c of ['CUST-001', 'CUST-002', 'CUST-003']) {
    const [row] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, company.id), eq(schema.customers.code, c)));
    if (row) customerIds.set(c, row.id);
  }
  for (const c of NEW_CUSTOMERS) {
    const [row] = await tx
      .insert(schema.customers)
      .values({
        companyId: company.id,
        code: c.code,
        name: c.name,
        legalName: c.legalName,
        displayName: c.name,
        customerType: c.type,
        customerGroupId: groupIds.get(c.group)!,
        paymentTermId: termIds.get(c.term)!,
        paymentTermsDays: TERMS.find((t) => t.code === c.term)!.days,
        creditLimit: c.limit,
        taxIdentificationNumber: c.tin,
        email: c.email,
        city: c.city,
        province: c.province,
        industry: c.industry,
        region: c.region,
        salespersonId: c.type === 'GOVERNMENT' ? manager : sales,
        defaultRevenueAccountId: revenue,
        currency,
      })
      .returning({ id: schema.customers.id });
    customerIds.set(c.code, row!.id);
    await tx.insert(schema.customerContacts).values({
      customerId: row!.id,
      name: c.contact.name,
      title: c.contact.title,
      email: c.contact.email,
      phone: c.contact.phone,
      isPrimary: true,
    });
    await tx.insert(schema.customerAddresses).values([
      {
        customerId: row!.id,
        addressType: 'BILLING',
        label: 'Head office',
        addressLine1: `${c.name} Building`,
        city: c.city,
        province: c.province,
        country: 'PH',
        isDefault: true,
      },
      {
        customerId: row!.id,
        addressType: 'SHIPPING',
        label: 'Warehouse',
        addressLine1: 'Receiving dock, industrial area',
        city: c.city,
        province: c.province,
        country: 'PH',
        isDefault: true,
      },
    ]);
    await tx.insert(schema.customerCreditProfiles).values({
      customerId: row!.id,
      creditHold: Boolean(c.hold),
      creditHoldReason: c.hold ?? null,
      creditHoldAt: c.hold ? now : null,
      creditHoldBy: c.hold ? adminUserId : null,
      creditHoldSource: c.hold ? 'MANUAL' : null,
      riskRating: c.risk ?? 'LOW',
      reviewDate: '2026-12-31',
    });
  }
  for (const c of ['CUST-001', 'CUST-002', 'CUST-003'])
    await tx
      .insert(schema.customerCreditProfiles)
      .values({ customerId: customerIds.get(c)! })
      .onConflictDoNothing();
  log(
    `AR master data seeded for ${company.code} (${TERMS.length} terms, ${GROUPS.length} groups, ${NEW_CUSTOMERS.length} customers)`,
  );

  // ---------------------------------------------------------------- helpers
  const postInvoice = async (input: {
    customer: string;
    type?: 'INVOICE' | 'CREDIT_NOTE';
    date: string;
    due: string;
    reference: string;
    description: string;
    net: string;
    account?: string;
    vatRate?: string;
  }): Promise<{ id: string; number: string; total: Money }> => {
    const type = input.type ?? 'INVOICE';
    const net = Money.parse(input.net, currency);
    const tax = net.multiply(input.vatRate ?? '0.12');
    const total = net.add(tax);
    const numberType = type === 'INVOICE' ? 'INV' : 'CN';
    const documentNumber = await allocateNumber(tx, company.id, numberType, input.date);
    const customerId = customerIds.get(input.customer)!;
    const [row] = await tx
      .insert(schema.invoices)
      .values({
        companyId: company.id,
        customerId,
        documentType: type,
        documentNumber,
        documentDate: input.date,
        dueDate: input.due,
        reference: input.reference,
        description: input.description,
        currency,
        subtotal: total.toString(),
        taxTotal: '0',
        total: total.toString(),
        baseTotal: total.toString(),
        status: 'APPROVED',
        accountingStatus: 'UNPOSTED',
        createdBy: adminUserId,
        approvedBy: adminUserId,
        approvedAt: now,
        paymentTermId: null,
      })
      .returning({ id: schema.invoices.id });
    const lineAccount = input.account ?? revenue;
    await tx.insert(schema.invoiceLines).values([
      {
        invoiceId: row!.id,
        lineNumber: 1,
        description: input.description,
        quantity: '1',
        unitPrice: net.toString(),
        amount: net.toString(),
        accountId: lineAccount,
      },
      ...(tax.isZero()
        ? []
        : [
            {
              invoiceId: row!.id,
              lineNumber: 2,
              description: 'Output VAT 12%',
              quantity: '1',
              unitPrice: tax.toString(),
              amount: tax.toString(),
              accountId: vat,
            },
          ]),
    ]);
    const debitDoc = type === 'INVOICE';
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: input.date,
        description: `${debitDoc ? 'Invoice' : 'Credit note'} ${documentNumber} - ${input.description}`,
        reference: input.reference,
        sourceType: 'AR_DOCUMENT',
        sourceId: row!.id,
        status: 'POSTED',
        lines: [
          {
            accountId: ar,
            debit: debitDoc ? total.toString() : '0',
            credit: debitDoc ? '0' : total.toString(),
            memo: `${documentNumber} - customer receivable`,
          },
          {
            accountId: lineAccount,
            debit: debitDoc ? '0' : net.toString(),
            credit: debitDoc ? net.toString() : '0',
            memo: input.description,
          },
          ...(tax.isZero()
            ? []
            : [
                {
                  accountId: vat,
                  debit: debitDoc ? '0' : tax.toString(),
                  credit: debitDoc ? tax.toString() : '0',
                  memo: 'Output VAT 12%',
                },
              ]),
        ],
      },
      adminUserId,
    );
    await tx
      .update(schema.invoices)
      .set({
        accountingStatus: 'POSTED',
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
      })
      .where(eq(schema.invoices.id, row!.id));
    return { id: row!.id, number: documentNumber, total };
  };

  const postReceipt = async (input: {
    customer: string;
    date: string;
    amount: string;
    reference: string;
    allocate: Array<{ invoice: { id: string; total: Money }; amount: string }>;
  }): Promise<string> => {
    const amount = Money.parse(input.amount, currency);
    const documentNumber = await allocateNumber(tx, company.id, 'RCP', input.date);
    const customerId = customerIds.get(input.customer)!;
    const [pay] = await tx
      .insert(schema.customerPayments)
      .values({
        companyId: company.id,
        customerId,
        documentNumber,
        paymentType: 'PAYMENT',
        status: 'APPROVED',
        paymentDate: input.date,
        amount: amount.toString(),
        baseAmount: amount.toString(),
        controlBaseAmount: amount.toString(),
        method: 'BANK_TRANSFER',
        cashAccountId: bank,
        reference: input.reference,
        externalReference: `BDO-${input.reference}`,
        currency,
        createdBy: adminUserId,
        approvedBy: adminUserId,
        approvedAt: now,
      })
      .returning({ id: schema.customerPayments.id });
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: input.date,
        description: `Customer receipt ${documentNumber}`,
        reference: input.reference,
        sourceType: 'AR_PAYMENT',
        sourceId: pay!.id,
        status: 'POSTED',
        lines: [
          { accountId: bank, debit: amount.toString(), memo: `${documentNumber} bank transfer` },
          {
            accountId: ar,
            credit: amount.toString(),
            memo: `${documentNumber} - customer receivable`,
          },
        ],
      },
      adminUserId,
    );
    let allocated = Money.zero(currency);
    for (const a of input.allocate) {
      const amt = Money.parse(a.amount, currency);
      allocated = allocated.add(amt);
      await tx.insert(schema.paymentAllocations).values({
        companyId: company.id,
        invoiceId: a.invoice.id,
        paymentId: pay!.id,
        amount: amt.toString(),
        allocationDate: input.date,
        createdBy: adminUserId,
      });
      const [inv] = await tx
        .select({ allocatedAmount: schema.invoices.allocatedAmount, total: schema.invoices.total })
        .from(schema.invoices)
        .where(eq(schema.invoices.id, a.invoice.id));
      const newAllocated = Money.of(inv!.allocatedAmount, currency).add(amt);
      await tx
        .update(schema.invoices)
        .set({
          allocatedAmount: newAllocated.toString(),
          status: newAllocated.lessThan(Money.of(inv!.total, currency)) ? 'PARTIALLY_PAID' : 'PAID',
        })
        .where(eq(schema.invoices.id, a.invoice.id));
    }
    await tx
      .update(schema.customerPayments)
      .set({
        status: 'POSTED',
        allocatedAmount: allocated.toString(),
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
      })
      .where(eq(schema.customerPayments.id, pay!.id));
    return pay!.id;
  };

  // --------------------------------------------------------------- invoices
  // Dates are relative to the demo "today" (2026-09-14) so every aging bucket is populated.
  // Nothing is dated in September: the tax e2e suite asserts on that month's tax register.
  const inv004 = await postInvoice({
    customer: 'CUST-004',
    date: '2026-05-10',
    due: '2026-06-09',
    reference: 'SO-2026-104',
    description: 'Structural steel fabrication supplies',
    net: '200000',
  });
  await postReceipt({
    customer: 'CUST-004',
    date: '2026-06-15',
    amount: '100000',
    reference: 'OR-2026-0104',
    allocate: [{ invoice: inv004, amount: '100000' }],
  });
  const inv005 = await postInvoice({
    customer: 'CUST-005',
    date: '2026-07-01',
    due: '2026-07-16',
    reference: 'SO-2026-105',
    description: 'Grocery merchandise - July',
    net: '50000',
  });
  await postReceipt({
    customer: 'CUST-005',
    date: '2026-07-20',
    amount: '60000',
    reference: 'OR-2026-0105',
    allocate: [{ invoice: inv005, amount: '56000' }],
  });
  await postInvoice({
    customer: 'CUST-005',
    type: 'CREDIT_NOTE',
    date: '2026-08-05',
    due: '2026-08-05',
    reference: 'RMA-2026-0105',
    description: 'Damaged goods returned',
    net: '5000',
  });
  await postInvoice({
    customer: 'CUST-006',
    date: '2026-08-20',
    due: '2026-10-04',
    reference: 'SO-2026-106',
    description: 'Fleet maintenance parts',
    net: '300000',
  });
  await postInvoice({
    customer: 'CUST-006',
    date: '2026-06-05',
    due: '2026-07-20',
    reference: 'SO-2026-096',
    description: 'Warehouse racking',
    net: '80000',
  });
  const inv007 = await postInvoice({
    customer: 'CUST-007',
    date: '2026-08-01',
    due: '2026-08-31',
    reference: 'SO-2026-107',
    description: 'Hotel linen and amenities',
    net: '40000',
  });
  const inv008 = await postInvoice({
    customer: 'CUST-008',
    date: '2026-04-01',
    due: '2026-05-31',
    reference: 'PO-AGN-2026-014',
    description: 'Office furniture for provincial capitol',
    net: '1000000',
  });
  const inv009 = await postInvoice({
    customer: 'CUST-009',
    date: '2026-03-01',
    due: '2026-03-16',
    reference: 'SO-2026-071',
    description: 'Farm tools and fertiliser',
    net: '20000',
  });
  await postInvoice({
    customer: 'CUST-010',
    date: '2026-08-28',
    due: '2026-09-04',
    reference: 'SO-2026-110',
    description: 'Home appliance',
    net: '10000',
  });
  await postInvoice({
    customer: 'CUST-003',
    date: '2026-08-29',
    due: '2026-10-16',
    reference: 'SO-2026-103',
    description: 'Hardware consignment',
    net: '60000',
  });
  await postInvoice({
    customer: 'CUST-006',
    date: '2026-08-31',
    due: '2026-10-20',
    reference: 'SVC-2026-006',
    description: 'Logistics consulting retainer',
    net: '25000',
    account: service,
  });
  log(`AR demo invoices and receipts posted for ${company.code}`);

  // ------------------------------------------------------------ sales orders
  const openOrders: Array<{
    customer: string;
    date: string;
    status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'CONFIRMED';
    reference: string;
    description: string;
    amount: string;
    qty: string;
  }> = [
    {
      customer: 'CUST-006',
      date: '2026-09-10',
      status: 'CONFIRMED',
      reference: 'PO-VL-2291',
      description: 'Pallet jacks',
      amount: '45000',
      qty: '4',
    },
    {
      customer: 'CUST-004',
      date: '2026-09-12',
      status: 'SUBMITTED',
      reference: 'PO-ISF-771',
      description: 'Welding consumables',
      amount: '12500',
      qty: '20',
    },
    {
      customer: 'CUST-008',
      date: '2026-09-13',
      status: 'DRAFT',
      reference: 'PR-AGN-2026-031',
      description: 'Computer workstations',
      amount: '38000',
      qty: '15',
    },
  ];
  for (const o of openOrders) {
    const gross = Money.parse(o.amount, currency).multiply(o.qty);
    const documentNumber = await allocateNumber(tx, company.id, 'SO', o.date);
    const [order] = await tx
      .insert(schema.orders)
      .values({
        companyId: company.id,
        orderType: 'SALES_ORDER',
        documentNumber,
        status: o.status,
        customerId: customerIds.get(o.customer)!,
        orderDate: o.date,
        expectedDate: '2026-09-30',
        reference: o.reference,
        description: o.description,
        currency,
        subtotal: gross.toString(),
        discountTotal: '0',
        total: gross.toString(),
        paymentTermId: termIds.get('NET30')!,
        salespersonId: sales,
        createdBy: adminUserId,
        submittedAt: o.status === 'DRAFT' ? null : now,
        approvedBy: o.status === 'APPROVED' || o.status === 'CONFIRMED' ? adminUserId : null,
        approvedAt: o.status === 'APPROVED' || o.status === 'CONFIRMED' ? now : null,
        confirmedBy: o.status === 'CONFIRMED' ? adminUserId : null,
        confirmedAt: o.status === 'CONFIRMED' ? now : null,
      })
      .returning({ id: schema.orders.id });
    await tx.insert(schema.orderLines).values({
      orderId: order!.id,
      lineNumber: 1,
      description: o.description,
      quantity: Money.of(o.qty, currency).toString(),
      unitPrice: Money.parse(o.amount, currency).toString(),
      discountPercent: '0',
      amount: gross.toString(),
      accountId: revenue,
      unit: 'pc',
    });
  }

  // ------------------------------------------------------------ collections
  const openCase = async (
    customer: string,
    status: 'CONTACTED' | 'PROMISED' | 'ESCALATED' | 'DISPUTED',
    extra: {
      nextAction: string;
      nextActionAt: string;
      escalation?: number;
      source?: 'MANUAL' | 'AUTO' | 'DUNNING';
    },
  ) => {
    const documentNumber = await allocateNumber(tx, company.id, 'COL', '2026-09-01');
    const [row] = await tx
      .insert(schema.collectionCases)
      .values({
        companyId: company.id,
        documentNumber,
        customerId: customerIds.get(customer)!,
        status,
        collectorId: manager ?? adminUserId,
        lastContactAt: now,
        nextAction: extra.nextAction,
        nextActionAt: extra.nextActionAt,
        escalationLevel: extra.escalation ?? 0,
        source: extra.source ?? 'MANUAL',
        createdBy: adminUserId,
      })
      .returning({ id: schema.collectionCases.id });
    return row!.id;
  };
  const case004 = await openCase('CUST-004', 'CONTACTED', {
    nextAction: 'Call AP supervisor about the June balance',
    nextActionAt: '2026-09-18',
  });
  await tx.insert(schema.collectionActivities).values([
    {
      caseId: case004,
      customerId: customerIds.get('CUST-004')!,
      invoiceId: inv004.id,
      activityType: 'CALL',
      summary: 'Spoke with Ramon: partial payment made in June, balance awaiting budget release',
      contactName: 'Ramon Dela Cruz',
      performedBy: manager ?? adminUserId,
    },
    {
      caseId: case004,
      customerId: customerIds.get('CUST-004')!,
      invoiceId: inv004.id,
      activityType: 'EMAIL',
      summary: 'Sent statement of account and copy of INV',
      performedBy: manager ?? adminUserId,
    },
  ]);
  const case008 = await openCase('CUST-008', 'PROMISED', {
    nextAction: 'Verify promised payment',
    nextActionAt: '2026-09-30',
  });
  const [promise] = await tx
    .insert(schema.promisesToPay)
    .values({
      companyId: company.id,
      customerId: customerIds.get('CUST-008')!,
      caseId: case008,
      currency,
      amount: '500000',
      promiseDate: '2026-09-30',
      invoiceIds: [inv008.id],
      collectorId: manager ?? adminUserId,
      notes: 'Partial release from the Q3 disbursement voucher; balance after audit clearance.',
      createdBy: adminUserId,
    })
    .returning({ id: schema.promisesToPay.id });
  await tx.insert(schema.collectionActivities).values({
    caseId: case008,
    customerId: customerIds.get('CUST-008')!,
    invoiceId: inv008.id,
    activityType: 'PROMISE',
    summary: `Promise to pay ${currency} 500,000 by 2026-09-30`,
    contactName: 'Engr. Paolo Villanueva',
    performedBy: manager ?? adminUserId,
  });
  void promise;
  const case009 = await openCase('CUST-009', 'ESCALATED', {
    nextAction: 'Prepare demand letter; evaluate write-off',
    nextActionAt: '2026-09-20',
    escalation: 2,
    source: 'DUNNING',
  });
  await tx.insert(schema.collectionActivities).values([
    {
      caseId: case009,
      customerId: customerIds.get('CUST-009')!,
      invoiceId: inv009.id,
      activityType: 'DUNNING',
      summary: 'First reminder - INV 7 days overdue',
      dunningPolicyId: policy!.id,
      dunningStep: 1,
      performedAt: new Date('2026-03-24T08:00:00Z'),
    },
    {
      caseId: case009,
      customerId: customerIds.get('CUST-009')!,
      invoiceId: inv009.id,
      activityType: 'ESCALATION',
      summary: 'Escalation to collections - 30 days overdue',
      dunningPolicyId: policy!.id,
      dunningStep: 2,
      performedAt: new Date('2026-04-16T08:00:00Z'),
    },
    {
      caseId: case009,
      customerId: customerIds.get('CUST-009')!,
      invoiceId: inv009.id,
      activityType: 'CREDIT_HOLD',
      summary: 'Customer placed on credit hold - 60 days overdue',
      dunningPolicyId: policy!.id,
      dunningStep: 3,
      performedAt: new Date('2026-05-16T08:00:00Z'),
    },
  ]);
  const woNumber = await allocateNumber(tx, company.id, 'WO', '2026-09-10');
  await tx.insert(schema.writeOffRequests).values({
    companyId: company.id,
    documentNumber: woNumber,
    invoiceId: inv009.id,
    customerId: customerIds.get('CUST-009')!,
    status: 'SUBMITTED',
    reason: 'BAD_DEBT',
    justification:
      'Customer unresponsive for 5 months; demand letter returned. Recommend write-off pending legal review.',
    currency,
    amount: inv009.total.toString(),
    exchangeRate: '1',
    baseAmount: inv009.total.toString(),
    requestedBy: adminUserId,
    submittedAt: now,
  });

  const case007 = await openCase('CUST-007', 'DISPUTED', {
    nextAction: 'Resolve pricing dispute with sales',
    nextActionAt: '2026-09-16',
  });
  const dspNumber = await allocateNumber(tx, company.id, 'DSP', '2026-09-08');
  await tx.insert(schema.invoiceDisputes).values({
    companyId: company.id,
    documentNumber: dspNumber,
    invoiceId: inv007.id,
    customerId: customerIds.get('CUST-007')!,
    caseId: case007,
    status: 'INVESTIGATING',
    reason: 'INCORRECT_PRICE',
    currency,
    amount: '4480',
    description: 'Customer claims the contracted linen price was 2,000 per set, invoiced at 2,200.',
    raisedBy: 'Carla Santos',
    assigneeId: sales,
    openedBy: adminUserId,
  });
  await tx.insert(schema.collectionActivities).values({
    caseId: case007,
    customerId: customerIds.get('CUST-007')!,
    invoiceId: inv007.id,
    activityType: 'DISPUTE',
    summary: `Dispute ${dspNumber} opened on ${inv007.number} (incorrect price)`,
    performedBy: adminUserId,
  });
  log(
    `AR collections demo seeded for ${company.code} (4 cases, 1 promise, 1 dispute, 1 write-off request)`,
  );
}
