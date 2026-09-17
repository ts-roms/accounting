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
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'P@ssw0rd123' };
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #7 - Accounts payable and procure-to-pay. Walks vendor onboarding
 * and holds, purchase order submit / approve, bills with early-payment terms,
 * payment holds, vendor payments with discount capture, a payment run from
 * proposal to execution and remittance, GRNI and period-end accruals - and
 * proves after every ledger-affecting step that the AP subledger equals the
 * GL control account and that controls (holds, SoD, approval, permissions,
 * company isolation) cannot be bypassed.
 */
describe('Payables platform (e2e)', () => {
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
    const res = await as(
      admin,
      http().get(`/api/v1/reports/ap-reconciliation?asOf=${asOf}`),
    ).expect(200);
    expect(res.body.reconciled).toBe(true);
    expect(res.body.subledgerBalance).toBe(res.body.ledgerBalance);
    const integrity = await as(admin, http().get(`/api/v1/ap-integrity?asOf=${asOf}`)).expect(200);
    for (const check of [
      'AP_GL_MISMATCH',
      'AP_ALLOCATION_DRIFT',
      'DISCOUNT_DRIFT',
      'HELD_BILL_SETTLED',
      'BILL_HOLD_FLAG_DRIFT',
    ])
      expect(integrity.body.findings.find((f: { check: string }) => f.check === check).count).toBe(
        0,
      );
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

  it('seed: AP reconciles including discounts, the dashboard, aging, GRNI and integrity run on real data', async () => {
    const rec = await expectReconciled();
    expect(rec.breakdown.discounts).toBe('3360.0000');
    const dash = await as(admin, http().get(`/api/v1/ap-dashboard?asOf=${TODAY}`)).expect(200);
    expect(dash.body.totals.totalPayables).toBe('1574800.0000');
    expect(dash.body.totals.onHoldCount).toBe(1);
    expect(dash.body.totals.vendorsOnHold).toBe(1);
    expect(dash.body.totals.vendorsPendingApproval).toBe(1);
    expect(dash.body.totals.pendingPaymentRuns).toBe(1);
    expect(dash.body.totals.grni).toBe('63000.0000');
    expect(dash.body.aging).toHaveLength(6);
    expect(dash.body.cashRequirements[0].label).toBe('Overdue');
    expect(dash.body.dpoTrend).toHaveLength(6);
    const aging = await as(admin, http().get(`/api/v1/reports/ap-aging?asOf=${TODAY}`)).expect(200);
    expect(aging.body.buckets.map((b: { key: string }) => b.key)).toEqual([
      'current',
      'days1to30',
      'days31to60',
      'days61to90',
      'days91to120',
      'over120',
    ]);
    expect(aging.body.totals.net).toBe(rec.subledgerBalance);
    const grni = await as(admin, http().get(`/api/v1/grni?asOf=${TODAY}`)).expect(200);
    expect(grni.body.totals.total).toBe('63000.0000');
    const integrity = await as(admin, http().get(`/api/v1/ap-integrity?asOf=${TODAY}`)).expect(200);
    expect(integrity.body.status).toBe('OK');
    expect(integrity.body.findings).toHaveLength(19);
  });

  let discountTermId: string;
  let groupId: string;
  it('configures a discount payment term, a vendor group and AP settings (policy is data)', async () => {
    const term = await as(admin, http().post('/api/v1/payment-terms'))
      .send({
        code: '1-7N20',
        name: '1% 7 days, net 20',
        basis: 'NET_DAYS',
        days: 20,
        discountPercent: '1',
        discountDays: 7,
      })
      .expect(201);
    discountTermId = term.body.id;
    const group = await as(admin, http().post('/api/v1/vendor-groups'))
      .send({
        code: 'E2E',
        name: 'E2E suppliers',
        defaultPaymentTermId: discountTermId,
        defaultExpenseAccountId: acc['6400'],
      })
      .expect(201);
    groupId = group.body.id;
    await as(viewer, http().post('/api/v1/vendor-groups'))
      .send({ code: 'X', name: 'x' })
      .expect(403);
    const settings = await as(admin, http().patch('/api/v1/ap-settings'))
      .send({
        requireRunApproval: true,
        requirePaymentApproval: false,
        dueSoonDays: 10,
        requireVendorApproval: true,
      })
      .expect(200);
    expect(settings.body.requireVendorApproval).toBe(true);
    await as(admin, http().patch('/api/v1/ap-settings'))
      .send({
        agingBuckets: [
          { key: 'a', label: 'A', from: -99999, to: 0 },
          { key: 'b', label: 'B', from: 5, to: null },
        ],
      })
      .expect(400);
  });

  // ------------------------------------------------------------ vendor master

  let vendorId: string;
  it('vendor onboarding: created PENDING under the policy, blocked until approved, approval is delegable and audited', async () => {
    const created = await as(accountant, http().post('/api/v1/vendors'))
      .send({
        code: 'VEND-E2E',
        name: 'E2E Widgets Supply',
        vendorType: 'SUPPLIER',
        vendorGroupId: groupId,
        email: 'ap@e2ewidgets.test',
        taxIdentificationNumber: '999-111-222-000',
      })
      .expect(201);
    vendorId = created.body.id;
    expect(created.body.vendorStatus).toBe('PENDING');
    expect(created.body.paymentTermId).toBe(discountTermId);
    expect(created.body.vendorGroupName).toBe('E2E suppliers');
    // No PO / bill for a pending vendor while approval is required.
    const blocked = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: TODAY,
        lines: [{ description: 'x', unitPrice: '100', accountId: acc['6400'] }],
      })
      .expect(422);
    expect(blocked.body.code).toBe('VENDOR_NOT_APPROVED');
    await as(accountant, http().post(`/api/v1/vendors/${vendorId}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(403);
    const approved = await as(finance, http().post(`/api/v1/vendors/${vendorId}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(201);
    expect(approved.body.vendorStatus).toBe('APPROVED');
    expect(approved.body.profile.approvedAt).toBeTruthy();
    // Master data: contacts, addresses, masked bank accounts.
    await as(accountant, http().post(`/api/v1/vendors/${vendorId}/contacts`))
      .send({
        name: 'Pat Reyes',
        email: 'pat@e2ewidgets.test',
        isPrimary: true,
        receivesRemittance: true,
      })
      .expect(201);
    await as(accountant, http().post(`/api/v1/vendors/${vendorId}/addresses`))
      .send({ addressType: 'REMIT_TO', city: 'Cebu City', country: 'PH', isDefault: true })
      .expect(201);
    const bankRes = await as(accountant, http().post(`/api/v1/vendors/${vendorId}/bank-accounts`))
      .send({
        bankName: 'BPI',
        accountName: 'E2E Widgets Supply',
        accountNumber: '009988776655',
        routingCode: 'BOPIPHMM',
        isPrimary: true,
      })
      .expect(201);
    expect(bankRes.body.accountNumber).toBeUndefined();
    expect(bankRes.body.accountNumberMasked).toBe('********6655');
    const view = await as(admin, http().get(`/api/v1/vendors/${vendorId}`)).expect(200);
    expect(view.body.contacts).toHaveLength(1);
    expect(view.body.bankAccounts[0].accountNumberMasked).toBe('********6655');
    await as(admin, http().get(`/api/v1/vendors/${vendorId}`), otherCompanyId).expect(404);
  });

  // --------------------------------------------------------- procure-to-pay

  let poId: string;
  it('purchase order: submit opens the workflow, a vendor hold blocks it, approve is SoD-checked', async () => {
    const po = await as(admin, http().post('/api/v1/purchase-orders'))
      .send({
        vendorId,
        orderDate: TODAY,
        lines: [
          {
            description: 'Widget stock',
            quantity: '10',
            unitPrice: '1000',
            accountId: acc['6400'],
          },
        ],
      })
      .expect(201);
    poId = po.body.id;
    // Hold the vendor: no submit / approve possible.
    await as(finance, http().post(`/api/v1/vendors/${vendorId}/hold`))
      .send({ hold: true, reason: 'COMPLIANCE', note: 'Missing BIR 2303' })
      .expect(201);
    const held = await as(admin, http().post(`/api/v1/purchase-orders/${poId}/submit`)).expect(422);
    expect(held.body.code).toBe('VENDOR_ON_HOLD');
    const events = await pool.query(
      `select event_type from integration_events where event_type in ('vendor.on_hold') order by created_at desc limit 1`,
    );
    expect(events.rows[0]?.event_type).toBe('vendor.on_hold');
    await as(finance, http().post(`/api/v1/vendors/${vendorId}/hold`))
      .send({ hold: false })
      .expect(201);
    const submitted = await as(admin, http().post(`/api/v1/purchase-orders/${poId}/submit`)).expect(
      201,
    );
    expect(submitted.body.status).toBe('SUBMITTED');
    const approvedPo = await as(
      finance,
      http().post(`/api/v1/purchase-orders/${poId}/approve`),
    ).expect(201);
    expect(approvedPo.body.status).toBe('APPROVED');
    const po2 = await as(admin, http().get(`/api/v1/purchase-orders/${poId}`)).expect(200);
    expect(po2.body.status).toBe('APPROVED');
  });

  let billId: string;
  let billTotal: string;
  it('bill: named term drives due date and discount window, submit -> approve -> post through the gateway', async () => {
    const bill = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: TODAY,
        vendorInvoiceNumber: 'E2E-INV-1',
        lines: [
          {
            description: 'Widget stock',
            quantity: '10',
            unitPrice: '1000',
            accountId: acc['6400'],
          },
        ],
      })
      .expect(201);
    billId = bill.body.id;
    billTotal = bill.body.total;
    expect(bill.body.dueDate).toBe('2026-10-04'); // net 20
    expect(bill.body.discountDate).toBe('2026-09-21'); // 7 days
    expect(bill.body.discountAmount).toBe('100.0000'); // 1% of 10,000
    expect(bill.body.paymentTermId).toBe(discountTermId);
    expect(bill.body.purchaseOrderNumber).toBeNull();
    // Duplicate supplier invoice number is blocked by policy.
    const dup = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: TODAY,
        vendorInvoiceNumber: 'E2E-INV-1',
        lines: [{ description: 'x', unitPrice: '10000', accountId: acc['6400'] }],
      })
      .expect(422);
    expect(dup.body.code).toBe('DUPLICATE_VENDOR_INVOICE');
    const submitted = await as(accountant, http().post(`/api/v1/bills/${billId}/submit`)).expect(
      201,
    );
    expect(submitted.body.status).toBe('SUBMITTED');
    // SoD: the creator cannot approve even with the seeded delegated bill.approve (DLG-000001); posting needs bill.post.
    const self = await as(accountant, http().post(`/api/v1/bills/${billId}/approve`)).expect(422);
    expect(self.body.code).toBe('SOD_VIOLATION');
    await as(finance, http().post(`/api/v1/bills/${billId}/approve`)).expect(201);
    await as(accountant, http().post(`/api/v1/bills/${billId}/post`)).expect(403);
    const posted = await as(finance, http().post(`/api/v1/bills/${billId}/post`)).expect(201);
    expect(posted.body.accountingStatus).toBe('POSTED');
    const je = await journalOf(posted.body.journalEntryId);
    expect(je.lines.find((l) => l.accountId === acc['2110'])!.credit).toBe(billTotal);
    await expectReconciled();
    const audit = await as(admin, http().get(`/api/v1/audit-logs?entityId=${billId}`)).expect(200);
    expect((audit.body.items ?? audit.body).map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'SUBMIT', 'APPROVE', 'POST']),
    );
  });

  let holdId: string;
  it('payment hold: a held bill cannot be settled, release is audited and the flag mirrors the hold', async () => {
    const hold = await as(accountant, http().post(`/api/v1/bills/${billId}/hold`))
      .send({ reason: 'PRICE_DISCREPANCY', note: 'PO price was 950' })
      .expect(201);
    holdId = hold.body.id;
    expect(hold.body.status).toBe('ACTIVE');
    const listed = await as(admin, http().get('/api/v1/bills?onHold=true')).expect(200);
    expect(listed.body.items.some((b: { id: string }) => b.id === billId)).toBe(true);
    const pay = await as(accountant, http().post('/api/v1/vendor-payments'))
      .send({
        partyId: vendorId,
        paymentDate: TODAY,
        amount: '1000',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: billId, amount: '1000' }],
      })
      .expect(422);
    expect(pay.body.code).toBe('MATCH_EXCEPTION_UNREVIEWED');
    await as(viewer, http().post(`/api/v1/bill-holds/${holdId}/release`))
      .send({})
      .expect(403);
    const released = await as(finance, http().post(`/api/v1/bill-holds/${holdId}/release`))
      .send({ note: 'Credit agreed' })
      .expect(201);
    expect(released.body.status).toBe('RELEASED');
    const bill = await as(admin, http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill.body.onHold).toBe(false);
    await expectReconciled();
  });

  it('vendor payment with early-payment discount: Dr AP gross / Cr cash net / Cr purchase discount, bill fully settled', async () => {
    // 1% discount on the 10,000 bill inside the window.
    const bad = await as(accountant, http().post('/api/v1/vendor-payments'))
      .send({
        partyId: vendorId,
        paymentDate: TODAY,
        amount: '9900',
        cashAccountId: acc['1130'],
        allocations: [{ documentId: billId, amount: '9900', discount: '150' }],
      })
      .expect(422);
    expect(bad.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    const pay = await as(accountant, http().post('/api/v1/vendor-payments'))
      .send({
        partyId: vendorId,
        paymentDate: TODAY,
        amount: '9900',
        cashAccountId: acc['1130'],
        reference: 'E2E-PAY-1',
        allocations: [{ documentId: billId, amount: '9900', discount: '100' }],
      })
      .expect(201);
    expect(pay.body.discountAmount).toBe('100.0000');
    // Approval step is explicit and SoD-checked; posting needs vendor-payment.post.
    await as(accountant, http().post(`/api/v1/vendor-payments/${pay.body.id}/approve`)).expect(403);
    await as(finance, http().post(`/api/v1/vendor-payments/${pay.body.id}/approve`)).expect(201);
    const posted = await as(
      finance,
      http().post(`/api/v1/vendor-payments/${pay.body.id}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const je = await journalOf(posted.body.journalEntryId);
    expect(je.lines.find((l) => l.accountId === acc['2110'])!.debit).toBe('10000.0000');
    expect(je.lines.find((l) => l.accountId === acc['1130'])!.credit).toBe('9900.0000');
    expect(je.lines.find((l) => l.accountId === acc['5400'])!.credit).toBe('100.0000');
    const bill = await as(admin, http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill.body.status).toBe('PAID');
    expect(bill.body.discountTakenAmount).toBe('100.0000');
    expect(bill.body.allocatedAmount).toBe('10000.0000');
    await expectReconciled();
    // Void reverses the discount too.
    const voided = await as(finance, http().post(`/api/v1/vendor-payments/${pay.body.id}/void`))
      .send({ reason: 'Wrong bank account' })
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    const reopened = await as(admin, http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(reopened.body.status).toBe('APPROVED');
    expect(reopened.body.discountTakenAmount).toBe('0.0000');
    expect(reopened.body.balance).toBe('10000.0000');
    await expectReconciled();
  });

  // ------------------------------------------------------------ payment runs

  let runId: string;
  it('payment run: proposal skips held bills and takes discounts, approval is SoD-checked, execution posts one payment per vendor', async () => {
    // Second bill for the same vendor, due later (still proposed under DUE_OR_DISCOUNT because of its discount).
    const bill2 = await as(accountant, http().post('/api/v1/bills'))
      .send({
        vendorId,
        documentDate: TODAY,
        vendorInvoiceNumber: 'E2E-INV-2',
        lines: [{ description: 'Spare parts', unitPrice: '5000', accountId: acc['6400'] }],
      })
      .expect(201);
    await as(finance, http().post(`/api/v1/bills/${bill2.body.id}/approve`)).expect(201);
    await as(finance, http().post(`/api/v1/bills/${bill2.body.id}/post`)).expect(201);
    const seededHeld = await as(admin, http().get('/api/v1/bills?onHold=true')).expect(200);
    const heldBillId = seededHeld.body.items[0].id;

    const run = await as(accountant, http().post('/api/v1/payment-runs'))
      .send({
        cashAccountId: acc['1130'],
        paymentDate: TODAY,
        selectionMode: 'DUE_OR_DISCOUNT',
        vendorIds: [vendorId, seededHeld.body.items[0].vendorId],
      })
      .expect(201);
    runId = run.body.id;
    expect(run.body.status).toBe('DRAFT');
    const lines = run.body.lines as Array<{
      billId: string;
      status: string;
      skipReason: string | null;
      amount: string;
      discountTaken: string;
    }>;
    const l1 = lines.find((l) => l.billId === billId)!;
    const l2 = lines.find((l) => l.billId === bill2.body.id)!;
    const lh = lines.find((l) => l.billId === heldBillId)!;
    expect(l1.status).toBe('SELECTED');
    expect(l1.discountTaken).toBe('100.0000');
    expect(l1.amount).toBe('9900.0000');
    expect(l2.status).toBe('SELECTED');
    expect(l2.discountTaken).toBe('50.0000');
    expect(['ON_HOLD', 'VENDOR_ON_HOLD']).toContain(lh.skipReason);
    expect(run.body.totalAmount).toBe('14850.0000');
    expect(run.body.totalDiscount).toBe('150.0000');
    // A held bill cannot be forced in; a partial amount without the discount is fine.
    await as(accountant, http().patch(`/api/v1/payment-runs/${runId}/lines`))
      .send({ lines: [{ billId: heldBillId }] })
      .expect(422);
    const edited = await as(accountant, http().patch(`/api/v1/payment-runs/${runId}/lines`))
      .send({ lines: [{ billId: bill2.body.id, amount: '2000', takeDiscount: false }] })
      .expect(200);
    expect(edited.body.totalAmount).toBe('11900.0000');
    expect(edited.body.totalDiscount).toBe('100.0000');
    // Execution needs approval (policy), the proposer cannot approve, the viewer cannot execute.
    const early = await as(finance, http().post(`/api/v1/payment-runs/${runId}/execute`)).expect(
      422,
    );
    expect(early.body.code).toBe('DOCUMENT_INVALID_STATE');
    await as(accountant, http().post(`/api/v1/payment-runs/${runId}/submit`)).expect(201);
    await as(accountant, http().post(`/api/v1/payment-runs/${runId}/approve`))
      .send({})
      .expect(403);
    const approved = await as(finance, http().post(`/api/v1/payment-runs/${runId}/approve`))
      .send({ note: 'ok' })
      .expect(201);
    expect(approved.body.status).toBe('APPROVED');
    await as(viewer, http().post(`/api/v1/payment-runs/${runId}/execute`)).expect(403);
    const executed = await as(admin, http().post(`/api/v1/payment-runs/${runId}/execute`)).expect(
      201,
    );
    expect(executed.body.status).toBe('COMPLETED');
    const paidLines = executed.body.lines.filter((l: { status: string }) => l.status === 'PAID');
    expect(paidLines).toHaveLength(2);
    expect(new Set(paidLines.map((l: { paymentId: string }) => l.paymentId)).size).toBe(1); // one payment per vendor
    const payment = await as(
      admin,
      http().get(`/api/v1/vendor-payments/${paidLines[0].paymentId}`),
    ).expect(200);
    expect(payment.body.status).toBe('POSTED');
    expect(payment.body.amount).toBe('11900.0000');
    expect(payment.body.discountAmount).toBe('100.0000');
    expect(payment.body.paymentRunId).toBe(runId);
    const bill1 = await as(admin, http().get(`/api/v1/bills/${billId}`)).expect(200);
    expect(bill1.body.status).toBe('PAID');
    const bill2After = await as(admin, http().get(`/api/v1/bills/${bill2.body.id}`)).expect(200);
    expect(bill2After.body.status).toBe('PARTIALLY_PAID');
    expect(bill2After.body.balance).toBe('3000.0000');
    await expectReconciled();
    // Idempotent: executing again is rejected, the run stays completed.
    await as(admin, http().post(`/api/v1/payment-runs/${runId}/execute`)).expect(422);
    // Remittance file carries the vendor's bank details in full and both bills.
    const csv = await as(
      finance,
      http().get(`/api/v1/payment-runs/${runId}/remittance?format=CSV`),
    ).expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('009988776655');
    expect(csv.text).toContain('E2E-INV-1;E2E-INV-2');
    await as(viewer, http().get(`/api/v1/payment-runs/${runId}/remittance`)).expect(403);
    const events = await pool.query(
      `select event_type from integration_events where event_type like 'payment_run.%' order by created_at`,
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining([
        'payment_run.submitted',
        'payment_run.approved',
        'payment_run.executed',
      ]),
    );
  });

  // ----------------------------------------------------------------- accruals

  it('GRNI and accruals: received-not-billed lines accrue Dr expense / Cr accrued expense with an auto-reversal', async () => {
    const grni = await as(admin, http().get(`/api/v1/grni?asOf=2026-09-30`)).expect(200);
    expect(Number(grni.body.totals.unstocked)).toBeGreaterThan(0);
    const accrual = await as(finance, http().post('/api/v1/ap-accruals'))
      .send({
        accrualDate: '2026-09-30',
        reversalDate: '2026-10-01',
        source: 'RECEIVED_NOT_BILLED',
      })
      .expect(201);
    expect(accrual.body.status).toBe('DRAFT');
    expect(accrual.body.totalAmount).toBe(grni.body.totals.unstocked);
    expect(accrual.body.lines.length).toBe(
      grni.body.rows.filter((r: { stocked: boolean }) => !r.stocked).length,
    );
    await as(accountant, http().post(`/api/v1/ap-accruals/${accrual.body.id}/post`)).expect(403);
    const posted = await as(
      finance,
      http().post(`/api/v1/ap-accruals/${accrual.body.id}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const je = await journalOf(posted.body.journalEntryId);
    expect(je.status).toBe('REVERSED');
    expect(je.lines.find((l) => l.accountId === acc['2120'])!.credit).toBe(
      accrual.body.totalAmount,
    );
    const reversal = await journalOf(posted.body.reversalJournalEntryId);
    expect(reversal.lines.find((l) => l.accountId === acc['2120'])!.debit).toBe(
      accrual.body.totalAmount,
    );
    // Accruals never touch the AP control: still reconciled.
    await expectReconciled('2026-10-01');
    const manual = await as(finance, http().post('/api/v1/ap-accruals'))
      .send({
        accrualDate: '2026-09-30',
        reversalDate: '2026-09-30',
        source: 'MANUAL',
        lines: [{ description: 'x', accountId: acc['6400'], amount: '1' }],
      })
      .expect(422);
    expect(manual.body.code).toBe('ACCRUAL_INVALID');
  });

  // ---------------------------------------------------------- sweep / reports

  it('daily sweep, cash requirements, vendor statement and dashboard reflect the new activity', async () => {
    const sweep = await as(admin, http().post(`/api/v1/payables/sweep?asOf=${TODAY}`)).expect(201);
    expect(sweep.body.overdue).toBeGreaterThan(0);
    expect(sweep.body.agedGrniLines).toBeGreaterThanOrEqual(0);
    const cash = await as(
      admin,
      http().get(`/api/v1/cash-requirements?asOf=${TODAY}&vendorId=${vendorId}`),
    ).expect(200);
    expect(cash.body.bills.map((b: { billId: string }) => b.billId)).not.toContain(billId); // paid
    expect(
      cash.body.buckets.reduce((s: number, b: { amount: string }) => s + Number(b.amount), 0),
    ).toBe(3000);
    const stmt = await as(
      admin,
      http().get(`/api/v1/vendor-statements?vendorId=${vendorId}&from=2026-09-01&to=2026-09-30`),
    ).expect(200);
    expect(stmt.body.closingBalance).toBe('3000.0000');
    const dash = await as(admin, http().get(`/api/v1/ap-dashboard?asOf=${TODAY}`)).expect(200);
    expect(Number(dash.body.totals.discountCaptureRate)).toBeGreaterThan(0);
    expect(dash.body.topVendors.length).toBeGreaterThan(0);
    const integrity = await as(admin, http().get(`/api/v1/ap-integrity?asOf=${TODAY}`)).expect(200);
    expect(
      integrity.body.findings.find((f: { check: string }) => f.check === 'PAYMENT_RUN_LINE_UNPAID')
        .count,
    ).toBe(0);
    await as(viewer, http().get('/api/v1/ap-integrity')).expect(403);
  });

  it('integrations: the purchase-orders importer entity is registered and events reached the outbox', async () => {
    const events = await pool.query(
      `select event_type, count(*)::int as n from integration_events where event_type in ('bill.submitted','bill.approved','bill.posted','bill.on_hold','bill.released','vendor_payment.posted','vendor_payment.voided','vendor.approved','vendor.released','purchase_order.submitted','purchase_order.approved','ap_accrual.posted') group by event_type`,
    );
    const seen = new Set(events.rows.map((r) => r.event_type));
    for (const e of [
      'bill.submitted',
      'bill.approved',
      'bill.posted',
      'bill.on_hold',
      'bill.released',
      'vendor_payment.posted',
      'vendor_payment.voided',
      'vendor.approved',
      'vendor.released',
      'purchase_order.submitted',
      'purchase_order.approved',
      'ap_accrual.posted',
    ])
      expect(seen.has(e)).toBe(true);
  });
});
