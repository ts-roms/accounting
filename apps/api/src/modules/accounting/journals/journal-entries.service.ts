import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  getTableColumns,
  gte,
  ilike,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateJournalEntryInput,
  ListJournalEntriesQuery,
  RejectJournalEntryInput,
  ReverseJournalEntryInput,
  UpdateJournalEntryInput,
} from '@accounting/validation';
import { AuditService } from '@/modules/audit/audit.service';
import { SodService, type SodConflict } from '@/modules/rbac/sod.service';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  branches,
  companies,
  fiscalPeriods,
  journalEntries,
  journalLines,
  type JournalEntry,
} from '@/database/schema';
import { DocumentNumberingService } from '../numbering/document-numbering.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { AccountingPostingService } from './posting.service';

const MODULE = 'ACCOUNTING';

export interface JournalLineView {
  id: string;
  lineNumber: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
  branchId: string | null;
  departmentId: string | null;
  costCenterId: string | null;
  projectId: string | null;
}

export interface JournalEntryView extends JournalEntry {
  periodName: string;
  periodStatus: string;
  branchCode: string | null;
  createdByEmail: string | null;
  approvedByEmail: string | null;
  postedByEmail: string | null;
  reversalOfNumber: string | null;
  reversedByNumber: string | null;
}

export interface JournalEntryDetail extends JournalEntryView {
  lines: JournalLineView[];
  sodWarnings?: SodConflict[];
}

const EDITABLE = new Set(['DRAFT', 'REJECTED']);

/**
 * Journal document lifecycle:
 *   DRAFT -> SUBMITTED -> APPROVED -> POSTED -> LOCKED
 *   SUBMITTED/APPROVED -> REJECTED -> (edit) -> DRAFT
 *   POSTED/LOCKED -> REVERSED (a REVERSAL entry is created and posted)
 * Posting itself is delegated to AccountingPostingService.
 */
