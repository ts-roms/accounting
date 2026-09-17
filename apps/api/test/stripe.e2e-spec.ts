import { createHmac } from 'node:crypto';
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
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

const GOOD_KEY = 'sk_test_e2e_0123456789';
/** Fixture timestamps inside the seeded FY2026 (2026-03-01T00:00:00Z). */
const T0 = Math.floor(Date.UTC(2026, 2, 1) / 1000);
const WEBHOOK_SECRET = 'whsec_e2e_signing_secret';

/**
 * In-memory stand-in for api.stripe.com: bearer auth, newest-first lists with
 * `starting_after` / `has_more` (page size capped at 2 to exercise
 * pagination) and `created[gt]` bounds. Records every request so the test can
 * assert headers and pagination behaviour.
 */
function stripeStub() {
  const customers = [
    {
      id: 'cus_A',
      object: 'customer',
      name: 'Alpha Retail',
      email: 'AP@Alpha.example',
      currency: 'php',
      created: T0 + 100,
      address: { line1: '1 Alpha St', city: 'Davao City', country: 'ph' },
    },
    {
      id: 'cus_B',
      object: 'customer',
      name: null,
      email: 'billing@beta.example',
      created: T0 + 200,
    },
    {
      id: 'cus_C',
      object: 'customer',
      name: 'Gamma Ltd',
      email: null,
      created: T0 + 300,
      deleted: false,
    },
  ];
  const charges = [
    {
      id: 'ch_settled_1',
      object: 'charge',
      amount: 250000,
      amount_refunded: 0,
      currency: 'php',
      customer: 'cus_A',
      status: 'succeeded',
      paid: true,
      refunded: false,
      created: T0 + 1000,
      description: 'Order 1001',
      metadata: { invoice_reference: 'NONE' },
    },
    {
      id: 'ch_refunded',
      object: 'charge',
      amount: 10000,
      amount_refunded: 10000,
      currency: 'php',
      customer: 'cus_A',
      status: 'succeeded',
      paid: true,
      refunded: true,
      created: T0 + 1100,
    },
    {
      id: 'ch_guest',
      object: 'charge',
      amount: 4550,
      amount_refunded: 0,
      currency: 'php',
      customer: null,
      status: 'succeeded',
      paid: true,
      refunded: false,
      created: T0 + 1200,
      description: 'Walk-in card sale',
    },
  ];
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const list = <T extends { id: string; created: number }>(rows: T[], url: URL) => {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 10), 2);
    const gt = url.searchParams.get('created[gt]');
    let sorted = [...rows].sort((a, b) => b.created - a.created);
    if (gt) sorted = sorted.filter((r) => r.created > Number(gt));
    const after = url.searchParams.get('starting_after');
    if (after) {
      const idx = sorted.findIndex((r) => r.id === after);
      sorted = idx >= 0 ? sorted.slice(idx + 1) : [];
    }
    return { object: 'list', data: sorted.slice(0, limit), has_more: sorted.length > limit };
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    requests.push({ url: url.toString(), headers });
    if (headers.authorization !== `Bearer ${GOOD_KEY}`)
      return json(401, {
        error: { type: 'invalid_request_error', message: 'Invalid API Key provided' },
      });
    if (url.pathname === '/v1/account')
      return json(200, { id: 'acct_e2e', business_profile: { name: 'E2E Shop' } });
    if (url.pathname === '/v1/customers') return json(200, list(customers, url));
    if (url.pathname === '/v1/charges') return json(200, list(charges, url));
    return json(404, { error: { message: `Unknown resource ${url.pathname}` } });
  };
  return { fetchImpl, requests, customers, charges };
}

