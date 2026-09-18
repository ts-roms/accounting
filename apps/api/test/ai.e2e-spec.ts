import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '@/app.module';
import { configureApp } from '@/app.setup';
import { runMigrations } from '@/database/migrate';
import { runSeed } from '@/database/seed/seed';

// Scanned images are read locally by tesseract.js (language data is cached under STORAGE_DIR).
process.env.OCR_PROVIDER = 'TESSERACT';
const DB_URL = process.env.DATABASE_URL!;
const ADMIN = { email: 'admin@acme.local', password: 'P@ssw0rd123' };
const FINANCE = { email: 'finance@acme.local', password: 'P@ssw0rd123' };
const VIEWER = { email: 'viewer@acme.local', password: 'P@ssw0rd123' };
const CSRF = { 'x-requested-with': 'XMLHttpRequest' };
type Cookies = string[];

const INVOICE_TEXT = `Metro Wholesale Distributors
TIN: 444-555-666-000
INVOICE
Invoice No: MWD-2026-0099
Invoice Date: 2026-03-05
Due Date: 2026-04-04
Bill To: Acme Trading Corporation

Description                     Qty   Unit Price   Amount
Printer paper A4 (box)           10     450.00     4,500.00
Toner cartridge                   2   3,200.00     6,400.00

Subtotal                                          10,900.00
Total Amount Due                              PHP 10,900.00
`;

/**
 * Phase 9 - AI assistance is advisory: intake produces DRAFT documents through
 * the real services, classification and anomaly flags are suggestions, the
 * assistant answers from posted reports only, and nothing here posts.
 */
