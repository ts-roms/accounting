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
const AUDITOR = { email: 'auditor@acme.local', password: 'Demo!Passw0rd' };
const VIEWER = { email: 'viewer@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];
const WINDOW = 'from=2026-01-01&to=2026-09-30';
const money = (v: string | null | undefined) => Number(v ?? '0');

/**
 * Hardening phase 9 - consolidation readiness: consolidation groups with
 * ownership and method, a group chart of accounts fed by member mappings,
 * current-rate translation with the CTA plug, automatic intercompany
 * eliminations plus manual group adjustments, NCI, the readiness checklist
 * and finalised runs.
 */
describe('Consolidation groups (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let auditor: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  let groupId: string;
  const acc: Record<string, string> = {};
  const otherAcc: Record<string, string> = {};
  const groupAcc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const report = (id = groupId, window = WINDOW) =>
    as(http().get(`/api/v1/consolidation/groups/${id}/report?${window}`)).expect(200);
  const readiness = (id = groupId, window = WINDOW) =>
    as(http().get(`/api/v1/consolidation/groups/${id}/readiness?${window}`)).expect(200);
  const check = (body: { checks: Array<{ key: string; status: string }> }, key: string) =>
    body.checks.find((c) => c.key === key)!.status;

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
    auditor = await login(AUDITOR);
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    otherCompanyId = companies.body.find((c: { code: string }) => c.code !== 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const otherChart = await http()
      .get('/api/v1/accounts')
      .set('Cookie', admin)
      .set('x-company-id', otherCompanyId)
      .set(CSRF)
      .expect(200);
    for (const a of otherChart.body) otherAcc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------ groups

  it('creates a group with the parent at 100% and a subsidiary at 80% FULL', async () => {
    const created = await as(http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'ACME-GRP',
        name: 'Acme Group',
        presentationCurrency: 'PHP',
        parentCompanyId: companyId,
        members: [{ companyId: otherCompanyId, ownershipPct: 80, method: 'FULL' }],
      })
      .expect(201);
    groupId = created.body.id;
    expect(created.body.members).toHaveLength(2);
    const parent = created.body.members.find((m: { isParent: boolean }) => m.isParent);
    const sub = created.body.members.find((m: { isParent: boolean }) => !m.isParent);
    expect(parent.companyId).toBe(companyId);
    expect(parent.ownershipPct).toBe('100.0000');
    expect(sub.ownershipPct).toBe('80.0000');
    expect(created.body.groupAccountCount).toBe(0);
    await as(http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'ACME-GRP',
        name: 'dup',
        presentationCurrency: 'PHP',
        parentCompanyId: companyId,
      })
      .expect(409);
    const list = await as(http().get('/api/v1/consolidation/groups'), auditor).expect(200);
    expect(list.body.map((g: { code: string }) => g.code)).toContain('ACME-GRP');
  });

  it('auto-maps every member onto a group chart created from the parent, flagging intercompany accounts', async () => {
    const mapped = await as(http().post(`/api/v1/consolidation/groups/${groupId}/mappings/auto`))
      .send({ createMissing: true })
      .expect(201);
    expect(mapped.body.created).toBeGreaterThan(20);
    expect(mapped.body.mapped).toBe(mapped.body.created + (await postableCount(otherCompanyId)));
    expect(mapped.body.unmapped).toEqual([]);
    const chart = await as(http().get(`/api/v1/consolidation/groups/${groupId}/accounts`)).expect(
      200,
    );
    for (const g of chart.body) groupAcc[g.code] = g.id;
    const due = chart.body.find((g: { code: string }) => g.code === '1290');
    expect(due.isIntercompany).toBe(true);
    expect(due.type).toBe('ASSET');
    const mappings = await as(
      http().get(`/api/v1/consolidation/groups/${groupId}/mappings/${otherCompanyId}`),
    ).expect(200);
    const cash = mappings.body.find((m: { code: string }) => m.code === '1130');
    expect(cash.groupAccountId).toBe(groupAcc['1130']);
    expect(
      mappings.body.filter(
        (m: { isHeader: boolean; groupAccountId: string | null }) =>
          !m.isHeader && !m.groupAccountId,
      ),
    ).toHaveLength(0);
  });

  async function postableCount(company: string): Promise<number> {
    const r = await pool.query(
      `SELECT COUNT(*)::int AS n FROM accounts WHERE company_id = $1 AND is_header = false`,
      [company],
    );
    return r.rows[0].n as number;
  }

  // ----------------------------------------------------------------- report

  it('eliminates the intercompany pair, closes the balance sheet and reports NCI for the 80% member', async () => {
    const ict = await as(http().post('/api/v1/intercompany'))
      .send({
        fromCompanyId: companyId,
        toCompanyId: otherCompanyId,
        transactionDate: '2026-09-01',
        description: 'Shared services recharge',
        amount: '12000',
        fromAccountId: acc['6400'],
        toAccountId: otherAcc['4900'],
      })
      .expect(201);
    await as(http().post(`/api/v1/intercompany/${ict.body.id}/post`)).expect(201);

    const r = await report();
    expect(r.body.currency).toBe('PHP');
    expect(r.body.members).toHaveLength(2);
    for (const m of r.body.members) expect(m.rates).toEqual({ closing: '1', average: '1' });
    const due = r.body.rows.find((x: { code: string }) => x.code === '1290');
    const owed = r.body.rows.find((x: { code: string }) => x.code === '2180');
    expect(due.isIntercompany).toBe(true);
    expect(due.byCompany[otherCompanyId]).toBe('12000.0000');
    expect(due.eliminations).toBe('-12000.0000');
    expect(due.consolidated).toBe('0.0000');
    expect(owed.byCompany[companyId]).toBe('12000.0000');
    expect(r.body.totals.eliminationCheck).toBe('0.0000');
    expect(r.body.unmapped).toEqual([]);
    expect(r.body.totals.balanced).toBe(true);
    expect(r.body.totals.cumulativeTranslationAdjustment).toBe('0.0000'); // same currency, no translation
    // NCI: 20% of the subsidiary's net assets and of its result.
    const sub = r.body.members.find((m: { companyId: string }) => m.companyId === otherCompanyId);
    const subAssets = r.body.rows
      .filter((x: { type: string }) => x.type === 'ASSET')
      .reduce(
        (n: number, x: { byCompany: Record<string, string> }) =>
          n + money(x.byCompany[otherCompanyId]),
        0,
      );
    const subLiabilities = r.body.rows
      .filter((x: { type: string }) => x.type === 'LIABILITY')
      .reduce(
        (n: number, x: { byCompany: Record<string, string> }) =>
          n + money(x.byCompany[otherCompanyId]),
        0,
      );
    expect(money(sub.nci.netAssets)).toBeCloseTo((subAssets - subLiabilities) * 0.2, 2);
    expect(r.body.totals.nonControllingInterest).toBe(sub.nci.netAssets);
    // The parent's rows carry 100% (FULL): its bank balance equals the standalone balance sheet figure.
    const parentCash = r.body.rows.find((x: { code: string }) => x.code === '1130').byCompany[
      companyId
    ];
    const bs = await as(http().get('/api/v1/reports/balance-sheet?asOf=2026-09-30')).expect(200);
    const bank = bs.body.assets.rows.find((x: { code: string }) => x.code === '1130');
    expect(parentCash).toBe(bank.amount);
  });

  it('translation into USD uses closing and average rates and the CTA plug keeps the group closed', async () => {
    const usd = await as(http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'ACME-USD',
        name: 'Acme Group (USD)',
        presentationCurrency: 'USD',
        parentCompanyId: companyId,
        members: [{ companyId: otherCompanyId, ownershipPct: 50, method: 'FULL' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/consolidation/groups/${usd.body.id}/mappings/auto`))
      .send({ createMissing: true })
      .expect(201);
    const r = await report(usd.body.id);
    expect(r.body.currency).toBe('USD');
    const parent = r.body.members.find((m: { companyId: string }) => m.companyId === companyId);
    // PHP -> USD: closing on 2026-09-30 uses the 57.5 rate, the average blends 56 and 57.5.
    expect(Number(parent.rates.closing)).toBeCloseTo(1 / 57.5, 6);
    expect(Number(parent.rates.average)).toBeGreaterThan(Number(parent.rates.closing));
    expect(parent.cta).not.toBe('0.0000');
    expect(r.body.totals.eliminationCheck).toBe('0.0000');
    expect(r.body.totals.balanced).toBe(true);
    const sub = r.body.members.find((m: { companyId: string }) => m.companyId === otherCompanyId);
    expect(money(sub.nci.netAssets)).toBeGreaterThan(0); // 50% FULL -> half the net assets belong to NCI
    const php = await report();
    const phpDue = php.body.rows.find((x: { code: string }) => x.code === '1290').byCompany[
      otherCompanyId
    ];
    const usdDue = r.body.rows.find((x: { code: string }) => x.code === '1290').byCompany[
      otherCompanyId
    ];
    // Balance-sheet item at the closing rate.
    expect(money(usdDue)).toBeCloseTo(money(phpDue) / 57.5, 2);
  });

  it('a PROPORTIONATE member carries only its share, so the intra-group pair no longer mirrors until adjusted', async () => {
    const prop = await as(http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'ACME-JV',
        name: 'Acme joint venture view',
        presentationCurrency: 'PHP',
        parentCompanyId: companyId,
        members: [{ companyId: otherCompanyId, ownershipPct: 50, method: 'PROPORTIONATE' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/consolidation/groups/${prop.body.id}/mappings/auto`))
      .send({ createMissing: true })
      .expect(201);
    const r = await report(prop.body.id);
    const due = r.body.rows.find((x: { code: string }) => x.code === '1290');
    expect(due.byCompany[otherCompanyId]).toBe('6000.0000'); // 50% of 12,000
    const sub = r.body.members.find((m: { companyId: string }) => m.companyId === otherCompanyId);
    expect(sub.nci.netAssets).toBe('0.0000'); // proportionate: no NCI
    expect(r.body.totals.eliminationCheck).toBe('-6000.0000'); // receivable 6,000 vs payable 12,000
    const ready = await readiness(prop.body.id);
    expect(check(ready.body, 'INTERCOMPANY_BALANCED')).toBe('FAIL');
  });

  // ------------------------------------------------------------- adjustments

  it('books a balanced group adjustment that flows into the consolidated column; unbalanced ones are rejected', async () => {
    await as(http().post(`/api/v1/consolidation/groups/${groupId}/adjustments`))
      .send({
        effectiveDate: '2026-09-30',
        description: 'Unbalanced',
        lines: [
          { groupAccountId: groupAcc['3100'], debit: '1000' },
          { groupAccountId: groupAcc['1130'], credit: '900' },
        ],
      })
      .expect(400);
    const adj = await as(http().post(`/api/v1/consolidation/groups/${groupId}/adjustments`))
      .send({
        effectiveDate: '2026-09-30',
        reference: 'ELIM-01',
        description: 'Eliminate investment in subsidiary against share capital',
        lines: [
          {
            groupAccountId: groupAcc['3100'],
            debit: '1000',
            description: 'Share capital of subsidiary',
          },
          { groupAccountId: groupAcc['1130'], credit: '1000' },
        ],
      })
      .expect(201);
    expect(adj.body.total).toBe('1000.0000');
    expect(adj.body.lines).toHaveLength(2);
    const before = await report(groupId, 'from=2026-01-01&to=2026-08-31');
    expect(before.body.adjustments).toHaveLength(0); // effective after that window
    const r = await report();
    expect(r.body.adjustments.map((a: { id: string }) => a.id)).toContain(adj.body.id);
    const equity = r.body.rows.find((x: { code: string }) => x.code === '3100');
    const cash = r.body.rows.find((x: { code: string }) => x.code === '1130');
    expect(equity.adjustments).toBe('-1000.0000'); // debit reduces a credit-natural balance
    expect(cash.adjustments).toBe('-1000.0000');
    expect(money(equity.consolidated)).toBeCloseTo(money(equity.combined) - 1000, 3);
    expect(r.body.totals.adjustmentsBalanced).toBe(true);
    expect(r.body.totals.balanced).toBe(true);
    await as(
      http().delete(`/api/v1/consolidation/groups/${groupId}/adjustments/${adj.body.id}`),
    ).expect(204);
    const after = await as(
      http().get(`/api/v1/consolidation/groups/${groupId}/adjustments`),
    ).expect(200);
    expect(after.body).toHaveLength(0);
  });

  // --------------------------------------------------------- readiness & runs

  it('readiness flags unposted intercompany and unmapped accounts; a run only finalises when ready', async () => {
    const ready = await readiness();
    expect(check(ready.body, 'MEMBERS')).toBe('PASS');
    expect(check(ready.body, 'RATES')).toBe('PASS');
    expect(check(ready.body, 'INTERCOMPANY_POSTED')).toBe('PASS');
    expect(check(ready.body, 'MAPPINGS')).toBe('PASS');
    expect(check(ready.body, 'INTERCOMPANY_BALANCED')).toBe('PASS');
    expect(check(ready.body, 'BALANCED')).toBe('PASS');
    expect(check(ready.body, 'PERIODS')).toBe('WARN'); // September is still open
    expect(ready.body.ready).toBe(true);

    // A draft intra-group transaction and an unmapped account both block.
    const draft = await as(http().post('/api/v1/intercompany'))
      .send({
        fromCompanyId: companyId,
        toCompanyId: otherCompanyId,
        transactionDate: '2026-09-15',
        description: 'Not yet posted',
        amount: '500',
        fromAccountId: acc['6400'],
        toAccountId: otherAcc['4900'],
      })
      .expect(201);
    await as(http().put(`/api/v1/consolidation/groups/${groupId}/mappings`))
      .send({
        companyId: otherCompanyId,
        mappings: [{ accountId: otherAcc['1290'], groupAccountId: null }],
      })
      .expect(200);
    const blocked = await readiness();
    expect(check(blocked.body, 'INTERCOMPANY_POSTED')).toBe('FAIL');
    expect(check(blocked.body, 'MAPPINGS')).toBe('FAIL');
    expect(check(blocked.body, 'INTERCOMPANY_BALANCED')).toBe('FAIL'); // the receivable side is no longer in the rows
    expect(blocked.body.ready).toBe(false);
    const draftRun = await as(http().post(`/api/v1/consolidation/groups/${groupId}/runs`))
      .send({ from: '2026-01-01', to: '2026-09-30' })
      .expect(201);
    expect(draftRun.body.status).toBe('DRAFT');
    expect(draftRun.body.readiness.ready).toBe(false);
    expect(draftRun.body.report.unmapped).toHaveLength(1);
    const refused = await as(
      http().post(`/api/v1/consolidation/groups/${groupId}/runs/${draftRun.body.id}/finalize`),
    ).expect(422);
    expect(refused.body.code).toBe('CONSOLIDATION_NOT_READY');
    expect(refused.body.details.failing).toEqual(
      expect.arrayContaining(['INTERCOMPANY_POSTED', 'MAPPINGS']),
    );

    // Fix both, run again, finalise.
    await as(http().post(`/api/v1/intercompany/${draft.body.id}/post`)).expect(201);
    await as(http().put(`/api/v1/consolidation/groups/${groupId}/mappings`))
      .send({
        companyId: otherCompanyId,
        mappings: [{ accountId: otherAcc['1290'], groupAccountId: groupAcc['1290'] }],
      })
      .expect(200);
    const run = await as(http().post(`/api/v1/consolidation/groups/${groupId}/runs`))
      .send({ from: '2026-01-01', to: '2026-09-30' })
      .expect(201);
    expect(run.body.readiness.ready).toBe(true);
    expect(run.body.report.totals.balanced).toBe(true);
    const final = await as(
      http().post(`/api/v1/consolidation/groups/${groupId}/runs/${run.body.id}/finalize`),
    ).expect(201);
    expect(final.body.status).toBe('FINAL');
    expect(final.body.finalizedAt).toBeTruthy();
    await as(
      http().post(`/api/v1/consolidation/groups/${groupId}/runs/${run.body.id}/finalize`),
    ).expect(422);
    const runs = await as(http().get(`/api/v1/consolidation/groups/${groupId}/runs`)).expect(200);
    expect(runs.body.total).toBe(2);
    expect(runs.body.items[0].totals.balanced).toBe(true);
    const stored = await as(
      http().get(`/api/v1/consolidation/groups/${groupId}/runs/${run.body.id}`),
    ).expect(200);
    expect(stored.body.report.rows.length).toBeGreaterThan(5);
    const audit = await as(
      http().get(`/api/v1/audit-logs?action=FINALIZE&entityId=${run.body.id}`),
      auditor,
    ).expect(200);
    expect(audit.body.total).toBe(1);
  });

  // ------------------------------------------------------------- permissions

  it('auditors read groups and reports; viewers and auditors cannot maintain them', async () => {
    await as(
      http().get(`/api/v1/consolidation/groups/${groupId}/report?${WINDOW}`),
      auditor,
    ).expect(200);
    await as(
      http().get(`/api/v1/consolidation/groups/${groupId}/readiness?${WINDOW}`),
      auditor,
    ).expect(200);
    await as(http().post(`/api/v1/consolidation/groups/${groupId}/runs`), auditor)
      .send({ from: '2026-01-01', to: '2026-09-30' })
      .expect(403);
    await as(http().post('/api/v1/consolidation/groups'), viewer)
      .send({ code: 'X', name: 'x', presentationCurrency: 'PHP', parentCompanyId: companyId })
      .expect(403);
    await as(http().get('/api/v1/consolidation/groups'), viewer).expect(200);
  });
});
