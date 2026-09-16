import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';
import { IntegrationsService } from '@/modules/integrations/core/integrations.service';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

const CLIENT_ID = 'e2e_client_id';
const SECRET = 'e2e_sandbox_secret_0123456789';
const PUBLIC_TOKEN = 'public-sandbox-11111111-2222-3333-4444-555555555555';
const ACCESS_TOKEN = 'access-sandbox-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/**
 * In-memory stand-in for sandbox.plaid.com: header auth, public-token
 * exchange, `/accounts/get`, `/transactions/sync` with a cursor and a page
 * size capped at 3 (so pagination and the running balance across pages are
 * exercised), Plaid-style 400 errors, and the webhook verification key.
 */
function plaidStub() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'e2e-kid', use: 'sig', alg: 'ES256' };
  const accounts = [
    {
      account_id: 'acc_checking',
      name: 'Business Checking',
      official_name: 'BDO Business Checking',
      mask: '1234',
      type: 'depository',
      subtype: 'checking',
      balances: { current: 1200.5, available: 1200.5, iso_currency_code: 'PHP' },
    },
    { account_id: 'acc_card', name: 'Corporate Card', type: 'credit', subtype: 'credit card' },
  ];
  const tx = (
    id: string,
    date: string,
    amount: number,
    name: string,
    extra: Record<string, unknown> = {},
  ) => ({
    transaction_id: id,
    account_id: 'acc_checking',
    amount,
    iso_currency_code: 'PHP',
    date,
    name,
    pending: false,
    payment_channel: 'online',
    ...extra,
  });
  /** Two "generations": the second sync (after the webhook) delivers new rows only. */
  const generations: Array<Array<ReturnType<typeof tx>>> = [
    [
      tx('t1', '2026-03-02', -15000, 'ACH CREDIT NORTHWIND', { merchant_name: 'Northwind' }),
      tx('t2', '2026-03-02', 2500, 'BANK SERVICE CHARGE'),
      tx('t3', '2026-03-03', 320.75, 'GRAB PH', { merchant_name: 'Grab' }),
      tx('t4', '2026-03-04', 1000, 'PENDING CARD AUTH', { pending: true }),
      tx('t5', '2026-03-04', 899.99, 'Check 1042', { check_number: '1042' }),
      tx('t6', '2026-03-04', 45, 'CARD PURCHASE', { account_id: 'acc_card' }),
    ],
    [tx('t7', '2026-03-05', -8000, 'ACH CREDIT CONTOSO', { merchant_name: 'Contoso' })],
  ];
  let released = 1;
  const requests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const plaidError = (status: number, error_type: string, error_code: string, msg: string) =>
    json(status, { error_type, error_code, error_message: msg, request_id: 'req_e2e' });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url: url.toString(), headers, body });
    if (headers['plaid-client-id'] !== CLIENT_ID || headers['plaid-secret'] !== SECRET)
      return plaidError(
        400,
        'INVALID_INPUT',
        'INVALID_API_KEYS',
        'invalid client_id or secret provided',
      );
    if (url.pathname === '/webhook_verification_key/get')
      return body.key_id === 'e2e-kid'
        ? json(200, { key: jwk, request_id: 'req_key' })
        : plaidError(400, 'INVALID_INPUT', 'INVALID_FIELD', 'unknown key id');
    if (url.pathname === '/item/public_token/exchange')
      return body.public_token === PUBLIC_TOKEN
        ? json(200, { access_token: ACCESS_TOKEN, item_id: 'item_e2e', request_id: 'req_x' })
        : plaidError(
            400,
            'INVALID_INPUT',
            'INVALID_PUBLIC_TOKEN',
            'could not find matching public token',
          );
    if (body.access_token !== ACCESS_TOKEN)
      return plaidError(
        400,
        'INVALID_INPUT',
        'INVALID_ACCESS_TOKEN',
        'could not find matching access token',
      );
    if (url.pathname === '/accounts/get')
      return json(200, { accounts, item: { item_id: 'item_e2e' }, request_id: 'req_a' });
    if (url.pathname === '/transactions/sync') {
      const all = generations.slice(0, released).flat();
      const offset = typeof body.cursor === 'string' && body.cursor ? Number(body.cursor) : 0;
      const count = Math.min(Number(body.count ?? 100), 3);
      const added = all.slice(offset, offset + count);
      const next = offset + added.length;
      return json(200, {
        added,
        modified: [],
        removed: [],
        next_cursor: String(next),
        has_more: next < all.length,
        accounts,
        request_id: 'req_s',
      });
    }
    return plaidError(400, 'INVALID_REQUEST', 'INVALID_ENDPOINT', `unknown ${url.pathname}`);
  };

  const sign = (rawBody: string, iat = Math.floor(Date.now() / 1000), kid = 'e2e-kid') => {
    const b64 = (v: string | Buffer) => Buffer.from(v).toString('base64url');
    const header = b64(JSON.stringify({ alg: 'ES256', kid, typ: 'JWT' }));
    const payload = b64(
      JSON.stringify({
        iat,
        request_body_sha256: createHash('sha256').update(rawBody).digest('hex'),
      }),
    );
    const signer = createSign('SHA256');
    signer.update(`${header}.${payload}`);
    return `${header}.${payload}.${b64(signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }))}`;
  };
  return { fetchImpl, requests, sign, release: () => (released = generations.length) };
}

