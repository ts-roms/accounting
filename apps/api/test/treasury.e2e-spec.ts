import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
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
 * Prompt #8 - Cash management and treasury. Reads the seeded cash position,
 * forecast, dashboard and integrity report, then walks an inter-account
 * transfer through approval, send (cash in transit) and settlement, a
 * cross-currency transfer with realized FX, a bank payment file with its
 * bank handshake, petty cash vouchers from draft to posting, replenishment
 * and void, planned forecast items, settings / profiles, the daily sweep,
 * and proves the controls (permissions, SoD, thresholds, company isolation)
 * and that cash in transit and petty cash always reconcile to the ledger.
 */
describe('Treasury platform (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let otherCompanyId: string;
  const acc: Record<string, string> = {};
  const bank: Record<string, { id: string; glAccountId: string; currency: string }> = {};
  const TODAY = '2026-09-14';

  const http = () => request(app.getHttpServer());
  const as = (cookies: Cookies, req: request.Test, company = companyId) =>
    req.set('Cookie', cookies).set('x-company-id', company).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const glBalance = async (code: string, asOf = TODAY): Promise<string> => {
    const res = await as(
      admin,
      http().get(`/api/v1/general-ledger?accountId=${acc[code]}&from=2026-01-01&to=${asOf}`),
    ).expect(200);
    return res.body.closingBalance as string;
  };
  const journalOf = async (journalEntryId: string) => {
    const res = await as(admin, http().get(`/api/v1/journal-entries/${journalEntryId}`)).expect(
      200,
    );
    return res.body as {
      status: string;
      sourceType: string;
      lines: Array<{ accountId: string; debit: string; credit: string }>;
    };
  };
  const lineOn = (
    entry: { lines: Array<{ accountId: string; debit: string; credit: string }> },
    code: string,
  ) => entry.lines.find((l) => l.accountId === acc[code])!;
  /** The treasury invariants that must hold after every ledger-affecting step. */
  const expectIntegrity = async (asOf = TODAY) => {
    const res = await as(admin, http().get(`/api/v1/treasury/integrity?asOf=${asOf}`)).expect(200);
    for (const check of [
      'IN_TRANSIT_VS_LEDGER',
      'TRANSFERS_WITHOUT_JOURNAL',
      'PETTY_CASH_OVERSPENT',
      'VOUCHERS_WITHOUT_JOURNAL',
      'PETTY_CASH_LEDGER_DRIFT',
      'PAYMENT_FILE_TOTALS',
      'PAYMENT_IN_SEVERAL_FILES',
      'FILE_PAYMENT_NOT_POSTED',
    ])
      expect(res.body.findings.find((f: { check: string }) => f.check === check).count).toBe(0);
    return res.body;
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
    const banks = await as(admin, http().get('/api/v1/bank-accounts')).expect(200);
    for (const b of banks.body) bank[b.code] = b;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------- seed / reads

  it('seed: the cash position is the ledger, in transit equals the open transfer and integrity holds', async () => {
    const pos = await as(admin, http().get(`/api/v1/treasury/position?asOf=${TODAY}`)).expect(200);
    const bdo = pos.body.accounts.find((a: { code: string }) => a.code === 'BDO-MAIN');
    const bpi = pos.body.accounts.find((a: { code: string }) => a.code === 'BPI-SAVE');
    expect(bdo.bookBalance).toBe(await glBalance('1130'));
    expect(bpi.bookBalance).toBe('300000.0000');
    expect(bdo.inTransitOut).toBe('50000.0000');
    expect(bpi.inTransitIn).toBe('50000.0000');
    expect(bdo.minimumBalance).toBe('250000.0000');
    expect(bdo.belowMinimum).toBe(false);
    expect(pos.body.totals.inTransit).toBe('50000.0000');
    expect(pos.body.totals.pettyCash).toBe('20000.0000');
    expect(pos.body.byBank[0].bankName).toBe('BDO Unibank');
    expect(await glBalance('1190')).toBe('50000.0000');
    const report = await expectIntegrity();
    // The August sweep transfer is past its expected settlement: a warning, not a break.
    expect(
      report.findings.find((f: { check: string }) => f.check === 'UNSETTLED_TRANSFERS').count,
    ).toBe(1);
  });

  it('seed: the forecast rolls AR, AP, payment runs, transfers and planned items through weekly buckets under a scenario', async () => {
    const base = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=90&granularity=WEEK`),
    ).expect(200);
    expect(base.body.scenario).toBe('BASE');
    expect(base.body.buckets.length).toBeGreaterThanOrEqual(13);
    expect(base.body.openingCash).toBe(
      (await as(admin, http().get(`/api/v1/treasury/position?asOf=${TODAY}`)).expect(200)).body
        .totals.bookBalance,
    );
    const sources = base.body.bySource.map((s: { source: string }) => s.source);
    for (const s of [
      'AR_INVOICES',
      'AP_BILLS',
      'AP_PAYMENT_RUNS',
      'TRANSFERS',
      'PLANNED',
      'AR_PROMISES',
    ])
      expect(sources).toContain(s);
    // Buckets chain: each opening is the previous closing.
    for (let i = 1; i < base.body.buckets.length; i += 1)
      expect(base.body.buckets[i].opening).toBe(base.body.buckets[i - 1].closing);
    expect(base.body.minimumCash).toBe('350000.0000'); // max(avg outflow x 30 days, 250,000 + 100,000 minimums)
    const pessimistic = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=90&scenario=PESSIMISTIC`),
    ).expect(200);
    expect(Number(pessimistic.body.totals.inflows)).toBeLessThan(Number(base.body.totals.inflows));
    expect(Number(pessimistic.body.totals.outflows)).toBeGreaterThanOrEqual(
      Number(base.body.totals.outflows),
    );
    const monthly = await as(
      admin,
      http().get(
        `/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=90&granularity=MONTH&save=true`,
      ),
    ).expect(200);
    expect(monthly.body.buckets.length).toBeLessThanOrEqual(4);
    expect(monthly.body.snapshotId).toBeTruthy();
    const snapshots = await as(admin, http().get('/api/v1/treasury/forecast/snapshots')).expect(
      200,
    );
    expect(snapshots.body[0].id).toBe(monthly.body.snapshotId);
  });

  it('seed: the dashboard composes KPIs, the payment file is acknowledged and the petty cash fund reconciles', async () => {
    const dash = await as(finance, http().get(`/api/v1/treasury/dashboard?asOf=${TODAY}`)).expect(
      200,
    );
    expect(dash.body.kpis.totalCash).toBe(dash.body.position.totals.bookBalance);
    expect(dash.body.kpis.inTransit).toBe('50000.0000');
    expect(dash.body.kpis.daysCashOnHand).toBeGreaterThan(30);
    expect(dash.body.transfers.inTransit).toBe(1);
    expect(dash.body.transfers.unsettled).toHaveLength(1);
    expect(dash.body.pettyCash.funds).toHaveLength(1);
    expect(dash.body.pettyCash.pendingVouchers).toBe(2);
    const files = await as(admin, http().get('/api/v1/treasury/payment-files')).expect(200);
    expect(files.body.items).toHaveLength(1);
    expect(files.body.items[0].status).toBe('ACKNOWLEDGED');
    expect(files.body.items[0].totalAmount).toBe('50000.0000');
    const funds = await as(admin, http().get('/api/v1/treasury/petty-cash/funds')).expect(200);
    const fund = funds.body[0];
    expect(fund.code).toBe('PCF-HO');
    expect(fund.imprestAmount).toBe('20000.0000');
    expect(fund.unreplenished).toBe('5050.0000');
    expect(fund.expectedCashOnHand).toBe('14950.0000');
    expect(fund.bookBalance).toBe('14950.0000'); // imprest less posted vouchers, straight from the GL
    expect(fund.replenishmentDue).toBe(false);
  });

  // ---------------------------------------------------------------- transfers

  let transferId: string;

  it('bank transfer: draft -> approve (segregated, delegable) -> send posts cash in transit -> settle clears it', async () => {
    const created = await as(accountant, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BPI-SAVE']!.id,
        transferDate: TODAY,
        expectedSettlementDate: '2026-09-15',
        amount: '120000',
        feeAmount: '25',
        purpose: 'FUNDING',
        reference: 'TRF-E2E-01',
        idempotencyKey: 'treasury-e2e-transfer-01',
      })
      .expect(201);
    transferId = created.body.id;
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.documentNumber).toMatch(/^BTR-/);
    expect(created.body.baseAmount).toBe('120000.0000');
    // Idempotent create returns the same document.
    const again = await as(accountant, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BPI-SAVE']!.id,
        transferDate: TODAY,
        amount: '120000',
        idempotencyKey: 'treasury-e2e-transfer-01',
      })
      .expect(201);
    expect(again.body.id).toBe(transferId);
    // Same account both sides is rejected up front.
    await as(accountant, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BDO-MAIN']!.id,
        transferDate: TODAY,
        amount: '1',
      })
      .expect(400);
    // Above the 100,000 threshold: cannot be sent before approval.
    const early = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${transferId}/send`),
    ).expect(422);
    expect(early.body.code).toBe('DOCUMENT_INVALID_STATE');
    await as(accountant, http().post(`/api/v1/treasury/transfers/${transferId}/submit`)).expect(
      201,
    );
    // The accountant has no approval permission; the finance manager approves.
    await as(accountant, http().post(`/api/v1/treasury/transfers/${transferId}/approve`)).expect(
      403,
    );
    const approved = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${transferId}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const bdoBefore = await glBalance('1130');
    const sent = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${transferId}/send`),
    ).expect(201);
    expect(sent.body.status).toBe('SENT');
    const outEntry = await journalOf(sent.body.outJournalEntryId);
    expect(outEntry.status).toBe('POSTED');
    expect(outEntry.sourceType).toBe('BANK_TRANSFER_OUT');
    expect(lineOn(outEntry, '1190').debit).toBe('120000.0000');
    expect(lineOn(outEntry, '6600').debit).toBe('25.0000');
    expect(lineOn(outEntry, '1130').credit).toBe('120025.0000');
    expect(Number(await glBalance('1130'))).toBeCloseTo(Number(bdoBefore) - 120025, 2);
    expect(await glBalance('1190')).toBe('170000.0000'); // 50,000 seeded + 120,000
    const pos = await as(admin, http().get(`/api/v1/treasury/position?asOf=${TODAY}`)).expect(200);
    expect(pos.body.totals.inTransit).toBe('170000.0000');
    await expectIntegrity();
    const settled = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${transferId}/settle`),
    )
      .send({ settlementDate: '2026-09-15', bankReference: 'BPI-CR-7781' })
      .expect(201);
    expect(settled.body.status).toBe('SETTLED');
    expect(settled.body.settlementDate).toBe('2026-09-15');
    const inEntry = await journalOf(settled.body.inJournalEntryId);
    expect(inEntry.sourceType).toBe('BANK_TRANSFER_IN');
    expect(lineOn(inEntry, '1180').debit).toBe('120000.0000');
    expect(lineOn(inEntry, '1190').credit).toBe('120000.0000');
    expect(await glBalance('1190', '2026-09-15')).toBe('50000.0000');
    expect(await glBalance('1180', '2026-09-15')).toBe('420000.0000');
    // Settled twice is refused; the event trail carries the lifecycle.
    await as(finance, http().post(`/api/v1/treasury/transfers/${transferId}/settle`))
      .send({})
      .expect(422);
    await expectIntegrity('2026-09-15');
  });

  it('bank transfer: the creator cannot approve their own transfer (SoD) and a small transfer skips approval', async () => {
    // The default policy warns; tighten it to BLOCK the way an administrator would.
    const policies = await as(admin, http().get('/api/v1/sod-policies')).expect(200);
    const policy = policies.body.find(
      (x: { permissionA: string; permissionB: string }) =>
        x.permissionA === 'bank-transfer.create' && x.permissionB === 'bank-transfer.approve',
    );
    expect(policy.enforcement).toBe('WARN');
    await as(admin, http().put(`/api/v1/sod-policies/${policy.id}`))
      .send({ ...policy, description: undefined, enforcement: 'BLOCK' })
      .expect(200);
    const own = await as(finance, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BPI-SAVE']!.id,
        transferDate: TODAY,
        amount: '150000',
      })
      .expect(201);
    const sod = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${own.body.id}/approve`),
    ).expect(422);
    expect(sod.body.code).toBe('SOD_VIOLATION');
    await as(admin, http().put(`/api/v1/sod-policies/${policy.id}`))
      .send({ ...policy, description: undefined, enforcement: 'WARN' })
      .expect(200);
    const cancelled = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${own.body.id}/cancel`),
    )
      .send({ reason: 'Drafted by mistake' })
      .expect(201);
    expect(cancelled.body.status).toBe('CANCELLED');
    // Under the threshold the finance manager sends straight from draft.
    const small = await as(finance, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BPI-SAVE']!.id,
        transferDate: TODAY,
        amount: '5000',
        purpose: 'SWEEP',
      })
      .expect(201);
    const sent = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${small.body.id}/send`),
    ).expect(201);
    expect(sent.body.status).toBe('SENT');
    const list = await as(admin, http().get('/api/v1/treasury/transfers?status=SENT')).expect(200);
    expect(list.body.items.map((t: { id: string }) => t.id)).toContain(small.body.id);
    await as(finance, http().post(`/api/v1/treasury/transfers/${small.body.id}/settle`))
      .send({ settlementDate: TODAY })
      .expect(201);
    await expectIntegrity();
  });

  it('bank transfer: a cross-currency transfer books the destination at the settlement rate and the difference as realized FX', async () => {
    const usdGl = await as(admin, http().post('/api/v1/accounts'))
      .send({
        code: '1170',
        name: 'Cash in Bank - USD',
        type: 'ASSET',
        subtype: 'BANK',
        parentId: acc['1100'],
        // A foreign-currency bank account books to a GL account bound to that currency.
        currency: 'USD',
      })
      .expect(201);
    acc['1170'] = usdGl.body.id;
    const usd = await as(admin, http().post('/api/v1/bank-accounts'))
      .send({
        code: 'BDO-USD',
        name: 'BDO USD Account',
        bankName: 'BDO Unibank',
        accountNumber: '****0099',
        glAccountId: acc['1170'],
        currency: 'USD',
      })
      .expect(201);
    // PHP 57,500 out; USD 1,000 expected at 57.50 (the July rate).
    const created = await as(finance, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: usd.body.id,
        transferDate: TODAY,
        amount: '57500',
        purpose: 'FUNDING',
      })
      .expect(201);
    expect(created.body.toCurrency).toBe('USD');
    expect(created.body.receivedAmount).toBe('1000.0000');
    const sent = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${created.body.id}/send`),
    ).expect(201);
    expect(sent.body.status).toBe('SENT');
    // The bank credited USD 990 (correspondent charge): 990 x 57.50 = 56,925 lands in the USD account, 575 is a realized loss.
    const settled = await as(
      finance,
      http().post(`/api/v1/treasury/transfers/${created.body.id}/settle`),
    )
      .send({ settlementDate: TODAY, receivedAmount: '990' })
      .expect(201);
    expect(settled.body.receivedAmount).toBe('990.0000');
    expect(settled.body.fxDifference).toBe('-575.0000');
    const inEntry = await journalOf(settled.body.inJournalEntryId);
    expect(lineOn(inEntry, '1170').debit).toBe('56925.0000');
    expect(lineOn(inEntry, '1190').credit).toBe('57500.0000');
    expect(lineOn(inEntry, '6910').debit).toBe('575.0000');
    const pos = await as(admin, http().get(`/api/v1/treasury/position?asOf=${TODAY}`)).expect(200);
    const usdRow = pos.body.accounts.find((a: { code: string }) => a.code === 'BDO-USD');
    expect(usdRow.currency).toBe('USD');
    expect(usdRow.bookBalance).toBe('990.0000');
    expect(usdRow.baseBalance).toBe('56925.0000');
    expect(pos.body.byCurrency.map((c: { currency: string }) => c.currency)).toEqual(
      expect.arrayContaining(['PHP', 'USD']),
    );
    await expectIntegrity();
  });

  // ------------------------------------------------------------ payment files

  it('payment file: generated from posted vendor payments, downloadable with a checksum trailer, then transmitted and rejected by the bank', async () => {
    const { rows } = await pool.query<{ id: string; document_number: string; amount: string }>(
      `select id, document_number, amount from vendor_payments where company_id = $1 and reference = 'PAY-DPI-0781' and status = 'POSTED'`,
      [companyId],
    );
    expect(rows).toHaveLength(1);
    const payment = rows[0]!;
    // Only the payment-file manager may generate files.
    await as(accountant, http().post('/api/v1/treasury/payment-files'))
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        format: 'PESONET_CSV',
        paymentIds: [payment.id],
      })
      .expect(403);
    const file = await as(finance, http().post('/api/v1/treasury/payment-files'))
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        format: 'PESONET_CSV',
        paymentIds: [payment.id],
        valueDate: TODAY,
        description: 'DPI settlement',
      })
      .expect(201);
    expect(file.body.status).toBe('GENERATED');
    expect(file.body.paymentCount).toBe(1);
    expect(file.body.totalAmount).toBe(payment.amount);
    expect(file.body.lines[0].paymentNumber).toBe(payment.document_number);
    expect(file.body.lines[0].beneficiaryAccountMasked).toMatch(/^\*+\d{4}$/);
    expect(file.body.content).toBeUndefined(); // content is only served by the download
    const download = await as(
      finance,
      http().get(`/api/v1/treasury/payment-files/${file.body.id}/download`),
    ).expect(200);
    expect(download.headers['content-disposition']).toContain(`${file.body.documentNumber}.csv`);
    const text = download.text;
    expect(text.startsWith(`H,${file.body.documentNumber},${TODAY.replace(/-/g, '')},PHP,`)).toBe(
      true,
    );
    expect(text).toContain(`,${payment.document_number}`);
    expect(text.trim().split('\r\n').pop()!.startsWith('T,000001,')).toBe(true);
    expect(text.trim().split('\r\n').pop()!).toMatch(/,[0-9a-f]{64}$/); // trailer checksum of the body
    expect(createHash('sha256').update(text).digest('hex')).toBe(file.body.checksum);
    // A payment already in a live file cannot go into another one.
    const dup = await as(finance, http().post('/api/v1/treasury/payment-files'))
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        format: 'ISO20022_PAIN001',
        paymentIds: [payment.id],
      })
      .expect(422);
    expect(dup.body.code).toBe('VALIDATION_FAILED');
    const transmitted = await as(
      finance,
      http().post(`/api/v1/treasury/payment-files/${file.body.id}/status`),
    )
      .send({ status: 'TRANSMITTED', bankReference: 'BDO-BATCH-260914-07' })
      .expect(201);
    expect(transmitted.body.status).toBe('TRANSMITTED');
    expect(transmitted.body.transmittedAt).toBeTruthy();
    const rejected = await as(
      finance,
      http().post(`/api/v1/treasury/payment-files/${file.body.id}/status`),
    )
      .send({ status: 'REJECTED', note: 'Beneficiary account closed' })
      .expect(201);
    expect(rejected.body.status).toBe('REJECTED');
    // A rejected file releases its payments for a new file.
    const retry = await as(finance, http().post('/api/v1/treasury/payment-files'))
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        format: 'ISO20022_PAIN001',
        paymentIds: [payment.id],
        valueDate: TODAY,
      })
      .expect(201);
    expect(retry.body.format).toBe('ISO20022_PAIN001');
    const xml = await as(
      finance,
      http().get(`/api/v1/treasury/payment-files/${retry.body.id}/download`),
    ).expect(200);
    expect(xml.headers['content-type']).toContain('xml');
    expect(xml.text).toContain('<CstmrCdtTrfInitn>');
    expect(xml.text).toContain(`<MsgId>${retry.body.documentNumber}</MsgId>`);
    // Payments from another bank account cannot be filed against this one.
    const { rows: cashPayments } = await pool.query<{ id: string }>(
      `select id from vendor_payments where company_id = $1 and status = 'POSTED' and cash_account_id <> $2 limit 1`,
      [companyId, bank['BDO-MAIN']!.glAccountId],
    );
    if (cashPayments[0])
      await as(finance, http().post('/api/v1/treasury/payment-files'))
        .send({
          bankAccountId: bank['BDO-MAIN']!.id,
          format: 'PESONET_CSV',
          paymentIds: [cashPayments[0].id],
        })
        .expect(422);
    const rejectedNote = await as(admin, http().get('/api/v1/notifications?limit=50')).expect(200);
    expect(
      (rejectedNote.body.items ?? rejectedNote.body).some(
        (n: { eventType: string }) => n.eventType === 'PAYMENT_FILE_REJECTED',
      ),
    ).toBe(true);
    await expectIntegrity();
  });

  it('approval workflows gate payment-file transmission, petty cash approval and vendor onboarding', async () => {
    // Rules: any payment file, vouchers from 1,000, every new vendor - one finance step each.
    const rule = (documentType: string, name: string, minAmount?: string) =>
      as(admin, http().post('/api/v1/approval-workflows'))
        .send({
          documentType,
          name,
          ...(minAmount ? { minAmount } : {}),
          steps: [
            {
              name: 'Finance review',
              requiredPermission: 'bank-transfer.approve',
              minApprovers: 1,
            },
          ],
        })
        .expect(201);
    const rules = [
      await rule('PAYMENT_FILE', 'Payment files'),
      await rule('PETTY_CASH_VOUCHER', 'Large vouchers', '1000'),
      await rule('VENDOR', 'Vendor onboarding'),
    ];
    // Four-eyes: the requester never decides, so the admin signs the finance-generated file.
    const decide = async (id: string, who = admin) => {
      const res = await as(who, http().post(`/api/v1/approvals/${id}/decide`)).send({
        decision: 'APPROVE',
      });
      if (res.status !== 201) throw new Error('decide: ' + JSON.stringify(res.body));
    };
    const requestFor = async (documentType: string, documentId: string) => {
      const list = await as(
        admin,
        http().get(`/api/v1/approvals?documentType=${documentType}`),
      ).expect(200);
      return list.body.items.find((r: { documentId: string }) => r.documentId === documentId);
    };

    // Payment file: generated with a pending request; transmission waits for the decision.
    // Reuse the seeded DPI payment: cancel the live file the previous test left, then file it again.
    const { rows: dpi } = await pool.query(
      `select id from vendor_payments where company_id = $1 and reference = 'PAY-DPI-0781' and status = 'POSTED'`,
      [companyId],
    );
    const { rows: live } = await pool.query(
      `select f.id from payment_files f join payment_file_lines l on l.file_id = f.id
        where l.payment_id = $1 and f.status = 'GENERATED'`,
      [dpi[0]!.id],
    );
    for (const f of live)
      await as(finance, http().post(`/api/v1/treasury/payment-files/${f.id}/status`))
        .send({ status: 'CANCELLED', note: 'refiled under workflow' })
        .expect(201);
    const unfiled = dpi;
    const file = await as(finance, http().post('/api/v1/treasury/payment-files'))
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        format: 'PESONET_CSV',
        paymentIds: [unfiled[0]!.id],
        valueDate: TODAY,
      })
      .expect(201);
    const pendingFile = await requestFor('PAYMENT_FILE', file.body.id);
    expect(pendingFile?.status).toBe('PENDING');
    const blocked = await as(
      finance,
      http().post(`/api/v1/treasury/payment-files/${file.body.id}/status`),
    )
      .send({ status: 'TRANSMITTED' })
      .expect(422);
    expect(blocked.body.code).toBe('APPROVAL_REQUIRED');
    await decide(pendingFile.id);
    await as(finance, http().post(`/api/v1/treasury/payment-files/${file.body.id}/status`))
      .send({ status: 'TRANSMITTED', bankReference: 'BDO-BATCH-WF-1' })
      .expect(201);

    // Petty cash: a 1,500 voucher needs the workflow (submit opens it); a 200 one does not.
    const funds = await as(admin, http().get('/api/v1/treasury/petty-cash/funds')).expect(200);
    const big = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId: funds.body[0].id,
        voucherDate: TODAY,
        payee: 'Grab',
        description: 'Client visits',
        lines: [{ description: 'Transport', accountId: acc['6400'], amount: '1500' }],
      })
      .expect(201);
    const early = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${big.body.id}/approve`),
    ).expect(422);
    expect(early.body.code).toBe('APPROVAL_REQUIRED');
    await as(
      accountant,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${big.body.id}/submit`),
    ).expect(201);
    const pendingVoucher = await requestFor('PETTY_CASH_VOUCHER', big.body.id);
    expect(pendingVoucher?.status).toBe('PENDING');
    await decide(pendingVoucher.id);
    const approved = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${big.body.id}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    const small = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId: funds.body[0].id,
        voucherDate: TODAY,
        payee: 'Mercury Drug',
        description: 'First aid',
        lines: [{ description: 'Supplies', accountId: acc['6400'], amount: '200' }],
      })
      .expect(201);
    await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${small.body.id}/approve`),
    ).expect(201);

    // Vendor onboarding: creation opens the request; approval waits for it, rejection cancels it.
    await as(admin, http().patch('/api/v1/ap-settings'))
      .send({ requireVendorApproval: true })
      .expect(200);
    const vendor = await as(accountant, http().post('/api/v1/vendors'))
      .send({ code: 'VEND-WF', name: 'Workflow Supplies Inc' })
      .expect(201);
    expect(vendor.body.vendorStatus).toBe('PENDING');
    const pendingVendor = await requestFor('VENDOR', vendor.body.id);
    expect(pendingVendor?.status).toBe('PENDING');
    const tooSoon = await as(finance, http().post(`/api/v1/vendors/${vendor.body.id}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(422);
    expect(tooSoon.body.code).toBe('APPROVAL_REQUIRED');
    await decide(pendingVendor.id);
    const onboarded = await as(finance, http().post(`/api/v1/vendors/${vendor.body.id}/approve`))
      .send({ decision: 'APPROVE' })
      .expect(201);
    expect(onboarded.body.vendorStatus).toBe('APPROVED');
    await as(admin, http().patch('/api/v1/ap-settings'))
      .send({ requireVendorApproval: false })
      .expect(200);
    for (const r of rules)
      await as(admin, http().patch(`/api/v1/approval-workflows/${r.body.id}`))
        .send({ status: 'INACTIVE' })
        .expect(200);
  });

  // --------------------------------------------------------------- petty cash

  let fundId: string;
  let voucherId: string;

  it('petty cash: voucher draft -> approve -> post debits expenses and credits the fund; the fund is the GL', async () => {
    const funds = await as(admin, http().get('/api/v1/treasury/petty-cash/funds')).expect(200);
    fundId = funds.body[0].id;
    const created = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId,
        voucherDate: TODAY,
        payee: 'LBC Express',
        description: 'Courier - BIR filings',
        receiptReference: 'LBC-77120',
        lines: [
          { description: 'Courier fees', accountId: acc['6900'] ?? acc['6400'], amount: '1250' },
          { description: 'Packaging', accountId: acc['6400'], amount: '250' },
        ],
      })
      .expect(201);
    voucherId = created.body.id;
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.total).toBe('1500.0000');
    expect(created.body.documentNumber).toMatch(/^PCV-/);
    expect(created.body.lines).toHaveLength(2);
    // Posting a draft is refused; the accountant cannot approve or post.
    await as(finance, http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/post`)).expect(
      422,
    );
    await as(
      accountant,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/approve`),
    ).expect(403);
    const approved = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/approve`),
    ).expect(201);
    expect(approved.body.status).toBe('APPROVED');
    await as(
      accountant,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/post`),
    ).expect(403);
    const posted = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/post`),
    ).expect(201);
    expect(posted.body.status).toBe('POSTED');
    const entry = await journalOf(posted.body.journalEntryId);
    expect(entry.sourceType).toBe('PETTY_CASH_VOUCHER');
    expect(lineOn(entry, '6400').debit).toBe('250.0000');
    expect(lineOn(entry, '1120').credit).toBe('1500.0000');
    const fund = await as(admin, http().get(`/api/v1/treasury/petty-cash/funds/${fundId}`)).expect(
      200,
    );
    expect(fund.body.unreplenished).toBe('6550.0000'); // 5,050 seeded + 1,500
    expect(fund.body.expectedCashOnHand).toBe('13450.0000');
    expect(fund.body.bookBalance).toBe('13450.0000');
    expect(await glBalance('1120')).toBe('13450.0000');
    // A voucher larger than what is left in the box is refused.
    const tooBig = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId,
        voucherDate: TODAY,
        payee: 'x',
        lines: [{ description: 'y', accountId: acc['6400'], amount: '13500' }],
      })
      .expect(422);
    expect(tooBig.body.code).toBe('ALLOCATION_EXCEEDS_BALANCE');
    await expectIntegrity();
  });

  it('petty cash: replenishment is a bank withdrawal to the fund that restores the imprest and marks vouchers reimbursed', async () => {
    const bdoBefore = await glBalance('1130');
    await as(accountant, http().post(`/api/v1/treasury/petty-cash/funds/${fundId}/replenish`))
      .send({ bankAccountId: bank['BDO-MAIN']!.id, replenishmentDate: TODAY })
      .expect(403);
    const fund = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/funds/${fundId}/replenish`),
    )
      .send({
        bankAccountId: bank['BDO-MAIN']!.id,
        replenishmentDate: TODAY,
        reference: 'PC-REPL-09',
      })
      .expect(201);
    expect(fund.body.unreplenished).toBe('0.0000');
    expect(fund.body.expectedCashOnHand).toBe('20000.0000');
    expect(fund.body.bookBalance).toBe('20000.0000');
    expect(fund.body.lastReplenishedAt).toBe(TODAY);
    expect(Number(await glBalance('1130'))).toBeCloseTo(Number(bdoBefore) - 6550, 2);
    const voucher = await as(
      admin,
      http().get(`/api/v1/treasury/petty-cash/vouchers/${voucherId}`),
    ).expect(200);
    expect(voucher.body.replenishmentId).toBeTruthy();
    // Nothing left to replenish.
    const nothing = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/funds/${fundId}/replenish`),
    )
      .send({ bankAccountId: bank['BDO-MAIN']!.id, replenishmentDate: TODAY })
      .expect(422);
    expect(nothing.body.code).toBe('VALIDATION_FAILED');
    // A reimbursed voucher can no longer be voided; a fresh posted one reverses cleanly.
    await as(finance, http().post(`/api/v1/treasury/petty-cash/vouchers/${voucherId}/void`))
      .send({ reason: 'x' })
      .expect(422);
    const fresh = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId,
        voucherDate: TODAY,
        payee: 'Cashier',
        lines: [{ description: 'Cleaning', accountId: acc['6400'], amount: '600' }],
      })
      .expect(201);
    await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${fresh.body.id}/approve`),
    ).expect(201);
    await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${fresh.body.id}/post`),
    ).expect(201);
    expect(await glBalance('1120')).toBe('19400.0000');
    const voided = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${fresh.body.id}/void`),
    )
      .send({ reason: 'Duplicate of an expense claim', voidDate: TODAY })
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    const reversal = await journalOf(voided.body.reversalJournalEntryId);
    expect(reversal.sourceType).toBe('PETTY_CASH_VOUCHER_VOID');
    expect(lineOn(reversal, '1120').debit).toBe('600.0000');
    expect(await glBalance('1120')).toBe('20000.0000');
    await expectIntegrity();
  });

  it('petty cash: funds are created on a dedicated cash account, and the custodian is nudged when the box runs low', async () => {
    const gl = await as(admin, http().post('/api/v1/accounts'))
      .send({
        code: '1125',
        name: 'Petty Cash - Warehouse',
        type: 'ASSET',
        subtype: 'CASH',
        parentId: acc['1100'],
      })
      .expect(201);
    const { rows } = await pool.query<{ id: string }>(`select id from users where email = $1`, [
      ACCOUNTANT.email,
    ]);
    await as(accountant, http().post('/api/v1/treasury/petty-cash/funds'))
      .send({
        code: 'PCF-WH',
        name: 'Warehouse petty cash',
        glAccountId: gl.body.id,
        imprestAmount: '5000',
        custodianId: rows[0]!.id,
      })
      .expect(403); // the accountant operates the fund but does not configure it
    const fund = await as(admin, http().post('/api/v1/treasury/petty-cash/funds'))
      .send({
        code: 'PCF-WH',
        name: 'Warehouse petty cash',
        glAccountId: gl.body.id,
        imprestAmount: '5000',
        custodianId: rows[0]!.id,
        replenishAtPercent: '50',
      })
      .expect(201);
    expect(fund.body.bookBalance).toBe('0.0000');
    // The same GL account cannot back two funds.
    await as(admin, http().post('/api/v1/treasury/petty-cash/funds'))
      .send({
        code: 'PCF-WH2',
        name: 'Dup',
        glAccountId: gl.body.id,
        imprestAmount: '1000',
        custodianId: rows[0]!.id,
      })
      .expect(422);
    // Fund it from the bank (Dr 1125 / Cr 1130) with the replenishment endpoint: the full imprest is due.
    const funded = await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/funds/${fund.body.id}/replenish`),
    )
      .send({ bankAccountId: bank['BDO-MAIN']!.id, replenishmentDate: TODAY, amount: '5000' })
      .expect(201);
    expect(funded.body.bookBalance).toBe('5000.0000');
    // Spend past the 50% line: the custodian is notified.
    const v = await as(accountant, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId: fund.body.id,
        voucherDate: TODAY,
        payee: 'Hardware store',
        lines: [{ description: 'Pallet straps', accountId: acc['6400'], amount: '2600' }],
      })
      .expect(201);
    await as(
      finance,
      http().post(`/api/v1/treasury/petty-cash/vouchers/${v.body.id}/approve`),
    ).expect(201);
    await as(finance, http().post(`/api/v1/treasury/petty-cash/vouchers/${v.body.id}/post`)).expect(
      201,
    );
    const after = await as(
      admin,
      http().get(`/api/v1/treasury/petty-cash/funds/${fund.body.id}`),
    ).expect(200);
    expect(after.body.replenishmentDue).toBe(true);
    const notes = await as(accountant, http().get('/api/v1/notifications?limit=50')).expect(200);
    expect(
      (notes.body.items ?? notes.body).some(
        (n: { eventType: string }) => n.eventType === 'PETTY_CASH_LOW',
      ),
    ).toBe(true);
    const vouchers = await as(
      admin,
      http().get(`/api/v1/treasury/petty-cash/vouchers?fundId=${fund.body.id}`),
    ).expect(200);
    expect(vouchers.body.total).toBe(1);
    await expectIntegrity();
  });

  // ------------------------------------------------ forecast items / settings

  it('forecast items and settings are data: planned flows move the forecast, scenarios and floors come from settings', async () => {
    const before = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=30&granularity=DAY`),
    ).expect(200);
    await as(viewer, http().post('/api/v1/treasury/forecast/items'))
      .send({ name: 'x', direction: 'OUTFLOW', amount: '1', frequency: 'ONCE', startDate: TODAY })
      .expect(403);
    const item = await as(accountant, http().post('/api/v1/treasury/forecast/items'))
      .send({
        name: 'Insurance premium',
        direction: 'OUTFLOW',
        amount: '48000',
        frequency: 'ONCE',
        startDate: '2026-09-20',
        category: 'Insurance',
      })
      .expect(201);
    const after = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=30&granularity=DAY`),
    ).expect(200);
    expect(Number(after.body.totals.outflows) - Number(before.body.totals.outflows)).toBeCloseTo(
      48000,
      2,
    );
    const day = after.body.buckets.find((b: { start: string }) => b.start === '2026-09-20');
    expect(Number(day.bySource['OUTFLOW:PLANNED'] ?? 0)).toBeGreaterThanOrEqual(48000);
    const inactive = await as(
      accountant,
      http().patch(`/api/v1/treasury/forecast/items/${item.body.id}`),
    )
      .send({ active: false })
      .expect(200);
    expect(inactive.body.active).toBe(false);
    const reverted = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=30&granularity=DAY`),
    ).expect(200);
    expect(reverted.body.totals.outflows).toBe(before.body.totals.outflows);
    await as(accountant, http().delete(`/api/v1/treasury/forecast/items/${item.body.id}`)).expect(
      204,
    );
    const items = await as(
      admin,
      http().get('/api/v1/treasury/forecast/items?activeOnly=true'),
    ).expect(200);
    expect(items.body.items.some((i: { id: string }) => i.id === item.body.id)).toBe(false);

    // Settings: only treasury-settings.manage may change them; the floor follows minimumDaysCashOnHand.
    await as(accountant, http().put('/api/v1/treasury/settings'))
      .send({ minimumDaysCashOnHand: 60 })
      .expect(403);
    const settings = await as(admin, http().put('/api/v1/treasury/settings'))
      .send({
        minimumDaysCashOnHand: 0,
        scenarios: {
          PESSIMISTIC: { inflowFactor: '0.50', outflowFactor: '1.25', inflowDelayDays: 30 },
        },
      })
      .expect(200);
    expect(settings.body.minimumDaysCashOnHand).toBe(0);
    expect(settings.body.scenarios.PESSIMISTIC.inflowFactor).toBe('0.50');
    expect(settings.body.scenarios.BASE.inflowFactor).toBe('1');
    const floor = await as(
      admin,
      http().get(`/api/v1/treasury/forecast?asOf=${TODAY}&horizonDays=30`),
    ).expect(200);
    expect(floor.body.minimumCash).toBe('350000.0000'); // account minimums alone
    await as(admin, http().put('/api/v1/treasury/settings'))
      .send({ minimumDaysCashOnHand: 30 })
      .expect(200);

    // Bank account profile: limits and the single default payments account.
    const profile = await as(
      admin,
      http().put(`/api/v1/treasury/bank-accounts/${bank['BPI-SAVE']!.id}/profile`),
    )
      .send({ minimumBalance: '500000', isDefaultPayments: true })
      .expect(200);
    expect(profile.body.minimumBalance).toBe('500000.0000');
    expect(profile.body.isDefaultPayments).toBe(true);
    const bdoProfile = await as(
      admin,
      http().get(`/api/v1/treasury/bank-accounts/${bank['BDO-MAIN']!.id}/profile`),
    ).expect(200);
    expect(bdoProfile.body.isDefaultPayments).toBe(false);
    const pos = await as(admin, http().get(`/api/v1/treasury/position?asOf=${TODAY}`)).expect(200);
    const bpi = pos.body.accounts.find((a: { code: string }) => a.code === 'BPI-SAVE');
    expect(bpi.belowMinimum).toBe(true);
    expect(pos.body.totals.belowMinimum).toBe(1);
  });

  // ---------------------------------------------------------- sweep / controls

  it('the daily sweep raises deduped alerts for accounts below minimum, forecast shortfalls and unsettled transfers, and snapshots the forecast', async () => {
    await as(accountant, http().post(`/api/v1/treasury/sweep?asOf=${TODAY}`)).expect(403);
    const run = await as(admin, http().post(`/api/v1/treasury/sweep?asOf=${TODAY}`)).expect(201);
    expect(run.body.belowMinimum).toBe(1);
    expect(run.body.unsettledTransfers).toBe(1);
    expect(run.body.snapshotId).toBeTruthy();
    const again = await as(admin, http().post(`/api/v1/treasury/sweep?asOf=${TODAY}`)).expect(201);
    expect(again.body.belowMinimum).toBe(1);
    const notes = await as(admin, http().get('/api/v1/notifications?limit=100')).expect(200);
    const list = notes.body.items ?? notes.body;
    expect(
      list.filter((n: { eventType: string }) => n.eventType === 'CASH_BELOW_MINIMUM'),
    ).toHaveLength(1);
    expect(list.some((n: { eventType: string }) => n.eventType === 'BANK_TRANSFER_UNSETTLED')).toBe(
      true,
    );
    const events = await pool.query<{ event_type: string }>(
      `select distinct event_type from integration_events where company_id = $1 and (event_type like 'cash.%' or event_type like 'bank_transfer.%' or event_type like 'petty_cash.%' or event_type like 'payment_file.%')`,
      [companyId],
    );
    const types = events.rows.map((r) => r.event_type);
    for (const t of [
      'bank_transfer.approved',
      'bank_transfer.sent',
      'bank_transfer.settled',
      'payment_file.generated',
      'payment_file.rejected',
      'petty_cash.voucher_posted',
      'petty_cash.replenished',
      'cash.below_minimum',
    ])
      expect(types).toContain(t);
    // Restore the profile so later suites see the seeded limits.
    await as(admin, http().put(`/api/v1/treasury/bank-accounts/${bank['BPI-SAVE']!.id}/profile`))
      .send({ minimumBalance: '100000', isDefaultPayments: false })
      .expect(200);
    await as(admin, http().put(`/api/v1/treasury/bank-accounts/${bank['BDO-MAIN']!.id}/profile`))
      .send({ isDefaultPayments: true })
      .expect(200);
  });

  it('controls: viewers only read, treasury data never leaks across companies and the audit trail records every step', async () => {
    await as(viewer, http().get('/api/v1/treasury/dashboard')).expect(200);
    await as(viewer, http().post('/api/v1/treasury/transfers'))
      .send({
        fromBankAccountId: bank['BDO-MAIN']!.id,
        toBankAccountId: bank['BPI-SAVE']!.id,
        transferDate: TODAY,
        amount: '1',
      })
      .expect(403);
    await as(viewer, http().post('/api/v1/treasury/petty-cash/vouchers'))
      .send({
        fundId,
        voucherDate: TODAY,
        payee: 'x',
        lines: [{ description: 'y', accountId: acc['6400'], amount: '1' }],
      })
      .expect(403);
    await as(
      viewer,
      http().get(
        `/api/v1/treasury/payment-files/${(await as(admin, http().get('/api/v1/treasury/payment-files')).expect(200)).body.items[0].id}/download`,
      ),
    ).expect(403);
    await as(viewer, http().put('/api/v1/treasury/settings'))
      .send({ forecastHorizonDays: 30 })
      .expect(403);
    await as(admin, http().get(`/api/v1/treasury/transfers/${transferId}`), otherCompanyId).expect(
      404,
    );
    await as(
      admin,
      http().get(`/api/v1/treasury/petty-cash/funds/${fundId}`),
      otherCompanyId,
    ).expect(404);
    const otherPos = await as(
      admin,
      http().get('/api/v1/treasury/position'),
      otherCompanyId,
    ).expect(200);
    expect(otherPos.body.totals.inTransit).toBe('0.0000');
    const audit = await as(
      admin,
      http().get(`/api/v1/audit-logs?entityType=BankTransfer&entityId=${transferId}`),
    ).expect(200);
    const actions = (audit.body.items ?? audit.body).map((a: { action: string }) => a.action);
    for (const a of ['CREATE', 'SUBMIT', 'APPROVE', 'POST']) expect(actions).toContain(a);
    const voucherAudit = await as(
      admin,
      http().get(`/api/v1/audit-logs?entityType=PettyCashVoucher&entityId=${voucherId}`),
    ).expect(200);
    expect(
      (voucherAudit.body.items ?? voucherAudit.body).map((a: { action: string }) => a.action),
    ).toEqual(expect.arrayContaining(['CREATE', 'APPROVE', 'POST']));
    // The accounting integrity checker still sees a balanced, consistent ledger after everything above.
    const tb = await as(
      admin,
      http().get(`/api/v1/reports/trial-balance?from=2026-01-01&to=${TODAY}`),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
    await expectIntegrity();
  });
});
