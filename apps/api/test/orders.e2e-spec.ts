import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 4 - Sales & Purchasing. Quotation -> sales order -> invoice (AR) and
 * purchase request -> purchase order -> goods receipt -> bill (AP) with
 * three-way matching, returns -> credit notes. Orders never touch the ledger;
 * the subledgers must still reconcile after every step.
 */
describe('Sales & purchasing (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const party: Record<string, string> = {};
  const TODAY = '2026-09-11';

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req.set('Cookie', admin).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const expectReconciled = async (side: 'ar' | 'ap') => {
    const res = await as(http().get(`/api/v1/reports/${side}-reconciliation?asOf=${TODAY}`)).expect(
      200,
    );
    expect(res.body.reconciled).toBe(true);
    return res.body;
  };
  const trialBalance = async () => {
    const res = await as(
      http().get(`/api/v1/reports/trial-balance?from=2026-01-01&to=${TODAY}`),
    ).expect(200);
    expect(res.body.balanced).toBe(true);
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 2 });
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
    await runMigrations(DB_URL);
    await runSeed(DB_URL, {
      adminEmail: ADMIN.email,
      adminPassword: ADMIN.password,
      log: () => undefined,
    });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    admin = await login(ADMIN);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const customers = await as(http().get('/api/v1/customers?pageSize=50')).expect(200);
    for (const c of customers.body.items) party[c.code] = c.id;
    const vendors = await as(http().get('/api/v1/vendors?pageSize=50')).expect(200);
    for (const v of vendors.body.items) party[v.code] = v.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------ sales

  let quotationId: string;
  let salesOrderId: string;
  let soLines: Array<{ id: string; quantity: string }>;
  let invoiceId: string;

  it('quotation: computes discounted totals, sends, accepts and converts into a sales order', async () => {
    const res = await as(http().post('/api/v1/quotations'))
      .send({
        customerId: party['CUST-003'],
        orderDate: '2026-09-01',
        expectedDate: '2026-09-30',
        reference: 'RFQ-77',
        lines: [
          {
            description: 'Widgets',
            quantity: '10',
            unitPrice: '250',
            discountPercent: '10',
            accountId: acc['4100'],
          },
          { description: 'Installation', quantity: '2', unitPrice: '1500', accountId: acc['4200'] },
        ],
        idempotencyKey: 'qt-e2e-000001',
      })
      .expect(201);
    quotationId = res.body.id;
    expect(res.body.documentNumber).toMatch(/^QT-2026-\d{6}$/);
    expect(res.body.subtotal).toBe('5500.0000'); // 2500 + 3000 gross
    expect(res.body.discountTotal).toBe('250.0000');
    expect(res.body.total).toBe('5250.0000');
    expect(res.body.lines[0].amount).toBe('2250.0000');

    // Idempotent create returns the same order.
    const again = await as(http().post('/api/v1/quotations'))
      .send({
        customerId: party['CUST-003'],
        orderDate: '2026-09-01',
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['4100'] }],
        idempotencyKey: 'qt-e2e-000001',
      })
      .expect(201);
    expect(again.body.id).toBe(quotationId);

    // Lifecycle guards.
    const bad = await as(http().post(`/api/v1/quotations/${quotationId}/convert`))
      .send({})
      .expect(422);
    expect(bad.body.code).toBe('ORDER_INVALID_STATE');
    await as(http().post(`/api/v1/quotations/${quotationId}/send`)).expect(201);
    await as(http().post(`/api/v1/quotations/${quotationId}/accept`)).expect(201);
    const so = await as(http().post(`/api/v1/quotations/${quotationId}/convert`))
      .send({ orderDate: '2026-09-02' })
      .expect(201);
    salesOrderId = so.body.id;
    expect(so.body.orderType).toBe('SALES_ORDER');
    expect(so.body.documentNumber).toMatch(/^SO-2026-\d{6}$/);
    expect(so.body.status).toBe('DRAFT');
    expect(so.body.total).toBe('5250.0000');
    expect(so.body.sourceOrderNumber).toBe(res.body.documentNumber);
    soLines = so.body.lines.map((l: { id: string; quantity: string }) => ({
      id: l.id,
      quantity: l.quantity,
    }));

    const q = await as(http().get(`/api/v1/quotations/${quotationId}`)).expect(200);
    expect(q.body.status).toBe('CONVERTED');
    expect(q.body.convertedOrderNumber).toBe(so.body.documentNumber);
  });

  it('sales order: cannot be invoiced until approved; partial invoice creates a linked AR draft', async () => {
    const notYet = await as(http().post(`/api/v1/sales-orders/${salesOrderId}/fulfil`))
      .send({ documentDate: '2026-09-03' })
      .expect(422);
    expect(notYet.body.code).toBe('ORDER_INVALID_STATE');

    const approved = await as(http().post(`/api/v1/sales-orders/${salesOrderId}/approve`)).expect(
      201,
    );
    expect(approved.body.status).toBe('APPROVED');
    // Admin created and approved it: the WARN policy records a warning, does not block.
    expect(Array.isArray(approved.body.sodWarnings)).toBe(true);

    // Over-fulfilment is rejected.
    const over = await as(http().post(`/api/v1/sales-orders/${salesOrderId}/fulfil`))
      .send({
        documentDate: '2026-09-03',
        lines: [{ orderLineId: soLines[0]!.id, quantity: '11' }],
      })
      .expect(422);
    expect(over.body.code).toBe('ORDER_LINE_OVERFULFILLED');

    const inv = await as(http().post(`/api/v1/sales-orders/${salesOrderId}/fulfil`))
      .send({ documentDate: '2026-09-03', lines: [{ orderLineId: soLines[0]!.id, quantity: '6' }] })
      .expect(201);
    invoiceId = inv.body.documentId;
    expect(inv.body.documentNumber).toMatch(/^INV-2026-\d{6}$/);

    const detail = await as(http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(detail.body.status).toBe('DRAFT');
    expect(detail.body.salesOrderId).toBe(salesOrderId);
    expect(detail.body.lines).toHaveLength(1);
    expect(detail.body.lines[0].discountPercent).toBe('10.0000');
    expect(detail.body.lines[0].amount).toBe('1350.0000'); // 6 x 250 less 10%

    const so = await as(http().get(`/api/v1/sales-orders/${salesOrderId}`)).expect(200);
    expect(so.body.billingStatus).toBe('PARTIAL');
    expect(so.body.lines[0].billedQuantity).toBe('6.0000');
    expect(so.body.lines[0].remainingToBill).toBe('4.0000');
    expect(so.body.documents).toHaveLength(1);
  });

  it('deleting the draft invoice releases the order quantity; invoicing the rest auto-closes the order', async () => {
    await as(http().delete(`/api/v1/invoices/${invoiceId}`)).expect(204);
    let so = await as(http().get(`/api/v1/sales-orders/${salesOrderId}`)).expect(200);
    expect(so.body.billingStatus).toBe('NONE');
    expect(so.body.lines[0].billedQuantity).toBe('0.0000');

    const inv = await as(http().post(`/api/v1/sales-orders/${salesOrderId}/fulfil`))
      .send({ documentDate: '2026-09-04', idempotencyKey: 'so-inv-e2e-000001' })
      .expect(201);
    invoiceId = inv.body.documentId;
    so = await as(http().get(`/api/v1/sales-orders/${salesOrderId}`)).expect(200);
    expect(so.body.billingStatus).toBe('FULL');
    expect(so.body.status).toBe('CLOSED');

    // Post the invoice: the accounting effect is the normal AR posting.
    await as(http().post(`/api/v1/invoices/${invoiceId}/approve`)).expect(201);
    const posted = await as(http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(posted.body.accountingStatus).toBe('POSTED');
    expect(posted.body.total).toBe('5250.0000');
    const je = await as(http().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`)).expect(
      200,
    );
    expect(je.body.totalDebit).toBe('5250.0000');
    expect(
      je.body.lines.find((l: { accountId: string }) => l.accountId === acc['1200']).debit,
    ).toBe('5250.0000');
    await expectReconciled('ar');
    await trialBalance();
  });

  it('sales return: capped by invoiced quantity; crediting raises an AR credit note that reverses revenue', async () => {
    const tooMany = await as(http().post('/api/v1/sales-returns'))
      .send({
        orderId: salesOrderId,
        returnDate: '2026-09-05',
        lines: [{ orderLineId: soLines[0]!.id, quantity: '3' }],
      })
      .expect(201);
    // Draft creation succeeds; the cap is enforced when crediting.
    await as(http().post(`/api/v1/sales-returns/${tooMany.body.id}/approve`)).expect(201);
    const ret = await as(http().post(`/api/v1/sales-returns/${tooMany.body.id}/credit`))
      .send({})
      .expect(201);
    expect(ret.body.status).toBe('CREDITED');
    expect(ret.body.total).toBe('675.0000'); // 3 x 225 net
    expect(ret.body.creditNoteNumber).toMatch(/^CN-2026-\d{6}$/);

    const cn = await as(http().get(`/api/v1/invoices/${ret.body.creditNoteId}`)).expect(200);
    expect(cn.body.documentType).toBe('CREDIT_NOTE');
    expect(cn.body.total).toBe('675.0000');
    await as(http().post(`/api/v1/invoices/${cn.body.id}/approve`)).expect(201);
    const postedCn = await as(http().post(`/api/v1/invoices/${cn.body.id}/post`)).expect(201);
    const je = await as(
      http().get(`/api/v1/journal-entries/${postedCn.body.journalEntryId}`),
    ).expect(200);
    expect(
      je.body.lines.find((l: { accountId: string }) => l.accountId === acc['4100']).debit,
    ).toBe('675.0000');
    expect(
      je.body.lines.find((l: { accountId: string }) => l.accountId === acc['1200']).credit,
    ).toBe('675.0000');

    // Returned quantity is tracked; a second return beyond what was invoiced is rejected.
    const so = await as(http().get(`/api/v1/sales-orders/${salesOrderId}`)).expect(200);
    expect(so.body.lines[0].returnedQuantity).toBe('3.0000');
    expect(so.body.lines[0].remainingToReturn).toBe('7.0000');
    const second = await as(http().post('/api/v1/sales-returns'))
      .send({
        orderId: salesOrderId,
        returnDate: '2026-09-06',
        lines: [{ orderLineId: soLines[0]!.id, quantity: '8' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/sales-returns/${second.body.id}/approve`)).expect(201);
    const rejected = await as(http().post(`/api/v1/sales-returns/${second.body.id}/credit`))
      .send({})
      .expect(422);
    expect(rejected.body.code).toBe('ORDER_LINE_OVERFULFILLED');
    await expectReconciled('ar');
  });

  // ------------------------------------------------------------- purchasing

  let purchaseRequestId: string;
  let purchaseOrderId: string;
  let poLines: Array<{ id: string; quantity: string; unitPrice: string }>;
  let receiptId: string;
  let billId: string;

  it('purchase request: submit -> approve (SoD warning) -> convert with a vendor into a purchase order', async () => {
    const res = await as(http().post('/api/v1/purchase-requests'))
      .send({
        orderDate: '2026-09-01',
        description: 'Office chairs',
        lines: [
          {
            description: 'Ergonomic chair',
            quantity: '100',
            unitPrice: '80',
            accountId: acc['6400'],
          },
          { description: 'Delivery', quantity: '1', unitPrice: '500', accountId: acc['6400'] },
        ],
      })
      .expect(201);
    purchaseRequestId = res.body.id;
    expect(res.body.documentNumber).toMatch(/^PR-2026-\d{6}$/);
    expect(res.body.vendorId).toBeNull();

    const early = await as(
      http().post(`/api/v1/purchase-requests/${purchaseRequestId}/approve`),
    ).expect(422);
    expect(early.body.code).toBe('ORDER_INVALID_STATE');
    await as(http().post(`/api/v1/purchase-requests/${purchaseRequestId}/submit`)).expect(201);
    await as(http().post(`/api/v1/purchase-requests/${purchaseRequestId}/approve`)).expect(201);

    const noVendor = await as(http().post(`/api/v1/purchase-requests/${purchaseRequestId}/convert`))
      .send({})
      .expect(422);
    expect(noVendor.body.code).toBe('VALIDATION_FAILED');
    const po = await as(http().post(`/api/v1/purchase-requests/${purchaseRequestId}/convert`))
      .send({ vendorId: party['VEND-001'], orderDate: '2026-09-02', expectedDate: '2026-09-10' })
      .expect(201);
    purchaseOrderId = po.body.id;
    expect(po.body.documentNumber).toMatch(/^PO-2026-\d{6}$/);
    expect(po.body.total).toBe('8500.0000');
    poLines = po.body.lines;
    await as(http().post(`/api/v1/purchase-orders/${purchaseOrderId}/approve`)).expect(201);
  });

  it('goods receipt: draft, confirm (received quantities), over-receipt rejected without tolerance', async () => {
    // The seed configures a 5% over-receipt tolerance; this scenario runs with none.
    await as(http().put('/api/v1/purchasing/settings'))
      .send({
        priceTolerancePercent: '0',
        quantityTolerancePercent: '0',
        overReceiptTolerancePercent: '0',
        requirePurchaseOrder: false,
        requireReceiptBeforeBill: true,
      })
      .expect(200);
    const gr = await as(http().post('/api/v1/goods-receipts'))
      .send({
        purchaseOrderId,
        receiptDate: '2026-09-08',
        reference: 'DN-4411',
        lines: [{ orderLineId: poLines[0]!.id, quantity: '80' }],
      })
      .expect(201);
    receiptId = gr.body.id;
    expect(gr.body.documentNumber).toMatch(/^GR-2026-\d{6}$/);
    expect(gr.body.status).toBe('DRAFT');
    let po = await as(http().get(`/api/v1/purchase-orders/${purchaseOrderId}`)).expect(200);
    expect(po.body.receiptStatus).toBe('NONE');

    await as(http().post(`/api/v1/goods-receipts/${receiptId}/confirm`)).expect(201);
    po = await as(http().get(`/api/v1/purchase-orders/${purchaseOrderId}`)).expect(200);
    expect(po.body.receiptStatus).toBe('PARTIAL');
    expect(po.body.lines[0].receivedQuantity).toBe('80.0000');
    expect(po.body.lines[0].remainingToReceive).toBe('20.0000');

    const over = await as(http().post('/api/v1/goods-receipts'))
      .send({
        purchaseOrderId,
        receiptDate: '2026-09-09',
        lines: [{ orderLineId: poLines[0]!.id, quantity: '25' }],
      })
      .expect(201);
    const rejected = await as(http().post(`/api/v1/goods-receipts/${over.body.id}/confirm`)).expect(
      422,
    );
    expect(rejected.body.code).toBe('ORDER_LINE_OVERFULFILLED');
    await as(http().delete(`/api/v1/goods-receipts/${over.body.id}`)).expect(204);
  });

  it('three-way match: PO 100 / received 80 / billed 100 -> EXCEPTION; payment is held until reviewed', async () => {
    const bill = await as(http().post(`/api/v1/purchase-orders/${purchaseOrderId}/fulfil`))
      .send({
        documentDate: '2026-09-09',
        vendorInvoiceNumber: 'SI-2026-9001',
        lines: [
          { orderLineId: poLines[0]!.id, quantity: '100' },
          { orderLineId: poLines[1]!.id, quantity: '1', unitPrice: '650' },
        ],
      })
      .expect(201);
    billId = bill.body.documentId;
    const detail = await as(http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(detail.body.purchaseOrderId).toBe(purchaseOrderId);
    expect(detail.body.matchStatus).toBe('EXCEPTION');
    const codes = detail.body.matchExceptions.map((e: { code: string }) => e.code).sort();
    // line 1: 100 billed vs 80 received (quantity); line 2: nothing received + 650 vs 500 (price)
    expect(codes).toEqual(['MISSING_RECEIPT', 'PRICE_MISMATCH', 'QUANTITY_MISMATCH']);
    expect(detail.body.total).toBe('8650.0000');

    const po = await as(http().get(`/api/v1/purchase-orders/${purchaseOrderId}`)).expect(200);
    expect(po.body.billingStatus).toBe('FULL');
    expect(po.body.status).toBe('APPROVED'); // receipt still partial

    // Post the bill (AP recognises the liability) but payment allocation is blocked.
    await as(http().post(`/api/v1/bills/${billId}/approve`)).expect(201);
    await as(http().post(`/api/v1/bills/${billId}/post`)).expect(201);
    await expectReconciled('ap');
    const pay = await as(http().post('/api/v1/vendor-payments'))
      .send({
        partyId: party['VEND-001'],
        paymentDate: TODAY,
        amount: '8650',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: billId, amount: '8650' }],
      })
      .expect(422);
    expect(pay.body.code).toBe('MATCH_EXCEPTION_UNREVIEWED');
  });

  it('receiving the balance clears the receipt exceptions; review lifts the hold and the bill can be paid', async () => {
    const gr = await as(http().post('/api/v1/goods-receipts'))
      .send({
        purchaseOrderId,
        receiptDate: '2026-09-10',
        lines: [
          { orderLineId: poLines[0]!.id, quantity: '20' },
          { orderLineId: poLines[1]!.id, quantity: '1' },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/goods-receipts/${gr.body.id}/confirm`)).expect(201);
    let bill = await as(http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill.body.matchStatus).toBe('EXCEPTION');
    expect(bill.body.matchExceptions.map((e: { code: string }) => e.code)).toEqual([
      'PRICE_MISMATCH',
    ]);

    const po = await as(http().get(`/api/v1/purchase-orders/${purchaseOrderId}`)).expect(200);
    expect(po.body.receiptStatus).toBe('FULL');
    expect(po.body.status).toBe('CLOSED');

    const noNote = await as(http().post(`/api/v1/bills/${billId}/match-review`))
      .send({ note: '' })
      .expect(400);
    expect(noNote.body.code).toBe('VALIDATION_FAILED');
    bill = await as(http().post(`/api/v1/bills/${billId}/match-review`))
      .send({ note: 'Delivery surcharge agreed by phone with the supplier.' })
      .expect(201);
    expect(bill.body.matchStatus).toBe('REVIEWED');

    const pay = await as(http().post('/api/v1/vendor-payments'))
      .send({
        partyId: party['VEND-001'],
        paymentDate: TODAY,
        amount: '8650',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: billId, amount: '8650' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/vendor-payments/${pay.body.id}/post`)).expect(201);
    bill = await as(http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill.body.status).toBe('PAID');
    await expectReconciled('ap');
    await trialBalance();
  });

  it('tolerances are configuration: a 5% price tolerance turns the same variance into a match', async () => {
    const settings = await as(http().put('/api/v1/purchasing/settings'))
      .send({
        priceTolerancePercent: '5',
        quantityTolerancePercent: '0',
        overReceiptTolerancePercent: '10',
        requirePurchaseOrder: true,
        requireReceiptBeforeBill: true,
      })
      .expect(200);
    expect(settings.body.priceTolerancePercent).toBe('5.0000');

    const po = await as(http().post('/api/v1/purchase-orders'))
      .send({
        vendorId: party['VEND-002'],
        orderDate: '2026-09-05',
        lines: [{ description: 'Paper', quantity: '50', unitPrice: '200', accountId: acc['6400'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/purchase-orders/${po.body.id}/approve`)).expect(201);
    // 10% over-receipt tolerance: 55 accepted.
    const gr = await as(http().post('/api/v1/goods-receipts'))
      .send({
        purchaseOrderId: po.body.id,
        receiptDate: '2026-09-06',
        lines: [{ orderLineId: po.body.lines[0].id, quantity: '55' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/goods-receipts/${gr.body.id}/confirm`)).expect(201);

    const bill = await as(http().post(`/api/v1/purchase-orders/${po.body.id}/fulfil`))
      .send({
        documentDate: '2026-09-07',
        vendorInvoiceNumber: 'SI-2026-9002',
        lines: [{ orderLineId: po.body.lines[0].id, quantity: '50', unitPrice: '208' }],
      })
      .expect(201);
    const detail = await as(http().get(`/api/v1/bills/${bill.body.documentId}`)).expect(200);
    expect(detail.body.matchStatus).toBe('MATCHED'); // 4% variance within 5%

    // With "require purchase order" on, a bill without a PO is flagged.
    const loose = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: party['VEND-002'],
        documentDate: '2026-09-07',
        vendorInvoiceNumber: 'SI-2026-9003',
        lines: [{ description: 'Ad hoc', unitPrice: '100', accountId: acc['6400'] }],
      })
      .expect(201);
    expect(loose.body.matchStatus).toBe('EXCEPTION');
    expect(loose.body.matchExceptions[0].code).toBe('MISSING_PURCHASE_ORDER');
  });

  it('purchase return against received goods raises a vendor credit note (Dr AP / Cr expense)', async () => {
    const ret = await as(http().post('/api/v1/purchase-returns'))
      .send({
        orderId: purchaseOrderId,
        returnDate: '2026-09-11',
        reason: 'Two chairs damaged',
        lines: [{ orderLineId: poLines[0]!.id, quantity: '2' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/purchase-returns/${ret.body.id}/approve`)).expect(201);
    const credited = await as(http().post(`/api/v1/purchase-returns/${ret.body.id}/credit`))
      .send({})
      .expect(201);
    expect(credited.body.total).toBe('160.0000');
    expect(credited.body.creditNoteNumber).toMatch(/^VCN-2026-\d{6}$/);
    await as(http().post(`/api/v1/bills/${credited.body.creditNoteId}/approve`)).expect(201);
    const posted = await as(http().post(`/api/v1/bills/${credited.body.creditNoteId}/post`)).expect(
      201,
    );
    const je = await as(http().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`)).expect(
      200,
    );
    expect(
      je.body.lines.find((l: { accountId: string }) => l.accountId === acc['2110']).debit,
    ).toBe('160.0000');
    expect(
      je.body.lines.find((l: { accountId: string }) => l.accountId === acc['6400']).credit,
    ).toBe('160.0000');
    await expectReconciled('ap');
    await trialBalance();
  });

  it('orders never post to the ledger: no journal carries an order or receipt source', async () => {
    const rows = await pool.query(
      `select count(*)::int as n from journal_entries where source_type in ('SALES_ORDER','PURCHASE_ORDER','GOODS_RECEIPT','QUOTATION','PURCHASE_REQUEST')`,
    );
    expect(rows.rows[0].n).toBe(0);
    // Cancelling an order with activity is refused; a fresh draft can be cancelled.
    const busy = await as(http().post(`/api/v1/purchase-orders/${purchaseOrderId}/cancel`))
      .send({ reason: 'x' })
      .expect(422);
    expect(busy.body.code).toBe('ORDER_INVALID_STATE');
    const fresh = await as(http().post('/api/v1/sales-orders'))
      .send({
        customerId: party['CUST-001'],
        orderDate: TODAY,
        lines: [{ description: 'x', unitPrice: '10', accountId: acc['4100'] }],
      })
      .expect(201);
    const cancelled = await as(http().post(`/api/v1/sales-orders/${fresh.body.id}/cancel`))
      .send({ reason: 'Customer withdrew' })
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
  });
});
