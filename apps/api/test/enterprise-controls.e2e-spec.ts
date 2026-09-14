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
 * Hardening phase 5 - enterprise controls: field-level change history,
 * segregation of duties on documents and standing conflicts, approval
 * deadlines / escalation / branch scope, the suspense monitor and its close
 * blocker, and the financial control dashboard.
 */
describe('Enterprise controls (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let accountant: Cookies;
  let companyId: string;
  let customerId: string;
  let vendorId: string;
  const acc: Record<string, string> = {};
  const periods: Record<string, { id: string; name: string; endDate: string }> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const postJournal = async (
    entryDate: string,
    lines: Array<{ code: string; debit?: string; credit?: string }>,
    description = 'Controls test',
  ) => {
    const body = {
      entryDate,
      description,
      lines: lines.map((l) => ({
        accountId: acc[l.code],
        debit: l.debit ?? '0',
        credit: l.credit ?? '0',
      })),
    };
    const je = await as(http().post('/api/v1/journal-entries'), accountant).send(body).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`), accountant).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/post`), finance).expect(201);
    return je.body.id as string;
  };
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

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
    const customers = await as(http().get('/api/v1/customers?pageSize=5')).expect(200);
    customerId = customers.body.items[0].id;
    const vendors = await as(http().get('/api/v1/vendors?pageSize=5')).expect(200);
    vendorId = vendors.body.items[0].id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------- field history

  it('an invoice edit writes one immutable history row per changed field, with the reason', async () => {
    const inv = await as(http().post('/api/v1/invoices'), accountant)
      .send({
        customerId,
        documentDate: '2026-06-01',
        reference: 'H5-HIST',
        lines: [{ description: 'Service', unitPrice: '100000', accountId: acc['4100'] }],
      })
      .expect(201);
    await as(http().patch(`/api/v1/invoices/${inv.body.id}`), accountant)
      .send({
        reference: 'H5-HIST-2',
        lines: [{ description: 'Service', unitPrice: '110000', accountId: acc['4100'] }],
        changeReason: 'Additional approved service',
      })
      .expect(200);
    const history = await as(
      http().get(`/api/v1/history?entityType=Invoice&entityId=${inv.body.id}`),
      accountant,
    ).expect(200);
    const fields = history.body.map((h: { field: string }) => h.field).sort();
    expect(fields).toEqual(expect.arrayContaining(['reference', 'subtotal', 'total']));
    const total = history.body.find((h: { field: string }) => h.field === 'total');
    expect(total.previousValue).toBe('100000.0000');
    expect(total.newValue).toBe('110000.0000');
    expect(total.reason).toBe('Additional approved service');
    expect(total.changedByEmail).toBe(ACCOUNTANT.email);
    expect(total.auditLogId).toBeGreaterThan(0);
    // Unchanged fields leave no row; the rows themselves cannot be edited or removed.
    expect(fields).not.toContain('customerId');
    await expect(
      pool.query(`update field_changes set new_value = '"1"' where id = $1`, [total.id]),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query(`delete from field_changes where id = $1`, [total.id])).rejects.toThrow(
      /append-only/,
    );
    // Viewers need history.view: a missing entity type simply yields nothing.
    const none = await as(
      http().get(`/api/v1/history?entityType=Nope&entityId=${inv.body.id}`),
    ).expect(200);
    expect(none.body).toEqual([]);
  });

  // --------------------------------------------------------------- SoD

  it('segregation of duties on documents: BLOCK refuses, WARN passes and is audited; standing conflicts are reported', async () => {
    const policies = await as(http().get('/api/v1/sod-policies')).expect(200);
    const policy = policies.body.find(
      (p: { permissionA: string; permissionB: string }) =>
        p.permissionA === 'invoice.create' && p.permissionB === 'invoice.approve',
    );
    expect(policy).toBeDefined();
    const upsert = (enforcement: 'BLOCK' | 'WARN') =>
      as(http().put(`/api/v1/sod-policies/${policy.id}`))
        .send({
          name: policy.name,
          description: policy.description,
          permissionA: policy.permissionA,
          permissionB: policy.permissionB,
          enforcement,
          isActive: true,
        })
        .expect(200);
    await upsert('BLOCK');
    // Admin holds both permissions: creating and approving the same invoice is blocked...
    const inv = await as(http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-02',
        lines: [{ description: 'Service', unitPrice: '5000', accountId: acc['4100'] }],
      })
      .expect(201);
    const blocked = await as(http().post(`/api/v1/invoices/${inv.body.id}/approve`)).expect(422);
    expect(blocked.body.code).toBe('SOD_VIOLATION');
    expect(blocked.body.details.conflicts[0].policyId).toBe(policy.id);
    // ...another approver is fine.
    await as(http().post(`/api/v1/invoices/${inv.body.id}/approve`), finance).expect(201);
    // The standing-conflict report names every user holding both sides.
    const conflicts = await as(http().get('/api/v1/sod-policies/conflicts')).expect(200);
    const mine = conflicts.body.filter(
      (c: { policyId: string; userEmail: string }) =>
        c.policyId === policy.id && c.userEmail === ADMIN.email,
    );
    expect(mine.length).toBeGreaterThan(0);
    expect(mine[0].enforcement).toBe('BLOCK');
    // WARN lets the action through but records the override on the audit trail.
    await upsert('WARN');
    const inv2 = await as(http().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-06-02',
        lines: [{ description: 'Service', unitPrice: '6000', accountId: acc['4100'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${inv2.body.id}/approve`)).expect(201);
    const audit = await http()
      .get(`/api/v1/audit-logs?action=SOD_WARNING&entityId=${inv2.body.id}`)
      .set('Cookie', admin)
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].newValue.policyId).toBe(policy.id);
    expect(audit.body.items[0].newValue.actorId).toBeDefined();
    // Vendor payments: the creator must not release (post) the payment either.
    const payPolicy = policies.body.find(
      (p: { permissionA: string; permissionB: string }) =>
        p.permissionA === 'vendor-payment.create' && p.permissionB === 'vendor-payment.post',
    );
    expect(payPolicy?.enforcement).toBe('WARN');
  });

  // ------------------------------------------------------ approval engine

  it('approvals: branch scope, deadlines and escalation to a fallback approver', async () => {
    // A branch-specific workflow never matches a document of another branch (or none).
    const branches = await http()
      .get(`/api/v1/branches?companyId=${companyId}`)
      .set('Cookie', admin)
      .expect(200);
    const branchId = branches.body[0].id;
    const scoped = await as(http().post('/api/v1/approval-workflows'))
      .send({
        documentType: 'VENDOR_BILL',
        name: 'Branch bills',
        branchId,
        priority: 1,
        steps: [{ name: 'Branch head', requiredPermission: 'sod.manage', minApprovers: 1 }],
      })
      .expect(201);
    expect(scoped.body.branchId).toBe(branchId);
    // Company-wide workflow: only holders of sod.manage (admin) approve; finance may
    // step in once the request is overdue.
    const workflow = await as(http().post('/api/v1/approval-workflows'))
      .send({
        documentType: 'VENDOR_BILL',
        name: 'Bills need the controller',
        minAmount: '1000',
        deadlineHours: 4,
        escalationPermission: 'bill.approve',
        steps: [{ name: 'Controller', requiredPermission: 'sod.manage', minApprovers: 1 }],
      })
      .expect(201);
    expect(workflow.body.deadlineHours).toBe(4);
    const bill = await as(http().post('/api/v1/bills'), accountant)
      .send({
        vendorId,
        documentDate: '2026-06-03',
        vendorInvoiceNumber: 'H5-ESC-1',
        lines: [{ description: 'Consulting', unitPrice: '25000', accountId: acc['6400'] }],
      })
      .expect(201);
    // Approving opens the request and refuses until the chain completes.
    const gated = await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(
      422,
    );
    expect(gated.body.code).toBe('APPROVAL_REQUIRED');
    const requestId = gated.body.details.requestId as string;
    const opened = await as(http().get(`/api/v1/approvals/${requestId}`), finance).expect(200);
    expect(opened.body.workflowId).toBe(workflow.body.id); // the branch-scoped one did not match
    expect(opened.body.dueAt).not.toBeNull();
    expect(opened.body.overdue).toBe(false);
    expect(opened.body.canDecide).toBe(false); // finance lacks sod.manage and it is not overdue
    const early = await as(http().post(`/api/v1/approvals/${requestId}/decide`), finance)
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(early.body.code).toBe('APPROVAL_NOT_ELIGIBLE');
    // The deadline passes (simulated): the request is overdue, escalated once, audited.
    await pool.query(
      `update approval_requests set due_at = now() - interval '1 hour' where id = $1`,
      [requestId],
    );
    const overdue = await as(http().get('/api/v1/approvals?overdue=true'), finance).expect(200);
    expect(overdue.body.items.map((r: { id: string }) => r.id)).toContain(requestId);
    const view = await as(http().get(`/api/v1/approvals/${requestId}`), finance).expect(200);
    expect(view.body.overdue).toBe(true);
    expect(view.body.escalatedAt).not.toBeNull();
    expect(view.body.canDecide).toBe(true);
    const escalations = await http()
      .get(`/api/v1/audit-logs?action=ESCALATE&entityId=${requestId}`)
      .set('Cookie', admin)
      .expect(200);
    expect(escalations.body.items).toHaveLength(1);
    // The fallback approver decides; the bill can now be approved.
    const decided = await as(http().post(`/api/v1/approvals/${requestId}/decide`), finance)
      .send({ decision: 'APPROVE', comment: 'Controller unavailable' })
      .expect(201);
    expect(decided.body.status).toBe('APPROVED');
    expect(decided.body.decisions[0].comment).toBe('Controller unavailable');
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    // Dashboard reflects the pending / overdue counts.
    await as(http().patch(`/api/v1/approval-workflows/${workflow.body.id}`))
      .send({ status: 'INACTIVE' })
      .expect(200);
    await as(http().patch(`/api/v1/approval-workflows/${scoped.body.id}`))
      .send({ status: 'INACTIVE' })
      .expect(200);
  });

  // ------------------------------------------------------------ suspense

  it('suspense monitor: aged balances require investigation, block the close and show on the integrity report until cleared', async () => {
    const clean = await as(http().get('/api/v1/controls/suspense')).expect(200);
    expect(clean.body.accounts.map((a: { code: string }) => a.code)).toEqual(
      expect.arrayContaining(['1590', '1990', '2160']),
    );
    expect(clean.body.accounts.every((a: { status: string }) => a.status === 'CLEAR')).toBe(true);
    expect(clean.body.requiresInvestigation).toBe(0);
    // An unexplained receipt parked in suspense 60 days ago.
    const parkedOn = daysAgo(60);
    const parked = await postJournal(
      parkedOn,
      [
        { code: '1110', debit: '5000' },
        { code: '1990', credit: '5000' },
      ],
      'Unidentified receipt',
    );
    const aged = await as(http().get('/api/v1/controls/suspense')).expect(200);
    const suspense = aged.body.accounts.find((a: { code: string }) => a.code === '1990');
    expect(suspense.balance).toBe('-5000.0000');
    expect(suspense.openSince).toBe(parkedOn);
    expect(suspense.ageDays).toBe(60);
    expect(suspense.openTransactions).toBe(1);
    expect(suspense.status).toBe('REQUIRES_INVESTIGATION');
    expect(suspense.reasons.join(' ')).toMatch(/Open for 60 days/);
    expect(aged.body.requiresInvestigation).toBe(1);
    // Integrity and the close see the same thing.
    const integrity = await as(http().get('/api/v1/integrity')).expect(200);
    const finding = integrity.body.findings.find(
      (f: { check: string }) => f.check === 'SUSPENSE_BALANCE',
    );
    expect(finding.count).toBe(1);
    expect(finding.severity).toBe('WARNING');
    expect(
      integrity.body.findings.find((f: { check: string }) => f.check === 'TAX_ACCOUNT_INVALID')
        .count,
    ).toBe(0);
    const period = Object.values(periods).find(
      (p) => p.endDate >= parkedOn && p.endDate < daysAgo(0),
    )!;
    const blockers = await as(
      http().get(`/api/v1/financial-closes/blockers?fiscalPeriodId=${period.id}`),
    ).expect(200);
    const blocker = blockers.body.find((b: { key: string }) => b.key === 'SUSPENSE_BALANCES');
    expect(blocker?.blocking).toBe(true);
    // Policy relaxes it: a wider age limit and materiality make it "within policy".
    await as(http().patch('/api/v1/accounting-policies'))
      .send({ suspenseMaxAgeDays: 90, suspenseMateriality: '10000' })
      .expect(200);
    const relaxed = await as(http().get('/api/v1/controls/suspense')).expect(200);
    expect(relaxed.body.accounts.find((a: { code: string }) => a.code === '1990').status).toBe(
      'WITHIN_POLICY',
    );
    await as(http().patch('/api/v1/accounting-policies'))
      .send({ suspenseMaxAgeDays: 30, suspenseMateriality: '0', closeBlockOnSuspense: false })
      .expect(200);
    const notBlocking = await as(
      http().get(`/api/v1/financial-closes/blockers?fiscalPeriodId=${period.id}`),
    ).expect(200);
    expect(
      notBlocking.body.find((b: { key: string }) => b.key === 'SUSPENSE_BALANCES')?.blocking,
    ).toBe(false);
    // Clearing the item (identified as a customer receipt) returns the account to CLEAR.
    await postJournal(
      daysAgo(1),
      [
        { code: '1990', debit: '5000' },
        { code: '1120', credit: '5000' },
      ],
      'Receipt identified',
    );
    const cleared = await as(http().get('/api/v1/controls/suspense')).expect(200);
    const after = cleared.body.accounts.find((a: { code: string }) => a.code === '1990');
    expect(after.status).toBe('CLEAR');
    expect(after.openSince).toBeNull();
    expect(after.transactions).toBe(2);
    expect(parked).toBeDefined();
  });

  // ------------------------------------------------------------ dashboard

  it('the control dashboard summarises every control with a severity', async () => {
    const res = await as(http().get('/api/v1/controls/dashboard'), accountant).expect(200);
    const keys = res.body.tiles.map((t: { key: string }) => t.key);
    expect(keys).toEqual([
      'UNBALANCED_JOURNALS',
      'INTEGRITY',
      'PENDING_APPROVALS',
      'RECONCILIATION_VARIANCES',
      'SUSPENSE_BALANCE',
      'OPEN_EXCEPTIONS',
      'SOD_CONFLICTS',
      'FAILED_JOBS',
      'OPEN_PERIOD',
      'CLOSE_PROGRESS',
    ]);
    const tile = (key: string) => res.body.tiles.find((t: { key: string }) => t.key === key);
    expect(tile('UNBALANCED_JOURNALS').value).toBe('0');
    expect(tile('UNBALANCED_JOURNALS').severity).toBe('OK');
    expect(tile('SUSPENSE_BALANCE').kind).toBe('amount');
    expect(tile('OPEN_PERIOD').value).toBe('January 2026');
    expect(tile('SOD_CONFLICTS').severity).toBe('WARNING'); // admin holds both sides of WARN policies
    expect(['OK', 'INFO', 'WARNING', 'CRITICAL']).toContain(res.body.status);
    // Company context is required.
    await http().get('/api/v1/controls/dashboard').set('Cookie', admin).expect(403);
  });
});
