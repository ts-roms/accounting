import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { WorkflowDocumentType } from '@accounting/types';
import { NotFoundError } from '@/common/errors/app-error';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  approvalRequests,
  auditLogs,
  bankTransactions,
  customerPayments,
  customers,
  deliveries,
  depreciationRuns,
  expenseClaims,
  fixedAssets,
  fxRevaluations,
  goodsReceipts,
  intercompanyTransactions,
  invoices,
  journalEntries,
  journalLines,
  prepaymentSchedules,
  prepayments,
  recurringJournalRuns,
  recurringJournals,
  stockDocuments,
  users,
  vendorBills,
  vendorPayments,
  vendors,
  writeOffRequests,
} from '@/database/schema';

/**
 * Traceability (H7): follows one journal entry back to the document that
 * produced it, the counterparty on that document, the journals linked to it
 * (reversals, corrections, sibling postings of the same source) and every
 * audit event recorded against the journal and its source. Read-only: it
 * composes existing tables and never derives figures of its own.
 */

export interface TraceSourceDocument {
  /** Base source module (e.g. `AR_DOCUMENT`); the journal's own `sourceType` may carry a suffix such as `_VOID`. */
  sourceType: string;
  /** The journal's exact `sourceType` (distinguishes posting / void / reversal events). */
  event: string;
  id: string;
  documentNumber: string | null;
  status: string | null;
  amount: string | null;
  /** Web route to the document detail (relative). */
  path: string;
  /** Audit `entityType` written by the owning service. */
  entityType: string;
  workflowDocumentType: WorkflowDocumentType | null;
}

export interface TraceParty {
  kind: 'CUSTOMER' | 'VENDOR' | 'EMPLOYEE';
  id: string;
  code: string | null;
  name: string;
  path: string;
}

export interface TraceJournal {
  id: string;
  documentNumber: string;
  status: string;
  entryDate: string;
  journalType: string;
  sourceType: string | null;
  totalDebit: string;
  relation: 'THIS' | 'ORIGINAL' | 'REVERSAL' | 'CORRECTED' | 'CORRECTION' | 'SAME_SOURCE';
}

export interface TraceActor {
  id: string | null;
  email: string | null;
  name: string | null;
}

export interface TraceAuditEvent {
  id: number;
  occurredAt: string;
  action: string;
  module: string;
  entityType: string;
  entityId: string | null;
  user: TraceActor;
  metadata: unknown;
}

export interface TraceApproval {
  id: string;
  documentType: string;
  documentNumber: string;
  status: string;
  amount: string;
  createdAt: string;
}

export interface JournalTrace {
  journal: {
    id: string;
    documentNumber: string;
    status: string;
    journalType: string;
    entryDate: string;
    description: string;
    reference: string | null;
    totalDebit: string;
    totalCredit: string;
    sourceType: string | null;
    sourceId: string | null;
    branchId: string | null;
    createdBy: TraceActor;
    approvedBy: TraceActor;
    postedBy: TraceActor;
    createdAt: string;
    approvedAt: string | null;
    postedAt: string | null;
    lineCount: number;
    accountIds: string[];
  };
  source: TraceSourceDocument | null;
  party: TraceParty | null;
  related: TraceJournal[];
  approvals: TraceApproval[];
  audit: TraceAuditEvent[];
}

type Resolver = (db: Database, companyId: string, id: string) => Promise<Resolved | null>;
interface Resolved {
  documentNumber: string | null;
  status: string | null;
  amount: string | null;
  path: string;
  entityType: string;
  workflowDocumentType: WorkflowDocumentType | null;
  party?: { kind: TraceParty['kind']; id: string } | null;
}

const first = <T>(rows: T[]): T | null => rows[0] ?? null;

