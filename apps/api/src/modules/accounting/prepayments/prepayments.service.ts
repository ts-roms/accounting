import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { PinoLogger } from 'nestjs-pino';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  ListPrepaymentsQuery,
  PrepaymentInput,
  RecognizePrepaymentsInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { AppError, BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  companies,
  journalEntries,
  prepaymentSchedules,
  prepayments,
  type Prepayment,
  type PrepaymentSchedule,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { businessToday } from '@/common/time/clock';
import { DimensionsService } from '../dimensions/dimensions.service';
import { AccountingPostingService, type PostingActor } from '../journals/posting.service';
import { buildPrepaymentSchedule } from './prepayments.logic';

const MODULE = 'ACCOUNTING';

export interface PrepaymentScheduleView extends PrepaymentSchedule {
  documentNumber: string | null;
}

export interface PrepaymentView extends Prepayment {
  prepaidAccountCode: string;
  expenseAccountCode: string;
  remainingAmount: string;
}

export interface PrepaymentDetail extends PrepaymentView {
  schedules: PrepaymentScheduleView[];
  initialDocumentNumber: string | null;
}

export interface RecognitionResult {
  asOf: string;
  recognized: Array<{
    prepaymentId: string;
    name: string;
    sequence: number;
    recognitionDate: string;
    amount: string;
    journalEntryId: string;
    documentNumber: string;
  }>;
  skipped: Array<{ prepaymentId: string; reason: string }>;
}

/**
 * Prepaid expenses: one initial posting (Dr prepaid / Cr cash or payable) and a
 * schedule of straight-line recognitions (Dr expense / Cr prepaid). The
 * prepayment row is a subledger record - its remaining amount must always
 * equal what the ledger holds for it, which the schedule guarantees because
 * every instalment posts through the engine with its own source identity.
 */
@Injectable()
export class PrepaymentsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly posting: AccountingPostingService,
    private readonly dimensions: DimensionsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PrepaymentsService.name);
  }

  async list(
    companyId: string,
    query: ListPrepaymentsQuery,
  ): Promise<PaginatedResult<PrepaymentView>> {
    const conditions: SQL[] = [eq(prepayments.companyId, companyId)];
    if (query.status) conditions.push(eq(prepayments.status, query.status));
    if (query.search) conditions.push(sql`${prepayments.name} ILIKE ${`%${query.search}%`}`);
    const where = and(...conditions);
    const [rows, total] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(prepayments.startDate), asc(prepayments.name))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, prepayments, where),
    ]);
    return toPaginatedResult(rows, total, query);
  }

  async get(companyId: string, id: string): Promise<PrepaymentDetail> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(prepayments.id, id), eq(prepayments.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Prepayment', id);
    const schedules = await this.db
      .select({
        id: prepaymentSchedules.id,
        prepaymentId: prepaymentSchedules.prepaymentId,
        companyId: prepaymentSchedules.companyId,
        sequence: prepaymentSchedules.sequence,
        recognitionDate: prepaymentSchedules.recognitionDate,
        amount: prepaymentSchedules.amount,
        status: prepaymentSchedules.status,
        journalEntryId: prepaymentSchedules.journalEntryId,
        recognizedAt: prepaymentSchedules.recognizedAt,
        documentNumber: journalEntries.documentNumber,
      })
      .from(prepaymentSchedules)
      .leftJoin(journalEntries, eq(journalEntries.id, prepaymentSchedules.journalEntryId))
      .where(eq(prepaymentSchedules.prepaymentId, id))
      .orderBy(asc(prepaymentSchedules.sequence));
    const [initial] = row.initialEntryId
      ? await this.db
          .select({ documentNumber: journalEntries.documentNumber })
          .from(journalEntries)
          .where(eq(journalEntries.id, row.initialEntryId))
      : [];
    return { ...row, schedules, initialDocumentNumber: initial?.documentNumber ?? null };
  }

  async create(
    companyId: string,
    actor: AuthenticatedUser,
    input: PrepaymentInput,
  ): Promise<PrepaymentDetail> {
    const id = await this.db.transaction(async (tx) => {
      const currency = await this.companyCurrency(tx, companyId);
      await this.validateAccounts(tx, companyId, currency, input);
      const schedule = buildPrepaymentSchedule(
        input.amount,
        currency,
        input.startDate,
        input.months,
      );
      const [row] = await tx
        .insert(prepayments)
        .values({
          companyId,
          name: input.name,
          description: input.description ?? null,
          reference: input.reference ?? null,
          prepaidAccountId: input.prepaidAccountId,
          expenseAccountId: input.expenseAccountId,
          creditAccountId: input.creditAccountId ?? null,
          currency,
          amount: Money.parse(input.amount, currency).toString(),
          startDate: input.startDate,
          months: input.months,
          branchId: input.branchId ?? null,
          departmentId: input.departmentId ?? null,
          costCenterId: input.costCenterId ?? null,
          projectId: input.projectId ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (!row) throw new Error('Insert returned no row');
      await tx.insert(prepaymentSchedules).values(
        schedule.map((s) => ({
          prepaymentId: row.id,
          companyId,
          sequence: s.sequence,
          recognitionDate: s.recognitionDate,
          amount: s.amount,
        })),
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'Prepayment',
          entityId: row.id,
          newValue: {
            name: row.name,
            amount: row.amount,
            startDate: row.startDate,
            months: row.months,
            instalments: schedule.length,
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

  /** DRAFT -> ACTIVE. Posts the initial entry when a credit account is configured. */
  async activate(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<PrepaymentDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.PREPAYMENT_INVALID_STATE,
          `Only draft prepayments can be activated (current status: ${row.status}).`,
        );
      let initialEntryId: string | null = null;
      if (row.creditAccountId) {
        const entry = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: row.startDate,
            description: `Prepayment: ${row.name}`,
            reference: row.reference,
            journalType: 'GENERAL',
            branchId: row.branchId,
            lines: [
              {
                accountId: row.prepaidAccountId,
                debit: row.amount,
                credit: '0',
                description: row.name,
                ...this.dims(row),
              },
              {
                accountId: row.creditAccountId,
                debit: '0',
                credit: row.amount,
                description: row.name,
                ...this.dims(row),
              },
            ],
            sourceType: 'PREPAYMENT',
            sourceId: row.id,
            actor: this.actor(actor),
          },
          { permission: P['prepayment.post'] },
        );
        initialEntryId = entry.id;
      }
      await tx
        .update(prepayments)
        .set({
          status: 'ACTIVE',
          initialEntryId,
          activatedBy: actor.id,
          activatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(prepayments.id, id));
      await this.audit.record(
        {
          action: 'ACTIVATE',
          module: MODULE,
          entityType: 'Prepayment',
          entityId: id,
          previousValue: { status: 'DRAFT' },
          newValue: { status: 'ACTIVE', initialEntryId },
          companyId,
          userId: actor.id,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  /**
   * Posts every PENDING instalment dated on or before `asOf`. Each prepayment
   * runs in its own transaction; failures are reported, not fatal.
   */
  async recognize(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: RecognizePrepaymentsInput,
  ): Promise<RecognitionResult> {
    const asOf = input.asOf ?? businessToday();
    const conditions: SQL[] = [
      eq(prepayments.companyId, companyId),
      eq(prepayments.status, 'ACTIVE'),
    ];
    if (input.prepaymentId) conditions.push(eq(prepayments.id, input.prepaymentId));
    const active = await this.db
      .select({ id: prepayments.id })
      .from(prepayments)
      .where(and(...conditions));
    const result: RecognitionResult = { asOf, recognized: [], skipped: [] };
    for (const { id } of active) {
      try {
        await this.db.transaction((tx) =>
          this.recognizeOne(tx, companyId, actor, id, asOf, result),
        );
      } catch (err) {
        const reason = err instanceof AppError ? err.message : 'Unexpected error';
        this.logger.warn({ err, prepaymentId: id }, 'Prepayment recognition failed');
        result.skipped.push({ prepaymentId: id, reason });
      }
    }
    return result;
  }

  /** Nightly scheduler entry point. */
  async recognizeAllCompanies(asOf?: string): Promise<Record<string, RecognitionResult>> {
    const rows = await this.db.select({ id: companies.id }).from(companies);
    const out: Record<string, RecognitionResult> = {};
    for (const { id } of rows) out[id] = await this.recognize(id, null, { asOf });
    return out;
  }

  /**
   * Cancels the remaining schedule. A prepayment nothing has been recognised
   * on is fully unwound (initial entry reversed); a partly recognised one keeps
   * its posted history and the remaining prepaid balance is cleared by a
   * manual journal - the audit entry says so.
   */
  async cancel(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<PrepaymentDetail> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, companyId, id);
      if (row.status === 'COMPLETED' || row.status === 'CANCELLED')
        throw new BusinessRuleError(
          ErrorCodes.PREPAYMENT_INVALID_STATE,
          `A ${row.status.toLowerCase()} prepayment cannot be cancelled.`,
        );
      const recognizedNothing = Money.of(row.recognizedAmount, row.currency).isZero();
      let reversalId: string | null = null;
      if (recognizedNothing && row.initialEntryId) {
        const [initial] = await tx
          .select()
          .from(journalEntries)
          .where(eq(journalEntries.id, row.initialEntryId))
          .for('update');
        if (initial && (initial.status === 'POSTED' || initial.status === 'LOCKED')) {
          const reversal = await this.posting.reverseEntry(tx, initial, {
            reversalDate: laterOf(initial.entryDate, businessToday()),
            description: `Cancelled prepayment ${row.name}: ${reason}`,
            actor: this.actor(actor),
            permission: P['prepayment.post'],
          });
          reversalId = reversal.id;
        }
      }
      await tx
        .update(prepaymentSchedules)
        .set({ status: 'CANCELLED' })
        .where(
          and(eq(prepaymentSchedules.prepaymentId, id), eq(prepaymentSchedules.status, 'PENDING')),
        );
      await tx
        .update(prepayments)
        .set({ status: 'CANCELLED', updatedAt: new Date() })
        .where(eq(prepayments.id, id));
      await this.audit.record(
        {
          action: 'CANCEL',
          module: MODULE,
          entityType: 'Prepayment',
          entityId: id,
          previousValue: { status: row.status, recognizedAmount: row.recognizedAmount },
          newValue: {
            status: 'CANCELLED',
            reason,
            initialEntryReversed: reversalId,
            remainingToClearManually: recognizedNothing
              ? '0'
              : Money.of(row.amount, row.currency)
                  .subtract(Money.of(row.recognizedAmount, row.currency))
                  .toString(),
          },
          companyId,
          userId: actor.id,
        },
        tx,
      );
    });
    return this.get(companyId, id);
  }

  // -------------------------------------------------------------- internals

  private async recognizeOne(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser | null,
    id: string,
    asOf: string,
    result: RecognitionResult,
  ): Promise<void> {
    const row = await this.lock(tx, companyId, id);
    if (row.status !== 'ACTIVE') return;
    const due = await tx
      .select()
      .from(prepaymentSchedules)
      .where(
        and(
          eq(prepaymentSchedules.prepaymentId, id),
          eq(prepaymentSchedules.status, 'PENDING'),
          lte(prepaymentSchedules.recognitionDate, asOf),
        ),
      )
      .orderBy(asc(prepaymentSchedules.sequence))
      .for('update');
    if (due.length === 0) return;

    let recognized = Money.of(row.recognizedAmount, row.currency);
    const postingActor: PostingActor = actor ? this.actor(actor) : { id: null, system: true };
    for (const instalment of due) {
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: instalment.recognitionDate,
          description: `Prepayment recognition ${instalment.sequence}/${row.months}: ${row.name}`,
          reference: row.reference,
          journalType: 'ADJUSTING',
          branchId: row.branchId,
          lines: [
            {
              accountId: row.expenseAccountId,
              debit: instalment.amount,
              credit: '0',
              description: row.name,
              ...this.dims(row),
            },
            {
              accountId: row.prepaidAccountId,
              debit: '0',
              credit: instalment.amount,
              description: row.name,
              ...this.dims(row),
            },
          ],
          sourceType: 'PREPAYMENT_RECOGNITION',
          sourceId: instalment.id,
          actor: postingActor,
        },
        { permission: P['prepayment.post'] },
      );
      await tx
        .update(prepaymentSchedules)
        .set({ status: 'RECOGNIZED', journalEntryId: entry.id, recognizedAt: new Date() })
        .where(eq(prepaymentSchedules.id, instalment.id));
      recognized = recognized.add(Money.of(instalment.amount, row.currency));
      result.recognized.push({
        prepaymentId: id,
        name: row.name,
        sequence: instalment.sequence,
        recognitionDate: instalment.recognitionDate,
        amount: instalment.amount,
        journalEntryId: entry.id,
        documentNumber: entry.documentNumber,
      });
    }
    const [count] = await tx
      .select({ pending: sql<number>`count(*)::int` })
      .from(prepaymentSchedules)
      .where(
        and(eq(prepaymentSchedules.prepaymentId, id), eq(prepaymentSchedules.status, 'PENDING')),
      );
    const completed = (count?.pending ?? 0) === 0;
    await tx
      .update(prepayments)
      .set({
        recognizedAmount: recognized.toString(),
        status: completed ? 'COMPLETED' : 'ACTIVE',
        updatedAt: new Date(),
      })
      .where(eq(prepayments.id, id));
    await this.audit.record(
      {
        action: 'RECOGNIZE',
        module: MODULE,
        entityType: 'Prepayment',
        entityId: id,
        newValue: {
          asOf,
          instalments: due.map((d) => d.sequence),
          recognizedAmount: recognized.toString(),
          completed,
        },
        companyId,
        userId: actor?.id ?? null,
      },
      tx,
    );
  }

  private async validateAccounts(
    tx: DbExecutor,
    companyId: string,
    currency: string,
    input: PrepaymentInput,
  ): Promise<void> {
    const ids = [input.prepaidAccountId, input.expenseAccountId, input.creditAccountId].filter(
      (x): x is string => Boolean(x),
    );
    const rows = await tx
      .select()
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), inArray(accounts.id, ids)));
    const byId = new Map(rows.map((a) => [a.id, a]));
    for (const id of ids) {
      const account = byId.get(id);
      if (!account) throw new NotFoundError('Account', id);
      if (account.isHeader || account.status !== 'ACTIVE')
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          `${account.code} ${account.name} cannot be posted to.`,
        );
      if (account.currency && account.currency !== currency)
        throw new BusinessRuleError(
          ErrorCodes.CURRENCY_MISMATCH,
          `${account.code} is a ${account.currency} account.`,
        );
    }
    const prepaid = byId.get(input.prepaidAccountId)!;
    if (prepaid.type !== 'ASSET')
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The prepaid account must be an asset account.',
      );
    const expense = byId.get(input.expenseAccountId)!;
    if (!['EXPENSE', 'COST_OF_SALES', 'OTHER_EXPENSE'].includes(expense.type))
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The recognition account must be an expense account.',
      );
    await this.dimensions.validateRefs(tx, companyId, [input], input.startDate);
  }

  private dims(row: Prepayment) {
    return {
      departmentId: row.departmentId,
      costCenterId: row.costCenterId,
      projectId: row.projectId,
    };
  }

  private actor(user: AuthenticatedUser): PostingActor {
    return { id: user.id, permissions: user.permissions, system: user.system };
  }

  private viewQuery(executor: DbExecutor) {
    const prepaid = alias(accounts, 'prepaid');
    const expense = alias(accounts, 'expense');
    return executor
      .select({
        id: prepayments.id,
        companyId: prepayments.companyId,
        name: prepayments.name,
        description: prepayments.description,
        reference: prepayments.reference,
        prepaidAccountId: prepayments.prepaidAccountId,
        expenseAccountId: prepayments.expenseAccountId,
        creditAccountId: prepayments.creditAccountId,
        currency: prepayments.currency,
        amount: prepayments.amount,
        recognizedAmount: prepayments.recognizedAmount,
        startDate: prepayments.startDate,
        months: prepayments.months,
        status: prepayments.status,
        branchId: prepayments.branchId,
        departmentId: prepayments.departmentId,
        costCenterId: prepayments.costCenterId,
        projectId: prepayments.projectId,
        initialEntryId: prepayments.initialEntryId,
        createdBy: prepayments.createdBy,
        activatedBy: prepayments.activatedBy,
        activatedAt: prepayments.activatedAt,
        createdAt: prepayments.createdAt,
        updatedAt: prepayments.updatedAt,
        prepaidAccountCode: prepaid.code,
        expenseAccountCode: expense.code,
        remainingAmount: sql<string>`(${prepayments.amount} - ${prepayments.recognizedAmount})::text`,
      })
      .from(prepayments)
      .innerJoin(prepaid, eq(prepaid.id, prepayments.prepaidAccountId))
      .innerJoin(expense, eq(expense.id, prepayments.expenseAccountId));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<Prepayment> {
    const [row] = await tx
      .select()
      .from(prepayments)
      .where(and(eq(prepayments.id, id), eq(prepayments.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Prepayment', id);
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

const laterOf = (a: string, b: string): string => (a > b ? a : b);
