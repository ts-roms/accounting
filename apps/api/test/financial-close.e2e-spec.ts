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
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];
const AREAS = ['AR', 'AP', 'INVENTORY', 'FIXED_ASSETS', 'TAX'] as const;

/**
 * Hardening phase 4 - financial close: the checklist, the policy-driven
 * blockers, management approval and completion that closes / locks the period.
 */
describe('Financial close (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let accountant: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const periods: Record<string, { id: string; name: string; endDate: string }> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const task = (
    close: { tasks: Array<{ key: string; status: string; id: string }> },
    key: string,
  ) => close.tasks.find((t) => t.key === key)!;
  const finishManualTasks = async (closeId: string) => {
    let close = (await as(http().get(`/api/v1/financial-closes/${closeId}`)).expect(200)).body;
    for (const t of close.tasks.filter(
      (x: { kind: string; required: boolean; status: string }) =>
        x.kind === 'MANUAL' && x.required && x.status !== 'DONE',
    )) {
      close = (
        await as(http().patch(`/api/v1/financial-closes/${closeId}/tasks/${t.id}`), accountant)
          .send({ status: 'DONE', notes: 'Done in test' })
          .expect(200)
      ).body;
    }
    return close;
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
    const years = await as(http().get('/api/v1/fiscal-years')).expect(200);
    for (const p of years.body[0].periods) periods[p.startDate.slice(0, 7)] = p;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  let closeId: string;

  it('starting a close evaluates the checklist: reconciliations missing block, others pass', async () => {
    const jan = periods['2026-01']!;
    const res = await as(http().post('/api/v1/financial-closes'), accountant)
      .send({ fiscalPeriodId: jan.id, closeType: 'MONTH' })
      .expect(201);
    closeId = res.body.id;
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.periodName).toBe('January 2026');
    expect(res.body.tasks.length).toBe(21);
    expect(task(res.body, 'AR_RECONCILIATION').status).toBe('BLOCKED');
    expect(task(res.body, 'TRIAL_BALANCE').status).toBe('DONE');
    expect(task(res.body, 'INTEGRITY').status).toBe('DONE');
    expect(task(res.body, 'UNAPPROVED_JOURNALS').status).toBe('DONE');
    // Depreciation: no active assets in January -> passes; bank: no completed statement -> blocked.
    expect(task(res.body, 'DEPRECIATION').status).toBe('DONE');
    expect(task(res.body, 'BANK_RECONCILIATION').status).toBe('BLOCKED');
    expect(
      res.body.blockers
        .filter((b: { blocking: boolean }) => b.blocking)
        .map((b: { key: string }) => b.key),
    ).toEqual(expect.arrayContaining(['AR_RECONCILIATION', 'BANK_RECONCILIATION']));
    // FX revaluation is informational by default policy.
    expect(
      res.body.blockers.find((b: { key: string }) => b.key === 'FX_REVALUATION').blocking,
    ).toBe(false);
    // Only one live close per period.
    const dup = await as(http().post('/api/v1/financial-closes'), accountant)
      .send({ fiscalPeriodId: jan.id })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');
    await as(
      http().post('/api/v1/financial-closes'),
      await login({ email: 'viewer@acme.local', password: 'Demo!Passw0rd' }),
    )
      .send({ fiscalPeriodId: jan.id })
      .expect(403);
  });

  it('approval is refused while blockers or required tasks remain; manual tasks are worked by people', async () => {
    const blocked = await as(http().post(`/api/v1/financial-closes/${closeId}/approve`), finance)
      .send({})
      .expect(422);
    expect(blocked.body.code).toBe('CLOSE_BLOCKED');
    expect(blocked.body.details.blockers.length).toBeGreaterThan(0);
    // Automatic tasks cannot be ticked by hand.
    const auto = task(
      (await as(http().get(`/api/v1/financial-closes/${closeId}`)).expect(200)).body,
      'AR_RECONCILIATION',
    );
    await as(http().patch(`/api/v1/financial-closes/${closeId}/tasks/${auto.id}`), accountant)
      .send({ status: 'DONE' })
      .expect(422);
    // Skipping a required manual task needs a reason.
    const manual = task(
      (await as(http().get(`/api/v1/financial-closes/${closeId}`)).expect(200)).body,
      'MANUAL_ACCRUALS',
    );
    await as(http().patch(`/api/v1/financial-closes/${closeId}/tasks/${manual.id}`), accountant)
      .send({ status: 'SKIPPED' })
      .expect(422);
    const skipped = await as(
      http().patch(`/api/v1/financial-closes/${closeId}/tasks/${manual.id}`),
      accountant,
    )
      .send({ status: 'SKIPPED', reason: 'No accruals this month' })
      .expect(200);
    expect(task(skipped.body, 'MANUAL_ACCRUALS')).toMatchObject({
      status: 'SKIPPED',
      skipReason: 'No accruals this month',
    });
    // A custom task can be added.
    const added = await as(http().post(`/api/v1/financial-closes/${closeId}/tasks`), accountant)
      .send({ title: 'Payroll accrual check', required: true })
      .expect(201);
    expect(
      added.body.tasks.some((t: { title: string }) => t.title === 'Payroll accrual check'),
    ).toBe(true);
  });

  it('once every reconciliation is approved and the bank policy relaxed, the close becomes READY, is approved and completed (period closed)', async () => {
    // Approve the five subledger reconciliations as of the period end.
    for (const area of AREAS) {
      const rec = await as(http().post('/api/v1/reconciliations'), accountant)
        .send({ area, asOf: periods['2026-01']!.endDate })
        .expect(201);
      expect(rec.body.status).toBe('RECONCILED');
      await as(http().post(`/api/v1/reconciliations/${rec.body.id}/approve`), finance)
        .send({})
        .expect(201);
    }
    // No bank statement was imported for January: the policy decides whether that blocks.
    let close = (
      await as(http().post(`/api/v1/financial-closes/${closeId}/refresh`), accountant).expect(201)
    ).body;
    expect(task(close, 'AR_RECONCILIATION').status).toBe('DONE');
    expect(task(close, 'BANK_RECONCILIATION').status).toBe('BLOCKED');
    await as(http().patch('/api/v1/accounting-policies'))
      .send({ closeRequireBankReconciliation: false })
      .expect(200);
    close = (
      await as(http().post(`/api/v1/financial-closes/${closeId}/refresh`), accountant).expect(201)
    ).body;
    expect(task(close, 'BANK_RECONCILIATION').status).toBe('PENDING');
    expect(
      close.blockers.find((b: { key: string }) => b.key === 'BANK_RECONCILIATION').blocking,
    ).toBe(false);
    close = await finishManualTasks(closeId);
    expect(close.status).toBe('READY');
    expect(close.progress).toBe(100);

    // Management approval (finance), then completion closes the period.
    await as(http().post(`/api/v1/financial-closes/${closeId}/approve`), accountant)
      .send({})
      .expect(403);
    const approved = await as(http().post(`/api/v1/financial-closes/${closeId}/approve`), finance)
      .send({ notes: 'Reviewed the statements' })
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedByName).toBe('Marco Santos');
    const completed = await as(http().post(`/api/v1/financial-closes/${closeId}/complete`), finance)
      .send({})
      .expect(201);
    expect(completed.body.status).toBe('COMPLETED');
    expect(completed.body.periodStatus).toBe('CLOSED');
    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [closeId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['CREATE', 'APPROVE', 'PERIOD_CLOSE']),
    );
    // Completed closes are immutable and a closed period cannot start another close.
    await as(http().post(`/api/v1/financial-closes/${closeId}/cancel`), accountant)
      .send({ reason: 'oops' })
      .expect(422);
    const again = await as(http().post('/api/v1/financial-closes'), accountant)
      .send({ fiscalPeriodId: periods['2026-01']!.id })
      .expect(422);
    expect(again.body.code).toBe('ACCOUNTING_PERIOD_CLOSED');
  });

  it('a regression after approval withdraws the approval; lock-on-complete policy locks the period', async () => {
    const feb = periods['2026-02']!;
    for (const area of AREAS) {
      const rec = await as(http().post('/api/v1/reconciliations'), accountant)
        .send({ area, asOf: feb.endDate })
        .expect(201);
      await as(http().post(`/api/v1/reconciliations/${rec.body.id}/approve`), finance)
        .send({})
        .expect(201);
    }
    const started = await as(http().post('/api/v1/financial-closes'), accountant)
      .send({ fiscalPeriodId: feb.id })
      .expect(201);
    await finishManualTasks(started.body.id);
    const approved = await as(
      http().post(`/api/v1/financial-closes/${started.body.id}/approve`),
      finance,
    )
      .send({})
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    // A new draft journal lands in the period -> UNAPPROVED_JOURNALS fails -> approval withdrawn.
    const je = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({
        entryDate: '2026-02-20',
        description: 'Late draft',
        lines: [
          { accountId: acc['6400'], debit: '10', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '10' },
        ],
      })
      .expect(201);
    const regressed = await as(
      http().post(`/api/v1/financial-closes/${started.body.id}/refresh`),
      accountant,
    ).expect(201);
    expect(regressed.body.status).toBe('IN_PROGRESS');
    expect(regressed.body.approvedBy).toBeNull();
    await as(http().post(`/api/v1/financial-closes/${started.body.id}/complete`), finance)
      .send({})
      .expect(422);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`), accountant).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/reject`), finance)
      .send({ reason: 'not this period' })
      .expect(201);
    // Rejected drafts still sit in the period as unposted work; delete it.
    await as(http().delete(`/api/v1/journal-entries/${je.body.id}`), accountant).expect(204);
    await as(http().patch('/api/v1/accounting-policies'))
      .send({ closeLockOnComplete: true })
      .expect(200);
    await as(http().post(`/api/v1/financial-closes/${started.body.id}/approve`), finance)
      .send({})
      .expect(201);
    const done = await as(
      http().post(`/api/v1/financial-closes/${started.body.id}/complete`),
      finance,
    )
      .send({})
      .expect(201);
    expect(done.body.periodStatus).toBe('LOCKED');
    const blockers = await as(
      http().get(`/api/v1/financial-closes/blockers?fiscalPeriodId=${periods['2026-03']!.id}`),
    ).expect(200);
    expect(blockers.body.some((b: { key: string }) => b.key === 'AR_RECONCILIATION')).toBe(true);
  });
});