/** Resolvers per base source type. Suffixes (`_VOID`, `_REVERSAL`, ...) map onto their base. */
const RESOLVERS: Record<string, Resolver> = {
  /** Reversals / corrections point at the journal they reverse or correct. */
  JOURNAL_REVERSAL: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: journalEntries.documentNumber,
          s: journalEntries.status,
          a: journalEntries.totalDebit,
        })
        .from(journalEntries)
        .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/accounting/journal-entries/${id}`,
        entityType: 'JournalEntry',
        workflowDocumentType: 'JOURNAL_ENTRY',
      }
    );
  },
  AR_DOCUMENT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: invoices.documentNumber,
          s: invoices.status,
          a: invoices.baseTotal,
          p: invoices.customerId,
        })
        .from(invoices)
        .where(and(eq(invoices.companyId, companyId), eq(invoices.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/sales/invoices/${id}`,
        entityType: 'Invoice',
        workflowDocumentType: 'INVOICE',
        party: { kind: 'CUSTOMER', id: r.p },
      }
    );
  },
  AP_DOCUMENT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: vendorBills.documentNumber,
          s: vendorBills.status,
          a: vendorBills.baseTotal,
          p: vendorBills.vendorId,
        })
        .from(vendorBills)
        .where(and(eq(vendorBills.companyId, companyId), eq(vendorBills.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/purchasing/bills/${id}`,
        entityType: 'VendorBill',
        workflowDocumentType: 'VENDOR_BILL',
        party: { kind: 'VENDOR', id: r.p },
      }
    );
  },
  AR_PAYMENT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: customerPayments.documentNumber,
          s: customerPayments.status,
          a: customerPayments.baseAmount,
          p: customerPayments.customerId,
        })
        .from(customerPayments)
        .where(and(eq(customerPayments.companyId, companyId), eq(customerPayments.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/sales/payments/${id}`,
        entityType: 'CustomerPayment',
        workflowDocumentType: 'CUSTOMER_PAYMENT',
        party: { kind: 'CUSTOMER', id: r.p },
      }
    );
  },
  AP_PAYMENT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: vendorPayments.documentNumber,
          s: vendorPayments.status,
          a: vendorPayments.baseAmount,
          p: vendorPayments.vendorId,
        })
        .from(vendorPayments)
        .where(and(eq(vendorPayments.companyId, companyId), eq(vendorPayments.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/purchasing/payments/${id}`,
        entityType: 'VendorPayment',
        workflowDocumentType: 'VENDOR_PAYMENT',
        party: { kind: 'VENDOR', id: r.p },
      }
    );
  },
  EXPENSE_CLAIM: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: expenseClaims.claimNumber,
          s: expenseClaims.status,
          a: expenseClaims.total,
          p: expenseClaims.claimantUserId,
        })
        .from(expenseClaims)
        .where(and(eq(expenseClaims.companyId, companyId), eq(expenseClaims.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/budgeting/expense-claims/${id}`,
        entityType: 'ExpenseClaim',
        workflowDocumentType: 'EXPENSE_CLAIM',
        party: { kind: 'EMPLOYEE', id: r.p },
      }
    );
  },
  BANK_TRANSACTION: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: bankTransactions.documentNumber,
          s: bankTransactions.status,
          a: bankTransactions.amount,
        })
        .from(bankTransactions)
        .where(and(eq(bankTransactions.companyId, companyId), eq(bankTransactions.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/banking/transactions?id=${id}`,
        entityType: 'BankTransaction',
        workflowDocumentType: null,
      }
    );
  },
  FIXED_ASSET: async (db, companyId, id) => {
    const r = first(
      await db
        .select({ n: fixedAssets.assetNumber, s: fixedAssets.status })
        .from(fixedAssets)
        .where(and(eq(fixedAssets.companyId, companyId), eq(fixedAssets.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: null,
        path: `/fixed-assets/assets/${id}`,
        entityType: 'FixedAsset',
        workflowDocumentType: null,
      }
    );
  },
  DEPRECIATION_RUN: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: depreciationRuns.runNumber,
          s: depreciationRuns.status,
          a: depreciationRuns.totalAmount,
        })
        .from(depreciationRuns)
        .where(and(eq(depreciationRuns.companyId, companyId), eq(depreciationRuns.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/fixed-assets/depreciation?id=${id}`,
        entityType: 'DepreciationRun',
        workflowDocumentType: null,
      }
    );
  },
  GOODS_RECEIPT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: goodsReceipts.documentNumber,
          s: goodsReceipts.status,
          p: goodsReceipts.vendorId,
        })
        .from(goodsReceipts)
        .where(and(eq(goodsReceipts.companyId, companyId), eq(goodsReceipts.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: null,
        path: `/purchasing/receipts/${id}`,
        entityType: 'GoodsReceipt',
        workflowDocumentType: null,
        party: r.p ? { kind: 'VENDOR', id: r.p } : null,
      }
    );
  },
  DELIVERY: async (db, companyId, id) => {
    const r = first(
      await db
        .select({ n: deliveries.documentNumber, s: deliveries.status, p: deliveries.customerId })
        .from(deliveries)
        .where(and(eq(deliveries.companyId, companyId), eq(deliveries.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: null,
        path: `/receivables/deliveries/${id}`,
        entityType: 'Delivery',
        workflowDocumentType: null,
        party: { kind: 'CUSTOMER', id: r.p },
      }
    );
  },
  STOCK_ADJUSTMENT: async (db, companyId, id) => stockDocument(db, companyId, id, 'adjustments'),
  STOCK_TRANSFER: async (db, companyId, id) => stockDocument(db, companyId, id, 'transfers'),
  STOCK_COUNT: async (db, companyId, id) => stockDocument(db, companyId, id, 'counts'),
  INTERCOMPANY: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: intercompanyTransactions.documentNumber,
          s: intercompanyTransactions.status,
          a: intercompanyTransactions.amount,
        })
        .from(intercompanyTransactions)
        .where(
          and(
            eq(intercompanyTransactions.id, id),
            or(
              eq(intercompanyTransactions.fromCompanyId, companyId),
              eq(intercompanyTransactions.toCompanyId, companyId),
            ),
          ),
        ),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/accounting/intercompany?id=${id}`,
        entityType: 'IntercompanyTransaction',
        workflowDocumentType: null,
      }
    );
  },
  FX_REVALUATION: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: fxRevaluations.runNumber,
          s: sql<string>`CASE WHEN ${fxRevaluations.reversalJournalEntryId} IS NULL THEN 'POSTED' ELSE 'REVERSED' END`,
        })
        .from(fxRevaluations)
        .where(and(eq(fxRevaluations.companyId, companyId), eq(fxRevaluations.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: null,
        path: `/accounting/fx-revaluation?id=${id}`,
        entityType: 'FxRevaluation',
        workflowDocumentType: null,
      }
    );
  },
  RECURRING_JOURNAL: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          id: recurringJournals.id,
          n: recurringJournals.name,
          s: recurringJournals.status,
        })
        .from(recurringJournalRuns)
        .innerJoin(
          recurringJournals,
          eq(recurringJournals.id, recurringJournalRuns.recurringJournalId),
        )
        .where(and(eq(recurringJournalRuns.companyId, companyId), eq(recurringJournalRuns.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: null,
        path: `/accounting/recurring-journals?id=${r.id}`,
        entityType: 'RecurringJournal',
        workflowDocumentType: null,
      }
    );
  },
  PREPAYMENT: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          id: prepayments.id,
          n: prepayments.name,
          s: prepayments.status,
          a: prepaymentSchedules.amount,
        })
        .from(prepaymentSchedules)
        .innerJoin(prepayments, eq(prepayments.id, prepaymentSchedules.prepaymentId))
        .where(and(eq(prepaymentSchedules.companyId, companyId), eq(prepaymentSchedules.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/accounting/prepayments?id=${r.id}`,
        entityType: 'Prepayment',
        workflowDocumentType: null,
      }
    );
  },
  AR_WRITE_OFF: async (db, companyId, id) => {
    const r = first(
      await db
        .select({
          n: writeOffRequests.documentNumber,
          s: writeOffRequests.status,
          a: writeOffRequests.amount,
          p: writeOffRequests.customerId,
        })
        .from(writeOffRequests)
        .where(and(eq(writeOffRequests.companyId, companyId), eq(writeOffRequests.id, id))),
    );
    return (
      r && {
        documentNumber: r.n,
        status: r.s,
        amount: r.a,
        path: `/receivables/write-offs?id=${id}`,
        entityType: 'WriteOffRequest',
        workflowDocumentType: 'WRITE_OFF',
        party: { kind: 'CUSTOMER', id: r.p },
      }
    );
  },
};

