import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte, ne, sql, type SQL } from 'drizzle-orm';
import type { PaginatedResult } from '@accounting/types';
import type {
  AiAnomalyScanInput,
  DecideAiSuggestionInput,
  ListAiAnomaliesQuery,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accountMappings,
  accounts,
  aiSuggestions,
  customers,
  invoices,
  journalEntries,
  journalLines,
  users,
  vendorBills,
  vendors,
  type AiSuggestion,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import {
  detectAnomalies,
  stats,
  type AnomalyDocument,
  type AnomalyJournal,
  type PartyStat,
} from './ai.logic';

const MODULE = 'AI';
/** Subledger control accounts that a manual journal should never touch directly. */
const CONTROL_KEYS = [
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'INVENTORY',
  'EMPLOYEE_PAYABLE',
] as const;

export interface AiAnomalyView extends AiSuggestion {
  decidedByName: string | null;
}

export interface ScanResult {
  from: string;
  to: string;
  scanned: { documents: number; journals: number };
  flagged: number;
  new: number;
  items: AiAnomalyView[];
}

/**
 * Anomaly detection over posted data. Detectors are pure (`ai.logic.ts`);
 * this service gathers the inputs, stores flags keyed by fingerprint so a
 * re-scan never duplicates, and records the reviewer's decision. Flags never
 * change the ledger - they point people at what to look at.
 */
@Injectable()
export class AiAnomalyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(
    companyId: string,
    query: ListAiAnomaliesQuery,
  ): Promise<PaginatedResult<AiAnomalyView>> {
    const filters: SQL[] = [eq(aiSuggestions.companyId, companyId)];
    if (query.status) filters.push(eq(aiSuggestions.status, query.status));
    if (query.severity) filters.push(eq(aiSuggestions.severity, query.severity));
    if (query.anomalyType) filters.push(eq(aiSuggestions.anomalyType, query.anomalyType));
    if (query.search)
      filters.push(
        sql`(${aiSuggestions.title} ilike ${`%${query.search}%`} or ${aiSuggestions.entityNumber} ilike ${`%${query.search}%`})`,
      );
    const where = and(...filters);
    const [rows, [count]] = await Promise.all([
      this.viewQuery()
        .where(where)
        .orderBy(
          sql`case ${aiSuggestions.severity} when 'HIGH' then 0 when 'MEDIUM' then 1 else 2 end`,
          desc(aiSuggestions.lastSeenAt),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(aiSuggestions)
        .where(where),
    ]);
    return toPaginatedResult(rows.map(toView), count?.total ?? 0, query);
  }

  async get(companyId: string, id: string): Promise<AiAnomalyView> {
    const [row] = await this.viewQuery().where(
      and(eq(aiSuggestions.id, id), eq(aiSuggestions.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Anomaly flag', id);
    return toView(row);
  }

  async summary(
    companyId: string,
  ): Promise<{ open: number; high: number; medium: number; low: number }> {
    const [row] = await this.db
      .select({
        open: sql<number>`count(*)::int`,
        high: sql<number>`count(*) filter (where ${aiSuggestions.severity} = 'HIGH')::int`,
        medium: sql<number>`count(*) filter (where ${aiSuggestions.severity} = 'MEDIUM')::int`,
        low: sql<number>`count(*) filter (where ${aiSuggestions.severity} = 'LOW')::int`,
      })
      .from(aiSuggestions)
      .where(and(eq(aiSuggestions.companyId, companyId), eq(aiSuggestions.status, 'OPEN')));
    return row ?? { open: 0, high: 0, medium: 0, low: 0 };
  }

  /** Runs every detector over the window and upserts the flags. `actor` is null for the scheduler. */
  async scan(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: AiAnomalyScanInput,
  ): Promise<ScanResult> {
    const [documents, journals, partyStats] = await Promise.all([
      this.documents(companyId, input.from, input.to),
      this.journals(companyId, input.from, input.to),
      this.partyStats(companyId, input.from),
    ]);
    const flags = detectAnomalies({ documents, journals, partyStats });
    let created = 0;
    const ids: string[] = [];
    await this.db.transaction(async (tx) => {
      for (const flag of flags) {
        const [row] = await tx
          .insert(aiSuggestions)
          .values({
            companyId,
            anomalyType: flag.anomalyType,
            severity: flag.severity,
            fingerprint: flag.fingerprint,
            entityType: flag.entityType,
            entityId: flag.entityId,
            entityNumber: flag.entityNumber,
            entityDate: flag.entityDate,
            title: flag.title,
            detail: flag.detail,
            payload: flag.payload,
            confidence: flag.confidence.toFixed(4),
          })
          .onConflictDoUpdate({
            target: [aiSuggestions.companyId, aiSuggestions.fingerprint],
            set: { lastSeenAt: new Date(), detail: flag.detail, payload: flag.payload },
          })
          .returning({
            id: aiSuggestions.id,
            createdAt: aiSuggestions.createdAt,
            lastSeenAt: aiSuggestions.lastSeenAt,
          });
        if (row) {
          ids.push(row.id);
          if (row.createdAt.getTime() === row.lastSeenAt.getTime()) created++;
        }
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'AiAnomalyScan',
          entityId: companyId,
          newValue: {
            from: input.from,
            to: input.to,
            documents: documents.length,
            journals: journals.length,
            flagged: flags.length,
            created,
          },
          metadata: { actor: actor?.email ?? 'scheduler' },
          companyId,
        },
        tx,
      );
    });
    const items = ids.length
      ? (await this.viewQuery().where(inArray(aiSuggestions.id, ids))).map(toView)
      : [];
    return {
      from: input.from,
      to: input.to,
      scanned: { documents: documents.length, journals: journals.length },
      flagged: flags.length,
      new: created,
      items,
    };
  }

  async decide(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: DecideAiSuggestionInput,
  ): Promise<AiAnomalyView> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(aiSuggestions)
        .where(and(eq(aiSuggestions.id, id), eq(aiSuggestions.companyId, companyId)))
        .for('update');
      if (!row) throw new NotFoundError('Anomaly flag', id);
      if (row.status !== 'OPEN')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'This flag was already decided.',
        );
      const status = input.decision === 'ACCEPT' ? 'ACCEPTED' : 'DISMISSED';
      await tx
        .update(aiSuggestions)
        .set({
          status,
          decidedBy: actor.id,
          decidedAt: new Date(),
          decisionNote: input.note ?? null,
        })
        .where(eq(aiSuggestions.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'AiSuggestion',
          entityId: id,
          previousValue: { status: 'OPEN' },
          newValue: { status, note: input.note },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // ------------------------------------------------------------------ inputs

  private async documents(companyId: string, from: string, to: string): Promise<AnomalyDocument[]> {
    const bills = await this.db
      .select({
        id: vendorBills.id,
        number: vendorBills.documentNumber,
        partyId: vendorBills.vendorId,
        partyName: vendors.name,
        date: vendorBills.documentDate,
        total: vendorBills.total,
        reference: sql<
          string | null
        >`coalesce(${vendorBills.vendorInvoiceNumber}, ${vendorBills.reference})`,
        createdBy: vendorBills.createdBy,
        approvedBy: vendorBills.approvedBy,
        postedBy: vendorBills.postedBy,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          ne(vendorBills.status, 'VOID'),
          gte(vendorBills.documentDate, from),
          lte(vendorBills.documentDate, to),
        ),
      );
    const sales = await this.db
      .select({
        id: invoices.id,
        number: invoices.documentNumber,
        partyId: invoices.customerId,
        partyName: customers.name,
        date: invoices.documentDate,
        total: invoices.total,
        reference: invoices.reference,
        createdBy: invoices.createdBy,
        approvedBy: invoices.approvedBy,
        postedBy: invoices.postedBy,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          ne(invoices.status, 'VOID'),
          gte(invoices.documentDate, from),
          lte(invoices.documentDate, to),
        ),
      );
    return [
      ...bills.map((b) => ({ ...b, entityType: 'BILL' as const })),
      ...sales.map((s) => ({ ...s, entityType: 'INVOICE' as const })),
    ];
  }

  private async journals(
    companyId: string,
    from: string,
    to: string,
    executor: DbExecutor = this.db,
  ): Promise<AnomalyJournal[]> {
    const controlIds = (
      await executor
        .select({ id: accountMappings.accountId, code: accounts.code })
        .from(accountMappings)
        .innerJoin(accounts, eq(accounts.id, accountMappings.accountId))
        .where(
          and(
            eq(accountMappings.companyId, companyId),
            inArray(accountMappings.key, [...CONTROL_KEYS]),
          ),
        )
    ).reduce((m, r) => m.set(r.id, r.code), new Map<string, string>());
    const rows = await executor
      .select({
        id: journalEntries.id,
        number: journalEntries.documentNumber,
        entryDate: journalEntries.entryDate,
        createdAt: journalEntries.createdAt,
        postedAt: journalEntries.postedAt,
        createdBy: journalEntries.createdBy,
        approvedBy: journalEntries.approvedBy,
        postedBy: journalEntries.postedBy,
        sourceType: journalEntries.sourceType,
        reversalOfId: journalEntries.reversalOfId,
        total: journalEntries.totalDebit,
        accountIds: sql<string[]>`array_agg(distinct ${journalLines.accountId})`,
      })
      .from(journalEntries)
      .innerJoin(journalLines, eq(journalLines.journalEntryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalEntries.status, 'POSTED'),
          gte(journalEntries.entryDate, from),
          lte(journalEntries.entryDate, to),
        ),
      )
      .groupBy(journalEntries.id);
    return rows.map((r) => ({
      id: r.id,
      number: r.number,
      entryDate: r.entryDate,
      createdAt: r.createdAt.toISOString(),
      postedAt: r.postedAt?.toISOString() ?? null,
      createdBy: r.createdBy,
      approvedBy: r.approvedBy,
      postedBy: r.postedBy,
      manual: !r.sourceType && !r.reversalOfId,
      total: r.total,
      controlAccountsHit: r.accountIds
        .map((id) => controlIds.get(id))
        .filter((c): c is string => Boolean(c)),
    }));
  }

  /** Per-party amount statistics from documents before the window (the baseline). */
  private async partyStats(companyId: string, before: string): Promise<Map<string, PartyStat>> {
    const out = new Map<string, PartyStat>();
    const group = (rows: { partyId: string; total: string }[]) => {
      const byParty = new Map<string, string[]>();
      for (const r of rows) byParty.set(r.partyId, [...(byParty.get(r.partyId) ?? []), r.total]);
      for (const [partyId, totals] of byParty) out.set(partyId, stats(totals));
    };
    group(
      await this.db
        .select({ partyId: vendorBills.vendorId, total: vendorBills.total })
        .from(vendorBills)
        .where(
          and(
            eq(vendorBills.companyId, companyId),
            ne(vendorBills.status, 'VOID'),
            sql`${vendorBills.documentDate} < ${before}`,
          ),
        ),
    );
    group(
      await this.db
        .select({ partyId: invoices.customerId, total: invoices.total })
        .from(invoices)
        .where(
          and(
            eq(invoices.companyId, companyId),
            ne(invoices.status, 'VOID'),
            sql`${invoices.documentDate} < ${before}`,
          ),
        ),
    );
    return out;
  }

  private viewQuery() {
    return this.db
      .select({
        row: aiSuggestions,
        decidedByName: sql<string | null>`${users.firstName} || ' ' || ${users.lastName}`,
      })
      .from(aiSuggestions)
      .leftJoin(users, eq(users.id, aiSuggestions.decidedBy));
  }
}

function toView(r: { row: AiSuggestion; decidedByName: string | null }): AiAnomalyView {
  return { ...r.row, decidedByName: r.decidedByName };
}
