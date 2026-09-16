import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lte, sql, type SQL } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  ListRecurringJournalsQuery,
  RecurringJournalInput,
  RunRecurringJournalsInput,
  UpdateRecurringJournalInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import {
  AppError,
  BusinessRuleError,
  DuplicateError,
  NotFoundError,
  PermissionDeniedError,
} from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  journalEntries,
  journalLines,
  recurringJournalRuns,
  recurringJournals,
  type RecurringJournal,
  type RecurringJournalLine,
  type RecurringJournalRun,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { DimensionsService } from '../dimensions/dimensions.service';
import { DocumentNumberingService } from '../numbering/document-numbering.service';
import { AccountingPostingService, type PostingActor } from '../journals/posting.service';
import { dueOccurrences, firstOfNextMonth } from './recurring.logic';

const MODULE = 'ACCOUNTING';

export interface RecurringJournalRunView extends RecurringJournalRun {
  documentNumber: string | null;
  journalStatus: string | null;
}

export interface RecurringJournalDetail extends RecurringJournal {
  runs: RecurringJournalRunView[];
}

export interface RecurringRunResult {
  asOf: string;
  generated: Array<{
    recurringJournalId: string;
    name: string;
    runDate: string;
    journalEntryId: string;
    documentNumber: string;
    status: string;
  }>;
  skipped: Array<{ recurringJournalId: string; name: string; runDate: string; reason: string }>;
}

/** The scheduler principal: posting authority comes from the template's approved mode. */
const SYSTEM_ACTOR: PostingActor = { id: null, system: true };

/**
 * Recurring journal templates (rent, subscriptions, standing accruals). Each
 * due occurrence becomes a journal with the run row as its source identity,
 * so a template can never produce the same occurrence twice - even when two
 * workers run the schedule at once. DRAFT occurrences go through the normal
 * workflow; AUTO_POST occurrences post immediately, which is why enabling that
 * mode requires `journal.post` and is recorded on the template.
 */