describe('Stripe connector (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let jobs: JobRunnerService;
  let admin: Cookies;
  let companyId: string;
  let bankGlAccountId: string;
  let stripeId: string;
  const stub = stripeStub();

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
  const signed = (event: object, secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000)) => {
    const raw = JSON.stringify(event);
    const mac = createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
    return { raw, header: `t=${ts},v1=${mac}` };
  };
  const deliver = (event: object, secret?: string) => {
    const { raw, header } = signed(event, secret);
    return server()
      .post(`/api/v1/webhooks/inbound/${stripeId}`)
      .set('content-type', 'application/json')
      .set('stripe-signature', header)
      .send(raw);
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
    bankGlAccountId = banks.body.find((b: { code: string }) => b.code === 'BDO-MAIN').glAccountId;
    await as(server().post('/api/v1/customers'))
      .send({ code: 'WALKIN', name: 'Walk-in customers', paymentTermsDays: 0 })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('is listed as a real (non-demo) provider and connects with a Stripe secret key', async () => {
    const providers = await as(server().get('/api/v1/integrations/providers')).expect(200);
    const stripe = providers.body.find((p: { provider: string }) => p.provider === 'STRIPE');
    expect(stripe).toMatchObject({ category: 'PAYMENT', authType: 'API_KEY' });
    expect(stripe.demo).toBeFalsy();
    expect(stripe.capabilities).toEqual(
      expect.arrayContaining(['PULL', 'WEBHOOKS', 'INCREMENTAL_SYNC']),
    );

    const bad = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'STRIPE',
        name: 'Stripe (bad key)',
        credentials: { apiKey: 'sk_test_wrong' },
        config: { cashAccountId: bankGlAccountId },
      })
      .expect(201);
    expect(bad.body.status).toBe('ERROR');
    expect(bad.body.lastError).toMatch(/AUTHENTICATION_ERROR/);

    const created = await as(server().post('/api/v1/integrations'))
      .send({
        provider: 'STRIPE',
        name: 'Stripe',
        scopes: ['customers:write', 'payments:write', 'payments:post'],
        credentials: { apiKey: GOOD_KEY, webhookSecret: WEBHOOK_SECRET },
        config: { cashAccountId: bankGlAccountId, autoPost: true, guestCustomerCode: 'WALKIN' },
      })
      .expect(201);
    stripeId = created.body.id;
    expect(created.body.status).toBe('CONNECTED');
    expect(JSON.stringify(created.body)).not.toContain(GOOD_KEY);
    const test = await as(server().post(`/api/v1/integrations/${stripeId}/test`)).expect(200);
    expect(test.body).toMatchObject({ ok: true, details: { account: 'acct_e2e', mode: 'test' } });
    const account = [...stub.requests].reverse().find((r) => r.url.endsWith('/v1/account'))!;
    expect(account.headers['stripe-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(account.headers.authorization).toBe(`Bearer ${GOOD_KEY}`);
    // The secret never reaches the integration log.
    const logs = await as(server().get(`/api/v1/integrations/${stripeId}/logs`)).expect(200);
    expect(JSON.stringify(logs.body)).not.toContain(GOOD_KEY);
  });

  it('pulls customers and settled charges with pagination, converts minor units and posts receipts', async () => {
    stub.requests.length = 0;
    const queued = await as(server().post(`/api/v1/integrations/${stripeId}/sync`))
      .send({ mode: 'FULL' })
      .expect(202);
    await drain();
    const job = await as(
      server().get(`/api/v1/integrations/${stripeId}/sync-jobs/${queued.body.id}`),
    ).expect(200);
    expect(job.body).toMatchObject({
      status: 'COMPLETED',
      recordsProcessed: 5,
      recordsCreated: 5,
      recordsFailed: 0,
    });
    // 3 customers + 3 charges over pages of 2 -> two pages each.
    const customerCalls = stub.requests.filter((r) => r.url.includes('/v1/customers'));
    expect(customerCalls).toHaveLength(2);
    expect(new URL(customerCalls[1]!.url).searchParams.get('starting_after')).toBe('cus_B');
    expect(stub.requests.filter((r) => r.url.includes('/v1/charges'))).toHaveLength(2);

    const customers = await as(server().get('/api/v1/customers?search=STRIPE-')).expect(200);
    const alpha = customers.body.items.find((c: { code: string }) => c.code === 'STRIPE-CUS_A');
    expect(alpha).toMatchObject({
      name: 'Alpha Retail',
      email: 'ap@alpha.example',
      city: 'Davao City',
      country: 'PH',
    });
    // A customer without a name falls back to the e-mail as display name.
    expect(customers.body.items.find((c: { code: string }) => c.code === 'STRIPE-CUS_B').name).toBe(
      'billing@beta.example',
    );

    const payments = await as(server().get('/api/v1/customer-payments?search=ch_')).expect(200);
    expect(payments.body.items).toHaveLength(2);
    const settled = payments.body.items.find(
      (p: { reference: string }) => p.reference === 'ch_settled_1',
    );
    expect(settled).toMatchObject({ amount: '2500.0000', status: 'POSTED', method: 'CARD' });
    const guest = payments.body.items.find(
      (p: { reference: string }) => p.reference === 'ch_guest',
    );
    expect(guest).toMatchObject({ amount: '45.5000', status: 'POSTED', customerCode: 'WALKIN' });
    expect(
      payments.body.items.some((p: { reference: string }) => p.reference === 'ch_refunded'),
    ).toBe(false);
    // Receipts posted through CustomerPaymentsService -> AccountingPostingService: Dr bank / Cr AR.
    const lines = await sql<{ debit: string }>(
      'select l.debit from journal_lines l join journal_entries e on e.id = l.journal_entry_id where e.source_type = $1 and e.source_id = $2 and l.account_id = $3',
      ['AR_PAYMENT', settled.id, bankGlAccountId],
    );
    expect(lines[0]!.debit).toBe('2500.0000');

    // Stored cursors are JSON with the created[gt] bound for the next run.
    const cursors = await as(server().get(`/api/v1/integrations/${stripeId}/cursors`)).expect(200);
    const chargeCursor = JSON.parse(
      cursors.body.find((c: { entity: string }) => c.entity === 'payments').cursor,
    );
    expect(chargeCursor).toEqual({ createdGt: T0 + 1200 });

    // Incremental run: bounded by created[gt], nothing new, nothing duplicated.
    stub.requests.length = 0;
    const again = await as(server().post(`/api/v1/integrations/${stripeId}/sync`))
      .send({ mode: 'INCREMENTAL' })
      .expect(202);
    await drain();
    const job2 = await as(
      server().get(`/api/v1/integrations/${stripeId}/sync-jobs/${again.body.id}`),
    ).expect(200);
    expect(job2.body).toMatchObject({ status: 'COMPLETED', recordsProcessed: 0 });
    expect(
      new URL(stub.requests.find((r) => r.url.includes('/v1/charges'))!.url).searchParams.get(
        'created[gt]',
      ),
    ).toBe(String(T0 + 1200));
    expect(
      (
        await sql('select count(*)::int as n from customer_payments where reference like $1', [
          'ch_%',
        ])
      )[0]!.n,
    ).toBe(2);
  });

  it('accepts Stripe-signed webhooks, rejects forged / live-mode / replayed ones, and imports the money once', async () => {
    const charge = {
      id: 'ch_hook_1',
      object: 'charge',
      amount: 99900,
      amount_refunded: 0,
      currency: 'php',
      customer: 'cus_C',
      status: 'succeeded',
      paid: true,
      refunded: false,
      created: T0 + 2000,
      description: 'Webhook sale',
      metadata: {},
    };
    const event = {
      id: 'evt_hook_1',
      object: 'event',
      type: 'charge.succeeded',
      created: T0 + 2001,
      livemode: false,
      data: { object: charge },
    };
    const receipt = await deliver(event).expect(202);
    expect(receipt.body).toMatchObject({ accepted: true, duplicate: false });
    await drain();
    const payments = await as(server().get('/api/v1/customer-payments?search=ch_hook_1')).expect(
      200,
    );
    expect(payments.body.items[0]).toMatchObject({
      amount: '999.0000',
      status: 'POSTED',
      customerCode: 'STRIPE-CUS_C',
    });

    const forged = await deliver(event, 'whsec_other').expect(401);
    expect(forged.body.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    const live = await deliver({ ...event, id: 'evt_live', livemode: true }).expect(401);
    expect(live.body.details.reason).toBe('LIVEMODE_MISMATCH');
    const notEvent = await deliver({ id: 'ch_x', type: 'charge.succeeded', data: {} }).expect(401);
    expect(notEvent.body.details.reason).toBe('MALFORMED_BODY');
    // Replay of the same event id with a bigger amount is acknowledged but ignored.
    const replay = await deliver({
      ...event,
      data: { object: { ...charge, amount: 500000 } },
    }).expect(202);
    expect(replay.body.duplicate).toBe(true);
    await drain();
    expect(
      (
        await sql('select count(*)::int as n from customer_payments where reference = $1', [
          'ch_hook_1',
        ])
      )[0]!.n,
    ).toBe(1);

    // Customer updates flow through; unpaid sessions and refunds are ignored with a note.
    await deliver({
      id: 'evt_cust',
      type: 'customer.updated',
      livemode: false,
      data: {
        object: {
          id: 'cus_C',
          object: 'customer',
          name: 'Gamma Limited',
          email: 'ar@gamma.example',
        },
      },
    }).expect(202);
    await deliver({
      id: 'evt_refund',
      type: 'charge.refunded',
      livemode: false,
      data: { object: { ...charge, id: 'ch_r', refunded: true } },
    }).expect(202);
    await deliver({
      id: 'evt_cs',
      type: 'checkout.session.completed',
      livemode: false,
      data: {
        object: {
          id: 'cs_1',
          payment_status: 'paid',
          payment_intent: 'pi_1',
          amount_total: 100,
          currency: 'php',
        },
      },
    }).expect(202);
    await drain();
    const gamma = await as(server().get('/api/v1/customers?search=STRIPE-CUS_C')).expect(200);
    expect(gamma.body.items[0]).toMatchObject({ name: 'Gamma Limited', email: 'ar@gamma.example' });
    const events = await as(server().get(`/api/v1/integrations/${stripeId}/events`)).expect(200);
    expect(events.body.every((e: { status: string }) => e.status === 'PROCESSED')).toBe(true);
    expect(
      (
        await sql('select count(*)::int as n from customer_payments where reference in ($1, $2)', [
          'ch_r',
          'cs_1',
        ])
      )[0]!.n,
    ).toBe(0);
    const ar = await as(server().get('/api/v1/reports/ar-reconciliation?asOf=2026-12-31')).expect(
      200,
    );
    expect(ar.body.reconciled).toBe(true);
  });
});
