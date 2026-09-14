import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, getTableColumns, or, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { P, type PaginatedResult } from '@accounting/types';
import type { CreateIntercompanyInput, ListIntercompanyQuery } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError, PermissionDeniedError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  companies,
  intercompanyTransactions,
  journalEntries,
  journalLines,
  type Company,
  type IntercompanyTransaction,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import { AccountingPostingService } from '@/modules/accounting/journals/posting.service';
import { DocumentNumberingService } from '@/modules/accounting/numbering/document-numbering.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { PermissionResolverService } from '@/modules/rbac/permission-resolver.service';

const MODULE = 'INTERCOMPANY';

export interface IntercompanyView extends IntercompanyTransaction {
  fromCompanyCode: string;
  fromCompanyName: string;
  toCompanyCode: string;
  toCompanyName: string;
  fromAccountCode: string;
  toAccountCode: string;
  fromJournalNumber: string | null;
  toJournalNumber: string | null;
}

/**
 * One event, two ledgers. Posting writes the originating company's entry
 * (Dr chosen account / Cr intercompany payable) and the receiving company's
 * mirror (Dr intercompany receivable / Cr chosen account) inside one database
 * transaction, converting when the two companies keep different base currencies.
 */
@Injectable()
export class IntercompanyService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly accounts: AccountsService,
    private readonly posting: AccountingPostingService,
    private readonly numbering: DocumentNumberingService,
    private readonly rates: ExchangeRatesService,
    private readonly resolver: PermissionResolverService,
  ) {}

  async list(
    organizationId: string,
    query: ListIntercompanyQuery,
  ): Promise<PaginatedResult<IntercompanyView>> {
    const filters: SQL[] = [eq(intercompanyTransactions.organizationId, organizationId)];
    if (query.status) filters.push(eq(intercompanyTransactions.status, query.status));
    if (query.companyId)
      filters.push(
        or(
          eq(intercompanyTransactions.fromCompanyId, query.companyId),
          eq(intercompanyTransactions.toCompanyId, query.companyId),
        )!,
      );
    if (query.search)
      filters.push(
        sql`(${intercompanyTransactions.documentNumber} ilike ${`%${query.search}%`} or ${intercompanyTransactions.description} ilike ${`%${query.search}%`})`,
      );
    const where = and(...filters);
    const [rows, countRows] = await Promise.all([
      this.viewQuery(this.db)
        .where(where)
        .orderBy(
          desc(intercompanyTransactions.transactionDate),
          desc(intercompanyTransactions.documentNumber),
        )
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)` })
        .from(intercompanyTransactions)
        .where(where),
    ]);
    return toPaginatedResult(rows, Number(countRows[0]?.total ?? 0), query);
  }

  async get(organizationId: string, id: string): Promise<IntercompanyView> {
    const [row] = await this.viewQuery(this.db).where(
      and(
        eq(intercompanyTransactions.id, id),
        eq(intercompanyTransactions.organizationId, organizationId),
      ),
    );
    if (!row) throw new NotFoundError('Intercompany transaction', id);
    return row;
  }

  async create(
    organizationId: string,
    actor: AuthenticatedUser,
    input: CreateIntercompanyInput,
  ): Promise<IntercompanyView> {
    const id = await this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [existing] = await tx
          .select({ id: intercompanyTransactions.id })
          .from(intercompanyTransactions)
          .where(
            and(
              eq(intercompanyTransactions.organizationId, organizationId),
              eq(intercompanyTransactions.idempotencyKey, input.idempotencyKey),
            ),
          );
        if (existing) return existing.id;
      }
      const from = await this.company(tx, organizationId, input.fromCompanyId);
      const to = await this.company(tx, organizationId, input.toCompanyId);
      await this.assertPostable(from.id, input.fromAccountId, tx);
      await this.assertPostable(to.id, input.toAccountId, tx);
      await this.assertMember(actor, [from.id, to.id], 'intercompany.post', tx);
      const documentNumber = await this.numbering.allocate(
        from.id,
        'ICT',
        Number(input.transactionDate.slice(0, 4)),
        tx,
      );
      const [row] = await tx
        .insert(intercompanyTransactions)
        .values({
          organizationId,
          documentNumber,
          fromCompanyId: from.id,
          toCompanyId: to.id,
          transactionDate: input.transactionDate,
          description: input.description,
          reference: input.reference ?? null,
          currency: from.baseCurrency,
          amount: Money.parse(input.amount, from.baseCurrency).toString(),
          fromAccountId: input.fromAccountId,
          toAccountId: input.toAccountId,
          idempotencyKey: input.idempotencyKey ?? null,
          createdBy: actor.id,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'IntercompanyTransaction',
          entityId: row!.id,
          newValue: { documentNumber, from: from.code, to: to.code, amount: row!.amount },
          metadata: { actor: actor.email },
          organizationId,
          companyId: from.id,
        },
        tx,
      );
      return row!.id;
    });
    return this.get(organizationId, id);
  }

  /** Posts both mirrored entries or nothing. Idempotent on a posted transaction. */
  async post(
    organizationId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<IntercompanyView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(intercompanyTransactions)
        .where(
          and(
            eq(intercompanyTransactions.id, id),
            eq(intercompanyTransactions.organizationId, organizationId),
          ),
        )
        .for('update');
      if (!existing) throw new NotFoundError('Intercompany transaction', id);
      if (existing.status === 'POSTED') return;
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is ${existing.status}.`,
        );
      const from = await this.company(tx, organizationId, existing.fromCompanyId);
      const to = await this.company(tx, organizationId, existing.toCompanyId);
      await this.assertMember(actor, [from.id, to.id], 'intercompany.post', tx);
      const payable = await this.accounts.resolveMapped(from.id, 'INTERCOMPANY_PAYABLE', tx);
      const receivable = await this.accounts.resolveMapped(to.id, 'INTERCOMPANY_RECEIVABLE', tx);
      const fromAmount = Money.of(existing.amount, existing.currency);
      const rate = await this.rates.rateFor(
        organizationId,
        from.baseCurrency,
        to.baseCurrency,
        existing.transactionDate,
        tx,
      );
      const toAmount = fromAmount.convert(to.baseCurrency, rate);
      const fromEntry = await this.posting.postEvent(
        tx,
        {
          companyId: from.id,
          entryDate: existing.transactionDate,
          description: `Intercompany ${existing.documentNumber} to ${to.code}: ${existing.description}`,
          reference: existing.reference ?? existing.documentNumber,
          journalType: 'GENERAL',
          sourceType: 'INTERCOMPANY',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: existing.fromAccountId,
              debit: fromAmount.toString(),
              credit: '0',
              description: existing.description,
            },
            {
              accountId: payable.id,
              debit: '0',
              credit: fromAmount.toString(),
              description: `Due to ${to.code}`,
            },
          ],
        },
        { permission: P['intercompany.post'] },
      );
      const toEntry = await this.posting.postEvent(
        tx,
        {
          companyId: to.id,
          entryDate: existing.transactionDate,
          description: `Intercompany ${existing.documentNumber} from ${from.code}: ${existing.description}`,
          reference: existing.reference ?? existing.documentNumber,
          journalType: 'GENERAL',
          sourceType: 'INTERCOMPANY',
          sourceId: existing.id,
          actor,
          lines: [
            {
              accountId: receivable.id,
              debit: toAmount.toString(),
              credit: '0',
              description: `Due from ${from.code}`,
            },
            {
              accountId: existing.toAccountId,
              debit: '0',
              credit: toAmount.toString(),
              description: existing.description,
            },
          ],
        },
        { permission: P['intercompany.post'] },
      );
      await tx
        .update(intercompanyTransactions)
        .set({
          status: 'POSTED',
          fromJournalEntryId: fromEntry.id,
          toJournalEntryId: toEntry.id,
          postedBy: actor.id,
          postedAt: new Date(),
        })
        .where(eq(intercompanyTransactions.id, id));
      await this.audit.record(
        {
          action: 'POST',
          module: MODULE,
          entityType: 'IntercompanyTransaction',
          entityId: id,
          newValue: {
            status: 'POSTED',
            fromJournal: fromEntry.documentNumber,
            toJournal: toEntry.documentNumber,
            rate,
          },
          metadata: { actor: actor.email, documentNumber: existing.documentNumber },
          organizationId,
          companyId: from.id,
        },
        tx,
      );
    });
    return this.get(organizationId, id);
  }

  /** Reverses both entries. */
  async reverse(
    organizationId: string,
    actor: AuthenticatedUser,
    id: string,
    reason: string,
  ): Promise<IntercompanyView> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(intercompanyTransactions)
        .where(
          and(
            eq(intercompanyTransactions.id, id),
            eq(intercompanyTransactions.organizationId, organizationId),
          ),
        )
        .for('update');
      if (!existing) throw new NotFoundError('Intercompany transaction', id);
      if (
        existing.status !== 'POSTED' ||
        !existing.fromJournalEntryId ||
        !existing.toJournalEntryId
      )
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          `${existing.documentNumber} is not posted.`,
        );
      await this.assertMember(
        actor,
        [existing.fromCompanyId, existing.toCompanyId],
        'intercompany.post',
        tx,
      );
      for (const [companyId, entryId] of [
        [existing.fromCompanyId, existing.fromJournalEntryId],
        [existing.toCompanyId, existing.toJournalEntryId],
      ] as const) {
        const lines = await tx
          .select()
          .from(journalLines)
          .where(eq(journalLines.journalEntryId, entryId))
          .orderBy(asc(journalLines.lineNumber));
        const reversal = await this.posting.postEvent(
          tx,
          {
            companyId,
            entryDate: existing.transactionDate,
            description: `Reversal of ${existing.documentNumber}: ${reason}`,
            reference: existing.documentNumber,
            journalType: 'REVERSAL',
            sourceType: 'INTERCOMPANY_REVERSAL',
            sourceId: existing.id,
            reversalOfId: entryId,
            actor,
            lines: lines.map((l) => ({
              accountId: l.accountId,
              debit: l.credit,
              credit: l.debit,
              description: l.description,
            })),
          },
          { permission: P['intercompany.post'] },
        );
        await tx
          .update(journalEntries)
          .set({ status: 'REVERSED', reversedById: reversal.id })
          .where(eq(journalEntries.id, entryId));
      }
      await tx
        .update(intercompanyTransactions)
        .set({ status: 'REVERSED' })
        .where(eq(intercompanyTransactions.id, id));
      await this.audit.record(
        {
          action: 'REVERSE',
          module: MODULE,
          entityType: 'IntercompanyTransaction',
          entityId: id,
          newValue: { status: 'REVERSED', reason },
          metadata: { actor: actor.email, documentNumber: existing.documentNumber },
          organizationId,
          companyId: existing.fromCompanyId,
        },
        tx,
      );
    });
    return this.get(organizationId, id);
  }

  async remove(organizationId: string, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(intercompanyTransactions)
        .where(
          and(
            eq(intercompanyTransactions.id, id),
            eq(intercompanyTransactions.organizationId, organizationId),
          ),
        )
        .for('update');
      if (!existing) throw new NotFoundError('Intercompany transaction', id);
      if (existing.status !== 'DRAFT')
        throw new BusinessRuleError(
          ErrorCodes.DOCUMENT_INVALID_STATE,
          'Only drafts can be deleted.',
        );
      await tx.delete(intercompanyTransactions).where(eq(intercompanyTransactions.id, id));
    });
  }

  // ----------------------------------------------------------------- helpers

  /** The actor needs the permission in every company touched, not just the active one. */
  private async assertMember(
    actor: AuthenticatedUser,
    companyIds: string[],
    permission: string,
    tx: DbExecutor,
  ): Promise<void> {
    for (const companyId of companyIds) {
      const access = await this.resolver.resolve(actor.id, companyId, tx);
      if (!access.permissions.has(permission)) throw new PermissionDeniedError([permission]);
    }
  }

  private async company(tx: DbExecutor, organizationId: string, id: string): Promise<Company> {
    const [row] = await tx
      .select()
      .from(companies)
      .where(and(eq(companies.id, id), eq(companies.organizationId, organizationId)));
    if (!row) throw new NotFoundError('Company', id);
    if (row.status !== 'ACTIVE')
      throw new BusinessRuleError(ErrorCodes.PARTY_INACTIVE, `Company ${row.code} is inactive.`);
    return row;
  }

  private async assertPostable(
    companyId: string,
    accountId: string,
    tx: DbExecutor,
  ): Promise<void> {
    const [account] = await this.accounts.findByIds(companyId, [accountId], tx);
    if (!account) throw new NotFoundError('Account', accountId);
    if (account.isHeader || account.status !== 'ACTIVE')
      throw new BusinessRuleError(
        ErrorCodes.ACCOUNT_NOT_POSTABLE,
        `${account.code} ${account.name} cannot be used for postings.`,
      );
  }

  private viewQuery(executor: DbExecutor) {
    const fromCo = sql.raw('"intercompany_transactions"."from_company_id"');
    const toCo = sql.raw('"intercompany_transactions"."to_company_id"');
    return executor
      .select({
        ...getTableColumns(intercompanyTransactions),
        fromCompanyCode: sql<string>`(select c.code from companies c where c.id = ${fromCo})`,
        fromCompanyName: sql<string>`(select c.name from companies c where c.id = ${fromCo})`,
        toCompanyCode: sql<string>`(select c.code from companies c where c.id = ${toCo})`,
        toCompanyName: sql<string>`(select c.name from companies c where c.id = ${toCo})`,
        fromAccountCode: sql<string>`(select a.code from accounts a where a.id = ${sql.raw('"intercompany_transactions"."from_account_id"')})`,
        toAccountCode: sql<string>`(select a.code from accounts a where a.id = ${sql.raw('"intercompany_transactions"."to_account_id"')})`,
        fromJournalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${sql.raw('"intercompany_transactions"."from_journal_entry_id"')})`,
        toJournalNumber: sql<
          string | null
        >`(select j.document_number from journal_entries j where j.id = ${sql.raw('"intercompany_transactions"."to_journal_entry_id"')})`,
      })
      .from(intercompanyTransactions);
  }
}
