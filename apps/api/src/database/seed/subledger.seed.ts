import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { SubledgerDocumentType } from '@accounting/types';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (m: string) => void;

const CUSTOMERS = [
  {
    code: 'CUST-001',
    name: 'Mindanao Retail Corporation',
    legalName: 'Mindanao Retail Corporation',
    taxIdentificationNumber: '111-222-333-000',
    email: 'ap@mindanaoretail.ph',
    city: 'Butuan City',
    province: 'Agusan del Norte',
    paymentTermsDays: 30,
    creditLimit: '500000',
  },
  {
    code: 'CUST-002',
    name: 'Davao Trading House',
    legalName: 'Davao Trading House Inc.',
    taxIdentificationNumber: '222-333-444-000',
    email: 'accounts@davaotrading.ph',
    city: 'Davao City',
    province: 'Davao del Sur',
    paymentTermsDays: 15,
    creditLimit: '150000',
  },
  {
    code: 'CUST-003',
    name: 'Cebu Hardware Supply',
    legalName: 'Cebu Hardware Supply Co.',
    taxIdentificationNumber: '333-444-555-000',
    email: 'finance@cebuhardware.ph',
    city: 'Cebu City',
    province: 'Cebu',
    paymentTermsDays: 45,
    creditLimit: null,
  },
];

const VENDORS = [
  {
    code: 'VEND-001',
    name: 'Metro Wholesale Distributors',
    legalName: 'Metro Wholesale Distributors Inc.',
    taxIdentificationNumber: '444-555-666-000',
    email: 'billing@metrowholesale.ph',
    city: 'Cagayan de Oro',
    province: 'Misamis Oriental',
    paymentTermsDays: 30,
  },
  {
    code: 'VEND-002',
    name: 'Butuan Office Systems',
    legalName: 'Butuan Office Systems',
    taxIdentificationNumber: '555-666-777-000',
    email: 'sales@butuanoffice.ph',
    city: 'Butuan City',
    province: 'Agusan del Norte',
    paymentTermsDays: 15,
  },
  {
    code: 'VEND-003',
    name: 'PhilPower Utilities',
    legalName: 'Philippine Power Utilities Corp.',
    taxIdentificationNumber: '666-777-888-000',
    email: 'billing@philpower.ph',
    city: 'Davao City',
    province: 'Davao del Sur',
    paymentTermsDays: 15,
  },
];

interface DocLine {
  description: string;
  quantity?: string;
  unitPrice: string;
  code: string;
}

interface Doc {
  side: 'AR' | 'AP';
  party: string;
  type: SubledgerDocumentType;
  date: string;
  due: string;
  reference?: string;
  vendorInvoiceNumber?: string;
  description?: string;
  lines: DocLine[];
  status: 'DRAFT' | 'POSTED';
  /** Payments settling this document: [date, amount, cashAccountCode, method, reference] */
  payments?: Array<{
    date: string;
    amount: string;
    cash: string;
    method: 'BANK_TRANSFER' | 'CASH' | 'CHECK';
    reference: string;
  }>;
}

