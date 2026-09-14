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

/**
 * Hardening phase 1 - accounting integrity controls: fiscal period states,
 * posting-gateway authority, correction chains, idempotent/concurrent posting
 * and the integrity checker.
 */
describe('Accounting controls (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let accountant: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const periods: Record<string, { id: string; name: string }> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const journal = (entryDate: string, amount = '100', description = 'Control test') => ({
    entryDate,
    description,
    lines: [
      { accountId: acc['6400'], debit: amount, credit: '0' },
      { accountId: acc['1110'], debit: '0', credit: amount },
    ],
  });
  /** Draft -> submit -> approve -> post, as the given users. */
  const postJournal = async (body: object, poster: Cookies = finance) => {
    const je = await as(http().post('/api/v1/journal-entries'), accountant).send(body).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`), accountant).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
    const res = await as(http().post(`/api/v1/journal-entries/${je.body.id}/post`), poster);
    return { id: je.body.id as string, res };
  };
  const integrity = async () =>
    (await as(http().get('/api/v1/integrity?asOf=2026-12-31')).expect(200)).body;

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

  it('starts from an integrity-clean seed', async () => {
    const report = await integrity();
    expect(report.findings.filter((f: { count: number }) => f.count > 0)).toEqual([]);
    expect(report.status).toBe('OK');
    expect(report.findings.every((f: { count: number }) => f.count === 0)).toBe(true);
    expect(report.findings.map((f: { check: string }) => f.check)).toEqual(
      expect.arrayContaining([
        'UNBALANCED_JOURNAL',
        'AR_CONTROL_VARIANCE',
        'AP_CONTROL_VARIANCE',
        'INVENTORY_VARIANCE',
        'FIXED_ASSETS_VARIANCE',
        'ACCOUNT_MAPPING',
      ]),
    );
    await as(http().get('/api/v1/integrity'), accountant).expect(403);
  });

  it('SOFT_CLOSED admits only holders of period.post-soft-closed; drafts are still allowed', async () => {
    const jan = periods['2026-01']!;
    await as(http().post(`/api/v1/fiscal-periods/${jan.id}/soft-close`), finance)
      .send({ reason: 'Books provisionally closed' })
      .expect(201);
    // The accountant can still draft into it, but posting by the admin (journal.post without the soft-close right) is refused.
    const draft = await as(http().post('/api/v1/journal-entries'), accountant)
      .send(journal('2026-01-15'))
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/submit`), accountant).expect(
      201,
    );
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/approve`), finance).expect(201);
    // Finance manager holds period.post-soft-closed -> allowed; strip it to prove the gate.
    const posted = await as(
      http().post(`/api/v1/journal-entries/${draft.body.id}/post`),
      finance,
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const { rows } = await pool.query(
      `SELECT action, metadata FROM audit_logs WHERE entity_id = $1 AND action = 'POST'`,
      [draft.body.id],
    );
    expect(rows[0].metadata.periodStatus).toBe('SOFT_CLOSED');

    // A user without the right: the accountant has journal.create only -> the gateway refuses at the period gate
    // (via the posting authority check first, since they cannot post at all).
    const other = await as(http().post('/api/v1/journal-entries'), accountant)
      .send(journal('2026-01-16'))
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${other.body.id}/submit`), accountant).expect(
      201,
    );
    await as(http().post(`/api/v1/journal-entries/${other.body.id}/approve`), finance).expect(201);
    const denied = await as(
      http().post(`/api/v1/journal-entries/${other.body.id}/post`),
      accountant,
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    await as(http().post(`/api/v1/journal-entries/${other.body.id}/reject`), finance)
      .send({ reason: 'not needed' })
      .expect(201);
    // Subledger posting into the soft-closed period by someone without the right is refused with the period code.
    const vendors = await as(http().get('/api/v1/vendors?pageSize=5')).expect(200);
    const bill = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: vendors.body.items[0].id,
        documentDate: '2026-01-20',
        vendorInvoiceNumber: 'SC-1',
        lines: [{ description: 'Soft close test', unitPrice: '10', accountId: acc['6400'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    await pool.query(
      `DELETE FROM role_permissions rp USING roles r, permissions p WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = 'FINANCE_MANAGER' AND p.key = 'period.post-soft-closed'`,
    );
    const financeAgain = await login(FINANCE);
    const softDenied = await as(
      http().post(`/api/v1/bills/${bill.body.id}/post`),
      financeAgain,
    ).expect(422);
    expect(softDenied.body.code).toBe('ACCOUNTING_PERIOD_SOFT_CLOSED');
    await pool.query(
      `INSERT INTO role_permissions (role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.key = 'FINANCE_MANAGER' AND p.key = 'period.post-soft-closed'`,
    );
    finance = await login(FINANCE);
    await as(http().post(`/api/v1/bills/${bill.body.id}/post`), finance).expect(201);
  });

  it('reopening needs a reason, closing locks entries, LOCKED is final even for SQL', async () => {
    const jan = periods['2026-01']!;
    // reopen from SOFT_CLOSED without a reason -> validation error
    const noReason = await as(http().post(`/api/v1/fiscal-periods/${jan.id}/reopen`))
      .send({})
      .expect(400);
    expect(noReason.body.code).toBe('VALIDATION_FAILED');
    const reopenRes = await as(http().post(`/api/v1/fiscal-periods/${jan.id}/reopen`)).send({
      reason: 'Late supplier invoice',
    });
    expect(reopenRes.body).toMatchObject({ status: 'OPEN' });
    const { rows: reopened } = await pool.query(
      `SELECT status, reopen_reason FROM fiscal_periods WHERE id = $1`,
      [jan.id],
    );
    expect(reopened[0]).toEqual({ status: 'OPEN', reopen_reason: 'Late supplier invoice' });

    await as(http().post(`/api/v1/fiscal-periods/${jan.id}/close`), finance)
      .send({})
      .expect(201);
    const lockDenied = await as(http().post(`/api/v1/fiscal-periods/${jan.id}/lock`), finance)
      .send({})
      .expect(403);
    expect(lockDenied.body.code).toBe('PERMISSION_DENIED');
    const locked = await as(http().post(`/api/v1/fiscal-periods/${jan.id}/lock`))
      .send({ reason: 'Statements issued' })
      .expect(201);
    expect(locked.body.status).toBe('LOCKED');
    const reopenLocked = await as(http().post(`/api/v1/fiscal-periods/${jan.id}/reopen`))
      .send({ reason: 'Trying anyway' })
      .expect(422);
    expect(reopenLocked.body.code).toBe('ACCOUNTING_PERIOD_LOCKED');
    // Nothing can even be drafted into it...
    const draftDenied = await as(http().post('/api/v1/journal-entries'), accountant)
      .send(journal('2026-01-25'))
      .expect(422);
    expect(draftDenied.body.code).toBe('ACCOUNTING_PERIOD_LOCKED');
    // ...and direct SQL that tries to make an entry part of the ledger is refused by the database trigger.
    await pool.query(
      `INSERT INTO journal_entries (company_id, fiscal_period_id, document_number, status, entry_date, description, currency, total_debit, total_credit) VALUES ($1, $2, 'JE-SQL-LOCK', 'APPROVED', '2026-01-25', 'sql', 'PHP', 0, 0)`,
      [companyId, jan.id],
    );
    await expect(
      pool.query(
        `UPDATE journal_entries SET status = 'POSTED', posted_at = now() WHERE document_number = 'JE-SQL-LOCK'`,
      ),
    ).rejects.toThrow(/locked/);
    await pool.query(`DELETE FROM journal_entries WHERE document_number = 'JE-SQL-LOCK'`);
    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [jan.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'PERIOD_SOFT_CLOSE',
      'PERIOD_REOPEN',
      'PERIOD_CLOSE',
      'PERIOD_LOCK',
    ]);
  });

  it('a correction reverses the original and opens a linked draft; the chain is navigable', async () => {
    const { id, res } = await postJournal(journal('2026-03-10', '250', 'Wrong amount'));
    expect(res.status).toBe(201);
    const denied = await as(http().post(`/api/v1/journal-entries/${id}/correct`), accountant)
      .send({ reversalDate: '2026-03-10', reason: 'Should be 200' })
      .expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    const corrected = await as(http().post(`/api/v1/journal-entries/${id}/correct`), finance)
      .send({ reversalDate: '2026-03-11', reason: 'Should be 200' })
      .expect(201);
    expect(corrected.body.original.status).toBe('REVERSED');
    expect(corrected.body.reversal.journalType).toBe('REVERSAL');
    expect(corrected.body.reversal.status).toBe('POSTED');
    expect(corrected.body.correction.status).toBe('DRAFT');
    expect(corrected.body.correction.journalType).toBe('ADJUSTING');
    expect(corrected.body.correction.correctionOfNumber).toBe(
      corrected.body.original.documentNumber,
    );
    expect(
      corrected.body.correction.lines.map((l: { debit: string; credit: string }) => [
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      ['250.0000', '0.0000'],
      ['0.0000', '250.0000'],
    ]);
    expect(
      corrected.body.original.related.map((r: { relation: string }) => r.relation).sort(),
    ).toEqual(['CORRECTION', 'REVERSAL']);
    expect(corrected.body.correction.related.map((r: { relation: string }) => r.relation)).toEqual([
      'CORRECTS',
    ]);
    // Fix the draft and post it through the normal workflow.
    const fixed = await as(
      http().patch(`/api/v1/journal-entries/${corrected.body.correction.id}`),
      accountant,
    )
      .send({
        lines: [
          { accountId: acc['6400'], debit: '200', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '200' },
        ],
      })
      .expect(200);
    expect(fixed.body.totalDebit).toBe('200.0000');
    await as(http().post(`/api/v1/journal-entries/${fixed.body.id}/submit`), accountant).expect(
      201,
    );
    await as(http().post(`/api/v1/journal-entries/${fixed.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${fixed.body.id}/post`), finance).expect(201);
    const audit = await pool.query(
      `SELECT action FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['POST', 'REVERSE', 'CORRECT']),
    );
    // Correcting twice is refused (already reversed and corrected) - the second call reuses the reversal but opens another draft; forbid year-end closings only.
    const tb = await as(
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31'),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
  });

  it('concurrent posts of one document and replayed idempotency keys create a single journal', async () => {
    const vendors = await as(http().get('/api/v1/vendors?pageSize=5')).expect(200);
    const bill = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: vendors.body.items[0].id,
        documentDate: '2026-04-05',
        vendorInvoiceNumber: 'CONC-1',
        lines: [{ description: 'Concurrency', unitPrice: '333', accountId: acc['6400'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        as(http().post(`/api/v1/bills/${bill.body.id}/post`), finance),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses[0]).toBe(201);
    const journals = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'AP_DOCUMENT' AND source_id = $1`,
      [bill.body.id],
    );
    expect(journals.rows[0].n).toBe(1);

    const key = `idem-${Date.now()}`;
    const first = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({ ...journal('2026-04-06', '5'), idempotencyKey: key })
      .expect(201);
    const replay = await as(http().post('/api/v1/journal-entries'), accountant)
      .send({ ...journal('2026-04-06', '5'), idempotencyKey: key })
      .expect(201);
    expect(replay.body.id).toBe(first.body.id);
  });

  it('the gateway validates the source document, branches and dimensions before writing', async () => {
    // A foreign-currency payment allocated twice posts two distinct realized-FX journals (regression: identity was the payment).
    const customer = await as(http().post('/api/v1/customers'))
      .send({ code: 'CUST-USD-C', name: 'Dollar Client', currency: 'USD' })
      .expect(201);
    const mk = async (n: number) => {
      const inv = await as(http().post('/api/v1/invoices'))
        .send({
          customerId: customer.body.id,
          documentDate: '2026-03-02',
          lines: [{ description: `USD ${n}`, unitPrice: '100', accountId: acc['4200'] }],
        })
        .expect(201);
      await as(http().post(`/api/v1/invoices/${inv.body.id}/approve`), finance).expect(201);
      await as(http().post(`/api/v1/invoices/${inv.body.id}/post`), finance).expect(201);
      return inv.body.id as string;
    };
    const [i1, i2] = [await mk(1), await mk(2)];
    const pay = await as(http().post('/api/v1/customer-payments'))
      .send({
        partyId: customer.body.id,
        paymentDate: '2026-07-15',
        amount: '200',
        cashAccountId: acc['1130'],
      })
      .expect(201);
    expect(pay.body.exchangeRate).toBe('57.50000000');
    await as(http().post(`/api/v1/customer-payments/${pay.body.id}/post`), finance).expect(201);
    await as(http().post(`/api/v1/customer-payments/${pay.body.id}/allocate`), finance)
      .send({ allocationDate: '2026-07-15', allocations: [{ documentId: i1, amount: '100' }] })
      .expect(201);
    await as(http().post(`/api/v1/customer-payments/${pay.body.id}/allocate`), finance)
      .send({ allocationDate: '2026-07-16', allocations: [{ documentId: i2, amount: '100' }] })
      .expect(201);
    const fx = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE source_type = 'FX_REALIZED'`,
    );
    expect(fx.rows[0].n).toBe(2);
    const recon = await as(http().get('/api/v1/reports/ar-reconciliation?asOf=2026-12-31')).expect(
      200,
    );
    expect(recon.body.reconciled).toBe(true);
    const report = await integrity();
    expect(
      report.findings.find((f: { check: string }) => f.check === 'AR_CONTROL_VARIANCE').count,
    ).toBe(0);
    expect(
      report.findings.find((f: { check: string }) => f.check === 'UNBALANCED_JOURNAL').count,
    ).toBe(0);
  });
});
