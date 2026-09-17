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
 * Prompt #11 - Payroll & employee expenses. Proves the seeded pay items,
 * employees and May - August runs reconcile to the employee payable, then
 * drives the lifecycle: pay items and settings as data, employee master with
 * effective-dated assignments, a run that reimburses a posted expense claim
 * of the linked user, one-off inputs, four-eyes approval, one posting
 * journal, payment from the bank, the reversal rule, reports, the treasury
 * forecast source, the financial-close check, the reminder job and the
 * permission boundaries (payroll views are restricted).
 */
describe('Payroll (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  const items: Record<string, { id: string; type: string }> = {};
  const employees: Record<string, { id: string; userId: string | null }> = {};
  let bankAccountId: string;
  let claimId: string;
  let septemberRunId: string;
  let augustRunId: string;

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test) =>
    req.set('Cookie', cookies).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const glBalance = async (code: string, asOf: string): Promise<string> => {
    const res = await as(
      admin,
      http().get(`/api/v1/general-ledger?accountId=${acc[code]}&from=2026-01-01&to=${asOf}`),
    ).expect(200);
    return res.body.closingBalance as string;
  };
  const journalOf = async (id: string) => {
    const res = await as(admin, http().get(`/api/v1/journal-entries/${id}`)).expect(200);
    return res.body as {
      status: string;
      entryDate: string;
      sourceType: string;
      lines: Array<{
        accountId: string;
        debit: string;
        credit: string;
        departmentId: string | null;
      }>;
    };
  };
  const sumOn = (
    entry: { lines: Array<{ accountId: string; debit: string; credit: string }> },
    code: string,
    side: 'debit' | 'credit',
  ) =>
    entry.lines
      .filter((l) => l.accountId === acc[code])
      .reduce((n, l) => n + Number(l[side]), 0)
      .toFixed(4);
  const expectIntegrity = async (asOf: string) => {
    const res = await as(admin, http().get(`/api/v1/payroll/integrity?asOf=${asOf}`)).expect(200);
    for (const check of ['EMPLOYEE_PAYABLE_VS_LEDGER', 'PAYSLIP_TOTALS', 'PAY_RUN_WITHOUT_JOURNAL'])
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
    accountant = await login(ACCOUNTANT);
    finance = await login(FINANCE);
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    for (const a of (await as(admin, http().get('/api/v1/accounts')).expect(200)).body)
      acc[a.code] = a.id;
    for (const i of (await as(admin, http().get('/api/v1/payroll/pay-items')).expect(200)).body)
      items[i.code] = { id: i.id, type: i.type };
    for (const e of (await as(admin, http().get('/api/v1/employees?pageSize=50')).expect(200)).body
      .items)
      employees[e.lastName] = { id: e.id, userId: e.userId };
    const banks = await as(admin, http().get('/api/v1/bank-accounts')).expect(200);
    bankAccountId = (banks.body.items ?? banks.body).find(
      (b: { code: string }) => b.code === 'BDO-MAIN',
    ).id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------------- seed

  it('seed: pay items, employees and May - August runs reconcile to the employee payable', async () => {
    expect(Object.keys(items)).toHaveLength(11);
    expect(items['WTAX']!.type).toBe('WITHHOLDING_TAX');
    expect(Object.keys(employees)).toHaveLength(5);
    expect(employees['Santos']!.userId).toBeTruthy(); // linked to accountant@acme.local
    const runs = await as(finance, http().get('/api/v1/payroll/runs')).expect(200);
    expect(
      runs.body.items.map((r: { periodEnd: string; status: string }) => [r.periodEnd, r.status]),
    ).toEqual([
      ['2026-08-31', 'APPROVED'],
      ['2026-07-31', 'PAID'],
      ['2026-06-30', 'PAID'],
      ['2026-05-31', 'PAID'],
    ]);
    augustRunId = runs.body.items[0].id;
    const june = await as(
      finance,
      http().get(`/api/v1/payroll/runs/${runs.body.items[2].id}`),
    ).expect(200);
    expect(june.body.employeeCount).toBe(4);
    expect(june.body.grossTotal).toBe('178500.0000');
    expect(june.body.netTotal).toBe('153096.2250');
    expect(june.body.inputs).toHaveLength(1);
    const lim = june.body.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Ben Lim',
    );
    expect(lim.gross).toBe('32500.0000'); // 28,000 + 2,500 overtime + 2,000 allowance
    expect(lim.taxable).toBe('28337.5000'); // 30,500 taxable - 1,350 SSS (capped) - 812.50 PhilHealth
    expect(lim.withholding).toBe('1125.6750'); // (28,337.50 - 20,833) x 15%
    expect(lim.lines.map((l: { code: string }) => l.code)).toEqual([
      'BASIC',
      'OT',
      'ALLOW-TRANSPO',
      'SSS-EE',
      'PHIC-EE',
      'HDMF-EE',
      'SSS-ER',
      'PHIC-ER',
      'HDMF-ER',
      'WTAX',
    ]);
    expect(june.body.journalNumber).toMatch(/^JE-/);
    expect(june.body.paymentJournalNumber).toMatch(/^JE-/);
    expect(await glBalance('2170', '2026-08-31')).toBe('0.0000'); // everything posted has been paid
    expect(await glBalance('2175', '2026-08-31')).toBe('89685.0000'); // employee deductions (incl. the loan, whose item has no own account) + employer contributions of three runs
    const integrity = await expectIntegrity('2026-08-31');
    expect(integrity.status).toBe('OK');
    const summary = await as(
      finance,
      http().get('/api/v1/payroll/reports/summary?from=2026-05-01&to=2026-08-31'),
    ).expect(200);
    expect(summary.body.runs).toBe(3);
    expect(summary.body.gross).toBe('554500.0000');
    expect(summary.body.byDepartment).toHaveLength(3);
    expect(summary.body.byMonth.map((m: { month: string }) => m.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
    ]);
  });

  // ----------------------------------------------------------------- config

  it('config: pay items and settings are data; brackets and duplicates are validated', async () => {
    const bonus = await as(finance, http().post('/api/v1/payroll/pay-items'))
      .send({
        code: 'BONUS',
        name: 'Performance bonus',
        type: 'EARNING',
        calculation: 'FIXED',
        taxable: true,
        sortOrder: 6,
      })
      .expect(201);
    items['BONUS'] = { id: bonus.body.id, type: 'EARNING' };
    await as(finance, http().post('/api/v1/payroll/pay-items'))
      .send({ code: 'BONUS', name: 'Again', type: 'EARNING', calculation: 'FIXED' })
      .expect(409);
    const badBrackets = await as(finance, http().post('/api/v1/payroll/pay-items'))
      .send({
        code: 'BAD',
        name: 'Bad',
        type: 'WITHHOLDING_TAX',
        calculation: 'BRACKET',
        brackets: [
          { over: '100', base: '0', rate: '5' },
          { over: '50', base: '0', rate: '10' },
        ],
      })
      .expect(400);
    expect(badBrackets.body.code).toBe('VALIDATION_FAILED');
    const secondBase = await as(finance, http().post('/api/v1/payroll/pay-items'))
      .send({ code: 'BASIC2', name: 'Another base', type: 'EARNING', calculation: 'BASE_SALARY' })
      .expect(422);
    expect(secondBase.body.code).toBe('PAY_ITEM_INVALID');
    const settings = await as(finance, http().put('/api/v1/payroll/settings'))
      .send({ payDateReminderDays: 5 })
      .expect(200);
    expect(settings.body.payDateReminderDays).toBe(5);
    expect(settings.body.payrollBankAccountId).toBe(bankAccountId);
    await as(viewer, http().get('/api/v1/payroll/pay-items')).expect(403); // payroll views are restricted
    await as(
      accountant,
      http().post('/api/v1/payroll/runs/00000000-0000-0000-0000-000000000000/approve'),
    ).expect(403);
  });

  // -------------------------------------------------------------- employees

  it('employees: numbered from the EMP rule, effective-dated assignments, one user per employee', async () => {
    await as(viewer, http().get('/api/v1/employees')).expect(403);
    const created = await as(accountant, http().post('/api/v1/employees'))
      .send({
        firstName: 'Dan',
        lastName: 'Ocampo',
        jobTitle: 'Support Engineer',
        payFrequency: 'MONTHLY',
        baseSalary: '30000',
        hireDate: '2026-09-01',
        paymentMethod: 'BANK',
        bankName: 'BDO',
        bankAccountNumber: '****9999',
      })
      .expect(201);
    expect(created.body.employeeNumber).toMatch(/^EMP-2026-/);
    expect(created.body.status).toBe('ACTIVE');
    employees['Ocampo'] = { id: created.body.id, userId: null };
    const assigned = await as(
      accountant,
      http().post(`/api/v1/employees/${created.body.id}/pay-items`),
    )
      .send({ payItemId: items['LOAN']!.id, amount: '1000', effectiveFrom: '2026-10-01' })
      .expect(201);
    expect(assigned.body.payItems).toHaveLength(1);
    const baseAssign = await as(
      accountant,
      http().post(`/api/v1/employees/${created.body.id}/pay-items`),
    )
      .send({ payItemId: items['BASIC']!.id, effectiveFrom: '2026-09-01' })
      .expect(422);
    expect(baseAssign.body.code).toBe('PAY_ITEM_INVALID');
    const takenUser = await as(accountant, http().patch(`/api/v1/employees/${created.body.id}`))
      .send({ userId: employees['Santos']!.userId, changeReason: 'link' })
      .expect(409);
    expect(takenUser.body.code).toBe('DUPLICATE');
    const updated = await as(accountant, http().patch(`/api/v1/employees/${created.body.id}`))
      .send({ baseSalary: '32000', changeReason: 'Salary review' })
      .expect(200);
    expect(updated.body.baseSalary).toBe('32000.0000');
    const ytd = await as(
      finance,
      http().get(`/api/v1/employees/${employees['Santos']!.id}/ytd?year=2026`),
    ).expect(200);
    expect(ytd.body.payslips).toBe(3);
    expect(ytd.body.gross).toBe('186000.0000');
  });

  // ---------------------------------------------------------------- pay run

  it('pay run: a posted expense claim of the linked user is reimbursed; inputs change the payslip; approval is four-eyes', async () => {
    const claim = await as(accountant, http().post('/api/v1/expense-claims'))
      .send({
        claimDate: '2026-09-10',
        purpose: 'Client lunch',
        lines: [
          {
            expenseDate: '2026-09-09',
            description: 'Lunch',
            accountId: acc['6400'],
            amount: '850',
          },
        ],
      })
      .expect(201);
    claimId = claim.body.id;
    await as(accountant, http().post(`/api/v1/expense-claims/${claimId}/submit`)).expect(201);
    await as(finance, http().post(`/api/v1/expense-claims/${claimId}/approve`)).expect(201);
    await as(finance, http().post(`/api/v1/expense-claims/${claimId}/post`)).expect(201);

    const overlap = await as(accountant, http().post('/api/v1/payroll/runs'))
      .send({
        payFrequency: 'MONTHLY',
        periodStart: '2026-08-15',
        periodEnd: '2026-09-14',
        payDate: '2026-09-15',
      })
      .expect(422);
    expect(overlap.body.code).toBe('PAY_RUN_INVALID_STATE');
    const run = await as(accountant, http().post('/api/v1/payroll/runs'))
      .send({
        payFrequency: 'MONTHLY',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        payDate: '2026-09-30',
        description: 'September payroll',
      })
      .expect(201);
    septemberRunId = run.body.id;
    expect(run.body.documentNumber).toBe('PYR-2026-000005');
    expect(run.body.status).toBe('DRAFT');
    await as(finance, http().post(`/api/v1/payroll/runs/${septemberRunId}/approve`)).expect(422);

    const calculated = await as(
      accountant,
      http().post(`/api/v1/payroll/runs/${septemberRunId}/calculate`),
    ).expect(200);
    expect(calculated.body.status).toBe('CALCULATED');
    expect(calculated.body.employeeCount).toBe(6); // five seeded + Dan Ocampo (hired 09-01)
    const maria = calculated.body.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Maria Santos',
    );
    expect(maria.reimbursements).toBe('850.0000');
    expect(maria.lines.find((l: { code: string }) => l.code === 'CLAIM').expenseClaimId).toBe(
      claimId,
    );
    expect(maria.net).toBe('53121.6000'); // 52,271.60 + 850 reimbursed
    const dan = calculated.body.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Dan Ocampo',
    );
    expect(dan.gross).toBe('34000.0000'); // 32,000 + allowance; the loan starts in October
    expect(dan.lines.some((l: { code: string }) => l.code === 'LOAN')).toBe(false);
    expect(calculated.body.reimbursementTotal).toBe('850.0000');

    const withInputs = await as(
      accountant,
      http().put(`/api/v1/payroll/runs/${septemberRunId}/inputs`),
    )
      .send({
        inputs: [
          {
            employeeId: employees['Reyes']!.id,
            payItemId: items['BONUS']!.id,
            amount: '5000',
            note: 'Q3 target',
          },
        ],
      })
      .expect(200);
    expect(withInputs.body.status).toBe('DRAFT'); // inputs invalidate the calculation
    const recalculated = await as(
      accountant,
      http().post(`/api/v1/payroll/runs/${septemberRunId}/calculate`),
    ).expect(200);
    const jose = recalculated.body.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Jose Reyes',
    );
    expect(jose.gross).toBe('52000.0000'); // 45,000 + 5,000 bonus + 2,000 allowance
    expect(jose.lines.find((l: { code: string }) => l.code === 'BONUS').description).toBe(
      'Performance bonus - Q3 target',
    );

    await as(accountant, http().post(`/api/v1/payroll/runs/${septemberRunId}/submit`)).expect(200);
    await as(accountant, http().post(`/api/v1/payroll/runs/${septemberRunId}/approve`)).expect(403);
    const approved = await as(
      finance,
      http().post(`/api/v1/payroll/runs/${septemberRunId}/approve`),
    ).expect(200);
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.approvedByName).toBeTruthy();
    const locked = await as(accountant, http().put(`/api/v1/payroll/runs/${septemberRunId}/inputs`))
      .send({ inputs: [] })
      .expect(422);
    expect(locked.body.code).toBe('PAY_RUN_INVALID_STATE');
  });

  it('post + pay: one journal by account and department, the net owed, then the bank payment settles payroll and the claim', async () => {
    await as(accountant, http().post(`/api/v1/payroll/runs/${septemberRunId}/post`)).expect(403);
    const posted = await as(
      finance,
      http().post(`/api/v1/payroll/runs/${septemberRunId}/post`),
    ).expect(200);
    expect(posted.body.status).toBe('POSTED');
    const entry = await journalOf(posted.body.journalEntryId);
    expect(entry.entryDate).toBe('2026-09-30');
    expect(entry.sourceType).toBe('PAY_RUN');
    expect(sumOn(entry, '6100', 'debit')).toBe(posted.body.grossTotal); // the claim line carries no expense
    expect(sumOn(entry, '6110', 'debit')).toBe(posted.body.employerTotal);
    expect(sumOn(entry, '2140', 'credit')).toBe(posted.body.withholdingTotal);
    expect(sumOn(entry, '2170', 'credit')).toBe((Number(posted.body.netTotal) - 850).toFixed(4));
    expect(entry.lines.some((l) => l.departmentId)).toBe(true);
    // Payable now carries September's net (less the claim, which was already there) plus the claim.
    expect(await glBalance('2170', '2026-09-30')).toBe(posted.body.netTotal);
    await expectIntegrity('2026-09-30');

    const claimBefore = await as(finance, http().get(`/api/v1/expense-claims/${claimId}`)).expect(
      200,
    );
    expect(claimBefore.body.status).toBe('POSTED');
    const paid = await as(finance, http().post(`/api/v1/payroll/runs/${septemberRunId}/pay`))
      .send({ reference: 'PAYROLL-SEP' })
      .expect(200);
    expect(paid.body.status).toBe('PAID');
    expect(paid.body.bankAccountCode).toBe('BDO-MAIN');
    const payment = await journalOf(paid.body.paymentJournalEntryId);
    expect(payment.sourceType).toBe('PAY_RUN_PAYMENT');
    expect(sumOn(payment, '2170', 'debit')).toBe(paid.body.netTotal);
    expect(sumOn(payment, '1130', 'credit')).toBe(paid.body.netTotal);
    const claimAfter = await as(finance, http().get(`/api/v1/expense-claims/${claimId}`)).expect(
      200,
    );
    expect(claimAfter.body.status).toBe('PAID');
    expect(claimAfter.body.paymentJournalEntryId).toBe(paid.body.paymentJournalEntryId);
    expect(await glBalance('2170', '2026-09-30')).toBe('0.0000');
    await expectIntegrity('2026-09-30');
    const noReverse = await as(
      finance,
      http().post(`/api/v1/payroll/runs/${septemberRunId}/reverse`),
    )
      .send({ reason: 'x' })
      .expect(422);
    expect(noReverse.body.code).toBe('PAY_RUN_INVALID_STATE');
  });

  it('reverse: an unpaid posted run mirrors its journal and frees the period', async () => {
    const run = await as(accountant, http().post('/api/v1/payroll/runs'))
      .send({
        payFrequency: 'MONTHLY',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        payDate: '2026-10-30',
      })
      .expect(201);
    await as(accountant, http().post(`/api/v1/payroll/runs/${run.body.id}/calculate`)).expect(200);
    await as(finance, http().post(`/api/v1/payroll/runs/${run.body.id}/approve`)).expect(200);
    const posted = await as(
      finance,
      http().post(`/api/v1/payroll/runs/${run.body.id}/post`),
    ).expect(200);
    const dan = posted.body.payslips.find(
      (p: { employeeName: string }) => p.employeeName === 'Dan Ocampo',
    );
    expect(
      dan.lines.some(
        (l: { code: string; amount: string }) => l.code === 'LOAN' && l.amount === '1000.0000',
      ),
    ).toBe(true);
    expect(await glBalance('2170', '2026-10-31')).toBe(posted.body.netTotal);
    const reversed = await as(finance, http().post(`/api/v1/payroll/runs/${run.body.id}/reverse`))
      .send({ reason: 'Wrong overtime' })
      .expect(200);
    expect(reversed.body.status).toBe('REVERSED');
    expect((await journalOf(posted.body.journalEntryId)).status).toBe('REVERSED');
    expect(await glBalance('2170', '2026-10-31')).toBe('0.0000');
    await expectIntegrity('2026-10-31');
    const again = await as(accountant, http().post('/api/v1/payroll/runs'))
      .send({
        payFrequency: 'MONTHLY',
        periodStart: '2026-10-01',
        periodEnd: '2026-10-31',
        payDate: '2026-10-30',
      })
      .expect(201);
    await as(accountant, http().delete(`/api/v1/payroll/runs/${again.body.id}`)).expect(204);
  });

  // ------------------------------------------------------ integrations

  it('integrations: treasury forecast carries approved runs, the close checklist waits for posting, reminders fire', async () => {
    const forecast = await as(
      finance,
      http().get('/api/v1/treasury/forecast?asOf=2026-09-01&horizonDays=30'),
    ).expect(200);
    const payroll = forecast.body.bySource.find((s: { source: string }) => s.source === 'PAYROLL');
    expect(payroll).toBeTruthy();
    expect(Number(payroll.outflow ?? payroll.amount ?? payroll.total)).toBeGreaterThan(0);

    const years = await as(admin, http().get('/api/v1/fiscal-years')).expect(200);
    const august = years.body[0].periods.find(
      (p: { startDate: string }) => p.startDate === '2026-08-01',
    );
    const close = await as(finance, http().post('/api/v1/financial-closes'))
      .send({ fiscalPeriodId: august.id })
      .expect(201);
    const task = close.body.tasks.find((t: { key: string }) => t.key === 'PAYROLL_POSTED');
    expect(task.status).not.toBe('DONE');
    expect(task.detail.openRuns).toEqual(['PYR-2026-000004']);
    await as(finance, http().post(`/api/v1/payroll/runs/${augustRunId}/post`)).expect(200);
    const refreshed = await as(
      finance,
      http().post(`/api/v1/financial-closes/${close.body.id}/refresh`),
    ).expect(201);
    expect(
      refreshed.body.tasks.find((t: { key: string }) => t.key === 'PAYROLL_POSTED').status,
    ).toBe('DONE');
    await expectIntegrity('2026-09-30');
    const integrity = await as(
      admin,
      http().get('/api/v1/payroll/integrity?asOf=2026-09-17'),
    ).expect(200);
    expect(
      integrity.body.findings.find((f: { check: string }) => f.check === 'PAY_RUNS_UNPAID').count,
    ).toBe(1); // August, pay date 09-05

    const reminders = await as(
      finance,
      http().post('/api/v1/payroll/reminders/run?asOf=2026-09-17'),
    ).expect(200);
    expect(reminders.body.reminders).toBeGreaterThan(0);
    const withholding = await as(
      finance,
      http().get('/api/v1/payroll/reports/withholding?from=2026-05-01&to=2026-09-30'),
    ).expect(200);
    expect(withholding.body.rows.map((r: { month: string }) => r.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
    ]);
    expect(Number(withholding.body.total)).toBeGreaterThan(60000);
  });
});