/** The demo scenario: purchase on account, pay supplier, sell on account, collect; plus open and overdue items. */
const DOCUMENTS: Doc[] = [
  {
    side: 'AP',
    party: 'VEND-001',
    type: 'INVOICE',
    date: '2026-01-05',
    due: '2026-02-04',
    vendorInvoiceNumber: 'SI-10021',
    description: 'Merchandise inventory for resale',
    status: 'POSTED',
    lines: [
      { description: 'Merchandise inventory (VAT exclusive)', unitPrice: '100000', code: '1300' },
      { description: 'Input VAT 12%', unitPrice: '12000', code: '1450' },
    ],
    payments: [
      {
        date: '2026-01-20',
        amount: '112000',
        cash: '1130',
        method: 'BANK_TRANSFER',
        reference: 'CV-0001',
      },
    ],
  },
  {
    side: 'AR',
    party: 'CUST-001',
    type: 'INVOICE',
    date: '2026-01-15',
    due: '2026-02-14',
    reference: 'SO-0001',
    description: 'Merchandise sale',
    status: 'POSTED',
    lines: [
      { description: 'Merchandise (VAT exclusive)', unitPrice: '150000', code: '4100' },
      { description: 'Output VAT 12%', unitPrice: '18000', code: '2130' },
    ],
    payments: [
      {
        date: '2026-02-03',
        amount: '168000',
        cash: '1130',
        method: 'BANK_TRANSFER',
        reference: 'OR-0001',
      },
    ],
  },
  {
    side: 'AP',
    party: 'VEND-002',
    type: 'INVOICE',
    date: '2026-03-05',
    due: '2026-03-20',
    vendorInvoiceNumber: 'OS-4471',
    description: 'Office equipment',
    status: 'POSTED',
    lines: [
      {
        description: 'Office equipment - workstation set',
        quantity: '4',
        unitPrice: '30000',
        code: '1510',
      },
    ],
    payments: [
      { date: '2026-03-05', amount: '120000', cash: '1130', method: 'CHECK', reference: 'CV-0003' },
    ],
  },
  {
    side: 'AR',
    party: 'CUST-002',
    type: 'INVOICE',
    date: '2026-03-18',
    due: '2026-04-02',
    reference: 'SO-0002',
    description: 'Merchandise sale',
    status: 'POSTED',
    lines: [
      { description: 'Merchandise (VAT exclusive)', unitPrice: '85000', code: '4100' },
      { description: 'Output VAT 12%', unitPrice: '10200', code: '2130' },
    ],
  },
  {
    side: 'AR',
    party: 'CUST-002',
    type: 'CREDIT_NOTE',
    date: '2026-03-25',
    due: '2026-03-25',
    reference: 'RMA-0001',
    description: 'Returned goods from SO-0002',
    status: 'POSTED',
    lines: [
      { description: 'Returned merchandise', unitPrice: '5000', code: '4100' },
      { description: 'Output VAT 12%', unitPrice: '600', code: '2130' },
    ],
  },
  {
    side: 'AR',
    party: 'CUST-003',
    type: 'INVOICE',
    date: '2026-04-08',
    due: '2026-05-23',
    reference: 'SO-0003',
    description: 'Merchandise sale',
    status: 'POSTED',
    lines: [
      { description: 'Merchandise (VAT exclusive)', unitPrice: '42000', code: '4100' },
      { description: 'Output VAT 12%', unitPrice: '5040', code: '2130' },
    ],
    payments: [
      {
        date: '2026-05-10',
        amount: '20000',
        cash: '1130',
        method: 'BANK_TRANSFER',
        reference: 'OR-0003',
      },
    ],
  },
  {
    side: 'AP',
    party: 'VEND-003',
    type: 'INVOICE',
    date: '2026-04-30',
    due: '2026-05-15',
    vendorInvoiceNumber: 'PP-2026-04-8812',
    description: 'Electricity April 2026',
    status: 'POSTED',
    lines: [{ description: 'Electricity consumption', unitPrice: '9200', code: '6300' }],
  },
  {
    side: 'AR',
    party: 'CUST-001',
    type: 'INVOICE',
    date: '2026-09-01',
    due: '2026-10-01',
    reference: 'SO-0004',
    description: 'Merchandise sale - awaiting approval',
    status: 'DRAFT',
    lines: [
      { description: 'Merchandise (VAT exclusive)', unitPrice: '60000', code: '4100' },
      { description: 'Output VAT 12%', unitPrice: '7200', code: '2130' },
    ],
  },
];

