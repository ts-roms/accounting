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

// Seeded head-office lease: 36 x 45,000 in advance at 8% from 2026-05-01.
const OFFICE_PV = '1445604.7896';
const OFFICE_LIABILITY_AUG = '1301521.3948'; // after four instalments and four runs
const OFFICE_ACCUMULATED_AUG = '160622.7544'; // 4 x 40,155.6886
const OFFICE_DEPRECIATION = '40155.6886';
const OFFICE_INTEREST_SEP = '8376.8093';

/**
 * Prompt #13 - Lease accounting & fixed-asset extensions. Proves the seeded
 * register agrees with the ledger, then drives the lifecycle: settings and
 * contracts as data, the schedule preview, commencement (Dr right-of-use /
 * Cr liability), the September lease run (interest + depreciation in one
 * journal), an in-advance instalment paid from the bank, reversal order,
 * remeasurement, termination with its gain, exempt leases expensed as paid,
 * the reports, the treasury forecast source, the close check, the job, the
 * asset split and the register rollforward, and the permission boundaries.
 */
describe('Leases (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  let bdo: string;
  let lessorId: string;
  let officeId: string;
  let forkliftId: string;
  let vanId: string;
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
      entryDate: string;
      sourceType: string;
      journalType: string;
      lines: Array<{ accountId: string; debit: string; credit: string }>;
    };
  };
  const sumOn = (
    entry: { lines: Array<{ accountId: string; debit: string; credit: string }> },
    code: string,
    side: 'debit' | 'credit',
  ) =>
    entry.lines
      .filter((l) => l.accountId === acc[code])
      .reduce((n, l) => n + Number(l[side]), 0)
      .toFixed(4);
  const integrity = async (asOf: string, clean = true) => {
    const res = await as(admin, http().get(`/api/v1/leases/integrity?asOf=${asOf}`)).expect(200);
    if (clean)
      for (const check of [
        'LEASE_LIABILITY_VS_LEDGER',
        'ROU_ASSET_VS_LEDGER',
        'LEASE_SCHEDULE_TOTALS',
      ])
        expect(res.body.findings.find((f: { check: string }) => f.check === check).count).toBe(0);
    return res.body as { status: string; findings: Array<{ check: string; count: number }> };
  };
  const lease = async (id: string) =>
    (await as(admin, http().get(`/api/v1/leases/${id}`)).expect(200)).body as {
      status: string;
      classification: string;
      liabilityBalance: string;
      rouCost: string;
      rouAccumulatedDepreciation: string;
      rouCarrying: string;
      termMonths: number;
      paymentAmount: string;
      commencementJournalEntryId: string | null;
      terminationJournalEntryId: string | null;
      terminationGainLoss: string | null;
      lines: Array<{
        id: string;
        sequence: number;
        status: string;
        payment: string;
        paymentDate: string | null;
        periodEnd: string;
        interest: string;
        depreciation: string;
        closingLiability: string;
        paidAt: string | null;
        runId: string | null;
      }>;
      events: Array<{ eventType: string; journalEntryId: string | null }>;
      nextPayment: { lineId: string; date: string; amount: string } | null;
      preview: { initialLiability: string; lines: unknown[] } | null;
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
    const banks = await as(admin, http().get('/api/v1/bank-accounts')).expect(200);
    bdo = (banks.body.items ?? banks.body).find((b: { code: string }) => b.code === 'BDO-MAIN').id;
    const vendors = await as(admin, http().get('/api/v1/vendors?search=Butuan Realty')).expect(200);
    lessorId = vendors.body.items[0].id;
    const list = await as(admin, http().get('/api/v1/leases?pageSize=50')).expect(200);
    const byNumber = (n: string) =>
      list.body.items.find((l: { leaseNumber: string }) => l.leaseNumber === n).id;
    officeId = byNumber('LSE-2026-000001');
    forkliftId = byNumber('LSE-2026-000002');
    vanId = byNumber('LSE-2026-000003');
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------- seed

  it('seed: the register agrees with the ledger and the schedule', async () => {
    const office = await lease(officeId);
    expect(office.status).toBe('ACTIVE');
    expect(office.classification).toBe('FINANCE');
    expect(office.rouCost).toBe(OFFICE_PV);
    expect(office.liabilityBalance).toBe(OFFICE_LIABILITY_AUG);
    expect(office.rouAccumulatedDepreciation).toBe(OFFICE_ACCUMULATED_AUG);
    expect(office.lines).toHaveLength(36);
    expect(office.lines.filter((l) => l.status === 'POSTED')).toHaveLength(4);
    expect(office.lines.filter((l) => l.paidAt)).toHaveLength(4);
    expect(office.nextPayment).toMatchObject({ date: '2026-09-01', amount: '45000.0000' });
    expect(office.lines[35]!.closingLiability).toBe('0.0000');
    // Ledger: liability, ROU cost, accumulated depreciation and the four months of interest / depreciation.
    expect(await glBalance('2220', '2026-08-31')).toBe(OFFICE_LIABILITY_AUG);
    expect(await glBalance('1530', '2026-08-31')).toBe(OFFICE_PV);
    expect(await glBalance('1540', '2026-08-31')).toBe(OFFICE_ACCUMULATED_AUG);
    expect(await glBalance('8110', '2026-08-31')).toBe('35916.6052'); // 9,337.3653 + 9,099.6144 + 8,860.2785 + 8,619.3470
    expect(await glBalance('6210', '2026-09-30')).toBe('32000.0000'); // forklift June - September
    const runs = await as(finance, http().get('/api/v1/leases/runs')).expect(200);
    expect(runs.body.items.map((r: { periodEnd: string }) => r.periodEnd)).toEqual([
      '2026-08-31',
      '2026-07-31',
      '2026-06-30',
      '2026-05-31',
    ]);
    const forklift = await lease(forkliftId);
    expect(forklift.classification).toBe('SHORT_TERM');
    expect(forklift.liabilityBalance).toBe('0.0000');
    expect(forklift.lines.filter((l) => l.status === 'POSTED')).toHaveLength(4);
    const van = await lease(vanId);
    expect(van.status).toBe('DRAFT');
    expect(van.preview!.initialLiability).toBe('394004.6305');
    const report = await integrity('2026-09-17', true);
    expect(report.findings.find((f) => f.check === 'LEASE_PAYMENTS_OVERDUE')!.count).toBe(1); // September instalment of the office lease
    expect(report.findings.find((f) => f.check === 'LEASE_RUNS_OVERDUE')!.count).toBe(0);
  });

  // -------------------------------------------------------------- lifecycle

  it('september: the run posts interest and depreciation in one journal, the instalment settles the liability, reversal order holds', async () => {
    const preview = await as(
      finance,
      http().get('/api/v1/leases/runs/preview?periodEnd=2026-09-30'),
    ).expect(200);
    expect(preview.body.lines).toBe(1);
    expect(preview.body.interest).toBe(OFFICE_INTEREST_SEP);
    expect(preview.body.depreciation).toBe(OFFICE_DEPRECIATION);

    // Pay the September instalment first (in advance, before the run).
    const office = await lease(officeId);
    const paid = await as(finance, http().post(`/api/v1/leases/${officeId}/pay`))
      .send({
        lineId: office.nextPayment!.lineId,
        bankAccountId: bdo,
        paymentDate: '2026-09-01',
        memo: 'September rent',
      })
      .expect(200);
    const line5 = paid.body.lines.find((l: { sequence: number }) => l.sequence === 5);
    expect(line5.paidAt).toBeTruthy();
    const paymentJe = await journalOf(line5.paymentJournalEntryId);
    expect(paymentJe.sourceType).toBe('LEASE_PAYMENT');
    expect(sumOn(paymentJe, '2220', 'debit')).toBe('45000.0000');
    expect(sumOn(paymentJe, '1130', 'credit')).toBe('45000.0000');
    expect(paid.body.liabilityBalance).toBe('1256521.3948');
    // Schedule order: month 7 cannot be paid before month 6.
    const line7 = paid.body.lines.find((l: { sequence: number }) => l.sequence === 7);
    const outOfOrder = await as(finance, http().post(`/api/v1/leases/${officeId}/pay`))
      .send({ lineId: line7.id, bankAccountId: bdo, paymentDate: '2026-09-02' })
      .expect(422);
    expect(outOfOrder.body.code).toBe('LEASE_SCHEDULE_INVALID');

    const run = await as(finance, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-09-30', description: 'September close' })
      .expect(201);
    septemberRunId = run.body.id;
    expect(run.body.documentNumber).toMatch(/^LRN-2026-\d{6}$/);
    expect(run.body.status).toBe('POSTED');
    expect(run.body.interestTotal).toBe(OFFICE_INTEREST_SEP);
    expect(run.body.depreciationTotal).toBe(OFFICE_DEPRECIATION);
    expect(run.body.lines).toHaveLength(1);
    const je = await journalOf(run.body.journalEntryId);
    expect(je.status).toBe('POSTED');
    expect(je.journalType).toBe('ADJUSTING');
    expect(je.sourceType).toBe('LEASE_RUN');
    expect(je.entryDate).toBe('2026-09-30');
    expect(sumOn(je, '8110', 'debit')).toBe(OFFICE_INTEREST_SEP);
    expect(sumOn(je, '2220', 'credit')).toBe(OFFICE_INTEREST_SEP);
    expect(sumOn(je, '6500', 'debit')).toBe(OFFICE_DEPRECIATION);
    expect(sumOn(je, '1540', 'credit')).toBe(OFFICE_DEPRECIATION);
    const after = await lease(officeId);
    expect(after.liabilityBalance).toBe('1264898.2041'); // schedule closing of month 5
    expect(after.lines.find((l) => l.sequence === 5)!.runId).toBe(septemberRunId);
    expect(await glBalance('2220', '2026-09-30')).toBe('1264898.2041');
    await integrity('2026-09-30');

    // Nothing more is due: a second run for the same period end posts nothing.
    const empty = await as(finance, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-09-30' })
      .expect(201);
    expect(empty.body.run).toBeNull();

    // Reverse and re-post: mirror journal, months reopened, register restored.
    const reversed = await as(finance, http().post(`/api/v1/leases/runs/${septemberRunId}/reverse`))
      .send({ reason: 'Re-run with the audited rate' })
      .expect(200);
    expect(reversed.body.status).toBe('REVERSED');
    expect(reversed.body.reversalJournalEntryId).toBeTruthy();
    expect((await lease(officeId)).liabilityBalance).toBe('1256521.3948');
    expect(await glBalance('2220', '2026-09-30')).toBe('1256521.3948');
    await integrity('2026-09-30');
    const again = await as(finance, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-09-30' })
      .expect(201);
    septemberRunId = again.body.id;
    expect(again.body.interestTotal).toBe(OFFICE_INTEREST_SEP);
    await integrity('2026-09-30');
  });

  it('contract: settings, preview, create, commence (Dr ROU / Cr liability), in-arrears payment needs its run', async () => {
    const settings = await as(accountant, http().put('/api/v1/leases/settings'))
      .send({ lowValueThreshold: '250000', defaultDiscountRate: '8' })
      .expect(200);
    expect(settings.body.shortTermThresholdMonths).toBe(12);
    const preview = await as(accountant, http().post('/api/v1/leases/preview'))
      .send({
        commencementDate: '2026-10-01',
        termMonths: 24,
        paymentAmount: '18000',
        paymentTiming: 'IN_ARREARS',
        annualDiscountRate: '9',
      })
      .expect(200);
    expect(preview.body.initialLiability).toBe('394004.6305');
    expect(preview.body.lines).toHaveLength(24);

    // The seeded draft van: commence it with initial direct costs paid from the bank.
    await as(accountant, http().patch(`/api/v1/leases/${vanId}`))
      .send({ vendorId: lessorId, initialDirectCosts: '6000', location: 'Butuan depot' })
      .expect(200);
    const badTerm = await as(accountant, http().patch(`/api/v1/leases/${vanId}`))
      .send({ paymentFrequency: 'QUARTERLY', termMonths: 25 })
      .expect(422);
    expect(badTerm.body.code).toBe('LEASE_SCHEDULE_INVALID');
    const commenced = await as(finance, http().post(`/api/v1/leases/${vanId}/commence`))
      .send({ clearingAccountId: acc['1130'] })
      .expect(200);
    expect(commenced.body.status).toBe('ACTIVE');
    expect(commenced.body.classification).toBe('FINANCE');
    expect(commenced.body.liabilityBalance).toBe('394004.6305');
    expect(commenced.body.rouCost).toBe('400004.6305'); // PV + 6,000 initial direct costs
    const je = await journalOf(commenced.body.commencementJournalEntryId);
    expect(je.sourceType).toBe('LEASE_COMMENCEMENT');
    expect(sumOn(je, '1530', 'debit')).toBe('400004.6305');
    expect(sumOn(je, '2220', 'credit')).toBe('394004.6305');
    expect(sumOn(je, '1130', 'credit')).toBe('6000.0000');
    // Terms are frozen once commenced.
    const frozen = await as(accountant, http().patch(`/api/v1/leases/${vanId}`))
      .send({ paymentAmount: '19000' })
      .expect(422);
    expect(frozen.body.code).toBe('LEASE_INVALID_STATE');
    // In arrears: the October instalment cannot be paid before the October run.
    const van = await lease(vanId);
    const october = van.lines.find((l) => l.sequence === 1)!;
    expect(october.paymentDate).toBe('2026-10-31');
    const early = await as(finance, http().post(`/api/v1/leases/${vanId}/pay`))
      .send({ lineId: october.id, bankAccountId: bdo, paymentDate: '2026-10-31' })
      .expect(422);
    expect(early.body.code).toBe('LEASE_SCHEDULE_INVALID');
    const run = await as(finance, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-10-31', leaseIds: [vanId] })
      .expect(201);
    expect(run.body.leaseCount).toBe(1);
    expect(run.body.interestTotal).toBe('2955.0347');
    const paid = await as(finance, http().post(`/api/v1/leases/${vanId}/pay`))
      .send({ lineId: october.id, bankAccountId: bdo, paymentDate: '2026-10-31' })
      .expect(200);
    expect(paid.body.liabilityBalance).toBe('378959.6652'); // schedule closing of month 1
    await integrity('2026-10-31');
  });

  it('remeasurement re-discounts the remaining payments and adjusts the right-of-use asset; termination books the gain', async () => {
    const before = await lease(vanId);
    const carryingBefore = Number(before.rouCarrying);
    const notAtBoundary = await as(finance, http().post(`/api/v1/leases/${vanId}/remeasure`))
      .send({ effectiveDate: '2026-11-15', paymentAmount: '20000' })
      .expect(422);
    expect(notAtBoundary.body.code).toBe('LEASE_SCHEDULE_INVALID');
    const remeasured = await as(finance, http().post(`/api/v1/leases/${vanId}/remeasure`))
      .send({ effectiveDate: '2026-11-01', paymentAmount: '20000', notes: 'Rent review' })
      .expect(200);
    expect(remeasured.body.paymentAmount).toBe('20000.0000');
    // 23 x 20,000 in arrears at 9% from 2026-11-01.
    const remaining = remeasured.body.lines.filter(
      (l: { status: string }) => l.status !== 'CANCELLED',
    );
    expect(remaining).toHaveLength(24);
    expect(
      remeasured.body.lines.filter((l: { status: string }) => l.status === 'CANCELLED'),
    ).toHaveLength(23);
    const newLiability = Number(remeasured.body.liabilityBalance);
    const delta = newLiability - Number(before.liabilityBalance);
    expect(delta).toBeGreaterThan(0);
    expect(Number(remeasured.body.rouCarrying)).toBeCloseTo(carryingBefore + delta, 3);
    const event = remeasured.body.events.find(
      (e: { eventType: string }) => e.eventType === 'REMEASUREMENT',
    );
    const je = await journalOf(event.journalEntryId);
    expect(je.sourceType).toBe('LEASE_REMEASUREMENT');
    expect(Number(sumOn(je, '1530', 'debit'))).toBeCloseTo(delta, 3);
    expect(Number(sumOn(je, '2220', 'credit'))).toBeCloseTo(delta, 3);
    expect(remaining[remaining.length - 1].closingLiability).toBe('0.0000');
    await integrity('2026-11-01');

    // Terminate early: liability released vs carrying amount -> gain / loss on disposal.
    const terminated = await as(finance, http().post(`/api/v1/leases/${vanId}/terminate`))
      .send({ terminationDate: '2026-11-30', notes: 'Vehicle returned' })
      .expect(200);
    expect(terminated.body.status).toBe('TERMINATED');
    expect(terminated.body.liabilityBalance).toBe('0.0000');
    expect(terminated.body.rouCost).toBe('0.0000');
    const gainLoss = Number(terminated.body.terminationGainLoss);
    const tje = await journalOf(terminated.body.terminationJournalEntryId);
    expect(tje.sourceType).toBe('LEASE_TERMINATION');
    expect(Number(sumOn(tje, '2220', 'debit'))).toBeCloseTo(newLiability, 3);
    expect(Number(sumOn(tje, '1530', 'credit'))).toBeCloseTo(Number(remeasured.body.rouCost), 3);
    expect(Number(sumOn(tje, '4920', gainLoss >= 0 ? 'credit' : 'debit'))).toBeCloseTo(
      Math.abs(gainLoss),
      3,
    );
    expect(
      terminated.body.lines.filter((l: { status: string }) => l.status === 'PENDING'),
    ).toHaveLength(0);
    expect(await glBalance('2220', '2026-11-30')).toBe('1264898.2041'); // only the office lease remains
    await integrity('2026-11-30');
    const closed = await as(finance, http().post(`/api/v1/leases/${vanId}/pay`))
      .send({ lineId: before.lines[2]!.id, bankAccountId: bdo, paymentDate: '2026-12-31' })
      .expect(422);
    expect(closed.body.code).toBe('LEASE_INVALID_STATE');
  });

  it('exempt lease: payments are expensed as paid, no liability, completion when the last instalment is paid', async () => {
    const created = await as(accountant, http().post('/api/v1/leases'))
      .send({
        name: 'Trade-show booth hire',
        commencementDate: '2026-10-01',
        termMonths: 3,
        paymentAmount: '12000',
        annualDiscountRate: '8',
        bankAccountId: bdo,
      })
      .expect(201);
    expect(created.body.leaseNumber).toMatch(/^LSE-2026-\d{6}$/);
    expect(created.body.classification).toBe('SHORT_TERM');
    expect(created.body.preview.initialLiability).toBe('0.0000');
    const commenced = await as(finance, http().post(`/api/v1/leases/${created.body.id}/commence`))
      .send({})
      .expect(200);
    expect(commenced.body.commencementJournalEntryId).toBeNull();
    expect(commenced.body.lines).toHaveLength(3);
    const expenseBefore = Number(await glBalance('6210', '2026-12-31'));
    for (const line of commenced.body.lines as Array<{ id: string; paymentDate: string }>) {
      const paid = await as(finance, http().post(`/api/v1/leases/${created.body.id}/pay`))
        .send({ lineId: line.id, bankAccountId: bdo, paymentDate: line.paymentDate })
        .expect(200);
      expect(paid.body.liabilityBalance).toBe('0.0000');
    }
    expect(Number(await glBalance('6210', '2026-12-31'))).toBeCloseTo(expenseBefore + 36000, 3);
    expect((await lease(created.body.id)).status).toBe('COMPLETED');
    const removeDone = await as(
      accountant,
      http().delete(`/api/v1/leases/${created.body.id}`),
    ).expect(422);
    expect(removeDone.body.code).toBe('LEASE_INVALID_STATE');
  });

  // ---------------------------------------------------------------- reports

  it('reports: register, maturity split, dashboard, forecast source, close check and the job', async () => {
    const register = await as(viewer, http().get('/api/v1/leases/reports/register')).expect(200);
    const office = register.body.rows.find(
      (r: { leaseNumber: string }) => r.leaseNumber === 'LSE-2026-000001',
    );
    expect(office.endDate).toBe('2029-04-30');
    expect(office.liabilityBalance).toBe('1264898.2041');
    expect(register.body.totals.finance).toBe(1);
    expect(register.body.totals.liability).toBe('1264898.2041');
    const maturity = await as(
      viewer,
      http().get('/api/v1/leases/reports/maturity?asOf=2026-09-30&years=3'),
    ).expect(200);
    expect(maturity.body.buckets).toHaveLength(4);
    expect(maturity.body.buckets[0].amount).toBe('556000.0000'); // 12 x 45,000 (office) + 2 x 8,000 (forklift) due Oct 2026 - Sep 2027
    expect(maturity.body.liability).toBe('1264898.2041');
    expect(
      Number(maturity.body.currentPortion) + Number(maturity.body.nonCurrentPortion),
    ).toBeCloseTo(1264898.2041, 3);
    // Principal due within a year: 540,000 of instalments less the interest they carry.
    expect(Number(maturity.body.currentPortion)).toBeGreaterThan(400000);
    expect(Number(maturity.body.currentPortion)).toBeLessThan(540000);
    expect(Number(maturity.body.unaccruedInterest)).toBeGreaterThan(0);
    const dashboard = await as(
      viewer,
      http().get('/api/v1/leases/dashboard?asOf=2026-09-30'),
    ).expect(200);
    expect(dashboard.body.activeLeases).toBe(2);
    expect(dashboard.body.liability).toBe('1264898.2041');
    expect(dashboard.body.integrity.findings).toHaveLength(5);

    const forecast = await as(
      finance,
      http().get('/api/v1/treasury/forecast?asOf=2026-10-01&horizonDays=60'),
    ).expect(200);
    const source = forecast.body.bySource.find(
      (s: { source: string }) => s.source === 'LEASE_PAYMENTS',
    );
    expect(source).toBeTruthy();
    expect(Number(source.outflow ?? source.amount ?? source.total)).toBeGreaterThanOrEqual(90000);

    // Close check: October's month is not yet run for the office lease.
    const years = await as(admin, http().get('/api/v1/fiscal-years')).expect(200);
    const october = years.body[0].periods.find(
      (p: { startDate: string }) => p.startDate === '2026-10-01',
    );
    const close = await as(finance, http().post('/api/v1/financial-closes'))
      .send({ fiscalPeriodId: october.id })
      .expect(201);
    const task = close.body.tasks.find((t: { key: string }) => t.key === 'LEASE_RUNS_POSTED');
    expect(task.status).not.toBe('DONE');
    expect(task.detail.pendingMonths).toBe(1);
    await as(finance, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-10-31' })
      .expect(201);
    const refreshed = await as(
      finance,
      http().post(`/api/v1/financial-closes/${close.body.id}/refresh`),
    ).expect(201);
    expect(
      refreshed.body.tasks.find((t: { key: string }) => t.key === 'LEASE_RUNS_POSTED').status,
    ).toBe('DONE');

    // The job: automatic runs off -> only reminders; on -> posts November.
    const sweep = await as(
      finance,
      http().post('/api/v1/leases/runs/sweep?asOf=2026-11-30'),
    ).expect(200);
    expect(sweep.body.runs).toBe(0);
    expect(sweep.body.paymentReminders).toBeGreaterThan(0);
    await as(accountant, http().put('/api/v1/leases/settings'))
      .send({ autoPostRuns: true })
      .expect(200);
    const auto = await as(finance, http().post('/api/v1/leases/runs/sweep?asOf=2026-11-30')).expect(
      200,
    );
    expect(auto.body.runs).toBe(1);
    expect(auto.body.lines).toBe(1);
    await integrity('2026-11-30');
  });

  // ------------------------------------------------------- fixed assets

  it('fixed assets: split carves children out of the register without posting; the rollforward ties per category and shows right-of-use assets', async () => {
    const categories = await as(admin, http().get('/api/v1/asset-categories')).expect(200);
    const furniture = categories.body.find((c: { code: string }) => c.code === 'FURN');
    const created = await as(accountant, http().post('/api/v1/fixed-assets'))
      .send({
        name: 'Workstation cluster (12 desks)',
        categoryId: furniture.id,
        acquisitionDate: '2026-05-15',
        acquisitionCost: '240000',
        salvageValue: '24000',
        usefulLifeMonths: 60,
      })
      .expect(201);
    const assetId = created.body.id;
    await as(finance, http().post(`/api/v1/fixed-assets/${assetId}/capitalize`))
      .send({ creditAccountId: acc['1130'] })
      .expect(201);
    const costBefore = await glBalance('1510', '2026-09-30');
    const split = await as(accountant, http().post(`/api/v1/fixed-assets/${assetId}/split`))
      .send({
        eventDate: '2026-09-15',
        parts: [
          { name: 'Workstations - 3F east wing', percent: '50' },
          { name: 'Workstations - 3F west wing', percent: '25', location: 'West wing' },
        ],
        notes: 'Relocated by wing',
      })
      .expect(200);
    expect(split.body.children).toHaveLength(2);
    expect(split.body.parent.cost).toBe('60000.0000');
    expect(split.body.parent.status).toBe('ACTIVE');
    expect(split.body.children[0].cost).toBe('120000.0000');
    expect(split.body.children[0].salvageValue).toBe('12000.0000');
    expect(split.body.children[1].cost).toBe('60000.0000');
    expect(split.body.children[1].location).toBe('West wing');
    expect(split.body.children[0].assetNumber).toMatch(/^FA-2026-\d{6}$/);
    expect(
      split.body.parent.events.filter((e: { eventType: string }) => e.eventType === 'SPLIT'),
    ).toHaveLength(1);
    // Register only: the asset account did not move.
    expect(await glBalance('1510', '2026-09-30')).toBe(costBefore);
    const tooMuch = await as(accountant, http().post(`/api/v1/fixed-assets/${assetId}/split`))
      .send({
        eventDate: '2026-09-16',
        parts: [
          { name: 'Rest', percent: '60' },
          { name: 'More', percent: '50' },
        ],
      })
      .expect(422);
    expect(tooMuch.body.code).toBe('VALIDATION_FAILED');
    // A full split retires the parent from the register with no gain / loss.
    const full = await as(accountant, http().post(`/api/v1/fixed-assets/${assetId}/split`))
      .send({
        eventDate: '2026-09-16',
        parts: [{ name: 'Workstations - 3F north', percent: '100' }],
      })
      .expect(200);
    expect(full.body.parent.status).toBe('DISPOSED');
    expect(full.body.parent.cost).toBe('0.0000');
    expect(full.body.children[0].cost).toBe('60000.0000');

    const rf = await as(
      viewer,
      http().get('/api/v1/fixed-assets/reports/rollforward?from=2026-09-01&to=2026-09-30'),
    ).expect(200);
    const furn = rf.body.groups.find((g: { categoryCode: string }) => g.categoryCode === 'FURN');
    expect(furn.cost.opening).toBe('240000.0000');
    expect(furn.cost.additions).toBe('240000.0000'); // three children carved in
    expect(furn.cost.disposals).toBe('-240000.0000'); // carved out of the parent
    expect(furn.cost.closing).toBe('240000.0000');
    expect(furn.counts).toEqual({ opening: 1, additions: 3, disposals: 1, closing: 3 });
    const rou = rf.body.groups.find((g: { categoryCode: string }) => g.categoryCode === 'ROU');
    expect(rou.cost.opening).toBe(OFFICE_PV);
    expect(rou.accumulated.opening).toBe(OFFICE_ACCUMULATED_AUG);
    expect(rou.accumulated.depreciation).toBe(OFFICE_DEPRECIATION);
    expect(rou.counts.opening).toBe(1);
    expect(Number(rf.body.totals.bookValue.closing)).toBeGreaterThan(0);
    const wholeYear = await as(
      viewer,
      http().get('/api/v1/fixed-assets/reports/rollforward?from=2026-01-01&to=2026-12-31'),
    ).expect(200);
    const rouYear = wholeYear.body.groups.find(
      (g: { categoryCode: string }) => g.categoryCode === 'ROU',
    );
    expect(rouYear.counts).toEqual({ opening: 0, additions: 2, disposals: 1, closing: 1 });
    expect(rouYear.cost.closing).toBe(OFFICE_PV);
  });

  // ------------------------------------------------------------ permissions

  it('permissions: viewers read, accountants capture, only lease.post commences and runs', async () => {
    await as(viewer, http().get('/api/v1/leases')).expect(200);
    await as(viewer, http().post('/api/v1/leases'))
      .send({ name: 'x', commencementDate: '2026-10-01', termMonths: 1, paymentAmount: '1' })
      .expect(403);
    const draft = await as(accountant, http().post('/api/v1/leases'))
      .send({
        name: 'Copier',
        commencementDate: '2026-12-01',
        termMonths: 6,
        paymentAmount: '3000',
      })
      .expect(201);
    await as(accountant, http().post(`/api/v1/leases/${draft.body.id}/commence`))
      .send({})
      .expect(403);
    await as(accountant, http().post('/api/v1/leases/runs'))
      .send({ periodEnd: '2026-12-31' })
      .expect(403);
    await as(accountant, http().delete(`/api/v1/leases/${draft.body.id}`)).expect(204);
    await as(viewer, http().get('/api/v1/leases/reports/register')).expect(200);
    await as(viewer, http().put('/api/v1/leases/settings'))
      .send({ autoPostRuns: false })
      .expect(403);
  });
});
