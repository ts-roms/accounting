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
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Phase 6 - Fixed assets & banking. Asset lifecycle postings (capitalise,
 * depreciate, impair, revalue, dispose) tie the register to the asset and
 * accumulated depreciation accounts; bank statement import, matching,
 * manual review and reconciliation against the bank GL account.
 */
describe('Fixed assets & banking (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req.set('Cookie', admin).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const journalLine = async (journalEntryId: string, code: string) => {
    const je = await as(http().get(`/api/v1/journal-entries/${journalEntryId}`)).expect(200);
    return je.body.lines.filter((l: { accountId: string }) => l.accountId === acc[code]);
  };
  const balance = async (code: string) => {
    const tb = await as(
      http().get(`/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31&includeZero=true`),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
    const row = tb.body.rows.find((r: { accountId: string }) => r.accountId === acc[code]);
    return row
      ? { debit: row.closingDebit, credit: row.closingCredit }
      : { debit: '0.0000', credit: '0.0000' };
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
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------ fixed assets

  let categoryId: string;
  let assetId: string;
  let periods: Array<{
    id: string;
    name: string;
    startDate: string;
    endDate: string;
    status: string;
  }>;

  it('registers an asset in a category; drafts have no ledger effect and can be edited', async () => {
    const categories = await as(http().get('/api/v1/asset-categories')).expect(200);
    categoryId = categories.body.find((c: { code: string }) => c.code === 'IT').id;
    const years = await as(http().get('/api/v1/fiscal-years')).expect(200);
    periods = years.body[0].periods;

    const before = await balance('1510');
    const res = await as(http().post('/api/v1/fixed-assets'))
      .send({
        name: 'Server rack',
        categoryId,
        acquisitionDate: '2026-01-15',
        acquisitionCost: '120000',
        salvageValue: '0',
        location: 'HQ server room',
        reference: 'PO-77',
      })
      .expect(201);
    assetId = res.body.id;
    expect(res.body.assetNumber).toMatch(/^FA-2026-\d{6}$/);
    expect(res.body.status).toBe('DRAFT');
    expect(res.body.usefulLifeMonths).toBe(36); // from the category
    expect(res.body.depreciationMethod).toBe('STRAIGHT_LINE');
    expect(res.body.bookValue).toBe('120000.0000');
    expect(await balance('1510')).toEqual(before);

    const bad = await as(http().post('/api/v1/fixed-assets'))
      .send({
        name: 'x',
        categoryId,
        acquisitionDate: '2026-01-15',
        acquisitionCost: '1000',
        salvageValue: '1000',
      })
      .expect(422);
    expect(bad.body.code).toBe('VALIDATION_FAILED');
    const edited = await as(http().patch(`/api/v1/fixed-assets/${assetId}`))
      .send({ usefulLifeMonths: 24 })
      .expect(200);
    expect(edited.body.usefulLifeMonths).toBe(24);
    expect(edited.body.nextDepreciation).toBe('0.0000'); // not active yet
  });

  it('capitalisation posts Dr asset cost / Cr clearing; cost fields lock afterwards', async () => {
    const cap = await as(http().post(`/api/v1/fixed-assets/${assetId}/capitalize`))
      .send({ creditAccountId: acc['1130'] })
      .expect(201);
    expect(cap.body.status).toBe('ACTIVE');
    expect((await journalLine(cap.body.capitalizationJournalEntryId, '1510'))[0].debit).toBe(
      '120000.0000',
    );
    expect((await journalLine(cap.body.capitalizationJournalEntryId, '1130'))[0].credit).toBe(
      '120000.0000',
    );
    expect(cap.body.nextDepreciation).toBe('5000.0000'); // 120,000 / 24
    expect(cap.body.remainingSchedule).toHaveLength(24);
    const locked = await as(http().patch(`/api/v1/fixed-assets/${assetId}`))
      .send({ acquisitionCost: '1' })
      .expect(422);
    expect(locked.body.code).toBe('DOCUMENT_INVALID_STATE');
    const again = await as(http().post(`/api/v1/fixed-assets/${assetId}/capitalize`))
      .send({})
      .expect(422);
    expect(again.body.code).toBe('DOCUMENT_INVALID_STATE');
  });

  let runId: string;

  it('depreciation run: preview, post (Dr expense / Cr accumulated), period order and idempotency', async () => {
    const january = periods.find((p) => p.startDate === '2026-01-01')!;
    const february = periods.find((p) => p.startDate === '2026-02-01')!;
    const preview = await as(
      http().get(`/api/v1/depreciation-runs/preview?fiscalPeriodId=${january.id}`),
    ).expect(200);
    expect(preview.body).toHaveLength(1);
    expect(preview.body[0].amount).toBe('5000.0000');

    const run = await as(http().post('/api/v1/depreciation-runs'))
      .send({ fiscalPeriodId: january.id })
      .expect(201);
    runId = run.body.id;
    expect(run.body.runNumber).toMatch(/^DEP-2026-\d{6}$/);
    expect(run.body.status).toBe('DRAFT');
    expect(run.body.totalAmount).toBe('5000.0000');
    const second = await as(http().post('/api/v1/depreciation-runs'))
      .send({ fiscalPeriodId: february.id })
      .expect(422);
    expect(second.body.code).toBe('DOCUMENT_INVALID_STATE'); // draft pending

    const accumBefore = await balance('1520');
    const posted = await as(http().post(`/api/v1/depreciation-runs/${runId}/post`)).expect(201);
    expect(posted.body.status).toBe('POSTED');
    expect((await journalLine(posted.body.journalEntryId, '6500'))[0].debit).toBe('5000.0000');
    expect((await journalLine(posted.body.journalEntryId, '1520'))[0].credit).toBe('5000.0000');
    const accumAfter = await balance('1520');
    expect(Number(accumAfter.credit) - Number(accumBefore.credit)).toBe(5000);
    const asset = await as(http().get(`/api/v1/fixed-assets/${assetId}`)).expect(200);
    expect(asset.body.accumulatedDepreciation).toBe('5000.0000');
    expect(asset.body.bookValue).toBe('115000.0000');
    expect(asset.body.depreciatedMonths).toBe(1);
    // Same period again is refused; posting again is a no-op.
    expect(
      (
        await as(http().post('/api/v1/depreciation-runs'))
          .send({ fiscalPeriodId: january.id })
          .expect(422)
      ).body.code,
    ).toBe('DOCUMENT_INVALID_STATE');
    expect(
      (await as(http().post(`/api/v1/depreciation-runs/${runId}/post`)).expect(201)).body.status,
    ).toBe('POSTED');
  });

  it('impairment reduces the book value and spreads the rest over the remaining life; revaluation credits surplus', async () => {
    const impaired = await as(http().post(`/api/v1/fixed-assets/${assetId}/impair`))
      .send({ eventDate: '2026-02-10', amount: '23000', notes: 'Water damage' })
      .expect(201);
    expect(impaired.body.bookValue).toBe('92000.0000');
    expect(impaired.body.nextDepreciation).toBe('4000.0000'); // 92,000 / 23 remaining months
    const ev = impaired.body.events.find(
      (e: { eventType: string }) => e.eventType === 'IMPAIRMENT',
    );
    expect((await journalLine(ev.journalEntryId, '6950'))[0].debit).toBe('23000.0000');
    expect((await journalLine(ev.journalEntryId, '1520'))[0].credit).toBe('23000.0000');

    const revalued = await as(http().post(`/api/v1/fixed-assets/${assetId}/revalue`))
      .send({ eventDate: '2026-02-20', newBookValue: '100000' })
      .expect(201);
    expect(revalued.body.cost).toBe('128000.0000');
    expect(revalued.body.bookValue).toBe('100000.0000');
    const rev = revalued.body.events.find(
      (e: { eventType: string }) => e.eventType === 'REVALUATION',
    );
    expect((await journalLine(rev.journalEntryId, '3300'))[0].credit).toBe('8000.0000');
    const down = await as(http().post(`/api/v1/fixed-assets/${assetId}/revalue`))
      .send({ eventDate: '2026-02-21', newBookValue: '90000' })
      .expect(422);
    expect(down.body.code).toBe('VALIDATION_FAILED');
  });

  it('disposal releases cost and accumulated depreciation and books the gain / loss; asset stops depreciating', async () => {
    const transferred = await as(http().post(`/api/v1/fixed-assets/${assetId}/transfer`))
      .send({ eventDate: '2026-03-01', location: 'Cebu office' })
      .expect(201);
    expect(transferred.body.location).toBe('Cebu office');
    const disposed = await as(http().post(`/api/v1/fixed-assets/${assetId}/dispose`))
      .send({ eventDate: '2026-03-15', proceeds: '90000', proceedsAccountId: acc['1130'] })
      .expect(201);
    expect(disposed.body.status).toBe('DISPOSED');
    expect(disposed.body.disposalGainLoss).toBe('-10000.0000'); // 90,000 - 100,000 book value
    const je = disposed.body.disposalJournalEntryId;
    expect((await journalLine(je, '1510'))[0].credit).toBe('128000.0000');
    expect((await journalLine(je, '1520'))[0].debit).toBe('28000.0000');
    expect((await journalLine(je, '1130'))[0].debit).toBe('90000.0000');
    expect((await journalLine(je, '4920'))[0].debit).toBe('10000.0000');
    const february = periods.find((p) => p.startDate === '2026-02-01')!;
    const preview = await as(
      http().get(`/api/v1/depreciation-runs/preview?fiscalPeriodId=${february.id}`),
    ).expect(200);
    expect(preview.body).toHaveLength(0);
    const noMore = await as(http().post(`/api/v1/fixed-assets/${assetId}/impair`))
      .send({ eventDate: '2026-03-16', amount: '1' })
      .expect(422);
    expect(noMore.body.code).toBe('DOCUMENT_INVALID_STATE');
  });

  it('a posted run can be reversed (latest only) and the register is restored', async () => {
    const vehicle = await as(http().post('/api/v1/fixed-assets'))
      .send({
        name: 'Delivery van',
        categoryId: (await as(http().get('/api/v1/asset-categories'))).body.find(
          (c: { code: string }) => c.code === 'VEH',
        ).id,
        acquisitionDate: '2026-01-05',
        acquisitionCost: '600000',
        salvageValue: '60000',
      })
      .expect(201);
    await as(http().post(`/api/v1/fixed-assets/${vehicle.body.id}/capitalize`))
      .send({})
      .expect(201); // clearing account by default
    const february = periods.find((p) => p.startDate === '2026-02-01')!;
    const run = await as(http().post('/api/v1/depreciation-runs'))
      .send({ fiscalPeriodId: february.id })
      .expect(201);
    const posted = await as(http().post(`/api/v1/depreciation-runs/${run.body.id}/post`)).expect(
      201,
    );
    expect(posted.body.lines[0].amount).toBe('20000.0000'); // 600,000 x 40% / 12
    const reversed = await as(http().post(`/api/v1/depreciation-runs/${run.body.id}/reverse`))
      .send({ reason: 'Wrong rate' })
      .expect(201);
    expect(reversed.body.status).toBe('REVERSED');
    const asset = await as(http().get(`/api/v1/fixed-assets/${vehicle.body.id}`)).expect(200);
    expect(asset.body.accumulatedDepreciation).toBe('0.0000');
    expect(asset.body.depreciatedMonths).toBe(0);
    await balance('1520'); // trial balance still balanced
  });

  // ----------------------------------------------------------------- banking
  // A fresh GL account keeps the seeded history out of the reconciliation.

  let bdoId: string;
  let bankId: string;
  let statementId: string;
  let feeLineId: string;
  let exceptionLineId: string;

  it('bank accounts bind to a cash / bank GL account and report the ledger balance', async () => {
    const accounts = await as(http().get('/api/v1/bank-accounts')).expect(200);
    const bdo = accounts.body.find((b: { code: string }) => b.code === 'BDO-MAIN');
    bdoId = bdo.id;
    expect(bdo.glAccountCode).toBe('1130');
    expect(Number(bdo.ledgerBalance)).toBeGreaterThan(0);
    const gl = await as(http().post('/api/v1/accounts'))
      .send({
        code: '1140',
        name: 'Cash in Bank - BPI',
        type: 'ASSET',
        subtype: 'BANK',
        parentId: acc['1100'],
      })
      .expect(201);
    acc['1140'] = gl.body.id;
    const bad = await as(http().post('/api/v1/bank-accounts'))
      .send({ code: 'X', name: 'x', glAccountId: acc['4100'] })
      .expect(422);
    expect(bad.body.code).toBe('ACCOUNT_NOT_POSTABLE');
    const dup = await as(http().post('/api/v1/bank-accounts'))
      .send({ code: 'BDO-2', name: 'x', glAccountId: acc['1130'] })
      .expect(422);
    expect(dup.body.code).toBe('CONFLICT');
    const created = await as(http().post('/api/v1/bank-accounts'))
      .send({
        code: 'BPI-MAIN',
        name: 'BPI Current Account',
        bankName: 'BPI',
        accountNumber: '****9921',
        glAccountId: acc['1140'],
      })
      .expect(201);
    bankId = created.body.id;
    expect(created.body.ledgerBalance).toBe('0.0000');
  });

  it('bank transactions post Dr/Cr the bank GL account; transfers move between bank accounts; void reverses', async () => {
    const trf = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bdoId,
        transactionType: 'TRANSFER',
        transactionDate: '2026-09-01',
        amount: '50000',
        toBankAccountId: bankId,
        reference: 'TRF-1',
        memo: 'Fund BPI',
      })
      .expect(201);
    expect(trf.body.documentNumber).toMatch(/^BTX-2026-\d{6}$/);
    const postedTrf = await as(http().post(`/api/v1/bank-transactions/${trf.body.id}/post`)).expect(
      201,
    );
    expect((await journalLine(postedTrf.body.journalEntryId, '1130'))[0].credit).toBe('50000.0000');
    expect((await journalLine(postedTrf.body.journalEntryId, '1140'))[0].debit).toBe('50000.0000');

    const dep = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bankId,
        transactionType: 'DEPOSIT',
        transactionDate: '2026-09-02',
        amount: '5000',
        counterpartyAccountId: acc['4900'],
        reference: 'DEP-1',
        memo: 'Sundry income',
      })
      .expect(201);
    const posted = await as(http().post(`/api/v1/bank-transactions/${dep.body.id}/post`)).expect(
      201,
    );
    expect((await journalLine(posted.body.journalEntryId, '1140'))[0].debit).toBe('5000.0000');
    expect((await journalLine(posted.body.journalEntryId, '4900'))[0].credit).toBe('5000.0000');
    expect(
      (await as(http().get(`/api/v1/bank-accounts/${bankId}`)).expect(200)).body.ledgerBalance,
    ).toBe('55000.0000');

    const wrong = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bankId,
        transactionType: 'WITHDRAWAL',
        transactionDate: '2026-09-03',
        amount: '10',
      })
      .expect(422);
    expect(wrong.body.code).toBe('VALIDATION_FAILED');
    const self = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bankId,
        transactionType: 'TRANSFER',
        transactionDate: '2026-09-03',
        amount: '10',
        toBankAccountId: bankId,
      })
      .expect(422);
    expect(self.body.code).toBe('VALIDATION_FAILED');

    // Void reverses the journal and leaves the original untouched.
    const oops = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bankId,
        transactionType: 'WITHDRAWAL',
        transactionDate: '2026-09-03',
        amount: '999',
        counterpartyAccountId: acc['6400'],
        reference: 'OOPS',
      })
      .expect(201);
    await as(http().post(`/api/v1/bank-transactions/${oops.body.id}/post`)).expect(201);
    const voided = await as(http().post(`/api/v1/bank-transactions/${oops.body.id}/void`))
      .send({ reason: 'Keyed in error' })
      .expect(201);
    expect(voided.body.status).toBe('VOID');
    expect(voided.body.reversalJournalEntryId).toBeTruthy();
    expect(
      (await as(http().get(`/api/v1/bank-accounts/${bankId}`)).expect(200)).body.ledgerBalance,
    ).toBe('55000.0000');
  });

  it('statement import runs the matching engine: matched, exception (ambiguous) and unmatched lines', async () => {
    // Two identical ledger payments create an ambiguity for the exception case.
    for (const ref of ['CHK-901', 'CHK-902']) {
      const w = await as(http().post('/api/v1/bank-transactions'))
        .send({
          bankAccountId: bankId,
          transactionType: 'WITHDRAWAL',
          transactionDate: '2026-09-05',
          amount: '800',
          counterpartyAccountId: acc['6400'],
          reference: ref,
        })
        .expect(201);
      await as(http().post(`/api/v1/bank-transactions/${w.body.id}/post`)).expect(201);
    }
    const lines = [
      {
        lineDate: '2026-09-01',
        description: 'Incoming transfer TRF-1',
        reference: 'TRF-1',
        amount: '50000',
      },
      { lineDate: '2026-09-02', description: 'Deposit DEP-1', reference: 'DEP-1', amount: '5000' },
      { lineDate: '2026-09-06', description: 'Check 901', amount: '-800' },
      {
        lineDate: '2026-09-07',
        description: 'Monthly service fee',
        reference: 'FEE',
        amount: '-350',
      },
    ];
    const wrongClosing = await as(http().post('/api/v1/bank-statements'))
      .send({
        bankAccountId: bankId,
        statementDate: '2026-09-07',
        openingBalance: '0',
        closingBalance: '1',
        lines,
      })
      .expect(422);
    expect(wrongClosing.body.code).toBe('VALIDATION_FAILED');
    const stm = await as(http().post('/api/v1/bank-statements'))
      .send({
        bankAccountId: bankId,
        statementDate: '2026-09-07',
        openingBalance: '0',
        closingBalance: '53850',
        lines,
        fileName: 'sept.csv',
      })
      .expect(201);
    statementId = stm.body.id;
    expect(stm.body.statementNumber).toMatch(/^STM-2026-\d{6}$/);
    expect(stm.body.status).toBe('OPEN');
    expect(stm.body.matchedCount).toBe(2);
    const detail = await as(http().get(`/api/v1/bank-statements/${statementId}/lines`)).expect(200);
    const byDesc = (d: string) =>
      detail.body.find((l: { description: string }) => l.description === d);
    expect(byDesc('Incoming transfer TRF-1').status).toBe('MATCHED');
    expect(byDesc('Deposit DEP-1').status).toBe('MATCHED');
    expect(byDesc('Check 901').status).toBe('EXCEPTION');
    expect(byDesc('Monthly service fee').status).toBe('UNMATCHED');
    feeLineId = byDesc('Monthly service fee').id;
    exceptionLineId = byDesc('Check 901').id;
  });

  it('review: manual match resolves the exception; recording the fee from the line matches it; completion needs a zero difference', async () => {
    const notYet = await as(http().post(`/api/v1/bank-statements/${statementId}/complete`))
      .send({})
      .expect(422);
    expect(notYet.body.code).toBe('DOCUMENT_INVALID_STATE');
    const rec = await as(
      http().get(`/api/v1/bank-statements/${statementId}/reconciliation`),
    ).expect(200);
    expect(rec.body.canComplete).toBe(false);
    expect(rec.body.figures.unrecordedDebits).toBe('1150.0000'); // 800 exception + 350 fee
    expect(rec.body.figures.outstandingPayments).toBe('1600.0000'); // both checks still unmatched

    const candidates = await as(
      http().get(`/api/v1/bank-statements/${statementId}/ledger-lines?onlyUnmatched=true`),
    ).expect(200);
    const chk901 = candidates.body.find(
      (l: { reference: string | null }) => l.reference === 'CHK-901',
    );
    expect(chk901).toBeTruthy();
    const wrongAmount = await as(
      http().post(`/api/v1/bank-statements/${statementId}/lines/${feeLineId}/match`),
    )
      .send({ journalLineId: chk901.journalLineId })
      .expect(422);
    expect(wrongAmount.body.code).toBe('VALIDATION_FAILED');
    const matched = await as(
      http().post(`/api/v1/bank-statements/${statementId}/lines/${exceptionLineId}/match`),
    )
      .send({ journalLineId: chk901.journalLineId })
      .expect(201);
    expect(matched.body.status).toBe('MATCHED');
    const unmatched = await as(
      http().post(`/api/v1/bank-statements/${statementId}/lines/${exceptionLineId}/unmatch`),
    ).expect(201);
    expect(unmatched.body.status).toBe('UNMATCHED');
    await as(http().post(`/api/v1/bank-statements/${statementId}/lines/${exceptionLineId}/match`))
      .send({ journalLineId: chk901.journalLineId })
      .expect(201);

    // The fee is not in the books: record it from the statement line, post -> matched automatically.
    const fee = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: bankId,
        transactionType: 'BANK_FEE',
        transactionDate: '2026-09-07',
        amount: '350',
        counterpartyAccountId: acc['6600'],
        reference: 'FEE',
        statementLineId: feeLineId,
      })
      .expect(201);
    const postedFee = await as(http().post(`/api/v1/bank-transactions/${fee.body.id}/post`)).expect(
      201,
    );
    expect((await journalLine(postedFee.body.journalEntryId, '6600'))[0].debit).toBe('350.0000');
    const lines = await as(http().get(`/api/v1/bank-statements/${statementId}/lines`)).expect(200);
    expect(lines.body.find((l: { id: string }) => l.id === feeLineId).status).toBe('MATCHED');

    const view = await as(
      http().get(`/api/v1/bank-statements/${statementId}/reconciliation`),
    ).expect(200);
    expect(view.body.figures.ledgerBalance).toBe('53050.0000');
    expect(view.body.figures.statementBalance).toBe('53850.0000');
    // CHK-902 is in the books but not on the statement: an outstanding payment, explained.
    expect(view.body.figures.outstandingPayments).toBe('800.0000');
    expect(view.body.figures.unrecordedDebits).toBe('0.0000');
    expect(view.body.figures.difference).toBe('0.0000');
    expect(view.body.canComplete).toBe(true);
    const done = await as(http().post(`/api/v1/bank-statements/${statementId}/complete`))
      .send({ notes: 'September' })
      .expect(201);
    expect(done.body.reconciliation.status).toBe('COMPLETED');
    expect(done.body.statement.status).toBe('RECONCILED');
    const linesAfter = await as(http().get(`/api/v1/bank-statements/${statementId}/lines`)).expect(
      200,
    );
    expect(linesAfter.body.every((l: { status: string }) => l.status === 'RECONCILED')).toBe(true);
    // Reconciled bank transactions cannot be voided; reconciled statements are frozen.
    const voided = await as(http().post(`/api/v1/bank-transactions/${fee.body.id}/void`))
      .send({ reason: 'x' })
      .expect(422);
    expect(voided.body.code).toBe('DOCUMENT_INVALID_STATE');
    const frozen = await as(
      http().post(`/api/v1/bank-statements/${statementId}/lines/${exceptionLineId}/unmatch`),
    ).expect(422);
    expect(frozen.body.code).toBe('DOCUMENT_INVALID_STATE');
    await balance('1140');
  });
});
