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
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

/**
 * Hardening phase 6 - data infrastructure: configurable document numbering,
 * the CSV import engine (validate -> preview -> commit, atomic for financial
 * datasets), CSV exports and the controlled opening-balance process with its
 * reconciliation report.
 */
describe('Data infrastructure (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let accountant: Cookies;
  let viewer: Cookies;
  let companyId: string;
  let branchId: string;
  const acc: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const upload = (type: string, csv: string, fields: Record<string, string> = {}, who = admin) => {
    let req = as(http().post('/api/v1/imports'), who).field('type', type);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', Buffer.from(csv, 'utf8'), {
      filename: `${type}.csv`,
      contentType: 'text/csv',
    });
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
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const branches = await http()
      .get(`/api/v1/branches?companyId=${companyId}`)
      .set('Cookie', admin)
      .expect(200);
    branchId = branches.body.find((b: { code: string }) => b.code === 'CEB').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ------------------------------------------------------------- numbering

  it('numbering rules: defaults, a branch-specific format, previews that do not consume, no reuse', async () => {
    const list = await as(http().get('/api/v1/numbering-rules?year=2026')).expect(200);
    const je = list.body.find(
      (r: { documentType: string; branchId: string | null }) =>
        r.documentType === 'JE' && r.branchId === null,
    );
    expect(je.ruleId).toBeNull();
    expect(je.format).toBe('{PREFIX}-{YEAR}-{SEQ}');
    expect(je.nextNumber).toMatch(/^JE-2026-\d{6}$/);
    // Viewers cannot configure numbering.
    await as(http().put('/api/v1/numbering-rules'), viewer)
      .send({ documentType: 'INV', prefix: 'INV', format: '{PREFIX}-{YEAR}-{SEQ}' })
      .expect(403);
    // Branch-specific invoice numbering for Cebu.
    const rule = await as(http().put('/api/v1/numbering-rules'))
      .send({
        documentType: 'INV',
        branchId,
        prefix: 'INV',
        format: '{PREFIX}-{BRANCH}-{YEAR}-{SEQ}',
        padding: 5,
      })
      .expect(200);
    expect(rule.body.branchId).toBe(branchId);
    const preview = await as(
      http().get(`/api/v1/numbering-rules/preview?documentType=INV&branchId=${branchId}&year=2026`),
    ).expect(200);
    expect(preview.body.next).toBe('INV-CEB-2026-00001');
    const again = await as(
      http().get(`/api/v1/numbering-rules/preview?documentType=INV&branchId=${branchId}&year=2026`),
    ).expect(200);
    expect(again.body.next).toBe('INV-CEB-2026-00001'); // preview never consumes
    // A Cebu invoice takes the branch number; a company-wide one keeps the default sequence.
    const customers = await as(http().get('/api/v1/customers?pageSize=1')).expect(200);
    const customerId = customers.body.items[0].id;
    const cebu = await as(http().post('/api/v1/invoices'), accountant)
      .send({
        customerId,
        branchId,
        documentDate: '2026-06-10',
        lines: [{ description: 'Cebu sale', unitPrice: '100', accountId: acc['4100'] }],
      })
      .expect(201);
    expect(cebu.body.documentNumber).toBe('INV-CEB-2026-00001');
    const head = await as(http().post('/api/v1/invoices'), accountant)
      .send({
        customerId,
        documentDate: '2026-06-10',
        lines: [{ description: 'Head office sale', unitPrice: '100', accountId: acc['4100'] }],
      })
      .expect(201);
    expect(head.body.documentNumber).toMatch(/^INV-2026-\d{6}$/);
    const next = await as(
      http().get(`/api/v1/numbering-rules/preview?documentType=INV&branchId=${branchId}&year=2026`),
    ).expect(200);
    expect(next.body.next).toBe('INV-CEB-2026-00002');
    // Formats must carry {SEQ}; prefixes are upper-case codes.
    await as(http().put('/api/v1/numbering-rules'))
      .send({ documentType: 'PO', prefix: 'PO', format: '{PREFIX}-{YEAR}' })
      .expect(400);
    // Removing the branch rule sends Cebu back to the company sequence without reusing numbers.
    await as(http().delete(`/api/v1/numbering-rules/${rule.body.id}`)).expect(204);
    const fallback = await as(
      http().get(`/api/v1/numbering-rules/preview?documentType=INV&branchId=${branchId}&year=2026`),
    ).expect(200);
    expect(fallback.body.next).toMatch(/^INV-2026-\d{6}$/);
  });

  // ---------------------------------------------------------------- imports

  it('import engine: templates, validation with row errors, preview, master data commit with skipInvalid', async () => {
    const types = await as(http().get('/api/v1/imports/types')).expect(200);
    expect(types.body.map((t: { type: string }) => t.type)).toContain('CUSTOMERS');
    const template = await as(http().get('/api/v1/imports/templates/CUSTOMERS')).expect(200);
    expect(template.headers['content-type']).toMatch(/text\/csv/);
    expect(template.text.split('\r\n')[0]).toMatch(/^code,name,legal_name/);
    // Viewers cannot upload.
    await upload('CUSTOMERS', 'code,name\nX,Y\n', {}, viewer).expect(403);
    // Two good rows, one duplicate of a seeded customer, one with a bad email, one duplicated in-file.
    const csv = [
      'code,name,email,payment_terms_days,credit_limit',
      'IMP-001,Imported One,one@imp.test,45,100000',
      'IMP-002,Imported Two,,30,',
      'CUST-001,Seeded again,,30,',
      'IMP-003,Bad Email,not-an-email,30,',
      'IMP-001,Duplicate In File,,30,',
    ].join('\n');
    const job = await upload('CUSTOMERS', csv).expect(201);
    expect(job.body.status).toBe('VALIDATED');
    expect(job.body.rowCount).toBe(5);
    expect(job.body.validCount).toBe(2);
    expect(job.body.errorCount).toBe(3);
    const byCode = (code: string) =>
      job.body.rows.find((r: { values: { code: string } }) => r.values.code === code);
    expect(byCode('CUST-001').errors[0]).toMatch(/already exists/);
    expect(byCode('IMP-003').errors[0]).toMatch(/email/);
    expect(job.body.rows[4].errors[0]).toMatch(/duplicate of line 2/);
    // With errors, a plain commit is refused; skipInvalid loads the valid rows.
    const refused = await as(http().post(`/api/v1/imports/${job.body.id}/commit`))
      .send({})
      .expect(422);
    expect(refused.body.code).toBe('IMPORT_INVALID_ROWS');
    const done = await as(http().post(`/api/v1/imports/${job.body.id}/commit`))
      .send({ skipInvalid: true })
      .expect(201);
    expect(done.body.status).toBe('COMMITTED');
    expect(done.body.result.created).toBe(2);
    expect(byCode('IMP-001')).toBeDefined();
    const created = await as(http().get('/api/v1/customers?search=IMP-00&pageSize=10')).expect(200);
    expect(created.body.items.map((c: { code: string }) => c.code).sort()).toEqual([
      'IMP-001',
      'IMP-002',
    ]);
    expect(
      created.body.items.find((c: { code: string }) => c.code === 'IMP-001').paymentTermsDays,
    ).toBe(45);
    // A committed job cannot be committed twice; the audit trail has the IMPORT event.
    await as(http().post(`/api/v1/imports/${job.body.id}/commit`))
      .send({ skipInvalid: true })
      .expect(422);
    const audit = await http()
      .get(`/api/v1/audit-logs?action=IMPORT&entityId=${job.body.id}`)
      .set('Cookie', admin)
      .expect(200);
    expect(audit.body.items).toHaveLength(1);
    expect(audit.body.items[0].newValue.created).toBe(2);
    // Missing required columns are refused at upload.
    const bad = await upload('VENDORS', 'name\nNo code\n').expect(422);
    expect(bad.body.code).toBe('IMPORT_FILE_INVALID');
    expect(bad.body.details.missing).toEqual(['code']);
  });

  it('import engine: chart of accounts creates parents first; journals import atomically as balanced drafts', async () => {
    const coa = [
      'code,name,type,subtype,parent_code,is_header',
      '1160,Petty Cash Sub,ASSET,CASH,1155,no',
      '1155,Petty Cash Group,ASSET,,1100,yes',
    ].join('\n');
    const coaJob = await upload('CHART_OF_ACCOUNTS', coa).expect(201);
    expect(coaJob.body.errorCount).toBe(0);
    const coaDone = await as(http().post(`/api/v1/imports/${coaJob.body.id}/commit`))
      .send({})
      .expect(201);
    expect(coaDone.body.result.created).toBe(2);
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    const sub = chart.body.find((a: { code: string }) => a.code === '1160');
    const group = chart.body.find((a: { code: string }) => a.code === '1155');
    expect(group.isHeader).toBe(true);
    expect(sub.parentId).toBe(group.id);

    // One balanced entry, one unbalanced: the whole file is refused (atomic dataset).
    const unbalanced = [
      'entry,date,description,reference,account_code,debit,credit,line_description',
      'A1,2026-06-30,Accrued utilities,UTIL-06,6300,8500,,June electricity',
      'A1,2026-06-30,Accrued utilities,UTIL-06,2120,,8500,',
      'B1,2026-06-30,Broken,,6400,100,,',
      'B1,2026-06-30,Broken,,1110,,90,',
    ].join('\n');
    const jeBad = await upload('JOURNAL_ENTRIES', unbalanced).expect(201);
    expect(jeBad.body.errorCount).toBe(2);
    expect(jeBad.body.rows[2].errors[0]).toMatch(/does not balance/);
    const refused = await as(http().post(`/api/v1/imports/${jeBad.body.id}/commit`))
      .send({ skipInvalid: true })
      .expect(422);
    expect(refused.body.code).toBe('IMPORT_INVALID_ROWS');
    // Fixed file: two drafts appear together, numbered by the engine.
    const good = unbalanced.replace(',,90,', ',,100,');
    const jeGood = await upload('JOURNAL_ENTRIES', good).expect(201);
    expect(jeGood.body.errorCount).toBe(0);
    const jeDone = await as(http().post(`/api/v1/imports/${jeGood.body.id}/commit`))
      .send({})
      .expect(201);
    expect(jeDone.body.result.created).toBe(2);
    expect(jeDone.body.result.documents).toHaveLength(2);
    expect(jeDone.body.rows[0].result).toMatch(/^JE-2026-\d{6}$/);
    const draft = await as(
      http().get(`/api/v1/journal-entries?search=${jeDone.body.result.documents[0]}`),
    ).expect(200);
    expect(draft.body.items[0].status).toBe('DRAFT');
    expect(draft.body.items[0].totalDebit).toBe('8500.0000');
    // Nothing from the refused file was created.
    const broken = await as(http().get('/api/v1/journal-entries?search=Broken&pageSize=5')).expect(
      200,
    );
    expect(
      broken.body.items.filter((j: { totalDebit: string }) => j.totalDebit === '100.0000'),
    ).toHaveLength(1);
  });

  // ----------------------------------------------------------------- exports

  it('exports: CSV with the dataset permission, audited; a viewer without reports.export is refused', async () => {
    const tb = await as(
      http().get('/api/v1/exports?dataset=TRIAL_BALANCE&from=2026-01-01&to=2026-06-30'),
    ).expect(200);
    expect(tb.headers['content-type']).toMatch(/text\/csv/);
    expect(tb.headers['content-disposition']).toMatch(/trial-balance-20260630\.csv/);
    const lines = tb.text.trim().split('\r\n');
    expect(lines[0]).toBe(
      'Account code,Account name,Type,Opening debit,Opening credit,Period debit,Period credit,Closing debit,Closing credit',
    );
    expect(lines.length).toBeGreaterThan(5);
    expect(Number(tb.headers['x-export-rows'])).toBe(lines.length - 1);
    const gl = await as(
      http().get(
        `/api/v1/exports?dataset=GENERAL_LEDGER&accountId=${acc['1130']}&from=2026-01-01&to=2026-12-31`,
      ),
    ).expect(200);
    expect(gl.text.split('\r\n')[0]).toMatch(/^Date,Journal,Type,Status/);
    await as(http().get('/api/v1/exports?dataset=GENERAL_LEDGER')).expect(422);
    const cust = await as(http().get('/api/v1/exports?dataset=CUSTOMERS')).expect(200);
    expect(cust.text).toContain('IMP-001');
    await as(http().get('/api/v1/exports?dataset=AUDIT_LOGS'), viewer).expect(403);
    const audit = await http()
      .get('/api/v1/audit-logs?action=EXPORT&entityId=TRIAL_BALANCE')
      .set('Cookie', admin)
      .expect(200);
    expect(audit.body.items.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------- opening balances

  it('opening balances: AR / AP items, opening stock and a migrated asset all reconcile to their control accounts', async () => {
    const asOf = '2026-05-31';
    const customers = await as(http().get('/api/v1/customers?pageSize=5')).expect(200);
    const vendors = await as(http().get('/api/v1/vendors?pageSize=5')).expect(200);
    const before = await as(http().get(`/api/v1/opening-balances/report?asOf=${asOf}`)).expect(200);
    const arBefore = before.body.areas.find((a: { area: string }) => a.area === 'AR');
    // Inactive party or a post-cut-over date is refused before anything is created.
    const bad = await as(http().post('/api/v1/opening-balances/subledger'))
      .send({
        area: 'AR',
        asOfDate: asOf,
        items: [
          {
            partyId: customers.body.items[0].id,
            reference: 'LEGACY-1',
            documentDate: '2026-06-15',
            amount: '1000',
          },
        ],
      })
      .expect(422);
    expect(bad.body.code).toBe('OPENING_BALANCE_INVALID');
    const ar = await as(http().post('/api/v1/opening-balances/subledger'))
      .send({
        area: 'AR',
        asOfDate: asOf,
        idempotencyKey: 'opening-ar-2026',
        items: [
          {
            partyId: customers.body.items[0].id,
            reference: 'LEGACY-1001',
            documentDate: '2026-04-20',
            dueDate: '2026-05-20',
            amount: '25000',
          },
          {
            partyId: customers.body.items[1].id,
            reference: 'LEGACY-1002',
            documentDate: '2026-05-05',
            amount: '12500.5',
          },
        ],
      })
      .expect(201);
    expect(ar.body.created).toBe(2);
    expect(ar.body.total).toBe('37500.5000');
    const ap = await as(http().post('/api/v1/opening-balances/subledger'))
      .send({
        area: 'AP',
        asOfDate: asOf,
        items: [
          {
            partyId: vendors.body.items[0].id,
            reference: 'SUP-77',
            documentDate: '2026-05-10',
            amount: '8000',
          },
        ],
      })
      .expect(201);
    expect(ap.body.created).toBe(1);
    // Replaying the AR load with the same idempotency key creates nothing new.
    const replay = await as(http().post('/api/v1/opening-balances/subledger'))
      .send({
        area: 'AR',
        asOfDate: asOf,
        idempotencyKey: 'opening-ar-2026',
        items: [
          {
            partyId: customers.body.items[0].id,
            reference: 'LEGACY-1001',
            documentDate: '2026-04-20',
            dueDate: '2026-05-20',
            amount: '25000',
          },
          {
            partyId: customers.body.items[1].id,
            reference: 'LEGACY-1002',
            documentDate: '2026-05-05',
            amount: '12500.5',
          },
        ],
      })
      .expect(201);
    expect(replay.body.documents).toEqual(ar.body.documents);

    // Opening stock and a migrated asset.
    const warehouses = await as(http().get('/api/v1/warehouses')).expect(200);
    const products = await as(http().get('/api/v1/products?pageSize=50')).expect(200);
    const product = products.body.items.find((p: { sku: string }) => p.sku === 'MERCH-001');
    const inv = await as(http().post('/api/v1/opening-balances/inventory'))
      .send({
        asOfDate: asOf,
        lines: [
          {
            productId: product.id,
            warehouseId: warehouses.body[0].id,
            quantity: '10',
            unitCost: '200',
          },
        ],
      })
      .expect(201);
    expect(inv.body.total).toBe('2000.0000');
    const categories = await as(http().get('/api/v1/asset-categories')).expect(200);
    const fa = await as(http().post('/api/v1/opening-balances/assets'))
      .send({
        asOfDate: asOf,
        assets: [
          {
            categoryId: categories.body.find((c: { code: string }) => c.code === 'IT').id,
            name: 'Legacy server',
            acquisitionDate: '2025-01-15',
            acquisitionCost: '90000',
            accumulatedDepreciation: '40000',
            usefulLifeMonths: 36,
            reference: 'FA-LEGACY-7',
          },
        ],
      })
      .expect(201);
    expect(fa.body.total).toBe('50000.0000');
    const asset = await as(http().get(`/api/v1/fixed-assets?search=Legacy%20server`)).expect(200);
    expect(asset.body.items[0].status).toBe('ACTIVE');
    expect(asset.body.items[0].accumulatedDepreciation).toBe('40000.0000');

    // Everything reconciles; the AR control moved by exactly the loaded items and equity carries the offsets.
    const report = await as(http().get(`/api/v1/opening-balances/report?asOf=${asOf}`)).expect(200);
    expect(report.body.areas.filter((a: { reconciled: boolean }) => !a.reconciled)).toEqual([]);
    const arAfter = report.body.areas.find((a: { area: string }) => a.area === 'AR');
    expect(Number(arAfter.ledger) - Number(arBefore.ledger)).toBeCloseTo(37500.5, 4);
    expect(report.body.trialBalanceBalanced).toBe(true);
    expect(report.body.reconciled).toBe(true);
    expect(report.body.openingEquity.code).toBe('3900');
    // Credit balance in equity: AR 37,500.5 + stock 2,000 + assets 90,000 - AP 8,000 - accumulated 40,000.
    expect(report.body.openingEquity.balance).toBe('81500.5000');
    // Viewers may read the report but not load balances.
    await as(http().get(`/api/v1/opening-balances/report?asOf=${asOf}`), viewer).expect(200);
    await as(http().post('/api/v1/opening-balances/inventory'), viewer).send({}).expect(403);
  });
});
