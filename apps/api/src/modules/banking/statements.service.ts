import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lte,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { MatchKind, PaginatedResult } from '@accounting/types';
import type {
  ImportStatementInput,
  ListStatementLinesQuery,
  ListStatementsQuery,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  bankLineMatches,
  bankReconciliations,
  bankStatementLines,
  bankStatements,
  journalEntries,
  journalLines,
  type BankReconciliation,
  type BankStatement,
  type BankStatementLine,
} from '@/database/schema';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from './banking.service';
import {
  matchStatementLines,
  reconciliationDifference,
  type LedgerCandidate,
} from './matching.logic';

const MODULE = 'BANKING';
const LEDGER_STATUSES = ['POSTED', 'LOCKED', 'REVERSED'] as const;

/**
 * A voided bank transaction and its reversal cancel each other by `asOf`:
 * neither is a reconciling item (the bank saw neither). Reversed entries whose
 * reversal is dated after `asOf` still count - they are in the ledger balance.
 */
const notCancelled = (asOf: string) =>
  sql`NOT EXISTS (select 1 from journal_entries r where (r.id = ${journalEntries.reversedById} and r.entry_date <= ${asOf}::date) or (r.id = ${journalEntries.reversalOfId} and r.status = 'REVERSED'))`;

export interface StatementView extends BankStatement {
  bankAccountCode: string;
  bankAccountName: string;
  lineCount: number;
  matchedCount: number;
  unmatchedCount: number;
  exceptionCount: number;
  possibleCount: number;
}

export interface StatementLineView extends BankStatementLine {
  matchedJournalLineId: string | null;
  matchedJournalNumber: string | null;
  matchedEntryDate: string | null;
  matchedDescription: string | null;
  matchKind: MatchKind | null;
}

export interface LedgerLineView {
  journalLineId: string;
  journalEntryId: string;
  journalNumber: string;
  entryDate: string;
  description: string | null;
  reference: string | null;
  debit: string;
  credit: string;
  matchedStatementLineId: string | null;
}

export interface ReconciliationView {
  statement: StatementView;
  reconciliation: BankReconciliation | null;
  figures: {
    statementBalance: string;
    ledgerBalance: string;
    depositsInTransit: string;
    outstandingPayments: string;
    unrecordedCredits: string;
    unrecordedDebits: string;
    difference: string;
  };
  outstandingLedgerLines: LedgerLineView[];
  canComplete: boolean;
}

/**
 * Bank statements and reconciliation. Imported lines run through the matching
 * engine against the posted journal lines on the bank's GL account; users
 * review exceptions, match manually, or record missing items as bank
 * transactions. Completing a reconciliation requires every statement line to
 * be explained and the adjusted balances to agree.
 */
