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
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  CreateJournalEntryInput,
  ListJournalEntriesQuery,
  OpeningBalancesInput,
  RejectJournalEntryInput,
  CorrectJournalEntryInput,
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
  exchangeRates,
  fiscalPeriods,
  journalEntries,
  journalLines,
  type JournalEntry,
} from '@/database/schema';
import { pickRate } from '@/modules/fx/fx.logic';
import { AccountsService } from '../accounts/accounts.service';
import { convertForeignLines, ForeignJournalUnbalancedError } from './fx-lines.logic';
import { DocumentNumberingService } from '../numbering/document-numbering.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';
import { AuthorityService } from '@/modules/delegations/authority.service';
import { AccountingPostingService, type PostingLine } from './posting.service';

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
  /** Foreign-currency journals only. */
  foreignDebit: string | null;
  foreignCredit: string | null;
  exchangeRate: string | null;
}

/** Header fields + lines after currency preparation, ready to be written. */
interface PreparedLines {
  lines: PostingLine[];
  transactionCurrency: string | null;
  exchangeRate: string | null;
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
  /** For a correcting entry: the original it replaces. */
  correctionOfNumber: string | null;
}

export interface RelatedEntry {
  id: string;
  documentNumber: string;
  status: JournalEntry['status'];
  entryDate: string;
  relation: 'ORIGINAL' | 'REVERSAL' | 'REVERSED' | 'CORRECTION' | 'CORRECTS';
}

