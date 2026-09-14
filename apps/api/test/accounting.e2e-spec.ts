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
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

type Cookies = string[];

/**
 * Phase 2 - Accounting core. Runs against the seeded ACME company on
 * accounting_test and verifies the critical invariants end to end.
 */
describe('Accounting core (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
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
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(admin, http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------ chart of accounts

  it('requires the company context for accounting endpoints', async () => {
    const res = await http().get('/api/v1/accounts').set('Cookie', admin).expect(403);
    expect(res.body.code).toBe('COMPANY_CONTEXT_REQUIRED');
  });

  it('returns the chart as an ordered tree with levels', async () => {
    const res = await as(admin, http().get('/api/v1/accounts')).expect(200);
    const codes = res.body.map((a: { code: string }) => a.code);
    expect(codes.indexOf('1000')).toBeLessThan(codes.indexOf('1100'));
    expect(codes.indexOf('1100')).toBeLessThan(codes.indexOf('1110'));
    expect(res.body.find((a: { code: string }) => a.code === '1110').level).toBe(2);
    expect(res.body.find((a: { code: string }) => a.code === '1000').isHeader).toBe(true);
  });

  it('creates accounts under a compatible parent and rejects type mismatches', async () => {
    const ok = await as(admin, http().post('/api/v1/accounts'))
      .send({
        code: '1140',
        name: 'Cash in Bank - BPI',
        type: 'ASSET',
        subtype: 'BANK',
        parentId: acc['1100'],
      })
      .expect(201);
    expect(ok.body.normalBalance).toBe('DEBIT');
    acc['1140'] = ok.body.id;

    const bad = await as(admin, http().post('/api/v1/accounts'))
      .send({ code: '1141', name: 'Wrong', type: 'EXPENSE', parentId: acc['1100'] })
      .expect(422);
    expect(bad.body.code).toBe('ACCOUNT_HIERARCHY_INVALID');

    const dup = await as(admin, http().post('/api/v1/accounts'))
      .send({ code: '1140', name: 'Dup', type: 'ASSET' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');
  });

  it('refuses to delete an account with activity and refuses to deactivate a system account', async () => {
    const del = await as(admin, http().delete(`/api/v1/accounts/${acc['1130']}`)).expect(422);
    expect(del.body.code).toBe('ACCOUNT_HAS_ACTIVITY');
    const sys = await as(admin, http().patch(`/api/v1/accounts/${acc['3200']}`))
      .send({ status: 'INACTIVE' })
      .expect(422);
    expect(sys.body.code).toBe('FORBIDDEN');
    // A never-used account can be deleted.
    await as(admin, http().delete(`/api/v1/accounts/${acc['1140']}`)).expect(204);
  });

  // ------------------------------------------------------------ journal lifecycle

  let entryId: string;

  it('rejects unbalanced journal entries at creation', async () => {
    const res = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-04-10',
        description: 'Unbalanced',
        lines: [
          { accountId: acc['6400'], debit: '100', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '90' },
        ],
      })
      .expect(422);
    expect(res.body.code).toBe('JOURNAL_UNBALANCED');
    expect(res.body.details.difference).toBe('10.0000');
  });

  it('rejects posting to header, inactive or foreign accounts', async () => {
    const header = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-04-10',
        description: 'Header',
        lines: [
          { accountId: acc['1000'], debit: '100', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '100' },
        ],
      })
      .expect(422);
    expect(header.body.code).toBe('ACCOUNT_NOT_POSTABLE');
  });

  it('creates a balanced draft with a sequential document number (idempotent on key)', async () => {
    const body = {
      entryDate: '2026-04-10',
      description: 'Office supplies purchased in cash',
      reference: 'PCV-0009',
      idempotencyKey: 'test-key-000001',
      lines: [
        { accountId: acc['6400'], debit: '1250.50', credit: '0', description: 'Bond paper' },
        { accountId: acc['1110'], debit: '0', credit: '1250.50' },
      ],
    };
    const first = await as(accountant, http().post('/api/v1/journal-entries'))
      .send(body)
      .expect(201);
    expect(first.body.status).toBe('DRAFT');
    expect(first.body.documentNumber).toMatch(/^JE-2026-\d{6}$/);
    expect(first.body.totalDebit).toBe('1250.5000');
    expect(first.body.lines).toHaveLength(2);
    entryId = first.body.id;

    const replay = await as(accountant, http().post('/api/v1/journal-entries'))
      .send(body)
      .expect(201);
    expect(replay.body.id).toBe(entryId);
  });

  it('enforces the lifecycle: cannot post a draft, cannot approve without submission', async () => {
    const post = await as(finance, http().post(`/api/v1/journal-entries/${entryId}/post`)).expect(
      422,
    );
    expect(post.body.code).toBe('JOURNAL_INVALID_STATE');
    const approve = await as(
      finance,
      http().post(`/api/v1/journal-entries/${entryId}/approve`),
    ).expect(422);
    expect(approve.body.code).toBe('JOURNAL_INVALID_STATE');
  });

  it('accountant submits; accountant lacks approve permission; finance approves and posts', async () => {
    await as(accountant, http().post(`/api/v1/journal-entries/${entryId}/submit`)).expect(201);
    const denied = await as(
      accountant,
      http().post(`/api/v1/journal-entries/${entryId}/approve`),
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');

    const approved = await as(
      finance,
      http().post(`/api/v1/journal-entries/${entryId}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.sodWarnings).toEqual([]);

    const posted = await as(finance, http().post(`/api/v1/journal-entries/${entryId}/post`)).expect(
      201,
    );
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.postingDate).toBe('2026-04-10');
    // Approver == poster triggers the WARN policy (journal.approve vs journal.post).
    expect(posted.body.sodWarnings.map((w: { permissionB: string }) => w.permissionB)).toContain(
      'journal.post',
    );

    const again = await as(finance, http().post(`/api/v1/journal-entries/${entryId}/post`)).expect(
      201,
    );
    expect(again.body.status).toBe('POSTED');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'POST' AND entity_id = $1`,
      [entryId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('posted entries are immutable through the API and the database', async () => {
    const edit = await as(accountant, http().patch(`/api/v1/journal-entries/${entryId}`))
      .send({ description: 'x' })
      .expect(422);
    expect(edit.body.code).toBe('JOURNAL_INVALID_STATE');
    await as(accountant, http().delete(`/api/v1/journal-entries/${entryId}`)).expect(422);
    await expect(
      pool.query(`UPDATE journal_entries SET total_debit = 1 WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`UPDATE journal_lines SET debit = 1 WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`DELETE FROM journal_lines WHERE journal_entry_id = $1`, [entryId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`DELETE FROM journal_entries WHERE id = $1`, [entryId]),
    ).rejects.toThrow(/cannot be deleted/);
  });

  it('SoD BLOCK policy stops the same user from creating and approving one document', async () => {
    const policies = await http().get('/api/v1/sod-policies').set('Cookie', admin).expect(200);
    const policy = policies.body.find(
      (p: { permissionA: string; permissionB: string }) =>
        p.permissionA === 'journal.create' && p.permissionB === 'journal.approve',
    );
    await http()
      .put(`/api/v1/sod-policies/${policy.id}`)
      .set('Cookie', admin)
      .set(CSRF)
      .send({ ...policy, description: undefined, enforcement: 'BLOCK' })
      .expect(200);

    const created = await as(admin, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-04-11',
        description: 'SoD test',
        lines: [
          { accountId: acc['6900'], debit: '10', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '10' },
        ],
      })
      .expect(201);
    await as(admin, http().post(`/api/v1/journal-entries/${created.body.id}/submit`)).expect(201);
    const blocked = await as(
      admin,
      http().post(`/api/v1/journal-entries/${created.body.id}/approve`),
    ).expect(422);
    expect(blocked.body.code).toBe('SOD_VIOLATION');
    // A different approver is fine.
    await as(finance, http().post(`/api/v1/journal-entries/${created.body.id}/approve`)).expect(
      201,
    );
    await as(admin, http().post(`/api/v1/journal-entries/${created.body.id}/reject`))
      .send({ reason: 'Not needed' })
      .expect(201);
    const rejected = await as(
      admin,
      http().get(`/api/v1/journal-entries/${created.body.id}`),
    ).expect(200);
    expect(rejected.body.status).toBe('REJECTED');
    expect(rejected.body.rejectionReason).toBe('Not needed');
    await as(admin, http().delete(`/api/v1/journal-entries/${created.body.id}`)).expect(204);
    await http()
      .put(`/api/v1/sod-policies/${policy.id}`)
      .set('Cookie', admin)
      .set(CSRF)
      .send({ ...policy, description: undefined, enforcement: 'WARN' })
      .expect(200);
  });

  // ------------------------------------------------------------ ledger & reports

  it('trial balance balances and the balance sheet ties (A = L + E + earnings)', async () => {
    const tb = await as(
      admin,
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-04-30'),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.totals.periodDebit).toBe(tb.body.totals.periodCredit);
    expect(tb.body.totals.closingDebit).toBe(tb.body.totals.closingCredit);

    const bs = await as(admin, http().get('/api/v1/reports/balance-sheet?asOf=2026-04-30')).expect(
      200,
    );
    expect(bs.body.balanced).toBe(true);
    expect(bs.body.totalAssets).toBe(bs.body.totalLiabilitiesAndEquity);
    const accumulated = bs.body.assets.rows.find((r: { code: string }) => r.code === '1520');
    expect(accumulated.amount).toBe('-2000.0000');

    const is = await as(
      admin,
      http().get('/api/v1/reports/income-statement?from=2026-01-01&to=2026-04-30'),
    ).expect(200);
    expect(is.body.revenue.total).toBe('312000.0000');
    expect(is.body.costOfSales.total).toBe('60000.0000');
    expect(is.body.grossProfit).toBe('252000.0000');
    expect(is.body.expenses.total).toBe('125950.5000'); // seed 124,700 + 1,250.50 posted above
    expect(is.body.netIncome).toBe('126049.5000');
    expect(bs.body.currentEarnings).toBe(is.body.netIncome);
  });

  it('general ledger shows running balances and drills to journal entries', async () => {
    const gl = await as(
      admin,
      http().get(`/api/v1/general-ledger?accountId=${acc['1110']}&from=2026-01-01&to=2026-04-30`),
    ).expect(200);
    expect(gl.body.openingBalance).toBe('0.0000');
    expect(gl.body.closingBalance).toBe('-1250.5000'); // cash on hand credited without prior balance (seed has no opening)
    const last = gl.body.lines[gl.body.lines.length - 1];
    expect(last.journalEntryId).toBe(entryId);
    expect(last.balance).toBe(gl.body.closingBalance);

    const tbRow = (
      await as(
        admin,
        http().get('/api/v1/reports/trial-balance?from=2026-04-01&to=2026-04-30'),
      ).expect(200)
    ).body.rows.find((r: { code: string }) => r.code === '6400');
    expect(tbRow.periodDebit).toBe('1250.5000');
  });

  // ------------------------------------------------------------ periods

  let periods: Array<{ id: string; name: string; periodNumber: number; status: string }>;
  let yearId: string;

  it('closes periods sequentially and blocks when unposted entries exist', async () => {
    const years = await as(admin, http().get('/api/v1/fiscal-years')).expect(200);
    const fy = years.body.find((y: { name: string }) => y.name === 'FY2026');
    yearId = fy.id;
    periods = fy.periods;
    const [jan, feb, mar, apr] = periods;

    const outOfOrder = await as(finance, http().post(`/api/v1/fiscal-periods/${feb!.id}/close`))
      .send({})
      .expect(422);
    expect(outOfOrder.body.code).toBe('PERIOD_SEQUENCE_VIOLATION');

    await as(finance, http().post(`/api/v1/fiscal-periods/${jan!.id}/close`))
      .send({})
      .expect(201);
    await as(finance, http().post(`/api/v1/fiscal-periods/${feb!.id}/close`))
      .send({})
      .expect(201);
    await as(finance, http().post(`/api/v1/fiscal-periods/${mar!.id}/close`))
      .send({})
      .expect(201);

    // April holds the seeded SUBMITTED entry.
    const blocked = await as(finance, http().post(`/api/v1/fiscal-periods/${apr!.id}/close`))
      .send({})
      .expect(422);
    expect(blocked.body.code).toBe('PERIOD_HAS_UNPOSTED_ENTRIES');

    const { rows } = await pool.query(
      `SELECT status FROM journal_entries WHERE fiscal_period_id = $1`,
      [jan!.id],
    );
    expect(rows.every((r) => r.status === 'LOCKED')).toBe(true);
  });

  it('rejects postings into a closed period and allows them again after reopening', async () => {
    const attempt = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-01-15',
        description: 'Late',
        lines: [
          { accountId: acc['6900'], debit: '5', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '5' },
        ],
      })
      .expect(422);
    expect(attempt.body.code).toBe('ACCOUNTING_PERIOD_CLOSED');

    const [, , mar] = periods;
    const reopenDenied = await as(finance, http().post(`/api/v1/fiscal-periods/${mar!.id}/reopen`))
      .send({})
      .expect(403);
    expect(reopenDenied.body.code).toBe('PERMISSION_DENIED');
    await as(admin, http().post(`/api/v1/fiscal-periods/${mar!.id}/reopen`))
      .send({ reason: 'Late invoice' })
      .expect(201);
    const { rows } = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [mar!.id],
    );
    expect(rows.map((r) => r.action)).toEqual(['PERIOD_CLOSE', 'PERIOD_REOPEN']);

    const late = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-03-20',
        description: 'Late March expense',
        lines: [
          { accountId: acc['6900'], debit: '5', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '5' },
        ],
      })
      .expect(201);
    await as(accountant, http().delete(`/api/v1/journal-entries/${late.body.id}`)).expect(204);
    await as(finance, http().post(`/api/v1/fiscal-periods/${mar!.id}/close`))
      .send({})
      .expect(201);
  });

  // ------------------------------------------------------------ reversal

  it('reverses a locked entry with a mirror-image posted reversal', async () => {
    const list = await as(
      admin,
      http().get('/api/v1/journal-entries?search=Depreciation&pageSize=5'),
    ).expect(200);
    const original = list.body.items[0];
    expect(original.status).toBe('LOCKED');

    const reversal = await as(
      finance,
      http().post(`/api/v1/journal-entries/${original.id}/reverse`),
    )
      .send({ reversalDate: '2026-04-15' })
      .expect(201);
    expect(reversal.body.journalType).toBe('REVERSAL');
    expect(reversal.body.status).toBe('POSTED');
    expect(reversal.body.reversalOfId).toBe(original.id);
    const debits = reversal.body.lines
      .filter((l: { debit: string }) => l.debit !== '0.0000')
      .map((l: { accountCode: string }) => l.accountCode);
    expect(debits).toEqual(['1520']); // original debited 6500 / credited 1520

    const after = await as(admin, http().get(`/api/v1/journal-entries/${original.id}`)).expect(200);
    expect(after.body.status).toBe('REVERSED');
    expect(after.body.reversedByNumber).toBe(reversal.body.documentNumber);

    const twice = await as(finance, http().post(`/api/v1/journal-entries/${original.id}/reverse`))
      .send({ reversalDate: '2026-04-15' })
      .expect(422);
    expect(twice.body.code).toBe('JOURNAL_INVALID_STATE');

    const bs = await as(admin, http().get('/api/v1/reports/balance-sheet?asOf=2026-04-30')).expect(
      200,
    );
    expect(bs.body.balanced).toBe(true);
    expect(bs.body.assets.rows.find((r: { code: string }) => r.code === '1520')).toBeUndefined(); // net zero now
  });

  // ------------------------------------------------------------ year-end close

  it('closes the fiscal year with a closing entry and zeroes the income statement', async () => {
    // Post or reject every open document so periods can close.
    const open = await as(
      admin,
      http().get('/api/v1/journal-entries?status=SUBMITTED&pageSize=50'),
    ).expect(200);
    for (const e of open.body.items) {
      await as(finance, http().post(`/api/v1/journal-entries/${e.id}/approve`)).expect(201);
      await as(finance, http().post(`/api/v1/journal-entries/${e.id}/post`)).expect(201);
    }
    for (const p of periods.slice(3)) {
      await as(finance, http().post(`/api/v1/fiscal-periods/${p.id}/close`))
        .send({})
        .expect(201);
    }
    const before = await as(
      admin,
      http().get('/api/v1/reports/income-statement?from=2026-01-01&to=2026-12-31'),
    ).expect(200);
    const bsBefore = await as(
      admin,
      http().get('/api/v1/reports/balance-sheet?asOf=2026-12-31'),
    ).expect(200);

    const closed = await as(finance, http().post(`/api/v1/fiscal-years/${yearId}/close`)).expect(
      201,
    );
    expect(closed.body.status).toBe('CLOSED');

    const closing = await as(
      admin,
      http().get('/api/v1/journal-entries?journalType=CLOSING'),
    ).expect(200);
    expect(closing.body.total).toBe(1);
    expect(closing.body.items[0].status).toBe('LOCKED');
    expect(closing.body.items[0].entryDate).toBe('2026-12-31');

    const bsAfter = await as(
      admin,
      http().get('/api/v1/reports/balance-sheet?asOf=2026-12-31'),
    ).expect(200);
    expect(bsAfter.body.balanced).toBe(true);
    expect(bsAfter.body.currentEarnings).toBe('0.0000');
    const retained = bsAfter.body.equity.rows.find((r: { code: string }) => r.code === '3200');
    expect(retained.amount).toBe(before.body.netIncome);
    expect(bsAfter.body.totalAssets).toBe(bsBefore.body.totalAssets);

    const again = await as(finance, http().post(`/api/v1/fiscal-years/${yearId}/close`)).expect(
      422,
    );
    expect(again.body.code).toBe('FISCAL_YEAR_CLOSED');
    const reopen = await as(admin, http().post(`/api/v1/fiscal-periods/${periods[11]!.id}/reopen`))
      .send({})
      .expect(422);
    expect(reopen.body.code).toBe('FISCAL_YEAR_CLOSED');
  });

  it('creates the next fiscal year and rejects overlaps', async () => {
    const next = await as(admin, http().post('/api/v1/fiscal-years'))
      .send({ startDate: '2027-01-01' })
      .expect(201);
    expect(next.body.name).toBe('FY2027');
    expect(next.body.periods).toHaveLength(12);
    expect(next.body.periods[11].endDate).toBe('2027-12-31');
    const overlap = await as(admin, http().post('/api/v1/fiscal-years'))
      .send({ startDate: '2027-07-01' })
      .expect(422);
    expect(overlap.body.code).toBe('FISCAL_YEAR_OVERLAP');
  });
});
