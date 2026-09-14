import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 5 - Inventory. Stock moves only through the inventory engine; every
 * movement that changes value posts to the ledger in the same transaction and
 * the inventory subledger must tie to the inventory control account after
 * every step. Covers FIFO and weighted average, GRNI accrual, PPV, COGS,
 * returns, transfers, counts, lots and serials.
 */
describe('Inventory (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const party: Record<string, string> = {};
  const wh: Record<string, string> = {};
  const prod: Record<string, string> = {};
  const TODAY = '2026-09-11';

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req.set('Cookie', admin).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const valuation = async () => {
    const res = await as(http().get(`/api/v1/inventory/valuation?asOf=${TODAY}`)).expect(200);
    expect(res.body.reconciled).toBe(true);
    return res.body;
  };
  const trialBalance = async () => {
    const res = await as(
      http().get(`/api/v1/reports/trial-balance?from=2026-01-01&to=${TODAY}`),
    ).expect(200);
    expect(res.body.balanced).toBe(true);
  };
  const onHand = async (productId: string, warehouseId?: string) => {
    const res = await as(
      http().get(
        `/api/v1/inventory/stock-on-hand?productId=${productId}${warehouseId ? `&warehouseId=${warehouseId}` : ''}&includeZero=true`,
      ),
    ).expect(200);
    return res.body as {
      rows: Array<{ quantityOnHand: string; totalCost: string; lotNumber: string | null }>;
      totals: { quantity: string; value: string };
    };
  };
  const journalLine = async (journalEntryId: string, code: string) => {
    const je = await as(http().get(`/api/v1/journal-entries/${journalEntryId}`)).expect(200);
    return je.body.lines.filter((l: { accountId: string }) => l.accountId === acc[code]);
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
    const warehouses = await as(http().get('/api/v1/warehouses')).expect(200);
    for (const w of warehouses.body) wh[w.code] = w.id;
    const products = await as(http().get('/api/v1/products?pageSize=50')).expect(200);
    for (const p of products.body.items) prod[p.sku] = p.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('seed: opening stock ties to the inventory control account', async () => {
    const v = await valuation();
    expect(v.totalSubledger).toBe('40000.0000');
    expect(v.totalLedger).toBe('40000.0000');
    const stock = await onHand(prod['MERCH-001']!);
    expect(stock.totals.quantity).toBe('200.0000');
  });

  // ------------------------------------------------------------- FIFO flow

  let fifoId: string;
  let poId: string;
  let poLineId: string;
  let invoiceId: string;

  it('master data: product with FIFO costing and reorder level; stocked lines need a warehouse', async () => {
    const res = await as(http().post('/api/v1/products'))
      .send({
        sku: 'E2E-FIFO',
        name: 'E2E FIFO widget',
        costingMethod: 'FIFO',
        purchasePrice: '100',
        salePrice: '300',
        reorderLevel: '5',
      })
      .expect(201);
    fifoId = res.body.id;
    expect(res.body.sku).toBe('E2E-FIFO');
    expect(res.body.quantityOnHand).toBe('0');
    const dup = await as(http().post('/api/v1/products'))
      .send({ sku: 'E2E-FIFO', name: 'dup' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');

    const missingWarehouse = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-001'],
        documentDate: TODAY,
        lines: [
          {
            description: 'x',
            quantity: '1',
            unitPrice: '300',
            accountId: acc['4100'],
            productId: fifoId,
          },
        ],
      })
      .expect(422);
    expect(missingWarehouse.body.code).toBe('VALIDATION_FAILED');
  });

  it('stock adjustment IN posts Dr inventory / Cr inventory adjustments and creates a FIFO layer', async () => {
    const adj = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        reason: 'FOUND',
        lines: [{ productId: fifoId, direction: 'IN', quantity: '10', unitCost: '100' }],
      })
      .expect(201);
    expect(adj.body.documentNumber).toMatch(/^ADJ-2026-\d{6}$/);
    expect(adj.body.status).toBe('DRAFT');
    expect((await onHand(fifoId)).totals.quantity).toBe('0.0000'); // drafts move nothing
    const posted = await as(http().post(`/api/v1/stock-adjustments/${adj.body.id}/post`)).expect(
      201,
    );
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.totalCost).toBe('1000.0000');
    expect((await journalLine(posted.body.journalEntryId, '1300'))[0].debit).toBe('1000.0000');
    expect((await journalLine(posted.body.journalEntryId, '5200'))[0].credit).toBe('1000.0000');
    expect((await onHand(fifoId)).totals).toEqual({ quantity: '10.0000', value: '1000.0000' });
    await valuation();
  });

  it('goods receipt of a stocked PO line accrues Dr inventory / Cr GRNI at the PO net price', async () => {
    const po = await as(http().post('/api/v1/purchase-orders'))
      .send({
        vendorId: party['VEND-001'],
        orderDate: '2026-09-02',
        lines: [
          {
            description: 'FIFO widgets',
            quantity: '20',
            unitPrice: '120',
            accountId: acc['1300'],
            productId: fifoId,
            warehouseId: wh['MAIN'],
          },
        ],
      })
      .expect(201);
    poId = po.body.id;
    poLineId = po.body.lines[0].id;
    await as(http().post(`/api/v1/purchase-orders/${poId}/approve`)).expect(201);
    const gr = await as(http().post('/api/v1/goods-receipts'))
      .send({
        purchaseOrderId: poId,
        receiptDate: '2026-09-03',
        lines: [{ orderLineId: poLineId, quantity: '20' }],
      })
      .expect(201);
    const confirmed = await as(http().post(`/api/v1/goods-receipts/${gr.body.id}/confirm`)).expect(
      201,
    );
    expect(confirmed.body.journalEntryId).toBeTruthy();
    expect((await journalLine(confirmed.body.journalEntryId, '1300'))[0].debit).toBe('2400.0000');
    expect((await journalLine(confirmed.body.journalEntryId, '2160'))[0].credit).toBe('2400.0000');
    expect((await onHand(fifoId)).totals).toEqual({ quantity: '30.0000', value: '3400.0000' });
    await valuation();
  });

  it('billing the received PO line clears GRNI and books the price variance', async () => {
    const bill = await as(http().post(`/api/v1/purchase-orders/${poId}/fulfil`))
      .send({
        documentDate: '2026-09-04',
        vendorInvoiceNumber: 'INV-E2E-FIFO',
        lines: [{ orderLineId: poLineId, quantity: '20', unitPrice: '125' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/bills/${bill.body.documentId}/approve`)).expect(201);
    const posted = await as(http().post(`/api/v1/bills/${bill.body.documentId}/post`)).expect(201);
    expect(posted.body.total).toBe('2500.0000');
    expect((await journalLine(posted.body.journalEntryId, '2160'))[0].debit).toBe('2400.0000');
    expect((await journalLine(posted.body.journalEntryId, '5300'))[0].debit).toBe('100.0000');
    expect((await journalLine(posted.body.journalEntryId, '2110'))[0].credit).toBe('2500.0000');
    expect(await journalLine(posted.body.journalEntryId, '1300')).toHaveLength(0); // inventory was booked by the receipt
    expect((await onHand(fifoId)).totals.value).toBe('3400.0000');
    await valuation();
    await trialBalance();
  });

  it('invoicing 15 units relieves FIFO layers (10 @ 100 + 5 @ 120) and posts COGS in the same entry', async () => {
    const inv = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-001'],
        documentDate: '2026-09-05',
        lines: [
          {
            description: 'FIFO widgets',
            quantity: '15',
            unitPrice: '300',
            accountId: acc['4100'],
            productId: fifoId,
            warehouseId: wh['MAIN'],
          },
        ],
      })
      .expect(201);
    invoiceId = inv.body.id;
    await as(http().post(`/api/v1/invoices/${invoiceId}/approve`)).expect(201);
    const posted = await as(http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(posted.body.lines[0].costAmount).toBe('1600.0000');
    expect((await journalLine(posted.body.journalEntryId, '5100'))[0].debit).toBe('1600.0000');
    expect((await journalLine(posted.body.journalEntryId, '1300'))[0].credit).toBe('1600.0000');
    expect((await journalLine(posted.body.journalEntryId, '4100'))[0].credit).toBe('4500.0000');
    expect((await journalLine(posted.body.journalEntryId, '1200'))[0].debit).toBe('4500.0000');
    expect((await onHand(fifoId)).totals).toEqual({ quantity: '15.0000', value: '1800.0000' });
    const card = await as(http().get(`/api/v1/products/${fifoId}/stock-card`)).expect(200);
    expect(card.body.items[0].movementType).toBe('ISSUE');
    expect(card.body.items[0].balanceAfter).toBe('15.0000');
    await valuation();
  });

  it('issuing more than on hand is rejected unless negative stock is allowed', async () => {
    const inv = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-001'],
        documentDate: '2026-09-05',
        lines: [
          {
            description: 'Too many',
            quantity: '100',
            unitPrice: '300',
            accountId: acc['4100'],
            productId: fifoId,
            warehouseId: wh['MAIN'],
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${inv.body.id}/approve`)).expect(201);
    const rejected = await as(http().post(`/api/v1/invoices/${inv.body.id}/post`)).expect(422);
    expect(rejected.body.code).toBe('INSUFFICIENT_STOCK');
    const detail = await as(http().get(`/api/v1/invoices/${inv.body.id}`)).expect(200);
    expect(detail.body.accountingStatus).toBe('UNPOSTED'); // the whole transaction rolled back
    expect((await onHand(fifoId)).totals.quantity).toBe('15.0000');
    await as(http().post(`/api/v1/invoices/${inv.body.id}/void`))
      .send({ reason: 'test' })
      .expect(201);
  });

  it('transfers move value between warehouses without a journal; counts adjust the variance', async () => {
    const trf = await as(http().post('/api/v1/stock-transfers'))
      .send({
        warehouseId: wh['MAIN'],
        toWarehouseId: wh['BR01'],
        documentDate: '2026-09-06',
        lines: [{ productId: fifoId, quantity: '5' }],
      })
      .expect(201);
    const posted = await as(http().post(`/api/v1/stock-transfers/${trf.body.id}/post`)).expect(201);
    expect(posted.body.journalEntryId).toBeNull();
    expect(posted.body.totalCost).toBe('600.0000');
    expect((await onHand(fifoId, wh['MAIN'])).totals).toEqual({
      quantity: '10.0000',
      value: '1200.0000',
    });
    expect((await onHand(fifoId, wh['BR01'])).totals).toEqual({
      quantity: '5.0000',
      value: '600.0000',
    });
    await valuation();

    const count = await as(http().post('/api/v1/stock-counts'))
      .send({
        warehouseId: wh['BR01'],
        documentDate: '2026-09-07',
        lines: [{ productId: fifoId, countedQuantity: '4' }],
      })
      .expect(201);
    expect(count.body.lines[0].expectedQuantity).toBe('5.0000');
    expect(count.body.lines[0].direction).toBe('OUT');
    expect(count.body.lines[0].quantity).toBe('1.0000');
    const postedCount = await as(http().post(`/api/v1/stock-counts/${count.body.id}/post`)).expect(
      201,
    );
    expect((await journalLine(postedCount.body.journalEntryId, '5200'))[0].debit).toBe('120.0000');
    expect((await journalLine(postedCount.body.journalEntryId, '1300'))[0].credit).toBe('120.0000');
    expect((await onHand(fifoId, wh['BR01'])).totals).toEqual({
      quantity: '4.0000',
      value: '480.0000',
    });
    await valuation();
  });

  it('voiding the posted invoice puts the goods back at the original cost and reverses COGS', async () => {
    const voided = await as(http().post(`/api/v1/invoices/${invoiceId}/void`))
      .send({ reason: 'Customer cancelled', reversalDate: '2026-09-08' })
      .expect(201);
    expect(voided.body.accountingStatus).toBe('REVERSED');
    expect((await journalLine(voided.body.reversalJournalEntryId, '1300'))[0].debit).toBe(
      '1600.0000',
    );
    expect((await journalLine(voided.body.reversalJournalEntryId, '5100'))[0].credit).toBe(
      '1600.0000',
    );
    expect((await onHand(fifoId, wh['MAIN'])).totals).toEqual({
      quantity: '25.0000',
      value: '2800.0000',
    });
    await valuation();
    await trialBalance();
  });

  // --------------------------------------------------------- weighted average

  it('weighted average: receipt at a new price moves the average; issues relieve at the average', async () => {
    const merch = prod['MERCH-001']!;
    const adj = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        reason: 'CORRECTION',
        lines: [{ productId: merch, direction: 'IN', quantity: '100', unitCost: '260' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/stock-adjustments/${adj.body.id}/post`)).expect(201);
    // 200 @ 200 + 100 @ 260 = 66,000 / 300 = 220.00
    const stock = await onHand(merch, wh['MAIN']);
    expect(stock.totals).toEqual({ quantity: '300.0000', value: '66000.0000' });

    const inv = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-002'],
        documentDate: '2026-09-09',
        lines: [
          {
            description: 'Merchandise',
            quantity: '50',
            unitPrice: '350',
            accountId: acc['4100'],
            productId: merch,
            warehouseId: wh['MAIN'],
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${inv.body.id}/approve`)).expect(201);
    const posted = await as(http().post(`/api/v1/invoices/${inv.body.id}/post`)).expect(201);
    expect(posted.body.lines[0].costAmount).toBe('11000.0000');
    expect((await onHand(merch, wh['MAIN'])).totals).toEqual({
      quantity: '250.0000',
      value: '55000.0000',
    });
    await valuation();

    // Sales return -> credit note brings goods back at the current average cost (Dr inventory / Cr COGS).
    const so = await as(http().post('/api/v1/sales-orders'))
      .send({
        customerId: party['CUST-002'],
        orderDate: '2026-09-09',
        lines: [
          {
            description: 'Merchandise',
            quantity: '10',
            unitPrice: '350',
            accountId: acc['4100'],
            productId: merch,
            warehouseId: wh['MAIN'],
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/sales-orders/${so.body.id}/approve`)).expect(201);
    const soInv = await as(http().post(`/api/v1/sales-orders/${so.body.id}/fulfil`))
      .send({ documentDate: '2026-09-09' })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${soInv.body.documentId}/approve`)).expect(201);
    await as(http().post(`/api/v1/invoices/${soInv.body.documentId}/post`)).expect(201);
    const ret = await as(http().post('/api/v1/sales-returns'))
      .send({
        orderId: so.body.id,
        returnDate: '2026-09-10',
        lines: [{ orderLineId: so.body.lines[0].id, quantity: '2' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/sales-returns/${ret.body.id}/approve`)).expect(201);
    const credited = await as(http().post(`/api/v1/sales-returns/${ret.body.id}/credit`))
      .send({})
      .expect(201);
    await as(http().post(`/api/v1/invoices/${credited.body.creditNoteId}/approve`)).expect(201);
    const cn = await as(http().post(`/api/v1/invoices/${credited.body.creditNoteId}/post`)).expect(
      201,
    );
    expect(cn.body.lines[0].costAmount).toBe('440.0000'); // 2 x 220
    expect((await journalLine(cn.body.journalEntryId, '1300'))[0].debit).toBe('440.0000');
    expect((await journalLine(cn.body.journalEntryId, '5100'))[0].credit).toBe('440.0000');
    expect((await onHand(merch, wh['MAIN'])).totals.quantity).toBe('242.0000');
    await valuation();
    await trialBalance();
  });

  // ---------------------------------------------------------- lots & serials

  it('lot-tracked stock needs a lot; serial-tracked stock needs one serial per unit and rejects unknown serials', async () => {
    const paper = prod['MERCH-003']!;
    const noLot = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        lines: [{ productId: paper, direction: 'IN', quantity: '10', unitCost: '280' }],
      })
      .expect(201);
    const rejected = await as(
      http().post(`/api/v1/stock-adjustments/${noLot.body.id}/post`),
    ).expect(422);
    expect(rejected.body.code).toBe('STOCK_IDENTITY_REQUIRED');
    const withLot = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        lines: [
          {
            productId: paper,
            direction: 'IN',
            quantity: '10',
            unitCost: '280',
            lotNumber: 'LOT-A',
            expiryDate: '2027-01-31',
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/stock-adjustments/${withLot.body.id}/post`)).expect(201);
    const lots = await onHand(paper);
    expect(lots.rows[0]?.lotNumber).toBe('LOT-A');

    const laptop = prod['EQUIP-001']!;
    const wrongCount = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        lines: [
          {
            productId: laptop,
            direction: 'IN',
            quantity: '2',
            unitCost: '65000',
            serialNumbers: ['SN-1'],
          },
        ],
      })
      .expect(201);
    expect(
      (await as(http().post(`/api/v1/stock-adjustments/${wrongCount.body.id}/post`)).expect(422))
        .body.code,
    ).toBe('STOCK_IDENTITY_REQUIRED');
    const serials = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-01',
        lines: [
          {
            productId: laptop,
            direction: 'IN',
            quantity: '2',
            unitCost: '65000',
            serialNumbers: ['SN-1', 'SN-2'],
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/stock-adjustments/${serials.body.id}/post`)).expect(201);
    const unknown = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-02',
        reason: 'DAMAGE',
        lines: [{ productId: laptop, direction: 'OUT', quantity: '1', serialNumbers: ['SN-9'] }],
      })
      .expect(201);
    expect(
      (await as(http().post(`/api/v1/stock-adjustments/${unknown.body.id}/post`)).expect(422)).body
        .code,
    ).toBe('SERIAL_UNAVAILABLE');
    const damaged = await as(http().post('/api/v1/stock-adjustments'))
      .send({
        warehouseId: wh['MAIN'],
        documentDate: '2026-09-02',
        reason: 'DAMAGE',
        lines: [{ productId: laptop, direction: 'OUT', quantity: '1', serialNumbers: ['SN-1'] }],
      })
      .expect(201);
    const posted = await as(
      http().post(`/api/v1/stock-adjustments/${damaged.body.id}/post`),
    ).expect(201);
    expect((await journalLine(posted.body.journalEntryId, '5200'))[0].debit).toBe('65000.0000');
    expect((await onHand(laptop)).totals.quantity).toBe('1.0000');
    await valuation();
    await trialBalance();
  });

  it('reorder report and settings', async () => {
    const below = await as(http().get('/api/v1/products?belowReorder=true&pageSize=50')).expect(
      200,
    );
    const skus = below.body.items.map((p: { sku: string }) => p.sku);
    expect(skus).toContain('MERCH-002'); // no stock, reorder level 5
    expect(skus).not.toContain('E2E-FIFO'); // 29 on hand vs level 5
    const settings = await as(http().put('/api/v1/inventory/settings'))
      .send({ defaultCostingMethod: 'FIFO', allowNegativeStock: false })
      .expect(200);
    expect(settings.body.defaultCostingMethod).toBe('FIFO');
  });
});