@Injectable()
export class RecurringJournalsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly dimensions: DimensionsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RecurringJournalsService.name);
  }

  async list(
    companyId: string,
    query: ListRecurringJournalsQuery,
  ): Promise<PaginatedResult<RecurringJournal>> {
    const conditions: SQL[] = [eq(recurringJournals.companyId, companyId)];
    if (query.status) conditions.push(eq(recurringJournals.status, query.status));
    if (query.search) conditions.push(sql`${recurringJournals.name} ILIKE ${`%${query.search}%`}`);
    const where = and(...conditions);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(recurringJournals)
        .where(where)
        .orderBy(asc(recurringJournals.name))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, recurringJournals, where),
    ]);
    return toPaginatedResult(rows, total, query);
  }

  async get(companyId: string, id: string): Promise<RecurringJournalDetail> {
    const template = await this.lock(this.db, companyId, id, false);
    const runs = await this.db
      .select({
        id: recurringJournalRuns.id,
        recurringJournalId: recurringJournalRuns.recurringJournalId,
        companyId: recurringJournalRuns.companyId,
        runDate: recurringJournalRuns.runDate,
        journalEntryId: recurringJournalRuns.journalEntryId,
        reversalEntryId: recurringJournalRuns.reversalEntryId,
        createdBy: recurringJournalRuns.createdBy,
        createdAt: recurringJournalRuns.createdAt,
        documentNumber: journalEntries.documentNumber,
        journalStatus: journalEntries.status,
      })
      .from(recurringJournalRuns)
      .leftJoin(journalEntries, eq(journalEntries.id, recurringJournalRuns.journalEntryId))
      .where(eq(recurringJournalRuns.recurringJournalId, id))
      .orderBy(desc(recurringJournalRuns.runDate));
    return { ...template, runs };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: RecurringJournalInput,
  ): Promise<RecurringJournalDetail> {
    const id = await this.db.transaction(async (tx) => {
      await this.validateTemplate(tx, companyId, input.lines, input.branchId, input.startDate);
      this.assertMode(actor, input.mode);
      let row: RecurringJournal | undefined;
      try {
        [row] = await tx
          .insert(recurringJournals)
          .values({
            companyId,
            name: input.name,
            description: input.description,
            reference: input.reference ?? null,
            journalType: input.journalType,
            frequency: input.frequency,
            interval: input.interval,
            startDate: input.startDate,
            endDate: input.endDate ?? null,
            maxOccurrences: input.maxOccurrences ?? null,
            nextRunDate: input.startDate,
            mode: input.mode,
            autoReverse: input.autoReverse,
            branchId: input.branchId ?? null,
            lines: input.lines.map(toTemplateLine),
            createdBy: actor.id,
            autoPostApprovedBy: input.mode === 'AUTO_POST' ? actor.id : null,
          })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'recurring_journals_company_name_uq'))
          throw new DuplicateError('RecurringJournal', 'name', input.name);
        throw err;
      }
      if (!row) throw new Error('Insert returned no row');
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'RecurringJournal',
          entityId: row.id,
          newValue: {
            name: row.name,
            frequency: row.frequency,
            interval: row.interval,
            mode: row.mode,
            autoReverse: row.autoReverse,
            startDate: row.startDate,
            endDate: row.endDate,
            lines: row.lines.length,
          },
          companyId,
          userId: actor.id,
        },
        tx,
      );
      return row.id;
    });
    return this.get(companyId, id);
  }

  async update(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateRecurringJournalInput,
  ): Promise<RecurringJournalDetail> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (input.lines)
        await this.validateTemplate(
          tx,
          companyId,
          input.lines,
          existing.branchId,
          existing.startDate,
        );
      if (input.mode && input.mode !== existing.mode) this.assertMode(actor, input.mode);
      if (input.status === 'COMPLETED')
        throw new BusinessRuleError(
          ErrorCodes.RECURRING_JOURNAL_INVALID_STATE,
          'A template completes on its own when its schedule is exhausted; pause it instead.',
        );
      if (existing.status === 'COMPLETED' && input.status === 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.RECURRING_JOURNAL_INVALID_STATE,
          'A completed template cannot be reactivated; create a new one.',
        );
      const [updated] = await tx
        .update(recurringJournals)
        .set({
          name: input.name ?? existing.name,
          description: input.description ?? existing.description,
          reference: input.reference === undefined ? existing.reference : (input.reference ?? null),
          endDate: input.endDate === undefined ? existing.endDate : input.endDate,
          maxOccurrences:
            input.maxOccurrences === undefined ? existing.maxOccurrences : input.maxOccurrences,
          mode: input.mode ?? existing.mode,
          autoPostApprovedBy:
            input.mode === 'AUTO_POST' && existing.mode !== 'AUTO_POST'
              ? actor.id
              : input.mode === 'DRAFT'
                ? null
                : existing.autoPostApprovedBy,
          autoReverse: input.autoReverse ?? existing.autoReverse,
          status: input.status ?? existing.status,
          lines: input.lines ? input.lines.map(toTemplateLine) : existing.lines,
          updatedAt: new Date(),
        })
        .where(eq(recurringJournals.id, id))
        .returning();
      if (!updated) throw new Error('Update returned no row');
      const action =
        input.status && input.status !== existing.status
          ? input.status === 'PAUSED'
            ? 'PAUSE'
            : 'RESUME'
          : 'UPDATE';
      await this.audit.record(
        {
          action,
          module: MODULE,
          entityType: 'RecurringJournal',
          entityId: id,
          previousValue: {
            mode: existing.mode,
            status: existing.status,
            endDate: existing.endDate,
            autoReverse: existing.autoReverse,
          },
          newValue: {
            mode: updated.mode,
            status: updated.status,
            endDate: updated.endDate,
            autoReverse: updated.autoReverse,
            linesReplaced: Boolean(input.lines),
          },
          companyId,
          userId: actor.id,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Generates every occurrence due on or before `asOf`. Each template runs in
   * its own transaction so one bad template (missing period, inactive
   * account) is reported and does not block the others.
   */
  async run(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: RunRecurringJournalsInput,
  ): Promise<RecurringRunResult> {
    const asOf = input.asOf ?? new Date().toISOString().slice(0, 10);
    const conditions: SQL[] = [
      eq(recurringJournals.companyId, companyId),
      eq(recurringJournals.status, 'ACTIVE'),
      lte(recurringJournals.nextRunDate, asOf),
    ];
    if (input.recurringJournalId)
      conditions.push(eq(recurringJournals.id, input.recurringJournalId));
    const due = await this.db
      .select({ id: recurringJournals.id })
      .from(recurringJournals)
      .where(and(...conditions))
      .orderBy(asc(recurringJournals.name));

    const result: RecurringRunResult = { asOf, generated: [], skipped: [] };
    for (const { id } of due) {
      try {
        await this.db.transaction((tx) => this.runTemplate(tx, companyId, actor, id, asOf, result));
      } catch (err) {
        const reason = err instanceof AppError ? err.message : 'Unexpected error';
        this.logger.warn({ err, recurringJournalId: id }, 'Recurring journal run failed');
        result.skipped.push({ recurringJournalId: id, name: '', runDate: asOf, reason });
      }
    }
    return result;
  }

  /** Runs every company's due templates - the nightly scheduler entry point. */
  async runAllCompanies(asOf?: string): Promise<Record<string, RecurringRunResult>> {
    const rows = await this.db.select({ id: companies.id }).from(companies);
    const out: Record<string, RecurringRunResult> = {};
    for (const { id } of rows) out[id] = await this.run(id, null, { asOf });
    return out;
  }

  // -------------------------------------------------------------- internals

  private async runTemplate(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser | null,
    id: string,
    asOf: string,
    result: RecurringRunResult,
  ): Promise<void> {
    const template = await this.lock(tx, companyId, id);
    if (template.status !== 'ACTIVE') return;
    const schedule = dueOccurrences(template, asOf);
    const postingActor: PostingActor = actor
      ? { id: actor.id, permissions: actor.permissions, system: actor.system }
      : SYSTEM_ACTOR;
    let occurrences = template.occurrences;
    let lastRunDate = template.lastRunDate;

    for (const runDate of schedule.dates) {
      // The unique (template, run date) index is the concurrency guard: a
      // second worker inserting the same occurrence fails here and rolls back.
      const [run] = await tx
        .insert(recurringJournalRuns)
        .values({
          recurringJournalId: template.id,
          companyId,
          runDate,
          createdBy: actor?.id ?? null,
        })
        .returning();
      if (!run) throw new Error('Insert returned no row');
      const autoReverseDate = template.autoReverse ? firstOfNextMonth(runDate) : null;
      const description = `${template.description} (${runDate})`;

      let entry: { id: string; documentNumber: string; status: string };
      if (template.mode === 'AUTO_POST') {
        entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: runDate,
            description,
            reference: template.reference,
            journalType: template.journalType,
            branchId: template.branchId,
            lines: template.lines,
            sourceType: 'RECURRING_JOURNAL',
            sourceId: run.id,
            autoReverseDate,
            actor: postingActor,
          },
          { permission: P['journal.post'] },
        );
      } else {
        entry = await this.createDraft(
          tx,
          companyId,
          actor,
          template,
          run.id,
          runDate,
          description,
          autoReverseDate,
        );
      }
      await tx
        .update(recurringJournalRuns)
        .set({ journalEntryId: entry.id })
        .where(eq(recurringJournalRuns.id, run.id));
      occurrences += 1;
      lastRunDate = runDate;
      result.generated.push({
        recurringJournalId: template.id,
        name: template.name,
        runDate,
        journalEntryId: entry.id,
        documentNumber: entry.documentNumber,
        status: entry.status,
      });
    }

    await tx
      .update(recurringJournals)
      .set({
        occurrences,
        lastRunDate,
        nextRunDate: schedule.nextRunDate,
        status: schedule.exhausted ? 'COMPLETED' : template.status,
        updatedAt: new Date(),
      })
      .where(eq(recurringJournals.id, template.id));
    if (schedule.dates.length > 0 || schedule.exhausted) {
      await this.audit.record(
        {
          action: 'RECURRING_RUN',
          module: MODULE,
          entityType: 'RecurringJournal',
          entityId: template.id,
          newValue: {
            asOf,
            runDates: schedule.dates,
            nextRunDate: schedule.nextRunDate,
            completed: schedule.exhausted,
            mode: template.mode,
          },
          companyId,
          userId: actor?.id ?? null,
        },
        tx,
      );
    }
  }

  /** A DRAFT journal for the normal workflow; drafts are documents, not ledger writes. */
  private async createDraft(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser | null,
    template: RecurringJournal,
    runId: string,
    runDate: string,
    description: string,
    autoReverseDate: string | null,
  ): Promise<{ id: string; documentNumber: string; status: string }> {
    const currency = await this.companyCurrency(tx, companyId);
    const validated = await this.posting.validateLines(tx, companyId, currency, template.lines);
    await this.dimensions.validateRefs(tx, companyId, template.lines, runDate);
    const period = await this.posting.resolvePeriod(tx, companyId, runDate, { draft: true });
    const documentNumber = await this.numbering.allocate(
      companyId,
      'JE',
      Number(runDate.slice(0, 4)),
      tx,
    );
    const [entry] = await tx
      .insert(journalEntries)
      .values({
        companyId,
        branchId: template.branchId,
        fiscalPeriodId: period.id,
        documentNumber,
        journalType: template.journalType,
        status: 'DRAFT',
        entryDate: runDate,
        autoReverseDate,
        description,
        reference: template.reference,
        currency,
        totalDebit: validated.totalDebit.toString(),
        totalCredit: validated.totalCredit.toString(),
        sourceType: 'RECURRING_JOURNAL',
        sourceId: runId,
        createdBy: actor?.id ?? null,
      })
      .returning();
    if (!entry) throw new Error('Insert returned no row');
    await tx.insert(journalLines).values(
      template.lines.map((line, index) => ({
        journalEntryId: entry.id,
        companyId,
        lineNumber: index + 1,
        accountId: line.accountId,
        description: line.description ?? null,
        debit: line.debit,
        credit: line.credit,
        branchId: line.branchId ?? template.branchId ?? null,
        departmentId: line.departmentId ?? null,
        costCenterId: line.costCenterId ?? null,
        projectId: line.projectId ?? null,
      })),
    );
    await this.audit.record(
      {
        action: 'CREATE',
        module: MODULE,
        entityType: 'JournalEntry',
        entityId: entry.id,
        newValue: {
          documentNumber,
          entryDate: runDate,
          description,
          totalDebit: entry.totalDebit,
          recurringJournalId: template.id,
        },
        companyId,
        userId: actor?.id ?? null,
      },
      tx,
    );
    return { id: entry.id, documentNumber, status: entry.status };
  }

  private async validateTemplate(
    tx: DbExecutor,
    companyId: string,
    lines: RecurringJournalInput['lines'],
    branchId: string | null | undefined,
    asOf: string,
  ): Promise<void> {
    const currency = await this.companyCurrency(tx, companyId);
    const validated = await this.posting.validateLines(tx, companyId, currency, lines);
    this.posting.assertAccountBranches(validated.accountsById, branchId, lines);
    await this.posting.validateBranches(tx, companyId, branchId, lines);
    await this.dimensions.validateRefs(tx, companyId, lines, asOf);
  }

  /** AUTO_POST is a posting decision: only a `journal.post` holder may switch it on. */
  private assertMode(actor: AuthenticatedUser, mode: RecurringJournal['mode']): void {
    if (mode !== 'AUTO_POST') return;
    if (!actor.permissions.has(P['journal.post']))
      throw new PermissionDeniedError([P['journal.post']]);
  }

  private async lock(
    executor: DbExecutor,
    companyId: string,
    id: string,
    forUpdate = true,
  ): Promise<RecurringJournal> {
    const query = executor
      .select()
      .from(recurringJournals)
      .where(and(eq(recurringJournals.id, id), eq(recurringJournals.companyId, companyId)));
    const [row] = forUpdate ? await query.for('update') : await query;
    if (!row) throw new NotFoundError('RecurringJournal', id);
    return row;
  }

  private async companyCurrency(tx: DbExecutor, companyId: string): Promise<string> {
    const [row] = await tx
      .select({ baseCurrency: companies.baseCurrency })
      .from(companies)
      .where(eq(companies.id, companyId));
    if (!row) throw new NotFoundError('Company', companyId);
    return row.baseCurrency;
  }
}

function toTemplateLine(line: RecurringJournalInput['lines'][number]): RecurringJournalLine {
  return {
    accountId: line.accountId,
    debit: line.debit,
    credit: line.credit,
    description: line.description ?? null,
    branchId: line.branchId ?? null,
    departmentId: line.departmentId ?? null,
    costCenterId: line.costCenterId ?? null,
    projectId: line.projectId ?? null,
  };
}