describe('AI assistance (e2e)', () => {
  let app: INestApplication;
  let pool: Pool;
  let admin: Cookies;
  let finance: Cookies;
  let viewer: Cookies;
  let companyId: string;
  const acc: Record<string, string> = {};
  let vendorId: string;

  const http = () => request(app.getHttpServer());
  const as = (req: request.Test, who: Cookies = admin) =>
    req.set('Cookie', who).set('x-company-id', companyId).set(CSRF);
  const login = async (creds: { email: string; password: string }): Promise<Cookies> => {
    const res = await http().post('/api/v1/auth/login').send(creds).expect(200);
    return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]!);
  };
  const postedBill = async (
    vendor: string,
    date: string,
    ref: string,
    amount: string,
    descriptions = [`Supplies ${ref}`],
  ) => {
    const bill = await as(http().post('/api/v1/bills'))
      .send({
        vendorId: vendor,
        documentDate: date,
        vendorInvoiceNumber: ref,
        lines: descriptions.map((description) => ({
          description,
          unitPrice: amount,
          accountId: acc['6400'],
        })),
      })
      .expect(201);
    await as(http().post(`/api/v1/bills/${bill.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/bills/${bill.body.id}/post`), finance).expect(201);
    return bill.body as { id: string; documentNumber: string; total: string };
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
    viewer = await login(VIEWER);
    const companies = await http().get('/api/v1/companies').set('Cookie', admin).expect(200);
    companyId = companies.body.find((c: { code: string }) => c.code === 'ACME').id;
    const chart = await as(http().get('/api/v1/accounts')).expect(200);
    for (const a of chart.body) acc[a.code] = a.id;
    const vendors = await as(http().get('/api/v1/vendors?pageSize=50')).expect(200);
    vendorId = vendors.body.items.find((v: { code: string }) => v.code === 'VEND-001').id;
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it('reports the provider and that everything is advisory', async () => {
    const res = await as(http().get('/api/v1/ai/status')).expect(200);
    expect(res.body).toEqual({
      provider: 'HEURISTIC',
      model: null,
      ocr: 'TESSERACT',
      advisoryOnly: true,
    });
    // Viewers may look (ai.view) but not use.
    await as(http().get('/api/v1/ai/status'), viewer).expect(200);
    await as(http().post('/api/v1/ai/ask'), viewer).send({ question: 'revenue' }).expect(403);
  });

  it('intake extracts a text invoice, matches the vendor by TIN and drafts a bill that stays DRAFT', async () => {
    // History so the classifier has something to learn from.
    await postedBill(vendorId, '2026-01-15', 'MWD-H1', '2100', [
      'Printer paper A4 box',
      'Toner cartridge HP',
    ]);
    const up = await as(http().post('/api/v1/ai/intake'))
      .attach('file', Buffer.from(INVOICE_TEXT), {
        filename: 'mwd-0099.txt',
        contentType: 'text/plain',
      })
      .expect(201);
    expect(up.body.status).toBe('EXTRACTED');
    expect(up.body.kind).toBe('BILL');
    expect(up.body.vendorId).toBe(vendorId);
    expect(up.body.vendorName).toBe('Metro Wholesale Distributors');
    expect(up.body.extracted.reference).toBe('MWD-2026-0099');
    expect(up.body.extracted.total).toBe('10900.0000');
    expect(up.body.extracted.lines).toHaveLength(2);
    expect(up.body.extracted.lineSuggestions[0].accountCode).toBe('6400');
    expect(up.body.attachmentId).toBeTruthy();
    expect(Number(up.body.confidence)).toBeGreaterThanOrEqual(0.9);

    // Viewers can't upload; reviewers without bill.create can't draft a bill.
    await as(http().post('/api/v1/ai/intake'), viewer)
      .attach('file', Buffer.from('x'), { filename: 'x.txt', contentType: 'text/plain' })
      .expect(403);

    const drafted = await as(http().post(`/api/v1/ai/intake/${up.body.id}/draft`))
      .send({ kind: 'BILL' })
      .expect(201);
    expect(drafted.body.status).toBe('DRAFTED');
    expect(drafted.body.draftBillId).toBeTruthy();
    expect(drafted.body.warnings).toEqual([]);
    const bill = await as(http().get(`/api/v1/bills/${drafted.body.draftBillId}`)).expect(200);
    expect(bill.body.status).toBe('DRAFT');
    expect(bill.body.accountingStatus).toBe('UNPOSTED');
    expect(bill.body.total).toBe('10900.0000');
    expect(bill.body.vendorInvoiceNumber).toBe('MWD-2026-0099');
    expect(bill.body.lines.map((l: { accountId: string }) => l.accountId)).toEqual([
      acc['6400'],
      acc['6400'],
    ]);
    // The source file now hangs off the bill.
    const files = await as(http().get(`/api/v1/attachments/BILL/${bill.body.id}`)).expect(200);
    expect(files.body.map((f: { fileName: string }) => f.fileName)).toEqual(['mwd-0099.txt']);
    // No journal was created by the intake.
    const je = await as(http().get('/api/v1/journal-entries?search=mwd-0099')).expect(200);
    expect(je.body.total).toBe(0);
    await as(http().post(`/api/v1/ai/intake/${up.body.id}/draft`))
      .send({ kind: 'BILL' })
      .expect(422);
  });

  it('a scanned image is read by OCR and extracted like a text upload (no model needed)', async () => {
    const png = readFileSync(path.join(__dirname, 'fixtures', 'scanned-invoice.png'));
    const up = await as(http().post('/api/v1/ai/intake'))
      .attach('file', png, { filename: 'scan.png', contentType: 'image/png' })
      .expect(201);
    expect(up.body.status).toBe('EXTRACTED');
    expect(up.body.kind).toBe('BILL');
    expect(up.body.provider).toBe('HEURISTIC');
    expect(up.body.vendorId).toBe(vendorId); // matched by the TIN read off the image
    expect(up.body.extracted.reference).toBe('MWD-2026-0100');
    expect(up.body.extracted.total).toBe('12208.0000');
    expect(up.body.extracted.lines.length).toBeGreaterThanOrEqual(2);
    const detail = await as(http().get(`/api/v1/ai/intake/${up.body.id}`)).expect(200);
    expect(detail.body.sourceText).toContain('Metro Wholesale Distributors');
    expect(detail.body.error).toBeNull();
  }, 120_000);

  it('unreadable uploads land in NEEDS_REVIEW, can be corrected and dismissed', async () => {
    const up = await as(http().post('/api/v1/ai/intake'))
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF'), {
        filename: 'blank.pdf',
        contentType: 'application/pdf',
      })
      .expect(201);
    expect(up.body.status).toBe('NEEDS_REVIEW');
    const fixed = await as(http().patch(`/api/v1/ai/intake/${up.body.id}`))
      .send({
        kind: 'EXPENSE_CLAIM',
        extracted: {
          vendorName: 'Taxi',
          documentDate: '2026-03-08',
          total: '350',
          lines: [
            {
              description: 'Taxi to client',
              quantity: '1',
              unitPrice: '350',
              accountId: acc['6400'],
            },
          ],
        },
      })
      .expect(200);
    expect(fixed.body.status).toBe('EXTRACTED');
    expect(fixed.body.extracted.lines[0].unitPrice).toBe('350');
    const dismissed = await as(http().post(`/api/v1/ai/intake/${up.body.id}/dismiss`))
      .send({ reason: 'not a business expense' })
      .expect(201);
    expect(dismissed.body.status).toBe('DISMISSED');
    const list = await as(http().get('/api/v1/ai/intake?status=DISMISSED')).expect(200);
    expect(list.body.total).toBe(1);
  });

  it('classifies a description from posting history', async () => {
    const res = await as(http().post('/api/v1/ai/classify'))
      .send({ description: 'Toner cartridge for the printer', side: 'PURCHASE', partyId: vendorId })
      .expect(201);
    expect(res.body[0].accountCode).toBe('6400');
    expect(res.body[0].confidence).toBeGreaterThan(0.5);
    expect(res.body[0].rationale).toContain('used');
  });

  it('anomaly scan flags a duplicate bill and a manual control posting, re-scans do not duplicate, decisions are recorded', async () => {
    const a = await postedBill(vendorId, '2026-05-02', 'DUP-77', '9999');
    // Exact re-use of a vendor invoice number is already blocked by the bill itself (409/422),
    // so the near-duplicate differs in reference and is two days apart.
    const b = await postedBill(vendorId, '2026-05-04', 'DUP-77A', '9999');
    // A manual journal straight onto accounts payable.
    const je = await as(http().post('/api/v1/journal-entries'))
      .send({
        entryDate: '2026-05-06',
        description: 'Manual AP adjustment',
        lines: [
          { accountId: acc['2110'], debit: '10000', credit: '0', description: 'AP' },
          { accountId: acc['6400'], debit: '0', credit: '10000', description: 'Expense' },
        ],
      })
      .expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/submit`)).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/approve`), finance).expect(201);
    await as(http().post(`/api/v1/journal-entries/${je.body.id}/post`), finance).expect(201);

    const scan = await as(http().post('/api/v1/ai/anomalies/scan'))
      .send({ from: '2026-05-01', to: '2026-05-31' })
      .expect(201);
    const types = scan.body.items.map(
      (i: { anomalyType: string; entityId: string }) => `${i.anomalyType}:${i.entityId}`,
    );
    expect(types).toContain(`DUPLICATE_DOCUMENT:${b.id}`);
    expect(types).not.toContain(`DUPLICATE_DOCUMENT:${a.id}`);
    expect(types).toContain(`MANUAL_CONTROL_POSTING:${je.body.id}`);
    expect(types).toContain(`ROUND_AMOUNT:${je.body.id}`);
    expect(scan.body.new).toBe(scan.body.flagged);

    const again = await as(http().post('/api/v1/ai/anomalies/scan'))
      .send({ from: '2026-05-01', to: '2026-05-31' })
      .expect(201);
    expect(again.body.new).toBe(0);
    expect(again.body.flagged).toBe(scan.body.flagged);
    const summary = await as(http().get('/api/v1/ai/anomalies/summary')).expect(200);
    expect(summary.body.open).toBe(scan.body.flagged);
    expect(summary.body.high).toBeGreaterThanOrEqual(2);

    const dup = scan.body.items.find(
      (i: { anomalyType: string }) => i.anomalyType === 'DUPLICATE_DOCUMENT',
    );
    const decided = await as(http().post(`/api/v1/ai/anomalies/${dup.id}/decide`), finance)
      .send({ decision: 'ACCEPT', note: 'Confirmed - voiding the second bill' })
      .expect(201);
    expect(decided.body.status).toBe('ACCEPTED');
    expect(decided.body.decidedByName).toBe('Marco Santos');
    await as(http().post(`/api/v1/ai/anomalies/${dup.id}/decide`), finance)
      .send({ decision: 'DISMISS' })
      .expect(422);
    const open = await as(http().get('/api/v1/ai/anomalies?status=OPEN')).expect(200);
    expect(open.body.total).toBe(scan.body.flagged - 1);
    // Flags never touched the ledger: both bills are still posted and the trial balance balances.
    const tb = await as(
      http().get('/api/v1/reports/trial-balance?from=2026-01-01&to=2026-12-31'),
    ).expect(200);
    expect(tb.body.balanced).toBe(true);
    await as(http().post('/api/v1/ai/anomalies/scan'), viewer)
      .send({ from: '2026-05-01', to: '2026-05-31' })
      .expect(403);
  });

  it('the assistant answers from posted reports, cites sources and respects permissions', async () => {
    const is = await as(
      http().get('/api/v1/reports/income-statement?from=2026-05-01&to=2026-05-31'),
    ).expect(200);
    const ask = await as(http().post('/api/v1/ai/ask'))
      .send({ question: 'What were our expenses in May 2026?' })
      .expect(201);
    expect(ask.body.intent).toBe('EXPENSES');
    expect(ask.body.answer.role).toBe('ASSISTANT');
    expect(ask.body.answer.provider).toBe('HEURISTIC');
    const expenses = ask.body.answer.sources.find((s: { label: string }) =>
      s.label.startsWith('Operating expenses'),
    );
    expect(expenses.value).toContain('PHP');
    expect(expenses.value.replace(/[^0-9.]/g, '')).toBe(
      Number(is.body.expenses.total)
        .toFixed(2)
        .replace(/[^0-9.]/g, ''),
    );
    expect(ask.body.answer.content).toContain('May 2026');

    const followUp = await as(http().post('/api/v1/ai/ask'))
      .send({
        question: 'And which vendors do we owe the most?',
        conversationId: ask.body.conversationId,
      })
      .expect(201);
    expect(followUp.body.intent).toBe('TOP_VENDORS');
    expect(followUp.body.answer.sources[0].report).toBe('AP aging');
    const convo = await as(
      http().get(`/api/v1/ai/conversations/${ask.body.conversationId}`),
    ).expect(200);
    expect(convo.body.messages).toHaveLength(4);
    // Another user cannot read this conversation.
    await as(http().get(`/api/v1/ai/conversations/${ask.body.conversationId}`), finance).expect(
      404,
    );
    // Unknown questions get the help text, never invented numbers.
    const unknown = await as(http().post('/api/v1/ai/ask'))
      .send({ question: 'Should I buy bitcoin?' })
      .expect(201);
    expect(unknown.body.answer.sources).toEqual([]);
    expect(unknown.body.answer.content).toContain('do not');
  });

  it('forecasts from monthly posted history', async () => {
    const res = await as(
      http().get('/api/v1/ai/forecast?metric=EXPENSES&history=6&horizon=3'),
    ).expect(200);
    expect(res.body.history).toHaveLength(6);
    expect(res.body.forecast).toHaveLength(3);
    expect(res.body.history.some((p: { value: string }) => Number(p.value) > 0)).toBe(true);
    expect(res.body.currency).toBe('PHP');
    expect(res.body.forecast[0].period > res.body.history[5].period).toBe(true);
    expect(res.body.note).toContain('baseline');
  });
});
