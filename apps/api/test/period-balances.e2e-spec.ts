import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';
import { DRIZZLE, type Database } from '@/database/database.types';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import {
  GeneralLedgerService,
  type BalanceFilter,
} from '@/modules/accounting/ledger/general-ledger.service';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Period-balance read model: `account_period_balances` is maintained by
 * database triggers from posted lines and only ever read by
 * `GeneralLedgerService.activity/activityByMonth` for whole calendar months.
 * These tests prove that the model equals the lines under every filter the
 * statements use, follows posting and reversal, is watched by the integrity
 * check and can be rebuilt from the ledger.
 */
describe('Period balances (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let companyId: string;
  let ledger: GeneralLedgerService;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const sorted = <T extends { accountId: string; month?: string }>(rows: T[]) =>
    [...rows].sort((a, b) =>
      `${a.month ?? ''}|${a.accountId}`.localeCompare(`${b.month ?? ''}|${b.accountId}`),
    );
  /** `activity()` must equal the pure line scan for the same filter. */
  const expectSameActivity = async (filter: BalanceFilter, nonEmpty = true) => {
    const [model, lines] = await Promise.all([
      ledger.activity(filter),
      ledger.lineActivity(filter),
    ]);
    if (nonEmpty) expect(lines.length).toBeGreaterThan(0);
    expect(sorted(model)).toEqual(sorted(lines));
  };
  const integrityFinding = async () => {
    const res = await as(http().get('/api/v1/integrity?asOf=2026-12-31')).expect(200);
    return res.body.findings.find(
      (f: { check: string }) => f.check === 'PERIOD_BALANCES_VS_LEDGER',
    ) as { count: number; samples: unknown[] };
  };
  const storedFor = async (accountId: string, month: string) => {
    const { rows } = await pool.query<{ debit: string; credit: string; line_count: number }>(
      `select coalesce(sum(debit), 0)::text as debit, coalesce(sum(credit), 0)::text as credit,
              coalesce(sum(line_count), 0)::int as line_count
         from account_period_balances where company_id = $1 and account_id = $2 and period_start = $3`,
      [companyId, accountId, month],
    );
    return rows[0]!;
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
    ledger = app.get(GeneralLedgerService);
    admin = await login(ADMIN);
    finance = await login(FINANCE);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('the migration populated the model from the seeded ledger and the integrity check passes', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'select count(*)::text as n from account_period_balances where company_id = $1',
      [companyId],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
    const finding = await integrityFinding();
    expect(finding.count).toBe(0);
  });

  it('activity() from the model equals the line scan for whole months, partial edges and every filter', async () => {
    const { rows: branches } = await pool.query<{ id: string }>(
      'select id from branches where company_id = $1 limit 1',
      [companyId],
    );
    const filters: BalanceFilter[] = [
      { companyId, from: '2026-01-01', to: '2026-12-31' },
      { companyId, from: '2026-01-15', to: '2026-08-10' },
      { companyId, to: '2026-06-30' },
      { companyId, to: '2026-06-15' },
      { companyId, from: '2026-03-03', to: '2026-03-28' },
      { companyId, from: '2026-01-01', to: '2026-12-31', accountIds: [acc['1110']!, acc['1200']!] },
      { companyId, from: '2026-01-01', to: '2026-12-31', accountTypes: ['REVENUE', 'EXPENSE'] },
      { companyId, from: '2026-01-01', to: '2026-12-31', excludeJournalTypes: ['CLOSING'] },
    ];
    for (const filter of filters) await expectSameActivity(filter);
    // The seed posts without branches: both sides must agree on an empty result too.
    await expectSameActivity(
      { companyId, from: '2026-01-01', to: '2026-12-31', branchId: branches[0]!.id },
      false,
    );
  });

  it('activityByMonth() from the model equals the monthly line scan', async () => {
    const filter: BalanceFilter = { companyId, from: '2026-01-10', to: '2026-09-20' };
    const model = await ledger.activityByMonth(filter);
    const { rows: lines } = await pool.query<{
      month: string;
      accountId: string;
      debit: string;
      credit: string;
    }>(
      `select to_char(date_trunc('month', e.entry_date), 'YYYY-MM-DD') as month,
              l.account_id as "accountId", sum(l.debit)::text as debit, sum(l.credit)::text as credit
         from journal_lines l join journal_entries e on e.id = l.journal_entry_id
        where e.company_id = $1 and e.status in ('POSTED', 'LOCKED', 'REVERSED')
          and e.entry_date between $2 and $3
        group by 1, 2`,
      [companyId, filter.from, filter.to],
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(sorted(model)).toEqual(sorted(lines));
  });

  it('posting and reversing a journal moves the model in step with the lines', async () => {
    const before = await storedFor(acc['6400']!, '2026-05-01');
    const draft = await as(http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-05-20',
        description: 'Period balance probe',
        lines: [
          { accountId: acc['6400'], debit: '123.45', credit: '0' },
          { accountId: acc['1110'], debit: '0', credit: '123.45' },
        ],
      })
      .expect(201);
    // Drafts never reach the model.
    expect(await storedFor(acc['6400']!, '2026-05-01')).toEqual(before);
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/submit`)).expect(201);
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/post`), finance).expect(201);
    const posted = await storedFor(acc['6400']!, '2026-05-01');
    expect(Number(posted.debit) - Number(before.debit)).toBeCloseTo(123.45, 4);
    expect(posted.line_count).toBe(before.line_count + 1);

    // A reversal in June adds the mirror image to June; May keeps the original (REVERSED stays in the ledger).
    const june = await storedFor(acc['6400']!, '2026-06-01');
    await as(http().post(`/api/v1/journal-entries/${draft.body.id}/reverse`), finance)
      .send({ reversalDate: '2026-06-02' })
      .expect(201);
    expect(await storedFor(acc['6400']!, '2026-05-01')).toEqual(posted);
    const juneAfter = await storedFor(acc['6400']!, '2026-06-01');
    expect(Number(juneAfter.credit) - Number(june.credit)).toBeCloseTo(123.45, 4);
    expect((await integrityFinding()).count).toBe(0);
    await expectSameActivity({ companyId, from: '2026-05-01', to: '2026-06-30' });
  });

  it('concurrent postings touching the same rows in opposite line order all succeed (lock order)', async () => {
    // Half the journals list cash first, half list the expense first: before 0040 the trigger
    // locked model rows in line order and these deadlocked against each other.
    const drafts: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      const lines = [
        { accountId: acc['6400'], debit: '10.00', credit: '0' },
        { accountId: acc['1110'], debit: '0', credit: '10.00' },
      ];
      const res = await as(http().post('/api/v1/journal-entries'))
        .send({
          entryDate: '2026-07-15',
          description: `Lock order probe ${i}`,
          lines: i % 2 ? lines : [...lines].reverse(),
        })
        .expect(201);
      await as(http().post(`/api/v1/journal-entries/${res.body.id}/submit`)).expect(201);
      await as(http().post(`/api/v1/journal-entries/${res.body.id}/approve`), finance).expect(201);
      drafts.push(res.body.id as string);
    }
    const posted = await Promise.all(
      drafts.map((id) => as(http().post(`/api/v1/journal-entries/${id}/post`), finance)),
    );
    expect(posted.map((r) => r.status)).toEqual(drafts.map(() => 201));
    expect((await integrityFinding()).count).toBe(0);
    await expectSameActivity({ companyId, from: '2026-07-01', to: '2026-07-31' });
  });

  it('auto-reversing journals and ordinary postings on the same rows do not deadlock', async () => {
    // postEntry of an accrual used to update the model rows first and take the JE counter for its
    // mirror afterwards; every postEvent takes the counter first - opposite orders, deadlocks.
    const accruals: string[] = [];
    for (let i = 0; i < 15; i += 1) {
      const res = await as(http().post('/api/v1/journal-entries'))
        .send({
          entryDate: '2026-07-20',
          autoReverseDate: '2026-08-01',
          description: `Accrual lock order probe ${i}`,
          lines: [
            { accountId: acc['6400'], debit: '5.00', credit: '0' },
            { accountId: acc['1110'], debit: '0', credit: '5.00' },
          ],
        })
        .expect(201);
      await as(http().post(`/api/v1/journal-entries/${res.body.id}/submit`)).expect(201);
      await as(http().post(`/api/v1/journal-entries/${res.body.id}/approve`), finance).expect(201);
      accruals.push(res.body.id as string);
    }
    const db = app.get<Database>(DRIZZLE);
    const posting = app.get(AccountingPostingService);
    const results = await Promise.allSettled([
      ...accruals.map((id) =>
        as(http().post(`/api/v1/journal-entries/${id}/post`), finance).then((r) => r.status),
      ),
      ...Array.from({ length: 15 }, (_, i) =>
        db.transaction((tx) =>
          posting.postEvent(tx, {
            companyId,
            entryDate: '2026-07-20',
            description: `Engine posting probe ${i}`,
            lines: [
              { accountId: acc['1110']!, debit: '7.00', credit: '0' },
              { accountId: acc['6400']!, debit: '0', credit: '7.00' },
            ],
            actor: { id: null, system: true },
          }),
        ),
      ),
    ]);
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(results.slice(0, 15).map((r) => (r as PromiseFulfilledResult<number>).value)).toEqual(
      accruals.map(() => 201),
    );
    expect((await integrityFinding()).count).toBe(0);
    await expectSameActivity({ companyId, from: '2026-07-01', to: '2026-08-31' });
  });

  it('the integrity check catches a drifted row and the operations rebuild repairs it', async () => {
    await pool.query(
      `update account_period_balances set debit = debit + 1
        where company_id = $1 and account_id = $2 and period_start = '2026-05-01'
          and id = (select id from account_period_balances
                     where company_id = $1 and account_id = $2 and period_start = '2026-05-01' limit 1)`,
      [companyId, acc['6400']],
    );
    await pool.query(
      `insert into account_period_balances (company_id, account_id, period_start, journal_type, debit, credit, line_count)
       values ($1, $2, '2031-01-01', 'GENERAL', 5, 0, 1)`,
      [companyId, acc['6400']],
    );
    const drifted = await integrityFinding();
    expect(drifted.count).toBe(2);

    const denied = await as(http().post('/api/v1/operations/period-balances/rebuild'), finance)
      .send({ companyId })
      .expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    const rebuilt = await as(http().post('/api/v1/operations/period-balances/rebuild'))
      .send({ companyId })
      .expect(201);
    expect(rebuilt.body.rows).toBeGreaterThan(0);
    expect((await integrityFinding()).count).toBe(0);
    const { rows: audit } = await pool.query(
      `select 1 from audit_logs where action = 'REBUILD' and entity_id = $1`,
      [companyId],
    );
    expect(audit).toHaveLength(1);
  });
});