export interface JournalEntryDetail extends JournalEntryView {
  lines: JournalLineView[];
  /** Original / reversal / correction chain, for navigation and audit. */
  related: RelatedEntry[];
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
    private readonly authority: AuthorityService,
    private readonly accounts: AccountsService,
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
    const [lines, related] = await Promise.all([this.lines(this.db, id), this.related(entry)]);
    return { ...entry, lines, related };
  }

  /** Every entry linked to this one through reversal or correction, in both directions. */
  private async related(entry: JournalEntry): Promise<RelatedEntry[]> {
    const pick = {
      id: journalEntries.id,
      documentNumber: journalEntries.documentNumber,
      status: journalEntries.status,
      entryDate: journalEntries.entryDate,
    };
    const out: RelatedEntry[] = [];
    const add = (rows: Omit<RelatedEntry, 'relation'>[], relation: RelatedEntry['relation']) => {
      for (const r of rows) out.push({ ...r, relation });
    };
    if (entry.reversalOfId)
      add(
        await this.db
          .select(pick)
          .from(journalEntries)
          .where(eq(journalEntries.id, entry.reversalOfId)),
        'ORIGINAL',
      );
    if (entry.reversedById)
      add(
        await this.db
          .select(pick)
          .from(journalEntries)
          .where(eq(journalEntries.id, entry.reversedById)),
        'REVERSAL',
      );
    if (entry.correctionOfId)
      add(
        await this.db
          .select(pick)
          .from(journalEntries)
          .where(eq(journalEntries.id, entry.correctionOfId)),
        'CORRECTS',
      );
    add(
      await this.db
        .select(pick)
        .from(journalEntries)
        .where(eq(journalEntries.correctionOfId, entry.id))
        .orderBy(asc(journalEntries.createdAt)),
      'CORRECTION',
    );
    return out;
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
      const prepared = await this.prepareLines(tx, companyId, currency, input.entryDate, input);
      const validated = await this.posting.validateLines(tx, companyId, currency, prepared.lines);
      await this.dimensions.validateRefs(tx, companyId, prepared.lines, input.entryDate);
      const period = await this.posting.resolvePeriod(tx, companyId, input.entryDate, {
        draft: true,
      });
      await this.assertBranch(tx, companyId, input.branchId);
      this.assertAutoReverse(input.entryDate, input.autoReverseDate);
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
          documentDate: input.documentDate ?? null,
          autoReverseDate: input.autoReverseDate ?? null,
          description: input.description,
          reference: input.reference ?? null,
          currency,
          transactionCurrency: prepared.transactionCurrency,
          exchangeRate: prepared.exchangeRate,
          totalDebit: validated.totalDebit.toString(),
          totalCredit: validated.totalCredit.toString(),
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!entry) throw new Error('Insert returned no row');
      await this.writeLines(tx, entry, prepared.lines);
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
            journalType: entry.journalType,
            transactionCurrency: prepared.transactionCurrency,
            exchangeRate: prepared.exchangeRate,
            autoReverseDate: entry.autoReverseDate,
          },
          companyId,
        },
        tx,
      );
      return entry.id;
    });
    return this.get(companyId, id);
  }

  /**
   * Opening balances as an OPENING journal: the caller supplies the balances
   * per account, the engine offsets any difference against the
   * OPENING_BALANCE_EQUITY mapping so the entry balances, and the draft goes
   * through the normal submit / approve / post controls (SoD included).
   */
  async openingBalances(
    companyId: string,
    actor: AuthenticatedUser,
    input: OpeningBalancesInput,
  ): Promise<JournalEntryDetail> {
    const currency = await this.companyCurrency(this.db, companyId);
    let debit = Money.zero(currency);
    let credit = Money.zero(currency);
    for (const line of input.lines) {
      debit = debit.add(Money.parse(line.debit, currency));
      credit = credit.add(Money.parse(line.credit, currency));
    }
    const lines: CreateJournalEntryInput['lines'] = input.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description ?? undefined,
      branchId: l.branchId ?? null,
      departmentId: l.departmentId ?? null,
      costCenterId: l.costCenterId ?? null,
      projectId: l.projectId ?? null,
    }));
    const difference = debit.subtract(credit);
    if (!difference.isZero()) {
      const offset = await this.accounts.resolveMapped(companyId, 'OPENING_BALANCE_EQUITY');
      lines.push({
        accountId: offset.id,
        debit: difference.isNegative() ? difference.abs().toString() : '0',
        credit: difference.isPositive() ? difference.toString() : '0',
        description: 'Opening balance offset',
        branchId: input.branchId ?? null,
        departmentId: null,
        costCenterId: null,
        projectId: null,
      });
    }
    if (lines.length < 2) {
      throw new BusinessRuleError(
        ErrorCodes.JOURNAL_UNBALANCED,
        'Opening balances need at least one non-zero balance.',
      );
    }
    const detail = await this.create(companyId, actor, {
      entryDate: input.asOfDate,
      description: input.description,
      reference: input.reference,
      journalType: 'OPENING',
      branchId: input.branchId ?? null,
      lines,
      idempotencyKey: input.idempotencyKey,
    });
    await this.audit.record({
      action: 'OPENING_BALANCE',
      module: MODULE,
      entityType: 'JournalEntry',
      entityId: detail.id,
      newValue: {
        documentNumber: detail.documentNumber,
        asOfDate: input.asOfDate,
        accounts: input.lines.length,
        offset: difference.toString(),
      },
      companyId,
      userId: actor.id,
    });
    return detail;
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
      const period = await this.posting.resolvePeriod(tx, companyId, entryDate, { draft: true });
      const branchId = input.branchId === undefined ? entry.branchId : input.branchId;
      await this.assertBranch(tx, companyId, branchId);
      const autoReverseDate =
        input.autoReverseDate === undefined ? entry.autoReverseDate : input.autoReverseDate;
      this.assertAutoReverse(entryDate, autoReverseDate);

      let totals = { totalDebit: entry.totalDebit, totalCredit: entry.totalCredit };
      let fx = { transactionCurrency: entry.transactionCurrency, exchangeRate: entry.exchangeRate };
      const currencyChanged =
        input.transactionCurrency !== undefined || input.exchangeRate !== undefined;
      if (input.lines || currencyChanged) {
        // Re-prepare from the amounts as entered (foreign when the entry is foreign).
        const entered = input.lines ?? (await this.enteredLines(tx, id));
        const prepared = await this.prepareLines(tx, companyId, currency, entryDate, {
          lines: entered,
          transactionCurrency:
            input.transactionCurrency === undefined
              ? (entry.transactionCurrency ?? undefined)
              : input.transactionCurrency,
          exchangeRate:
            input.exchangeRate === undefined
              ? (entry.exchangeRate ?? undefined)
              : input.exchangeRate,
        });
        const validated = await this.posting.validateLines(tx, companyId, currency, prepared.lines);
        await this.dimensions.validateRefs(tx, companyId, prepared.lines, entryDate);
        totals = {
          totalDebit: validated.totalDebit.toString(),
          totalCredit: validated.totalCredit.toString(),
        };
        fx = {
          transactionCurrency: prepared.transactionCurrency,
          exchangeRate: prepared.exchangeRate,
        };
        await tx.delete(journalLines).where(eq(journalLines.journalEntryId, id));
        await this.writeLines(tx, { id, companyId }, prepared.lines);
      }

      await tx
        .update(journalEntries)
        .set({
          entryDate,
          documentDate: input.documentDate === undefined ? entry.documentDate : input.documentDate,
          autoReverseDate,
          fiscalPeriodId: period.id,
          description: input.description ?? entry.description,
          reference: input.reference === undefined ? entry.reference : input.reference,
          journalType: input.journalType ?? entry.journalType,
          branchId,
          ...fx,
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
      await this.posting.resolvePeriod(tx, companyId, entry.entryDate, { draft: true });
      await this.approvals.open(tx, {
        companyId,
        documentType: 'JOURNAL_ENTRY',
        documentId: id,
        documentNumber: entry.documentNumber,
        amount: entry.totalDebit,
        currency: entry.currency,
        requestedBy: actor.id,
        branchId: entry.branchId,
      });
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
      await this.approvals.assertApproved(tx, {
        companyId,
        documentType: 'JOURNAL_ENTRY',
        documentId: id,
        documentNumber: entry.documentNumber,
        amount: entry.totalDebit,
        currency: entry.currency,
        requestedBy: entry.createdBy ?? actor.id,
        branchId: entry.branchId,
      });
      const conflict = await this.sod.checkActorSeparation(
        actor.organizationId,
        [P['journal.create'], P['journal.approve']],
        entry.createdBy,
        actor.id,
        tx,
      );
      if (conflict) warnings.push(conflict);
      const authority = await this.authority.assert(tx, actor, P['journal.approve'], {
        companyId,
        branchId: entry.branchId,
        amount: entry.totalDebit,
        currency: entry.currency,
        documentType: 'JOURNAL_ENTRY',
        documentId: id,
        documentNumber: entry.documentNumber,
        createdBy: entry.createdBy,
        action: 'Approved journal entry',
      });
      await this.posting.resolvePeriod(tx, companyId, entry.entryDate, { draft: true });
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
        warnings.length || authority.audit
          ? { ...(warnings.length ? { sodWarnings: warnings } : {}), ...authority.audit }
          : undefined,
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
      await this.posting.postEntry(tx, id, actor);
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
      return (await this.reverseInTx(tx, companyId, actor, entry, input)).id;
    });
    return this.get(companyId, reversalId);
  }

  /**
   * Correction workflow: the posted original is reversed and a DRAFT entry
   * pre-filled with the original lines is created, linked to the original, so
   * the chain Original -> Reversal -> Correction is explicit and navigable.
   * The draft goes through the normal submit / approve / post controls.
   */
  async correct(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: CorrectJournalEntryInput,
  ): Promise<{
    original: JournalEntryDetail;
    reversal: JournalEntryDetail;
    correction: JournalEntryDetail;
  }> {
    const ids = await this.db.transaction(async (tx) => {
      const entry = await this.lock(tx, companyId, id);
      if (entry.journalType === 'CLOSING')
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_INVALID_STATE,
          'Year-end closing entries are corrected by reopening the year, not by a correcting journal.',
        );
      let reversalId: string;
      if (entry.status === 'REVERSED') {
        if (!entry.reversedById)
          throw new BusinessRuleError(
            ErrorCodes.JOURNAL_INVALID_STATE,
            'Entry is reversed but has no reversal.',
          );
        reversalId = entry.reversedById;
      } else {
        this.assertStatus(entry, ['POSTED', 'LOCKED'], 'corrected');
        reversalId = (
          await this.reverseInTx(tx, companyId, actor, entry, {
            reversalDate: input.reversalDate,
            description: `Reversal of ${entry.documentNumber} for correction: ${input.reason}`,
          })
        ).id;
      }
      const lines = await tx
        .select()
        .from(journalLines)
        .where(eq(journalLines.journalEntryId, id))
        .orderBy(asc(journalLines.lineNumber));
      const correctionDate = input.correctionDate ?? input.reversalDate;
      const period = await this.posting.resolvePeriod(tx, companyId, correctionDate, {
        draft: true,
      });
      const documentNumber = await this.numbering.allocate(
        companyId,
        'JE',
        Number(correctionDate.slice(0, 4)),
        tx,
      );
      const [correction] = await tx
        .insert(journalEntries)
        .values({
          companyId,
          branchId: entry.branchId,
          fiscalPeriodId: period.id,
          documentNumber,
          journalType: 'ADJUSTING',
          status: 'DRAFT',
          entryDate: correctionDate,
          description: `Correction of ${entry.documentNumber}: ${input.reason}`,
          reference: entry.documentNumber,
          currency: entry.currency,
          totalDebit: entry.totalDebit,
          totalCredit: entry.totalCredit,
          correctionOfId: entry.id,
          createdBy: actor.id,
        })
        .returning();
      if (!correction) throw new Error('Insert returned no row');
      await this.writeLines(
        tx,
        correction,
        lines.map((l) => ({
          accountId: l.accountId,
          description: l.description ?? undefined,
          debit: l.debit,
          credit: l.credit,
          branchId: l.branchId,
          departmentId: l.departmentId,
          costCenterId: l.costCenterId,
          projectId: l.projectId,
        })),
      );
      await this.audit.record(
        {
          action: 'CORRECT',
          module: MODULE,
          entityType: 'JournalEntry',
          entityId: entry.id,
          newValue: { reversalId, correctionId: correction.id, correctionNumber: documentNumber },
          metadata: { documentNumber: entry.documentNumber, reason: input.reason },
          companyId,
        },
        tx,
      );
      return { reversalId, correctionId: correction.id };
    });
    const [original, reversal, correction] = await Promise.all([
      this.get(companyId, id),
      this.get(companyId, ids.reversalId),
      this.get(companyId, ids.correctionId),
    ]);
    return { original, reversal, correction };
  }

  private async reverseInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    entry: JournalEntry,
    input: ReverseJournalEntryInput,
  ): Promise<JournalEntry> {
    this.assertStatus(entry, ['POSTED', 'LOCKED'], 'reversed');
    if (entry.companyId !== companyId) throw new NotFoundError('JournalEntry', entry.id);
    return this.posting.reverseEntry(tx, entry, {
      reversalDate: input.reversalDate,
      description: input.description,
      actor,
      permission: P['journal.reverse'],
    });
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
        correctionOfNumber: sql<
          string | null
        >`(select document_number from journal_entries r where r.id = ${journalEntries.correctionOfId})`,
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
        foreignDebit: journalLines.foreignDebit,
        foreignCredit: journalLines.foreignCredit,
        exchangeRate: journalLines.exchangeRate,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(eq(journalLines.journalEntryId, entryId))
      .orderBy(asc(journalLines.lineNumber));
  }

  /** Lines as the user entered them: foreign amounts for a foreign entry, base otherwise. */
  private async enteredLines(
    tx: DbExecutor,
    entryId: string,
  ): Promise<CreateJournalEntryInput['lines']> {
    const rows = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalEntryId, entryId))
      .orderBy(asc(journalLines.lineNumber));
    return rows.map((l) => ({
      accountId: l.accountId,
      debit: l.foreignDebit ?? l.debit,
      credit: l.foreignCredit ?? l.credit,
      description: l.description ?? undefined,
      branchId: l.branchId,
      departmentId: l.departmentId,
      costCenterId: l.costCenterId,
      projectId: l.projectId,
    }));
  }

  /**
   * Base-currency lines for the ledger. A foreign transaction currency converts
   * every line at the explicit rate or the organization's rate table on the
   * entry date; the foreign amounts stay on the lines.
   */
  private async prepareLines(
    tx: DbExecutor,
    companyId: string,
    baseCurrency: string,
    entryDate: string,
    input: {
      lines: CreateJournalEntryInput['lines'];
      transactionCurrency?: string;
      exchangeRate?: string;
    },
  ): Promise<PreparedLines> {
    const txCurrency = input.transactionCurrency ?? baseCurrency;
    if (txCurrency === baseCurrency) {
      return {
        lines: input.lines.map((l) => ({ ...l, description: l.description ?? null })),
        transactionCurrency: null,
        exchangeRate: null,
      };
    }
    const rate =
      input.exchangeRate ??
      (await this.rateFor(tx, companyId, txCurrency, baseCurrency, entryDate));
    try {
      return {
        lines: convertForeignLines(input.lines, txCurrency, baseCurrency, rate),
        transactionCurrency: txCurrency,
        exchangeRate: rate,
      };
    } catch (err) {
      if (err instanceof ForeignJournalUnbalancedError) {
        throw new BusinessRuleError(
          ErrorCodes.JOURNAL_UNBALANCED,
          `Journal entry is out of balance in ${txCurrency}: debits ${err.totalDebit} vs credits ${err.totalCredit}.`,
          { totalDebit: err.totalDebit, totalCredit: err.totalCredit, currency: txCurrency },
        );
      }
      throw err;
    }
  }

  /** Rate table lookup (same rule as ExchangeRatesService.rateFor; FxModule depends on this module). */
  private async rateFor(
    tx: DbExecutor,
    companyId: string,
    from: string,
    to: string,
    onDate: string,
  ): Promise<string> {
    const [company] = await tx
      .select({ organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!company) throw new NotFoundError('Company', companyId);
    const rows = await tx
      .select()
      .from(exchangeRates)
      .where(
        and(
          eq(exchangeRates.organizationId, company.organizationId),
          lte(exchangeRates.rateDate, onDate),
          or(
            and(eq(exchangeRates.fromCurrency, from), eq(exchangeRates.toCurrency, to)),
            and(eq(exchangeRates.fromCurrency, to), eq(exchangeRates.toCurrency, from)),
          ),
        ),
      );
    const rate = pickRate(rows, from, to, onDate);
    if (!rate)
      throw new BusinessRuleError(
        ErrorCodes.EXCHANGE_RATE_MISSING,
        `No ${from}/${to} exchange rate on or before ${onDate}.`,
        { fromCurrency: from, toCurrency: to, onDate },
      );
    return rate;
  }

  private assertAutoReverse(entryDate: string, autoReverseDate: string | null | undefined): void {
    if (autoReverseDate && autoReverseDate <= entryDate) {
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The auto-reverse date must be after the entry date.',
      );
    }
  }

  private async writeLines(
    tx: DbExecutor,
    entry: { id: string; companyId: string },
    lines: readonly PostingLine[],
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
        foreignDebit: line.foreignDebit ?? null,
        foreignCredit: line.foreignCredit ?? null,
        exchangeRate: line.exchangeRate ?? null,
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
