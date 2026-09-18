import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type {
  BankingSettingsInput,
  CreateBankAccountInput,
  CreateBankTransactionInput,
  ListBankTransactionsQuery,
  UpdateBankAccountInput,
  UpdateBankTransactionInput,
  VoidDocumentInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, DuplicateError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { isUniqueViolation } from '@/common/utils/pg-errors';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  accounts,
  bankAccounts,
  bankLineMatches,
  bankStatementLines,
  bankTransactions,
  bankingSettings,
  journalEntries,
  journalLines,
  type BankAccount,
  type BankTransaction,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import {
  AccountingPostingService,
  type PostingLine,
} from '@/modules/accounting/journals/posting.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';

const MODULE = 'BANKING';

export interface BankAccountView extends BankAccount {
  glAccountCode: string;
  glAccountName: string;
  ledgerBalance: string;
  unreconciledCount: number;
  lastStatementDate: string | null;
}

export interface BankTransactionView extends BankTransaction {
  bankAccountCode: string;
  bankAccountName: string;
  counterpartyCode: string | null;
  counterpartyName: string | null;
  toBankAccountCode: string | null;
  journalNumber: string | null;
}

/** Bank / cash accounts, their direct transactions and settings. Balances come from the GL account. */
@Injectable()
export class BankingService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly ledger: GeneralLedgerService,
  ) {}

  // ---------------------------------------------------------------- accounts

  async listAccounts(companyId: string): Promise<BankAccountView[]> {
    const rows = await this.viewQuery(this.db)
      .where(eq(bankAccounts.companyId, companyId))
      .orderBy(asc(bankAccounts.code));
    const activity = await this.ledger.activity({
      companyId,
      to: '9999-12-31',
      accountIds: rows.map((r) => r.glAccountId),
    });
    return rows.map((r) => {
      const a = activity.find((x) => x.accountId === r.glAccountId);
      return {
        ...r,
        ledgerBalance: Money.of(a?.debit ?? '0', r.currency)
          .subtract(Money.of(a?.credit ?? '0', r.currency))
          .toString(),
      };
    });
  }

  async getAccount(companyId: string, id: string): Promise<BankAccountView> {
    const [row] = await this.viewQuery(this.db).where(
      and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Bank account', id);
    return {
      ...row,
      ledgerBalance: await this.ledgerBalance(
        companyId,
        row.glAccountId,
        row.currency,
        '9999-12-31',
      ),
    };
  }

  async ledgerBalance(
    companyId: string,
    glAccountId: string,
    currency: string,
    asOf: string,
    executor: DbExecutor = this.db,
  ): Promise<string> {
    const activity = await this.ledger.activity(
      { companyId, to: asOf, accountIds: [glAccountId] },
      executor,
    );
    const a = activity.find((x) => x.accountId === glAccountId);
    return Money.of(a?.debit ?? '0', currency)
      .subtract(Money.of(a?.credit ?? '0', currency))
      .toString();
  }

  async createAccount(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBankAccountInput,
  ): Promise<BankAccountView> {
    const id = await this.db.transaction(async (tx) => {
      const [gl] = await this.accounts.findByIds(companyId, [input.glAccountId], tx);
      if (
        !gl ||
        gl.isHeader ||
        gl.status !== 'ACTIVE' ||
        gl.type !== 'ASSET' ||
        !['CASH', 'BANK'].includes(gl.subtype ?? '')
      ) {
        throw new BusinessRuleError(
          ErrorCodes.ACCOUNT_NOT_POSTABLE,
          'A bank account must book to an active CASH or BANK asset account.',
        );
      }
      const currency = input.currency ?? (await this.accounts.companyCurrency(companyId, tx));
      let row: BankAccount | undefined;
      try {
        [row] = await tx
          .insert(bankAccounts)
          .values({ companyId, ...input, currency, code: input.code.toUpperCase() })
          .returning();
      } catch (err) {
        if (isUniqueViolation(err, 'bank_accounts_company_code_uq'))
          throw new DuplicateError('Bank account', 'code', input.code);
        if (isUniqueViolation(err, 'bank_accounts_gl_account_uq'))
          throw new BusinessRuleError(
            ErrorCodes.CONFLICT,
            `${gl.code} is already used by another bank account.`,
          );
        throw err;
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BankAccount',
          entityId: row!.id,
          newValue: { code: row!.code, glAccount: gl.code },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return row!.id;
    });
    return this.getAccount(companyId, id);
  }

  async updateAccount(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBankAccountInput,
  ): Promise<BankAccountView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
        .for('update');
      if (!existing) throw new NotFoundError('Bank account', id);
      const { code, currency, ...rest } = input;
      await tx
        .update(bankAccounts)
        .set({
          ...rest,
          ...(code ? { code: code.toUpperCase() } : {}),
          ...(currency ? { currency } : {}),
        })
        .where(eq(bankAccounts.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankAccount',
          entityId: id,
          previousValue: { name: existing.name, status: existing.status },
          newValue: input,
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getAccount(companyId, id);
  }

  async bankAccount(
    companyId: string,
    id: string,
    executor: DbExecutor = this.db,
  ): Promise<BankAccount> {
    const [row] = await executor
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)));
    if (!row) throw new NotFoundError('Bank account', id);
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.PARTY_INACTIVE,
        `Bank account ${row.code} is inactive.`,
      );
    return row;
  }

  // ------------------------------------------------------------ transactions

  async listTransactions(
    companyId: string,
    query: ListBankTransactionsQuery,
  ): Promise<PaginatedResult<BankTransactionView>> {
    const filters: SQL[] = [eq(bankTransactions.companyId, companyId)];
    if (query.bankAccountId)
      filters.push(
        or(
          eq(bankTransactions.bankAccountId, query.bankAccountId),
          eq(bankTransactions.toBankAccountId, query.bankAccountId),
        )!,
      );
    if (query.status) filters.push(eq(bankTransactions.status, query.status));
    if (query.from) filters.push(gte(bankTransactions.transactionDate, query.from));
    if (query.to) filters.push(lte(bankTransactions.transactionDate, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      filters.push(
        or(
          ilike(bankTransactions.documentNumber, term),
          ilike(bankTransactions.reference, term),
          ilike(bankTransactions.memo, term),
        )!,
      );
    }
    const where = and(...filters);
    const direction = query.sortDir === 'asc' ? asc : desc;
    const [rows, countRows] = await Promise.all([
      this.txQuery(this.db)
        .where(where)
        .orderBy(direction(bankTransactions.transactionDate), desc(bankTransactions.documentNumber))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(bankTransactions)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async getTransaction(companyId: string, id: string): Promise<BankTransactionView> {
    const [row] = await this.txQuery(this.db).where(
      and(eq(bankTransactions.id, id), eq(bankTransactions.companyId, companyId)),
    );
    if (!row) throw new NotFoundError('Bank transaction', id);
    return row;
  }

  async createTransaction(
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBankTransactionInput,
  ): Promise<BankTransactionView> {
    const id = await this.db.transaction((tx) =>
      this.createTransactionInTx(tx, companyId, actor, input),
    );
    return this.getTransaction(companyId, id);
  }

  /** Same as `createTransaction` inside a caller's transaction (bank feed rules, petty cash). Returns the id. */
  async createTransactionInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    input: CreateBankTransactionInput,
  ): Promise<string> {
    {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: bankTransactions.id })
          .from(bankTransactions)
          .where(
            and(
              eq(bankTransactions.companyId, companyId),
              eq(bankTransactions.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const account = await this.bankAccount(companyId, input.bankAccountId, tx);
      await this.validateSides(companyId, input, tx);
      await this.posting.resolvePeriod(tx, companyId, input.transactionDate, { draft: true });
      const documentNumber = await this.numbering.allocate(
        companyId,
        'BTX',
        Number(input.transactionDate.slice(0, 4)),
        tx,
      );
      const [created] = await tx
        .insert(bankTransactions)
        .values({
          companyId,
          documentNumber,
          bankAccountId: account.id,
          transactionType: input.transactionType,
          transactionDate: input.transactionDate,
          amount: Money.parse(input.amount, account.currency).toString(),
          currency: account.currency,
          counterpartyAccountId:
            input.transactionType === 'TRANSFER' ? null : input.counterpartyAccountId!,
          toBankAccountId: input.transactionType === 'TRANSFER' ? input.toBankAccountId! : null,
          reference: input.reference ?? null,
          memo: input.memo ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      if (input.statementLineId) {
        // Remember which statement line this transaction explains so posting can match it.
        await tx
          .update(bankStatementLines)
          .set({ matchNote: `pending:${created!.id}` })
          .where(eq(bankStatementLines.id, input.statementLineId));
      }
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'BankTransaction',
          entityId: created!.id,
          newValue: { documentNumber, type: input.transactionType, amount: created!.amount },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return created!.id;
    }
  }

  async updateTransaction(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBankTransactionInput,
  ): Promise<BankTransactionView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      const merged = {
        ...existing,
        ...input,
        amount: input.amount ?? existing.amount,
        counterpartyAccountId:
          input.counterpartyAccountId ?? existing.counterpartyAccountId ?? undefined,
        toBankAccountId: input.toBankAccountId ?? existing.toBankAccountId ?? undefined,
      };
      await this.validateSides(companyId, merged as CreateBankTransactionInput, tx);
      await tx
        .update(bankTransactions)
        .set({
          transactionType: merged.transactionType,
          transactionDate: merged.transactionDate,
          amount: Money.parse(merged.amount, existing.currency).toString(),
          counterpartyAccountId:
            merged.transactionType === 'TRANSFER' ? null : (merged.counterpartyAccountId ?? null),
          toBankAccountId:
            merged.transactionType === 'TRANSFER' ? (merged.toBankAccountId ?? null) : null,
          reference: input.reference === undefined ? existing.reference : input.reference,
          memo: input.memo === undefined ? existing.memo : input.memo,
        })
        .where(eq(bankTransactions.id, id));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankTransaction',
          entityId: id,
          newValue: input,
          metadata: { documentNumber: existing.documentNumber, actor: actor.email },
          companyId,
        },
        tx,
      );
    });
    return this.getTransaction(companyId, id);
  }

  async removeTransaction(companyId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      await tx
        .update(bankStatementLines)
        .set({ matchNote: null })
        .where(eq(bankStatementLines.matchNote, `pending:${id}`));
      await tx.delete(bankTransactions).where(eq(bankTransactions.id, id));
      await this.audit.record(
        {
          action: 'DELETE',
          module: MODULE,
          entityType: 'BankTransaction',
          entityId: id,
          previousValue: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
    });
  }

  /** Posts the cash movement; a statement line recorded through this transaction is matched to it. */
  async postTransaction(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<BankTransactionView> {
    await this.db.transaction((tx) => this.postTransactionInTx(tx, companyId, actor, id));
    return this.getTransaction(companyId, id);
  }

  /** Same as `postTransaction` inside a caller's transaction; returns the journal entry id. */
  async postTransactionInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<string | null> {
    {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status === 'POSTED') return existing.journalEntryId;
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      const account = await this.bankAccount(companyId, existing.bankAccountId, tx);
      const lines = await this.postingLines(companyId, existing, account, tx);
      const entry = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: existing.transactionDate,
          description: `${label(existing.transactionType)} ${existing.documentNumber}${existing.memo ? ` - ${existing.memo}` : ''}`,
          reference: existing.reference ?? existing.documentNumber,
          journalType: 'GENERAL',
          branchId: account.branchId,
          sourceType: 'BANK_TRANSACTION',
          sourceId: existing.id,
          actor,
          lines,
        },
        { permission: P['bank-transaction.post'] },
      );
      await tx
        .update(bankTransactions)
        .set({
          status: 'POSTED',
          journalEntryId: entry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(bankTransactions.id, id));
      // Statement line recorded through this transaction -> match it to the bank-side journal line.
      const [pending] = await tx
        .select()
        .from(bankStatementLines)
        .where(eq(bankStatementLines.matchNote, `pending:${id}`));
      if (pending) {
        const [bankLine] = await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .where(
            and(
              eq(journalLines.journalEntryId, entry.id),
              eq(journalLines.accountId, account.glAccountId),
            ),
          );
        if (bankLine) {
          await tx.insert(bankLineMatches).values({
            statementLineId: pending.id,
            journalLineId: bankLine.id,
            kind: 'MANUAL',
            matchedBy: actor.id,
          });
          await tx
            .update(bankStatementLines)
            .set({ status: 'MATCHED', matchNote: `Recorded by ${existing.documentNumber}` })
            .where(eq(bankStatementLines.id, pending.id));
        }
      }
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'BankTransaction',
          entityId: id,
          newValue: { status: 'POSTED', journalEntryId: entry.id },
          metadata: { documentNumber: existing.documentNumber },
          companyId,
        },
        tx,
      );
      return entry.id;
    }
  }

  async voidTransaction(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
    input: VoidDocumentInput,
  ): Promise<BankTransactionView> {
    await this.db.transaction(async (tx) => {
      const existing = await this.lock(tx, companyId, id);
      if (existing.status !== 'POSTED' || !existing.journalEntryId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is not posted.`,
        );
      // A reconciled bank line cannot be voided - the statement already confirmed it.
      const lineIds = (
        await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .where(eq(journalLines.journalEntryId, existing.journalEntryId))
      ).map((l) => l.id);
      const [matched] = await tx
        .select({ id: bankLineMatches.id, reconciliationId: bankLineMatches.reconciliationId })
        .from(bankLineMatches)
        .where(inArray(bankLineMatches.journalLineId, lineIds));
      if (matched?.reconciliationId)
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is part of a completed reconciliation.`,
        );
      if (matched) {
        await tx
          .update(bankStatementLines)
          .set({
            status: 'UNMATCHED',
            matchNote: `Match released: ${existing.documentNumber} voided`,
          })
          .where(
            eq(
              bankStatementLines.id,
              (
                await tx
                  .select({ s: bankLineMatches.statementLineId })
                  .from(bankLineMatches)
                  .where(eq(bankLineMatches.id, matched.id))
              )[0]!.s,
            ),
          );
        await tx.delete(bankLineMatches).where(eq(bankLineMatches.id, matched.id));
      }
      const originalLines = await tx.query.journalLines.findMany({
        where: (l, ops) => ops.eq(l.journalEntryId, existing.journalEntryId!),
        orderBy: (l, ops) => ops.asc(l.lineNumber),
      });
      const reversal = await this.posting.postEvent(
        tx,
        {
          companyId,
          entryDate: input.reversalDate ?? existing.transactionDate,
          description: `Void ${existing.documentNumber}: ${input.reason}`,
          reference: existing.documentNumber,
          journalType: 'REVERSAL',
          branchId: null,
          sourceType: 'BANK_TRANSACTION_VOID',
          sourceId: existing.id,
          reversalOfId: existing.journalEntryId,
          actor,
          lines: originalLines.map((l) => ({
            accountId: l.accountId,
            debit: l.credit,
            credit: l.debit,
            description: l.description,
            branchId: l.branchId,
          })),
        },
        { permission: P['bank-transaction.post'] },
      );
      await tx
        .update(journalEntries)
        .set({ status: 'REVERSED', reversedById: reversal.id })
        .where(eq(journalEntries.id, existing.journalEntryId));
      await tx
        .update(bankTransactions)
        .set({ status: 'VOID', reversalJournalEntryId: reversal.id, voidReason: input.reason })
        .where(eq(bankTransactions.id, id));
      await this.audit.record(
        {
          action: 'VOID',
          module: MODULE,
          entityType: 'BankTransaction',
          entityId: id,
          previousValue: { status: 'POSTED' },
          newValue: { status: 'VOID', reversalJournalEntryId: reversal.id },
          metadata: { documentNumber: existing.documentNumber, reason: input.reason },
          companyId,
        },
        tx,
      );
    });
    return this.getTransaction(companyId, id);
  }

  // ---------------------------------------------------------------- settings

  async settings(companyId: string, executor: DbExecutor = this.db) {
    const [row] = await executor
      .select()
      .from(bankingSettings)
      .where(eq(bankingSettings.companyId, companyId));
    return (
      row ?? {
        companyId,
        matchDateToleranceDays: 3,
        autoMatchMinConfidence: 'MEDIUM' as const,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      }
    );
  }

  async updateSettings(companyId: string, actor: AuthenticatedUser, input: BankingSettingsInput) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(bankingSettings)
        .values({ companyId, ...input })
        .onConflictDoUpdate({ target: bankingSettings.companyId, set: { ...input } })
        .returning();
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankingSettings',
          entityId: companyId,
          newValue: input,
          metadata: { editor: actor.email },
          companyId,
        },
        tx,
      );
      return row!;
    });
  }

  // ----------------------------------------------------------------- helpers

  private async postingLines(
    companyId: string,
    t: BankTransaction,
    account: BankAccount,
    tx: DbExecutor,
  ): Promise<PostingLine[]> {
    const amount = t.amount;
    if (t.transactionType === 'TRANSFER') {
      const to = await this.bankAccount(companyId, t.toBankAccountId!, tx);
      return [
        {
          accountId: to.glAccountId,
          debit: amount,
          credit: '0',
          description: `Transfer in from ${account.code}`,
        },
        {
          accountId: account.glAccountId,
          debit: '0',
          credit: amount,
          description: `Transfer out to ${to.code}`,
        },
      ];
    }
    const moneyIn = t.transactionType === 'DEPOSIT' || t.transactionType === 'INTEREST';
    return [
      {
        accountId: account.glAccountId,
        debit: moneyIn ? amount : '0',
        credit: moneyIn ? '0' : amount,
        description: `${label(t.transactionType)} ${t.documentNumber}`,
      },
      {
        accountId: t.counterpartyAccountId!,
        debit: moneyIn ? '0' : amount,
        credit: moneyIn ? amount : '0',
        description: t.memo ?? label(t.transactionType),
      },
    ];
  }

  private async validateSides(
    companyId: string,
    input: Pick<
      CreateBankTransactionInput,
      'transactionType' | 'counterpartyAccountId' | 'toBankAccountId' | 'bankAccountId'
    >,
    tx: DbExecutor,
  ): Promise<void> {
    if (input.transactionType === 'TRANSFER') {
      if (!input.toBankAccountId || input.toBankAccountId === input.bankAccountId)
        throw new BusinessRuleError(
          ErrorCodes.VALIDATION_FAILED,
          'A transfer needs a different destination bank account.',
        );
      await this.bankAccount(companyId, input.toBankAccountId, tx);
      return;
    }
    if (!input.counterpartyAccountId)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'Choose the account on the other side of the entry.',
      );
    const [acct] = await this.accounts.findByIds(companyId, [input.counterpartyAccountId], tx);
    if (!acct || acct.isHeader || acct.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_NOT_POSTABLE,
        'The counterparty account is not postable.',
      );
  }

  private async lock(tx: DbExecutor, companyId: string, id: string): Promise<BankTransaction> {
    const [row] = await tx
      .select()
      .from(bankTransactions)
      .where(and(eq(bankTransactions.id, id), eq(bankTransactions.companyId, companyId)))
      .for('update');
    if (!row) throw new NotFoundError('Bank transaction', id);
    return row;
  }

  private viewQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(bankAccounts),
        glAccountCode: accounts.code,
        glAccountName: accounts.name,
        ledgerBalance: sql<string>`'0'`,
        unreconciledCount: sql<number>`(select count(*)::int from bank_statement_lines l join bank_statements s on s.id = l.statement_id where s.bank_account_id = ${bankAccounts.id} and l.status in ('UNMATCHED','EXCEPTION'))`,
        lastStatementDate: sql<
          string | null
        >`(select max(s.statement_date) from bank_statements s where s.bank_account_id = ${bankAccounts.id})`,
      })
      .from(bankAccounts)
      .innerJoin(accounts, eq(accounts.id, bankAccounts.glAccountId))
      .$dynamic();
  }

  private txQuery(executor: DbExecutor) {
    return executor
      .select({
        ...getTableColumns(bankTransactions),
        bankAccountCode: bankAccounts.code,
        bankAccountName: bankAccounts.name,
        counterpartyCode: accounts.code,
        counterpartyName: accounts.name,
        toBankAccountCode: sql<
          string | null
        >`(select b2.code from bank_accounts b2 where b2.id = ${bankTransactions.toBankAccountId})`,
        journalNumber: sql<
          string | null
        >`(select je.document_number from journal_entries je where je.id = ${bankTransactions.journalEntryId})`,
      })
      .from(bankTransactions)
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankTransactions.bankAccountId))
      .leftJoin(accounts, eq(accounts.id, bankTransactions.counterpartyAccountId))
      .$dynamic();
  }
}

function label(type: BankTransaction['transactionType']): string {
  return {
    DEPOSIT: 'Deposit',
    WITHDRAWAL: 'Withdrawal',
    TRANSFER: 'Bank transfer',
    BANK_FEE: 'Bank fee',
    INTEREST: 'Interest',
  }[type];
}