async function stockDocument(
  db: Database,
  companyId: string,
  id: string,
  route: string,
): Promise<Resolved | null> {
  const r = first(
    await db
      .select({ n: stockDocuments.documentNumber, s: stockDocuments.status })
      .from(stockDocuments)
      .where(and(eq(stockDocuments.companyId, companyId), eq(stockDocuments.id, id))),
  );
  return (
    r && {
      documentNumber: r.n,
      status: r.s,
      amount: null,
      path: `/inventory/${route}/${id}`,
      entityType: 'StockDocument',
      workflowDocumentType: null,
    }
  );
}

/** `AR_DOCUMENT_VOID` -> `AR_DOCUMENT`, `FIXED_ASSET_DISPOSAL` -> `FIXED_ASSET`, `PREPAYMENT_RECOGNITION` -> `PREPAYMENT`. */
export function baseSourceType(sourceType: string): string {
  if (RESOLVERS[sourceType]) return sourceType;
  const parts = sourceType.split('_');
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join('_');
    if (RESOLVERS[candidate]) return candidate;
  }
  return sourceType;
}

@Injectable()
export class TraceService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async journal(companyId: string, id: string): Promise<JournalTrace> {
    const [entry] = await this.db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, companyId)));
    if (!entry) throw new NotFoundError('Journal entry', id);

    const actorIds = [entry.createdBy, entry.approvedBy, entry.postedBy].filter((x): x is string =>
      Boolean(x),
    );
    const [lines, actors] = await Promise.all([
      this.db
        .select({ accountId: journalLines.accountId })
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, id)),
      actorIds.length ? this.actors(actorIds) : Promise.resolve(new Map<string, TraceActor>()),
    ]);
    const actor = (uid: string | null): TraceActor =>
      (uid && actors.get(uid)) || { id: uid, email: null, name: null };

    // Source document + party
    let source: TraceSourceDocument | null = null;
    let party: TraceParty | null = null;
    if (entry.sourceType && entry.sourceId) {
      const base = baseSourceType(entry.sourceType);
      const resolved = RESOLVERS[base]
        ? await RESOLVERS[base](this.db, companyId, entry.sourceId)
        : null;
      source = {
        sourceType: base,
        event: entry.sourceType,
        id: entry.sourceId,
        documentNumber: resolved?.documentNumber ?? null,
        status: resolved?.status ?? null,
        amount: resolved?.amount ?? null,
        path: resolved?.path ?? '',
        entityType: resolved?.entityType ?? base,
        workflowDocumentType: resolved?.workflowDocumentType ?? null,
      };
      if (resolved?.party) party = await this.party(resolved.party.kind, resolved.party.id);
    }

    // Related journals: reversal chain, correction chain and other postings of the same source.
    const related: TraceJournal[] = [];
    const pick = {
      id: journalEntries.id,
      documentNumber: journalEntries.documentNumber,
      status: journalEntries.status,
      entryDate: journalEntries.entryDate,
      journalType: journalEntries.journalType,
      sourceType: journalEntries.sourceType,
      totalDebit: journalEntries.totalDebit,
    };
    const linkIds: Array<[string | null, TraceJournal['relation']]> = [
      [entry.reversalOfId, 'ORIGINAL'],
      [entry.reversedById, 'REVERSAL'],
      [entry.correctionOfId, 'CORRECTED'],
    ];
    const wanted = linkIds.filter(([lid]) => lid).map(([lid]) => lid!);
    const correction = await this.db
      .select(pick)
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.correctionOfId, id)));
    for (const c of correction) related.push({ ...c, relation: 'CORRECTION' });
    if (wanted.length) {
      const rows = await this.db
        .select(pick)
        .from(journalEntries)
        .where(inArray(journalEntries.id, wanted));
      for (const r of rows) {
        const relation = linkIds.find(([lid]) => lid === r.id)![1];
        related.push({ ...r, relation });
      }
    }
    if (entry.sourceId) {
      const siblings = await this.db
        .select(pick)
        .from(journalEntries)
        .where(
          and(
            eq(journalEntries.companyId, companyId),
            eq(journalEntries.sourceId, entry.sourceId),
            sql`${journalEntries.id} <> ${id}`,
          ),
        )
        .orderBy(journalEntries.entryDate);
      for (const s of siblings)
        if (!related.some((r) => r.id === s.id)) related.push({ ...s, relation: 'SAME_SOURCE' });
    }

    // Approval requests on the journal itself and on its source document.
    const approvalTargets: Array<{ type: WorkflowDocumentType; id: string }> = [
      { type: 'JOURNAL_ENTRY', id },
    ];
    if (source?.workflowDocumentType)
      approvalTargets.push({ type: source.workflowDocumentType, id: source.id });
    const approvals = await this.db
      .select({
        id: approvalRequests.id,
        documentType: approvalRequests.documentType,
        documentNumber: approvalRequests.documentNumber,
        status: approvalRequests.status,
        amount: approvalRequests.amount,
        createdAt: approvalRequests.createdAt,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.companyId, companyId),
          or(
            ...approvalTargets.map((t) =>
              and(eq(approvalRequests.documentType, t.type), eq(approvalRequests.documentId, t.id)),
            ),
          )!,
        ),
      )
      .orderBy(desc(approvalRequests.createdAt));

    // Audit trail of the journal and of the source document, newest first.
    const auditTargets: Array<[string, string]> = [['JournalEntry', id]];
    if (source) auditTargets.push([source.entityType, source.id]);
    const audit = await this.db
      .select({
        id: auditLogs.id,
        occurredAt: auditLogs.occurredAt,
        action: auditLogs.action,
        module: auditLogs.module,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        userId: auditLogs.userId,
        userEmail: auditLogs.userEmail,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          or(
            ...auditTargets.map(([t, eid]) =>
              and(eq(auditLogs.entityType, t), eq(auditLogs.entityId, eid)),
            ),
          )!,
        ),
      )
      .orderBy(desc(auditLogs.occurredAt), desc(auditLogs.id))
      .limit(200);

    return {
      journal: {
        id: entry.id,
        documentNumber: entry.documentNumber,
        status: entry.status,
        journalType: entry.journalType,
        entryDate: entry.entryDate,
        description: entry.description,
        reference: entry.reference,
        totalDebit: entry.totalDebit,
        totalCredit: entry.totalCredit,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
        branchId: entry.branchId,
        createdBy: actor(entry.createdBy),
        approvedBy: actor(entry.approvedBy),
        postedBy: actor(entry.postedBy),
        createdAt: entry.createdAt.toISOString(),
        approvedAt: entry.approvedAt?.toISOString() ?? null,
        postedAt: entry.postedAt?.toISOString() ?? null,
        lineCount: lines.length,
        accountIds: [...new Set(lines.map((l) => l.accountId))],
      },
      source,
      party,
      related,
      approvals: approvals.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
      audit: audit.map((a) => ({
        id: a.id,
        occurredAt: a.occurredAt.toISOString(),
        action: a.action,
        module: a.module,
        entityType: a.entityType,
        entityId: a.entityId,
        user: {
          id: a.userId,
          email: a.userEmail,
          name: (a.userId && actors.get(a.userId)?.name) || null,
        },
        metadata: a.metadata,
      })),
    };
  }

  /** Journals produced by one source document (the reverse direction: document -> ledger). */
  async document(companyId: string, sourceId: string): Promise<TraceJournal[]> {
    const rows = await this.db
      .select({
        id: journalEntries.id,
        documentNumber: journalEntries.documentNumber,
        status: journalEntries.status,
        entryDate: journalEntries.entryDate,
        journalType: journalEntries.journalType,
        sourceType: journalEntries.sourceType,
        totalDebit: journalEntries.totalDebit,
      })
      .from(journalEntries)
      .where(and(eq(journalEntries.companyId, companyId), eq(journalEntries.sourceId, sourceId)))
      .orderBy(journalEntries.entryDate, journalEntries.documentNumber);
    return rows.map((r) => ({ ...r, relation: 'SAME_SOURCE' as const }));
  }

  private async actors(ids: string[]): Promise<Map<string, TraceActor>> {
    const rows = await this.db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
      })
      .from(users)
      .where(inArray(users.id, ids));
    return new Map(
      rows.map((u) => [
        u.id,
        { id: u.id, email: u.email, name: `${u.firstName} ${u.lastName}`.trim() },
      ]),
    );
  }

  private async party(kind: TraceParty['kind'], id: string): Promise<TraceParty | null> {
    if (kind === 'CUSTOMER') {
      const [c] = await this.db
        .select({ code: customers.code, name: customers.name })
        .from(customers)
        .where(eq(customers.id, id));
      return c ? { kind, id, code: c.code, name: c.name, path: `/sales/customers/${id}` } : null;
    }
    if (kind === 'VENDOR') {
      const [v] = await this.db
        .select({ code: vendors.code, name: vendors.name })
        .from(vendors)
        .where(eq(vendors.id, id));
      return v ? { kind, id, code: v.code, name: v.name, path: `/purchasing/vendors/${id}` } : null;
    }
    const [u] = await this.db
      .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, id));
    return u
      ? {
          kind,
          id,
          code: u.email,
          name: `${u.firstName} ${u.lastName}`.trim(),
          path: `/admin/users?id=${id}`,
        }
      : null;
  }
}
