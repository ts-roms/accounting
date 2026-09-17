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
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];
const AREAS = ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS', 'TAX'] as const;

/**
 * Hardening phase 2 - recorded subledger reconciliations: every area derives
 * its expected balance, variances are explained by exceptions, approval is
 * four-eyes and never silent.
 */
describe('Subledger reconciliation (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let accountant: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const postJournal = async (entryDate: string, lines: object[], description = 'Recon test') => {
    const je = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({ entryDate, description, lines })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`), accountant).expect(201);
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
    accountant = await login(ACCOUNTANT);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('every subledger reconciles on the seeded company and the summary shows it', async () => {
    const summary = await as(http().get('/api/v1/reconciliations/summary?asOf=2026-12-31')).expect(
      200,
    );
    expect(summary.body.materiality).toBe('0.0000');
    expect(summary.body.areas.map((a: { area: string }) => a.area)).toEqual([...AREAS]);
    for (const a of summary.body.areas) {
      expect(a.live.variance).toBe('0.0000');
      expect(a.live.withinMateriality).toBe(true);
      expect(a.latest).toBeNull();
      expect(a.stale).toBe(true);
    }
    // The tax register carries the seeded VAT and the fixed-asset register the capitalised laptops.
    const tax = summary.body.areas.find((a: { area: string }) => a.area === 'TAX');
    expect(Number(tax.live.expected)).not.toBe(0);
    await as(http().get('/api/v1/reconciliations/summary'), accountant).expect(200);
  });

  it('a run records a snapshot per area; recomputing updates it; viewers cannot run', async () => {
    for (const area of AREAS) {
      const res = await as(http().post('/api/v1/reconciliations'), accountant)
        .send({ area, asOf: '2026-12-31' })
        .expect(201);
      expect(res.body.status).toBe('RECONCILED');
      expect(res.body.variance).toBe('0.0000');
      expect(res.body.lines.length).toBeGreaterThan(0);
      expect(res.body.preparedByName).toBe('Ana Reyes');
    }
    const again = await as(http().post('/api/v1/reconciliations'), accountant)
      .send({ area: 'AR', asOf: '2026-12-31' })
      .expect(201);
    const list = await as(http().get('/api/v1/reconciliations?area=AR')).expect(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(again.body.id);
    const viewer = await login({ email: 'viewer@acme.local', password: 'P@ssw0rd123' });
    await as(http().post('/api/v1/reconciliations'), viewer)
      .send({ area: 'AR', asOf: '2026-12-31' })
      .expect(403);
    await as(http().get('/api/v1/reconciliations'), viewer).expect(200);
  });

  it('a manual journal on the AR control creates a variance that must be explained before approval', async () => {
    // Manual posting straight onto accounts receivable: subledger unchanged, ledger +5,000.
    await postJournal(
      '2026-06-15',
      [
        { accountId: acc['1200'], debit: '5000', credit: '0' },
        { accountId: acc['4200'], debit: '0', credit: '5000' },
      ],
      'Manual AR adjustment',
    );
    const run = await as(http().post('/api/v1/reconciliations'), accountant)
      .send({ area: 'AR', asOf: '2026-06-30' })
      .expect(201);
    expect(run.body.status).toBe('HAS_VARIANCE');
    expect(run.body.variance).toBe('5000.0000');
    expect(run.body.unexplained).toBe('5000.0000');
    const id = run.body.id;

    // Cannot be approved silently.
    const blocked = await as(http().post(`/api/v1/reconciliations/${id}/approve`), finance)
      .send({})
      .expect(422);
    expect(blocked.body.code).toBe('RECONCILIATION_UNRESOLVED');
    expect(blocked.body.details.unexplained).toBe('5000.0000');

    // Explain it with an exception; still open -> still blocked.
    const withException = await as(
      http().post(`/api/v1/reconciliations/${id}/exceptions`),
      accountant,
    )
      .send({
        description: 'Manual AR adjustment JE to be reversed',
        amount: '5000',
        reference: 'JE manual',
      })
      .expect(201);
    expect(withException.body.openExceptions).toBe(1);
    expect(withException.body.unexplained).toBe('0.0000');
    const stillBlocked = await as(http().post(`/api/v1/reconciliations/${id}/approve`), finance)
      .send({})
      .expect(422);
    expect(stillBlocked.body.message).toContain('still open');

    // Assign a reviewer, resolve the exception, then the preparer cannot approve but finance can.
    const finUser = await pool.query(`SELECT id FROM users WHERE email = $1`, [FINANCE.email]);
    const assigned = await as(http().post(`/api/v1/reconciliations/${id}/assign`), accountant)
      .send({ reviewerId: finUser.rows[0].id, notes: 'Please review' })
      .expect(201);
    expect(assigned.body.status).toBe('UNDER_REVIEW');
    const exceptionId = withException.body.exceptions[0].id;
    await as(
      http().post(`/api/v1/reconciliations/${id}/exceptions/${exceptionId}/resolve`),
      accountant,
    )
      .send({ resolution: 'Reversed via correcting journal on 2026-07-01' })
      .expect(201);
    const sod = await as(http().post(`/api/v1/reconciliations/${id}/approve`), accountant)
      .send({})
      .expect(403);
    expect(sod.body.code).toBe('PERMISSION_DENIED');
    // Give the accountant the approve right to prove the four-eyes rule itself.
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'ACCOUNTANT' AND p.key = 'reconciliation.approve'`,
    );
    const acct2 = await login(ACCOUNTANT);
    const selfApprove = await as(http().post(`/api/v1/reconciliations/${id}/approve`), acct2)
      .send({})
      .expect(422);
    expect(selfApprove.body.code).toBe('SOD_VIOLATION');
    const approved = await as(http().post(`/api/v1/reconciliations/${id}/approve`), finance)
      .send({ notes: 'Explained by timing' })
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedByName).toBe('Marco Santos');
    expect(approved.body.notes).toContain('Explained by timing');
    // Approved records are final.
    await as(http().post('/api/v1/reconciliations'), accountant)
      .send({ area: 'AR', asOf: '2026-06-30' })
      .expect(422);
    await as(http().post(`/api/v1/reconciliations/${id}/exceptions`), accountant)
      .send({ description: 'late', amount: '1' })
      .expect(422);
    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['CREATE', 'UPDATE', 'RECONCILIATION_APPROVE']),
    );
  });

  it('materiality policy turns a small variance into RECONCILED and is audited', async () => {
    const before = await as(http().get('/api/v1/accounting-policies')).expect(200);
    expect(before.body.reconciliationMateriality).toBe('0.0000');
    await as(http().patch('/api/v1/accounting-policies'), finance)
      .send({ reconciliationMateriality: '10000' })
      .expect(403);
    const updated = await as(http().patch('/api/v1/accounting-policies'))
      .send({ reconciliationMateriality: '10000', reconciliationStaleDays: 10 })
      .expect(200);
    expect(updated.body.reconciliationMateriality).toBe('10000.0000');
    const run = await as(http().post('/api/v1/reconciliations'), accountant)
      .send({ area: 'AR', asOf: '2026-07-31' })
      .expect(201);
    expect(run.body.status).toBe('RECONCILED');
    expect(run.body.variance).toBe('5000.0000');
    expect(run.body.materiality).toBe('10000.0000');
    const approved = await as(
      http().post(`/api/v1/reconciliations/${run.body.id}/approve`),
      finance,
    )
      .send({})
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    await as(http().patch('/api/v1/accounting-policies'))
      .send({ reconciliationMateriality: '0' })
      .expect(200);
  });

  it('the integrity checker reports the same variance the reconciliation does', async () => {
    const report = await as(http().get('/api/v1/integrity?asOf=2026-12-31')).expect(200);
    const ar = report.body.findings.find(
      (f: { check: string }) => f.check === 'AR_CONTROL_VARIANCE',
    );
    expect(ar.count).toBe(1);
    expect(ar.samples[0].difference).toBe('5000.0000');
    const tax = report.body.findings.find((f: { check: string }) => f.check === 'TAX_VARIANCE');
    expect(tax.count).toBe(0);
  });
});
