import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';
import { JobRunnerService } from '@/modules/jobs/job-runner.service';
import { OutboundWebhooksService } from '@/modules/integrations/webhooks/outbound-webhooks.service';
import { verifySignature } from '@/modules/integrations/webhooks/webhook-signature';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };
const FINANCE = { email: 'finance@acme.local', password: 'Demo!Passw0rd' };
const VIEWER = { email: 'viewer@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #4 - integration platform: API keys and scopes, idempotency,
 * connectors, sync, inbound webhooks (signature, replay), outbound webhooks
 * (signing, retry, replay), OAuth, logs, health and - above all - that every
 * ledger effect of an integration goes through the domain and the posting
 * engine.
 */
describe('Integration platform (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jobs: JobRunnerService;
  let outbound: OutboundWebhooksService;
  let admin: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  let bankGlAccountId: string;
  let bankAccountId: string;
  const acc: Record<string, string> = {};

  const server = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin, company: string = companyId) =>
    req.set('Cookie', who).set('x-company-id', company).set(CSRF);
  const withKey = (req: request.Test, secret: string, company: string = companyId) =>
    req.set('Authorization', `Bearer ${secret}`).set('x-company-id', company);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await server().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
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
    outbound = app.get(OutboundWebhooksService);
    admin = await login(ADMIN);
    finance = await login(FINANCE);
    viewer = await login(VIEWER);
    const companies = await server().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    otherCompanyId = companies.body.find((c: { code: string }) => c.code !== 'ACME').id;
    const chart = await as(server().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const banks = await as(server().get('/api/v1/bank-accounts')).expect(200);
    const bdo = banks.body.find((b: { code: string }) => b.code === 'BDO-MAIN');
    bankAccountId = bdo.id;
    bankGlAccountId = bdo.glAccountId;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------- catalogue

  it('lists the connector catalogue and the scope catalogue without leaking secrets or schemas', async () => {
    const providers = await as(server().get('/api/v1/integrations/providers')).expect(200);
    const keys = providers.body.map((p: { provider: string }) => p.provider);
    expect(keys).toEqual(
      expect.arrayContaining([
        'DEMO_BANK',
        'DEMO_PAYMENT_GATEWAY',
        'DEMO_ECOMMERCE',
        'DEMO_TAX_AUTHORITY',
        'DEMO_OAUTH_CRM',
      ]),
    );
    expect(
      providers.body
        .filter((p: { provider: string }) => p.provider.startsWith('DEMO_'))
        .every((p: { demo: boolean }) => p.demo),
    ).toBe(true);
    const scopes = await as(server().get('/api/v1/api-keys/scopes')).expect(200);
    const post = scopes.body.find((s: { scope: string }) => s.scope === 'invoices:write');
    expect(post.permissions).not.toContain('invoice.post');
    await as(server().get('/api/v1/integrations/providers'), viewer).expect(403);
    // Seeded demo integrations are present and connected.
    const list = await as(server().get('/api/v1/integrations')).expect(200);
    expect(list.body.items.map((i: { name: string }) => i.name)).toEqual(
      expect.arrayContaining([
        'Demo Bank',
        'Demo Payment Gateway',
        'Demo E-Commerce',
        'Demo Tax Provider',
      ]),
    );
    for (const item of list.body.items) {
      expect(JSON.stringify(item)).not.toMatch(/demo-(bank|pg|shop|tax)-/);
      expect(item.credentials.every((c: { kind: string }) => !('ciphertext' in c))).toBe(true);
    }
  });

  // -------------------------------------------------------------- API keys

  let apiKeySecret: string;
  let apiKeyId: string;

  it('mints an API key (secret shown once), authenticates with it and enforces scopes', async () => {
    const created = await as(server().post('/api/v1/api-keys'))
      .send({
        name: 'Storefront sync',
        scopes: ['customers:read', 'customers:write', 'journals:create', 'journals:read'],
        rateLimitPerMinute: 1000,
      })
      .expect(201);
    apiKeySecret = created.body.secret;
    apiKeyId = created.body.id;
    expect(apiKeySecret.startsWith('ak_')).toBe(true);
    expect(created.body.keyHash).toBeUndefined();
    const listed = await as(server().get('/api/v1/api-keys')).expect(200);
    expect(listed.body[0].secret).toBeUndefined();
    expect(listed.body.find((k: { id: string }) => k.id === apiKeyId).effectiveStatus).toBe(
      'ACTIVE',
    );

    const me = await withKey(server().get('/api/v1/auth/me'), apiKeySecret).expect(200);
    expect(me.body.user.email).toBe(ADMIN.email);
    expect(me.body.permissions).toEqual(
      expect.arrayContaining(['customer.view', 'customer.manage', 'journal.create']),
    );
    expect(me.body.permissions).not.toContain('journal.post');
    expect(me.headers['x-ratelimit-remaining']).toBeDefined();

    await withKey(server().get('/api/v1/customers'), apiKeySecret).expect(200);
    const customer = await withKey(server().post('/api/v1/customers'), apiKeySecret)
      .send({ code: 'API-CUST-1', name: 'Created through API key' })
      .expect(201);
    expect(customer.body.code).toBe('API-CUST-1');
    // Out of scope: invoices and posting.
    const denied = await withKey(server().get('/api/v1/invoices'), apiKeySecret).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    await withKey(server().get('/api/v1/api-keys'), apiKeySecret).expect(403);
  });

  it('accounting safety: an API key can draft a journal but can never post it', async () => {
    const draft = await withKey(server().post('/api/v1/journal-entries'), apiKeySecret)
      .send({
        entryDate: '2026-03-10',
        description: 'API drafted journal',
        lines: [
          { accountId: acc['1110'], debit: '100', credit: '0' },
          { accountId: acc['4100'], debit: '0', credit: '100' },
        ],
      })
      .expect(201);
    expect(draft.body.status).toBe('DRAFT');
    await withKey(
      server().post(`/api/v1/journal-entries/${draft.body.id}/submit`),
      apiKeySecret,
    ).expect(403);
    await withKey(
      server().post(`/api/v1/journal-entries/${draft.body.id}/post`),
      apiKeySecret,
    ).expect(403);
    const [[row]] = [
      await sql<{ status: string }>('select status from journal_entries where id = $1', [
        draft.body.id,
      ]),
    ];
    expect(row!.status).toBe('DRAFT');
  });

  it('rejects invalid, revoked, expired and over-quota keys; company lists and rotation are enforced', async () => {
    const invalid = await withKey(
      server().get('/api/v1/customers'),
      'ak_definitely_not_a_key_000000',
    ).expect(401);
    expect(invalid.body.code).toBe('API_KEY_INVALID');

    const limited = await as(server().post('/api/v1/api-keys'))
      .send({
        name: 'Tiny quota',
        scopes: ['customers:read'],
        rateLimitPerMinute: 2,
        companyIds: [otherCompanyId],
      })
      .expect(201);
    const wrongCompany = await withKey(
      server().get('/api/v1/customers'),
      limited.body.secret,
    ).expect(403);
    expect(wrongCompany.body.code).toBe('COMPANY_NOT_ACCESSIBLE');
    await withKey(server().get('/api/v1/customers'), limited.body.secret, otherCompanyId).expect(
      200,
    );
    const tooMany = await withKey(
      server().get('/api/v1/customers'),
      limited.body.secret,
      otherCompanyId,
    ).expect(429);
    expect(tooMany.body.code).toBe('RATE_LIMITED');

    const expiring = await as(server().post('/api/v1/api-keys'))
      .send({
        name: 'Already expired',
        scopes: ['customers:read'],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(201);
    const expired = await withKey(server().get('/api/v1/customers'), expiring.body.secret).expect(
      401,
    );
    expect(expired.body.code).toBe('API_KEY_EXPIRED');

    const rotated = await as(server().post(`/api/v1/api-keys/${apiKeyId}/rotate`))
      .send({ graceMinutes: 0 })
      .expect(201);
    expect(rotated.body.secret).not.toBe(apiKeySecret);
    expect(rotated.body.scopes).toEqual([
      'customers:read',
      'customers:write',
      'journals:create',
      'journals:read',
    ]);
    const oldKey = await withKey(server().get('/api/v1/customers'), apiKeySecret).expect(401);
    expect(oldKey.body.code).toBe('API_KEY_REVOKED');
    apiKeySecret = rotated.body.secret;
    apiKeyId = rotated.body.id;
    await withKey(server().get('/api/v1/customers'), apiKeySecret).expect(200);

    await as(server().delete(`/api/v1/api-keys/${apiKeyId}`))
      .send({ reason: 'test' })
      .expect(200);
    const revoked = await withKey(server().get('/api/v1/customers'), apiKeySecret).expect(401);
    expect(revoked.body.code).toBe('API_KEY_REVOKED');
    const audit = await as(server().get('/api/v1/audit-logs?entityType=ApiKey')).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'ROTATE', 'REVOKE']),
    );
  });

  // ------------------------------------------------------------ idempotency

  it('replays identical requests under an Idempotency-Key and rejects a different payload', async () => {
    const key = `cust-${Date.now()}`;
    const body = { code: 'IDEMP-1', name: 'Idempotent customer' };
    const first = await as(server().post('/api/v1/customers'))
      .set('idempotency-key', key)
      .send(body)
      .expect(201);
    const second = await as(server().post('/api/v1/customers'))
      .set('idempotency-key', key)
      .send(body)
      .expect(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    const rows = await sql('select count(*)::int as n from customers where code = $1', ['IDEMP-1']);
    expect(rows[0]!.n).toBe(1);
    const conflict = await as(server().post('/api/v1/customers'))
      .set('idempotency-key', key)
      .send({ ...body, name: 'Changed' })
      .expect(422);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    // A deterministic client error is replayed too (same key, same bad body).
    const badKey = `bad-${Date.now()}`;
    await as(server().post('/api/v1/customers'))
      .set('idempotency-key', badKey)
      .send({ code: 'IDEMP-1', name: 'Dup' })
      .expect(409);
    const replayed = await as(server().post('/api/v1/customers'))
      .set('idempotency-key', badKey)
      .send({ code: 'IDEMP-1', name: 'Dup' })
      .expect(409);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
  });

  // ---------------------------------------------------- connectors and sync

  let shopId: string;

  it('connects a store, pulls customers and orders through mapping into the domain (DRAFT invoices), idempotently', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_ECOMMERCE',
        name: 'E2E Store',
        scopes: ['customers:write', 'invoices:write', 'invoices:post'],
        credentials: {
          bearerToken: 'demo-shop-e2e-token',
          webhookSecret: 'shop-webhook-secret-e2e',
        },
        config: {
          storeUrl: 'https://e2e-store.example',
          autoPost: true,
          fixture: {
            customers: [
              {
                id: 'c_1',
                name: 'Northwind Traders',
                email: 'AP@Northwind.Example',
                address: { line1: '1 Way', city: 'Davao City', country: 'ph' },
              },
              { id: 'c_2', name: 'Contoso', email: 'ap@contoso.example' },
            ],
            orders: [
              {
                id: 'o_1',
                order_number: 'WEB-1',
                customer_id: 'c_1',
                created_at: '2026-03-02T10:00:00Z',
                currency: 'PHP',
                line_items: [{ title: 'Service plan', quantity: '2', price: '1200.00' }],
              },
              {
                id: 'o_2',
                order_number: 'WEB-2',
                customer_id: 'c_2',
                created_at: '2026-03-03T10:00:00Z',
                currency: 'PHP',
                line_items: [{ title: 'Setup', price: '800.50' }],
              },
              {
                id: 'o_3',
                order_number: 'WEB-3',
                customer_id: 'c_missing',
                created_at: '2026-03-03T10:00:00Z',
                currency: 'PHP',
                line_items: [{ title: 'Orphan', price: '1.00' }],
              },
            ],
          },
        },
      })
      .expect(201);
    shopId = created.body.id;
    expect(created.body.status).toBe('CONNECTED');
    expect(created.body.credentials.map((c: { kind: string }) => c.kind).sort()).toEqual([
      'BEARER',
      'WEBHOOK_SECRET',
    ]);
    expect(JSON.stringify(created.body)).not.toContain('demo-shop-e2e-token');

    const test = await as(server().post(`/api/v1/integrations/${shopId}/test`)).expect(200);
    expect(test.body.ok).toBe(true);

    const queued = await as(server().post(`/api/v1/integrations/${shopId}/sync`))
      .send({ mode: 'FULL' })
      .expect(202);
    expect(queued.body.status).toBe('QUEUED');
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${shopId}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body.status).toBe('COMPLETED');
    expect(job.body.recordsProcessed).toBe(5);
    expect(job.body.recordsCreated).toBe(4);
    expect(job.body.recordsFailed).toBe(1);
    expect(job.body.failures[0]).toMatchObject({ externalId: 'o_3', code: 'MAPPING_ERROR' });

    const customers = await as(server().get('/api/v1/customers?search=EC-C_')).expect(200);
    const northwind = customers.body.items.find((c: { code: string }) => c.code === 'EC-C_1');
    expect(northwind).toMatchObject({
      name: 'Northwind Traders',
      email: 'ap@northwind.example',
      country: 'PH',
    });
    const invoices = await as(server().get('/api/v1/invoices?search=WEB-')).expect(200);
    expect(invoices.body.items).toHaveLength(2);
    const web1 = invoices.body.items.find((i: { reference: string }) => i.reference === 'WEB-1');
    expect(web1.total).toBe('2400.0000');
    // autoPost + invoices:post: the invoice was approved and posted through InvoicesService -> AccountingPostingService.
    expect(web1.accountingStatus).toBe('POSTED');
    expect(web1.journalNumber).toMatch(/^JE-/);

    // Second run: everything already linked -> skipped, nothing duplicated.
    const again = await as(server().post(`/api/v1/integrations/${shopId}/sync`))
      .send({ mode: 'FULL' })
      .expect(202);
    await drain();
    const job2 = await as(
      server().get(`/api/v1/integrations/${shopId}/sync-jobs/${again.body.id}`),
    ).expect(200);
    expect(job2.body.status).toBe('COMPLETED');
    expect(job2.body.recordsCreated).toBe(0);
    expect(job2.body.recordsUpdated).toBe(2); // customers refreshed
    expect(job2.body.recordsSkipped).toBe(2); // invoices already imported
    expect(
      (await sql('select count(*)::int as n from invoices where reference like $1', ['WEB-%']))[0]!
        .n,
    ).toBe(2);

    const refs = await as(
      server().get(`/api/v1/integrations/${shopId}/external-references?entityType=invoices`),
    ).expect(200);
    expect(refs.body).toHaveLength(2);
    const cursors = await as(server().get(`/api/v1/integrations/${shopId}/cursors`)).expect(200);
    expect(cursors.body.map((c: { entity: string }) => c.entity).sort()).toEqual([
      'customers',
      'invoices',
    ]);
    const jobsList = await as(server().get(`/api/v1/integrations/${shopId}/sync-jobs`)).expect(200);
    expect(jobsList.body.total).toBe(2);
    const audit = await as(server().get('/api/v1/audit-logs?entityType=IntegrationSyncJob')).expect(
      200,
    );
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['SYNC_START', 'SYNC_COMPLETE']),
    );
  });

  it('a sync is refused without the matching scope and never posts without an explicit :post scope', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_ECOMMERCE',
        name: 'Draft-only store',
        scopes: ['customers:write', 'invoices:write'],
        credentials: { bearerToken: 'demo-shop-draft-token' },
        config: {
          autoPost: true,
          fixture: {
            customers: [{ id: 'd_1', name: 'Draft Only Co' }],
            orders: [
              {
                id: 'd_o1',
                order_number: 'DRAFT-1',
                customer_id: 'd_1',
                created_at: '2026-03-04T10:00:00Z',
                line_items: [{ title: 'X', price: '10.00' }],
              },
            ],
          },
        },
      })
      .expect(201);
    const queued = await as(server().post(`/api/v1/integrations/${created.body.id}/sync`))
      .send({})
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${created.body.id}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body.status).toBe('COMPLETED');
    // The invoice was created as a draft, then the post step failed on scope -> recorded as a record failure.
    expect(job.body.recordsFailed).toBe(1);
    expect(job.body.failures[0].code).toBe('AUTHORIZATION_ERROR');
    const [inv] = await sql<{ status: string; accounting_status: string }>(
      'select status, accounting_status from invoices where reference = $1',
      ['DRAFT-1'],
    );
    expect(inv).toMatchObject({ status: 'DRAFT', accounting_status: 'UNPOSTED' });
  });

  it('records failures: bad credentials mark the integration ERROR with a redacted log entry', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_BANK',
        name: 'Bad bank',
        credentials: { apiKey: 'wrong-key-value' },
        config: { bankAccountId },
      })
      .expect(201);
    expect(created.body.status).toBe('ERROR');
    expect(created.body.lastError).toMatch(/AUTHENTICATION_ERROR/);
    const connect = await as(
      server().post(`/api/v1/integrations/${created.body.id}/connect`),
    ).expect(422);
    expect(connect.body.code).toBe('INTEGRATION_ERROR');
    const logs = await as(server().get(`/api/v1/integrations/${created.body.id}/logs`)).expect(200);
    expect(
      logs.body.items.some(
        (l: { status: string; errorCode: string }) =>
          l.status === 'FAILURE' && l.errorCode === 'AUTHENTICATION_ERROR',
      ),
    ).toBe(true);
    expect(JSON.stringify(logs.body)).not.toContain('wrong-key-value');
    const health = await as(server().get(`/api/v1/integrations/${created.body.id}/health`)).expect(
      200,
    );
    expect(health.body.status).toBe('UNHEALTHY');
    expect(health.body.deductions.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(['ERROR', 'CONSECUTIVE_FAILURES']),
    );
    const bad = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_BANK',
        name: 'Misconfigured bank',
        credentials: { apiKey: 'demo-bank-x' },
        config: { bankAccountId: 'not-a-uuid' },
      })
      .expect(422);
    expect(bad.body.code).toBe('INTEGRATION_CONFIG_INVALID');
    const sync = await as(server().post(`/api/v1/integrations/${created.body.id}/sync`))
      .send({})
      .expect(202);
    await drain();
    const failed = await as(
      server().get(`/api/v1/integrations/${created.body.id}/sync-jobs/${sync.body.id}`),
    ).expect(200);
    expect(failed.body.status).toBe('FAILED');
    expect(failed.body.errorCode).toBe('AUTHENTICATION_ERROR');
  });

  it('imports a bank feed as statements for reconciliation (never as ledger entries)', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_BANK',
        name: 'E2E bank feed',
        scopes: ['banking:write', 'banking:read'],
        credentials: { apiKey: 'demo-bank-e2e-key' },
        config: {
          bankAccountId,
          fixture: {
            statements: [
              {
                statement_id: 'STMT-E2E-1',
                statement_date: '2026-03-31',
                opening_balance: '0.00',
                closing_balance: '900.00',
                transactions: [
                  {
                    date: '2026-03-05',
                    description: 'Deposit',
                    reference: 'DEP-1',
                    amount: '1000.00',
                  },
                  { date: '2026-03-06', description: 'Fee', amount: '-100.00' },
                ],
              },
            ],
          },
        },
      })
      .expect(201);
    const before = (await sql('select count(*)::int as n from journal_entries'))[0]!.n;
    const queued = await as(server().post(`/api/v1/integrations/${created.body.id}/sync`))
      .send({})
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${created.body.id}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body).toMatchObject({ status: 'COMPLETED', recordsCreated: 1 });
    const statements = await as(
      server().get(`/api/v1/bank-statements?bankAccountId=${bankAccountId}`),
    ).expect(200);
    expect(
      statements.body.items.some(
        (s: { fileName: string }) => s.fileName === 'DEMO_BANK:STMT-E2E-1',
      ),
    ).toBe(true);
    expect((await sql('select count(*)::int as n from journal_entries'))[0]!.n).toBe(before);
  });

  // ------------------------------------------------------- inbound webhooks

  let gatewayId: string;
  const gatewaySecret = 'pg-webhook-secret-for-e2e';
  const signed = (body: object, secret = gatewaySecret, ts = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    return { raw, header: `t=${ts},v1=${mac}` };
  };

  it('accepts a signed payment webhook, imports the receipt through the domain and posts it to the GL', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_PAYMENT_GATEWAY',
        name: 'E2E gateway',
        scopes: ['customers:write', 'payments:write', 'payments:post'],
        credentials: { apiKey: 'demo-pg-e2e-secret', webhookSecret: gatewaySecret },
        config: { cashAccountId: bankGlAccountId, autoPost: true },
      })
      .expect(201);
    gatewayId = created.body.id;
    expect(created.body.status).toBe('CONNECTED');

    const event = {
      id: 'evt_pay_001',
      type: 'payment.received',
      created: '2026-03-09T12:00:00Z',
      data: {
        id: 'pay_001',
        customer_code: 'EC-C_1',
        amount: '2400.00',
        currency: 'php',
        created: '2026-03-09T12:00:00Z',
        status: 'succeeded',
        description: 'Order WEB-1',
        metadata: { order_id: 'WEB-1' },
      },
    };
    const { raw, header } = signed(event);
    const receipt = await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .set('x-webhook-signature', header)
      .send(raw)
      .expect(202);
    expect(receipt.body).toMatchObject({ accepted: true, duplicate: false });
    await drain();

    const payments = await as(server().get('/api/v1/customer-payments?search=pay_001')).expect(200);
    expect(payments.body.items).toHaveLength(1);
    const payment = payments.body.items[0];
    expect(payment.status).toBe('POSTED');
    expect(payment.amount).toBe('2400.0000');
    expect(payment.journalNumber).toMatch(/^JE-/);
    // The receipt settled the imported invoice (external reference o_1).
    const detail = await as(server().get(`/api/v1/customer-payments/${payment.id}`)).expect(200);
    expect(detail.body.allocations).toHaveLength(1);
    expect(detail.body.allocations[0].amount).toBe('2400.0000');
    // GL: Dr bank / Cr AR, written by AccountingPostingService with the payment as source document.
    const lines = await sql<{ account_id: string; debit: string; credit: string }>(
      'select l.account_id, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.journal_entry_id where e.source_type = $1 and e.source_id = $2 order by l.line_number',
      ['AR_PAYMENT', payment.id],
    );
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_id === bankGlAccountId)!.debit).toBe('2400.0000');
    const ar = await as(server().get('/api/v1/reports/ar-reconciliation?asOf=2026-12-31')).expect(
      200,
    );
    expect(ar.body.reconciled).toBe(true);

    const events = await as(server().get(`/api/v1/integrations/${gatewayId}/events`)).expect(200);
    expect(events.body[0]).toMatchObject({ externalEventId: 'evt_pay_001', status: 'PROCESSED' });
  });

  it('rejects invalid, stale and replayed webhooks', async () => {
    const event = {
      id: 'evt_pay_001',
      type: 'payment.received',
      data: { id: 'pay_001', customer_code: 'EC-C_1', amount: '2400.00', status: 'succeeded' },
    };
    const forged = signed(event, 'wrong-secret');
    const bad = await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .set('x-webhook-signature', forged.header)
      .send(forged.raw)
      .expect(401);
    expect(bad.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const stale = signed(event, gatewaySecret, Math.floor(Date.now() / 1000) - 3600);
    const old = await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .set('x-webhook-signature', stale.header)
      .send(stale.raw)
      .expect(401);
    expect(old.body.details.reason).toBe('STALE');
    await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .send(JSON.stringify(event))
      .expect(401);
    // Replay of the already-processed event id: acknowledged, never processed twice.
    const replay = signed({ ...event, data: { ...event.data, amount: '999999.00' } });
    const dup = await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .set('x-webhook-signature', replay.header)
      .send(replay.raw)
      .expect(202);
    expect(dup.body.duplicate).toBe(true);
    await drain();
    expect(
      (
        await sql('select count(*)::int as n from customer_payments where reference = $1', [
          'pay_001',
        ])
      )[0]!.n,
    ).toBe(1);
    // Unknown integration id and a tampered body are refused too.
    await server()
      .post('/api/v1/webhooks/inbound/00000000-0000-0000-0000-000000000000')
      .send({})
      .expect(404);
    const tampered = signed(event);
    await server()
      .post(`/api/v1/webhooks/inbound/${gatewayId}`)
      .set('content-type', 'application/json')
      .set('x-webhook-signature', tampered.header)
      .send(tampered.raw.replace('2400.00', '2401.00'))
      .expect(401);
  });

  // ------------------------------------------------------ outbound webhooks

  let receiver: http.Server;
  let receiverUrl: string;
  let receiverMode: 'ok' | 'fail' = 'ok';
  const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];

  it('delivers signed outbound webhooks from the transactional outbox, retries failures and replays', async () => {
    receiver = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.statusCode = receiverMode === 'ok' ? 200 : 500;
        res.end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

    const created = await as(server().post('/api/v1/webhooks'))
      .send({
        name: 'E2E receiver',
        url: receiverUrl,
        events: ['webhook.test', 'invoice.posted', 'payment.completed', 'journal.posted'],
        maxAttempts: 3,
      })
      .expect(201);
    const webhookId = created.body.id;
    const secret = created.body.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    expect((await as(server().get('/api/v1/webhooks')).expect(200)).body[0].secret).toBeUndefined();

    const test = await as(server().post(`/api/v1/webhooks/${webhookId}/test`)).expect(201);
    expect(test.body.status).toBe('DELIVERED');
    expect(received).toHaveLength(1);
    const ping = received[0]!;
    expect(ping.headers['x-webhook-event']).toBe('webhook.test');
    expect(
      verifySignature([secret], ping.body, ping.headers['x-webhook-signature'] as string).ok,
    ).toBe(true);
    expect(
      verifySignature(['other'], ping.body, ping.headers['x-webhook-signature'] as string).ok,
    ).toBe(false);

    // A real business event: post a customer payment -> outbox row -> delivery.
    const customers = await as(server().get('/api/v1/customers?search=EC-C_2')).expect(200);
    const payment = await as(server().post('/api/v1/customer-payments'))
      .send({
        partyId: customers.body.items[0].id,
        paymentDate: '2026-03-12',
        amount: '100',
        cashAccountId: acc['1110'],
        reference: 'OUTBOX-1',
      })
      .expect(201);
    await as(server().post(`/api/v1/customer-payments/${payment.body.id}/post`)).expect(201);
    const outbox = await sql<{ event_type: string; status: string }>(
      'select event_type, status from integration_events where direction = $1 and payload->>$2 = $3',
      ['OUTBOUND', 'paymentId', payment.body.id],
    );
    expect(outbox.map((o) => o.event_type).sort()).toEqual([
      'payment.completed',
      'payment.created',
    ]);
    await outbound.flush();
    const delivered = received.filter((r) => r.headers['x-webhook-event'] === 'payment.completed');
    expect(delivered).toHaveLength(1);
    expect(JSON.parse(delivered[0]!.body).data.documentNumber).toBe(payment.body.documentNumber);
    // journal.posted is emitted from inside the posting engine's transaction.
    expect(received.some((r) => r.headers['x-webhook-event'] === 'journal.posted')).toBe(true);

    // Failure path: receiver returns 500 -> RETRYING with backoff, then replay after recovery.
    receiverMode = 'fail';
    const failing = await as(server().post(`/api/v1/webhooks/${webhookId}/test`)).expect(201);
    expect(failing.body.status).toBe('EXHAUSTED'); // test deliveries get a single attempt
    expect(failing.body.lastHttpStatus).toBe(500);
    receiverMode = 'ok';
    const replay = await as(server().post(`/api/v1/webhooks/${webhookId}/replay`))
      .send({ deliveryIds: [failing.body.id] })
      .expect(201);
    expect(replay.body.replayed).toBe(1);
    await drain();
    const deliveries = await as(
      server().get(`/api/v1/webhooks/deliveries?webhookId=${webhookId}`),
    ).expect(200);
    const replayed = deliveries.body.items.find(
      (d: { replayOfId: string | null }) => d.replayOfId === failing.body.id,
    );
    expect(replayed.status).toBe('DELIVERED');
    await as(server().patch(`/api/v1/webhooks/${webhookId}`))
      .send({ status: 'DISABLED' })
      .expect(200);
    await as(server().post('/api/v1/webhooks'), viewer)
      .send({ name: 'x', url: receiverUrl, events: ['webhook.test'] })
      .expect(403);
    await new Promise<void>((r) => receiver.close(() => r()));
  });

  // ------------------------------------------------------------------ OAuth

  it('runs the OAuth authorisation-code flow with state validation, token refresh and disconnect', async () => {
    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'DEMO_OAUTH_CRM',
        name: 'E2E CRM',
        scopes: ['customers:write'],
        config: {
          clientId: 'e2e-client',
          fixture: {
            contacts: [
              {
                id: 'k1',
                properties: { company: 'CRM Imported Co', email: 'crm@example.com', owner: 'Ann' },
              },
            ],
          },
        },
      })
      .expect(201);
    const crmId = created.body.id;
    expect(created.body.status).toBe('DISCONNECTED');
    const start = await as(server().post(`/api/v1/integrations/${crmId}/oauth/start`))
      .send({ returnTo: '/admin/integrations/x' })
      .expect(200);
    const url = new URL(start.body.authorizationUrl);
    expect(url.origin).toBe('https://demo-crm.invalid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;

    const badState = await server()
      .get('/api/v1/integrations/oauth/callback?state=0123456789abcdef&code=demo-code-1')
      .expect(422);
    expect(badState.body.code).toBe('OAUTH_STATE_INVALID');
    const callback = await server()
      .get(
        `/api/v1/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=demo-code-1`,
      )
      .expect(302);
    expect(callback.headers.location).toBe(
      'http://localhost:3000/admin/integrations/x?oauth=success',
    );
    // State is single use.
    await server()
      .get(
        `/api/v1/integrations/oauth/callback?state=${encodeURIComponent(state)}&code=demo-code-1`,
      )
      .expect(422);

    const connected = await as(server().get(`/api/v1/integrations/${crmId}`)).expect(200);
    expect(connected.body.status).toBe('CONNECTED');
    expect(connected.body.oauth.status).toBe('CONNECTED');
    expect(JSON.stringify(connected.body)).not.toContain('demo-access-');
    const stored = await sql<{ ciphertext: string }>(
      'select ciphertext from integration_credentials where integration_id = $1',
      [crmId],
    );
    expect(stored[0]!.ciphertext.startsWith('v1:')).toBe(true);
    expect(stored[0]!.ciphertext).not.toContain('demo-access-');

    const refreshed = await as(server().post(`/api/v1/integrations/${crmId}/oauth/refresh`)).expect(
      200,
    );
    expect(refreshed.body.lastRefreshedAt).toBeDefined();
    const queued = await as(server().post(`/api/v1/integrations/${crmId}/sync`))
      .send({})
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${crmId}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body).toMatchObject({ status: 'COMPLETED', recordsCreated: 1 });
    const imported = await as(server().get('/api/v1/customers?search=CRM-K1')).expect(200);
    expect(imported.body.items[0].name).toBe('CRM Imported Co');

    const disconnected = await as(
      server().post(`/api/v1/integrations/${crmId}/oauth/disconnect`),
    ).expect(200);
    expect(disconnected.body.status).toBe('DISCONNECTED');
    expect(
      (
        await sql(
          'select count(*)::int as n from integration_credentials where integration_id = $1',
          [crmId],
        )
      )[0]!.n,
    ).toBe(0);
    const audit = await as(server().get('/api/v1/audit-logs?entityType=Integration')).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'CONNECT', 'DISCONNECT']),
    );
  });

  // ------------------------------------------------- mappings, logs, admin

  it('lets administrators override mappings, preview them and browse logs; viewers cannot', async () => {
    const preview = await as(server().post(`/api/v1/integrations/${shopId}/mappings/preview`))
      .send({ entity: 'customers', sample: { id: 'z9', name: '  Zed  ', email: 'Z@Z.IO' } })
      .expect(200);
    expect(preview.body.source).toBe('CONNECTOR_DEFAULT');
    expect(preview.body.output).toMatchObject({ code: 'EC-Z9', name: 'Zed', email: 'z@z.io' });
    const custom = await as(server().post(`/api/v1/integrations/${shopId}/mappings`))
      .send({
        entity: 'customers',
        name: 'Custom customer mapping',
        rules: [
          {
            target: 'code',
            source: 'id',
            transforms: [{ name: 'template', arg: 'SHOP-{value}' }, { name: 'upper' }],
            required: true,
          },
          { target: 'name', source: 'name', transforms: [{ name: 'trim' }], required: true },
          { target: 'notes', source: 'tier', transforms: [{ name: 'lookup', arg: 'tiers' }] },
        ],
        lookups: { tiers: { gold: 'VIP customer', '*': 'Standard' } },
      })
      .expect(201);
    expect(custom.body.version).toBe(1);
    const preview2 = await as(server().post(`/api/v1/integrations/${shopId}/mappings/preview`))
      .send({ entity: 'customers', sample: { id: 'z9', name: 'Zed', tier: 'gold' } })
      .expect(200);
    expect(preview2.body).toMatchObject({
      source: 'INTEGRATION',
      output: { code: 'SHOP-Z9', notes: 'VIP customer' },
    });
    const invalidRule = await as(server().post(`/api/v1/integrations/${shopId}/mappings`))
      .send({
        entity: 'customers',
        name: 'x',
        rules: [{ target: 'code', transforms: [{ name: 'explode' }] }],
      })
      .expect(400);
    expect(invalidRule.body.code).toBe('VALIDATION_FAILED');

    const logs = await as(server().get('/api/v1/integration-logs?pageSize=200')).expect(200);
    expect(logs.body.total).toBeGreaterThan(5);
    expect(
      logs.body.items.every((l: { operation: string }) => typeof l.operation === 'string'),
    ).toBe(true);
    expect(JSON.stringify(logs.body)).not.toMatch(/demo-(shop|pg|bank)-e2e/);
    await as(server().get('/api/v1/integration-logs'), viewer).expect(403);
    await as(server().get(`/api/v1/integrations/${shopId}`), viewer).expect(403);
    await as(server().post('/api/v1/integrations'), finance)
      .send({ provider: 'DEMO_BANK', name: 'F', config: { bankAccountId } })
      .expect(201);
    await as(server().delete(`/api/v1/integrations/${shopId}`), viewer).expect(403);

    const health = await as(server().get(`/api/v1/integrations/${shopId}/health`)).expect(200);
    expect(health.body.score).toBeGreaterThanOrEqual(80);
    expect(health.body.status).toBe('HEALTHY');
    const notifications = await as(server().get('/api/v1/notifications')).expect(200);
    expect(
      notifications.body.items.some(
        (n: { eventType: string }) =>
          n.eventType === 'SYNC_FAILED' || n.eventType === 'INTEGRATION_FAILED',
      ),
    ).toBe(true);
    const unread = await as(server().get('/api/v1/notifications/unread-count')).expect(200);
    expect(unread.body.count).toBeGreaterThan(0);
    await as(server().post('/api/v1/notifications/read-all')).expect(200);
    expect(
      (await as(server().get('/api/v1/notifications/unread-count')).expect(200)).body.count,
    ).toBe(0);
  });

  it('soft-deletes an integration, wiping credentials while keeping the audit trail', async () => {
    await as(server().delete(`/api/v1/integrations/${gatewayId}`)).expect(204);
    await as(server().get(`/api/v1/integrations/${gatewayId}`)).expect(404);
    expect(
      (
        await sql(
          'select count(*)::int as n from integration_credentials where integration_id = $1',
          [gatewayId],
        )
      )[0]!.n,
    ).toBe(0);
    expect(
      (await sql('select deleted_at from integrations where id = $1', [gatewayId]))[0]!.deleted_at,
    ).not.toBeNull();
    const audit = await as(
      server().get(`/api/v1/audit-logs?entityType=Integration&entityId=${gatewayId}`),
    ).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'CONNECT', 'DELETE']),
    );
    // Webhooks to a deleted integration are gone (410) rather than silently accepted.
    await server().post(`/api/v1/webhooks/inbound/${gatewayId}`).send({}).expect(404);
  });
});
