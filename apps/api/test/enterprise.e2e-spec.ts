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
const FINANCE = { email: 'finance@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 8 - multi-currency (rates, foreign-currency documents and payments,
 * realized and unrealized FX), intercompany + consolidation, approval
 * workflows and attachments.
 */
describe('Enterprise: multi-currency, intercompany, workflows, attachments (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin, company = companyId) =>
    req.set('Cookie', who).set('x-company-id', company).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const journalLine = async (journalEntryId: string, code: string, company = companyId) => {
    const je = await as(
      http().get(`/api/v1/journal-entries/${journalEntryId}`),
      admin,
      company,
    ).expect(200);
    const chart = await as(http().get('/api/v1/accounts'), admin, company).expect(200);
    const id = chart.body.find((a: { code: string }) => a.code === code)?.id;
    return je.body.lines.filter((l: { accountId: string }) => l.accountId === id);
  };
  const trialBalanced = async (company = companyId) => {
    const tb = await as(
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31'),
      admin,
      company,
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
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
    finance = await login(FINANCE);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    otherCompanyId = companies.body.find((c: { code: string }) => c.code !== 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------ exchange rates

  it('exchange rates: seeded quotes resolve by date, inverse pairs and missing pairs', async () => {
    const r1 = await as(
      http().get(
        '/api/v1/exchange-rates/resolve?fromCurrency=USD&toCurrency=PHP&onDate=2026-03-05',
      ),
    ).expect(200);
    expect(r1.body.rate).toBe('56.00000000');
    const r2 = await as(
      http().get(
        '/api/v1/exchange-rates/resolve?fromCurrency=USD&toCurrency=PHP&onDate=2026-08-01',
      ),
    ).expect(200);
    expect(r2.body.rate).toBe('57.50000000');
    const inv = await as(
      http().get(
        '/api/v1/exchange-rates/resolve?fromCurrency=PHP&toCurrency=USD&onDate=2026-08-01',
      ),
    ).expect(200);
    expect(inv.body.rate).toBe('0.01739130');
    const missing = await as(
      http().get(
        '/api/v1/exchange-rates/resolve?fromCurrency=JPY&toCurrency=PHP&onDate=2026-08-01',
      ),
    ).expect(422);
    expect(missing.body.code).toBe('EXCHANGE_RATE_MISSING');
    const upsert = await as(http().put('/api/v1/exchange-rates'))
      .send({ fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-09-01', rate: '58.25' })
      .expect(200);
    expect(upsert.body.rate).toBe('58.25000000');
    const again = await as(http().put('/api/v1/exchange-rates'))
      .send({ fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-09-01', rate: '58.3' })
      .expect(200);
    expect(again.body.id).toBe(upsert.body.id);
    const same = await as(http().put('/api/v1/exchange-rates'))
      .send({ fromCurrency: 'PHP', toCurrency: 'PHP', rateDate: '2026-09-01', rate: '1' })
      .expect(400);
    expect(same.body.code).toBe('VALIDATION_FAILED');
  });

  // --------------------------------------------------------- foreign-currency AR

  let usdCustomerId: string;
  let usdInvoiceId: string;

  it('a USD invoice posts in base at the document rate and carries its base total', async () => {
    const customer = await as(http().post('/api/v1/customers'))
      .send({
        code: 'CUST-USD',
        name: 'Pacific Imports LLC',
        currency: 'USD',
        paymentTermsDays: 30,
      })
      .expect(201);
    usdCustomerId = customer.body.id;
    expect(customer.body.currency).toBe('USD');
    const invoice = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: usdCustomerId,
        documentDate: '2026-03-05',
        lines: [{ description: 'Export consulting', unitPrice: '1000', accountId: acc['4200'] }],
      })
      .expect(201);
    usdInvoiceId = invoice.body.id;
    expect(invoice.body.currency).toBe('USD');
    expect(invoice.body.exchangeRate).toBe('56.00000000');
    expect(invoice.body.total).toBe('1000.0000');
    expect(invoice.body.baseTotal).toBe('56000.0000');
    await as(http().post(`/api/v1/invoices/${usdInvoiceId}/approve`), finance).expect(201);
    const posted = await as(http().post(`/api/v1/invoices/${usdInvoiceId}/post`), finance).expect(
      201,
    );
    expect((await journalLine(posted.body.journalEntryId, '1200'))[0].debit).toBe('56000.0000');
    expect((await journalLine(posted.body.journalEntryId, '4200'))[0].credit).toBe('56000.0000');
    // Missing rate blocks creation; an explicit override is honoured.
    const jpy = await as(http().post('/api/v1/customers'))
      .send({ code: 'CUST-JPY', name: 'Tokyo Trading', currency: 'JPY' })
      .expect(201);
    const noRate = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: jpy.body.id,
        documentDate: '2026-03-05',
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['4200'] }],
      })
      .expect(422);
    expect(noRate.body.code).toBe('EXCHANGE_RATE_MISSING');
    const override = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: jpy.body.id,
        documentDate: '2026-03-05',
        exchangeRate: '0.38',
        lines: [{ description: 'x', unitPrice: '10000', accountId: acc['4200'] }],
      })
      .expect(201);
    expect(override.body.baseTotal).toBe('3800.0000');
    await as(http().delete(`/api/v1/invoices/${override.body.id}`)).expect(204);
    // Aging ages the open item in base; the AR subledger still ties to the control.
    const aging = await as(http().get('/api/v1/reports/ar-aging?asOf=2026-06-30')).expect(200);
    const row = aging.body.rows.find((r: { partyId: string }) => r.partyId === usdCustomerId);
    expect(row.outstanding).toBe('56000.0000');
    const rec = await as(http().get('/api/v1/reports/ar-reconciliation?asOf=2026-06-30')).expect(
      200,
    );
    expect(rec.body.reconciled).toBe(true);
  });

  it('period-end revaluation restates the open USD receivable and reverses itself the next day', async () => {
    const preview = await as(
      http().get('/api/v1/fx/revaluations/preview?asOfDate=2026-07-31'),
    ).expect(200);
    const line = preview.body.lines.find(
      (l: { documentId: string }) => l.documentId === usdInvoiceId,
    );
    expect(line.closingRate).toBe('57.50000000');
    expect(line.adjustment).toBe('1500.0000');
    const run = await as(http().post('/api/v1/fx/revaluations'), finance)
      .send({ asOfDate: '2026-07-31' })
      .expect(201);
    expect(run.body.runNumber).toMatch(/^FXR-2026-\d{6}$/);
    expect(run.body.unrealizedGain).toBe('1500.0000');
    expect((await journalLine(run.body.journalEntryId, '1200'))[0].debit).toBe('1500.0000');
    expect((await journalLine(run.body.journalEntryId, '4930'))[0].credit).toBe('1500.0000');
    expect((await journalLine(run.body.reversalJournalEntryId, '1200'))[0].credit).toBe(
      '1500.0000',
    );
    const onClose = await as(
      http().get('/api/v1/reports/ar-reconciliation?asOf=2026-07-31'),
    ).expect(200);
    expect(onClose.body.breakdown.fxAdjustments).toBe('1500.0000');
    expect(onClose.body.reconciled).toBe(true);
    const after = await as(http().get('/api/v1/reports/ar-reconciliation?asOf=2026-08-01')).expect(
      200,
    );
    expect(after.body.breakdown.fxAdjustments).toBe('0.0000');
    expect(after.body.reconciled).toBe(true);
    const dup = await as(http().post('/api/v1/fx/revaluations'), finance)
      .send({ asOfDate: '2026-07-31' })
      .expect(422);
    expect(dup.body.code).toBe('DOCUMENT_INVALID_STATE');
    await trialBalanced();
  });

  it('settling the USD invoice at a higher rate books a realized gain; currency mismatches are refused', async () => {
    const receipt = await as(http().post('/api/v1/customer-payments'))
      .send({
        partyId: usdCustomerId,
        paymentDate: '2026-08-05',
        amount: '1000',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: usdInvoiceId, amount: '1000' }],
      })
      .expect(201);
    expect(receipt.body.currency).toBe('USD');
    expect(receipt.body.exchangeRate).toBe('57.50000000');
    const posted = await as(
      http().post(`/api/v1/customer-payments/${receipt.body.id}/post`),
      finance,
    ).expect(201);
    const je = posted.body.journalEntryId;
    expect((await journalLine(je, '1130'))[0].debit).toBe('57500.0000');
    expect((await journalLine(je, '1200'))[0].credit).toBe('56000.0000');
    expect((await journalLine(je, '4910'))[0].credit).toBe('1500.0000');
    expect(posted.body.baseAmount).toBe('57500.0000');
    expect(posted.body.controlBaseAmount).toBe('56000.0000');
    const invoice = await as(http().get(`/api/v1/invoices/${usdInvoiceId}`)).expect(200);
    expect(invoice.body.status).toBe('PAID');
    const rec = await as(http().get('/api/v1/reports/ar-reconciliation?asOf=2026-08-31')).expect(
      200,
    );
    expect(rec.body.reconciled).toBe(true);

    // A PHP customer's receipt cannot be applied to a USD invoice.
    const phpCustomer = await as(http().get('/api/v1/customers?pageSize=5')).expect(200);
    const php = phpCustomer.body.items.find((c: { currency: string }) => c.currency === 'PHP');
    await as(http().patch(`/api/v1/customers/${usdCustomerId}`))
      .send({ currency: 'PHP' })
      .expect(200);
    const second = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: php.id,
        documentDate: '2026-08-05',
        lines: [{ description: 'x', unitPrice: '100', accountId: acc['4200'] }],
      })
      .expect(201);
    void second;
    const mismatch = await as(http().post('/api/v1/customer-payments'))
      .send({
        partyId: usdCustomerId,
        paymentDate: '2026-08-06',
        amount: '10',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: usdInvoiceId, amount: '10' }],
      })
      .expect(422);
    expect(mismatch.body.code).toBe('CURRENCY_MISMATCH');
    await as(http().patch(`/api/v1/customers/${usdCustomerId}`))
      .send({ currency: 'USD' })
      .expect(200);
    await trialBalanced();
  });

  it('a USD bill paid at a higher rate books a realized loss and AP still reconciles', async () => {
    const vendor = await as(http().post('/api/v1/vendors'))
      .send({ code: 'VEND-USD', name: 'Cloud Services Inc', currency: 'USD' })
      .expect(201);
    const bill = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: vendor.body.id,
        documentDate: '2026-03-10',
        vendorInvoiceNumber: 'CLOUD-1',
        lines: [{ description: 'Hosting', unitPrice: '500', accountId: acc['6400'] }],
      })
      .expect(201);
    expect(bill.body.baseTotal).toBe('28000.0000');
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    const postedBill = await as(http().post(`/api/v1/bills/${bill.body.id}/post`), finance).expect(
      201,
    );
    expect((await journalLine(postedBill.body.journalEntryId, '2110'))[0].credit).toBe(
      '28000.0000',
    );
    expect((await journalLine(postedBill.body.journalEntryId, '6400'))[0].debit).toBe('28000.0000');
    const payment = await as(http().post('/api/v1/vendor-payments'))
      .send({
        partyId: vendor.body.id,
        paymentDate: '2026-08-05',
        amount: '500',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: bill.body.id, amount: '500' }],
      })
      .expect(201);
    const posted = await as(
      http().post(`/api/v1/vendor-payments/${payment.body.id}/post`),
      finance,
    ).expect(201);
    const je = posted.body.journalEntryId;
    expect((await journalLine(je, '2110'))[0].debit).toBe('28000.0000');
    expect((await journalLine(je, '1130'))[0].credit).toBe('28750.0000');
    expect((await journalLine(je, '6910'))[0].debit).toBe('750.0000');
    const rec = await as(http().get('/api/v1/reports/ap-reconciliation?asOf=2026-08-31')).expect(
      200,
    );
    expect(rec.body.reconciled).toBe(true);
    await trialBalanced();
  });

  // ----------------------------------------------------------- intercompany

  let intercompanyId: string;

  it('intercompany transaction posts mirrored entries in both companies atomically', async () => {
    const otherChart = await as(http().get('/api/v1/accounts'), admin, otherCompanyId).expect(200);
    const otherIncome = otherChart.body.find((a: { code: string }) => a.code === '4900').id;
    const wrongCompanyAccount = await as(http().post('/api/v1/intercompany'))
      .send({
        fromCompanyId: companyId,
        toCompanyId: otherCompanyId,
        transactionDate: '2026-09-01',
        description: 'Shared services',
        amount: '12000',
        fromAccountId: acc['6400'],
        toAccountId: acc['4900'],
      })
      .expect(404);
    expect(wrongCompanyAccount.body.code).toBe('NOT_FOUND');
    const created = await as(http().post('/api/v1/intercompany'))
      .send({
        fromCompanyId: companyId,
        toCompanyId: otherCompanyId,
        transactionDate: '2026-09-01',
        description: 'Shared services recharge',
        reference: 'SS-09',
        amount: '12000',
        fromAccountId: acc['6400'],
        toAccountId: otherIncome,
      })
      .expect(201);
    intercompanyId = created.body.id;
    expect(created.body.documentNumber).toMatch(/^ICT-2026-\d{6}$/);
    expect(created.body.status).toBe('DRAFT');
    const posted = await as(http().post(`/api/v1/intercompany/${intercompanyId}/post`)).expect(201);
    expect(posted.body.status).toBe('POSTED');
    expect((await journalLine(posted.body.fromJournalEntryId, '6400'))[0].debit).toBe('12000.0000');
    expect((await journalLine(posted.body.fromJournalEntryId, '2180'))[0].credit).toBe(
      '12000.0000',
    );
    expect((await journalLine(posted.body.toJournalEntryId, '1290', otherCompanyId))[0].debit).toBe(
      '12000.0000',
    );
    expect(
      (await journalLine(posted.body.toJournalEntryId, '4900', otherCompanyId))[0].credit,
    ).toBe('12000.0000');
    await trialBalanced();
    await trialBalanced(otherCompanyId);
  });

  it('the consolidated trial balance eliminates the intercompany pair and stays balanced', async () => {
    const report = await as(
      http().get('/api/v1/consolidation/trial-balance?from=2026-01-01&to=2026-09-30'),
    ).expect(200);
    expect(report.body.companies).toHaveLength(2);
    expect(report.body.currency).toBe('PHP');
    const due = report.body.rows.find((r: { code: string }) => r.code === '1290');
    const owed = report.body.rows.find((r: { code: string }) => r.code === '2180');
    expect(due.isIntercompany).toBe(true);
    expect(due.byCompany[otherCompanyId]).toBe('12000.0000');
    expect(due.eliminations).toBe('-12000.0000');
    expect(due.consolidated).toBe('0.0000');
    expect(owed.byCompany[companyId]).toBe('12000.0000');
    expect(report.body.totals.eliminationCheck).toBe('0.0000');
    expect(report.body.totals.balanced).toBe(true);
    const single = await as(
      http().get(
        `/api/v1/consolidation/trial-balance?from=2026-01-01&to=2026-09-30&companyIds=${otherCompanyId}`,
      ),
    ).expect(200);
    expect(single.body.companies).toHaveLength(1);
    expect(single.body.totals.eliminationCheck).toBe('12000.0000'); // the mirror lives in the excluded company

    const reversed = await as(http().post(`/api/v1/intercompany/${intercompanyId}/reverse`))
      .send({ reason: 'Recharged twice' })
      .expect(201);
    expect(reversed.body.status).toBe('REVERSED');
    const after = await as(
      http().get('/api/v1/consolidation/trial-balance?from=2026-01-01&to=2026-09-30'),
    ).expect(200);
    expect(after.body.rows.find((r: { code: string }) => r.code === '1290')).toBeUndefined();
    await trialBalanced();
    await trialBalanced(otherCompanyId);
  });

  // ---------------------------------------------------------------- workflows

  let workflowId: string;
  let bigEntryId: string;

  it('a two-step workflow gates journal approval above its amount band', async () => {
    const accountant = await login({ email: 'accountant@acme.local', password: 'Demo!Passw0rd' });
    const workflow = await as(http().post('/api/v1/approval-workflows'))
      .send({
        documentType: 'JOURNAL_ENTRY',
        name: 'Large journals',
        minAmount: '50000',
        steps: [
          { name: 'Finance review', requiredPermission: 'journal.approve', minApprovers: 1 },
          { name: 'Controller sign-off', requiredPermission: 'period.close', minApprovers: 1 },
        ],
      })
      .expect(201);
    workflowId = workflow.body.id;
    const bad = await as(http().post('/api/v1/approval-workflows'))
      .send({
        documentType: 'JOURNAL_ENTRY',
        name: 'x',
        minAmount: '10',
        maxAmount: '5',
        steps: [{ name: 's', requiredPermission: 'journal.approve' }],
      })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');

    // Below the band: the usual approve works untouched.
    const small = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({
        entryDate: '2026-09-10',
        description: 'Small accrual',
        lines: [
          { accountId: acc['6400'], debit: '1000' },
          { accountId: acc['2120'], credit: '1000' },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${small.body.id}/submit`), accountant).expect(
      201,
    );
    await as(http().post(`/api/v1/journal-entries/${small.body.id}/approve`), finance).expect(201);

    // In the band: submit opens a request; approve is refused until the chain completes.
    const big = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({
        entryDate: '2026-09-10',
        description: 'Large accrual',
        lines: [
          { accountId: acc['6400'], debit: '90000' },
          { accountId: acc['2120'], credit: '90000' },
        ],
      })
      .expect(201);
    bigEntryId = big.body.id;
    await as(http().post(`/api/v1/journal-entries/${bigEntryId}/submit`), accountant).expect(201);
    const blocked = await as(
      http().post(`/api/v1/journal-entries/${bigEntryId}/approve`),
      finance,
    ).expect(422);
    expect(blocked.body.code).toBe('APPROVAL_REQUIRED');
    expect(blocked.body.details.requestId).toBeTruthy();
    const requestId = blocked.body.details.requestId as string;

    const inbox = await as(http().get('/api/v1/approvals?mine=true'), finance).expect(200);
    expect(inbox.body.items.map((r: { id: string }) => r.id)).toContain(requestId);
    const notMine = await as(http().get('/api/v1/approvals?mine=true'), accountant).expect(200);
    expect(notMine.body.items.map((r: { id: string }) => r.id)).not.toContain(requestId);
    const selfApprove = await as(
      http().post(`/api/v1/approvals/${requestId}/decide`),
      accountant,
    ).expect(403);
    expect(selfApprove.body.code).toBe('PERMISSION_DENIED');

    const step1 = await as(http().post(`/api/v1/approvals/${requestId}/decide`), finance)
      .send({ decision: 'APPROVE', comment: 'Looks right' })
      .expect(201);
    expect(step1.body.status).toBe('PENDING');
    expect(step1.body.currentStep).toBe(1);
    const twice = await as(http().post(`/api/v1/approvals/${requestId}/decide`), finance)
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(twice.body.code).toBe('APPROVAL_NOT_ELIGIBLE'); // one decision per person per request
    const stillBlocked = await as(
      http().post(`/api/v1/journal-entries/${bigEntryId}/approve`),
      finance,
    ).expect(422);
    expect(stillBlocked.body.code).toBe('APPROVAL_REQUIRED');
    const step2 = await as(http().post(`/api/v1/approvals/${requestId}/decide`), admin)
      .send({ decision: 'APPROVE' })
      .expect(201);
    expect(step2.body.status).toBe('APPROVED');
    expect(step2.body.decisions).toHaveLength(2);
    await as(http().post(`/api/v1/journal-entries/${bigEntryId}/approve`), finance).expect(201);
    const listed = await as(http().get('/api/v1/approvals?status=APPROVED')).expect(200);
    expect(listed.body.items.some((r: { documentId: string }) => r.documentId === bigEntryId)).toBe(
      true,
    );
  });

  it('a rejection ends the request; deactivating the workflow lifts the gate', async () => {
    const accountant = await login({ email: 'accountant@acme.local', password: 'Demo!Passw0rd' });
    const je = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({
        entryDate: '2026-09-11',
        description: 'Another large accrual',
        lines: [
          { accountId: acc['6400'], debit: '60000' },
          { accountId: acc['2120'], credit: '60000' },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`), accountant).expect(201);
    const pending = await as(
      http().get(`/api/v1/approvals?documentType=JOURNAL_ENTRY&status=PENDING`),
    ).expect(200);
    const request = pending.body.items.find(
      (r: { documentId: string }) => r.documentId === je.body.id,
    );
    expect(request).toBeTruthy();
    const rejected = await as(http().post(`/api/v1/approvals/${request.id}/decide`), finance)
      .send({ decision: 'REJECT', comment: 'Wrong period' })
      .expect(201);
    expect(rejected.body.status).toBe('REJECTED');
    const blocked = await as(
      http().post(`/api/v1/journal-entries/${je.body.id}/approve`),
      finance,
    ).expect(422);
    expect(blocked.body.code).toBe('APPROVAL_REQUIRED');
    expect(blocked.body.details.status).toBe('PENDING'); // a fresh request was opened
    await as(http().patch(`/api/v1/approval-workflows/${workflowId}`))
      .send({ status: 'INACTIVE' })
      .expect(200);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
  });

  // -------------------------------------------------------------- attachments

  it('attachments upload, list, download with checksum and delete; unsafe files are refused', async () => {
    const pdf = Buffer.from(
      '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF',
    );
    const uploaded = await as(http().post(`/api/v1/attachments/journal-entry/${bigEntryId}`))
      .field('description', 'Signed voucher')
      .attach('file', pdf, { filename: 'voucher 09.pdf', contentType: 'application/pdf' })
      .expect(201);
    expect(uploaded.body.fileName).toBe('voucher 09.pdf');
    expect(uploaded.body.sizeBytes).toBe(pdf.length);
    expect(uploaded.body.sha256).toHaveLength(64);
    const listed = await as(http().get(`/api/v1/attachments/JOURNAL_ENTRY/${bigEntryId}`)).expect(
      200,
    );
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].uploadedByName).toMatch(/\w+ \w+/);
    const download = await as(http().get(`/api/v1/attachments/file/${uploaded.body.id}`)).expect(
      200,
    );
    expect(download.headers['content-type']).toMatch(/application\/pdf/);
    expect(download.headers['x-checksum-sha256']).toBe(uploaded.body.sha256);
    expect(Buffer.from(download.body).equals(pdf) || download.text === pdf.toString()).toBe(true);
    const exe = await as(http().post(`/api/v1/attachments/journal-entry/${bigEntryId}`))
      .attach('file', Buffer.from('MZ'), {
        filename: 'run.exe',
        contentType: 'application/x-msdownload',
      })
      .expect(422);
    expect(exe.body.code).toBe('FILE_NOT_ALLOWED');
    const foreign = await as(http().post(`/api/v1/attachments/invoice/${bigEntryId}`))
      .attach('file', pdf, { filename: 'x.pdf', contentType: 'application/pdf' })
      .expect(404);
    expect(foreign.body.code).toBe('NOT_FOUND');
    await as(http().delete(`/api/v1/attachments/file/${uploaded.body.id}`)).expect(204);
    const after = await as(http().get(`/api/v1/attachments/JOURNAL_ENTRY/${bigEntryId}`)).expect(
      200,
    );
    expect(after.body).toHaveLength(0);
  });
});
