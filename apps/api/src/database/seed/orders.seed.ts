import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { OrderStatus, OrderType } from '@accounting/types';
import * as schema from '../schema';
import { allocateNumber } from './seed-ledger';
import type { Tx } from './seed';

type Log = (m: string) => void;

/**
 * Phase 4 sample documents for ACME: a converted quotation and its approved
 * sales order, an open quotation, a submitted purchase request and an approved
 * purchase order with a confirmed partial receipt. Orders carry no ledger
 * effect, so this seed only writes order tables.
 */

interface SeedLine {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPercent?: string;
  code: string;
  received?: string;
}

interface SeedOrder {
  type: OrderType;
  party: string;
  date: string;
  expected?: string;
  reference?: string;
  description: string;
  status: OrderStatus;
  lines: SeedLine[];
  /** Key of the order this one was converted from. */
  convertedFrom?: string;
  key: string;
  receipt?: { date: string; reference: string };
}

const ORDERS: SeedOrder[] = [
  {
    key: 'qt1',
    type: 'QUOTATION',
    party: 'CUST-002',
    date: '2026-08-20',
    expected: '2026-09-20',
    reference: 'RFQ-2026-014',
    description: 'Warehouse shelving proposal',
    status: 'CONVERTED',
    lines: [
      {
        description: 'Heavy-duty shelving bay',
        quantity: '12',
        unitPrice: '18500',
        discountPercent: '5',
        code: '4100',
      },
      { description: 'Installation service', quantity: '1', unitPrice: '25000', code: '4200' },
    ],
  },
  {
    key: 'so1',
    type: 'SALES_ORDER',
    party: 'CUST-002',
    date: '2026-08-25',
    expected: '2026-09-20',
    reference: 'PO-DTH-5521',
    description: 'Warehouse shelving proposal',
    status: 'APPROVED',
    convertedFrom: 'qt1',
    lines: [
      {
        description: 'Heavy-duty shelving bay',
        quantity: '12',
        unitPrice: '18500',
        discountPercent: '5',
        code: '4100',
      },
      { description: 'Installation service', quantity: '1', unitPrice: '25000', code: '4200' },
    ],
  },
  {
    key: 'qt2',
    type: 'QUOTATION',
    party: 'CUST-001',
    date: '2026-09-05',
    expected: '2026-10-05',
    description: 'Q4 replenishment',
    status: 'SENT',
    lines: [
      {
        description: 'Merchandise (VAT exclusive)',
        quantity: '400',
        unitPrice: '350',
        code: '4100',
      },
    ],
  },
  {
    key: 'pr1',
    type: 'PURCHASE_REQUEST',
    party: '',
    date: '2026-09-08',
    description: 'Laptops for the finance team',
    status: 'SUBMITTED',
    lines: [
      { description: 'Business laptop 14"', quantity: '4', unitPrice: '65000', code: '1510' },
    ],
  },
  {
    key: 'po1',
    type: 'PURCHASE_ORDER',
    party: 'VEND-001',
    date: '2026-09-01',
    expected: '2026-09-15',
    reference: 'Q-8841',
    description: 'September merchandise replenishment',
    status: 'APPROVED',
    lines: [
      {
        description: 'Merchandise inventory (VAT exclusive)',
        quantity: '500',
        unitPrice: '210',
        code: '1300',
        received: '300',
      },
      { description: 'Freight-in', quantity: '1', unitPrice: '4500', code: '5100' },
    ],
    receipt: { date: '2026-09-09', reference: 'DR-77102' },
  },
];