@Injectable()
export class StatementsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly numbering: DocumentNumberingService,
    private readonly banking: BankingService,
  ) {}

  // ----------------------------------------------------------------- queries

  async list(
    companyId: string,
    query: ListStatementsQuery,
  ): Promise<PaginatedResult<StatementView>> {
    const filters: SQL[] = [eq(bankStatements.companyId, companyId)];
    if (query.bankAccountId) filters.push(eq(bankStatements.bankAccountId, query.bankAccountId));
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(desc(bankStatements.statementDate), desc(bankStatements.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(bankStatements)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(companyId: string, id: string): Promise<StatementView> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(bankStatements.id, id), eq(bankStatements.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Bank statement', id);
    return row;
  }

  async lines(
    companyId: string,
    statementId: string,
    query: ListStatementLinesQuery,
  ): Promise<StatementLineView[]> {
    await this.get(companyId, statementId);
    const filters: SQL[] = [eq(bankStatementLines.statementId, statementId)];
    if (query.status) filters.push(eq(bankStatementLines.status, query.status));
    const rows = await this.db
      .select({
        line: bankStatementLines,
        matchedJournalLineId: bankLineMatches.journalLineId,
        matchKind: bankLineMatches.kind,
        matchedJournalNumber: journalEntries.documentNumber,
        matchedEntryDate: journalEntries.entryDate,
        matchedDescription: journalLines.description,
      })
      .from(bankStatementLines)
      .leftJoin(bankLineMatches, eq(bankLineMatches.statementLineId, bankStatementLines.id))
      .leftJoin(journalLines, eq(journalLines.id, bankLineMatches.journalLineId))
      .leftJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(and(...filters))
      .orderBy(asc(bankStatementLines.lineNumber));
    return rows.map((r) => ({
      ...r.line,
      matchedJournalLineId: r.matchedJournalLineId ?? null,
      matchedJournalNumber: r.matchedJournalNumber ?? null,
      matchedEntryDate: r.matchedEntryDate ?? null,
      matchedDescription: r.matchedDescription ?? null,
      matchKind: r.matchKind ?? null,
    }));
  }

  /** Posted ledger lines on the bank's GL account up to the statement date, with their match state. */
  async ledgerLines(
    companyId: string,
    statementId: string,
    onlyUnmatched: boolean,
  ): Promise<LedgerLineView[]> {
    const statement = await this.get(companyId, statementId);
    const account = await this.banking.bankAccount(companyId, statement.bankAccountId);
    return this.ledgerLinesFor(
      this.db,
      companyId,
      account.glAccountId,
      statement.statementDate,
      onlyUnmatched,
    );
  }

  // ---------------------------------------------------------------- commands

  /** Imports the lines and runs the matching engine. */
  async import(
    companyId: string,
    actor: AuthenticatedUser,
    input: ImportStatementInput,
  ): Promise<StatementView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: bankStatements.id })
          .from(bankStatements)
          .where(
            and(
              eq(bankStatements.companyId, companyId),
              eq(bankStatements.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const account = await this.banking.bankAccount(companyId, input.bankAccountId, tx);
      const currency = account.currency;
      const opening = Money.of(input.openingBalance, currency);
      const closing = Money.of(input.closingBalance, currency);
      const movement = Money.sum(
        input.lines.map((l) => Money.of(l.amount, currency)),
        currency,
      );
      if (!opening.add(movement).equals(closing)) {
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Opening ${opening.toString()} plus movements ${movement.toString()} does not equal the closing balance ${closing.toString()}.`,
          { expected: opening.add(movement).toString() },
        );
      }
      const statementNumber = await this.numbering.allocate(
        companyId,
        'STM',
        Number(input.statementDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(bankStatements)
        .values({
          companyId,
          statementNumber,
          bankAccountId: account.id,
          statementDate: input.statementDate,
          openingBalance: opening.toString(),
          closingBalance: closing.toString(),
          fileName: input.fileName ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          importedBy: actor.id,
        })
        .returning();
      const inserted = await tx
        .insert(bankStatementLines)
        .values(
          input.lines.map((l, i) => ({
            statementId: created!.id,
            lineNumber: i + 1,
            lineDate: l.lineDate,
            description: l.description,
            reference: l.reference ?? null,
            amount: Money.of(l.amount, currency).toString(),
            balance: l.balance ? Money.of(l.balance, currency).toString() : null,
          })),
        )
        .returning();
      await this.runMatching(
        tx,
        companyId,
        account.glAccountId,
        currency,
        created!.id,
        inserted,
        actor.id,
      );
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BankStatement',
          entityId: created!.id,
          newValue: {
            statementNumber,
            bankAccount: account.code,
            lines: inserted.length,
            closingBalance: closing.toString(),
          },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    });
    return this.get(companyId, id);
  }

  /** Re-runs the engine on lines still UNMATCHED / EXCEPTION (after new ledger postings). */
  async rematch(
    companyId: string,
    actor: AuthenticatedUser,
    statementId: string,
  ): Promise<StatementView> {
    await this.db.transaction(async (tx) => {
      const statement = await this.lock(tx, companyId, statementId);
      if (statement.status === 'RECONCILED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${statement.statementNumber} is reconciled.`,
        );
      const account = await this.banking.bankAccount(companyId, statement.bankAccountId, tx);
      const open = await tx
        .select()
        .from(bankStatementLines)
        .where(
          and(
            eq(bankStatementLines.statementId, statementId),
            inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          ),
        );
      await this.runMatching(
        tx,
        companyId,
        account.glAccountId,
        account.currency,
        statementId,
        open,
        actor.id,
      );
    });
    return this.get(companyId, statementId);
  }

  async matchLine(
    companyId: string,
    actor: AuthenticatedUser,
    statementId: string,
    lineId: string,
    journalLineId: string,
  ): Promise<StatementLineView> {
    await this.db.transaction(async (tx) => {
      const statement = await this.lock(tx, companyId, statementId);
      if (statement.status === 'RECONCILED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${statement.statementNumber} is reconciled.`,
        );
      const account = await this.banking.bankAccount(companyId, statement.bankAccountId, tx);
      const [line] = await tx
        .select()
        .from(bankStatementLines)
        .where(
          and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.statementId, statementId)),
        )
        .for('update');
      if (!line) throw new NotFoundError('Statement line', lineId);
      if (line.status === 'MATCHED' || line.status === 'RECONCILED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Line is already matched; unmatch it first.',
        );
      const [candidate] = await tx
        .select({ line: journalLines, entry: journalEntries })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
        .where(
          and(
            eq(journalLines.id, journalLineId),
            eq(journalLines.accountId, account.glAccountId),
            eq(journalEntries.companyId, companyId),
            inArray(journalEntries.status, [...LEDGER_STATUSES]),
          ),
        );
      if (!candidate)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'The ledger line is not a posted line on this bank account.',
        );
      const ledgerAmount = Money.of(candidate.line.debit, account.currency).subtract(
        Money.of(candidate.line.credit, account.currency),
      );
      if (!ledgerAmount.equals(Money.of(line.amount, account.currency)))
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          `Amounts differ: statement ${line.amount}, ledger ${ledgerAmount.toString()}.`,
        );
      const [taken] = await tx
        .select({ id: bankLineMatches.id })
        .from(bankLineMatches)
        .where(eq(bankLineMatches.journalLineId, journalLineId));
      if (taken)
        throw new BusinessRuleError(
          ErrorCodes.CONFLICT,
          'That ledger line is already matched to another statement line.',
        );
      await tx
        .insert(bankLineMatches)
        .values({ statementLineId: lineId, journalLineId, kind: 'MANUAL', matchedBy: actor.id });
      await tx
        .update(bankStatementLines)
        .set({
          status: 'MATCHED',
          matchNote: `Matched manually to ${candidate.entry.documentNumber}`,
        })
        .where(eq(bankStatementLines.id, lineId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankStatementLine',
          entityId: lineId,
          newValue: { status: 'MATCHED', journalLineId },
          metadata: { statementNumber: statement.statementNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return (await this.lines(companyId, statementId, {})).find((l) => l.id === lineId)!;
  }

  async unmatchLine(
    companyId: string,
    actor: AuthenticatedUser,
    statementId: string,
    lineId: string,
  ): Promise<StatementLineView> {
    await this.db.transaction(async (tx) => {
      const statement = await this.lock(tx, companyId, statementId);
      if (statement.status === 'RECONCILED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${statement.statementNumber} is reconciled.`,
        );
      const [match] = await tx
        .select()
        .from(bankLineMatches)
        .where(eq(bankLineMatches.statementLineId, lineId));
      if (match?.reconciliationId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Line belongs to a completed reconciliation.',
        );
      if (match) await tx.delete(bankLineMatches).where(eq(bankLineMatches.id, match.id));
      await tx
        .update(bankStatementLines)
        .set({ status: 'UNMATCHED', matchNote: 'Unmatched manually' })
        .where(
          and(eq(bankStatementLines.id, lineId), eq(bankStatementLines.statementId, statementId)),
        );
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankStatementLine',
          entityId: lineId,
          newValue: { status: 'UNMATCHED' },
          metadata: { statementNumber: statement.statementNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return (await this.lines(companyId, statementId, {})).find((l) => l.id === lineId)!;
  }

  /** Marks a line as a bank-side duplicate (ignored for reconciliation). */
  async ignoreLine(
    companyId: string,
    actor: AuthenticatedUser,
    statementId: string,
    lineId: string,
    note: string,
  ): Promise<StatementLineView> {
    await this.db.transaction(async (tx) => {
      const statement = await this.lock(tx, companyId, statementId);
      if (statement.status === 'RECONCILED')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${statement.statementNumber} is reconciled.`,
        );
      await tx
        .update(bankStatementLines)
        .set({ status: 'DUPLICATE', matchNote: note })
        .where(
          and(
            eq(bankStatementLines.id, lineId),
            eq(bankStatementLines.statementId, statementId),
            inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          ),
        );
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankStatementLine',
          entityId: lineId,
          newValue: { status: 'DUPLICATE', note },
          metadata: { statementNumber: statement.statementNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return (await this.lines(companyId, statementId, {})).find((l) => l.id === lineId)!;
  }

  // ---------------------------------------------------------- reconciliation

  async reconciliation(companyId: string, statementId: string): Promise<ReconciliationView> {
    const statement = await this.get(companyId, statementId);
    const account = await this.banking.bankAccount(companyId, statement.bankAccountId);
    const currency = account.currency;
    const [existing] = await this.db
      .select()
      .from(bankReconciliations)
      .where(eq(bankReconciliations.statementId, statementId));
    const ledgerBalance = Money.of(
      await this.banking.bookBalance(
        companyId,
        account.glAccountId,
        currency,
        statement.statementDate,
      ),
      currency,
    );
    const outstanding = await this.ledgerLinesFor(
      this.db,
      companyId,
      account.glAccountId,
      statement.statementDate,
      true,
    );
    const depositsInTransit = Money.sum(
      outstanding.map((l) => Money.of(l.debit, currency)),
      currency,
    );
    const outstandingPayments = Money.sum(
      outstanding.map((l) => Money.of(l.credit, currency)),
      currency,
    );
    const lines = await this.lines(companyId, statementId, {});
    const unexplained = lines.filter(
      (l) => l.status === 'UNMATCHED' || l.status === 'POSSIBLE_MATCH' || l.status === 'EXCEPTION',
    );
    const unrecordedCredits = Money.sum(
      unexplained.filter((l) => Number(l.amount) > 0).map((l) => Money.of(l.amount, currency)),
      currency,
    );
    const unrecordedDebits = Money.sum(
      unexplained
        .filter((l) => Number(l.amount) < 0)
        .map((l) => Money.of(l.amount, currency).abs()),
      currency,
    );
    const figures = {
      statementBalance: Money.of(statement.closingBalance, currency),
      ledgerBalance,
      depositsInTransit,
      outstandingPayments,
      unrecordedCredits,
      unrecordedDebits,
    };
    const difference = reconciliationDifference(figures);
    return {
      statement,
      reconciliation: existing ?? null,
      figures: {
        statementBalance: figures.statementBalance.toString(),
        ledgerBalance: ledgerBalance.toString(),
        depositsInTransit: depositsInTransit.toString(),
        outstandingPayments: outstandingPayments.toString(),
        unrecordedCredits: unrecordedCredits.toString(),
        unrecordedDebits: unrecordedDebits.toString(),
        difference: difference.toString(),
      },
      outstandingLedgerLines: outstanding,
      canComplete: statement.status === 'OPEN' && unexplained.length === 0 && difference.isZero(),
    };
  }

  /** Locks the matches in as reconciled; refused while lines are unexplained or balances disagree. */
  async complete(
    companyId: string,
    actor: AuthenticatedUser,
    statementId: string,
    notes?: string,
  ): Promise<ReconciliationView> {
    await this.db.transaction(async (tx) => {
      const statement = await this.lock(tx, companyId, statementId);
      if (statement.status === 'RECONCILED') return;
      const view = await this.reconciliation(companyId, statementId);
      if (!view.canComplete) {
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `Reconciliation is not complete: ${view.figures.difference !== '0.0000' ? `difference ${view.figures.difference}` : 'unexplained statement lines remain'}.`,
          view.figures,
        );
      }
      const [rec] = await tx
        .insert(bankReconciliations)
        .values({
          companyId,
          bankAccountId: statement.bankAccountId,
          statementId,
          status: 'COMPLETED',
          statementDate: statement.statementDate,
          statementBalance: view.figures.statementBalance,
          ledgerBalance: view.figures.ledgerBalance,
          depositsInTransit: view.figures.depositsInTransit,
          outstandingPayments: view.figures.outstandingPayments,
          unrecordedCredits: view.figures.unrecordedCredits,
          unrecordedDebits: view.figures.unrecordedDebits,
          difference: view.figures.difference,
          completedBy: actor.id,
          completedAt: new Date(),
          notes: notes ?? null,
        })
        .onConflictDoUpdate({
          target: bankReconciliations.statementId,
          set: {
            status: 'COMPLETED',
            completedBy: actor.id,
            completedAt: new Date(),
            notes: notes ?? null,
          },
        })
        .returning();
      const lineIds = (
        await tx
          .select({ id: bankStatementLines.id })
          .from(bankStatementLines)
          .where(
            and(
              eq(bankStatementLines.statementId, statementId),
              eq(bankStatementLines.status, 'MATCHED'),
            ),
          )
      ).map((l) => l.id);
      if (lineIds.length) {
        await tx
          .update(bankLineMatches)
          .set({ reconciliationId: rec!.id })
          .where(inArray(bankLineMatches.statementLineId, lineIds));
        await tx
          .update(bankStatementLines)
          .set({ status: 'RECONCILED' })
          .where(inArray(bankStatementLines.id, lineIds));
      }
      await tx
        .update(bankStatements)
        .set({ status: 'RECONCILED' })
        .where(eq(bankStatements.id, statementId));
      await this.audit.record(
        {
          action: 'APPROVE',
          module: MODULE,
          entityType: 'BankReconciliation',
          entityId: rec!.id,
          newValue: { statementNumber: statement.statementNumber, ...view.figures },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.reconciliation(companyId, statementId);
  }

  // ----------------------------------------------------------------- helpers

  private async runMatching(
    tx: DbExecutor,
    companyId: string,
    glAccountId: string,
    currency: string,
    statementId: string,
    lines: BankStatementLine[],
    actorId: string,
  ): Promise<void> {
    if (lines.length === 0) return;
    const settings = await this.banking.settings(companyId, tx);
    const maxDate = lines.reduce((m, l) => (l.lineDate > m ? l.lineDate : m), '0000-01-01');
    const candidates = await this.candidates(
      tx,
      companyId,
      glAccountId,
      maxDate,
      settings.matchDateToleranceDays,
    );
    const outcomes = matchStatementLines(
      lines.map((l) => ({
        id: l.id,
        lineDate: l.lineDate,
        amount: l.amount,
        reference: l.reference,
        description: l.description,
      })),
      candidates,
      currency,
      settings.matchDateToleranceDays,
      settings.autoMatchMinConfidence,
    );
    for (const o of outcomes) {
      if (o.status === 'MATCHED' && o.journalLineId) {
        await tx.insert(bankLineMatches).values({
          statementLineId: o.statementLineId,
          journalLineId: o.journalLineId,
          kind: 'AUTO',
          matchedBy: actorId,
        });
      }
      await tx
        .update(bankStatementLines)
        .set({
          status: o.status,
          matchNote:
            o.status === 'EXCEPTION' || o.status === 'POSSIBLE_MATCH'
              ? `${o.note} candidates:${o.candidates.join(',')}`
              : o.note,
        })
        .where(eq(bankStatementLines.id, o.statementLineId));
    }
    void statementId;
  }

  /** Unmatched posted ledger lines on the bank account up to `maxDate` + tolerance. */
  private async candidates(
    tx: DbExecutor,
    companyId: string,
    glAccountId: string,
    maxDate: string,
    toleranceDays: number,
  ): Promise<LedgerCandidate[]> {
    const matched = await tx.select({ id: bankLineMatches.journalLineId }).from(bankLineMatches);
    const matchedIds = matched.map((m) => m.id);
    const rows = await tx
      .select({
        id: journalLines.id,
        entryDate: journalEntries.entryDate,
        // Statements are in the account currency: a currency-bound account's lines carry it.
        debit: sql<string>`coalesce(${journalLines.foreignDebit}, ${journalLines.debit})`,
        credit: sql<string>`coalesce(${journalLines.foreignCredit}, ${journalLines.credit})`,
        reference: journalEntries.reference,
        description: journalLines.description,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalLines.accountId, glAccountId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          sql`${journalEntries.entryDate} <= (${maxDate}::date + ${toleranceDays}::int)`,
          notCancelled(maxDate),
          matchedIds.length ? notInArray(journalLines.id, matchedIds) : sql`true`,
        ),
      );
    return rows.map((r) => ({
      journalLineId: r.id,
      entryDate: r.entryDate,
      debit: r.debit,
      credit: r.credit,
      reference: r.reference,
      description: r.description,
    }));
  }

  private async ledgerLinesFor(
    executor: DbExecutor,
    companyId: string,
    glAccountId: string,
    asOf: string,
    onlyUnmatched: boolean,
  ): Promise<LedgerLineView[]> {
    const rows = await executor
      .select({
        journalLineId: journalLines.id,
        journalEntryId: journalEntries.id,
        journalNumber: journalEntries.documentNumber,
        entryDate: journalEntries.entryDate,
        description: journalLines.description,
        reference: journalEntries.reference,
        // Statements are in the account currency: a currency-bound account's lines carry it.
        debit: sql<string>`coalesce(${journalLines.foreignDebit}, ${journalLines.debit})`,
        credit: sql<string>`coalesce(${journalLines.foreignCredit}, ${journalLines.credit})`,
        matchedStatementLineId: bankLineMatches.statementLineId,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .leftJoin(bankLineMatches, eq(bankLineMatches.journalLineId, journalLines.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalLines.accountId, glAccountId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          lte(journalEntries.entryDate, asOf),
          notCancelled(asOf),
          onlyUnmatched ? isNull(bankLineMatches.id) : sql`true`,
        ),
      )
      .orderBy(asc(journalEntries.entryDate), asc(journalEntries.documentNumber));
    return rows.map((r) => ({ ...r, matchedStatementLineId: r.matchedStatementLineId ?? null }));
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<BankStatement> {
    const [row] = await tx
      .select()
      .from(bankStatements)
      .where(and(eq(bankStatements.id, id), eq(bankStatements.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Bank statement', id);
    return row;
  }

  private viewQuery(executor: DbExecutor) {
    const count = (status: string) =>
      sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${bankStatements.id} and l.status = ${status})`;
    return executor
      .select({
        ...getTableColumns(bankStatements),
        bankAccountCode: bankAccounts.code,
        bankAccountName: bankAccounts.name,
        lineCount: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${bankStatements.id})`,
        matchedCount: sql<number>`(select count(*)::int from bank_statement_lines l where l.statement_id = ${bankStatements.id} and l.status in ('MATCHED','RECONCILED'))`,
        unmatchedCount: count('UNMATCHED'),
        exceptionCount: count('EXCEPTION'),
        possibleCount: count('POSSIBLE_MATCH'),
      })
      .from(bankStatements)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .$dynamic();
  }
}
