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
const FINANCE = { email: 'finance@acme.local', password: 'Demo!Passw0rd' };
const VIEWER = { email: 'viewer@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #9 - Multi-entity consolidation & intercompany. Reads the seeded
 * group (Acme Trading owns 80% of Acme Services through a share swap, a
 * management fee charged and settled), opens a fiscal-year-to-date run and
 * proves translation, eliminations, goodwill, non-controlling interest and
 * the balanced group statements; then the manual adjustment trail, the
 * four-eyes group close with readiness gates, an intercompany charge with
 * cash settlement through both ledgers, the drift detection after a late
 * entity posting, reopening, and the permission / structure controls.
 */
describe('Consolidation platform (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  const acc: Record<string, string> = {};
  const otherAcc: Record<string, string> = {};
  let groupId: string;
  let runId: string;

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test, company = companyId) =>
    req.set('Cookie', cookies).set('x-company-id', company).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const row = (body: { rows: Array<{ code: string }> }, code: string) =>
    body.rows.find((r) => r.code === code) as
      | {
          code: string;
          combined: string;
          adjustments: string;
          consolidated: string;
          byCompany: Record<string, string>;
        }
      | undefined;
  const expectIntegrity = async (expectCriticalZero = true) => {
    const res = await as(
      admin,
      http().get('/api/v1/consolidation/integrity?asOf=2026-08-31'),
    ).expect(200);
    if (expectCriticalZero)
      for (const check of [
        'CONSOLIDATION_UNBALANCED',
        'CONSOLIDATION_ADJUSTMENT_UNBALANCED',
        'GROUP_ACCOUNTS_MISSING',
        'INTERCOMPANY_WITHOUT_JOURNALS',
      ])
        expect(res.body.findings.find((f: { check: string }) => f.check === check).count).toBe(0);
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
    finance = await login(FINANCE);
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    otherCompanyId = companies.body.find((c: { code: string }) => c.code === 'ACMS').id;
    for (const a of (await as(admin, http().get('/api/v1/accounts')).expect(200)).body)
      acc[a.code] = a.id;
    for (const a of (await as(admin, http().get('/api/v1/accounts'), otherCompanyId).expect(200))
      .body)
      otherAcc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------- seed

  it('seed: the group, its members and rules exist; intercompany nets to zero; integrity holds', async () => {
    const groups = await as(admin, http().get('/api/v1/consolidation/groups')).expect(200);
    expect(groups.body).toHaveLength(1);
    const g = groups.body[0];
    groupId = g.id;
    expect(g.code).toBe('ACME-GROUP');
    expect(g.parentCompanyCode).toBe('ACME');
    expect(g.presentationCurrency).toBe('PHP');
    expect(
      g.members.map((m: { companyCode: string; method: string; ownershipPercent: string }) => [
        m.companyCode,
        m.method,
        m.ownershipPercent,
      ]),
    ).toEqual([
      ['ACME', 'FULL', '100.0000'],
      ['ACMS', 'FULL', '80.0000'],
    ]);
    expect(g.rules.map((r: { code: string }) => r.code).sort()).toEqual([
      'IC-BALANCES',
      'IC-FEES',
      'INVESTMENT',
    ]);
    expect(g.accounts.goodwill).toBe('1710');
    const recon = await as(
      admin,
      http().get('/api/v1/consolidation/intercompany-reconciliation?asOf=2026-08-31'),
    ).expect(200);
    expect(recon.body.pairs).toHaveLength(0); // the management fee was settled in July
    expect(recon.body.totals.entitiesWithDrift).toBe(0);
    const ic = await as(admin, http().get('/api/v1/intercompany?status=SETTLED')).expect(200);
    expect(ic.body.items).toHaveLength(1);
    expect(ic.body.items[0].settlementFromJournalNumber).toMatch(/^JE-/);
    const legacy = await as(
      admin,
      http().get('/api/v1/consolidation/trial-balance?from=2026-01-01&to=2026-08-31'),
    ).expect(200);
    expect(legacy.body.totals.balanced).toBe(true);
    const report = await expectIntegrity();
    expect(report.status).toBe('OK');
  });

  // -------------------------------------------------------------------- run

  it('a year-to-date run translates, eliminates the investment and fees, books goodwill and NCI, and balances', async () => {
    // Runs are fiscal-year-to-date: a monthly window is refused.
    const monthly = await as(
      accountant,
      http().post(`/api/v1/consolidation/groups/${groupId}/runs`),
    )
      .send({ periodStart: '2026-08-01', periodEnd: '2026-08-31' })
      .expect(422);
    expect(monthly.body.code).toBe('VALIDATION_FAILED');
    await as(viewer, http().post(`/api/v1/consolidation/groups/${groupId}/runs`))
      .send({ periodEnd: '2026-08-31' })
      .expect(403);
    const created = await as(
      accountant,
      http().post(`/api/v1/consolidation/groups/${groupId}/runs`),
    )
      .send({ periodEnd: '2026-08-31', description: 'August 2026 year-to-date' })
      .expect(201);
    runId = created.body.id;
    const r = created.body;
    expect(r.documentNumber).toMatch(/^CON-2026-/);
    expect(r.status).toBe('DRAFT');
    expect(r.periodStart).toBe('2026-01-01');
    expect(r.preparedAt).toBeTruthy();
    expect(r.members.map((m: { code: string }) => m.code)).toEqual(['ACME', 'ACMS']);
    expect(r.members[1].netIncome).toBe('332000.0000'); // 490,000 revenue - 98,000 opex - 60,000 fee
    expect(
      r.adjustments.map((a: { type: string; autoGenerated: boolean }) => [a.type, a.autoGenerated]),
    ).toEqual([
      ['ELIMINATION', true],
      ['ELIMINATION', true],
    ]);
    // Intercompany fee: 4980 revenue in ACME against 6970 expense in ACMS.
    expect(row(r, '4980')!.consolidated).toBe('0.0000');
    expect(row(r, '6970')!.consolidated).toBe('0.0000');
    // Investment 180,000 against 80% x 200,000 equity: goodwill 20,000, NCI 40,000 at acquisition.
    expect(row(r, '1700')!.combined).toBe('180000.0000');
    expect(row(r, '1700')!.consolidated).toBe('0.0000');
    expect(row(r, '1710')!.consolidated).toBe('20000.0000');
    expect(row(r, '3400')!.consolidated).toBe('40000.0000');
    expect(row(r, '3100')!.byCompany[otherCompanyId]).toBe('200000.0000');
    expect(row(r, '3100')!.adjustments).toBe('-200000.0000');
    expect(r.totals.balanced).toBe(true);
    expect(r.totals.difference).toBe('0.0000');
    expect(r.totals.profitAttributableToNci).toBe('66400.0000'); // 20% of 332,000
    expect(r.totals.translationAdjustment).toBe('0.0000'); // same currency
    expect(
      r.readiness.items.find((i: { key: string }) => i.key === 'INTERCOMPANY_MATCHED').ok,
    ).toBe(true);
    // A second run to the same date is refused; reopen instead.
    const dup = await as(accountant, http().post(`/api/v1/consolidation/groups/${groupId}/runs`))
      .send({ periodEnd: '2026-08-31' })
      .expect(422);
    expect(dup.body.code).toBe('DOCUMENT_INVALID_STATE');
    const statements = await as(
      viewer,
      http().get(`/api/v1/consolidation/runs/${runId}/statements`),
    ).expect(200);
    const bs = statements.body.balanceSheet.totals;
    expect(bs.balanced).toBe(true);
    expect(bs.liabilitiesAndEquity).toBe(bs.assets);
    expect(bs.nonControllingInterest).toBe('106400.0000'); // 40,000 at acquisition + 66,400 share of profit
    expect(bs.currentEarnings).toBe(statements.body.incomeStatement.totals.attributableToParent);
    expect(statements.body.incomeStatement.totals.netIncome).toBe(r.totals.netIncome);
    const list = await as(admin, http().get('/api/v1/consolidation/runs?status=DRAFT')).expect(200);
    expect(list.body.items[0].id).toBe(runId);
    expect(list.body.items[0].adjustmentCount).toBe(2);
    await expectIntegrity();
  });

  it('manual adjustments must balance, change the consolidated figures, and can be voided', async () => {
    const unbalanced = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/adjustments`),
    )
      .send({
        description: 'Bad',
        lines: [
          { accountCode: '6900', debit: '1000' },
          { accountCode: '1710', credit: '900' },
        ],
      })
      .expect(422);
    expect(unbalanced.body.code).toBe('JOURNAL_UNBALANCED');
    const unknown = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/adjustments`),
    )
      .send({
        description: 'Bad',
        lines: [
          { accountCode: '9999', debit: '1000' },
          { accountCode: '1710', credit: '1000' },
        ],
      })
      .expect(422);
    expect(unknown.body.code).toBe('VALIDATION_FAILED');
    const before = (await as(admin, http().get(`/api/v1/consolidation/runs/${runId}`)).expect(200))
      .body;
    const added = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/adjustments`),
    )
      .send({
        description: 'Goodwill impairment',
        reference: 'GW-2026-08',
        lines: [
          { accountCode: '6900', debit: '5000', description: 'Impairment' },
          { accountCode: '1710', credit: '5000' },
        ],
      })
      .expect(201);
    const manual = added.body.adjustments.find((a: { type: string }) => a.type === 'MANUAL');
    expect(manual.sequence).toBe(3);
    expect(manual.totalDebit).toBe('5000.0000');
    expect(row(added.body, '1710')!.consolidated).toBe('15000.0000');
    expect(Number(added.body.totals.netIncome)).toBeCloseTo(
      Number(before.totals.netIncome) - 5000,
      2,
    );
    expect(added.body.totals.balanced).toBe(true);
    // Re-preparing keeps the manual entry and regenerates the rule-driven ones.
    const prepared = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/prepare`),
    ).expect(201);
    expect(
      prepared.body.adjustments.filter((a: { status: string }) => a.status === 'ACTIVE'),
    ).toHaveLength(3);
    expect(row(prepared.body, '1710')!.consolidated).toBe('15000.0000');
    const voided = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/adjustments/${manual.id}/void`),
    )
      .send({ reason: 'Impairment test not concluded' })
      .expect(201);
    expect(voided.body.adjustments.find((a: { id: string }) => a.id === manual.id).status).toBe(
      'VOID',
    );
    expect(row(voided.body, '1710')!.consolidated).toBe('20000.0000');
    expect(voided.body.totals.netIncome).toBe(before.totals.netIncome);
    await expectIntegrity();
  });

  // ------------------------------------------------------------ group close

  it('finalizing is four-eyes and gated by readiness; a finalized run freezes the figures and locks the structure', async () => {
    await as(accountant, http().post(`/api/v1/consolidation/runs/${runId}/finalize`))
      .send({})
      .expect(403);
    // Require closed member periods: the demo periods are open, so the close is blocked.
    await as(admin, http().patch(`/api/v1/consolidation/groups/${groupId}`))
      .send({ requirePeriodsClosed: true })
      .expect(200);
    const blocked = await as(finance, http().post(`/api/v1/consolidation/runs/${runId}/finalize`))
      .send({})
      .expect(422);
    expect(blocked.body.code).toBe('CONSOLIDATION_NOT_READY');
    expect(blocked.body.details.blockers[0].key).toBe('PERIODS_CLOSED');
    const readiness = await as(
      admin,
      http().get(
        `/api/v1/consolidation/groups/${groupId}/readiness?periodStart=2026-01-01&periodEnd=2026-08-31`,
      ),
    ).expect(200);
    expect(readiness.body.ready).toBe(false);
    await as(admin, http().patch(`/api/v1/consolidation/groups/${groupId}`))
      .send({ requirePeriodsClosed: false })
      .expect(200);
    const finalized = await as(finance, http().post(`/api/v1/consolidation/runs/${runId}/finalize`))
      .send({ note: 'August group close' })
      .expect(201);
    expect(finalized.body.status).toBe('FINALIZED');
    expect(finalized.body.finalizedAt).toBeTruthy();
    expect(finalized.body.snapshotAt).toBeTruthy();
    expect(finalized.body.totals.balanced).toBe(true);
    expect(row(finalized.body, '1710')!.consolidated).toBe('20000.0000');
    // Frozen: no more adjustments, no structure changes covering the period.
    await as(accountant, http().post(`/api/v1/consolidation/runs/${runId}/adjustments`))
      .send({
        description: 'Late',
        lines: [
          { accountCode: '6900', debit: '1' },
          { accountCode: '1710', credit: '1' },
        ],
      })
      .expect(422);
    const member = (
      await as(admin, http().get(`/api/v1/consolidation/groups/${groupId}`)).expect(200)
    ).body.members.find((m: { companyCode: string }) => m.companyCode === 'ACMS');
    const locked = await as(
      admin,
      http().patch(`/api/v1/consolidation/groups/${groupId}/members/${member.id}`),
    )
      .send({ ownershipPercent: '75' })
      .expect(200);
    expect(
      locked.body.members.find((m: { id: string }) => m.id === member.id).ownershipPercent,
    ).toBe('75.0000'); // structure edits do not rewrite a finalized run...
    const rerun = await as(admin, http().get(`/api/v1/consolidation/runs/${runId}`)).expect(200);
    expect(row(rerun.body, '3400')!.consolidated).toBe('40000.0000'); // ...the frozen run still shows 80%
    await as(admin, http().patch(`/api/v1/consolidation/groups/${groupId}/members/${member.id}`))
      .send({ ownershipPercent: '80' })
      .expect(200);
    const removeBlocked = await as(
      admin,
      http().delete(`/api/v1/consolidation/groups/${groupId}/members/${member.id}`),
    ).expect(422);
    expect(removeBlocked.body.code).toBe('DOCUMENT_INVALID_STATE');
    const notes = await as(admin, http().get('/api/v1/notifications?limit=50')).expect(200);
    expect(
      (notes.body.items ?? notes.body).some(
        (n: { eventType: string }) => n.eventType === 'CONSOLIDATION_FINALIZED',
      ),
    ).toBe(true);
    const events = await pool.query<{ event_type: string }>(
      `select distinct event_type from integration_events where event_type like 'consolidation.%' or event_type like 'intercompany.%'`,
    );
    expect(events.rows.map((r) => r.event_type)).toContain('consolidation.finalized');
  });

  // ------------------------------------------------------------ intercompany

  let chargeId: string;

  it('an intercompany charge posted after the close shows as drift and as an open pair, and settles through both bank accounts', async () => {
    const created = await as(admin, http().post('/api/v1/intercompany'))
      .send({
        fromCompanyId: companyId,
        toCompanyId: otherCompanyId,
        transactionDate: '2026-08-25',
        description: 'Shared IT services - August',
        reference: 'IT-AUG',
        amount: '15000',
        fromAccountId: acc['6970'],
        toAccountId: otherAcc['4980'],
      })
      .expect(201);
    chargeId = created.body.id;
    const posted = await as(admin, http().post(`/api/v1/intercompany/${chargeId}/post`)).expect(
      201,
    );
    expect(posted.body.status).toBe('POSTED');
    const recon = await as(
      admin,
      http().get(
        `/api/v1/consolidation/intercompany-reconciliation?asOf=2026-08-31&groupId=${groupId}`,
      ),
    ).expect(200);
    expect(recon.body.pairs).toHaveLength(1);
    expect(recon.body.pairs[0]).toMatchObject({
      fromCompanyCode: 'ACME',
      toCompanyCode: 'ACMS',
      owed: '15000.0000',
      receivable: '15000.0000',
      status: 'MATCHED',
    });
    expect(recon.body.totals.entitiesWithDrift).toBe(0); // ledger agrees with the register
    // The finalized August run no longer reflects ACME's and ACMS's books.
    const report = await expectIntegrity();
    const drift = report.findings.find((f: { check: string }) => f.check === 'FINALIZED_RUN_DRIFT');
    expect(drift.count).toBe(1);
    expect(drift.samples[0].accounts).toEqual(expect.arrayContaining(['6970', '2180']));
    // Settle in cash: ACME pays from its BDO account, ACMS receives into its own.
    const acmeBanks = await as(admin, http().get('/api/v1/bank-accounts')).expect(200);
    const acmsBanks = await as(admin, http().get('/api/v1/bank-accounts'), otherCompanyId).expect(
      200,
    );
    const acmeBdo = acmeBanks.body.find((b: { code: string }) => b.code === 'BDO-MAIN');
    const acmsBdo = acmsBanks.body.find((b: { code: string }) => b.code === 'BDO-MAIN');
    // Wrong company's bank account is refused.
    await as(admin, http().post(`/api/v1/intercompany/${chargeId}/settle`))
      .send({
        settlementDate: '2026-08-28',
        fromBankAccountId: acmsBdo.id,
        toBankAccountId: acmeBdo.id,
      })
      .expect(404);
    const settled = await as(admin, http().post(`/api/v1/intercompany/${chargeId}/settle`))
      .send({
        settlementDate: '2026-08-28',
        fromBankAccountId: acmeBdo.id,
        toBankAccountId: acmsBdo.id,
        reference: 'IT-AUG-PAY',
      })
      .expect(201);
    expect(settled.body.status).toBe('SETTLED');
    expect(settled.body.settlementDate).toBe('2026-08-28');
    expect(settled.body.settlementFromJournalNumber).toMatch(/^JE-/);
    const fromLeg = await as(
      admin,
      http().get(`/api/v1/journal-entries/${settled.body.settlementFromJournalEntryId}`),
    ).expect(200);
    expect(fromLeg.body.sourceType).toBe('INTERCOMPANY_SETTLEMENT');
    expect(
      fromLeg.body.lines.find((l: { accountId: string }) => l.accountId === acc['2180']).debit,
    ).toBe('15000.0000');
    expect(
      fromLeg.body.lines.find((l: { accountId: string }) => l.accountId === acmeBdo.glAccountId)
        .credit,
    ).toBe('15000.0000');
    const toLeg = await as(
      admin,
      http().get(`/api/v1/journal-entries/${settled.body.settlementToJournalEntryId}`),
      otherCompanyId,
    ).expect(200);
    expect(
      toLeg.body.lines.find((l: { accountId: string }) => l.accountId === otherAcc['1290']).credit,
    ).toBe('15000.0000');
    await as(admin, http().post(`/api/v1/intercompany/${chargeId}/settle`))
      .send({
        settlementDate: '2026-08-28',
        fromBankAccountId: acmeBdo.id,
        toBankAccountId: acmsBdo.id,
      })
      .expect(422);
    const after = await as(
      admin,
      http().get('/api/v1/consolidation/intercompany-reconciliation?asOf=2026-08-31'),
    ).expect(200);
    expect(after.body.pairs).toHaveLength(0);
    expect(after.body.totals.entitiesWithDrift).toBe(0);
  });

  it('reopening the close (four-eyes) re-reads the books: the new fee is eliminated and drift clears', async () => {
    await as(accountant, http().post(`/api/v1/consolidation/runs/${runId}/reopen`))
      .send({ reason: 'x' })
      .expect(403);
    const reopened = await as(finance, http().post(`/api/v1/consolidation/runs/${runId}/reopen`))
      .send({ reason: 'Late August intercompany charge' })
      .expect(201);
    expect(reopened.body.status).toBe('DRAFT');
    expect(reopened.body.reopenReason).toBe('Late August intercompany charge');
    expect(reopened.body.snapshotAt).toBeNull();
    const prepared = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${runId}/prepare`),
    ).expect(201);
    expect(row(prepared.body, '4980')!.combined).toBe('75000.0000'); // 60,000 + 15,000 across both members
    expect(row(prepared.body, '4980')!.consolidated).toBe('0.0000');
    expect(row(prepared.body, '6970')!.consolidated).toBe('0.0000');
    expect(row(prepared.body, '1290')).toBeUndefined(); // settled: nothing left to eliminate
    expect(prepared.body.totals.balanced).toBe(true);
    expect(prepared.body.totals.profitAttributableToNci).toBe('69400.0000'); // 20% x (332,000 + 15,000)
    const finalized = await as(finance, http().post(`/api/v1/consolidation/runs/${runId}/finalize`))
      .send({ note: 'August group close, revised' })
      .expect(201);
    expect(finalized.body.status).toBe('FINALIZED');
    const report = await expectIntegrity();
    expect(
      report.findings.find((f: { check: string }) => f.check === 'FINALIZED_RUN_DRIFT').count,
    ).toBe(0);
    // A later run must be reopened before an earlier one.
    const sept = await as(accountant, http().post(`/api/v1/consolidation/groups/${groupId}/runs`))
      .send({ periodEnd: '2026-09-30' })
      .expect(201);
    await as(finance, http().post(`/api/v1/consolidation/runs/${sept.body.id}/finalize`))
      .send({})
      .expect(201);
    const chained = await as(finance, http().post(`/api/v1/consolidation/runs/${runId}/reopen`))
      .send({ reason: 'x' })
      .expect(422);
    expect(chained.body.code).toBe('DOCUMENT_INVALID_STATE');
    await as(finance, http().post(`/api/v1/consolidation/runs/${sept.body.id}/reopen`))
      .send({ reason: 'Not needed yet' })
      .expect(201);
  });

  // ------------------------------------------------------ structure / rules

  it('groups are configured from data: members, methods, rules and account codes are validated', async () => {
    await as(viewer, http().post('/api/v1/consolidation/groups'))
      .send({ code: 'X', name: 'x', parentCompanyId: companyId })
      .expect(403);
    const dup = await as(admin, http().post('/api/v1/consolidation/groups'))
      .send({ code: 'ACME-GROUP', name: 'Dup', parentCompanyId: companyId })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');
    const badCode = await as(admin, http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'TEST-GROUP',
        name: 'Test group',
        parentCompanyId: companyId,
        accounts: { goodwill: '9999' },
      })
      .expect(422);
    expect(badCode.body.code).toBe('VALIDATION_FAILED');
    const created = await as(finance, http().post('/api/v1/consolidation/groups'))
      .send({
        code: 'TEST-GROUP',
        name: 'Test group',
        parentCompanyId: companyId,
        translationMethod: 'CLOSING_RATE',
        intercompanyTolerance: '100',
      })
      .expect(201);
    expect(created.body.members).toHaveLength(1);
    expect(created.body.members[0].isParent).toBe(true);
    expect(created.body.accounts.investment).toBe('1700'); // resolved from the parent's mappings
    const selfMember = await as(
      admin,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/members`),
    )
      .send({ companyId, ownershipPercent: '50' })
      .expect(422);
    expect(selfMember.body.code).toBe('VALIDATION_FAILED');
    const associate = await as(
      admin,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/members`),
    )
      .send({
        companyId: otherCompanyId,
        method: 'EQUITY',
        ownershipPercent: '30',
        acquisitionDate: '2026-01-05',
      })
      .expect(201);
    expect(
      associate.body.members.find((m: { companyCode: string }) => m.companyCode === 'ACMS').method,
    ).toBe('EQUITY');
    const defaults = await as(
      admin,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/rules/defaults`),
    ).expect(201);
    expect(defaults.body.map((r: { code: string }) => r.code)).toEqual([
      'IC-BALANCES',
      'INVESTMENT',
    ]);
    const badRule = await as(
      admin,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/rules`),
    )
      .send({
        code: 'URP',
        name: 'Unrealized profit',
        type: 'UNREALIZED_PROFIT',
        config: { amount: '100' },
      })
      .expect(400);
    expect(badRule.status).toBe(400);
    const custom = await as(
      admin,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/rules`),
    )
      .send({
        code: 'RECLASS',
        name: 'Reclassify',
        type: 'CUSTOM',
        config: {
          lines: [
            { accountCode: '6900', debit: '100' },
            { accountCode: '6980', credit: '100' },
          ],
        },
      })
      .expect(201);
    expect(custom.body.active).toBe(true);
    // Equity method: the associate contributes only 30% of its result.
    const run = await as(
      accountant,
      http().post(`/api/v1/consolidation/groups/${created.body.id}/runs`),
    )
      .send({ periodEnd: '2026-08-31' })
      .expect(201);
    expect(
      run.body.members.map((m: { code: string; method: string }) => [m.code, m.method]),
    ).toEqual([
      ['ACME', 'FULL'],
      ['ACMS', 'EQUITY'],
    ]);
    expect(row(run.body, '3100')!.byCompany[otherCompanyId]).toBeUndefined();
    const pickup = run.body.adjustments.find((a: { type: string }) => a.type === 'EQUITY_PICKUP');
    expect(pickup.lines.find((l: { accountCode: string }) => l.accountCode === '4950').credit).toBe(
      '104100.0000',
    ); // 30% x 347,000
    expect(row(run.body, '4950')!.consolidated).toBe('104100.0000');
    expect(row(run.body, '6980')!.consolidated).toBe('-100.0000'); // the custom reclass
    expect(run.body.totals.balanced).toBe(true);
    const off = await as(
      admin,
      http().patch(`/api/v1/consolidation/groups/${created.body.id}/rules/${custom.body.id}`),
    )
      .send({ active: false })
      .expect(200);
    expect(off.body.active).toBe(false);
    const again = await as(
      accountant,
      http().post(`/api/v1/consolidation/runs/${run.body.id}/prepare`),
    ).expect(201);
    expect(row(again.body, '6980')).toBeUndefined();
    await as(admin, http().patch(`/api/v1/consolidation/groups/${created.body.id}`))
      .send({ status: 'INACTIVE' })
      .expect(200);
    await as(accountant, http().post(`/api/v1/consolidation/groups/${created.body.id}/runs`))
      .send({ periodEnd: '2026-07-31' })
      .expect(422);
    await expectIntegrity();
  });
});
