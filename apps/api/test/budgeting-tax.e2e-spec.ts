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
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 7 - dimensions on lines, the tax engine on AR / AP documents, budgets
 * with variance against posted actuals, and expense claims through approval,
 * posting and reimbursement.
 */
describe('Budgeting, dimensions, tax & expense claims (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const tax: Record<string, string> = {};
  const dim: Record<string, string> = {};
  const party: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const journalLine = async (journalEntryId: string, code: string) => {
    const je = await as(http().get(`/api/v1/journal-entries/${journalEntryId}`)).expect(200);
    return je.body.lines.filter((l: { accountId: string }) => l.accountId === acc[code]);
  };
  const trialBalanced = async () => {
    const tb = await as(
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31'),
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
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const codes = await as(http().get('/api/v1/tax/codes')).expect(200);
    for (const c of codes.body) tax[c.code] = c.id;
    const dims = await as(http().get('/api/v1/dimensions')).expect(200);
    for (const d of dims.body) dim[d.code] = d.id;
    const customers = await as(http().get('/api/v1/customers?pageSize=50')).expect(200);
    for (const c of customers.body.items) party[c.code] = c.id;
    const vendors = await as(http().get('/api/v1/vendors?pageSize=50')).expect(200);
    for (const v of vendors.body.items) party[v.code] = v.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // -------------------------------------------------------------- dimensions

  it('dimensions are typed: a project column cannot point at a department', async () => {
    expect(dim['ADMIN']).toBeTruthy();
    const created = await as(http().post('/api/v1/dimensions'))
      .send({ dimensionType: 'DEPARTMENT', code: 'RND', name: 'Research' })
      .expect(201);
    expect(created.body.usageCount).toBe(0);
    const dup = await as(http().post('/api/v1/dimensions'))
      .send({ dimensionType: 'DEPARTMENT', code: 'RND', name: 'Again' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');
    const mistyped = await as(http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-09-03',
        description: 'Mistyped dimension',
        lines: [
          { accountId: acc['6400'], debit: '100', projectId: dim['ADMIN'] },
          { accountId: acc['1110'], credit: '100' },
        ],
      })
      .expect(422);
    expect(mistyped.body.code).toBe('VALIDATION_FAILED');
    expect(mistyped.body.message).toMatch(/department, not a project/);
  });

  it('journal lines carry dimensions and the ledger / trial balance filter by them', async () => {
    const je = await as(http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-09-03',
        description: 'Team offsite',
        lines: [
          {
            accountId: acc['6400'],
            debit: '3000',
            departmentId: dim['SALES'],
            costCenterId: dim['CC-HQ'],
            projectId: dim['PRJ-ERP'],
          },
          { accountId: acc['1110'], credit: '3000' },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`)).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/post`), finance).expect(201);
    const detail = await as(http().get(`/api/v1/journal-entries/${je.body.id}`)).expect(200);
    expect(detail.body.lines[0].departmentId).toBe(dim['SALES']);

    const byDept = await as(
      http().get(
        `/api/v1/general-ledger?accountId=${acc['6400']}&from=2026-09-01&to=2026-09-30&departmentId=${dim['SALES']}`,
      ),
    ).expect(200);
    expect(byDept.body.lines).toHaveLength(1);
    expect(byDept.body.lines[0].debit).toBe('3000.0000');
    const other = await as(
      http().get(
        `/api/v1/general-ledger?accountId=${acc['6400']}&from=2026-09-01&to=2026-09-30&departmentId=${dim['OPS']}`,
      ),
    ).expect(200);
    expect(other.body.lines).toHaveLength(0);
    const tb = await as(
      http().get(
        `/api/v1/reports/trial-balance?from=2026-09-01&to=2026-09-30&projectId=${dim['PRJ-ERP']}`,
      ),
    ).expect(200);
    const row = tb.body.rows.find((r: { accountId: string }) => r.accountId === acc['6400']);
    expect(row.periodDebit).toBe('3000.0000');
    const usage = await as(http().get(`/api/v1/dimensions/${dim['PRJ-ERP']}`)).expect(200);
    expect(usage.body.usageCount).toBe(1);
  });

  // --------------------------------------------------------------------- tax

  it('tax codes carry effective-dated rates; overlapping windows are rejected', async () => {
    expect(tax['VAT12']).toBeTruthy();
    const vat = await as(http().get(`/api/v1/tax/codes/${tax['VAT12']}`)).expect(200);
    expect(vat.body.currentRate).toBe('12.0000');
    expect(vat.body.isDefaultSales).toBe(true);
    const overlap = await as(http().post('/api/v1/tax/codes'))
      .send({
        code: 'VAT15',
        name: 'Future VAT',
        kind: 'SALES_TAX',
        appliesTo: 'BOTH',
        reportingCategory: 'TAXABLE',
        salesAccountId: acc['2130'],
        purchaseAccountId: acc['1450'],
        rates: [
          { ratePercent: '12', effectiveFrom: '2020-01-01', effectiveTo: null },
          { ratePercent: '15', effectiveFrom: '2027-01-01' },
        ],
      })
      .expect(422);
    expect(overlap.body.code).toBe('VALIDATION_FAILED');
    const ok = await as(http().post('/api/v1/tax/codes'))
      .send({
        code: 'VAT15',
        name: 'Future VAT',
        kind: 'SALES_TAX',
        appliesTo: 'SALES',
        reportingCategory: 'TAXABLE',
        salesAccountId: acc['2130'],
        rates: [
          { ratePercent: '12', effectiveFrom: '2020-01-01', effectiveTo: '2026-12-31' },
          { ratePercent: '15', effectiveFrom: '2027-01-01' },
        ],
      })
      .expect(201);
    tax['VAT15'] = ok.body.id;
    expect(ok.body.rates).toHaveLength(2);
    const noAccount = await as(http().post('/api/v1/tax/codes'))
      .send({
        code: 'BAD',
        name: 'x',
        kind: 'SALES_TAX',
        appliesTo: 'BOTH',
        reportingCategory: 'TAXABLE',
        salesAccountId: acc['2130'],
        rates: [{ ratePercent: '1', effectiveFrom: '2020-01-01' }],
      })
      .expect(400);
    expect(noAccount.body.code).toBe('VALIDATION_FAILED');
  });

  let invoiceId: string;

  it('invoice with VAT and creditable withholding: total = subtotal + tax - withholding, posted per tax account', async () => {
    const inv = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-001'],
        documentDate: '2026-09-05',
        lines: [
          {
            description: 'Consulting',
            unitPrice: '10000',
            accountId: acc['4200'],
            taxCodeId: tax['VAT12'],
            withholdingTaxCodeId: tax['EWT2'],
            departmentId: dim['SALES'],
          },
          {
            description: 'Zero-rated export',
            unitPrice: '4000',
            accountId: acc['4100'],
            taxCodeId: tax['VAT0'],
          },
        ],
      })
      .expect(201);
    invoiceId = inv.body.id;
    expect(inv.body.subtotal).toBe('14000.0000');
    expect(inv.body.taxTotal).toBe('1200.0000');
    expect(inv.body.withholdingTotal).toBe('200.0000');
    expect(inv.body.total).toBe('15000.0000');
    expect(inv.body.lines[0].taxAmount).toBe('1200.0000');
    expect(inv.body.lines[0].withholdingAmount).toBe('200.0000');
    expect(inv.body.lines[1].taxRate).toBe('0.0000');

    const wrongSide = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: party['CUST-001'],
        documentDate: '2026-09-05',
        lines: [
          { description: 'x', unitPrice: '1', accountId: acc['4100'], taxCodeId: tax['EWT1'] },
        ],
      })
      .expect(422);
    expect(wrongSide.body.message).toMatch(/withholding tax code/);

    await as(http().post(`/api/v1/invoices/${invoiceId}/approve`), finance).expect(201);
    const posted = await as(http().post(`/api/v1/invoices/${invoiceId}/post`), finance).expect(201);
    const je = posted.body.journalEntryId;
    expect((await journalLine(je, '1200'))[0].debit).toBe('15000.0000');
    expect((await journalLine(je, '4200'))[0].credit).toBe('10000.0000');
    expect((await journalLine(je, '4200'))[0].departmentId).toBe(dim['SALES']);
    expect((await journalLine(je, '2130'))[0].credit).toBe('1200.0000');
    expect((await journalLine(je, '1460'))[0].debit).toBe('200.0000');
    expect(await journalLine(je, '1450')).toHaveLength(0);

    const txs = await as(
      http().get(`/api/v1/tax/transactions?from=2026-09-01&to=2026-09-30`),
    ).expect(200);
    expect(txs.body.items).toHaveLength(3); // VAT12, VAT0 (zero-rated base is still reported), EWT2
    const summary = await as(
      http().get('/api/v1/tax/reports/summary?from=2026-09-01&to=2026-09-30'),
    ).expect(200);
    expect(summary.body.totals.outputTax).toBe('1200.0000');
    expect(summary.body.totals.withholdingReceivable).toBe('200.0000');
    await trialBalanced();
  });

  it('bill with input VAT and expanded withholding; the tax summary nets output against input', async () => {
    const bill = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: party['VEND-002'],
        documentDate: '2026-09-06',
        vendorInvoiceNumber: 'TAX-9001',
        lines: [
          {
            description: 'Cleaning services',
            unitPrice: '5000',
            accountId: acc['6400'],
            taxCodeId: tax['VAT12'],
            withholdingTaxCodeId: tax['EWT1'],
            costCenterId: dim['CC-HQ'],
          },
        ],
      })
      .expect(201);
    expect(bill.body.total).toBe('5550.0000'); // 5,000 + 600 - 50
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    const posted = await as(http().post(`/api/v1/bills/${bill.body.id}/post`), finance).expect(201);
    const je = posted.body.journalEntryId;
    expect((await journalLine(je, '6400'))[0].debit).toBe('5000.0000');
    expect((await journalLine(je, '6400'))[0].costCenterId).toBe(dim['CC-HQ']);
    expect((await journalLine(je, '1450'))[0].debit).toBe('600.0000');
    expect((await journalLine(je, '2110'))[0].credit).toBe('5550.0000');
    expect((await journalLine(je, '2140'))[0].credit).toBe('50.0000');

    const summary = await as(
      http().get('/api/v1/tax/reports/summary?from=2026-09-01&to=2026-09-30'),
    ).expect(200);
    expect(summary.body.totals.inputTax).toBe('600.0000');
    expect(summary.body.totals.netTaxPayable).toBe('600.0000'); // 1,200 - 600
    expect(summary.body.totals.withholdingPayable).toBe('50.0000');
    const wht = await as(
      http().get('/api/v1/tax/reports/withholding?from=2026-09-01&to=2026-09-30&side=PURCHASES'),
    ).expect(200);
    expect(wht.body).toHaveLength(1);
    expect(wht.body[0].taxAmount).toBe('50.0000');
    expect(wht.body[0].partyId).toBe(party['VEND-002']);
    await trialBalanced();
  });

  it('voiding a taxed invoice reverses its tax transactions', async () => {
    await as(http().post(`/api/v1/invoices/${invoiceId}/void`), finance)
      .send({ reason: 'Re-issue' })
      .expect(201);
    const summary = await as(
      http().get('/api/v1/tax/reports/summary?from=2026-09-01&to=2026-09-30'),
    ).expect(200);
    expect(summary.body.totals.outputTax).toBe('0.0000');
    expect(summary.body.totals.withholdingReceivable).toBe('0.0000');
    expect(summary.body.totals.inputTax).toBe('600.0000');
    const txs = await as(
      http().get(`/api/v1/tax/transactions?from=2026-09-01&to=2026-09-30&side=SALES`),
    ).expect(200);
    expect(
      txs.body.items.filter((t: { reversalOfId: string | null }) => t.reversalOfId),
    ).toHaveLength(3);
    await trialBalanced();
  });

  // ----------------------------------------------------------------- budgets

  it('the seeded budget compares against posted actuals per account and period', async () => {
    const budgets = await as(http().get('/api/v1/budgets')).expect(200);
    const opex = budgets.body.items.find((b: { code: string }) => b.code.startsWith('OPEX-'));
    expect(opex.approvedVersionId).toBeTruthy();
    const variance = await as(http().get(`/api/v1/budgets/${opex.id}/variance`)).expect(200);
    expect(variance.body.periods).toHaveLength(12);
    const row = variance.body.rows.find((r: { code: string }) => r.code === '6400');
    expect(row).toBeTruthy();
    const sept = row.cells[8];
    expect(sept.budget).toBe('5000.0000');
    expect(sept.actual).toBe('8000.0000'); // 3,000 offsite + 5,000 cleaning
    expect(sept.variance).toBe('3000.0000');
    expect(row.budget).toBe('60000.0000');
    // Dimension filter narrows both sides.
    const byDept = await as(
      http().get(`/api/v1/budgets/${opex.id}/variance?departmentId=${dim['SALES']}`),
    ).expect(200);
    const deptRow = byDept.body.rows.find((r: { code: string }) => r.code === '6400');
    expect(deptRow.cells[8].actual).toBe('3000.0000');
    expect(deptRow.cells[8].budget).toBe('0.0000'); // seeded budget is not by department
  });

  it('budget versions: draft lines replace, approval locks and supersedes', async () => {
    const years = await as(http().get('/api/v1/fiscal-years')).expect(200);
    const year = years.body[0];
    const created = await as(http().post('/api/v1/budgets'))
      .send({ fiscalYearId: year.id, code: 'CAPEX-2026', name: 'Capital plan' })
      .expect(201);
    expect(created.body.versions).toHaveLength(1);
    const v1 = created.body.versions[0];
    const jan = year.periods[0];
    const lines = await as(http().put(`/api/v1/budgets/${created.body.id}/versions/${v1.id}/lines`))
      .send({
        lines: [
          {
            accountId: acc['6500'],
            fiscalPeriodId: jan.id,
            amount: '12000',
            departmentId: dim['OPS'],
          },
          {
            accountId: acc['6500'],
            fiscalPeriodId: jan.id,
            amount: '3000',
            departmentId: dim['ADMIN'],
          },
        ],
      })
      .expect(200);
    expect(lines.body.lines).toHaveLength(2);
    expect(lines.body.total).toBe('15000.0000');
    const header = await as(
      http().put(`/api/v1/budgets/${created.body.id}/versions/${v1.id}/lines`),
    )
      .send({ lines: [{ accountId: acc['6000'], fiscalPeriodId: jan.id, amount: '1' }] })
      .expect(422);
    expect(header.body.message).toMatch(/header account/);
    await as(
      http().post(`/api/v1/budgets/${created.body.id}/versions/${v1.id}/approve`),
      finance,
    ).expect(201);
    const locked = await as(
      http().put(`/api/v1/budgets/${created.body.id}/versions/${v1.id}/lines`),
    )
      .send({ lines: [] })
      .expect(422);
    expect(locked.body.code).toBe('DOCUMENT_INVALID_STATE');
    const v2 = await as(http().post(`/api/v1/budgets/${created.body.id}/versions`))
      .send({ name: 'Revised', copyFromVersionId: v1.id })
      .expect(201);
    expect(v2.body.versionNumber).toBe(2);
    expect(v2.body.lines).toHaveLength(2);
    await as(
      http().post(`/api/v1/budgets/${created.body.id}/versions/${v2.body.id}/approve`),
      finance,
    ).expect(201);
    const detail = await as(http().get(`/api/v1/budgets/${created.body.id}`)).expect(200);
    expect(detail.body.status).toBe('ACTIVE');
    expect(detail.body.versions.find((v: { id: string }) => v.id === v1.id).status).toBe(
      'SUPERSEDED',
    );
    expect(detail.body.approvedVersionId).toBe(v2.body.id);
    const variance = await as(
      http().get(`/api/v1/budgets/${created.body.id}/variance?departmentId=${dim['OPS']}`),
    ).expect(200);
    expect(
      variance.body.rows.find((r: { code: string }) => r.code === '6500').cells[0].budget,
    ).toBe('12000.0000');
  });

  // ---------------------------------------------------------- expense claims

  it('expense claim: tax-inclusive lines, submit, own-approval blocked, approve, post and reimburse', async () => {
    const claim = await as(http().post('/api/v1/expense-claims'))
      .send({
        claimDate: '2026-09-08',
        purpose: 'Client visit',
        lines: [
          {
            expenseDate: '2026-09-07',
            description: 'Taxi',
            accountId: acc['6400'],
            amount: '1120',
            taxCodeId: tax['VAT12'],
            departmentId: dim['SALES'],
          },
          {
            expenseDate: '2026-09-07',
            description: 'Parking (no receipt)',
            accountId: acc['6400'],
            amount: '200',
          },
        ],
      })
      .expect(201);
    expect(claim.body.claimNumber).toMatch(/^EXP-2026-\d{6}$/);
    expect(claim.body.total).toBe('1320.0000');
    expect(claim.body.taxTotal).toBe('120.0000');
    expect(claim.body.lines[0].taxAmount).toBe('120.0000');
    const late = await as(http().post('/api/v1/expense-claims'))
      .send({
        claimDate: '2026-09-08',
        purpose: 'x',
        lines: [
          { expenseDate: '2026-09-09', description: 'x', accountId: acc['6400'], amount: '1' },
        ],
      })
      .expect(422);
    expect(late.body.code).toBe('VALIDATION_FAILED');

    const tooEarly = await as(
      http().post(`/api/v1/expense-claims/${claim.body.id}/approve`),
      finance,
    ).expect(422);
    expect(tooEarly.body.code).toBe('DOCUMENT_INVALID_STATE');
    await as(http().post(`/api/v1/expense-claims/${claim.body.id}/submit`)).expect(201);
    const own = await as(http().post(`/api/v1/expense-claims/${claim.body.id}/approve`)).expect(
      422,
    );
    expect(own.body.code).toBe('SOD_VIOLATION');
    const approved = await as(
      http().post(`/api/v1/expense-claims/${claim.body.id}/approve`),
      finance,
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');

    const posted = await as(
      http().post(`/api/v1/expense-claims/${claim.body.id}/post`),
      finance,
    ).expect(201);
    const je = posted.body.journalEntryId;
    const expense = await journalLine(je, '6400');
    expect(expense.map((l: { debit: string }) => l.debit).sort()).toEqual([
      '1000.0000',
      '200.0000',
    ]);
    expect((await journalLine(je, '1450'))[0].debit).toBe('120.0000');
    expect((await journalLine(je, '2170'))[0].credit).toBe('1320.0000');
    const editLocked = await as(http().patch(`/api/v1/expense-claims/${claim.body.id}`))
      .send({ purpose: 'x' })
      .expect(422);
    expect(editLocked.body.code).toBe('DOCUMENT_INVALID_STATE');

    const banks = await as(http().get('/api/v1/bank-accounts')).expect(200);
    const bdo = banks.body.find((b: { code: string }) => b.code === 'BDO-MAIN');
    const paid = await as(http().post(`/api/v1/expense-claims/${claim.body.id}/pay`), finance)
      .send({ bankAccountId: bdo.id, paymentDate: '2026-09-10', reference: 'REIMB-1' })
      .expect(201);
    expect(paid.body.status).toBe('PAID');
    expect((await journalLine(paid.body.paymentJournalEntryId, '2170'))[0].debit).toBe('1320.0000');
    expect((await journalLine(paid.body.paymentJournalEntryId, '1130'))[0].credit).toBe(
      '1320.0000',
    );
    const summary = await as(
      http().get('/api/v1/tax/reports/summary?from=2026-09-01&to=2026-09-30'),
    ).expect(200);
    expect(summary.body.totals.inputTax).toBe('720.0000'); // 600 bill + 120 claim
    await trialBalanced();
  });
});