describe('Plaid connector (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jobs: JobRunnerService;
  let admin: Cookies;
  let companyId: string;
  let bankAccountId: string;
  let plaidId: string;
  const stub = plaidStub();

  const server = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req.set('Cookie', admin).set('x-company-id', companyId).set(CSRF);
  const sql = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await pool.query(text, params)).rows as T[];
  const drain = async () => {
    await jobs.drain();
    await jobs.drain();
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
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    jobs = app.get(JobRunnerService);
    app.get(IntegrationsService).fetchImpl = stub.fetchImpl;
    const login = await server().post('/api/v1/auth/login').send(ADMIN).expect(200);
    admin = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
    const companies = await server().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const banks = await as(server().get('/api/v1/bank-accounts')).expect(200);
    bankAccountId = banks.body.find((b: { code: string }) => b.code === 'BDO-MAIN').id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('exchanges a Link public token for an access token on connect, stores it encrypted and classifies Plaid errors', async () => {
    const providers = await as(server().get('/api/v1/integrations/providers')).expect(200);
    const plaid = providers.body.find((p: { provider: string }) => p.provider === 'PLAID');
    expect(plaid).toMatchObject({ category: 'BANKING', authType: 'BASIC' });
    expect(plaid.demo).toBeFalsy();

    const badSecret = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'PLAID',
        name: 'Plaid (bad secret)',
        credentials: { username: CLIENT_ID, password: 'wrong', bearerToken: PUBLIC_TOKEN },
        config: { bankAccountId },
      })
      .expect(201);
    expect(badSecret.body.status).toBe('ERROR');
    // HTTP 400 from Plaid, but INVALID_API_KEYS is an authentication problem, not a validation one.
    expect(badSecret.body.lastError).toMatch(/AUTHENTICATION_ERROR/);
    expect(badSecret.body.lastError).toMatch(/INVALID_API_KEYS/);

    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'PLAID',
        name: 'BDO via Plaid',
        scopes: ['banking:read', 'banking:write'],
        credentials: { username: CLIENT_ID, password: SECRET, bearerToken: PUBLIC_TOKEN },
        config: { bankAccountId, openingBalance: '10000.00', environment: 'SANDBOX' },
      })
      .expect(201);
    plaidId = created.body.id;
    expect(created.body.status).toBe('CONNECTED');
    expect(JSON.stringify(created.body)).not.toContain(SECRET);
    expect(JSON.stringify(created.body)).not.toContain(ACCESS_TOKEN);
    // The public token was exchanged once; the encrypted store now holds the access token.
    expect(stub.requests.filter((r) => r.url.endsWith('/item/public_token/exchange'))).toHaveLength(
      2,
    );
    const [cred] = await sql<{ ciphertext: string }>(
      "select ciphertext from integration_credentials where integration_id = $1 and kind = 'BEARER'",
      [plaidId],
    );
    expect(cred!.ciphertext).not.toContain(ACCESS_TOKEN);
    expect(cred!.ciphertext).not.toContain(PUBLIC_TOKEN);
    const test = await as(server().post(`/api/v1/integrations/${plaidId}/test`)).expect(200);
    expect(test.body).toMatchObject({
      ok: true,
      details: { accountId: 'acc_checking', currency: 'PHP', currentBalance: 1200.5 },
    });
    const accountsCall = [...stub.requests].reverse().find((r) => r.url.endsWith('/accounts/get'))!;
    expect(accountsCall.body).toEqual({ access_token: ACCESS_TOKEN });
    expect(accountsCall.headers['plaid-client-id']).toBe(CLIENT_ID);
    const logs = await as(server().get(`/api/v1/integrations/${plaidId}/logs`)).expect(200);
    expect(JSON.stringify(logs.body)).not.toContain(SECRET);
    expect(JSON.stringify(logs.body)).not.toContain(ACCESS_TOKEN);
  });

  it('pulls /transactions/sync pages into daily statements with continuous balances - never into the ledger', async () => {
    stub.requests.length = 0;
    const journalsBefore = (await sql('select count(*)::int as n from journal_entries'))[0]!.n;
    const queued = await as(server().post(`/api/v1/integrations/${plaidId}/sync`))
      .send({ mode: 'FULL' })
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${plaidId}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    // 6 transactions over pages of 3; the card and pending rows are dropped; dates 03-02, 03-03 (page 1) and 03-04 (page 2).
    expect(job.body).toMatchObject({ status: 'COMPLETED', recordsCreated: 3, recordsFailed: 0 });
    const syncCalls = stub.requests.filter((r) => r.url.endsWith('/transactions/sync'));
    expect(syncCalls).toHaveLength(2);
    expect(syncCalls[0]!.body).toMatchObject({ access_token: ACCESS_TOKEN, count: 100 });
    expect(syncCalls[1]!.body).toMatchObject({ cursor: '3' });

    const statements = await as(
      server().get(`/api/v1/bank-statements?bankAccountId=${bankAccountId}`),
    ).expect(200);
    const plaidStatements = statements.body.items
      .filter((s: { fileName: string }) => s.fileName.startsWith('PLAID:acc_checking:'))
      .sort((a: { statementDate: string }, b: { statementDate: string }) =>
        a.statementDate.localeCompare(b.statementDate),
      );
    expect(plaidStatements).toHaveLength(3);
    // Running balance: 10000 + 15000 - 2500 = 22500; - 320.75 = 22179.25; - 899.99 = 21279.26.
    expect(
      plaidStatements.map((s: Record<string, string>) => [
        s.statementDate,
        s.openingBalance,
        s.closingBalance,
      ]),
    ).toEqual([
      ['2026-03-02', '10000.0000', '22500.0000'],
      ['2026-03-03', '22500.0000', '22179.2500'],
      ['2026-03-04', '22179.2500', '21279.2600'],
    ]);
    const lines = await as(
      server().get(`/api/v1/bank-statements/${plaidStatements[0].id}/lines`),
    ).expect(200);
    expect(
      lines.body.map((l: Record<string, string>) => [l.description, l.amount, l.reference]),
    ).toEqual([
      ['Northwind', '15000.0000', 't1'],
      ['BANK SERVICE CHARGE', '-2500.0000', 't2'],
    ]);
    const day3 = await as(
      server().get(`/api/v1/bank-statements/${plaidStatements[2].id}/lines`),
    ).expect(200);
    expect(day3.body[0]).toMatchObject({ description: 'Check 1042', reference: 'CHK 1042' });
    // A bank feed is evidence for reconciliation: no journal entry was written.
    expect((await sql('select count(*)::int as n from journal_entries'))[0]!.n).toBe(
      journalsBefore,
    );
    const cursors = await as(server().get(`/api/v1/integrations/${plaidId}/cursors`)).expect(200);
    expect(JSON.parse(cursors.body[0].cursor)).toEqual({ cursor: '6', balance: '21279.26' });

    // Incremental re-run: Plaid has nothing new -> no records, cursor kept.
    const again = await as(server().post(`/api/v1/integrations/${plaidId}/sync`))
      .send({})
      .expect(202);
    await drain();
    const job2 = await as(
      server().get(`/api/v1/integrations/${plaidId}/sync-jobs/${again.body.id}`),
    ).expect(200);
    expect(job2.body).toMatchObject({ status: 'COMPLETED', recordsProcessed: 0 });
    expect(
      stub.requests.filter((r) => r.url.endsWith('/transactions/sync')).at(-1)!.body,
    ).toMatchObject({
      cursor: '6',
    });
  });

  it('verifies Plaid-signed webhooks (ES256 JWT + body hash) and syncs the new transactions on SYNC_UPDATES_AVAILABLE', async () => {
    stub.release();
    const raw = JSON.stringify({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'item_e2e',
      initial_update_complete: true,
      historical_update_complete: true,
      environment: 'sandbox',
    });
    const post = (body: string, jwt: string | undefined) => {
      const req = server()
        .post(`/api/v1/webhooks/inbound/${plaidId}`)
        .set('content-type', 'application/json');
      return (jwt ? req.set('plaid-verification', jwt) : req).send(body);
    };
    // Unsigned, tampered, stale and unknown-key deliveries are all refused before anything runs.
    await post(raw, undefined).expect(401);
    await post(raw + ' ', stub.sign(raw)).expect(401);
    await post(raw, stub.sign(raw, Math.floor(Date.now() / 1000) - 7200)).expect(401);
    await post(raw, stub.sign(raw, undefined, 'other-kid')).expect(401);
    const statementsBefore = (
      await sql('select count(*)::int as n from bank_statements where file_name like $1', [
        'PLAID:%',
      ])
    )[0]!.n;
    expect(statementsBefore).toBe(3);

    const accepted = await post(raw, stub.sign(raw)).expect(202);
    expect(accepted.body).toMatchObject({ accepted: true, duplicate: false });
    await drain();
    const events = await as(server().get(`/api/v1/integrations/${plaidId}/events`)).expect(200);
    expect(events.body[0]).toMatchObject({
      eventType: 'TRANSACTIONS.SYNC_UPDATES_AVAILABLE',
      status: 'PROCESSED',
    });
    // The webhook triggered an incremental sync that picked up only the new generation.
    const jobsList = await as(
      server().get(`/api/v1/integrations/${plaidId}/sync-jobs?pageSize=1`),
    ).expect(200);
    expect(jobsList.body.items[0]).toMatchObject({
      trigger: 'WEBHOOK',
      status: 'COMPLETED',
      recordsCreated: 1,
    });
    const [latest] = await sql<{
      opening_balance: string;
      closing_balance: string;
      statement_date: string;
    }>(
      "select opening_balance, closing_balance, statement_date::text from bank_statements where file_name like 'PLAID:%' order by statement_date desc limit 1",
    );
    expect(latest).toMatchObject({
      statement_date: '2026-03-05',
      opening_balance: '21279.2600',
      closing_balance: '29279.2600',
    });
    // Replay of the same signed body is deduplicated by the platform.
    const replay = await post(raw, stub.sign(raw)).expect(202);
    expect(replay.body.duplicate).toBe(true);
  });

  it('reports a lost bank login as an authentication failure that needs re-linking, not as bad data', async () => {
    // Simulate Plaid revoking the item: every call now answers ITEM_LOGIN_REQUIRED.
    const original = stub.fetchImpl;
    app.get(IntegrationsService).fetchImpl = async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/transactions/sync'))
        return new Response(
          JSON.stringify({
            error_type: 'ITEM_ERROR',
            error_code: 'ITEM_LOGIN_REQUIRED',
            error_message: 'the login details of this item have changed',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      return original(input, init);
    };
    const queued = await as(server().post(`/api/v1/integrations/${plaidId}/sync`))
      .send({})
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${plaidId}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body).toMatchObject({ status: 'FAILED', errorCode: 'AUTHENTICATION_ERROR' });
    expect(job.body.errorMessage).toMatch(/ITEM_LOGIN_REQUIRED/);
    const integration = await as(server().get(`/api/v1/integrations/${plaidId}`)).expect(200);
    expect(integration.body.status).toBe('ERROR');
    app.get(IntegrationsService).fetchImpl = original;
  });
});
