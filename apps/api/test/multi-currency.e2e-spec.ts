import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { Money } from '@accounting/money';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';

const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Prompt #14 - multi-currency depth. A PHP company runs a USD bank account,
 * a USD lease and USD deferred revenue: every line on a currency-bound account
 * carries its foreign amount, balances in both currencies come from the
 * ledger, instalments realize FX against the carrying base, period-end
 * revaluation restates bank balances and lease liabilities, and deferred
 * revenue stays at its historical base.
 */
describe('Multi-currency depth (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  let usdBankId: string;
  let usdCustomerId: string;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const journal = async (id: string) => {
    const je = await as(http().get(`/api/v1/journal-entries/${id}`)).expect(200);
    return je.body as {
      status: string;
      lines: Array<{
        accountId: string;
        debit: string;
        credit: string;
        foreignDebit: string | null;
        foreignCredit: string | null;
        foreignCurrency: string | null;
      }>;
    };
  };
  const lineOn = async (journalId: string, code: string) =>
    (await journal(journalId)).lines.filter((l) => l.accountId === acc[code]);
  const trialBalanced = async () => {
    const tb = await as(
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31'),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
  };
  const usdBank = async () =>
    (await as(http().get(`/api/v1/bank-accounts/${usdBankId}`)).expect(200)).body as {
      ledgerBalance: string;
      foreignBalance: string | null;
      baseCurrency: string;
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
    finance = await login(FINANCE);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    // Seeded USD/PHP: 56.00 from January, 57.50 from July; add September.
    await as(http().put('/api/v1/exchange-rates'))
      .send({ fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-09-01', rate: '58.25' })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------ USD bank account

  it('a foreign-currency bank account books to a currency-bound GL account; deposits carry the USD amount beside the base', async () => {
    const unbound = await as(http().post('/api/v1/accounts'))
      .send({
        code: '1171',
        name: 'USD wallet (unbound)',
        type: 'ASSET',
        subtype: 'BANK',
        parentId: acc['1100'],
      })
      .expect(201);
    // A USD bank account cannot book to a base-currency GL account.
    const refused = await as(http().post('/api/v1/bank-accounts'))
      .send({ code: 'USD-X', name: 'x', glAccountId: unbound.body.id, currency: 'USD' })
      .expect(422);
    expect(refused.body.code).toBe('CURRENCY_MISMATCH');

    const gl = await as(http().post('/api/v1/accounts'))
      .send({
        code: '1170',
        name: 'Cash in Bank - USD',
        type: 'ASSET',
        subtype: 'BANK',
        parentId: acc['1100'],
        currency: 'USD',
      })
      .expect(201);
    acc['1170'] = gl.body.id;
    const bank = await as(http().post('/api/v1/bank-accounts'))
      .send({
        code: 'BDO-USD',
        name: 'BDO USD Account',
        bankName: 'BDO Unibank',
        accountNumber: '****0099',
        glAccountId: acc['1170'],
        currency: 'USD',
      })
      .expect(201);
    usdBankId = bank.body.id;
    expect(bank.body.foreignBalance).toBe('0.0000');
    expect(bank.body.baseCurrency).toBe('PHP');

    // USD 1,000 deposit on 5 March at the table rate (56.00) -> PHP 56,000, USD 1,000 on the line.
    const deposit = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: usdBankId,
        transactionType: 'DEPOSIT',
        transactionDate: '2026-03-05',
        amount: '1000',
        counterpartyAccountId: acc['4900'],
        memo: 'Opening USD funding',
      })
      .expect(201);
    expect(deposit.body.exchangeRate).toBe('56.00000000');
    expect(deposit.body.baseAmount).toBe('56000.0000');
    const posted = await as(
      http().post(`/api/v1/bank-transactions/${deposit.body.id}/post`),
      finance,
    ).expect(201);
    const [bankLine] = await lineOn(posted.body.journalEntryId, '1170');
    expect(bankLine).toMatchObject({
      debit: '56000.0000',
      foreignDebit: '1000.0000',
      foreignCredit: '0.0000',
      foreignCurrency: 'USD',
    });
    const [income] = await lineOn(posted.body.journalEntryId, '4900');
    expect(income!.foreignCurrency).toBeNull();
    expect(await usdBank()).toMatchObject({
      ledgerBalance: '56000.0000',
      foreignBalance: '1000.0000',
    });

    // A direct transfer into a PHP account is refused: cross-currency moves are treasury transfers.
    const php = await as(http().get('/api/v1/bank-accounts')).expect(200);
    const phpBank = php.body.find((b: { currency: string; id: string }) => b.currency === 'PHP');
    const cross = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: usdBankId,
        transactionType: 'TRANSFER',
        transactionDate: '2026-03-06',
        amount: '100',
        toBankAccountId: phpBank.id,
      })
      .expect(422);
    expect(cross.body.code).toBe('CURRENCY_MISMATCH');
    await trialBalanced();
  });

  it('a USD receipt lands in the USD bank with its foreign amount; a PHP receipt into it is refused; the statement reconciles in USD', async () => {
    const customer = await as(http().post('/api/v1/customers'))
      .send({ code: 'CUST-USD', name: 'Pacific Imports LLC', currency: 'USD' })
      .expect(201);
    usdCustomerId = customer.body.id;
    const invoice = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: usdCustomerId,
        documentDate: '2026-03-10',
        lines: [{ description: 'Consulting', unitPrice: '500', accountId: acc['4200'] }],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/post`), finance).expect(201);

    // Settled 5 August at 57.50: bank PHP 28,750 / USD 500; AR relieved at 56.00; gain 750.
    const receipt = await as(http().post('/api/v1/customer-payments'))
      .send({
        partyId: usdCustomerId,
        paymentDate: '2026-08-05',
        amount: '500',
        cashAccountId: acc['1170'],
        allocations: [{ documentId: invoice.body.id, amount: '500' }],
      })
      .expect(201);
    await as(http().post(`/api/v1/customer-payments/${receipt.body.id}/post`), finance).expect(201);
    const view = await as(http().get(`/api/v1/customer-payments/${receipt.body.id}`)).expect(200);
    const [bankLine] = await lineOn(view.body.journalEntryId, '1170');
    expect(bankLine).toMatchObject({
      debit: '28750.0000',
      foreignDebit: '500.0000',
      foreignCurrency: 'USD',
    });
    expect((await lineOn(view.body.journalEntryId, '4910'))[0]?.credit).toBe('750.0000');
    expect(await usdBank()).toMatchObject({
      ledgerBalance: '84750.0000',
      foreignBalance: '1500.0000',
    });

    // A PHP customer's receipt cannot be paid into the USD account.
    const customers = await as(http().get('/api/v1/customers?pageSize=5')).expect(200);
    const phpCustomer = customers.body.items.find(
      (c: { currency: string }) => c.currency === 'PHP',
    );
    const mismatch = await as(http().post('/api/v1/customer-payments'))
      .send({
        partyId: phpCustomer.id,
        paymentDate: '2026-08-06',
        amount: '10',
        cashAccountId: acc['1170'],
        allocations: [],
      })
      .expect(422);
    expect(mismatch.body.code).toBe('CURRENCY_MISMATCH');

    // The bank statement is in USD and reconciles against the USD book balance.
    const stm = await as(http().post('/api/v1/bank-statements'))
      .send({
        bankAccountId: usdBankId,
        statementDate: '2026-08-31',
        openingBalance: '0',
        closingBalance: '1500',
        lines: [
          { lineDate: '2026-03-05', description: 'Opening USD funding', amount: '1000' },
          { lineDate: '2026-08-05', description: 'Pacific Imports LLC', amount: '500' },
        ],
      })
      .expect(201);
    const rec = await as(
      http().get(`/api/v1/bank-statements/${stm.body.id}/reconciliation`),
    ).expect(200);
    expect(rec.body.figures.ledgerBalance).toBe('1500.0000');
    expect(rec.body.figures.difference).toBe('0.0000');
    await trialBalanced();
  });

  it('period-end revaluation restates the USD bank balance at the closing rate and reverses the next day', async () => {
    // USD 1,500 carried at PHP 84,750; at 57.50 it is worth 86,250 -> unrealized gain 1,500.
    const preview = await as(
      http().get('/api/v1/fx/revaluations/preview?asOfDate=2026-08-31'),
    ).expect(200);
    const bankLine = preview.body.lines.find(
      (l: { side: string; documentId: string }) =>
        l.side === 'BANK' && l.documentId === acc['1170'],
    );
    expect(bankLine).toMatchObject({
      currency: 'USD',
      openAmount: '1500.0000',
      closingRate: '57.50000000',
      adjustment: '1500.0000',
    });
    const run = await as(http().post('/api/v1/fx/revaluations'), finance)
      .send({ asOfDate: '2026-08-31' })
      .expect(201);
    const [reval] = await lineOn(run.body.journalEntryId, '1170');
    // The bank account keeps its USD balance: the revaluation line carries a zero foreign amount.
    expect(reval).toMatchObject({
      debit: '1500.0000',
      foreignDebit: '0.0000',
      foreignCredit: '0.0000',
      foreignCurrency: 'USD',
    });
    expect((await lineOn(run.body.reversalJournalEntryId, '1170'))[0]?.credit).toBe('1500.0000');
    const onClose = await as(http().get(`/api/v1/bank-accounts/${usdBankId}`)).expect(200);
    expect(onClose.body.foreignBalance).toBe('1500.0000');
    await trialBalanced();
  });

  // ---------------------------------------------------------- USD lease

  it('a USD lease commences at the commencement rate, accretes interest at the run rate, realizes FX on instalments and revalues its liability', async () => {
    await as(http().put('/api/v1/leases/settings'), finance)
      .send({ lowValueThreshold: '0', defaultDiscountRate: '6' })
      .expect(200);
    const lessor = await as(http().post('/api/v1/vendors'))
      .send({ code: 'VEND-USD-LSR', name: 'Harbor Realty Inc', currency: 'USD' })
      .expect(201);
    // Fund the USD bank for the instalments (USD 3,000 at 56.00 in March).
    const funding = await as(http().post('/api/v1/bank-transactions'))
      .send({
        bankAccountId: usdBankId,
        transactionType: 'DEPOSIT',
        transactionDate: '2026-03-06',
        amount: '3000',
        counterpartyAccountId: acc['4900'],
      })
      .expect(201);
    await as(http().post(`/api/v1/bank-transactions/${funding.body.id}/post`), finance).expect(201);

    const created = await as(http().post('/api/v1/leases'), finance)
      .send({
        name: 'Cebu warehouse (USD)',
        vendorId: lessor.body.id,
        currency: 'USD',
        commencementDate: '2026-06-01',
        termMonths: 24,
        paymentAmount: '1000',
        paymentTiming: 'IN_ADVANCE',
        annualDiscountRate: '6',
        bankAccountId: usdBankId,
      })
      .expect(201);
    expect(created.body.currency).toBe('USD');
    expect(created.body.classification).toBe('FINANCE');
    const pvUsd = Money.of(created.body.preview.initialLiability, 'USD');

    // Commence on 1 June at the January rate (56.00): ROU and liability in base at that rate.
    const commenced = await as(http().post(`/api/v1/leases/${created.body.id}/commence`), finance)
      .send({})
      .expect(200);
    const pvBase = pvUsd.convert('PHP', '56');
    expect(commenced.body.exchangeRate).toBe('56.00000000');
    expect(commenced.body.liabilityBalanceBase).toBe(pvBase.toString());
    expect(commenced.body.rouCostBase).toBe(pvBase.toString());
    expect((await lineOn(commenced.body.commencementJournalEntryId, '2220'))[0]?.credit).toBe(
      pvBase.toString(),
    );
    expect((await lineOn(commenced.body.commencementJournalEntryId, '1530'))[0]?.debit).toBe(
      pvBase.toString(),
    );
    const leaseId = created.body.id as string;
    const lines = (await as(http().get(`/api/v1/leases/${leaseId}`)).expect(200)).body
      .lines as Array<{
      id: string;
      sequence: number;
      interest: string;
      depreciation: string;
      depreciationBase: string;
      paymentDate: string | null;
    }>;
    // Base depreciation is fixed at the commencement rate and sums to the base cost.
    const depBase = lines.reduce(
      (s, l) => s.add(Money.of(l.depreciationBase, 'PHP')),
      Money.zero('PHP'),
    );
    expect(depBase.toString()).toBe(pvBase.toString());

    // Month 1 paid on commencement day at 56.00: cash 56,000; liability relieved 1,000 x 56 -> no FX.
    const pay1 = await as(http().post(`/api/v1/leases/${leaseId}/pay`), finance)
      .send({ lineId: lines[0]!.id, bankAccountId: usdBankId, paymentDate: '2026-06-01' })
      .expect(200);
    const june = lines[0]!;
    void june;
    const pay1Journal = (await as(http().get(`/api/v1/leases/${leaseId}`)).expect(200)).body
      .lines[0].paymentJournalEntryId as string;
    const [cash1] = await lineOn(pay1Journal, '1170');
    expect(cash1).toMatchObject({
      credit: '56000.0000',
      foreignCredit: '1000.0000',
      foreignCurrency: 'USD',
    });
    expect((await lineOn(pay1Journal, '2220'))[0]?.debit).toBe('56000.0000');
    expect(await lineOn(pay1Journal, '4910')).toHaveLength(0);
    expect(await lineOn(pay1Journal, '6910')).toHaveLength(0);
    expect(pay1.body.liabilityBalanceBase).toBe(
      pvBase.subtract(Money.of('56000', 'PHP')).toString(),
    );

    // June run: interest at the June rate (56.00), depreciation from the historical base.
    const juneRun = await as(http().post('/api/v1/leases/runs'), finance)
      .send({ periodEnd: '2026-06-30', leaseIds: [leaseId] })
      .expect(201);
    const juneInterestBase = Money.of(lines[0]!.interest, 'USD').convert('PHP', '56');
    expect((await lineOn(juneRun.body.journalEntryId, '8110'))[0]?.debit).toBe(
      juneInterestBase.toString(),
    );
    expect((await lineOn(juneRun.body.journalEntryId, '1540'))[0]?.credit).toBe(
      lines[0]!.depreciationBase,
    );
    const afterJune = (await as(http().get(`/api/v1/leases/${leaseId}`)).expect(200)).body;
    const liabilityFcJuly = Money.of(afterJune.liabilityBalance, 'USD');
    const liabilityBaseJuly = Money.of(afterJune.liabilityBalanceBase, 'PHP');
    expect(liabilityBaseJuly.toString()).toBe(
      pvBase.subtract(Money.of('56000', 'PHP')).add(juneInterestBase).toString(),
    );

    // Month 2 paid on 1 July at 57.50: cash 57,500; the liability is relieved at its carrying
    // rate (~56) -> realized loss of about 1,500.
    const pay2 = await as(http().post(`/api/v1/leases/${leaseId}/pay`), finance)
      .send({ lineId: lines[1]!.id, bankAccountId: usdBankId, paymentDate: '2026-07-01' })
      .expect(200);
    const relieved = Money.of(liabilityBaseJuly.toString(), 'PHP', 20)
      .multiply('1000')
      .divide(liabilityFcJuly.toString());
    const relievedBase = Money.of(relieved.toString(), 'PHP');
    const pay2Journal = (await as(http().get(`/api/v1/leases/${leaseId}`)).expect(200)).body
      .lines[1].paymentJournalEntryId as string;
    expect((await lineOn(pay2Journal, '1170'))[0]?.credit).toBe('57500.0000');
    expect((await lineOn(pay2Journal, '2220'))[0]?.debit).toBe(relievedBase.toString());
    const loss = Money.of('57500', 'PHP').subtract(relievedBase);
    expect((await lineOn(pay2Journal, '6910'))[0]?.debit).toBe(loss.toString());
    expect(pay2.body.liabilityBalanceBase).toBe(
      liabilityBaseJuly.subtract(relievedBase).toString(),
    );

    // July run at 57.50, then the 31 July revaluation restates the liability to USD x 57.50.
    await as(http().post('/api/v1/leases/runs'), finance)
      .send({ periodEnd: '2026-07-31', leaseIds: [leaseId] })
      .expect(201);
    const beforeReval = (await as(http().get(`/api/v1/leases/${leaseId}`)).expect(200)).body;
    const preview = await as(
      http().get('/api/v1/fx/revaluations/preview?asOfDate=2026-07-31'),
    ).expect(200);
    const leaseLine = preview.body.lines.find(
      (l: { side: string; documentId: string }) => l.side === 'LEASE' && l.documentId === leaseId,
    );
    const expectedAdj = Money.of(beforeReval.liabilityBalance, 'USD')
      .convert('PHP', '57.5')
      .subtract(Money.of(beforeReval.liabilityBalanceBase, 'PHP'));
    expect(leaseLine).toMatchObject({
      currency: 'USD',
      openAmount: beforeReval.liabilityBalance,
      adjustment: expectedAdj.toString(),
    });
    const reval = await as(http().post('/api/v1/fx/revaluations'), finance)
      .send({ asOfDate: '2026-07-31' })
      .expect(201);
    const [liabLine] = await lineOn(reval.body.journalEntryId, '2220');
    expect(liabLine?.credit ?? liabLine?.debit).toBe(expectedAdj.abs().toString());

    // The register agrees with the ledger on the revaluation date (net of it) and after it reverses.
    for (const asOf of ['2026-07-31', '2026-08-31']) {
      const integrity = await as(http().get(`/api/v1/leases/integrity?asOf=${asOf}`)).expect(200);
      for (const check of [
        'LEASE_LIABILITY_VS_LEDGER',
        'ROU_ASSET_VS_LEDGER',
        'LEASE_SCHEDULE_TOTALS',
      ]) {
        const f = integrity.body.findings.find((x: { check: string }) => x.check === check);
        expect({ asOf, check, samples: f.samples, count: f.count }).toEqual({
          asOf,
          check,
          samples: [],
          count: 0,
        });
      }
    }
    // Register: contract-currency and base figures side by side; totals in base.
    const register = await as(http().get('/api/v1/leases/reports/register?asOf=2026-08-31')).expect(
      200,
    );
    const row = register.body.rows.find((r: { leaseId: string }) => r.leaseId === leaseId);
    expect(row.currency).toBe('USD');
    expect(row.liabilityBalanceBase).toBe(beforeReval.liabilityBalanceBase);
    expect(register.body.currency).toBe('PHP');
    await trialBalanced();
  });

  it('terminating the USD lease derecognizes the base carrying amounts and books the base gain or loss', async () => {
    const list = await as(http().get('/api/v1/leases?search=Cebu')).expect(200);
    const lease = list.body.items[0];
    const before = (await as(http().get(`/api/v1/leases/${lease.id}`)).expect(200)).body;
    const terminated = await as(http().post(`/api/v1/leases/${lease.id}/terminate`), finance)
      .send({ terminationDate: '2026-08-15', notes: 'Relocated' })
      .expect(200);
    const liability = Money.of(before.liabilityBalanceBase, 'PHP');
    const carrying = Money.of(before.rouCostBase, 'PHP').subtract(
      Money.of(before.rouAccumulatedDepreciationBase, 'PHP'),
    );
    expect(terminated.body.terminationGainLoss).toBe(liability.subtract(carrying).toString());
    expect((await lineOn(terminated.body.terminationJournalEntryId, '2220'))[0]?.debit).toBe(
      liability.toString(),
    );
    expect((await lineOn(terminated.body.terminationJournalEntryId, '1530'))[0]?.credit).toBe(
      before.rouCostBase,
    );
    const integrity = await as(http().get('/api/v1/leases/integrity?asOf=2026-08-31')).expect(200);
    expect(
      integrity.body.findings.find(
        (f: { check: string }) => f.check === 'LEASE_LIABILITY_VS_LEDGER',
      ).count,
    ).toBe(0);
    await trialBalanced();
  });

  // --------------------------------------------------- USD deferred revenue

  it('USD deferred revenue is booked and recognized at the invoice rate - a non-monetary balance never revalues', async () => {
    const policies = await as(http().get('/api/v1/revenue/policies')).expect(200);
    const ratable = policies.body.find((p: { code: string }) => p.code === 'RATABLE-SVC');
    const invoice = await as(http().post('/api/v1/invoices'))
      .send({
        customerId: usdCustomerId,
        documentDate: '2026-09-01',
        lines: [
          {
            description: 'Support Sep - Nov 2026 (USD)',
            unitPrice: '3000',
            accountId: acc['4200'],
            revenuePolicyId: ratable.id,
            serviceStartDate: '2026-09-01',
            serviceEndDate: '2026-11-30',
          },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/invoices/${invoice.body.id}/approve`), finance).expect(201);
    const posted = await as(
      http().post(`/api/v1/invoices/${invoice.body.id}/post`),
      finance,
    ).expect(201);
    // USD 3,000 at the September rate 58.25 = PHP 174,750 deferred.
    expect((await lineOn(posted.body.journalEntryId, '2190'))[0]?.credit).toBe('174750.0000');
    const schedules = await as(
      http().get(`/api/v1/revenue/schedules?invoiceId=${invoice.body.id}`),
    ).expect(200);
    const schedule = schedules.body.items[0];
    expect(schedule.currency).toBe('PHP');
    expect(schedule.totalAmount ?? schedule.amount).toBe('174750.0000');
    // Not in the revaluation: the obligation is settled in service, not in cash.
    const preview = await as(
      http().get('/api/v1/fx/revaluations/preview?asOfDate=2026-09-30'),
    ).expect(200);
    expect(
      preview.body.lines.some((l: { documentId: string }) => l.documentId === invoice.body.id),
    ).toBe(false);
    // Recognition at the historical base regardless of the rate on the run date.
    await as(http().put('/api/v1/exchange-rates'))
      .send({ fromCurrency: 'USD', toCurrency: 'PHP', rateDate: '2026-09-30', rate: '60' })
      .expect(200);
    const run = await as(http().post('/api/v1/revenue/runs'), finance)
      .send({ periodEnd: '2026-09-30' })
      .expect(201);
    const detail = await as(http().get(`/api/v1/revenue/schedules/${schedule.id}`)).expect(200);
    const september = detail.body.lines.find(
      (l: { recognitionDate: string }) => l.recognitionDate === '2026-09-30',
    );
    expect(september.status).toBe('RECOGNIZED');
    const recognized = (await lineOn(run.body.journalEntryId, '2190')).reduce(
      (s, l) => s.add(Money.of(l.debit, 'PHP')),
      Money.zero('PHP'),
    );
    expect(
      recognized.greaterThan(Money.of(september.amount, 'PHP')) ||
        recognized.equals(Money.of(september.amount, 'PHP')),
    ).toBe(true);
    await trialBalanced();
  });
});
