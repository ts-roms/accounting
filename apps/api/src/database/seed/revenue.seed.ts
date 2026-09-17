import { and, eq } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { RevenueMilestone, RevenueRecognitionMethod } from '@accounting/types';
import { buildSchedule } from '@/modules/revenue/revenue.logic';
import * as schema from '../schema';
import type { Tx } from './seed';
import { allocateNumber, insertEntry } from './seed-ledger';

type Log = (message: string) => void;

/**
 * Revenue recognition demo (Prompt #10) for ACME: three policies, an annual
 * support plan recognized ratably and an implementation project earned per
 * milestone, with the June - August recognition runs already posted the way
 * `RevenueRunsService` posts them (one ADJUSTING journal per run, the run as
 * source identity). Dated May - August only: the accounting e2e suite pins the
 * January - April income statement and the tax suite pins September.
 */
export async function seedRevenue(
  tx: Tx,
  company: schema.Company,
  codeToId: Map<string, string>,
  adminUserId: string,
  log: Log,
): Promise<void> {
  if (company.code !== 'ACME') return;
  const [existing] = await tx
    .select({ id: schema.revenuePolicies.id })
    .from(schema.revenuePolicies)
    .where(eq(schema.revenuePolicies.companyId, company.id));
  if (existing) return;

  const currency = company.baseCurrency;
  const now = new Date();
  const ar = codeToId.get('1200')!;
  const service = codeToId.get('4200')!;
  const vat = codeToId.get('2130')!;
  const deferred = codeToId.get('2190')!;

  // ----------------------------------------------------------------- policies
  const POLICIES: Array<{
    code: string;
    name: string;
    method: RevenueRecognitionMethod;
    description: string;
    defaultTermMonths?: number;
  }> = [
    {
      code: 'RATABLE-SVC',
      name: 'Ratable over service period',
      method: 'RATABLE',
      description:
        'Subscriptions, support plans and retainers earned evenly by day over the service window.',
      defaultTermMonths: 12,
    },
    {
      code: 'MILESTONE',
      name: 'Milestone billing',
      method: 'MILESTONE',
      description: 'Projects invoiced up-front and earned as each milestone is accepted.',
    },
    {
      code: 'POINT',
      name: 'Point in time',
      method: 'POINT_IN_TIME',
      description: 'Goods and one-off services earned when invoiced.',
    },
  ];
  const policyIds = new Map<string, string>();
  for (const p of POLICIES) {
    const [row] = await tx
      .insert(schema.revenuePolicies)
      .values({
        companyId: company.id,
        code: p.code,
        name: p.name,
        method: p.method,
        description: p.description,
        defaultTermMonths: p.defaultTermMonths ?? null,
      })
      .returning({ id: schema.revenuePolicies.id });
    policyIds.set(p.code, row!.id);
  }
  await tx
    .insert(schema.revenueSettings)
    .values({ companyId: company.id, autoRecognize: false, overdueGraceDays: 5 })
    .onConflictDoNothing();

  const customerId = async (code: string): Promise<string> => {
    const [row] = await tx
      .select({ id: schema.customers.id })
      .from(schema.customers)
      .where(and(eq(schema.customers.companyId, company.id), eq(schema.customers.code, code)));
    if (!row) throw new Error(`Seed: customer ${code} missing`);
    return row.id;
  };

  // ------------------------------------------------- deferred invoices + runs
  interface Deferred {
    customer: string;
    date: string;
    due: string;
    reference: string;
    description: string;
    net: string;
    policy: string;
    serviceStart?: string;
    serviceEnd?: string;
    milestones?: RevenueMilestone[];
    /** Milestone name -> completion date. */
    completed?: Record<string, string>;
  }
  const INVOICES: Deferred[] = [
    {
      customer: 'CUST-003',
      date: '2026-06-01',
      due: '2026-07-16',
      reference: 'SUP-2026-ANNUAL',
      description: 'Annual support plan Jun 2026 - May 2027',
      net: '120000',
      policy: 'RATABLE-SVC',
      serviceStart: '2026-06-01',
      serviceEnd: '2027-05-31',
    },
    {
      customer: 'CUST-005',
      date: '2026-07-15',
      due: '2026-08-14',
      reference: 'PRJ-ERP-ROLLOUT',
      description: 'ERP rollout - implementation project',
      net: '90000',
      policy: 'MILESTONE',
      milestones: [
        { name: 'Kick-off', percent: '30', expectedDate: '2026-07-15' },
        { name: 'Configuration accepted', percent: '40', expectedDate: '2026-08-20' },
        { name: 'Go-live', percent: '30', expectedDate: '2026-10-15' },
      ],
      completed: { 'Kick-off': '2026-07-15', 'Configuration accepted': '2026-08-20' },
    },
  ];

  const scheduleLines: Array<{
    id: string;
    scheduleId: string;
    recognitionDate: string | null;
    amount: string;
    description: string;
    milestoneName: string | null;
    completed: boolean;
  }> = [];

  for (const inv of INVOICES) {
    const net = Money.parse(inv.net, currency);
    const tax = net.multiply('0.12');
    const total = net.add(tax);
    const documentNumber = await allocateNumber(tx, company.id, 'INV', inv.date);
    const custId = await customerId(inv.customer);
    const policyId = policyIds.get(inv.policy)!;
    const policy = POLICIES.find((p) => p.code === inv.policy)!;
    const [row] = await tx
      .insert(schema.invoices)
      .values({
        companyId: company.id,
        customerId: custId,
        documentType: 'INVOICE',
        documentNumber,
        documentDate: inv.date,
        dueDate: inv.due,
        reference: inv.reference,
        description: inv.description,
        currency,
        subtotal: total.toString(),
        taxTotal: '0',
        total: total.toString(),
        baseTotal: total.toString(),
        status: 'APPROVED',
        accountingStatus: 'UNPOSTED',
        createdBy: adminUserId,
        approvedBy: adminUserId,
        approvedAt: now,
        paymentTermId: null,
      })
      .returning({ id: schema.invoices.id });
    const [line] = await tx
      .insert(schema.invoiceLines)
      .values({
        invoiceId: row!.id,
        lineNumber: 1,
        description: inv.description,
        quantity: '1',
        unitPrice: net.toString(),
        amount: net.toString(),
        accountId: service,
        revenuePolicyId: policyId,
        serviceStartDate: inv.serviceStart ?? null,
        serviceEndDate: inv.serviceEnd ?? null,
        milestones: inv.milestones ?? [],
      })
      .returning({ id: schema.invoiceLines.id });
    await tx.insert(schema.invoiceLines).values({
      invoiceId: row!.id,
      lineNumber: 2,
      description: 'Output VAT 12%',
      quantity: '1',
      unitPrice: tax.toString(),
      amount: tax.toString(),
      accountId: vat,
    });
    // Posting credits deferred revenue instead of the service revenue account.
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: inv.date,
        description: `Invoice ${documentNumber} - ${inv.description}`,
        reference: inv.reference,
        sourceType: 'AR_DOCUMENT',
        sourceId: row!.id,
        status: 'POSTED',
        lines: [
          {
            accountId: ar,
            debit: total.toString(),
            memo: `${documentNumber} - customer receivable`,
          },
          { accountId: deferred, credit: net.toString(), memo: inv.description },
          { accountId: vat, credit: tax.toString(), memo: 'Output VAT 12%' },
        ],
      },
      adminUserId,
    );
    await tx
      .update(schema.invoices)
      .set({
        accountingStatus: 'POSTED',
        journalEntryId: entryId,
        postedBy: adminUserId,
        postedAt: now,
      })
      .where(eq(schema.invoices.id, row!.id));

    const built = buildSchedule({
      method: policy.method,
      amount: net.toString(),
      currency,
      documentDate: inv.date,
      serviceStartDate: inv.serviceStart ?? null,
      serviceEndDate: inv.serviceEnd ?? null,
      defaultTermMonths: policy.defaultTermMonths ?? null,
      milestones: inv.milestones ?? [],
    });
    const [schedule] = await tx
      .insert(schema.revenueSchedules)
      .values({
        companyId: company.id,
        invoiceId: row!.id,
        invoiceLineId: line!.id,
        customerId: custId,
        policyId,
        method: policy.method,
        description: `${documentNumber} - ${inv.description}`,
        currency,
        totalAmount: net.toString(),
        deferredAccountId: deferred,
        revenueAccountId: service,
        serviceStartDate: built.serviceStart,
        serviceEndDate: built.serviceEnd,
      })
      .returning({ id: schema.revenueSchedules.id });
    for (const l of built.lines) {
      const completedOn = l.milestoneName ? inv.completed?.[l.milestoneName] : undefined;
      const [inserted] = await tx
        .insert(schema.revenueScheduleLines)
        .values({
          scheduleId: schedule!.id,
          sequence: l.sequence,
          recognitionDate: completedOn ?? l.recognitionDate,
          amount: l.amount,
          milestoneName: l.milestoneName,
          milestonePercent: l.milestonePercent,
          completedAt: completedOn ? new Date(`${completedOn}T08:00:00Z`) : null,
          completedBy: completedOn ? adminUserId : null,
          completionNote: completedOn ? 'Accepted by the customer' : null,
        })
        .returning({ id: schema.revenueScheduleLines.id });
      scheduleLines.push({
        id: inserted!.id,
        scheduleId: schedule!.id,
        recognitionDate: completedOn ?? l.recognitionDate,
        amount: l.amount,
        description: `${documentNumber} - ${inv.description}`,
        milestoneName: l.milestoneName,
        completed: Boolean(completedOn),
      });
    }
  }

  // Month-end runs June - August, each recognizing what fell due since the last one.
  const RUNS = ['2026-06-30', '2026-07-31', '2026-08-31'];
  let previous = '0000-00-00';
  for (const periodEnd of RUNS) {
    const due = scheduleLines.filter(
      (l) =>
        l.recognitionDate &&
        l.recognitionDate > previous &&
        l.recognitionDate <= periodEnd &&
        (l.milestoneName === null || l.completed),
    );
    previous = periodEnd;
    if (due.length === 0) continue;
    const total = Money.sum(
      due.map((l) => Money.of(l.amount, currency)),
      currency,
    );
    const documentNumber = await allocateNumber(tx, company.id, 'RRN', periodEnd);
    const [run] = await tx
      .insert(schema.revenueRecognitionRuns)
      .values({
        companyId: company.id,
        documentNumber,
        periodEnd,
        description: 'Month-end recognition',
        currency,
        totalAmount: total.toString(),
        lineCount: due.length,
        createdBy: adminUserId,
      })
      .returning({ id: schema.revenueRecognitionRuns.id });
    const entryId = await insertEntry(
      tx,
      company,
      {
        date: periodEnd,
        description: `Revenue recognition ${documentNumber} - Month-end recognition`,
        reference: documentNumber,
        journalType: 'ADJUSTING',
        sourceType: 'REVENUE_RECOGNITION_RUN',
        sourceId: run!.id,
        status: 'POSTED',
        lines: due.flatMap((l) => [
          { accountId: deferred, debit: l.amount, memo: l.description },
          {
            accountId: service,
            credit: l.amount,
            memo: l.milestoneName ? `${l.description} - ${l.milestoneName}` : l.description,
          },
        ]),
      },
      adminUserId,
    );
    await tx
      .update(schema.revenueRecognitionRuns)
      .set({ journalEntryId: entryId })
      .where(eq(schema.revenueRecognitionRuns.id, run!.id));
    for (const l of due) {
      await tx
        .update(schema.revenueScheduleLines)
        .set({ status: 'RECOGNIZED', runId: run!.id, journalEntryId: entryId, recognizedAt: now })
        .where(eq(schema.revenueScheduleLines.id, l.id));
    }
    for (const scheduleId of new Set(due.map((l) => l.scheduleId))) {
      const recognized = Money.sum(
        scheduleLines
          .filter(
            (l) =>
              l.scheduleId === scheduleId &&
              l.recognitionDate &&
              l.recognitionDate <= periodEnd &&
              (l.milestoneName === null || l.completed),
          )
          .map((l) => Money.of(l.amount, currency)),
        currency,
      );
      await tx
        .update(schema.revenueSchedules)
        .set({ recognizedAmount: recognized.toString() })
        .where(eq(schema.revenueSchedules.id, scheduleId));
    }
  }
  log(
    `Revenue recognition seeded for ${company.code} (${POLICIES.length} policies, ${INVOICES.length} deferred invoices, ${RUNS.length} runs)`,
  );
}
