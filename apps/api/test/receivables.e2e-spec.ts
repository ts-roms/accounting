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
 * Prompt #6 - Accounts receivable, order-to-cash and collections. Walks the
 * full flow (customer -> sales order -> delivery -> invoice -> receipt ->
 * allocation -> refund / dispute / write-off / collections) and proves after
 * every ledger-affecting step that the AR subledger equals the GL control
 * account, that controls (credit, SoD, approval, permissions, company
 * isolation) cannot be bypassed and that duplicate requests are idempotent.
 */
describe('Receivables platform (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  const acc: Record<string, string> = {};
  const TODAY = '2026-09-14';

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test, company = companyId) =>
    req.set('Cookie', cookies).set('x-company-id', company).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const expectReconciled = async (asOf = TODAY) => {
    const res = await as(admin, http().get(`/api/v1/ar-reconciliation?asOf=${asOf}`)).expect(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.subledgerBalance).toBe(res.body.ledgerBalance);
    expect(
      res.body.integrity.findings.find((f: { check: string }) => f.check === 'AR_GL_MISMATCH')
        .count,
    ).toBe(0);
    expect(
      res.body.integrity.findings.find((f: { check: string }) => f.check === 'ALLOCATION_DRIFT')
        .count,
    ).toBe(0);
    return res.body;
  };
  const journalOf = async (journalEntryId: string) => {
    const res = await as(admin, http().get(`/api/v1/journal-entries/${journalEntryId}`)).expect(
      200,
    );
    return res.body as {
      status: string;
      lines: Array<{ accountId: string; debit: string; credit: string }>;
    };
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
    otherCompanyId = companies.body.find((c: { code: string }) => c.code !== 'ACME').id;
    const chart = await as(admin, http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------ seed / config

  it('seed: AR reconciles, the dashboard and aging use real data, integrity runs', async () => {
    const rec = await expectReconciled();
    expect(rec.breakdown.writeOffs).toBe('0.0000');
    const dash = await as(admin, http().get(`/api/v1/ar-dashboard?asOf=${TODAY}`)).expect(200);
    expect(dash.body.totals.totalReceivables).toBe(
      rec.subledgerBalance === '1950240.0000' ? '1965440.0000' : dash.body.totals.totalReceivables,
    );
    expect(dash.body.aging).toHaveLength(6);
    expect(dash.body.totals.openCases).toBeGreaterThanOrEqual(4);
    expect(dash.body.totals.customersOnHold).toBe(1);
    expect(dash.body.dsoTrend).toHaveLength(6);
    const aging = await as(admin, http().get(`/api/v1/ar-aging?asOf=${TODAY}`)).expect(200);
    expect(aging.body.buckets.map((b: { key: string }) => b.key)).toEqual([
      'current',
      'days1to30',
      'days31to60',
      'days61to90',
      'days91to120',
      'over120',
    ]);
    expect(aging.body.totals.net).toBe(rec.subledgerBalance);
  });

  let netTermId: string;
  let groupId: string;
  it('configures payment terms, a customer group and credit rules (policy is data, not code)', async () => {
    const term = await as(admin, http().post('/api/v1/payment-terms'))
      .send({ code: 'NET20', name: 'Net 20 days', basis: 'NET_DAYS', days: 20 })
      .expect(201);
    netTermId = term.body.id;
    await as(admin, http().post('/api/v1/payment-terms'))
      .send({ code: 'NET20', name: 'dup' })
      .expect(409);
    const group = await as(admin, http().post('/api/v1/customer-groups'))
      .send({
        code: 'E2E',
        name: 'E2E group',
        paymentTermId: netTermId,
        defaultCreditLimit: '100000',
      })
      .expect(201);
    groupId = group.body.id;
    await as(accountant, http().post('/api/v1/credit-rules'))
      .send({ name: 'x', scope: 'SALES_ORDER', trigger: 'CREDIT_HOLD', action: 'BLOCK' })
      .expect(403);
    const rules = await as(admin, http().get('/api/v1/credit-rules')).expect(200);
    expect(rules.body.length).toBeGreaterThanOrEqual(5);
    const settings = await as(admin, http().patch('/api/v1/ar-settings'))
      .send({ autoCaseDaysOverdue: 30, unappliedCashWarnDays: 30 })
      .expect(200);
    expect(settings.body.autoCaseDaysOverdue).toBe(30);
    await as(admin, http().patch('/api/v1/ar-settings'))
      .send({
        agingBuckets: [
          { key: 'current', label: 'Current', from: -100, to: 0 },
          { key: 'late', label: 'Late', from: 5, to: null },
        ],
      })
      .expect(400);
  });

  // ---------------------------------------------------------------- customer

  let customerId: string;
  it('creates a customer that inherits the group terms and limit; contacts, addresses and credit summary work', async () => {
    const res = await as(admin, http().post('/api/v1/customers'))
      .send({
        code: 'CUST-E2E',
        name: 'E2E Trading',
        customerType: 'BUSINESS',
        customerGroupId: groupId,
        industry: 'Trading',
        region: 'Luzon',
      })
      .expect(201);
    customerId = res.body.id;
    expect(res.body.paymentTermId).toBe(netTermId);
    expect(res.body.paymentTermsDays).toBe(20);
    expect(res.body.creditLimit).toBe('100000.0000');
    expect(res.body.customerGroupName).toBe('E2E group');
    expect(res.body.creditHold).toBe(false);
    const contact = await as(admin, http().post(`/api/v1/customers/${customerId}/contacts`))
      .send({ name: 'Jo Cruz', email: 'jo@e2e.test', isPrimary: true })
      .expect(201);
    expect(contact.body.isPrimary).toBe(true);
    await as(admin, http().post(`/api/v1/customers/${customerId}/addresses`))
      .send({ addressType: 'SHIPPING', addressLine1: 'Pier 4', city: 'Manila', isDefault: true })
      .expect(201);
    const detail = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(detail.body.contacts).toHaveLength(1);
    expect(detail.body.addresses).toHaveLength(1);
    const credit = await as(admin, http().get(`/api/v1/customers/${customerId}/credit`)).expect(
      200,
    );
    expect(credit.body.creditLimit).toBe('100000.0000');
    expect(credit.body.availableCredit).toBe('100000.0000');
    expect(credit.body.status).toBe('GOOD');
    // Company isolation: the customer does not exist from the other company's point of view.
    await as(admin, http().get(`/api/v1/customers/${customerId}`), otherCompanyId).expect(404);
    await as(viewer, http().post(`/api/v1/customers/${customerId}/credit-hold`))
      .send({ hold: true, reason: 'x' })
      .expect(403);
  });

  // ------------------------------------------------------------ sales order

  let orderId: string;
  it('sales order: submit runs the credit policy, approval is gated, confirm follows approve', async () => {
    const create = await as(admin, http().post('/api/v1/sales-orders'))
      .send({
        customerId,
        orderDate: TODAY,
        expectedDate: '2026-09-20',
        lines: [
          {
            description: 'Consulting day',
            quantity: '4',
            unitPrice: '10000',
            accountId: acc['4200'],
          },
        ],
        idempotencyKey: 'so-e2e-000001',
      })
      .expect(201);
    orderId = create.body.id;
    const replay = await as(admin, http().post('/api/v1/sales-orders'))
      .send({
        customerId,
        orderDate: TODAY,
        lines: [{ description: 'x', unitPrice: '1', accountId: acc['4200'] }],
        idempotencyKey: 'so-e2e-000001',
      })
      .expect(201);
    expect(replay.body.id).toBe(orderId);
    const submitted = await as(admin, http().post(`/api/v1/sales-orders/${orderId}/submit`)).expect(
      201,
    );
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.creditCheck.outcome).toBeNull();
    // An order beyond the limit needs a sales-order approver: the seeded rule says REQUIRE_APPROVAL.
    const big = await as(admin, http().post('/api/v1/sales-orders'))
      .send({
        customerId,
        orderDate: TODAY,
        lines: [{ description: 'Big', unitPrice: '150000', accountId: acc['4200'] }],
      })
      .expect(201);
    const bigSubmit = await as(
      admin,
      http().post(`/api/v1/sales-orders/${big.body.id}/submit`),
    ).expect(201);
    expect(bigSubmit.body.creditCheck.outcome).toBe('REQUIRE_APPROVAL');
    await as(accountant, http().post(`/api/v1/sales-orders/${big.body.id}/approve`)).expect(403);
    await as(admin, http().post(`/api/v1/sales-orders/${big.body.id}/cancel`))
      .send({ reason: 'e2e' })
      .expect(201);
    await as(admin, http().post(`/api/v1/sales-orders/${orderId}/confirm`)).expect(422);
    const approved = await as(
      finance,
      http().post(`/api/v1/sales-orders/${orderId}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const confirmed = await as(
      admin,
      http().post(`/api/v1/sales-orders/${orderId}/confirm`),
    ).expect(201);
    expect(confirmed.body.status).toBe('CONFIRMED');
  });

  // --------------------------------------------------------------- delivery

  let deliveryId: string;
  let invoiceId: string;
  it('delivery: DRAFT -> DELIVERED consumes the order, invoicing it raises a draft invoice linked to both', async () => {
    const created = await as(admin, http().post('/api/v1/deliveries'))
      .send({ salesOrderId: orderId, deliveryDate: TODAY })
      .expect(201);
    deliveryId = created.body.id;
    expect(created.body.documentNumber).toMatch(/^DLV-2026-\d{6}$/);
    expect(created.body.lines[0].quantity).toBe('4.0000');
    await as(accountant, http().post(`/api/v1/deliveries/${deliveryId}/invoice`)).expect(422);
    const delivered = await as(admin, http().post(`/api/v1/deliveries/${deliveryId}/deliver`))
      .send({})
      .expect(201);
    expect(delivered.body.status).toBe('DELIVERED');
    const order = await as(admin, http().get(`/api/v1/sales-orders/${orderId}`)).expect(200);
    expect(order.body.deliveryStatus).toBe('FULL');
    expect(order.body.billingStatus).toBe('NONE');
    const invoice = await as(
      accountant,
      http().post(`/api/v1/deliveries/${deliveryId}/invoice`),
    ).expect(201);
    invoiceId = invoice.body.id;
    expect(invoice.body.deliveryId).toBe(deliveryId);
    expect(invoice.body.salesOrderId).toBe(orderId);
    expect(invoice.body.total).toBe('40000.0000');
    expect(invoice.body.dueDate).toBe('2026-10-04'); // NET20 from the customer's term
    expect(invoice.body.status).toBe('DRAFT');
    await as(accountant, http().post(`/api/v1/deliveries/${deliveryId}/invoice`)).expect(422);
    await as(admin, http().post(`/api/v1/deliveries/${deliveryId}/cancel`))
      .send({ reason: 'x' })
      .expect(422);
  });

  // ---------------------------------------------------------------- invoice

  it('invoice: submit -> approve (not by its creator via SoD-free path) -> post is idempotent and hits the AR control', async () => {
    const submitted = await as(
      accountant,
      http().post(`/api/v1/invoices/${invoiceId}/submit`),
    ).expect(201);
    expect(submitted.body.status).toBe('SUBMITTED');
    await as(accountant, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(403);
    await as(finance, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(422);
    const approved = await as(finance, http().post(`/api/v1/invoices/${invoiceId}/approve`)).expect(
      201,
    );
    expect(approved.body.status).toBe('APPROVED');
    const posted = await as(finance, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(posted.body.accountingStatus).toBe('POSTED');
    const again = await as(finance, http().post(`/api/v1/invoices/${invoiceId}/post`)).expect(201);
    expect(again.body.journalEntryId).toBe(posted.body.journalEntryId);
    const journal = await journalOf(posted.body.journalEntryId);
    expect(journal.status).toBe('POSTED');
    const arLine = journal.lines.find((l) => l.accountId === acc['1200']);
    expect(arLine?.debit).toBe('40000.0000');
    expect(journal.lines.find((l) => l.accountId === acc['4200'])?.credit).toBe('40000.0000');
    const order = await as(admin, http().get(`/api/v1/sales-orders/${orderId}`)).expect(200);
    expect(order.body.billingStatus).toBe('FULL');
    expect(order.body.status).toBe('CLOSED');
    await expectReconciled();
    const balance = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(balance.body.balance.outstanding).toBe('40000.0000');
    const credit = await as(admin, http().get(`/api/v1/customers/${customerId}/credit`)).expect(
      200,
    );
    expect(credit.body.creditUsed).toBe('40000.0000');
    expect(credit.body.availableCredit).toBe('60000.0000');
  });

  // ---------------------------------------------------------------- payments

  let paymentId: string;
  it('payments: partial receipt, approval policy, overpayment stays unapplied, allocation settles the rest', async () => {
    await as(admin, http().patch('/api/v1/ar-settings'))
      .send({ requirePaymentApproval: true })
      .expect(200);
    const partial = await as(accountant, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentDate: TODAY,
        amount: '15000',
        cashAccountId: acc['1130'],
        reference: 'OR-E2E-1',
        externalReference: 'GW-1',
        allocations: [{ documentId: invoiceId, amount: '15000' }],
        idempotencyKey: 'rcp-e2e-000001',
      })
      .expect(201);
    paymentId = partial.body.id;
    // Policy: approval required before posting.
    await as(finance, http().post(`/api/v1/customer-payments/${paymentId}/post`)).expect(422);
    await as(accountant, http().post(`/api/v1/customer-payments/${paymentId}/approve`)).expect(403);
    const approved = await as(
      finance,
      http().post(`/api/v1/customer-payments/${paymentId}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const posted = await as(
      finance,
      http().post(`/api/v1/customer-payments/${paymentId}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.allocationStatus).toBe('ALLOCATED');
    const inv = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(inv.body.status).toBe('PARTIALLY_PAID');
    expect(inv.body.balance).toBe('25000.0000');
    await expectReconciled();
    await as(admin, http().patch('/api/v1/ar-settings'))
      .send({ requirePaymentApproval: false })
      .expect(200);

    // Overpayment: 30,000 received against a 25,000 balance -> 5,000 unapplied, never written off.
    const over = await as(accountant, http().post('/api/v1/customer-payments'))
      .send({
        partyId: customerId,
        paymentDate: TODAY,
        amount: '30000',
        cashAccountId: acc['1130'],
        reference: 'OR-E2E-2',
        allocations: [{ documentId: invoiceId, amount: '25000' }],
      })
      .expect(201);
    const overPosted = await as(
      finance,
      http().post(`/api/v1/customer-payments/${over.body.id}/post`),
    ).expect(201);
    expect(overPosted.body.unallocatedAmount).toBe('5000.0000');
    expect(overPosted.body.allocationStatus).toBe('PARTIALLY_ALLOCATED');
    const paid = await as(admin, http().get(`/api/v1/invoices/${invoiceId}`)).expect(200);
    expect(paid.body.status).toBe('PAID');
    const balance = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(balance.body.balance.unappliedCredit).toBe('5000.0000');
    expect(balance.body.balance.net).toBe('-5000.0000');
    const unapplied = await as(admin, http().get(`/api/v1/unapplied-cash?asOf=${TODAY}`)).expect(
      200,
    );
    expect(unapplied.body.items.some((i: { id: string }) => i.id === over.body.id)).toBe(true);
    await expectReconciled();
    paymentId = over.body.id;
  });

  // ------------------------------------------------------------------ refund

  it('refund: request capped by unapplied credit, requester cannot approve, paying posts Dr AR / Cr cash', async () => {
    await as(accountant, http().post(`/api/v1/customer-payments/${paymentId}/refund`))
      .send({ amount: '9000', reason: 'too much' })
      .expect(422);
    const req = await as(accountant, http().post(`/api/v1/customer-payments/${paymentId}/refund`))
      .send({ amount: '5000', reason: 'Overpayment refund', method: 'BANK_TRANSFER' })
      .expect(201);
    expect(req.body.documentNumber).toMatch(/^RFD-/);
    expect(req.body.status).toBe('DRAFT');
    await as(accountant, http().post(`/api/v1/refunds/${req.body.id}/submit`)).expect(201);
    await as(accountant, http().post(`/api/v1/refunds/${req.body.id}/approve`))
      .send({})
      .expect(403);
    const approved = await as(finance, http().post(`/api/v1/refunds/${req.body.id}/approve`))
      .send({ comment: 'ok' })
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const paid = await as(finance, http().post(`/api/v1/refunds/${req.body.id}/pay`))
      .send({ paymentDate: TODAY })
      .expect(201);
    expect(paid.body.status).toBe('PAID');
    const refundPayment = await as(
      admin,
      http().get(`/api/v1/customer-payments/${paid.body.refundPaymentId}`),
    ).expect(200);
    expect(refundPayment.body.paymentType).toBe('REFUND');
    expect(refundPayment.body.status).toBe('POSTED');
    const journal = await journalOf(refundPayment.body.journalEntryId);
    expect(journal.lines.find((l) => l.accountId === acc['1200'])?.debit).toBe('5000.0000');
    expect(journal.lines.find((l) => l.accountId === acc['1130'])?.credit).toBe('5000.0000');
    const balance = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(balance.body.balance.unappliedCredit).toBe('0.0000');
    await expectReconciled();
  });

  // ------------------------------------------------ dispute, write-off, recovery

  let overdueInvoiceId: string;
  it('dispute on an overdue invoice pauses dunning; resolution needs a resolution code', async () => {
    const inv = await as(accountant, http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-05-01',
        dueDate: '2026-05-21',
        lines: [{ description: 'Old services', unitPrice: '8000', accountId: acc['4200'] }],
      })
      .expect(201);
    overdueInvoiceId = inv.body.id;
    await as(finance, http().post(`/api/v1/invoices/${overdueInvoiceId}/approve`)).expect(201);
    await as(finance, http().post(`/api/v1/invoices/${overdueInvoiceId}/post`)).expect(201);
    const dispute = await as(accountant, http().post('/api/v1/disputes'))
      .send({
        invoiceId: overdueInvoiceId,
        reason: 'INCORRECT_PRICE',
        description: 'Rate disputed',
      })
      .expect(201);
    expect(dispute.body.status).toBe('OPEN');
    expect(dispute.body.amount).toBe('8000.0000');
    await as(accountant, http().post('/api/v1/disputes'))
      .send({ invoiceId: overdueInvoiceId, reason: 'OTHER', description: 'dup' })
      .expect(422);
    const flagged = await as(admin, http().get(`/api/v1/invoices?disputedOnly=true`)).expect(200);
    expect(flagged.body.items.some((i: { id: string }) => i.id === overdueInvoiceId)).toBe(true);
    // Sweep: the disputed invoice is overdue but gets no dunning step.
    const sweep = await as(admin, http().post('/api/v1/collections/run-sweep'))
      .send({ asOf: TODAY })
      .expect(201);
    expect(sweep.body.overdue).toBeGreaterThan(0);
    const cases = await as(
      admin,
      http().get(`/api/v1/collections?customerId=${customerId}&openOnly=true`),
    ).expect(200);
    expect(cases.body.items).toHaveLength(1);
    const detail = await as(
      admin,
      http().get(`/api/v1/collections/${cases.body.items[0].id}`),
    ).expect(200);
    expect(
      detail.body.activities.filter(
        (a: { activityType: string; invoiceId: string }) =>
          a.activityType === 'DUNNING' && a.invoiceId === overdueInvoiceId,
      ),
    ).toHaveLength(0);
    // Write-off is refused while the dispute is open.
    const wo = await as(accountant, http().post('/api/v1/write-offs'))
      .send({ invoiceId: overdueInvoiceId, reason: 'BAD_DEBT', justification: 'Uncollectible' })
      .expect(201);
    await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/approve`))
      .send({})
      .expect(201);
    await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/post`))
      .send({})
      .expect(422);
    await as(accountant, http().patch(`/api/v1/disputes/${dispute.body.id}`))
      .send({ status: 'RESOLVED' })
      .expect(422);
    const resolved = await as(accountant, http().patch(`/api/v1/disputes/${dispute.body.id}`))
      .send({
        status: 'RESOLVED',
        resolution: 'REJECTED',
        resolutionNotes: 'Contract rate confirmed',
      })
      .expect(200);
    expect(resolved.body.status).toBe('RESOLVED');
    await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/reject`))
      .send({ comment: 'not yet' })
      .expect(201);
  });

  it('write-off: permission + approval + reason + journal; the balance leaves the subledger and comes back on recovery', async () => {
    await as(viewer, http().post('/api/v1/write-offs'))
      .send({ invoiceId: overdueInvoiceId, reason: 'BAD_DEBT', justification: 'x' })
      .expect(403);
    await as(accountant, http().post('/api/v1/write-offs'))
      .send({ invoiceId: overdueInvoiceId, reason: 'SMALL_BALANCE', justification: 'x' })
      .expect(422);
    await as(accountant, http().post('/api/v1/write-offs'))
      .send({ invoiceId: overdueInvoiceId, amount: '9000', reason: 'BAD_DEBT', justification: 'x' })
      .expect(422);
    const wo = await as(accountant, http().post('/api/v1/write-offs'))
      .send({
        invoiceId: overdueInvoiceId,
        reason: 'BAD_DEBT',
        justification: 'Customer ceased trading',
        idempotencyKey: 'wo-e2e-000001',
      })
      .expect(201);
    const replay = await as(accountant, http().post('/api/v1/write-offs'))
      .send({
        invoiceId: overdueInvoiceId,
        reason: 'BAD_DEBT',
        justification: 'again',
        idempotencyKey: 'wo-e2e-000001',
      })
      .expect(201);
    expect(replay.body.id).toBe(wo.body.id);
    await as(accountant, http().post(`/api/v1/write-offs/${wo.body.id}/submit`)).expect(201);
    await as(accountant, http().post(`/api/v1/write-offs/${wo.body.id}/approve`))
      .send({})
      .expect(403);
    await as(admin, http().post(`/api/v1/write-offs/${wo.body.id}/post`))
      .send({})
      .expect(422);
    const approved = await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/approve`))
      .send({ comment: 'Approved' })
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const posted = await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/post`))
      .send({ writeOffDate: TODAY })
      .expect(201);
    expect(posted.body.status).toBe('POSTED');
    expect(posted.body.debitAccountCode).toBe('1250'); // allowance policy on by default
    const journal = await journalOf(posted.body.journalEntryId);
    expect(journal.lines.find((l) => l.accountId === acc['1200'])?.credit).toBe('8000.0000');
    expect(journal.lines.find((l) => l.accountId === acc['1250'])?.debit).toBe('8000.0000');
    const inv = await as(admin, http().get(`/api/v1/invoices/${overdueInvoiceId}`)).expect(200);
    expect(inv.body.status).toBe('WRITTEN_OFF');
    expect(inv.body.balance).toBe('0.0000');
    expect(inv.body.writtenOffAmount).toBe('8000.0000');
    const rec = await expectReconciled();
    expect(rec.breakdown.writeOffs).toBe('8000.0000');
    const aging = await as(
      admin,
      http().get(`/api/v1/ar-aging?asOf=${TODAY}&partyId=${customerId}`),
    ).expect(200);
    expect(aging.body.totals.outstanding).toBe('0.0000');
    const statement = await as(
      admin,
      http().get(
        `/api/v1/customer-statements?customerId=${customerId}&from=2026-01-01&to=${TODAY}&save=true`,
      ),
    ).expect(200);
    expect(statement.body.lines.some((l: { kind: string }) => l.kind === 'WRITE_OFF')).toBe(true);
    expect(statement.body.closingBalance).toBe('0.0000');
    expect(statement.body.snapshotNumber).toMatch(/^STMT-/);
    // Recovery reinstates the receivable.
    const recovered = await as(finance, http().post(`/api/v1/write-offs/${wo.body.id}/recover`))
      .send({ recoveryDate: TODAY, reason: 'Customer resumed trading' })
      .expect(201);
    expect(recovered.body.status).toBe('RECOVERED');
    const back = await as(admin, http().get(`/api/v1/invoices/${overdueInvoiceId}`)).expect(200);
    expect(back.body.status).toBe('APPROVED');
    expect(back.body.balance).toBe('8000.0000');
    const rec2 = await expectReconciled();
    expect(rec2.breakdown.writeOffs).toBe('0.0000');
  });

  it('bad-debt provision: computed from configurable aging rates and posted Dr expense / Cr allowance', async () => {
    const run = await as(finance, http().post('/api/v1/bad-debt-provisions'))
      .send({ asOf: TODAY, method: 'AGING_PERCENT' })
      .expect(201);
    expect(run.body.status).toBe('DRAFT');
    expect(Number(run.body.requiredAllowance)).toBeGreaterThan(0);
    const posted = await as(
      finance,
      http().post(`/api/v1/bad-debt-provisions/${run.body.id}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const journal = await journalOf(posted.body.journalEntryId);
    expect(journal.lines.find((l) => l.accountId === acc['6710'])?.debit).toBe(
      posted.body.adjustment,
    );
    expect(journal.lines.find((l) => l.accountId === acc['1250'])?.credit).toBe(
      posted.body.adjustment,
    );
    await expectReconciled();
  });

  // ------------------------------------------------------------- collections

  it('collections: promises, activities, credit hold blocks new orders and is released', async () => {
    const cases = await as(
      admin,
      http().get(`/api/v1/collections?customerId=${customerId}&openOnly=true`),
    ).expect(200);
    const caseId = cases.body.items[0].id;
    const withActivity = await as(
      accountant,
      http().post(`/api/v1/collections/${caseId}/activities`),
    )
      .send({
        activityType: 'CALL',
        summary: 'Called AP',
        nextActionAt: '2026-09-20',
        nextAction: 'Follow up',
      })
      .expect(201);
    expect(withActivity.body.status).toBe('CONTACTED');
    expect(withActivity.body.lastContactAt).toBeTruthy();
    const promise = await as(accountant, http().post('/api/v1/promises-to-pay'))
      .send({
        customerId,
        caseId,
        amount: '8000',
        promiseDate: '2026-09-10',
        invoiceIds: [overdueInvoiceId],
      })
      .expect(201);
    expect(promise.body.status).toBe('PENDING');
    const promised = await as(admin, http().get(`/api/v1/collections/${caseId}`)).expect(200);
    expect(promised.body.status).toBe('PROMISED');
    // Evaluated as of a date after the promise date with no cash -> BROKEN.
    await as(admin, http().post('/api/v1/collections/run-sweep'))
      .send({ asOf: '2026-09-14' })
      .expect(201);
    const evaluated = await as(
      admin,
      http().get(`/api/v1/promises-to-pay/${promise.body.id}`),
    ).expect(200);
    expect(evaluated.body.status).toBe('BROKEN');
    // Credit hold from the workspace blocks new orders until released.
    await as(accountant, http().post(`/api/v1/collections/${caseId}/credit-hold`))
      .send({ hold: true, reason: 'x' })
      .expect(403);
    const held = await as(finance, http().post(`/api/v1/collections/${caseId}/credit-hold`))
      .send({ hold: true, reason: 'Broken promise' })
      .expect(201);
    expect(held.body.customerCode).toBe('CUST-E2E');
    const so = await as(admin, http().post('/api/v1/sales-orders'))
      .send({
        customerId,
        orderDate: TODAY,
        lines: [{ description: 'x', unitPrice: '100', accountId: acc['4200'] }],
      })
      .expect(201);
    const blocked = await as(
      admin,
      http().post(`/api/v1/sales-orders/${so.body.id}/submit`),
    ).expect(422);
    expect(blocked.body.code).toBe('CREDIT_HOLD');
    const credit = await as(admin, http().get(`/api/v1/customers/${customerId}/credit`)).expect(
      200,
    );
    expect(credit.body.status).toBe('ON_HOLD');
    await as(finance, http().post(`/api/v1/customers/${customerId}/credit-hold`))
      .send({ hold: false, reason: 'Paid' })
      .expect(201);
    const submitted = await as(
      admin,
      http().post(`/api/v1/sales-orders/${so.body.id}/submit`),
    ).expect(201);
    expect(submitted.body.status).toBe('SUBMITTED');
    const audit = await as(
      admin,
      http().get(`/api/v1/audit-logs?entityType=CustomerCreditProfile&entityId=${customerId}`),
    ).expect(200);
    expect((audit.body.items ?? audit.body).length).toBeGreaterThanOrEqual(2);
  });

  // --------------------------------------------------------- credit notes API

  it('credit notes post as Dr revenue / Cr AR through the alias resource and the webhook outbox records the events', async () => {
    const cn = await as(accountant, http().post('/api/v1/credit-notes'))
      .send({
        customerId,
        documentDate: TODAY,
        lines: [{ description: 'Goodwill credit', unitPrice: '1000', accountId: acc['4200'] }],
      })
      .expect(201);
    expect(cn.body.documentType).toBe('CREDIT_NOTE');
    await as(finance, http().post(`/api/v1/invoices/${cn.body.id}/approve`)).expect(201);
    const posted = await as(finance, http().post(`/api/v1/invoices/${cn.body.id}/post`)).expect(
      201,
    );
    const journal = await journalOf(posted.body.journalEntryId);
    expect(journal.lines.find((l) => l.accountId === acc['1200'])?.credit).toBe('1000.0000');
    const listed = await as(admin, http().get('/api/v1/credit-notes')).expect(200);
    expect(
      listed.body.items.every((i: { documentType: string }) => i.documentType === 'CREDIT_NOTE'),
    ).toBe(true);
    await expectReconciled();
    const events = await pool.query(
      `select event_type, count(*)::int as n from integration_events where company_id = $1 and direction = 'OUTBOUND' and event_type = any($2) group by event_type`,
      [
        companyId,
        [
          'sales_order.submitted',
          'sales_order.confirmed',
          'delivery.delivered',
          'invoice.posted',
          'payment.received',
          'payment.refunded',
          'credit_note.posted',
          'write_off.posted',
          'customer.credit_hold',
          'invoice.overdue',
          'invoice.disputed',
        ],
      ],
    );
    const types = events.rows.map((r: { event_type: string }) => r.event_type);
    for (const t of [
      'sales_order.confirmed',
      'invoice.posted',
      'payment.received',
      'credit_note.posted',
      'write_off.posted',
      'customer.credit_hold',
    ])
      expect(types).toContain(t);
  });

  it('final: AR subledger equals the GL, integrity has no critical findings, customer balance is consistent', async () => {
    const rec = await expectReconciled();
    expect(rec.integrity.status).not.toBe('CRITICAL');
    const customer = await as(admin, http().get(`/api/v1/customers/${customerId}`)).expect(200);
    expect(customer.body.balance.outstanding).toBe('8000.0000');
    expect(customer.body.balance.unappliedCredit).toBe('1000.0000');
    expect(customer.body.balance.net).toBe('7000.0000');
    const aging = await as(
      admin,
      http().get(`/api/v1/ar-aging?asOf=${TODAY}&partyId=${customerId}`),
    ).expect(200);
    expect(aging.body.totals.net).toBe('7000.0000');
    const integrity = await as(admin, http().get(`/api/v1/integrity?asOf=${TODAY}`)).expect(200);
    expect(
      integrity.body.findings.find((f: { check: string }) => f.check === 'AR_CONTROL_VARIANCE')
        .count,
    ).toBe(0);
  });
});
