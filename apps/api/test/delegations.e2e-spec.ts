import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';
import { DelegationsService } from '@/modules/delegations/delegations.service';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'Admin!Passw0rd' };
const FINANCE = { email: 'finance@acme.local', password: 'Demo!Passw0rd' };
const ACCOUNTANT = { email: 'accountant@acme.local', password: 'Demo!Passw0rd' };
const AUDITOR = { email: 'auditor@acme.local', password: 'Demo!Passw0rd' };
const VIEWER = { email: 'viewer@acme.local', password: 'Demo!Passw0rd' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #4 - delegated authority: creation rules, approval policy,
 * activation, use with amount / scope / SoD checks, audit attribution,
 * revocation and expiry - and that none of it grants anything the delegator
 * does not hold or lets anyone approve their own work.
 */
describe('Delegated authority (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let delegationsService: DelegationsService;
  let admin: Cookies;
  let finance: Cookies;
  let accountant: Cookies;
  let auditor: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  let branchId: string;
  let otherBranchId: string;
  let vendorId: string;
  const acc: Record<string, string> = {};
  const users: Record<string, string> = {};

  const server = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin, company: string = companyId) =>
    req.set('Cookie', who).set('x-company-id', company).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await server().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const sql = async <T = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await pool.query(text, params)).rows as T[];
  const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
  const createBill = async (who: Cookies, amount: string, extra: Record<string, unknown> = {}) => {
    const res = await as(server().post('/api/v1/bills'), who)
      .send({
        vendorId,
        documentDate: '2026-04-10',
        lines: [{ description: 'Delegation test', unitPrice: amount, accountId: acc['6400'] }],
        ...extra,
      })
      .expect(201);
    return res.body as { id: string; documentNumber: string; total: string };
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
    delegationsService = app.get(DelegationsService);
    admin = await login(ADMIN);
    finance = await login(FINANCE);
    accountant = await login(ACCOUNTANT);
    auditor = await login(AUDITOR);
    viewer = await login(VIEWER);
    const companies = await server().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    otherCompanyId = companies.body.find((c: { code: string }) => c.code !== 'ACME').id;
    const branches = await as(server().get(`/api/v1/branches?companyId=${companyId}`)).expect(200);
    branchId = branches.body[0].id;
    otherBranchId = branches.body[1].id;
    const chart = await as(server().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const people = await as(server().get('/api/v1/users?pageSize=50')).expect(200);
    for (const u of people.body.items) users[u.email] = u.id;
    const vendor = await as(server().post('/api/v1/vendors'))
      .send({ code: 'DLG-VEND', name: 'Delegation Vendor' })
      .expect(201);
    vendorId = vendor.body.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('exposes the delegable catalogue, policy and the seeded sample delegation', async () => {
    const permissions = await as(
      server().get('/api/v1/delegations/permissions'),
      accountant,
    ).expect(200);
    const keys = permissions.body.map((p: { permission: string }) => p.permission);
    expect(keys).toEqual(
      expect.arrayContaining(['bill.approve', 'invoice.approve', 'journal.approve']),
    );
    expect(keys).not.toContain('journal.post');
    expect(keys).not.toContain('role.assign');
    const policy = await as(server().get('/api/v1/delegations/policy'), accountant).expect(200);
    expect(policy.body.approvalPolicy).toBe('MANAGER_APPROVAL');
    const mine = await as(server().get('/api/v1/delegations?role=delegate'), accountant).expect(
      200,
    );
    expect(mine.body.items).toHaveLength(1);
    expect(mine.body.items[0]).toMatchObject({
      delegationNumber: 'DLG-000001',
      status: 'ACTIVE',
      inEffect: true,
      delegatorEmail: FINANCE.email,
    });
    const me = await as(server().get('/api/v1/auth/me'), accountant).expect(200);
    expect(me.body.permissions).not.toContain('bill.approve');
    expect(me.body.delegations).toHaveLength(1);
    expect(me.body.delegations[0]).toMatchObject({
      permission: 'bill.approve',
      maxAmount: '500000.0000',
      delegatorName: 'Marco Santos',
    });
    const authority = await as(server().get('/api/v1/delegations/my-authority'), accountant).expect(
      200,
    );
    expect(authority.body[0].delegationNumber).toBe('DLG-000001');
    // Grants are per company: nothing is lent in the other company.
    expect(
      (
        await as(
          server().get('/api/v1/delegations/my-authority'),
          accountant,
          otherCompanyId,
        ).expect(200)
      ).body,
    ).toEqual([]);
  });

  it('lets the delegate approve within the limit; the audit trail names the original authority', async () => {
    const bill = await createBill(admin, '120000');
    const approved = await as(server().post(`/api/v1/bills/${bill.id}/approve`), accountant).expect(
      201,
    );
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedBy).toBe(users[ACCOUNTANT.email]);

    const usage = await as(server().get('/api/v1/audit-logs?action=DELEGATION_USE')).expect(200);
    expect(usage.body.items).toHaveLength(1);
    const record = usage.body.items[0];
    expect(record.userEmail).toBe(ACCOUNTANT.email);
    expect(record.newValue).toMatchObject({
      delegation: 'DLG-000001',
      permission: 'bill.approve',
      action: 'Approved vendor bill',
      originalAuthority: { userId: users[FINANCE.email], name: 'Marco Santos' },
      actingUser: { email: ACCOUNTANT.email },
      document: { type: 'VENDOR_BILL', number: bill.documentNumber, amount: '120000.0000' },
    });
    const billAudit = await as(
      server().get(`/api/v1/audit-logs?entityType=VendorBill&entityId=${bill.id}&action=APPROVE`),
    ).expect(200);
    expect(billAudit.body.items[0].metadata.delegatedAuthority.delegation).toBe('DLG-000001');

    const list = await as(server().get('/api/v1/delegations?role=delegate'), accountant).expect(
      200,
    );
    const id = list.body.items[0].id;
    const usageRows = await as(server().get(`/api/v1/delegations/${id}/usage`), accountant).expect(
      200,
    );
    expect(usageRows.body).toHaveLength(1);
    expect(usageRows.body[0]).toMatchObject({
      documentNumber: bill.documentNumber,
      amount: '120000.0000',
      delegateUserId: users[ACCOUNTANT.email],
    });
    expect(
      (await as(server().get(`/api/v1/delegations/${id}`), accountant).expect(200)).body.usageCount,
    ).toBe(1);
  });

  it('Rule 7: refuses amounts above the delegated limit', async () => {
    const bill = await createBill(admin, '600000');
    const denied = await as(server().post(`/api/v1/bills/${bill.id}/approve`), accountant).expect(
      422,
    );
    expect(denied.body.code).toBe('DELEGATION_LIMIT_EXCEEDED');
    expect(denied.body.details.delegation).toBe('DLG-000001');
    expect(
      (
        await sql<{ status: string }>('select status from vendor_bills where id = $1', [bill.id])
      )[0]!.status,
    ).toBe('DRAFT');
  });

  it('Rule 9: the delegate cannot approve a bill they created themselves', async () => {
    const own = await createBill(accountant, '1000');
    const denied = await as(server().post(`/api/v1/bills/${own.id}/approve`), accountant).expect(
      422,
    );
    expect(denied.body.code).toBe('SOD_VIOLATION');
    expect(denied.body.details.rule).toBe('SELF_APPROVAL');
  });

  it('Rule 1 / 2 / self: cannot delegate what you do not hold, nor to yourself, nor non-delegable permissions', async () => {
    const base = {
      delegateUserId: users[VIEWER.email],
      companyId,
      startAt: isoIn(1000),
      endAt: isoIn(3 * 24 * 3600 * 1000),
      reason: 'Coverage',
    };
    // The auditor holds no approval permission: an administrator cannot lend one on their behalf either.
    const escalate = await as(server().post('/api/v1/delegations'))
      .send({
        ...base,
        delegatorUserId: users[AUDITOR.email],
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(422);
    expect(escalate.body.code).toBe('DELEGATION_NOT_PERMITTED');
    expect(escalate.body.details.missing).toEqual(['bill.approve']);
    const self = await as(server().post('/api/v1/delegations'), finance)
      .send({
        ...base,
        delegateUserId: users[FINANCE.email],
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(422);
    expect(self.body.code).toBe('DELEGATION_NOT_PERMITTED');
    const notDelegable = await as(server().post('/api/v1/delegations'), finance)
      .send({ ...base, scopes: [{ permission: 'bill.post' }] })
      .expect(400);
    expect(notDelegable.body.code).toBe('VALIDATION_FAILED');
    // The accountant holds no delegation.create at all.
    await as(server().post('/api/v1/delegations'), accountant)
      .send({ ...base, scopes: [{ permission: 'bill.approve' }] })
      .expect(403);
    // Windows: end before start, too long, in the past.
    const tooLong = await as(server().post('/api/v1/delegations'), finance)
      .send({
        ...base,
        endAt: isoIn(120 * 24 * 3600 * 1000),
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(422);
    expect(tooLong.body.message).toMatch(/at most 90 days/);
    await as(server().post('/api/v1/delegations'), finance)
      .send({
        ...base,
        startAt: isoIn(5000),
        endAt: isoIn(1000),
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(400);
  });

  let pendingId: string;

  it('Approval policy: a delegation waits for an eligible approver; parties and the unprivileged cannot approve it', async () => {
    const created = await as(server().post('/api/v1/delegations'), finance)
      .send({
        delegateUserId: users[ACCOUNTANT.email],
        companyId,
        startAt: isoIn(0),
        endAt: isoIn(2 * 24 * 3600 * 1000),
        reason: 'Invoice approvals while travelling',
        scopes: [{ permission: 'invoice.approve', maxAmount: '50000', branchId }],
      })
      .expect(201);
    pendingId = created.body.id;
    expect(created.body).toMatchObject({
      status: 'PENDING',
      requiredApprovals: 1,
      delegationNumber: 'DLG-000002',
      canApprove: false,
    });
    expect(created.body.scopes[0]).toMatchObject({
      permission: 'invoice.approve',
      maxAmount: '50000.0000',
      currency: 'PHP',
      branchId,
    });
    // Pending delegations grant nothing.
    const me = await as(server().get('/api/v1/auth/me'), accountant).expect(200);
    expect(me.body.delegations.map((d: { permission: string }) => d.permission)).toEqual([
      'bill.approve',
    ]);
    // Delegator and delegate are parties; the viewer lacks delegation.approve.
    const party = await as(server().post(`/api/v1/delegations/${pendingId}/approve`), finance)
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(party.body.code).toBe('SOD_VIOLATION');
    await as(server().post(`/api/v1/delegations/${pendingId}/approve`), accountant)
      .send({ decision: 'APPROVE' })
      .expect(422);
    const notEligible = await as(server().post(`/api/v1/delegations/${pendingId}/approve`), viewer)
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(notEligible.body.code).toBe('DELEGATION_NOT_ELIGIBLE');
    const inbox = await as(server().get('/api/v1/delegations?role=approver')).expect(200);
    expect(inbox.body.items.map((d: { id: string }) => d.id)).toContain(pendingId);
    const notifications = await as(server().get('/api/v1/notifications')).expect(200);
    expect(
      notifications.body.items.some(
        (n: { eventType: string }) => n.eventType === 'DELEGATION_APPROVAL_REQUIRED',
      ),
    ).toBe(true);
  });

  it('activates on approval and enforces branch scope; audit records every step', async () => {
    const approved = await as(server().post(`/api/v1/delegations/${pendingId}/approve`))
      .send({ decision: 'APPROVE', comment: 'ok' })
      .expect(201);
    expect(approved.body.status).toBe('ACTIVE');
    expect(approved.body.approvedBy).toBe(users[ADMIN.email]);
    await as(server().post(`/api/v1/delegations/${pendingId}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(422);

    const customers = await as(server().get('/api/v1/customers?pageSize=1')).expect(200);
    const customerId = customers.body.items[0].id;
    const inBranch = await as(server().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-04-11',
        branchId,
        lines: [{ description: 'Scoped', unitPrice: '1000', accountId: acc['4100'] }],
      })
      .expect(201);
    const ok = await as(
      server().post(`/api/v1/invoices/${inBranch.body.id}/approve`),
      accountant,
    ).expect(201);
    expect(ok.body.status).toBe('APPROVED');

    const outOfBranch = await as(server().post('/api/v1/invoices'))
      .send({
        customerId,
        documentDate: '2026-04-11',
        branchId: otherBranchId,
        lines: [{ description: 'Elsewhere', unitPrice: '1000', accountId: acc['4100'] }],
      })
      .expect(201);
    const denied = await as(
      server().post(`/api/v1/invoices/${outOfBranch.body.id}/approve`),
      accountant,
    ).expect(422);
    expect(denied.body.code).toBe('DELEGATION_SCOPE_EXCEEDED');
    expect(denied.body.details.rule).toBe('BRANCH');

    const audit = await as(
      server().get(`/api/v1/audit-logs?entityType=Delegation&entityId=${pendingId}`),
    ).expect(200);
    expect(audit.body.items.map((a: { action: string }) => a.action)).toEqual(
      expect.arrayContaining(['CREATE', 'APPROVE', 'ACTIVATE', 'DELEGATION_USE']),
    );
    // Auditors see delegations without being parties.
    expect(
      (await as(server().get('/api/v1/delegations'), auditor).expect(200)).body.total,
    ).toBeGreaterThanOrEqual(2);
  });

  it('Rule 5: revocation stops the authority immediately; only the delegator or an administrator may revoke', async () => {
    await as(server().post(`/api/v1/delegations/${pendingId}/revoke`), accountant)
      .send({ reason: 'nope' })
      .expect(403);
    const revoked = await as(server().post(`/api/v1/delegations/${pendingId}/revoke`), finance)
      .send({ reason: 'Back early' })
      .expect(201);
    expect(revoked.body.status).toBe('REVOKED');
    const customers = await as(server().get('/api/v1/customers?pageSize=1')).expect(200);
    const invoice = await as(server().post('/api/v1/invoices'))
      .send({
        customerId: customers.body.items[0].id,
        documentDate: '2026-04-12',
        branchId,
        lines: [{ description: 'After revoke', unitPrice: '10', accountId: acc['4100'] }],
      })
      .expect(201);
    const denied = await as(
      server().post(`/api/v1/invoices/${invoice.body.id}/approve`),
      accountant,
    ).expect(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    await as(server().post(`/api/v1/delegations/${pendingId}/revoke`), finance)
      .send({ reason: 'again' })
      .expect(422);
  });

  it('Rule 4: expiry is automatic - a delegation past its end grants nothing and the job marks it EXPIRED', async () => {
    const created = await as(server().post('/api/v1/delegations'), finance)
      .send({
        delegateUserId: users[ACCOUNTANT.email],
        companyId,
        startAt: isoIn(0),
        endAt: isoIn(2500),
        reason: 'Very short coverage',
        scopes: [{ permission: 'bill.approve', maxAmount: '999999' }],
      })
      .expect(201);
    await as(server().post(`/api/v1/delegations/${created.body.id}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(201);
    // Two grants for bill.approve now: the 999,999 one lets a 600k bill through while it lasts.
    const bill = await createBill(admin, '600000');
    await as(server().post(`/api/v1/bills/${bill.id}/approve`), accountant).expect(201);
    await new Promise((r) => setTimeout(r, 2600));
    const late = await createBill(admin, '600000');
    const denied = await as(server().post(`/api/v1/bills/${late.id}/approve`), accountant).expect(
      422,
    );
    expect(denied.body.code).toBe('DELEGATION_LIMIT_EXCEEDED'); // only DLG-000001 (500k) is left
    const swept = await delegationsService.expireDue();
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    const row = await as(server().get(`/api/v1/delegations/${created.body.id}`), finance).expect(
      200,
    );
    expect(row.body.status).toBe('EXPIRED');
    const audit = await as(
      server().get(
        `/api/v1/audit-logs?entityType=Delegation&entityId=${created.body.id}&action=EXPIRE`,
      ),
    ).expect(200);
    expect(audit.body.items).toHaveLength(1);
    expect(
      (await as(server().get(`/api/v1/delegations/${created.body.id}/usage`), finance).expect(200))
        .body,
    ).toHaveLength(1);
  });

  it('Rule 2 at use time: when the delegator loses the permission the delegation stops granting it', async () => {
    const roles = await as(server().get(`/api/v1/users/${users[FINANCE.email]}/roles`)).expect(200);
    const assignment = roles.body.find((r: { roleKey: string }) => r.roleKey === 'FINANCE_MANAGER');
    await as(
      server().delete(`/api/v1/users/${users[FINANCE.email]}/roles/${assignment.id}`),
    ).expect(204);
    const bill = await createBill(admin, '1000');
    const denied = await as(server().post(`/api/v1/bills/${bill.id}/approve`), accountant).expect(
      422,
    );
    expect(denied.body.code).toBe('DELEGATION_NOT_PERMITTED');
    const roleList = await as(server().get('/api/v1/roles')).expect(200);
    const fm = roleList.body.find((r: { key: string }) => r.key === 'FINANCE_MANAGER');
    await as(server().post(`/api/v1/users/${users[FINANCE.email]}/roles`))
      .send({ roleId: fm.id })
      .expect(201);
    await as(server().post(`/api/v1/bills/${bill.id}/approve`), accountant).expect(201);
  });

  it('Rule 8: a delegation that would create a segregation-of-duties conflict is refused', async () => {
    // Give the accountant an explicit BLOCK policy between creating and approving bills, then try to lend bill.approve again.
    await as(server().post('/api/v1/sod-policies'))
      .send({
        name: 'Bill create vs approve',
        permissionA: 'bill.create',
        permissionB: 'bill.approve',
        enforcement: 'BLOCK',
        isActive: true,
      })
      .expect(201);
    const conflict = await as(server().post('/api/v1/delegations'), finance)
      .send({
        delegateUserId: users[ACCOUNTANT.email],
        companyId,
        startAt: isoIn(0),
        endAt: isoIn(24 * 3600 * 1000),
        reason: 'Would conflict',
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(422);
    expect(conflict.body.code).toBe('SOD_VIOLATION');
  });

  it('Company isolation: the delegation is scoped to ACME and a delegation can be cancelled while pending', async () => {
    const created = await as(server().post('/api/v1/delegations'), finance)
      .send({
        delegateUserId: users[ACCOUNTANT.email],
        companyId,
        startAt: isoIn(0),
        endAt: isoIn(3600_000),
        reason: 'Cancel me',
        scopes: [{ permission: 'journal.approve' }],
      })
      .expect(201);
    expect(created.body.companyId).toBe(companyId);
    const cancelled = await as(
      server().post(`/api/v1/delegations/${created.body.id}/cancel`),
      finance,
    ).expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    // A delegation for the other company only grants authority there (SELF_SERVICE policy to activate directly).
    await as(server().put('/api/v1/delegations/policy'))
      .send({ approvalPolicy: 'SELF_SERVICE' })
      .expect(200);
    const foreign = await as(server().post('/api/v1/delegations'))
      .send({
        delegatorUserId: users[FINANCE.email],
        delegateUserId: users[ACCOUNTANT.email],
        companyId: otherCompanyId,
        startAt: isoIn(0),
        endAt: isoIn(3600_000),
        reason: 'Cross-company',
        scopes: [{ permission: 'journal.approve' }],
      })
      .expect(201);
    expect(foreign.body.status).toBe('ACTIVE');
    const there = await as(
      server().get('/api/v1/delegations/my-authority'),
      accountant,
      otherCompanyId,
    ).expect(200);
    expect(there.body.map((g: { permission: string }) => g.permission)).toEqual([
      'journal.approve',
    ]);
    const here = await as(server().get('/api/v1/delegations/my-authority'), accountant).expect(200);
    expect(here.body.map((g: { permission: string }) => g.permission)).not.toContain(
      'journal.approve',
    );
    // Non-administrators cannot create on behalf of others.
    await as(server().post('/api/v1/delegations'), finance)
      .send({
        delegatorUserId: users[ADMIN.email],
        delegateUserId: users[ACCOUNTANT.email],
        companyId,
        startAt: isoIn(0),
        endAt: isoIn(3600_000),
        reason: 'On behalf',
        scopes: [{ permission: 'bill.approve' }],
      })
      .expect(403);
  });
});
