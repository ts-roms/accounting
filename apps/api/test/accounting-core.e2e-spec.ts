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
 * Accounting core extensions (Prompt #2 gap closure): opening balances,
 * auto-reversing accruals, foreign-currency journals, recurring templates,
 * prepayment schedules, posting rules, dimension rules, other income /
 * expense, cash-flow statement, suspense monitor and the integrity checks
 * that cover them. Runs on a freshly migrated + seeded accounting_test.
 */
describe('Accounting core extensions (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  /** Draft -> submit (accountant) -> approve + post (finance). */
  const postThrough = async (entryId: string) => {
    await as(accountant, http().post(`/api/v1/journal-entries/${entryId}/submit`)).expect(201);
    await as(finance, http().post(`/api/v1/journal-entries/${entryId}/approve`)).expect(201);
    return (await as(finance, http().post(`/api/v1/journal-entries/${entryId}/post`)).expect(201))
      .body;
  };
  const ledgerNet = async (accountId: string, to: string): Promise<string> => {
    const res = await as(
      admin,
      http().get(`/api/v1/general-ledger?accountId=${accountId}&from=2026-01-01&to=${to}`),
    ).expect(200);
    return res.body.closingBalance;
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
    const dims = await as(admin, http().get('/api/v1/dimensions?dimensionType=PROJECT')).expect(
      200,
    );
    projectId = dims.body[0].id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------- chart of accounts

  it('exposes OTHER_INCOME / OTHER_EXPENSE types and the new account attributes', async () => {
    const res = await as(admin, http().get('/api/v1/accounts')).expect(200);
    const interest = res.body.find((a: { code: string }) => a.code === '7100');
    expect(interest.type).toBe('OTHER_INCOME');
    expect(interest.normalBalance).toBe('CREDIT');
    const suspense = res.body.find((a: { code: string }) => a.code === '1900');
    expect(suspense.subtype).toBe('SUSPENSE');
    expect(suspense.isReconciliation).toBe(true);

    const created = await as(admin, http().post('/api/v1/accounts'))
      .send({
        code: '8200',
        name: 'Bank Interest Expense',
        type: 'OTHER_EXPENSE',
        parentId: acc['8000'],
        cashFlowActivity: 'FINANCING',
        isReconciliation: true,
      })
      .expect(201);
    expect(created.body.cashFlowActivity).toBe('FINANCING');
    acc['8200'] = created.body.id;
  });

  // ------------------------------------------------------------- opening balances

  it('creates a balanced OPENING journal, offsetting the difference to opening balance equity', async () => {
    const res = await as(accountant, http().post('/api/v1/journal-entries/opening-balances'))
      .send({
        asOfDate: '2026-01-01',
        description: 'Migration opening balances',
        lines: [
          { accountId: acc['1110'], debit: '5000', credit: '0' },
          { accountId: acc['2210'], debit: '0', credit: '2000' },
        ],
      })
      .expect(201);
    expect(res.body.journalType).toBe('OPENING');
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.totalDebit).toBe(res.body.totalCredit);
    const offset = res.body.lines.find((l: { accountId: string }) => l.accountId === acc['3900']);
    expect(offset.credit).toBe('3000.0000');
    const posted = await postThrough(res.body.id);
    expect(posted.status).toBe('POSTED');
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE action = 'OPENING_BALANCE' AND entity_id = $1`,
      [res.body.id],
    );
    expect(rows[0].n).toBe(1);
  });

  // -------------------------------------------------------------------- accruals

  it('posts an accrual and its automatic reversal in the next period', async () => {
    const draft = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-03-31',
        description: 'Accrued audit fees',
        journalType: 'ACCRUAL',
        autoReverseDate: '2026-04-01',
        lines: [
          { accountId: acc['6300'], debit: '12000', credit: '0' },
          { accountId: acc['2120'], debit: '0', credit: '12000' },
        ],
      })
      .expect(201);
    expect(draft.body.autoReverseDate).toBe('2026-04-01');
    const posted = await postThrough(draft.body.id);
    expect(posted.status).toBe('REVERSED');
    expect(posted.reversedByNumber).toBeTruthy();
    const reversal = posted.related.find((r: { relation: string }) => r.relation === 'REVERSAL');
    expect(reversal.entryDate).toBe('2026-04-01');
    expect(reversal.status).toBe('POSTED');
    // The reversal is the exact mirror image, so the accrual nets to zero.
    const mirror = await as(admin, http().get(`/api/v1/journal-entries/${reversal.id}`)).expect(
      200,
    );
    expect(mirror.body.journalType).toBe('REVERSAL');
    expect(
      mirror.body.lines.map((l: { accountId: string; debit: string; credit: string }) => [
        l.accountId,
        l.debit,
        l.credit,
      ]),
    ).toEqual([
      [acc['6300'], '0.0000', '12000.0000'],
      [acc['2120'], '12000.0000', '0.0000'],
    ]);
    // Posting twice does not create a second reversal.
    await as(finance, http().post(`/api/v1/journal-entries/${draft.body.id}/post`)).expect(201);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE reversal_of_id = $1`,
      [draft.body.id],
    );
    expect(rows[0].n).toBe(1);
  });

  it('rejects an auto-reverse date on or before the entry date', async () => {
    const res = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-03-31',
        description: 'Bad accrual',
        journalType: 'ACCRUAL',
        autoReverseDate: '2026-03-31',
        lines: [
          { accountId: acc['6300'], debit: '1', credit: '0' },
          { accountId: acc['2120'], debit: '0', credit: '1' },
        ],
      })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  // --------------------------------------------------------- foreign-currency journals

  it('converts a USD journal to base at the table rate and keeps the foreign amounts', async () => {
    const res = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-10',
        description: 'USD consulting income received',
        transactionCurrency: 'USD',
        lines: [
          { accountId: acc['1130'], debit: '100', credit: '0' },
          { accountId: acc['4200'], debit: '0', credit: '100' },
        ],
      })
      .expect(201);
    expect(res.body.currency).toBe('PHP');
    expect(res.body.transactionCurrency).toBe('USD');
    expect(res.body.exchangeRate).toBe('56.00000000');
    expect(res.body.totalDebit).toBe('5600.0000');
    expect(res.body.lines[0].foreignDebit).toBe('100.0000');
    expect(res.body.lines[0].debit).toBe('5600.0000');

    const explicit = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-11',
        description: 'EUR at explicit rate with rounding',
        transactionCurrency: 'EUR',
        exchangeRate: '61.12345678',
        lines: [
          { accountId: acc['1130'], debit: '33.33', credit: '0' },
          { accountId: acc['1110'], debit: '33.33', credit: '0' },
          { accountId: acc['4200'], debit: '0', credit: '66.66' },
        ],
      })
      .expect(201);
    expect(explicit.body.totalDebit).toBe(explicit.body.totalCredit);

    const unbalanced = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-10',
        description: 'Unbalanced in USD',
        transactionCurrency: 'USD',
        lines: [
          { accountId: acc['1130'], debit: '100', credit: '0' },
          { accountId: acc['4200'], debit: '0', credit: '99' },
        ],
      })
      .expect(422);
    expect(unbalanced.body.code).toBe('JOURNAL_UNBALANCED');
  });

  // ------------------------------------------------------------- dimension rules

  it('blocks posting to an account whose rule requires a dimension the line lacks', async () => {
    const rules = await as(admin, http().get('/api/v1/accounting/dimension-rules')).expect(200);
    expect(rules.body.some((r: { accountCode: string }) => r.accountCode === '6150')).toBe(true);

    const draft = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-15',
        description: 'Consulting without project',
        lines: [
          { accountId: acc['6150'], debit: '500', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '500' },
        ],
      })
      .expect(201);
    await as(accountant, http().post(`/api/v1/journal-entries/${draft.body.id}/submit`)).expect(
      201,
    );
    await as(finance, http().post(`/api/v1/journal-entries/${draft.body.id}/approve`)).expect(201);
    const blocked = await as(
      finance,
      http().post(`/api/v1/journal-entries/${draft.body.id}/post`),
    ).expect(422);
    expect(blocked.body.code).toBe('DIMENSION_REQUIRED');

    // Adding the project makes it postable; a rule violation is visible to the integrity checker meanwhile.
    await as(finance, http().post(`/api/v1/journal-entries/${draft.body.id}/reject`))
      .send({ reason: 'Add the project' })
      .expect(201);
    await as(accountant, http().patch(`/api/v1/journal-entries/${draft.body.id}`))
      .send({
        lines: [
          { accountId: acc['6150'], debit: '500', credit: '0', projectId },
          { accountId: acc['1110'], debit: '0', credit: '500' },
        ],
      })
      .expect(200);
    const posted = await postThrough(draft.body.id);
    expect(posted.status).toBe('POSTED');
  });

  it('enforces branch applicability on accounts restricted to branches', async () => {
    const branches = await as(admin, http().get('/api/v1/branches')).expect(200);
    const [main, other] = branches.body as Array<{ id: string }>;
    await as(admin, http().patch(`/api/v1/accounts/${acc['1120']}`))
      .send({ allowedBranchIds: [main!.id] })
      .expect(200);
    const wrong = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-16',
        description: 'Petty cash from the wrong branch',
        branchId: other?.id ?? main!.id,
        lines: [
          { accountId: acc['6400'], debit: '10', credit: '0' },
          { accountId: acc['1120'], debit: '0', credit: '10' },
        ],
      })
      .expect(201);
    await as(accountant, http().post(`/api/v1/journal-entries/${wrong.body.id}/submit`)).expect(
      201,
    );
    await as(finance, http().post(`/api/v1/journal-entries/${wrong.body.id}/approve`)).expect(201);
    if (other) {
      const blocked = await as(
        finance,
        http().post(`/api/v1/journal-entries/${wrong.body.id}/post`),
      ).expect(422);
      expect(blocked.body.code).toBe('ACCOUNT_BRANCH_NOT_ALLOWED');
    }
    await as(admin, http().patch(`/api/v1/accounts/${acc['1120']}`))
      .send({ allowedBranchIds: [] })
      .expect(200);
  });

  // ----------------------------------------------------------- recurring journals

  it('runs a recurring template idempotently and completes it at its cap', async () => {
    const denied = await as(accountant, http().post('/api/v1/accounting/recurring-journals'))
      .send({
        name: 'Auto-post attempt',
        description: 'x',
        frequency: 'MONTHLY',
        startDate: '2026-01-31',
        mode: 'AUTO_POST',
        lines: [
          { accountId: acc['6200'], debit: '1', credit: '0' },
          { accountId: acc['2120'], debit: '0', credit: '1' },
        ],
      })
      .expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');

    const created = await as(finance, http().post('/api/v1/accounting/recurring-journals'))
      .send({
        name: 'Quarterly subscription',
        description: 'SaaS subscription',
        frequency: 'MONTHLY',
        interval: 3,
        startDate: '2026-01-31',
        maxOccurrences: 2,
        mode: 'AUTO_POST',
        autoReverse: false,
        lines: [
          { accountId: acc['6300'], debit: '900', credit: '0' },
          { accountId: acc['1130'], debit: '0', credit: '900' },
        ],
      })
      .expect(201);
    expect(created.body.nextRunDate).toBe('2026-01-31');

    const first = await as(finance, http().post('/api/v1/accounting/recurring-journals/run'))
      .send({ asOf: '2026-02-15', recurringJournalId: created.body.id })
      .expect(201);
    expect(first.body.generated).toHaveLength(1);
    expect(first.body.generated[0].status).toBe('POSTED');
    expect(first.body.generated[0].runDate).toBe('2026-01-31');

    // Same run twice: nothing new.
    const again = await as(finance, http().post('/api/v1/accounting/recurring-journals/run'))
      .send({ asOf: '2026-02-15', recurringJournalId: created.body.id })
      .expect(201);
    expect(again.body.generated).toHaveLength(0);

    const second = await as(finance, http().post('/api/v1/accounting/recurring-journals/run'))
      .send({ asOf: '2026-12-31', recurringJournalId: created.body.id })
      .expect(201);
    expect(second.body.generated.map((g: { runDate: string }) => g.runDate)).toEqual([
      '2026-04-30',
    ]);
    const detail = await as(
      admin,
      http().get(`/api/v1/accounting/recurring-journals/${created.body.id}`),
    ).expect(200);
    expect(detail.body.status).toBe('COMPLETED');
    expect(detail.body.occurrences).toBe(2);
    expect(detail.body.runs).toHaveLength(2);
  });

  it('generates DRAFT accrual occurrences with the next-month auto-reversal date', async () => {
    const list = await as(admin, http().get('/api/v1/accounting/recurring-journals')).expect(200);
    const rent = list.body.items.find((r: { name: string }) => r.name === 'Monthly rent accrual');
    const run = await as(accountant, http().post('/api/v1/accounting/recurring-journals/run'))
      .send({ asOf: '2026-02-28', recurringJournalId: rent.id })
      .expect(201);
    expect(
      run.body.generated.map((g: { runDate: string; status: string }) => [g.runDate, g.status]),
    ).toEqual([
      ['2026-01-31', 'DRAFT'],
      ['2026-02-28', 'DRAFT'],
    ]);
    const entry = await as(
      admin,
      http().get(`/api/v1/journal-entries/${run.body.generated[0].journalEntryId}`),
    ).expect(200);
    expect(entry.body.journalType).toBe('ACCRUAL');
    expect(entry.body.autoReverseDate).toBe('2026-02-01');
    expect(entry.body.sourceType).toBe('RECURRING_JOURNAL');
  });

  // ----------------------------------------------------------------- prepayments

  it('activates a prepayment and recognises it straight-line through the ledger', async () => {
    const created = await as(accountant, http().post('/api/v1/accounting/prepayments'))
      .send({
        name: 'Software licence',
        prepaidAccountId: acc['1400'],
        expenseAccountId: acc['6300'],
        creditAccountId: acc['1130'],
        amount: '100',
        startDate: '2026-01-01',
        months: 3,
      })
      .expect(201);
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.schedules.map((s: { amount: string }) => s.amount)).toEqual([
      '33.3334',
      '33.3333',
      '33.3333',
    ]);

    const prepaidBefore = await ledgerNet(acc['1400']!, '2026-12-31');
    await as(
      accountant,
      http().post(`/api/v1/accounting/prepayments/${created.body.id}/activate`),
    ).expect(403);
    const active = await as(
      finance,
      http().post(`/api/v1/accounting/prepayments/${created.body.id}/activate`),
    ).expect(201);
    expect(active.body.status).toBe('ACTIVE');
    expect(active.body.initialDocumentNumber).toBeTruthy();
    expect(await ledgerNet(acc['1400']!, '2026-12-31')).toBe(
      (Number(prepaidBefore) + 100).toFixed(4),
    );

    const partial = await as(finance, http().post('/api/v1/accounting/prepayments/recognize'))
      .send({ asOf: '2026-02-28', prepaymentId: created.body.id })
      .expect(201);
    expect(partial.body.recognized).toHaveLength(2);
    const again = await as(finance, http().post('/api/v1/accounting/prepayments/recognize'))
      .send({ asOf: '2026-02-28', prepaymentId: created.body.id })
      .expect(201);
    expect(again.body.recognized).toHaveLength(0);

    const done = await as(finance, http().post('/api/v1/accounting/prepayments/recognize'))
      .send({ asOf: '2026-12-31', prepaymentId: created.body.id })
      .expect(201);
    expect(done.body.recognized).toHaveLength(1);
    const detail = await as(
      admin,
      http().get(`/api/v1/accounting/prepayments/${created.body.id}`),
    ).expect(200);
    expect(detail.body.status).toBe('COMPLETED');
    expect(detail.body.recognizedAmount).toBe('100.0000');
    expect(detail.body.remainingAmount).toBe('0.0000');
    // The prepaid account is back where it started once fully recognised.
    expect(await ledgerNet(acc['1400']!, '2026-12-31')).toBe(prepaidBefore);
  });

  // --------------------------------------------------------------- posting rules

  it('resolves a seeded posting rule into balanced lines and rejects an unresolvable one', async () => {
    const rules = await as(admin, http().get('/api/v1/accounting/posting-rules')).expect(200);
    const invoice = rules.body.find(
      (r: { transactionType: string }) => r.transactionType === 'CUSTOMER_INVOICE',
    );
    expect(invoice.requirements.amountKeys).toEqual(['GROSS', 'NET', 'TAX']);
    const sim = await as(
      admin,
      http().post(`/api/v1/accounting/posting-rules/${invoice.id}/simulate`),
    )
      .send({
        amounts: { GROSS: '112', NET: '100', TAX: '12' },
        accounts: { REVENUE: acc['4100'] },
      })
      .expect(201);
    expect(sim.body.lines).toHaveLength(3);
    expect(sim.body.accounts.map((a: { code: string }) => a.code)).toEqual([
      '1200',
      '4100',
      '2130',
    ]);

    const bad = await as(
      admin,
      http().post(`/api/v1/accounting/posting-rules/${invoice.id}/simulate`),
    )
      .send({
        amounts: { GROSS: '112', NET: '100', TAX: '10' },
        accounts: { REVENUE: acc['4100'] },
      })
      .expect(422);
    expect(bad.body.code).toBe('POSTING_RULE_UNRESOLVED');

    const custom = await as(admin, http().post('/api/v1/accounting/posting-rules'))
      .send({
        transactionType: 'BANK_INTEREST',
        name: 'Bank interest earned',
        lines: [
          { side: 'DEBIT', accountSource: 'CONTEXT', accountKey: 'BANK', amountKey: 'AMOUNT' },
          { side: 'CREDIT', accountSource: 'ACCOUNT', accountId: acc['7100'], amountKey: 'AMOUNT' },
        ],
      })
      .expect(201);
    expect(custom.body.requirements.accountKeys).toEqual(['BANK']);
  });

  // ----------------------------------------------------------- statements & suspense

  it('reports other income in the P&L and reconciles the cash-flow statement', async () => {
    const draft = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-20',
        description: 'Bank interest',
        lines: [
          { accountId: acc['1130'], debit: '250', credit: '0' },
          { accountId: acc['7100'], debit: '0', credit: '250' },
        ],
      })
      .expect(201);
    await postThrough(draft.body.id);

    const pl = await as(
      admin,
      http().get(
        '/api/v1/reports/income-statement?from=2026-01-01&to=2026-03-31&compareFrom=2025-01-01&compareTo=2025-12-31',
      ),
    ).expect(200);
    expect(pl.body.otherIncome.total).toBe('250.0000');
    expect(pl.body.comparative.netIncome).toBe('0.0000');
    expect(pl.body.netIncome).toBe(
      (Number(pl.body.operatingIncome) + 250 - Number(pl.body.otherExpenses.total)).toFixed(4),
    );

    const cf = await as(
      admin,
      http().get('/api/v1/reports/cash-flow?from=2026-01-01&to=2026-04-30'),
    ).expect(200);
    expect(cf.body.method).toBe('INDIRECT');
    expect(cf.body.balanced).toBe(true);
    expect(cf.body.closingCash).not.toBe(cf.body.openingCash);
    expect(
      (
        Number(cf.body.operating.total) +
        Number(cf.body.investing.total) +
        Number(cf.body.financing.total)
      ).toFixed(4),
    ).toBe(cf.body.netChangeInCash);
  });

  it('monitors suspense balances with age and owner and clears through a reclassification', async () => {
    const users = await as(admin, http().get('/api/v1/users')).expect(200);
    const owner = (users.body.items ?? users.body).find(
      (u: { email: string }) => u.email === FINANCE.email,
    );
    await as(admin, http().patch(`/api/v1/accounts/${acc['1900']}`))
      .send({ ownerUserId: owner.id })
      .expect(200);
    const unknown = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-01',
        description: 'Unidentified bank receipt',
        lines: [
          { accountId: acc['1130'], debit: '700', credit: '0' },
          { accountId: acc['1900'], debit: '0', credit: '700' },
        ],
      })
      .expect(201);
    await postThrough(unknown.body.id);

    const report = await as(
      admin,
      http().get('/api/v1/accounting/suspense?asOf=2026-03-01'),
    ).expect(200);
    const suspense = report.body.accounts.find((a: { code: string }) => a.code === '1900');
    expect(suspense.balance).toBe('-700.0000');
    expect(suspense.unresolvedCount).toBe(1);
    expect(suspense.oldestAgeDays).toBe(28);
    expect(suspense.ownerEmail).toBe(FINANCE.email);

    const clearing = await as(accountant, http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-02-20',
        description: 'Identified: customer receipt',
        journalType: 'RECLASSIFICATION',
        lines: [
          { accountId: acc['1900'], debit: '700', credit: '0' },
          { accountId: acc['1200'], debit: '0', credit: '700' },
        ],
      })
      .expect(201);
    await postThrough(clearing.body.id);
    const cleared = await as(
      admin,
      http().get('/api/v1/accounting/suspense?asOf=2026-03-01'),
    ).expect(200);
    const after = cleared.body.accounts.find((a: { code: string }) => a.code === '1900');
    expect(after.balance).toBe('0.0000');
    expect(after.unresolvedCount).toBe(0);
  });

  it('passes the extended integrity checks', async () => {
    const res = await as(admin, http().get('/api/v1/integrity?asOf=2026-12-31')).expect(200);
    const byCheck = Object.fromEntries(
      res.body.findings.map((f: { check: string; count: number }) => [f.check, f.count]),
    );
    for (const check of [
      'UNBALANCED_JOURNAL',
      'INVALID_CURRENCY',
      'INVALID_DIMENSION',
      'DIMENSION_RULE',
      'ACCOUNT_BRANCH',
      'DUPLICATE_SOURCE',
      'STATEMENTS_BALANCE',
    ]) {
      expect([check, byCheck[check]]).toEqual([check, 0]);
    }
  });
});
