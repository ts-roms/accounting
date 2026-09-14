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
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };

/**
 * Integration test for the Phase 1 foundation. Runs against a real PostgreSQL
 * (accounting_test) so constraints, triggers and transactions are exercised.
 */
describe('Foundation (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let adminCookies: string[];
  let organizationId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DB_URL, max: 2 });
    await pool.query(
      'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; DROP SCHEMA IF EXISTS drizzle CASCADE;',
    );
    await runMigrations(DB_URL);
    await runSeed(DB_URL, {
      adminEmail: ADMIN.email,
      adminPassword: ADMIN.password,
      demoUsers: true,
      log: () => undefined,
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const http = () => request(app.getHttpServer());
  const asAdmin = (req: request.Test) => req.set('Cookie', adminCookies).set(CSRF);

  it('rejects unauthenticated access with the standard error envelope', async () => {
    const res = await http().get('/api/v1/auth/me').expect(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHENTICATED' });
    expect(typeof res.body.correlationId).toBe('string');
  });

  it('logs in, sets httpOnly cookies and returns the principal', async () => {
    const res = await http().post('/api/v1/auth/login').send(ADMIN).expect(200);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    expect(setCookie.some((c) => c.startsWith('acct_access=') && /HttpOnly/i.test(c))).toBe(true);
    expect(setCookie.some((c) => c.startsWith('acct_refresh=') && /HttpOnly/i.test(c))).toBe(true);
    adminCookies = setCookie.map((c) => c.split(';')[0]!);

    const me = await http().get('/api/v1/auth/me').set('Cookie', adminCookies).expect(200);
    expect(me.body.user.email).toBe(ADMIN.email);
    expect(me.body.roleKeys).toContain('SUPER_ADMIN');
    expect(me.body.permissions).toContain('journal.post');
    expect(me.body.companies.length).toBeGreaterThanOrEqual(2);
    organizationId = me.body.organization.id;
  });

  it('blocks state-changing requests without the CSRF header', async () => {
    const res = await http()
      .post('/api/v1/companies')
      .set('Cookie', adminCookies)
      .send({})
      .expect(403);
    expect(res.body.code).toBe('CSRF_HEADER_MISSING');
  });

  it('validates input with Zod and reports issues', async () => {
    const res = await asAdmin(http().post('/api/v1/companies'))
      .send({ code: 'lower', name: '' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.issues.length).toBeGreaterThan(0);
  });

  it('creates a company inside a transaction and records an audit entry', async () => {
    const created = await asAdmin(http().post('/api/v1/companies'))
      .send({ code: 'TST', name: 'Test Co', baseCurrency: 'PHP', fiscalYearStartMonth: 4 })
      .expect(201);
    expect(created.body.code).toBe('TST');

    const dup = await asAdmin(http().post('/api/v1/companies'))
      .send({ code: 'TST', name: 'Again' })
      .expect(409);
    expect(dup.body.code).toBe('DUPLICATE');

    const { rows } = await pool.query(
      `SELECT action, entity_type, user_email, new_value FROM audit_logs WHERE entity_id = $1 ORDER BY id`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'CREATE',
      entity_type: 'Company',
      user_email: ADMIN.email,
    });
    expect(rows[0].new_value.code).toBe('TST');
  });

  it('enforces CHECK constraints at the database level', async () => {
    const res = await asAdmin(http().post('/api/v1/companies'))
      .send({ code: 'BAD', name: 'Bad', fiscalYearStartMonth: 13 })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    await expect(
      pool.query(
        `INSERT INTO companies (organization_id, code, name, fiscal_year_start_month) VALUES ($1, 'RAW', 'Raw', 13)`,
        [organizationId],
      ),
    ).rejects.toThrow(/companies_fiscal_month_chk/);
  });

  it('denies actions the role does not permit', async () => {
    const viewer = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'viewer@acme.local', password: 'Demo!Passw0rd' })
      .expect(200);
    const cookies = (viewer.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0]!,
    );
    const res = await http()
      .post('/api/v1/companies')
      .set('Cookie', cookies)
      .set(CSRF)
      .send({ code: 'V', name: 'V' })
      .expect(403);
    expect(res.body).toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { required: ['company.manage'] },
    });
    await http().get('/api/v1/audit-logs').set('Cookie', cookies).expect(403);
  });

  it('creates a user, assigns roles with SoD warnings and resolves company-scoped permissions', async () => {
    const roles = await asAdmin(http().get('/api/v1/roles')).expect(200);
    const roleId = (key: string) => roles.body.find((r: { key: string }) => r.key === key).id;
    const companies = await asAdmin(http().get('/api/v1/companies')).expect(200);
    const companyId: string = companies.body[0].id;

    const user = await asAdmin(http().post('/api/v1/users'))
      .send({
        email: 'new.user@acme.local',
        firstName: 'New',
        lastName: 'User',
        password: 'NewUser!Pass1',
        roleIds: [roleId('ACCOUNTANT')],
      })
      .expect(201);
    expect(user.body).not.toHaveProperty('passwordHash');

    // ACCOUNTANT holds journal.create; FINANCE_MANAGER adds journal.approve -> WARN policy.
    const assign = await asAdmin(http().post(`/api/v1/users/${user.body.id}/roles`))
      .send({ roleId: roleId('FINANCE_MANAGER'), companyId })
      .expect(201);
    expect(assign.body.warnings.map((w: { permissionA: string }) => w.permissionA)).toContain(
      'journal.create',
    );

    const login = await http()
      .post('/api/v1/auth/login')
      .send({ email: 'new.user@acme.local', password: 'NewUser!Pass1' })
      .expect(200);
    const cookies = (login.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0]!,
    );

    const orgWide = await http().get('/api/v1/auth/me').set('Cookie', cookies).expect(200);
    expect(orgWide.body.permissions).toContain('journal.create');
    expect(orgWide.body.permissions).not.toContain('journal.approve');

    const scoped = await http()
      .get('/api/v1/auth/me')
      .set('Cookie', cookies)
      .set('x-company-id', companyId)
      .expect(200);
    expect(scoped.body.permissions).toContain('journal.approve');
    expect(scoped.body.activeCompanyId).toBe(companyId);

    const other = companies.body[1].id;
    const otherScoped = await http()
      .get('/api/v1/auth/me')
      .set('Cookie', cookies)
      .set('x-company-id', other)
      .expect(200);
    expect(otherScoped.body.permissions).not.toContain('journal.approve');
  });

  it('blocks assignments that violate a BLOCK segregation-of-duties policy', async () => {
    const policies = await asAdmin(http().get('/api/v1/sod-policies')).expect(200);
    const policy = policies.body.find(
      (p: { permissionA: string }) => p.permissionA === 'journal.create',
    );
    await asAdmin(http().put(`/api/v1/sod-policies/${policy.id}`))
      .send({ ...policy, description: policy.description ?? undefined, enforcement: 'BLOCK' })
      .expect(200);

    const roles = await asAdmin(http().get('/api/v1/roles')).expect(200);
    const users = await asAdmin(http().get('/api/v1/users?search=accountant@')).expect(200);
    const accountant = users.body.items[0];
    const financeManager = roles.body.find((r: { key: string }) => r.key === 'FINANCE_MANAGER');

    const res = await asAdmin(http().post(`/api/v1/users/${accountant.id}/roles`))
      .send({ roleId: financeManager.id })
      .expect(422);
    expect(res.body.code).toBe('SOD_VIOLATION');
    expect(res.body.details.conflicts[0].enforcement).toBe('BLOCK');
  });

  it('protects the last super administrator', async () => {
    const me = await asAdmin(http().get('/api/v1/auth/me')).expect(200);
    const res = await asAdmin(http().patch(`/api/v1/users/${me.body.user.id}/status`))
      .send({ status: 'INACTIVE' })
      .expect(422);
    expect(['FORBIDDEN', 'LAST_SUPER_ADMIN']).toContain(res.body.code);
  });

  it('keeps the audit trail append-only even for direct SQL', async () => {
    await expect(pool.query(`UPDATE audit_logs SET module = 'X'`)).rejects.toThrow(/append-only/);
    await expect(pool.query(`DELETE FROM audit_logs`)).rejects.toThrow(/append-only/);
  });

  it('lists the audit trail with filters', async () => {
    const res = await asAdmin(
      http().get('/api/v1/audit-logs?action=CREATE&entityType=Company'),
    ).expect(200);
    expect(res.body.total).toBeGreaterThanOrEqual(1);
    expect(res.body.items.every((i: { action: string }) => i.action === 'CREATE')).toBe(true);
  });

  it('rotates refresh tokens and revokes on reuse', async () => {
    const login = await http().post('/api/v1/auth/login').send(ADMIN).expect(200);
    const first = (login.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);

    const refreshed = await http()
      .post('/api/v1/auth/refresh')
      .set('Cookie', first)
      .set(CSRF)
      .expect(200);
    const second = (refreshed.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0]!,
    );
    await http().get('/api/v1/auth/me').set('Cookie', second).expect(200);

    // Presenting the already-rotated token is treated as theft: everything is revoked.
    await http().post('/api/v1/auth/refresh').set('Cookie', first).set(CSRF).expect(401);
    const res = await http().get('/api/v1/auth/me').set('Cookie', second).expect(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });

  it('logs out and invalidates the session', async () => {
    // The reuse-detection test above revoked every admin session; start a fresh one.
    const login = await http().post('/api/v1/auth/login').send(ADMIN).expect(200);
    adminCookies = (login.headers['set-cookie'] as unknown as string[]).map(
      (c) => c.split(';')[0]!,
    );
    await asAdmin(http().post('/api/v1/auth/logout')).expect(204);
    const res = await http().get('/api/v1/auth/me').set('Cookie', adminCookies).expect(401);
    expect(res.body.code).toBe('SESSION_EXPIRED');
  });
});