@Injectable()
export class JournalEntriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly sod: SodService,
    private readonly dimensions: DimensionsService,
    private readonly approvals: ApprovalsService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(
    companyId: string,
    query: ListJournalEntriesQuery,
  ): Promise<PaginatedResult<JournalEntryView>> {
    const filters: SQL[] = [eq(journalEntries.companyId, companyId)];
    if (query.status) filters.push(eq(journalEntries.status, query.status));
    if (query.journalType) filters.push(eq(journalEntries.journalType, query.journalType));
    if (query.from) filters.push(gte(journalEntries.entryDate, query.from));
    if (query.to) filters.push(lte(journalEntries.entryDate, query.to));
    if (query.fiscalPeriodId) filters.push(eq(journalEntries.fiscalPeriodId, query.fiscalPeriodId));
    if (query.accountId) {
      filters.push(
        exists(
          this.db
            .select({ one: sql`1` })
            .from(journalLines)
            .where(
              and(
                eq(journalLines.journalEntryId, journalEntries.id),
                eq(journalLines.accountId, query.accountId),
              ),
            ),
        ),
      );
    }
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(journalEntries.documentNumber, term),
          ilike(journalEntries.description, term),
          ilike(journalEntries.reference, term),
        )!,
      );
    }
    const where = and(...filters);
    const sortColumn =
      query.sortBy === 'documentNumber'
        ? journalEntries.documentNumber
        : query.sortBy === 'totalDebit'
          ? journalEntries.totalDebit
          : journalEntries.entryDate;
    const direction = query.sortDir === 'asc' ? asc : desc;

    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(direction(sortColumn), desc(journalEntries.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, journalEntries, where),
    ]);
    return toPaginatedResult(rows, total, query);
  }

  async get(companyId: string, id: string): Promise<JournalEntryDetail> {
    const [entry] = await this.viewQuery(this.db).where(
      and(eq(journalEntries.id, id), eq(journalEntries.companyId, companyId)),
    );
    if (!entry) throw new NotFoundError('Journal entry', id);
    const lines = await this.lines(this.db, id);
    return { ...entry, lines };
  }

  // ---------------------------------------------------------------- commands

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateJournalEntryInput,
  ): Promise<JournalEntryDetail> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: journalEntries.id })
          .from(journalEntries)
          .where(
            and(
              eq(journalEntries.companyId, companyId),
              eq(journalEntries.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const currency = await this.companyCurrency(tx, companyId);
      const validated = await this.posting.validateLines(tx, companyId, currency, input.lines);
      await this.dimensions.validateRefs(tx, companyId, input.lines, input.entryDate);
      const period = await this.posting.resolvePeriod(tx, companyId, input.entryDate);
      await this.assertBranch(tx, companyId, input.branchId);
      const documentNumber = await this.numbering.allocate(
        companyId,
        'JE',
        Number(input.entryDate.slice(0, 4)),
        tx,
      );

      const [entry] = await tx
        .insert(journalEntries)
        .values({
          companyId,
          branchId: input.branchId ?? null,
          fiscalPeriodId: period.id,
          documentNumber,
          journalType: input.journalType,
          status: 'DRAFT',
          entryDate: input.entryDate,
          description: input.description,
          reference: input.reference ?? null,
          currency,
          totalDebit: validated.totalDebit.toString(),
          totalCredit: validated.totalCredit.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!entry) throw new Error('Insert returned no row');
      await this.writeLines(tx, entry, input.lines);
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'JournalEntry',
          entityId: entry.id,
          newValue: {
            documentNumber,
            entryDate: entry.entryDate,
            description: entry.description,
            totalDebit: entry.totalDebit,
            lines: input.lines.length,
          },
          companyId,
        },
        tx,
      );
      return entry.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateJournalEntryInput,
  ): Promise<JournalEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      if (!EDITABLE.has(entry.status)) {
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          `Only draft or rejected entries can be edited (current status: ${entry.status}).`,
        );
      }
      const currency = entry.currency;
      const entryDate = input.entryDate ?? entry.entryDate;
      const period = await this.posting.resolvePeriod(tx, companyId, entryDate);
      const branchId = input.branchId === undefined ? entry.branchId : input.branchId;
      await this.assertBranch(tx, companyId, branchId);

      let totals = { totalDebit: entry.totalDebit, totalCredit: entry.totalCredit };
      if (input.lines) {
        const validated = await this.posting.validateLines(tx, companyId, currency, input.lines);
        await this.dimensions.validateRefs(tx, companyId, input.lines, entryDate);
        totals = {
          totalDebit: validated.totalDebit.toString(),
          totalCredit: validated.totalCredit.toString(),
        };
        await tx.delete(journalLines).where(eq(journalLines.journalEntryId, id));
        await this.writeLines(tx, { id, companyId }, input.lines);
      }

      await tx
        .update(journalEntries)
        .set({
          entryDate,
          fiscalPeriodId: period.id,
          description: input.description ?? entry.description,
          reference: input.reference === undefined ? entry.reference : input.reference,
          journalType: input.journalType ?? entry.journalType,
          branchId,
          status: 'DRAFT',
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
          ...totals,
        })
        .where(eq(journalEntries.id, id));

      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'JournalEntry',
          entityId: id,
          previousValue: {
            status: entry.status,
            entryDate: entry.entryDate,
            description: entry.description,
            totalDebit: entry.totalDebit,
          },
          newValue: {
            status: 'DRAFT',
            entryDate,
            description: input.description ?? entry.description,
            totalDebit: totals.totalDebit,
          },
          metadata: {
            documentNumber: entry.documentNumber,
            linesReplaced: Boolean(input.lines),
            editor: actor.email,
          },
          companyId,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      if (!EDITABLE.has(entry.status)) {
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          'Only draft or rejected entries can be deleted; posted entries must be reversed.',
        );
      }
      await tx.delete(journalEntries).where(eq(journalEntries.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'JournalEntry',
          entityId: id,
          previousValue: { documentNumber: entry.documentNumber, status: entry.status },
          companyId,
        },
        tx,
      );
    });
  }

  async submit(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<JournalEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      this.assertStatus(entry, ['DRAFT', 'REJECTED'], 'submitted');
      await this.posting.resolvePeriod(tx, companyId, entry.entryDate);
      await this.approvals.open(tx, { companyId, documentType: 'JOURNAL_ENTRY', documentId: id, documentNumber: entry.documentNumber, amount: entry.totalDebit, currency: entry.currency, requestedBy: actor.id });
      await tx
        .update(journalEntries)
        .set({
          status: 'SUBMITTED',
          submittedBy: actor.id,
          submittedAt: new Date(),
          rejectedAt: null,
          rejectedBy: null,
          rejectionReason: null,
        })
        .where(eq(journalEntries.id, id));
      await this.transitionAudit(tx, entry, 'SUBMIT', 'SUBMITTED', companyId);
    });
    return this.get(companyId, id);
  }

  async approve(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<JournalEntryDetail> {
    const warnings: SodConflict[] = [];
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      this.assertStatus(entry, ['SUBMITTED'], 'approved');
      await this.approvals.assertApproved(tx, { companyId, documentType: 'JOURNAL_ENTRY', documentId: id, documentNumber: entry.documentNumber, amount: entry.totalDebit, currency: entry.currency, requestedBy: entry.createdBy ?? actor.id });
      const conflict = await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['journal.create'], P['journal.approve']],
        entry.createdBy,
        actor.id,
        tx,
      );
      if (conflict) warnings.push(conflict);
      await this.posting.resolvePeriod(tx, companyId, entry.entryDate);
      await tx
        .update(journalEntries)
        .set({ status: 'APPROVED', approvedBy: actor.id, approvedAt: new Date() })
        .where(eq(journalEntries.id, id));
      await this.transitionAudit(
        tx,
        entry,
        'APPROVE',
        'APPROVED',
        companyId,
        warnings.length ? { sodWarnings: warnings } : undefined,
      );
    });
    return { ...(await this.get(companyId, id)), sodWarnings: warnings };
  }

  async reject(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: RejectJournalEntryInput,
  ): Promise<JournalEntryDetail> {
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      this.assertStatus(entry, ['SUBMITTED', 'APPROVED'], 'rejected');
      await this.approvals.cancelFor(tx, 'JOURNAL_ENTRY', id);
      await tx
        .update(journalEntries)
        .set({
          status: 'REJECTED',
          rejectedBy: actor.id,
          rejectedAt: new Date(),
          rejectionReason: input.reason,
          approvedBy: null,
          approvedAt: null,
        })
        .where(eq(journalEntries.id, id));
      await this.transitionAudit(tx, entry, 'REJECT', 'REJECTED', companyId, {
        reason: input.reason,
      });
    });
    return this.get(companyId, id);
  }

  async post(companyId: string, actor: AuthenticatedUser, id: string): Promise<JournalEntryDetail> {
    const warnings: SodConflict[] = [];
    await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      if (entry.status === 'POSTED' || entry.status === 'LOCKED' || entry.status === 'REVERSED')
        return; // idempotent
      this.assertStatus(entry, ['APPROVED'], 'posted');
      const conflict = await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['journal.approve'], P['journal.post']],
        entry.approvedBy,
        actor.id,
        tx,
      );
      if (conflict) warnings.push(conflict);
      await this.posting.postEntry(tx, id, actor.id);
      if (warnings.length) {
        await this.audit.record(
          {
            action: 'POST',
            module: MODULE,
            entityType: 'JournalEntry',
            entityId: id,
            metadata: { documentNumber: entry.documentNumber, sodWarnings: warnings },
            companyId,
          },
          tx,
        );
      }
    });
    return { ...(await this.get(companyId, id)), sodWarnings: warnings };
  }

  /** Creates and posts a mirror-image REVERSAL entry; the original becomes REVERSED and stays in the ledger. */
  async reverse(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: ReverseJournalEntryInput,
  ): Promise<JournalEntryDetail> {
    const reversalId = await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      this.assertStatus(entry, ['POSTED', 'LOCKED'], 'reversed');
      if (input.reversalDate < entry.entryDate) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The reversal date cannot be before the original entry date.',
        );
      }
      const lines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, id))
        .orderBy(asc(journalLines.lineNumber));

      const reversal = await this.posting.postEvent(tx, {
        companyId,
        entryDate: input.reversalDate,
        description:
          input.description ?? `Reversal of ${entry.documentNumber}: ${entry.description}`,
        reference: entry.documentNumber,
        journalType: 'REVERSAL',
        branchId: entry.branchId,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          debit: l.credit,
          credit: l.debit,
          branchId: l.branchId,
          departmentId: l.departmentId,
          costCenterId: l.costCenterId,
          projectId: l.projectId,
        })),
        sourceType: 'JOURNAL_REVERSAL',
        sourceId: entry.id,
        reversalOfId: entry.id,
        actorId: actor.id,
      });

      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'JournalEntry',
          entityId: id,
          previousValue: { status: entry.status },
          newValue: { status: 'REVERSED', reversedById: reversal.id },
          metadata: {
            documentNumber: entry.documentNumber,
            reversalDocumentNumber: reversal.documentNumber,
          },
          companyId,
        },
        tx,
      );
      return reversal.id;
    });
    return this.get(companyId, reversalId);
  }

  // --------------------------------------------------------------- internals

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(journalEntries),
        periodName: fiscalPeriods.name,
        periodStatus: fiscalPeriods.status,
        branchCode: branches.code,
        createdByEmail: sql<
          string | null
        >`(select email from users u where u.id = ${journalEntries.createdBy})`,
        approvedByEmail: sql<
          string | null
        >`(select email from users u where u.id = ${journalEntries.approvedBy})`,
        postedByEmail: sql<
          string | null
        >`(select email from users u where u.id = ${journalEntries.postedBy})`,
        reversalOfNumber: sql<
          string | null
        >`(select document_number from journal_entries r where r.id = ${journalEntries.reversalOfId})`,
        reversedByNumber: sql<
          string | null
        >`(select document_number from journal_entries r where r.id = ${journalEntries.reversedById})`,
      })
      .from(journalEntries)
      .innerJoin(fiscalPeriods, eq(fiscalPeriods.id, journalEntries.fiscalPeriodId))
      .leftJoin(branches, eq(branches.id, journalEntries.branchId));
  }

  private async lines(executor: DbExecutor, entryId: string): Promise<JournalLineView[]> {
    return executor
      .select({
        id: journalLines.id,
        lineNumber: journalLines.lineNumber,
        accountId: journalLines.accountId,
        accountCode: accounts.code,
        accountName: accounts.name,
        description: journalLines.description,
        debit: journalLines.debit,
        credit: journalLines.credit,
        branchId: journalLines.branchId,
        departmentId: journalLines.departmentId,
        costCenterId: journalLines.costCenterId,
        projectId: journalLines.projectId,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.journalEntryId, entryId))
      .orderBy(asc(journalLines.lineNumber));
  }

  private async writeLines(
    tx: DbExecutor,
    entry: { id: string; companyId: string },
    lines: CreateJournalEntryInput['lines'],
  ) {
    await tx.insert(journalLines).values(
      lines.map((line, index) => ({
        journalEntryId: entry.id,
        companyId: entry.companyId,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description ?? null,
        debit: line.debit,
        credit: line.credit,
        branchId: line.branchId ?? null,
        departmentId: line.departmentId ?? null,
        costCenterId: line.costCenterId ?? null,
        projectId: line.projectId ?? null,
      })),
    );
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<JournalEntry> {
    const [entry] = await tx
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.id, id), eq(journalEntries.companyId, companyId)))
      .for('update');
    if (!entry) throw new NotFoundError('Journal entry', id);
    return entry;
  }

  private assertStatus(entry: JournalEntry, allowed: JournalEntry['status'][], verb: string): void {
    if (!allowed.includes(entry.status)) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_INVALID_STATE,
        `${entry.documentNumber} cannot be ${verb} from status ${entry.status}.`,
        { status: entry.status, allowed },
      );
    }
  }

  private async assertBranch(
    tx: DbExecutor,
    companyId: string,
    branchId: string | null | undefined,
  ): Promise<void> {
    if (!branchId) return;
    const [row] = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)));
    if (!row) throw new NotFoundError('Branch', branchId);
  }

  private async companyCurrency(tx: DbExecutor, companyId: string): Promise<string> {
    const [row] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new NotFoundError('Company', companyId);
    return row.baseCurrency;
  }

  private async transitionAudit(
    tx: DbExecutor,
    entry: JournalEntry,
    action: 'SUBMIT' | 'APPROVE' | 'REJECT',
    next: JournalEntry['status'],
    companyId: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        module: MODULE,
        entityType: 'JournalEntry',
        entityId: entry.id,
        previousValue: { status: entry.status },
        newValue: { status: next },
        metadata: { documentNumber: entry.documentNumber, ...metadata },
        companyId,
      },
      tx,
    );
  }
}
