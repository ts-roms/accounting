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
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #12 - Bank feed auto-reconciliation. Seeded rules and an open
 * statement with six unexplained lines; refreshing suggestions auto-applies
 * the fee and interest rules (posted bank transactions matched to their
 * lines), suggests a GCash deposit, a customer receipt citing an open
 * invoice and a vendor payment for an open bill; applying, overriding,
 * dismissing and explaining by hand; rule tests, history suggestions,
 * KPIs, integrity, the sweep job and permission boundaries.
 */
describe('Bank feed (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  let bankId: string;
  let statementId: string;
  const lines: Record<string, { id: string; amount: string }> = {};

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const queue = async (extra = '') =>
    (await as(finance, http().get(`/api/v1/banking/feed/queue?pageSize=50${extra}`)).expect(200))
      .body as {
      total: number;
      items: Array<{
        id: string;
        description: string;
        status: string;
        suggestions: Array<{
          id: string;
          source: string;
          action: string;
          confidence: string;
          payload: Record<string, unknown>;
        }>;
      }>;
    };
  const lineStatus = async (lineId: string) => {
    const res = await as(
      finance,
      http().get(`/api/v1/bank-statements/${statementId}/lines`),
    ).expect(200);
    return res.body.find((l: { id: string }) => l.id === lineId) as {
      status: string;
      matchKind: string | null;
      matchNote: string | null;
      matchedJournalNumber: string | null;
    };
  };
  const glBalance = async (code: string, asOf: string): Promise<string> =>
    (
      await as(
        admin,
        http().get(`/api/v1/general-ledger?accountId=${acc[code]}&from=2026-01-01&to=${asOf}`),
      ).expect(200)
    ).body.closingBalance;
  const expectIntegrity = async () => {
    const res = await as(
      admin,
      http().get('/api/v1/banking/feed/integrity?asOf=2026-09-30'),
    ).expect(200);
    for (const check of ['APPLIED_WITHOUT_MATCH', 'RULES_WITHOUT_ACCOUNT'])
      expect(res.body.findings.find((f: { check: string }) => f.check === check).count).toBe(0);
    return res.body as { status: string; findings: Array<{ check: string; count: number }> };
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
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    for (const a of (await as(admin, http().get('/api/v1/accounts')).expect(200)).body)
      acc[a.code] = a.id;
    const banks = await as(admin, http().get('/api/v1/bank-accounts')).expect(200);
    bankId = (banks.body.items ?? banks.body).find(
      (b: { code: string }) => b.code === 'BDO-MAIN',
    ).id;
    const statements = await as(admin, http().get('/api/v1/bank-statements')).expect(200);
    statementId = statements.body.items[0].id;
    for (const l of (
      await as(admin, http().get(`/api/v1/bank-statements/${statementId}/lines`)).expect(200)
    ).body) {
      const key = l.description.startsWith('BANK SERVICE')
        ? 'fee'
        : l.description.startsWith('INTEREST')
          ? 'interest'
          : l.description.startsWith('GCASH')
            ? 'gcash'
            : l.description.startsWith('FUND TRANSFER')
              ? 'receipt'
              : l.description.startsWith('CHECK')
                ? 'cheque'
                : 'pos';
      lines[key] = { id: l.id, amount: l.amount };
    }
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------- seed

  it('seed: rules, settings and an open statement with six unexplained lines and no suggestions yet', async () => {
    const rules = await as(finance, http().get('/api/v1/banking/feed/rules')).expect(200);
    expect(
      rules.body.map((r: { name: string; autoApply: boolean }) => [r.name, r.autoApply]),
    ).toEqual([
      ['Bank service fees', true],
      ['Interest credited', true],
      ['GCash settlements', false],
    ]);
    const settings = await as(finance, http().get('/api/v1/banking/feed/settings')).expect(200);
    expect(settings.body.autoApplyRules).toBe(true);
    expect(settings.body.autoApplyDocumentMatches).toBe(false);
    expect(Object.keys(lines)).toHaveLength(6);
    const q = await queue();
    expect(q.total).toBe(6);
    expect(q.items.every((l) => l.suggestions.length === 0)).toBe(true);
    await as(viewer, http().post('/api/v1/banking/feed/suggest')).send({}).expect(403);
    await as(viewer, http().get('/api/v1/banking/feed/queue')).expect(200); // bank-account.view suffices to read
  });

  // ---------------------------------------------------------------- suggest

  it('suggest: auto-apply rules post and match fee / interest; documents and the GCash rule are suggested for review', async () => {
    const feesBefore = await glBalance('6600', '2026-09-30');
    const summary = await as(finance, http().post('/api/v1/banking/feed/suggest'))
      .send({ statementId })
      .expect(200);
    expect(summary.body).toMatchObject({ lines: 6, suggested: 5, autoApplied: 2, failed: 0 });

    const fee = await lineStatus(lines['fee']!.id);
    expect(fee.status).toBe('MATCHED');
    expect(fee.matchKind).toBe('RULE');
    expect(fee.matchNote).toMatch(/Recorded by BTX-2026-\d{6} \(rule \/ policy\)/);
    expect((await lineStatus(lines['interest']!.id)).status).toBe('MATCHED');
    expect(await glBalance('6600', '2026-09-30')).toBe((Number(feesBefore) + 350).toFixed(4));
    const interest = await as(finance, http().get('/api/v1/bank-transactions?pageSize=50')).expect(
      200,
    );
    const tx = interest.body.items.find(
      (t: { transactionType: string; amount: string }) =>
        t.transactionType === 'INTEREST' && t.amount === '125.5000',
    );
    expect(tx.status).toBe('POSTED');

    const q = await queue();
    expect(q.total).toBe(4);
    const gcash = q.items.find((l) => l.id === lines['gcash']!.id)!;
    expect(gcash.suggestions.map((s) => [s.source, s.confidence])).toEqual([['RULE', 'MEDIUM']]);
    const receipt = q.items.find((l) => l.id === lines['receipt']!.id)!;
    expect(receipt.suggestions[0]).toMatchObject({
      source: 'DOCUMENT',
      action: 'RECEIVE_CUSTOMER',
      confidence: 'HIGH',
    });
    expect(
      (receipt.suggestions[0]!.payload.allocations as Array<{ documentNumber: string }>)[0]!
        .documentNumber,
    ).toBe('INV-2026-000011');
    const cheque = q.items.find((l) => l.id === lines['cheque']!.id)!;
    expect(cheque.suggestions[0]).toMatchObject({
      source: 'DOCUMENT',
      action: 'PAY_VENDOR',
      confidence: 'HIGH',
    });
    const pos = q.items.find((l) => l.id === lines['pos']!.id)!;
    expect(pos.suggestions).toHaveLength(0);
    const rules = await as(finance, http().get('/api/v1/banking/feed/rules')).expect(200);
    expect(rules.body.find((r: { name: string }) => r.name === 'Bank service fees').hitCount).toBe(
      1,
    );
    await expectIntegrity();
  });

  it('apply: a document suggestion posts a customer receipt allocated to the invoice and a vendor payment to the bill', async () => {
    const arBefore = await glBalance('1200', '2026-09-30');
    const q = await queue();
    const receipt = q.items.find((l) => l.id === lines['receipt']!.id)!;
    const applied = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${receipt.suggestions[0]!.id}/apply`),
    )
      .send({})
      .expect(200);
    expect(applied.body.status).toBe('APPLIED');
    expect(applied.body.resultType).toBe('CUSTOMER_PAYMENT');
    expect(applied.body.resultNumber).toMatch(/^RCP-2026-/);
    expect(applied.body.appliedBy).toBeTruthy();
    const line = await lineStatus(lines['receipt']!.id);
    expect(line.status).toBe('MATCHED');
    expect(line.matchedJournalNumber).toMatch(/^JE-/);
    expect(await glBalance('1200', '2026-09-30')).toBe(
      (Number(arBefore) - Number(lines['receipt']!.amount)).toFixed(4),
    );
    const invoice = await as(finance, http().get('/api/v1/invoices?search=INV-2026-000011')).expect(
      200,
    );
    expect(invoice.body.items[0].status).toBe('PAID');
    // The same suggestion cannot be applied twice.
    const again = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${receipt.suggestions[0]!.id}/apply`),
    )
      .send({})
      .expect(422);
    expect(again.body.code).toBe('BANK_SUGGESTION_INVALID');

    const cheque = (await queue()).items.find((l) => l.id === lines['cheque']!.id)!;
    const paid = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${cheque.suggestions[0]!.id}/apply`),
    )
      .send({})
      .expect(200);
    expect(paid.body.resultType).toBe('VENDOR_PAYMENT');
    expect((await lineStatus(lines['cheque']!.id)).status).toBe('MATCHED');
    await expectIntegrity();
  });

  it('review: overriding a rule suggestion, dismissing, explaining by hand and refusing a wrong direction', async () => {
    const q = await queue();
    const gcash = q.items.find((l) => l.id === lines['gcash']!.id)!;
    // Money in cannot be explained as a fee.
    const wrong = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${gcash.suggestions[0]!.id}/apply`),
    )
      .send({ transactionType: 'BANK_FEE' })
      .expect(422);
    expect(wrong.body.code).toBe('BANK_SUGGESTION_INVALID');
    const overridden = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${gcash.suggestions[0]!.id}/apply`),
    )
      .send({ counterpartyAccountId: acc['4100'], memo: 'GCash sales settlement' })
      .expect(200);
    expect(overridden.body.payload.counterpartyAccountId).toBe(acc['4100']);
    expect((await lineStatus(lines['gcash']!.id)).status).toBe('MATCHED');

    const explained = await as(
      finance,
      http().post(`/api/v1/banking/feed/lines/${lines['pos']!.id}/explain`),
    )
      .send({
        action: 'POST_TRANSACTION',
        transactionType: 'WITHDRAWAL',
        counterpartyAccountId: acc['6400'],
        memo: 'Office supplies',
        note: 'Receipt on file',
      })
      .expect(200);
    expect(explained.body).toMatchObject({
      source: 'MANUAL',
      status: 'APPLIED',
      resultType: 'BANK_TRANSACTION',
    });
    expect((await lineStatus(lines['pos']!.id)).status).toBe('MATCHED');
    expect((await queue()).total).toBe(0);
    await as(finance, http().post(`/api/v1/banking/feed/lines/${lines['pos']!.id}/explain`))
      .send({ action: 'IGNORE' })
      .expect(422); // already matched
    await expectIntegrity();
  });

  // ------------------------------------------------------- rules + history

  it('rules: create / test / update; a new statement gets history suggestions from earlier explanations', async () => {
    const bad = await as(finance, http().post('/api/v1/banking/feed/rules'))
      .send({ name: 'No conditions', action: 'IGNORE' })
      .expect(400);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const missingAccount = await as(finance, http().post('/api/v1/banking/feed/rules'))
      .send({
        name: 'Fee without account',
        descriptionPattern: 'fee',
        action: 'POST_TRANSACTION',
        transactionType: 'BANK_FEE',
      })
      .expect(400);
    expect(missingAccount.body.code).toBe('VALIDATION_FAILED');
    const stm = await as(finance, http().post('/api/v1/bank-statements'))
      .send({
        bankAccountId: bankId,
        statementDate: '2026-09-12',
        openingBalance: '0',
        closingBalance: '1030.5',
        fileName: 'feed-2.csv',
        lines: [
          { lineDate: '2026-09-10', description: 'POS PURCHASE 7-ELEVEN MAKATI', amount: '-520' },
          { lineDate: '2026-09-11', description: 'ATM WITHDRAWAL FEE', amount: '-15' },
          {
            lineDate: '2026-09-11',
            description: 'DEPOSIT REVERSAL - DUPLICATE POSTING',
            amount: '1565.5',
          },
        ],
      })
      .expect(201);
    const test = await as(finance, http().post('/api/v1/banking/feed/rules/test'))
      .send({ direction: 'OUT', descriptionPattern: '^atm withdrawal', descriptionMode: 'REGEX' })
      .expect(200);
    expect(test.body.matched).toBe(1);
    expect(test.body.lines[0].description).toBe('ATM WITHDRAWAL FEE');
    const rule = await as(finance, http().post('/api/v1/banking/feed/rules'))
      .send({
        name: 'ATM fees',
        priority: 5,
        direction: 'OUT',
        descriptionPattern: 'atm withdrawal',
        action: 'POST_TRANSACTION',
        transactionType: 'BANK_FEE',
        counterpartyAccountId: acc['6600'],
        autoApply: false,
      })
      .expect(201);
    const ignore = await as(finance, http().post('/api/v1/banking/feed/rules'))
      .send({
        name: 'Bank reversals',
        priority: 1,
        direction: 'IN',
        descriptionPattern: 'reversal',
        action: 'IGNORE',
        autoApply: true,
      })
      .expect(201);
    await as(finance, http().patch(`/api/v1/banking/feed/rules/${rule.body.id}`))
      .send({ priority: 7 })
      .expect(200);

    const summary = await as(finance, http().post('/api/v1/banking/feed/suggest'))
      .send({ statementId: stm.body.id })
      .expect(200);
    expect(summary.body).toMatchObject({ lines: 3, suggested: 3, autoApplied: 1 });
    const stmLines = (
      await as(finance, http().get(`/api/v1/bank-statements/${stm.body.id}/lines`)).expect(200)
    ).body as Array<{ id: string; description: string; status: string; matchNote: string }>;
    const reversal = stmLines.find((l) => l.description.startsWith('DEPOSIT REVERSAL'))!;
    expect(reversal.status).toBe('DUPLICATE');
    expect(reversal.matchNote).toMatch(/^Ignored/);
    const q = await queue();
    const pos = q.items.find((l) => l.description === 'POS PURCHASE 7-ELEVEN MAKATI')!;
    expect(pos.suggestions[0]).toMatchObject({
      source: 'HISTORY',
      action: 'POST_TRANSACTION',
      confidence: 'LOW',
    });
    expect(pos.suggestions[0]!.payload.counterpartyAccountId).toBe(acc['6400']);
    const atm = q.items.find((l) => l.description === 'ATM WITHDRAWAL FEE')!;
    expect(atm.suggestions[0]).toMatchObject({ source: 'RULE', confidence: 'MEDIUM' });
    const dismissed = await as(
      finance,
      http().post(`/api/v1/banking/feed/suggestions/${atm.suggestions[0]!.id}/dismiss`),
    ).expect(200);
    expect(dismissed.body.status).toBe('DISMISSED');
    expect((await queue('&suggested=NO')).items.some((l) => l.id === atm.id)).toBe(true);
    await as(finance, http().delete(`/api/v1/banking/feed/rules/${ignore.body.id}`)).expect(204);
  });

  it('dashboard, integrity and the sweep job report the state of the feed', async () => {
    const dash = await as(
      finance,
      http().get('/api/v1/banking/feed/dashboard?asOf=2026-09-30&days=60'),
    ).expect(200);
    expect(dash.body.imported).toBe(9);
    expect(dash.body.explained).toBe(7); // six seeded lines + the ignored reversal
    expect(dash.body.ruleApplied).toBe(4); // fee, interest, GCash (rule, overridden) and the reversal
    expect(dash.body.documentApplied).toBe(2);
    expect(dash.body.manual).toBe(1);
    expect(dash.body.pendingLines).toBe(2);
    expect(Number(dash.body.automationRate)).toBeGreaterThan(30);
    expect(dash.body.topRules[0].name).toBe('Bank service fees');
    expect(dash.body.byBankAccount).toHaveLength(1);
    const settings = await as(finance, http().put('/api/v1/banking/feed/settings'))
      .send({ staleAfterDays: 3 })
      .expect(200);
    expect(settings.body.staleAfterDays).toBe(3);
    const integrity = await expectIntegrity();
    expect(integrity.findings.find((f) => f.check === 'STALE_UNMATCHED_LINES')!.count).toBe(2);
    const sweep = await as(
      finance,
      http().post('/api/v1/banking/feed/sweep?asOf=2026-09-30'),
    ).expect(200);
    expect(sweep.body.companies).toBeGreaterThanOrEqual(1);
    expect(sweep.body.notified).toBeGreaterThanOrEqual(1);
    expect((await queue()).total).toBe(2); // the sweep suggests but never posts
  });
});