export async function seedSubledgers(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  const customerIds = new Map<string, string>();
  for (const c of CUSTOMERS) {
    const [existing] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, company.id), eq(schema.customers.code, c.code)));
    if (existing) {
      customerIds.set(c.code, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(schema.customers)
      .values({
        companyId: company.id,
        ...c,
        defaultRevenueAccountId: codeToId.get('4100') ?? null,
      })
      .returning({ id: schema.customers.id });
    customerIds.set(c.code, row!.id);
  }
  const vendorIds = new Map<string, string>();
  for (const v of VENDORS) {
    const [existing] = await tx
      .select({ id: schema.vendors.id })
      .from(schema.vendors)
      .where(and(eq(schema.vendors.companyId, company.id), eq(schema.vendors.code, v.code)));
    if (existing) {
      vendorIds.set(v.code, existing.id);
      continue;
    }
    const [row] = await tx
      .insert(schema.vendors)
      .values({
        companyId: company.id,
        ...v,
        defaultExpenseAccountId: codeToId.get('6900') ?? null,
      })
      .returning({ id: schema.vendors.id });
    vendorIds.set(v.code, row!.id);
  }
  log(`customers/vendors ensured for ${company.code} (${CUSTOMERS.length}/${VENDORS.length})`);

  if (company.code !== 'ACME') return;
  const [anyDoc] = await tx
    .select({ id: schema.invoices.id })
    .from(schema.invoices)
    .where(eq(schema.invoices.companyId, company.id))
    .limit(1);
  if (anyDoc) return;

  const currency = company.baseCurrency;
  const ar = codeToId.get('1200')!;
  const ap = codeToId.get('2110')!;
  const now = new Date();

  for (const doc of DOCUMENTS) {
    const partyId = doc.side === 'AR' ? customerIds.get(doc.party)! : vendorIds.get(doc.party)!;
    const lines = doc.lines.map((l, i) => {
      const amount = Money.parse(l.unitPrice, currency).multiply(l.quantity ?? '1');
      return {
        lineNumber: i + 1,
        description: l.description,
        quantity: Money.of(l.quantity ?? '1', currency).toString(),
        unitPrice: Money.parse(l.unitPrice, currency).toString(),
        amount: amount.toString(),
        accountId: codeToId.get(l.code)!,
        branchId: null,
      };
    });
    const total = Money.sum(
      lines.map((l) => Money.of(l.amount, currency)),
      currency,
    );
    const numberType =
      doc.side === 'AR'
        ? ({ INVOICE: 'INV', CREDIT_NOTE: 'CN', DEBIT_NOTE: 'DN' } as const)[doc.type]
        : ({ INVOICE: 'BILL', CREDIT_NOTE: 'VCN', DEBIT_NOTE: 'VDN' } as const)[doc.type];
    const documentNumber = await allocateNumber(tx, company.id, numberType, doc.date);
    const debitDoc = doc.type !== 'CREDIT_NOTE';
    const control = doc.side === 'AR' ? ar : ap;
    // AR: Dr AR / Cr lines. AP: Dr lines / Cr AP. Credit notes mirror.
    const controlDebit = (doc.side === 'AR') === debitDoc;

    let journalEntryId: string | null = null;
    const base = {
      companyId: company.id,
      documentType: doc.type,
      documentNumber,
      status: 'DRAFT' as const,
      accountingStatus: 'UNPOSTED' as const,
      documentDate: doc.date,
      dueDate: doc.due,
      reference: doc.reference ?? null,
      description: doc.description ?? null,
      currency,
      subtotal: total.toString(),
      taxTotal: '0',
      total: total.toString(),
      baseTotal: total.toString(),
      createdBy: adminUserId,
    };
    let documentId: string;
    if (doc.side === 'AR') {
      const [row] = await tx
        .insert(schema.invoices)
        .values({ ...base, customerId: partyId })
        .returning({ id: schema.invoices.id });
      documentId = row!.id;
      await tx
        .insert(schema.invoiceLines)
        .values(lines.map((l) => ({ ...l, invoiceId: documentId })));
    } else {
      const [row] = await tx
        .insert(schema.vendorBills)
        .values({
          ...base,
          vendorId: partyId,
          vendorInvoiceNumber: doc.vendorInvoiceNumber ?? null,
        })
        .returning({ id: schema.vendorBills.id });
      documentId = row!.id;
      await tx.insert(schema.billLines).values(lines.map((l) => ({ ...l, billId: documentId })));
    }

    if (doc.status === 'POSTED') {
      journalEntryId = await insertEntry(
        tx,
        company,
        {
          date: doc.date,
          description: `${labelFor(doc.side, doc.type)} ${documentNumber}${doc.description ? ` - ${doc.description}` : ''}`,
          reference: doc.reference ?? doc.vendorInvoiceNumber ?? documentNumber,
          sourceType: doc.side === 'AR' ? 'AR_DOCUMENT' : 'AP_DOCUMENT',
          sourceId: documentId,
          status: 'POSTED',
          lines: [
            {
              accountId: control,
              debit: controlDebit ? total.toString() : '0',
              credit: controlDebit ? '0' : total.toString(),
              memo: `${documentNumber} - ${doc.side === 'AR' ? 'customer receivable' : 'vendor payable'}`,
            },
            ...lines.map((l) => ({
              accountId: l.accountId,
              debit: controlDebit ? '0' : l.amount,
              credit: controlDebit ? l.amount : '0',
              memo: l.description,
            })),
          ],
        },
        adminUserId,
      );
      const table = doc.side === 'AR' ? schema.invoices : schema.vendorBills;
      await tx
        .update(table)
        .set({
          status: 'APPROVED',
          accountingStatus: 'POSTED',
          journalEntryId,
          approvedBy: adminUserId,
          approvedAt: now,
          postedBy: adminUserId,
          postedAt: now,
        })
        .where(eq(table.id, documentId));
    }

    let allocated = Money.zero(currency);
    for (const p of doc.payments ?? []) {
      const amount = Money.parse(p.amount, currency);
      const cashAccountId = codeToId.get(p.cash)!;
      const paymentNumber = await allocateNumber(
        tx,
        company.id,
        doc.side === 'AR' ? 'RCP' : 'PAY',
        p.date,
      );
      const paymentBase = {
        companyId: company.id,
        documentNumber: paymentNumber,
        paymentType: 'PAYMENT' as const,
        status: 'DRAFT' as const,
        paymentDate: p.date,
        amount: amount.toString(),
        baseAmount: amount.toString(),
        controlBaseAmount: amount.toString(),
        method: p.method,
        cashAccountId,
        reference: p.reference,
        currency,
        createdBy: adminUserId,
      };
      const paymentTable = doc.side === 'AR' ? schema.customerPayments : schema.vendorPayments;
      const [pay] =
        doc.side === 'AR'
          ? await tx
              .insert(schema.customerPayments)
              .values({ ...paymentBase, customerId: partyId })
              .returning({ id: schema.customerPayments.id })
          : await tx
              .insert(schema.vendorPayments)
              .values({ ...paymentBase, vendorId: partyId })
              .returning({ id: schema.vendorPayments.id });
      const paymentEntry = await insertEntry(
        tx,
        company,
        {
          date: p.date,
          description: `${doc.side === 'AR' ? 'Customer receipt' : 'Vendor payment'} ${paymentNumber} - ${documentNumber}`,
          reference: p.reference,
          sourceType: doc.side === 'AR' ? 'AR_PAYMENT' : 'AP_PAYMENT',
          sourceId: pay!.id,
          status: 'POSTED',
          lines:
            doc.side === 'AR'
              ? [
                  {
                    accountId: cashAccountId,
                    debit: amount.toString(),
                    memo: `${paymentNumber} ${p.method.toLowerCase()}`,
                  },
                  {
                    accountId: ar,
                    credit: amount.toString(),
                    memo: `${paymentNumber} - customer receivable`,
                  },
                ]
              : [
                  {
                    accountId: ap,
                    debit: amount.toString(),
                    memo: `${paymentNumber} - vendor payable`,
                  },
                  {
                    accountId: cashAccountId,
                    credit: amount.toString(),
                    memo: `${paymentNumber} ${p.method.toLowerCase()}`,
                  },
                ],
        },
        adminUserId,
      );
      await tx
        .update(paymentTable)
        .set({
          status: 'POSTED',
          allocatedAmount: amount.toString(),
          journalEntryId: paymentEntry,
          postedBy: adminUserId,
          postedAt: now,
        })
        .where(eq(paymentTable.id, pay!.id));
      if (doc.side === 'AR') {
        await tx.insert(schema.paymentAllocations).values({
          companyId: company.id,
          invoiceId: documentId,
          paymentId: pay!.id,
          amount: amount.toString(),
          allocationDate: p.date,
          createdBy: adminUserId,
        });
      } else {
        await tx.insert(schema.vendorPaymentAllocations).values({
          companyId: company.id,
          billId: documentId,
          paymentId: pay!.id,
          amount: amount.toString(),
          allocationDate: p.date,
          createdBy: adminUserId,
        });
      }
      allocated = allocated.add(amount);
    }
    if (!allocated.isZero()) {
      const status = allocated.lessThan(total) ? 'PARTIALLY_PAID' : 'PAID';
      const table = doc.side === 'AR' ? schema.invoices : schema.vendorBills;
      await tx
        .update(table)
        .set({ allocatedAmount: allocated.toString(), status })
        .where(eq(table.id, documentId));
    }
  }
  log(`AR/AP sample documents created for ${company.code} (${DOCUMENTS.length})`);
}

function labelFor(side: 'AR' | 'AP', type: SubledgerDocumentType): string {
  if (side === 'AR')
    return type === 'INVOICE' ? 'Invoice' : type === 'CREDIT_NOTE' ? 'Credit note' : 'Debit note';
  return type === 'INVOICE'
    ? 'Vendor bill'
    : type === 'CREDIT_NOTE'
      ? 'Vendor credit note'
      : 'Vendor debit note';
}
