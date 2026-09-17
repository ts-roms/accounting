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
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'P@ssw0rd123' };
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #10 - Revenue recognition & deferred revenue. Proves the seeded
 * policies / schedules / runs reconcile to the ledger, then drives the full
 * lifecycle through the API: draft-time validation of service windows and
 * milestones, invoice posting that credits deferred revenue and builds the
 * schedule, month-end runs (one journal, dimensions carried), milestone
 * completion, run reversal (latest first), the void guard, reports
 * (rollforward / waterfall / backlog), the financial-close check, the
 * scheduler and the permission boundaries.
 */
describe('Revenue recognition (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let customerId: string;
  const acc: Record<string, string> = {};
  const policies: Record<string, string> = {};
  let ratableInvoiceId: string;
  let ratableScheduleId: string;
  let milestoneInvoiceId: string;
  let milestoneScheduleId: string;
  let septemberRunId: string;

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const glBalance = async (code: string, asOf: string): Promise<string> => {
    const res = await as(
      admin,
      http().get(`/api/v1/general-ledger?accountId=${acc[code]}&from=2026-01-01&to=${asOf}`),
    ).expect(200);
    return res.body.closingBalance as string;
  };
  const journalOf = async (id: string) => {
    const res = await as(admin, http().get(`/api/v1/journal-entries/${id}`)).expect(200);
    return res.body as {
      status: string;
      journalType: string;
      entryDate: string;
      sourceType: string;
      lines: Array<{ accountId: string; debit: string; credit: string; projectId: string | null }>;
    };
  };
  const expectIntegrity = async (asOf: string) => {
    const res = await as(admin, http().get(`/api/v1/revenue/integrity?asOf=${asOf}`)).expect(200);
    for (const check of [
      'DEFERRED_REVENUE_VS_LEDGER',
      'SCHEDULE_TOTALS',
      'RECOGNIZED_WITHOUT_JOURNAL',
    ])
      expect(res.body.findings.find((f: { check: string }) => f.check === check).count).toBe(0);
    return res.body as { status: string; findings: Array<{ check: string; count: number }> };
  };
  const rollforward = async (from: string, to: string) =>
    (
      await as(
        admin,
        http().get(`/api/v1/revenue/reports/rollforward?from=${from}&to=${to}`),
      ).expect(200)
    ).body as {
      opening: string;
      additions: string;
      recognized: string;
      voided: string;
      closing: string;
      ledgerBalance: string;
      difference: string;
      byMethod: Array<{ method: string; closing: string }>;
    };
  const postInvoice = async (body: Record<string, unknown>) => {
    const created = await as(accountant, http().post('/api/v1/invoices'))
      .send({ customerId, ...body })
      .expect(201);
    await as(finance, http().post(`/api/v1/invoices/${created.body.id}/approve`)).expect(201);
    const posted = await as(
      finance,
      http().post(`/api/v1/invoices/${created.body.id}/post`),
    ).expect(201);
    return posted.body as { id: string; documentNumber: string; journalEntryId: string };
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
    finance = await login(FINANCE);
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    for (const a of (await as(admin, http().get('/api/v1/accounts')).expect(200)).body)
      acc[a.code] = a.id;
    const customers = await as(admin, http().get('/api/v1/customers?pageSize=50')).expect(200);
    customerId = customers.body.items.find((c: { code: string }) => c.code === 'CUST-001').id;
    for (const p of (await as(admin, http().get('/api/v1/revenue/policies')).expect(200)).body)
      policies[p.code] = p.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------- seed

  it('seed: policies, schedules and three month-end runs reconcile to the deferred revenue ledger', async () => {
    expect(Object.keys(policies).sort()).toEqual(['MILESTONE', 'POINT', 'RATABLE-SVC']);
    const schedules = await as(viewer, http().get('/api/v1/revenue/schedules')).expect(200);
    expect(schedules.body.total).toBe(2);
    const ratable = schedules.body.items.find((s: { method: string }) => s.method === 'RATABLE');
    expect(ratable.totalAmount).toBe('120000.0000');
    expect(ratable.recognizedAmount).toBe('30246.5755'); // 92 of 365 days
    expect(ratable.remainingAmount).toBe('89753.4245');
    expect(ratable.nextRecognitionDate).toBe('2026-09-30');
    const milestone = schedules.body.items.find(
      (s: { method: string }) => s.method === 'MILESTONE',
    );
    expect(milestone.recognizedAmount).toBe('63000.0000'); // 30% + 40% of 90,000
    const runs = await as(viewer, http().get('/api/v1/revenue/runs')).expect(200);
    expect(runs.body.items.map((r: { periodEnd: string }) => r.periodEnd)).toEqual([
      '2026-08-31',
      '2026-07-31',
      '2026-06-30',
    ]);
    const august = await as(
      viewer,
      http().get(`/api/v1/revenue/runs/${runs.body.items[0].id}`),
    ).expect(200);
    expect(august.body.totalAmount).toBe('46191.7809');
    expect(august.body.lines).toHaveLength(2);
    expect(august.body.journalNumber).toMatch(/^JE-/);

    const rf = await rollforward('2026-06-01', '2026-08-31');
    expect(rf.opening).toBe('0.0000');
    expect(rf.additions).toBe('210000.0000');
    expect(rf.recognized).toBe('93246.5755');
    expect(rf.closing).toBe('116753.4245');
    expect(rf.ledgerBalance).toBe(rf.closing);
    expect(rf.difference).toBe('0.0000');
    expect(await glBalance('2190', '2026-08-31')).toBe('116753.4245');
    const integrity = await expectIntegrity('2026-08-31');
    expect(integrity.status).toBe('OK');
  });

  // ---------------------------------------------------------- configuration

  it('config: settings and policies are data; duplicate codes and terms on non-ratable policies are refused', async () => {
    const settings = await as(finance, http().put('/api/v1/revenue/settings'))
      .send({ overdueGraceDays: 3, defaultPolicyId: policies['POINT'] })
      .expect(200);
    expect(settings.body.overdueGraceDays).toBe(3);
    expect(settings.body.autoRecognize).toBe(false);
    const created = await as(finance, http().post('/api/v1/revenue/policies'))
      .send({
        code: 'RATABLE-6',
        name: 'Six-month retainer',
        method: 'RATABLE',
        defaultTermMonths: 6,
      })
      .expect(201);
    policies['RATABLE-6'] = created.body.id;
    await as(finance, http().post('/api/v1/revenue/policies'))
      .send({ code: 'RATABLE-6', name: 'Again', method: 'RATABLE' })
      .expect(409);
    const bad = await as(finance, http().post('/api/v1/revenue/policies'))
      .send({ code: 'BAD', name: 'Milestone with term', method: 'MILESTONE', defaultTermMonths: 3 })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    await as(viewer, http().post('/api/v1/revenue/policies'))
      .send({ code: 'NOPE', name: 'Viewer', method: 'POINT_IN_TIME' })
      .expect(403);
  });

  // ------------------------------------------------------- invoice posting

  it('invoice: bad service windows and milestone splits are refused when the line is entered', async () => {
    const noEnd = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-09-01',
        lines: [
          {
            description: 'Retainer without an end',
            unitPrice: '1000',
            accountId: acc['4200'],
            revenuePolicyId: policies['MILESTONE'],
            milestones: [{ name: 'Half', percent: '50' }],
          },
        ],
      })
      .expect(422);
    expect(noEnd.body.code).toBe('REVENUE_SCHEDULE_INVALID');
    expect(noEnd.body.message).toContain('not 100');
    const backwards = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-09-01',
        lines: [
          {
            description: 'Backwards window',
            unitPrice: '1000',
            accountId: acc['4200'],
            revenuePolicyId: policies['RATABLE-SVC'],
            serviceStartDate: '2026-10-01',
            serviceEndDate: '2026-09-30',
          },
        ],
      })
      .expect(422);
    expect(backwards.body.code).toBe('REVENUE_SCHEDULE_INVALID');
    const creditNote = await as(accountant, http().post('/api/v1/credit-notes'))
      .send({
        customerId,
        documentType: 'CREDIT_NOTE',
        documentDate: '2026-09-01',
        lines: [
          {
            description: 'Deferred credit note',
            unitPrice: '1000',
            accountId: acc['4200'],
            revenuePolicyId: policies['RATABLE-SVC'],
          },
        ],
      })
      .expect(422);
    expect(creditNote.body.code).toBe('REVENUE_SCHEDULE_INVALID');
  });

  it('invoice: a ratable line credits deferred revenue on posting and gets a day-prorated schedule', async () => {
    const before = await glBalance('2190', '2026-09-30');
    const posted = await postInvoice({
      documentDate: '2026-09-01',
      description: 'Q4 support retainer',
      lines: [
        {
          description: 'Support Sep - Nov 2026',
          unitPrice: '30000',
          accountId: acc['4200'],
          revenuePolicyId: policies['RATABLE-SVC'],
          serviceStartDate: '2026-09-01',
          serviceEndDate: '2026-11-30',
          projectId: null,
        },
        { description: 'Onboarding fee', unitPrice: '5000', accountId: acc['4200'] },
      ],
    });
    ratableInvoiceId = posted.id;
    const entry = await journalOf(posted.journalEntryId);
    expect(entry.status).toBe('POSTED');
    const deferredLine = entry.lines.find((l) => l.accountId === acc['2190']);
    expect(deferredLine?.credit).toBe('30000.0000');
    // The onboarding fee has no policy (the company default is POINT_IN_TIME) and hits revenue directly.
    expect(entry.lines.find((l) => l.accountId === acc['4200'])?.credit).toBe('5000.0000');
    expect(await glBalance('2190', '2026-09-30')).toBe((Number(before) + 30000).toFixed(4));

    const schedules = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules?invoiceId=${ratableInvoiceId}`),
    ).expect(200);
    expect(schedules.body.total).toBe(1);
    ratableScheduleId = schedules.body.items[0].id;
    const detail = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${ratableScheduleId}`),
    ).expect(200);
    expect(detail.body.documentNumber).toBe(posted.documentNumber);
    expect(detail.body.policyCode).toBe('RATABLE-SVC');
    expect(
      detail.body.lines.map((l: { recognitionDate: string; amount: string }) => [
        l.recognitionDate,
        l.amount,
      ]),
    ).toEqual([
      ['2026-09-30', '9890.1099'], // 30 of 91 days (+ the rounding minor unit)
      ['2026-10-31', '10219.7803'],
      ['2026-11-30', '9890.1098'],
    ]);
    await expectIntegrity('2026-09-30');
  });

  it('invoice: a milestone line defers the full amount; milestones only fall due once completed', async () => {
    const posted = await postInvoice({
      documentDate: '2026-09-05',
      description: 'Warehouse rollout',
      lines: [
        {
          description: 'Warehouse rollout project',
          unitPrice: '60000',
          accountId: acc['4200'],
          revenuePolicyId: policies['MILESTONE'],
          milestones: [
            { name: 'Design', percent: '25', expectedDate: '2026-09-20' },
            { name: 'Build', percent: '50', expectedDate: '2026-11-15' },
            { name: 'Handover', percent: '25', expectedDate: '2026-12-20' },
          ],
        },
      ],
    });
    milestoneInvoiceId = posted.id;
    const schedules = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules?invoiceId=${milestoneInvoiceId}`),
    ).expect(200);
    milestoneScheduleId = schedules.body.items[0].id;
    const detail = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${milestoneScheduleId}`),
    ).expect(200);
    expect(
      detail.body.lines.map((l: { milestoneName: string; amount: string }) => [
        l.milestoneName,
        l.amount,
      ]),
    ).toEqual([
      ['Design', '15000.0000'],
      ['Build', '30000.0000'],
      ['Handover', '15000.0000'],
    ]);
    // Nothing is due yet: expected dates alone never trigger recognition.
    const preview = await as(
      viewer,
      http().get('/api/v1/revenue/runs/preview?periodEnd=2026-09-30'),
    ).expect(200);
    expect(preview.body.lines).toBe(2); // seeded September instalment + the new ratable September line
    expect(preview.body.amount).toBe('19753.1236');

    const design = detail.body.lines[0];
    const completed = await as(
      finance,
      http().post(`/api/v1/revenue/schedules/${milestoneScheduleId}/lines/${design.id}/complete`),
    )
      .send({ completedOn: '2026-09-18', note: 'Design signed off' })
      .expect(200);
    expect(completed.body.lines[0].completedAt).toBeTruthy();
    expect(completed.body.lines[0].recognitionDate).toBe('2026-09-18');
    await as(
      finance,
      http().post(`/api/v1/revenue/schedules/${milestoneScheduleId}/lines/${design.id}/complete`),
    )
      .send({})
      .expect(422);
    const after = await as(
      viewer,
      http().get('/api/v1/revenue/runs/preview?periodEnd=2026-09-30'),
    ).expect(200);
    expect(after.body.lines).toBe(3);
    expect(after.body.amount).toBe('34753.1236');
  });

  // ------------------------------------------------------------------- runs

  it('run: one adjusting journal recognizes every due line; schedules and the ledger follow', async () => {
    await as(viewer, http().post('/api/v1/revenue/runs'))
      .send({ periodEnd: '2026-09-30' })
      .expect(403);
    await as(accountant, http().post('/api/v1/revenue/runs'))
      .send({ periodEnd: '2026-09-30' })
      .expect(403);
    const run = await as(finance, http().post('/api/v1/revenue/runs'))
      .send({ periodEnd: '2026-09-30', description: 'September close' })
      .expect(201);
    septemberRunId = run.body.id;
    expect(run.body.documentNumber).toBe('RRN-2026-000004');
    expect(run.body.lineCount).toBe(3);
    expect(run.body.totalAmount).toBe('34753.1236');
    expect(run.body.status).toBe('POSTED');
    const entry = await journalOf(run.body.journalEntryId);
    expect(entry.journalType).toBe('ADJUSTING');
    expect(entry.entryDate).toBe('2026-09-30');
    expect(entry.sourceType).toBe('REVENUE_RECOGNITION_RUN');
    expect(entry.lines).toHaveLength(6);
    const deferredDebits = entry.lines
      .filter((l) => l.accountId === acc['2190'])
      .reduce((n, l) => n + Number(l.debit), 0);
    expect(deferredDebits.toFixed(4)).toBe('34753.1236');

    const ratable = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${ratableScheduleId}`),
    ).expect(200);
    expect(ratable.body.recognizedAmount).toBe('9890.1099');
    expect(ratable.body.lines[0].status).toBe('RECOGNIZED');
    expect(ratable.body.lines[0].runNumber).toBe('RRN-2026-000004');
    expect(ratable.body.lines[1].status).toBe('PENDING');
    const milestone = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${milestoneScheduleId}`),
    ).expect(200);
    expect(milestone.body.recognizedAmount).toBe('15000.0000');
    expect(milestone.body.status).toBe('ACTIVE');

    // Nothing left for the same period: a second run is a no-op, not a duplicate.
    const again = await as(finance, http().post('/api/v1/revenue/runs'))
      .send({ periodEnd: '2026-09-30' })
      .expect(201);
    expect(again.body.run).toBeNull();

    const rf = await rollforward('2026-09-01', '2026-09-30');
    expect(rf.opening).toBe('116753.4245');
    expect(rf.additions).toBe('90000.0000');
    expect(rf.recognized).toBe('34753.1236');
    expect(rf.closing).toBe('172000.3009');
    expect(rf.difference).toBe('0.0000');
    expect(rf.byMethod.map((m) => m.method)).toEqual(['MILESTONE', 'RATABLE']);
    await expectIntegrity('2026-09-30');
  });

  it('reports: the waterfall buckets pending lines by month and the backlog groups them by customer', async () => {
    const wf = await as(
      viewer,
      http().get('/api/v1/revenue/reports/waterfall?from=2026-10-01&months=3'),
    ).expect(200);
    expect(wf.body.buckets.map((b: { month: string }) => b.month)).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
    ]);
    // October: seeded 10,191.7809 + new ratable 10,219.7803 + the seeded Go-live milestone expected 10-15.
    expect(wf.body.buckets[0].amount).toBe('47411.5612');
    expect(wf.body.buckets[1].amount).toBe('49753.1235'); // 9,863.0137 + 9,890.1098 + Build 30,000 (expected)
    expect(wf.body.buckets[2].amount).toBe('25191.7808'); // 10,191.7808 + Handover 15,000
    expect(wf.body.unscheduled).toBe('0.0000');
    expect(Number(wf.body.beyond)).toBeGreaterThan(0);
    expect(wf.body.total).toBe('172000.3009');
    expect(wf.body.byCustomer.length).toBeGreaterThanOrEqual(3);

    const backlog = await as(
      viewer,
      http().get('/api/v1/revenue/reports/backlog?asOf=2026-09-30'),
    ).expect(200);
    expect(backlog.body.totals.deferred).toBe('172000.3009');
    expect(backlog.body.totals.overdue).toBe('0.0000');
    expect(backlog.body.totals.schedules).toBe(4);
    const cust1 = backlog.body.rows.find(
      (r: { customerCode: string }) => r.customerCode === 'CUST-001',
    );
    expect(cust1.schedules).toBe(2);
    expect(cust1.deferred).toBe('65109.8901'); // 20,109.8901 ratable + 45,000 milestones
  });

  it('close: the financial close checklist flags due deferred revenue until a run posts it', async () => {
    const years = await as(admin, http().get('/api/v1/fiscal-years')).expect(200);
    const october = years.body[0].periods.find(
      (p: { startDate: string }) => p.startDate === '2026-10-01',
    );
    const close = await as(finance, http().post('/api/v1/financial-closes'))
      .send({ fiscalPeriodId: october.id })
      .expect(201);
    const task = close.body.tasks.find((t: { key: string }) => t.key === 'REVENUE_RECOGNITION');
    expect(task.status).not.toBe('DONE');
    expect(task.detail.pendingLines).toBe(2);
    await as(finance, http().post('/api/v1/revenue/runs'))
      .send({ periodEnd: '2026-10-31' })
      .expect(201);
    const refreshed = await as(
      finance,
      http().post(`/api/v1/financial-closes/${close.body.id}/refresh`),
    ).expect(201);
    expect(
      refreshed.body.tasks.find((t: { key: string }) => t.key === 'REVENUE_RECOGNITION').status,
    ).toBe('DONE');
  });

  it('reverse: runs unwind latest first, re-open their lines and mirror the journal; then the void guard lifts', async () => {
    const blocked = await as(finance, http().post(`/api/v1/revenue/runs/${septemberRunId}/reverse`))
      .send({ reason: 'Out of order' })
      .expect(422);
    expect(blocked.body.code).toBe('REVENUE_RUN_INVALID_STATE');
    const voidBlocked = await as(admin, http().post(`/api/v1/invoices/${ratableInvoiceId}/void`))
      .send({ reason: 'Customer cancelled' })
      .expect(422);
    expect(voidBlocked.body.code).toBe('REVENUE_RECOGNIZED');

    const runs = await as(viewer, http().get('/api/v1/revenue/runs?status=POSTED')).expect(200);
    const october = runs.body.items.find(
      (r: { periodEnd: string }) => r.periodEnd === '2026-10-31',
    );
    const reversedOct = await as(finance, http().post(`/api/v1/revenue/runs/${october.id}/reverse`))
      .send({ reason: 'October re-run after contract change' })
      .expect(200);
    expect(reversedOct.body.status).toBe('REVERSED');
    expect(reversedOct.body.reversalJournalNumber).toMatch(/^JE-/);
    const reversedSep = await as(
      finance,
      http().post(`/api/v1/revenue/runs/${septemberRunId}/reverse`),
    )
      .send({ reason: 'September re-run' })
      .expect(200);
    expect(reversedSep.body.status).toBe('REVERSED');
    const original = await journalOf(reversedSep.body.journalEntryId);
    expect(original.status).toBe('REVERSED');
    const ratable = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${ratableScheduleId}`),
    ).expect(200);
    expect(ratable.body.recognizedAmount).toBe('0.0000');
    expect(ratable.body.lines.every((l: { status: string }) => l.status === 'PENDING')).toBe(true);
    await expectIntegrity('2026-10-31');

    const voided = await as(admin, http().post(`/api/v1/invoices/${ratableInvoiceId}/void`))
      .send({ reason: 'Customer cancelled', reversalDate: '2026-09-30' })
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    const cancelled = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${ratableScheduleId}`),
    ).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.lines.every((l: { status: string }) => l.status === 'CANCELLED')).toBe(
      true,
    );
    const rf = await rollforward('2026-09-01', '2026-09-30');
    expect(rf.voided).toBe('30000.0000');
    expect(rf.difference).toBe('0.0000');
    await expectIntegrity('2026-09-30');
  });

  it('scheduler: automatic recognition posts only for companies that opted in, and only auto policies', async () => {
    const nothing = await as(
      finance,
      http().post('/api/v1/revenue/recognize-now?asOf=2026-10-31'),
    ).expect(200);
    expect(nothing.body.runs).toBe(0);
    await as(finance, http().patch(`/api/v1/revenue/policies/${policies['MILESTONE']}`))
      .send({ autoRecognize: false })
      .expect(200);
    await as(finance, http().put('/api/v1/revenue/settings'))
      .send({ autoRecognize: true })
      .expect(200);
    const posted = await as(
      finance,
      http().post('/api/v1/revenue/recognize-now?asOf=2026-10-31'),
    ).expect(200);
    expect(posted.body.runs).toBe(1);
    const runs = await as(viewer, http().get('/api/v1/revenue/runs?status=POSTED')).expect(200);
    const auto = runs.body.items.find((r: { periodEnd: string }) => r.periodEnd === '2026-10-31');
    expect(auto.createdBy).toBeNull();
    expect(auto.description).toBe('Automatic month-end recognition');
    // Only the ratable (auto) lines: seeded Sep + Oct instalments, the milestone stays pending.
    expect(auto.lineCount).toBe(2);
    expect(auto.totalAmount).toBe('20054.7946');
    const milestone = await as(
      viewer,
      http().get(`/api/v1/revenue/schedules/${milestoneScheduleId}`),
    ).expect(200);
    expect(milestone.body.recognizedAmount).toBe('0.0000');
    const integrity = await expectIntegrity('2026-10-31');
    expect(integrity.findings.find((f) => f.check === 'OVERDUE_RECOGNITION')?.count).toBe(1); // the completed Design milestone
  });
});