export async function seedOrders(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [any] = await tx
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(eq(schema.orders.companyId, company.id))
    .limit(1);
  if (any) return;

  const currency = company.baseCurrency;
  const partyId = async (code: string, kind: 'customer' | 'vendor') => {
    const table = kind === 'customer' ? schema.customers : schema.vendors;
    const [row] = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.companyId, company.id), eq(table.code, code)));
    return row!.id;
  };
  const created = new Map<string, { id: string; number: string; lineIds: string[] }>();

  for (const o of ORDERS) {
    const isSales = o.type === 'QUOTATION' || o.type === 'SALES_ORDER';
    const customerId = isSales ? await partyId(o.party, 'customer') : null;
    const vendorId = !isSales && o.party ? await partyId(o.party, 'vendor') : null;
    let subtotal = Money.zero(currency);
    let discountTotal = Money.zero(currency);
    const lines = o.lines.map((l, i) => {
      const gross = Money.parse(l.unitPrice, currency).multiply(l.quantity);
      const discount = gross.multiply(l.discountPercent ?? '0').multiply('0.01');
      subtotal = subtotal.add(gross);
      discountTotal = discountTotal.add(discount);
      return {
        lineNumber: i + 1,
        description: l.description,
        quantity: Money.of(l.quantity, currency).toString(),
        unitPrice: Money.parse(l.unitPrice, currency).toString(),
        discountPercent: Money.of(l.discountPercent ?? '0', currency).toString(),
        amount: gross.subtract(discount).toString(),
        accountId: codeToId.get(l.code)!,
        receivedQuantity: Money.of(l.received ?? '0', currency).toString(),
      };
    });
    const numberType = {
      QUOTATION: 'QT',
      SALES_ORDER: 'SO',
      PURCHASE_REQUEST: 'PR',
      PURCHASE_ORDER: 'PO',
    } as const;
    const documentNumber = await allocateNumber(tx, company.id, numberType[o.type], o.date);
    const source = o.convertedFrom ? created.get(o.convertedFrom) : undefined;
    const anyReceived = lines.some((l) => Money.of(l.receivedQuantity, currency).isPositive());
    const [row] = await tx
      .insert(schema.orders)
      .values({
        companyId: company.id,
        orderType: o.type,
        documentNumber,
        status: o.status,
        customerId,
        vendorId,
        orderDate: o.date,
        expectedDate: o.expected ?? null,
        reference: o.reference ?? null,
        description: o.description,
        currency,
        subtotal: subtotal.toString(),
        discountTotal: discountTotal.toString(),
        total: subtotal.subtract(discountTotal).toString(),
        receiptStatus: anyReceived ? 'PARTIAL' : 'NONE',
        sourceOrderId: source?.id ?? null,
        submittedAt: o.status === 'SUBMITTED' ? new Date() : null,
        approvedBy: o.status === 'APPROVED' ? adminUserId : null,
        approvedAt: o.status === 'APPROVED' ? new Date() : null,
        createdBy: adminUserId,
      })
      .returning({ id: schema.orders.id });
    const inserted = await tx
      .insert(schema.orderLines)
      .values(
        lines.map((l, i) => ({
          ...l,
          orderId: row!.id,
          sourceLineId: source?.lineIds[i] ?? null,
        })),
      )
      .returning({ id: schema.orderLines.id });
    created.set(o.key, { id: row!.id, number: documentNumber, lineIds: inserted.map((r) => r.id) });
    if (source) {
      await tx
        .update(schema.orders)
        .set({ convertedOrderId: row!.id })
        .where(eq(schema.orders.id, source.id));
    }
    if (o.receipt) {
      const grNumber = await allocateNumber(tx, company.id, 'GR', o.receipt.date);
      const [gr] = await tx
        .insert(schema.goodsReceipts)
        .values({
          companyId: company.id,
          documentNumber: grNumber,
          purchaseOrderId: row!.id,
          vendorId: vendorId!,
          status: 'CONFIRMED',
          receiptDate: o.receipt.date,
          reference: o.receipt.reference,
          confirmedBy: adminUserId,
          confirmedAt: new Date(),
          createdBy: adminUserId,
        })
        .returning({ id: schema.goodsReceipts.id });
      const receivedLines = lines
        .map((l, i) => ({ l, id: inserted[i]!.id }))
        .filter(({ l }) => Money.of(l.receivedQuantity, currency).isPositive());
      await tx.insert(schema.goodsReceiptLines).values(
        receivedLines.map(({ l, id }, i) => ({
          goodsReceiptId: gr!.id,
          lineNumber: i + 1,
          orderLineId: id,
          quantity: l.receivedQuantity,
        })),
      );
    }
  }
  await tx
    .insert(schema.purchasingSettings)
    .values({
      companyId: company.id,
      priceTolerancePercent: '2',
      quantityTolerancePercent: '0',
      overReceiptTolerancePercent: '5',
      requirePurchaseOrder: false,
      requireReceiptBeforeBill: true,
    })
    .onConflictDoNothing();
  log(`sales & purchasing samples seeded for ${company.code} (${ORDERS.length} orders, 1 receipt)`);
}
