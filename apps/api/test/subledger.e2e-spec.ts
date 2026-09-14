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
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 3 - AR/AP. Exercises the document and payment lifecycles and proves
 * the subledgers reconcile to their control accounts after every step.
 */
describe('Receivables & payables (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const TODAY = '2026-09-11';

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const expectReconciled = async (side: 'ar' | 'ap') => {
    const res = await as(
      admin,
      http().get(`/api/v1/reports/${side}-reconciliation?asOf=${TODAY}`),
    ).expect(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.subledgerBalance).toBe(res.body.ledgerBalance);
    return res.body;
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
    accountant = await login(ACCOUNTANT);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(admin, http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('seed: AR and AP subledgers reconcile to their control accounts', async () => {
    const ar = await expectReconciled('ar');
    expect(ar.subledgerBalance).toBe('116640.0000');
    const ap = await expectReconciled('ap');
    expect(ap.subledgerBalance).toBe('9200.0000');
    const aging = await as(admin, http().get(`/api/v1/reports/ar-aging?asOf=${TODAY}`)).expect(200);
    expect(aging.body.totals.net).toBe(ar.subledgerBalance);
  });

  // ------------------------------------------------------------------ AR

  let customerId: string;
  let invoiceId: string;
  let receiptId: string;

  it('creates a customer with a credit limit and lists balances', async () => {
    const res = await as(admin, http().post('/api/v1/customers'))
      .send({
        code: 'CUST-E2E',
        name: 'E2E Customer',
        paymentTermsDays: 20,
        creditLimit: '10000',
        email: 'e2e@customer.test',
      })
      .expect(201);
    customerId = res.body.id;
    expect(res.body.balance.outstanding).toBe('0.0000');
    const dup = await as(admin, http().post('/api/v1/customers'))
      .send({ code: 'CUST-E2E', name: 'Dup' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('creates an invoice with computed line amounts, terms-based due date and a credit-limit warning', async () => {
    const res = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-01',
        reference: 'SO-E2E',
        lines: [
          { description: 'Widgets', quantity: '3', unitPrice: '2500.5', accountId: acc['4100'] },
          { description: 'Delivery', unitPrice: '1500', accountId: acc['4200'] },
        ],
        idempotencyKey: 'inv-e2e-000001',
      })
      .expect(201);
    invoiceId = res.body.id;
    expect(res.body.documentNumber).toMatch(/^INV-2026-\d{6}$/);
    expect(res.body.total).toBe('9001.5000');
    expect(res.body.dueDate).toBe('2026-06-21');
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.accountingStatus).toBe('UNPOSTED');
    expect(res.body.warnings).toEqual([]);

    const replay = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-01',
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['4100'] }],
        idempotencyKey: 'inv-e2e-000001',
      })
      .expect(201);
    expect(replay.body.id).toBe(invoiceId);

    const big = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-02',
        lines: [{ description: 'Big order', unitPrice: '5000', accountId: acc['4100'] }],
      })
      .expect(201);
    expect(big.body.warnings[0].code).toBe('CREDIT_LIMIT_EXCEEDED');
    await as(accountant, http().delete(`/api/v1/invoices/${big.body.id}`)).expect(204);
  });

  it('rejects header accounts on lines and posting before approval', async () => {
    const bad = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-01',
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['4000'] }],
      })
      .expect(422);
    expect(bad.body.code).toBe('ACCOUNT_NOT_POSTABLE');
    const early = await as(admin, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(422);
    expect(early.body.code).toBe('DOCUMENT_INVALID_STATE');
    const denied = await as(
      accountant,
      http().post(`/api/v1/invoices/${invoiceId}/approve`),
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
  });

  it('approves and posts the invoice: Dr AR / Cr revenue, subledger still reconciled', async () => {
    await as(admin, http().post(`/api/v1/invoices/${invoiceId}/approve`)).expect(201);
    const posted = await as(admin, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(posted.body.accountingStatus).toBe('POSTED');
    expect(posted.body.status).toBe('APPROVED');
    expect(posted.body.balance).toBe('9001.5000');
    expect(posted.body.journalNumber).toMatch(/^JE-2026-/);

    const je = await as(
      admin,
      http().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`),
    ).expect(200);
    const arLine = je.body.lines.find((l: { accountCode: string }) => l.accountCode === '1200');
    expect(arLine.debit).toBe('9001.5000');
    expect(
      je.body.lines.find((l: { accountCode: string }) => l.accountCode === '4100').credit,
    ).toBe('7501.5000');
    expect(je.body.sourceType).toBe('AR_DOCUMENT');

    const again = await as(admin, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(again.body.journalEntryId).toBe(posted.body.journalEntryId);
    await expectReconciled('ar');
  });

  it('receipts: over-allocation is rejected, partial payment settles part of the invoice', async () => {
    const over = await as(accountant, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentDate: '2026-06-10',
        amount: '10000',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: invoiceId, amount: '9500' }],
      })
      .expect(422);
    expect(over.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');

    const draft = await as(accountant, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentDate: '2026-06-10',
        amount: '4000',
        method: 'BANK_TRANSFER',
        cashAccountId: acc['1130'],
        reference: 'OR-E2E-1',
        allocations: [{ documentId: invoiceId, amount: '4000' }],
      })
      .expect(201);
    receiptId = draft.body.id;
    expect(draft.body.status).toBe('DRAFT');
    expect(draft.body.documentNumber).toMatch(/^RCP-2026-/);

    // Draft allocations do not touch the invoice until posting.
    const before = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(before.body.allocatedAmount).toBe('0.0000');

    const denied = await as(
      accountant,
      http().post(`/api/v1/customer-payments/${receiptId}/post`),
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    const posted = await as(
      admin,
      http().post(`/api/v1/customer-payments/${receiptId}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.allocatedAmount).toBe('4000.0000');

    const after = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(after.body.status).toBe('PARTIALLY_PAID');
    expect(after.body.balance).toBe('5001.5000');
    expect(after.body.allocations).toHaveLength(1);

    const je = await as(
      admin,
      http().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`),
    ).expect(200);
    expect(je.body.lines.find((l: { accountCode: string }) => l.accountCode === '1130').debit).toBe(
      '4000.0000',
    );
    expect(
      je.body.lines.find((l: { accountCode: string }) => l.accountCode === '1200').credit,
    ).toBe('4000.0000');
    await expectReconciled('ar');
  });

  it('overpayment stays on account and can be allocated later; refunds are capped by unapplied credit', async () => {
    const receipt = await as(admin, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentDate: '2026-06-20',
        amount: '6000',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: invoiceId, amount: '5001.5' }],
      })
      .expect(201);
    await as(admin, http().post(`/api/v1/customer-payments/${receipt.body.id}/post`)).expect(201);
    const paid = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.balance).toBe('0.0000');

    const customer = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(customer.body.balance.unappliedCredit).toBe('998.5000');
    expect(customer.body.balance.net).toBe('-998.5000');

    const tooBig = await as(admin, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentType: 'REFUND',
        paymentDate: '2026-06-25',
        amount: '2000',
        cashAccountId: acc['1130'],
      })
      .expect(201);
    const blocked = await as(
      admin,
      http().post(`/api/v1/customer-payments/${tooBig.body.id}/post`),
    ).expect(422);
    expect(blocked.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    await as(admin, http().delete(`/api/v1/customer-payments/${tooBig.body.id}`)).expect(204);

    const refund = await as(admin, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentType: 'REFUND',
        paymentDate: '2026-06-25',
        amount: '998.5',
        cashAccountId: acc['1130'],
      })
      .expect(201);
    await as(admin, http().post(`/api/v1/customer-payments/${refund.body.id}/post`)).expect(201);
    const afterRefund = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(afterRefund.body.balance.unappliedCredit).toBe('0.0000');
    await expectReconciled('ar');
  });

  it('credit notes post as Dr revenue / Cr AR and apply to open invoices without a new ledger entry', async () => {
    const inv = await as(admin, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-07-01',
        lines: [{ description: 'Service', unitPrice: '3000', accountId: acc['4200'] }],
      })
      .expect(201);
    await as(admin, http().post(`/api/v1/invoices/${inv.body.id}/approve`)).expect(201);
    await as(admin, http().post(`/api/v1/invoices/${inv.body.id}/post`)).expect(201);

    const cn = await as(admin, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentType: 'CREDIT_NOTE',
        documentDate: '2026-07-05',
        lines: [{ description: 'Discount', unitPrice: '500', accountId: acc['4200'] }],
      })
      .expect(201);
    expect(cn.body.documentNumber).toMatch(/^CN-2026-/);
    await as(admin, http().post(`/api/v1/invoices/${cn.body.id}/approve`)).expect(201);
    const postedCn = await as(admin, http().post(`/api/v1/invoices/${cn.body.id}/post`)).expect(
      201,
    );
    const je = await as(
      admin,
      http().get(`/api/v1/journal-entries/${postedCn.body.journalEntryId}`),
    ).expect(200);
    expect(
      je.body.lines.find((l: { accountCode: string }) => l.accountCode === '1200').credit,
    ).toBe('500.0000');

    const entriesBefore = (
      await as(admin, http().get('/api/v1/journal-entries?pageSize=1')).expect(200)
    ).body.total;
    const tooMuch = await as(admin, http().post(`/api/v1/invoices/${cn.body.id}/apply`))
      .send({ allocations: [{ documentId: inv.body.id, amount: '600' }] })
      .expect(422);
    expect(tooMuch.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    const applied = await as(admin, http().post(`/api/v1/invoices/${cn.body.id}/apply`))
      .send({ allocations: [{ documentId: inv.body.id, amount: '500' }], allocationDate: TODAY })
      .expect(201);
    expect(applied.body.status).toBe('PAID');
    const target = await as(admin, http().get(`/api/v1/invoices/${inv.body.id}`)).expect(200);
    expect(target.body.balance).toBe('2500.0000');
    expect(target.body.status).toBe('PARTIALLY_PAID');
    const entriesAfter = (
      await as(admin, http().get('/api/v1/journal-entries?pageSize=1')).expect(200)
    ).body.total;
    expect(entriesAfter).toBe(entriesBefore);
    await expectReconciled('ar');
  });

  it('void: settled documents cannot be voided; voiding a receipt releases allocations and reverses its entry', async () => {
    const blocked = await as(admin, http().post(`/api/v1/invoices/${invoiceId}/void`))
      .send({ reason: 'test' })
      .expect(422);
    expect(blocked.body.code).toBe('DOCUMENT_HAS_ALLOCATIONS');

    const voided = await as(admin, http().post(`/api/v1/customer-payments/${receiptId}/void`))
      .send({ reason: 'Bounced check', reversalDate: '2026-07-10' })
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    expect(voided.body.reversalJournalEntryId).toBeTruthy();
    const original = await as(
      admin,
      http().get(`/api/v1/journal-entries/${voided.body.journalEntryId}`),
    ).expect(200);
    expect(original.body.status).toBe('REVERSED');

    const invoice = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(invoice.body.status).toBe('PARTIALLY_PAID');
    expect(invoice.body.balance).toBe('4000.0000');
    await expectReconciled('ar');
  });

  it('statement shows running balance and aging buckets the open items', async () => {
    const st = await as(
      admin,
      http().get(`/api/v1/customers/${customerId}/statement?from=2026-06-01&to=${TODAY}`),
    ).expect(200);
    expect(st.body.openingBalance).toBe('0.0000');
    expect(st.body.lines.length).toBeGreaterThanOrEqual(5);
    const last = st.body.lines[st.body.lines.length - 1];
    expect(last.balance).toBe(st.body.closingBalance);
    expect(st.body.closingBalance).toBe('6500.0000'); // 4,000 open on invoice 1 + 2,500 on invoice 2

    const aging = await as(
      admin,
      http().get(`/api/v1/reports/ar-aging?asOf=${TODAY}&partyId=${customerId}`),
    ).expect(200);
    expect(aging.body.rows[0].outstanding).toBe('6500.0000');
    expect(aging.body.rows[0].buckets.days61to90).toBe('4000.0000'); // due 2026-06-21, 82 days
    expect(aging.body.rows[0].buckets.days31to60).toBe('2500.0000'); // due 2026-07-21, 52 days
  });

  // ------------------------------------------------------------------ AP

  let vendorId: string;
  let billId: string;

  it('creates a vendor and a bill; supplier invoice numbers cannot repeat and near-duplicates warn', async () => {
    const vendor = await as(admin, http().post('/api/v1/vendors'))
      .send({ code: 'VEND-E2E', name: 'E2E Supplier', paymentTermsDays: 10 })
      .expect(201);
    vendorId = vendor.body.id;
    const bill = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: '2026-06-03',
        vendorInvoiceNumber: 'SUP-777',
        scheduledPaymentDate: '2026-06-12',
        lines: [
          {
            description: 'Printer toner',
            quantity: '2',
            unitPrice: '1750',
            accountId: acc['6400'],
          },
        ],
      })
      .expect(201);
    billId = bill.body.id;
    expect(bill.body.documentNumber).toMatch(/^BILL-2026-/);
    expect(bill.body.total).toBe('3500.0000');
    expect(bill.body.dueDate).toBe('2026-06-13');
    expect(bill.body.warnings).toEqual([]);

    const dupNumber = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: '2026-06-04',
        vendorInvoiceNumber: 'SUP-777',
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['6400'] }],
      })
      .expect(422);
    expect(dupNumber.body.code).toBe('DUPLICATE_VENDOR_INVOICE');

    const near = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: '2026-06-05',
        lines: [
          { description: 'Toner again', quantity: '2', unitPrice: '1750', accountId: acc['6400'] },
        ],
      })
      .expect(201);
    expect(near.body.warnings[0].code).toBe('POSSIBLE_DUPLICATE_BILL');
    await as(accountant, http().delete(`/api/v1/bills/${near.body.id}`)).expect(204);
  });

  it('posts the bill (Dr expense / Cr AP), pays it, and AP stays reconciled', async () => {
    await as(admin, http().post(`/api/v1/bills/${billId}/approve`)).expect(201);
    const posted = await as(admin, http().post(`/api/v1/bills/${billId}/post`)).expect(201);
    const je = await as(
      admin,
      http().get(`/api/v1/journal-entries/${posted.body.journalEntryId}`),
    ).expect(200);
    expect(
      je.body.lines.find((l: { accountCode: string }) => l.accountCode === '2110').credit,
    ).toBe('3500.0000');
    expect(je.body.lines.find((l: { accountCode: string }) => l.accountCode === '6400').debit).toBe(
      '3500.0000',
    );
    await expectReconciled('ap');

    const schedule = await as(
      admin,
      http().get('/api/v1/reports/ap-schedule?to=2026-06-30'),
    ).expect(200);
    expect(
      schedule.body.items.some(
        (i: { id: string; payOn: string }) => i.id === billId && i.payOn === '2026-06-12',
      ),
    ).toBe(true);

    const pay = await as(admin, http().post('/api/v1/vendor-payments'))
      .send({
        partyId: vendorId,
        paymentDate: '2026-06-12',
        amount: '3500',
        method: 'CHECK',
        cashAccountId: acc['1130'],
        reference: 'CV-E2E',
        allocations: [{ documentId: billId, amount: '3500' }],
      })
      .expect(201);
    expect(pay.body.documentNumber).toMatch(/^PAY-2026-/);
    const postedPay = await as(
      admin,
      http().post(`/api/v1/vendor-payments/${pay.body.id}/post`),
    ).expect(201);
    const payJe = await as(
      admin,
      http().get(`/api/v1/journal-entries/${postedPay.body.journalEntryId}`),
    ).expect(200);
    expect(
      payJe.body.lines.find((l: { accountCode: string }) => l.accountCode === '2110').debit,
    ).toBe('3500.0000');
    expect(
      payJe.body.lines.find((l: { accountCode: string }) => l.accountCode === '1130').credit,
    ).toBe('3500.0000');

    const bill = await as(admin, http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill.body.status).toBe('PAID');
    const ap = await expectReconciled('ap');
    expect(ap.subledgerBalance).toBe('9200.0000');
    const aging = await as(admin, http().get(`/api/v1/reports/ap-aging?asOf=${TODAY}`)).expect(200);
    expect(aging.body.totals.net).toBe('9200.0000');
  });

  it('ledger-level invariants still hold after all subledger activity', async () => {
    const tb = await as(
      admin,
      http().get(`/api/v1/reports/trial-balance?from=2026-01-01&to=${TODAY}`),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
    const bs = await as(admin, http().get(`/api/v1/reports/balance-sheet?asOf=${TODAY}`)).expect(
      200,
    );
    expect(bs.body.balanced).toBe(true);
    const ar = await expectReconciled('ar');
    expect(bs.body.assets.rows.find((r: { code: string }) => r.code === '1200').amount).toBe(
      ar.ledgerBalance,
    );
    const ap = await expectReconciled('ap');
    expect(bs.body.liabilities.rows.find((r: { code: string }) => r.code === '2110').amount).toBe(
      ap.ledgerBalance,
    );
  });
});
