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
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const AUDITOR = { email: 'auditor@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

const money = (v: string | null | undefined) => Number(v ?? '0');

/**
 * Hardening phase 7 - reporting engine: configurable report definitions run
 * against posted journals and approved budgets (comparative columns,
 * formulas, variances, dimension groups, as-of basis), the journal control
 * center and end-to-end traceability from a journal to its source document
 * and audit trail.
 */
describe('Reporting engine (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let auditor: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const dim: Record<string, string> = {};
  const defs: Record<string, { id: string; isSystem: boolean; basis: string }> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const run = (id: string, params: Record<string, unknown>, who: Cookies = admin) =>
    as(http().post(`/api/v1/report-definitions/${id}/run`), who).send(params);
  const rowOf = (
    report: { rows: Array<{ key: string; kind: string; label: string }> },
    key: string,
    kind?: string,
  ) =>
    report.rows.find((r) => r.key === key && (!kind || r.kind === kind)) as
      | {
          key: string;
          kind: string;
          label: string;
          values: Record<string, string | null>;
          accountId?: string;
        }
      | undefined;
  const postJournal = async (
    entryDate: string,
    description: string,
    lines: Array<Record<string, string | undefined>>,
  ): Promise<string> => {
    const je = await as(http().post('/api/v1/journal-entries'))
      .send({ entryDate, description, lines })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`)).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/post`), finance).expect(201);
    return je.body.id as string;
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
    viewer = await login(VIEWER);
    auditor = await login(AUDITOR);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const dims = await as(http().get('/api/v1/dimensions')).expect(200);
    for (const d of dims.body) dim[d.code] = d.id;

    // Activity the reports compare: August + September 2026 revenue and expenses, one by department.
    await postJournal('2026-08-15', 'August sale', [
      { accountId: acc['1110'], debit: '4000' },
      { accountId: acc['4100'], credit: '4000' },
    ]);
    await postJournal('2026-09-10', 'September sale', [
      { accountId: acc['1110'], debit: '6000' },
      { accountId: acc['4100'], credit: '6000' },
    ]);
    await postJournal('2026-09-12', 'Sales team offsite', [
      { accountId: acc['6400'], debit: '3000', departmentId: dim['SALES'] },
      { accountId: acc['1110'], credit: '3000' },
    ]);
    await postJournal('2026-09-20', 'Office cleaning', [
      { accountId: acc['6400'], debit: '5000' },
      { accountId: acc['1110'], credit: '5000' },
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------ definitions

  it('seeds the system definitions per company and lists them', async () => {
    const list = await as(http().get('/api/v1/report-definitions?pageSize=50')).expect(200);
    const codes = list.body.items.map((d: { code: string }) => d.code);
    for (const code of [
      'PL_COMPARATIVE',
      'BUDGET_VS_ACTUAL',
      'BALANCE_SHEET_ASOF',
      'DEPARTMENT_EXPENSES',
    ])
      expect(codes).toContain(code);
    for (const d of list.body.items)
      defs[d.code] = { id: d.id, isSystem: d.isSystem, basis: d.basis };
    expect(defs['PL_COMPARATIVE']!.isSystem).toBe(true);
    expect(defs['BALANCE_SHEET_ASOF']!.basis).toBe('AS_OF');
    // Idempotent: a second list does not duplicate them.
    const again = await as(http().get('/api/v1/report-definitions?pageSize=50')).expect(200);
    expect(again.body.total).toBe(list.body.total);
  });

  it('the comparative income statement matches the standard income statement per column', async () => {
    const report = await run(defs['PL_COMPARATIVE']!.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    }).expect(201);
    const [current, prior, ytd] = await Promise.all([
      as(http().get('/api/v1/reports/income-statement?from=2026-09-01&to=2026-09-30')).expect(200),
      as(http().get('/api/v1/reports/income-statement?from=2026-08-01&to=2026-08-31')).expect(200),
      as(http().get('/api/v1/reports/income-statement?from=2026-01-01&to=2026-09-30')).expect(200),
    ]);
    const columns = report.body.columns.map((c: { key: string; from: string; to: string }) => [
      c.key,
      c.from,
      c.to,
    ]);
    expect(columns).toEqual(
      expect.arrayContaining([
        ['CURRENT', '2026-09-01', '2026-09-30'],
        ['PRIOR', '2026-08-01', '2026-08-31'],
        ['YTD', '2026-01-01', '2026-09-30'],
        ['PRIOR_YEAR', '2025-09-01', '2025-09-30'],
      ]),
    );
    const revenue = rowOf(report.body, 'REVENUE', 'ACCOUNTS')!;
    const netIncome = rowOf(report.body, 'NET_INCOME', 'FORMULA')!;
    const grossProfit = rowOf(report.body, 'GROSS_PROFIT', 'FORMULA')!;
    expect(revenue.values.CURRENT).toBe(current.body.revenue.total);
    expect(revenue.values.PRIOR).toBe(prior.body.revenue.total);
    expect(revenue.values.YTD).toBe(ytd.body.revenue.total);
    expect(netIncome.values.CURRENT).toBe(current.body.netIncome);
    expect(netIncome.values.PRIOR).toBe(prior.body.netIncome);
    expect(netIncome.values.YTD).toBe(ytd.body.netIncome);
    expect(grossProfit.values.CURRENT).toBe(current.body.grossProfit);
    // Variance columns derive from the source columns.
    expect(money(revenue.values.VAR)).toBeCloseTo(
      money(revenue.values.CURRENT) - money(revenue.values.PRIOR),
      3,
    );
    expect(revenue.values.VAR_PCT).toBe(
      (
        ((money(revenue.values.CURRENT) - money(revenue.values.PRIOR)) /
          Math.abs(money(revenue.values.PRIOR))) *
        100
      ).toFixed(2),
    );
    // Rows print in layout order: gross profit after cost of sales, before operating expenses.
    const keys = report.body.rows
      .filter((r: { kind: string }) => r.kind !== 'ACCOUNT')
      .map((r: { key: string }) => r.key);
    expect(keys.indexOf('GROSS_PROFIT')).toBeGreaterThan(keys.indexOf('COST_OF_SALES'));
    expect(keys.indexOf('GROSS_PROFIT')).toBeLessThan(keys.indexOf('OPERATING_EXPENSES'));
    // Account drill-down lines carry the account id for the ledger link.
    const acct4100 = report.body.rows.find(
      (r: { kind: string; accountId?: string }) =>
        r.kind === 'ACCOUNT' && r.accountId === acc['4100'],
    );
    expect(acct4100).toBeTruthy();
    expect(acct4100.level).toBe(1);
  });

  it('budget vs actual reads the approved budget version of the period', async () => {
    const report = await run(defs['BUDGET_VS_ACTUAL']!.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    }).expect(201);
    const opex = rowOf(report.body, 'OPERATING_EXPENSES', 'ACCOUNTS')!;
    const line6400 = report.body.rows.find(
      (r: { kind: string; accountId?: string }) =>
        r.kind === 'ACCOUNT' && r.accountId === acc['6400'],
    );
    expect(line6400.values.BUDGET).toBe('5000.0000'); // seeded OPEX budget, September
    expect(line6400.values.ACTUAL).toBe('8000.0000'); // 3,000 offsite + 5,000 cleaning
    expect(line6400.values.VAR).toBe('3000.0000');
    expect(line6400.values.VAR_PCT).toBe('60.00');
    expect(money(opex.values.BUDGET)).toBeGreaterThanOrEqual(5000);
    // Budget figures never come from the ledger: the revenue budget is what the version says (0 when not budgeted).
    const revenue = rowOf(report.body, 'REVENUE', 'ACCOUNTS')!;
    expect(revenue.values.ACTUAL).toBe('6000.0000');
  });

  it('as-of basis: the balance sheet definition balances at every column', async () => {
    const report = await run(defs['BALANCE_SHEET_ASOF']!.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    }).expect(201);
    const current = report.body.columns.find((c: { key: string }) => c.key === 'CURRENT');
    expect(current.from).toBeNull(); // AS_OF columns read all history up to the date
    expect(current.to).toBe('2026-09-30');
    const check = rowOf(report.body, 'CHECK', 'FORMULA')!;
    for (const key of ['CURRENT', 'PRIOR', 'PRIOR_YEAR']) expect(money(check.values[key])).toBe(0);
    const assets = rowOf(report.body, 'ASSETS', 'ACCOUNTS')!;
    const bs = await as(http().get('/api/v1/reports/balance-sheet?asOf=2026-09-30')).expect(200);
    expect(assets.values.CURRENT).toBe(bs.body.totalAssets);
    const lAndE = rowOf(report.body, 'LIABILITIES_AND_EQUITY', 'FORMULA')!;
    expect(lAndE.values.CURRENT).toBe(bs.body.totalLiabilitiesAndEquity);
  });

  it('dimension groups split a row per department and reconcile to the unallocated remainder', async () => {
    const report = await run(defs['DEPARTMENT_EXPENSES']!.id, {
      from: '2026-09-01',
      to: '2026-09-30',
    }).expect(201);
    const group = rowOf(report.body, 'BY_DEPARTMENT', 'DIMENSION_GROUP')!;
    const sales = report.body.rows.find(
      (r: { kind: string; dimensionId?: string }) =>
        r.kind === 'DIMENSION_VALUE' && r.dimensionId === dim['SALES'],
    );
    expect(sales.values.ACTUAL).toBe('3000.0000');
    const total = rowOf(report.body, 'TOTAL_EXPENSES', 'ACCOUNTS')!;
    const unallocated = rowOf(report.body, 'UNALLOCATED', 'FORMULA')!;
    expect(money(total.values.ACTUAL)).toBeCloseTo(
      money(group.values.ACTUAL) + money(unallocated.values.ACTUAL),
      3,
    );
    expect(money(unallocated.values.ACTUAL)).toBeGreaterThanOrEqual(5000); // cleaning has no department
    // Dimension filter on the run narrows the figures.
    const filtered = await run(defs['DEPARTMENT_EXPENSES']!.id, {
      from: '2026-09-01',
      to: '2026-09-30',
      departmentId: dim['SALES'],
    }).expect(201);
    expect(rowOf(filtered.body, 'TOTAL_EXPENSES', 'ACCOUNTS')!.values.ACTUAL).toBe('3000.0000');
  });

  it('ad-hoc layouts run without saving; validation rejects broken formulas', async () => {
    const layout = {
      rows: [
        {
          key: 'SALES',
          label: 'Sales',
          kind: 'ACCOUNTS',
          accounts: { codes: ['4100'] },
          showAccounts: false,
        },
        { key: 'OPEX', label: 'Opex', kind: 'ACCOUNTS', accounts: { types: ['EXPENSE'] } },
        { key: 'MARGIN', label: 'Margin', kind: 'FORMULA', formula: 'SALES - OPEX', bold: true },
      ],
      columns: [
        { key: 'SEP', label: 'September', kind: 'CURRENT' },
        { key: 'AUG', label: 'August', kind: 'CUSTOM_RANGE', from: '2026-08-01', to: '2026-08-31' },
        { key: 'DIFF', label: 'Change', kind: 'VARIANCE', base: 'SEP', against: 'AUG' },
      ],
    };
    const res = await as(http().post('/api/v1/reports/run'))
      .send({ basis: 'PERIOD', layout, params: { from: '2026-09-01', to: '2026-09-30' } })
      .expect(201);
    const margin = rowOf(res.body, 'MARGIN', 'FORMULA')!;
    expect(rowOf(res.body, 'SALES')!.values.SEP).toBe('6000.0000');
    const aug = money(rowOf(res.body, 'SALES')!.values.AUG); // seeded August sales + 4,000
    expect(aug).toBeGreaterThanOrEqual(4000);
    expect(money(rowOf(res.body, 'SALES')!.values.DIFF)).toBeCloseTo(6000 - aug, 3);
    expect(money(margin.values.SEP)).toBe(6000 - money(rowOf(res.body, 'OPEX')!.values.SEP));

    const broken = await as(http().post('/api/v1/reports/run'))
      .send({
        basis: 'PERIOD',
        layout: {
          ...layout,
          rows: [
            layout.rows[0],
            { key: 'X', label: 'x', kind: 'FORMULA', formula: 'SALES - NOPE' },
          ],
        },
        params: { from: '2026-09-01', to: '2026-09-30' },
      })
      .expect(400);
    expect(JSON.stringify(broken.body)).toMatch(/unknown row NOPE/);
  });

  it('custom definitions: copy a system report, edit the copy, never the original', async () => {
    const copy = await as(
      http().post(`/api/v1/report-definitions/${defs['PL_COMPARATIVE']!.id}/copy`),
      finance,
    )
      .send({ code: 'PL_MGMT', name: 'Management P&L' })
      .expect(201);
    expect(copy.body.isSystem).toBe(false);
    expect(copy.body.category).toBe('CUSTOM');
    const dup = await as(
      http().post(`/api/v1/report-definitions/${defs['PL_COMPARATIVE']!.id}/copy`),
      finance,
    )
      .send({ code: 'PL_MGMT', name: 'Again' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');

    const layout = {
      ...copy.body.layout,
      columns: [{ key: 'CURRENT', label: 'Period', kind: 'CURRENT' }],
    };
    const updated = await as(http().patch(`/api/v1/report-definitions/${copy.body.id}`), finance)
      .send({ layout, description: 'One column' })
      .expect(200);
    expect(updated.body.layout.columns).toHaveLength(1);
    const ran = await run(copy.body.id, { from: '2026-09-01', to: '2026-09-30' }).expect(201);
    expect(ran.body.columns).toHaveLength(1);

    const locked = await as(
      http().patch(`/api/v1/report-definitions/${defs['PL_COMPARATIVE']!.id}`),
      finance,
    )
      .send({ layout })
      .expect(422);
    expect(locked.body.code).toBe('DOCUMENT_INVALID_STATE');

    // Definition changes leave an audit trail.
    const audit = await as(
      http().get(`/api/v1/audit-logs?entityType=ReportDefinition&entityId=${copy.body.id}`),
      auditor,
    ).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'UPDATE']),
    );
  });

  it('permissions: viewers run reports but cannot define them', async () => {
    await run(defs['PL_COMPARATIVE']!.id, { from: '2026-09-01', to: '2026-09-30' }, viewer).expect(
      201,
    );
    await as(http().post('/api/v1/report-definitions'), viewer)
      .send({
        code: 'NOPE',
        name: 'Nope',
        layout: {
          rows: [{ key: 'A', label: 'a', kind: 'HEADER' }],
          columns: [{ key: 'C', label: 'c', kind: 'CURRENT' }],
        },
      })
      .expect(403);
  });

  // ---------------------------------------------------- journal control center

  it('journal control center: filters by source, actor and amount; summary counts the population', async () => {
    const manual = await as(
      http().get(
        '/api/v1/journal-entries?sourceType=MANUAL&from=2026-08-01&to=2026-09-30&pageSize=50',
      ),
    ).expect(200);
    expect(manual.body.total).toBeGreaterThanOrEqual(4);
    for (const je of manual.body.items) expect(je.sourceType).toBeNull();
    const big = await as(
      http().get('/api/v1/journal-entries?minAmount=5000&from=2026-08-01&to=2026-09-30'),
    ).expect(200);
    expect(big.body.items.every((je: { totalDebit: string }) => money(je.totalDebit) >= 5000)).toBe(
      true,
    );
    expect(
      big.body.items.some((je: { description: string }) => je.description === 'September sale'),
    ).toBe(true);
    const me = await http().get('/api/v1/auth/me').set('Cookie', admin).expect(200);
    const mine = await as(
      http().get(
        `/api/v1/journal-entries?createdBy=${me.body.user.id}&from=2026-08-01&to=2026-09-30`,
      ),
    ).expect(200);
    expect(mine.body.total).toBeGreaterThanOrEqual(4);

    const summary = await as(
      http().get('/api/v1/journal-entries/summary?from=2026-08-01&to=2026-09-30'),
    ).expect(200);
    expect(summary.body.total.count).toBeGreaterThanOrEqual(4);
    expect(summary.body.total.manual).toBeGreaterThanOrEqual(4);
    // Seeded journals were created and posted by the seed user; ours were four-eyes (admin -> finance).
    expect(summary.body.total.selfPosted).toBeLessThanOrEqual(summary.body.total.count - 4);
    const posted = summary.body.byStatus.find((s: { status: string }) => s.status === 'POSTED');
    expect(posted.count).toBeGreaterThanOrEqual(4);
    const manualRow = summary.body.bySource.find(
      (s: { sourceType: string }) => s.sourceType === 'MANUAL',
    );
    expect(manualRow.count).toBe(summary.body.total.manual);
  });

  // ------------------------------------------------------------- traceability

  it('trace: journal -> source invoice -> customer -> related journals -> audit trail', async () => {
    const customers = await as(http().get('/api/v1/customers?pageSize=5')).expect(200);
    const customer = customers.body.items[0];
    const invoice = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: customer.id,
        documentDate: '2026-09-21',
        dueDate: '2026-10-21',
        lines: [{ description: 'Traced sale', unitPrice: '1500', accountId: acc['4100'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/submit`)).expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/post`), finance).expect(201);
    const posted = await as(http().get(`/api/v1/invoices/${invoice.body.id}`)).expect(200);
    const journalId = posted.body.journalEntryId as string;
    expect(journalId).toBeTruthy();

    const trace = await as(http().get(`/api/v1/trace/journal/${journalId}`), auditor).expect(200);
    expect(trace.body.journal.id).toBe(journalId);
    expect(trace.body.journal.postedBy.email).toBe(FINANCE.email);
    expect(trace.body.source.sourceType).toBe('AR_DOCUMENT');
    expect(trace.body.source.documentNumber).toBe(posted.body.documentNumber);
    expect(trace.body.source.path).toBe(`/sales/invoices/${invoice.body.id}`);
    expect(trace.body.party.kind).toBe('CUSTOMER');
    expect(trace.body.party.id).toBe(customer.id);
    const auditEntities = trace.body.audit.map((a: { entityType: string }) => a.entityType);
    expect(auditEntities).toContain('JournalEntry');
    expect(auditEntities).toContain('Invoice');
    expect(
      trace.body.audit.some(
        (a: { action: string; entityType: string }) =>
          a.action === 'POST' && a.entityType === 'JournalEntry',
      ),
    ).toBe(true);

    // Void the invoice: the reversal is linked both ways and shares the source.
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/void`), finance)
      .send({ reason: 'Trace test' })
      .expect(201);
    const after = await as(http().get(`/api/v1/trace/journal/${journalId}`), auditor).expect(200);
    const reversal = after.body.related.find(
      (r: { relation: string }) => r.relation === 'REVERSAL',
    );
    expect(reversal).toBeTruthy();
    expect(after.body.journal.status).toBe('REVERSED');
    const fromReversal = await as(
      http().get(`/api/v1/trace/journal/${reversal.id}`),
      auditor,
    ).expect(200);
    expect(fromReversal.body.source.event).toBe('AR_DOCUMENT_VOID');
    expect(fromReversal.body.source.sourceType).toBe('AR_DOCUMENT');
    expect(
      fromReversal.body.related.some(
        (r: { relation: string; id: string }) => r.relation === 'ORIGINAL' && r.id === journalId,
      ),
    ).toBe(true);

    // Reverse direction: every journal of the document.
    const byDoc = await as(http().get(`/api/v1/trace/document/${invoice.body.id}`), auditor).expect(
      200,
    );
    expect(byDoc.body.map((j: { id: string }) => j.id).sort()).toEqual(
      [journalId, reversal.id].sort(),
    );

    // Manual journals trace to no source; viewers are not allowed to see the trail.
    const manual = await as(
      http().get('/api/v1/journal-entries?sourceType=MANUAL&pageSize=1'),
    ).expect(200);
    const manualTrace = await as(
      http().get(`/api/v1/trace/journal/${manual.body.items[0].id}`),
      finance,
    ).expect(200);
    expect(manualTrace.body.source).toBeNull();
    await as(http().get(`/api/v1/trace/journal/${journalId}`), viewer).expect(403);
  });
});
