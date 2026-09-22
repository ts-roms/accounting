import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { BankSuggestionPayload, PaginatedResult } from '@accounting/types';
import type {
  ApplyBankSuggestionInput,
  BankFeedQueueQuery,
  ExplainBankLineInput,
  SuggestBankFeedInput,
} from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database, type DbExecutor } from '@/database/database.types';
import {
  bankAccounts,
  bankLineMatches,
  bankLineSuggestions,
  bankMatchingRules,
  bankStatementLines,
  bankStatements,
  bankTransactions,
  companies,
  customerPayments,
  customers,
  invoices,
  journalEntries,
  journalLines,
  vendorBills,
  vendorPayments,
  vendors,
  type BankLineSuggestion,
  type BankStatementLine,
} from '@/database/schema';
import { AuditService } from '@/modules/audit/audit.service';
import { BankingService } from '@/modules/banking/banking.service';
import { OutboxService } from '@/modules/integrations/events/outbox.service';
import { NotificationsService } from '@/modules/integrations/notifications/notifications.service';
import { VendorPaymentsService } from '@/modules/payables/vendor-payments.service';
import { CustomerPaymentsService } from '@/modules/receivables/customer-payments.service';
import { businessToday } from '@/common/time/clock';
import { BankFeedRulesService } from './bank-feed-rules.service';
import {
  defaultTransactionType,
  directionOf,
  historyKey,
  suggestForLine,
  type FeedLine,
  type HistoryEntry,
  type OpenDocument,
} from './bank-feed.logic';

const MODULE = 'BANK_FEED';

export interface SuggestionView extends BankLineSuggestion {
  ruleName: string | null;
}

export interface QueueLine {
  id: string;
  statementId: string;
  statementNumber: string;
  bankAccountId: string;
  bankAccountCode: string;
  currency: string;
  lineDate: string;
  description: string;
  reference: string | null;
  amount: string;
  status: BankStatementLine['status'];
  matchNote: string | null;
  ageDays: number;
  suggestions: SuggestionView[];
}

export interface SuggestSummary {
  lines: number;
  suggested: number;
  autoApplied: number;
  failed: number;
}

export interface FeedDashboard {
  asOf: string;
  days: number;
  currency: string;
  imported: number;
  explained: number;
  autoMatched: number;
  ruleApplied: number;
  documentApplied: number;
  manual: number;
  pendingLines: number;
  pendingSuggestions: number;
  staleLines: number;
  /** Share of imported lines explained without a person (matcher + auto-applied rules / documents). */
  automationRate: string;
  byBankAccount: Array<{
    bankAccountId: string;
    code: string;
    name: string;
    imported: number;
    unexplained: number;
    unexplainedIn: string;
    unexplainedOut: string;
  }>;
  topRules: Array<{ id: string; name: string; hitCount: number; lastHitAt: string | null }>;
  ageing: Array<{ bucket: string; lines: number; amount: string }>;
}

/**
 * Bank feed auto-reconciliation (Prompt #12). `suggest` runs the pure
 * engine over unexplained statement lines; `apply` turns a suggestion into
 * the document that explains the line - a posted bank transaction, a
 * customer receipt or a vendor payment created through the owning service -
 * and matches the statement line to that document's bank ledger line. The
 * feed never writes journal rows and never matches without a document.
 */
@Injectable()
export class BankFeedService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly banking: BankingService,
    private readonly customerPayments: CustomerPaymentsService,
    private readonly vendorPayments: VendorPaymentsService,
    private readonly rules: BankFeedRulesService,
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationsService,
  ) {}

  // ------------------------------------------------------------------ suggest

  /** Rebuilds pending suggestions for unexplained lines of open statements; with an actor, auto-applies what policy allows (the scheduler only suggests). */
  async suggest(
    companyId: string,
    actor: AuthenticatedUser | null,
    input: SuggestBankFeedInput = {},
  ): Promise<SuggestSummary> {
    const settings = await this.rules.settings(companyId);
    const rules = await this.rules.activeRules(companyId);
    const filters: SQL[] = [
      eq(bankStatements.companyId, companyId),
      eq(bankStatements.status, 'OPEN'),
      inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
    ];
    if (input.statementId) filters.push(eq(bankStatements.id, input.statementId));
    if (input.bankAccountId) filters.push(eq(bankStatements.bankAccountId, input.bankAccountId));
    const rows = await this.db
      .select({
        line: bankStatementLines,
        bankAccountId: bankStatements.bankAccountId,
        currency: bankAccounts.currency,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(and(...filters))
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.lineNumber));
    const summary: SuggestSummary = { lines: rows.length, suggested: 0, autoApplied: 0, failed: 0 };
    if (rows.length === 0) return summary;
    const currency = rows[0]!.currency;
    const [openInvoices, openBills, history] = await Promise.all([
      this.openInvoices(companyId, currency),
      this.openBills(companyId, currency),
      this.history(companyId),
    ]);
    const toApply: Array<{ lineId: string; suggestionId: string }> = [];
    await this.db.transaction(async (tx) => {
      // Lines whose only explanation is a ledger candidate keep it; the feed adds document / rule explanations beside it.
      await tx
        .update(bankLineSuggestions)
        .set({ status: 'SUPERSEDED' })
        .where(
          and(
            inArray(
              bankLineSuggestions.statementLineId,
              rows.map((r) => r.line.id),
            ),
            eq(bankLineSuggestions.status, 'PENDING'),
            sql`${bankLineSuggestions.source} <> 'MANUAL'`,
          ),
        );
      for (const r of rows) {
        const line: FeedLine = {
          id: r.line.id,
          bankAccountId: r.bankAccountId,
          lineDate: r.line.lineDate,
          amount: r.line.amount,
          description: r.line.description,
          reference: r.line.reference,
        };
        const drafts = suggestForLine(line, {
          currency,
          rules,
          openInvoices,
          openBills,
          history,
          autoApplyRules: settings.autoApplyRules,
          autoApplyDocumentMatches: settings.autoApplyDocumentMatches,
          historyMinOccurrences: settings.historyMinOccurrences,
        });
        if (drafts.length === 0) continue;
        summary.suggested += 1;
        const inserted = await tx
          .insert(bankLineSuggestions)
          .values(
            drafts.map((d) => ({
              companyId,
              statementLineId: line.id,
              source: d.source,
              action: d.action,
              ruleId: d.ruleId,
              confidence: d.confidence,
              payload: d.payload,
              explanation: d.explanation,
            })),
          )
          .returning({ id: bankLineSuggestions.id });
        const auto = drafts.findIndex((d) => d.autoApply);
        if (auto >= 0 && actor && r.line.status === 'UNMATCHED')
          toApply.push({ lineId: line.id, suggestionId: inserted[auto]!.id });
      }
    });
    for (const a of toApply) {
      try {
        await this.apply(companyId, actor!, a.suggestionId, {}, { automatic: true });
        summary.autoApplied += 1;
      } catch (err) {
        summary.failed += 1;
        await this.db
          .update(bankLineSuggestions)
          .set({
            explanation: sql`${bankLineSuggestions.explanation} || ' Auto-apply failed: ' || ${(err as Error).message}`,
          })
          .where(eq(bankLineSuggestions.id, a.suggestionId));
      }
    }
    return summary;
  }

  // -------------------------------------------------------------------- apply

  /** Applies a pending suggestion (with optional overrides) inside one transaction. */
  async apply(
    companyId: string,
    actor: AuthenticatedUser,
    suggestionId: string,
    overrides: ApplyBankSuggestionInput = {},
    options: { automatic?: boolean } = {},
  ): Promise<SuggestionView> {
    await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(bankLineSuggestions)
        .where(
          and(
            eq(bankLineSuggestions.id, suggestionId),
            eq(bankLineSuggestions.companyId, companyId),
          ),
        )
        .for('update');
      if (!s) throw new NotFoundError('Suggestion', suggestionId);
      if (s.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.BANK_SUGGESTION_INVALID,
          `Suggestion is ${s.status.toLowerCase()}.`,
        );
      const payload: BankSuggestionPayload = {
        ...s.payload,
        ...(overrides.action ? { action: overrides.action } : {}),
        ...(overrides.transactionType !== undefined
          ? {
              transactionType:
                overrides.transactionType as BankSuggestionPayload['transactionType'],
            }
          : {}),
        ...(overrides.counterpartyAccountId !== undefined
          ? { counterpartyAccountId: overrides.counterpartyAccountId }
          : {}),
        ...(overrides.memo !== undefined ? { memo: overrides.memo } : {}),
        ...(overrides.partyId !== undefined ? { partyId: overrides.partyId } : {}),
        ...(overrides.departmentId !== undefined ? { departmentId: overrides.departmentId } : {}),
        ...(overrides.costCenterId !== undefined ? { costCenterId: overrides.costCenterId } : {}),
        ...(overrides.projectId !== undefined ? { projectId: overrides.projectId } : {}),
        ...(overrides.allocations
          ? { allocations: overrides.allocations.map((a) => ({ ...a, documentNumber: '' })) }
          : {}),
      };
      const result = await this.explainInTx(
        tx,
        companyId,
        actor,
        s.statementLineId,
        payload,
        options.automatic ? `rule / policy` : `suggestion ${s.source.toLowerCase()}`,
      );
      await tx
        .update(bankLineSuggestions)
        .set({
          status: 'APPLIED',
          payload,
          resultType: result.resultType,
          resultId: result.resultId,
          resultNumber: result.resultNumber,
          journalLineId: result.journalLineId,
          appliedBy: options.automatic ? null : actor.id,
          appliedAt: new Date(),
        })
        .where(eq(bankLineSuggestions.id, suggestionId));
      await tx
        .update(bankLineSuggestions)
        .set({ status: 'SUPERSEDED' })
        .where(
          and(
            eq(bankLineSuggestions.statementLineId, s.statementLineId),
            eq(bankLineSuggestions.status, 'PENDING'),
          ),
        );
      if (s.ruleId)
        await tx
          .update(bankMatchingRules)
          .set({ hitCount: sql`${bankMatchingRules.hitCount} + 1`, lastHitAt: new Date() })
          .where(eq(bankMatchingRules.id, s.ruleId));
    });
    return this.getSuggestion(companyId, suggestionId);
  }

  /** Explains a line by hand: records a MANUAL suggestion and applies it in the same transaction. */
  async explain(
    companyId: string,
    actor: AuthenticatedUser,
    lineId: string,
    input: ExplainBankLineInput,
  ): Promise<SuggestionView> {
    const id = await this.db.transaction(async (tx) => {
      const [line] = await tx
        .select({ id: bankStatementLines.id })
        .from(bankStatementLines)
        .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
        .where(and(eq(bankStatementLines.id, lineId), eq(bankStatements.companyId, companyId)));
      if (!line) throw new NotFoundError('Statement line', lineId);
      const payload: BankSuggestionPayload = {
        action: input.action,
        transactionType: input.transactionType as BankSuggestionPayload['transactionType'],
        counterpartyAccountId: input.counterpartyAccountId ?? null,
        memo: input.memo ?? null,
        partyId: input.partyId ?? null,
        departmentId: input.departmentId ?? null,
        costCenterId: input.costCenterId ?? null,
        projectId: input.projectId ?? null,
        allocations: input.allocations?.map((a) => ({ ...a, documentNumber: '' })),
      };
      const result = await this.explainInTx(
        tx,
        companyId,
        actor,
        lineId,
        payload,
        input.note ?? 'entered by hand',
      );
      const [s] = await tx
        .insert(bankLineSuggestions)
        .values({
          companyId,
          statementLineId: lineId,
          source: 'MANUAL',
          action: input.action,
          confidence: 'HIGH',
          payload,
          explanation: input.note ?? 'Explained by hand.',
          status: 'APPLIED',
          resultType: result.resultType,
          resultId: result.resultId,
          resultNumber: result.resultNumber,
          journalLineId: result.journalLineId,
          appliedBy: actor.id,
          appliedAt: new Date(),
        })
        .returning({ id: bankLineSuggestions.id });
      await tx
        .update(bankLineSuggestions)
        .set({ status: 'SUPERSEDED' })
        .where(
          and(
            eq(bankLineSuggestions.statementLineId, lineId),
            eq(bankLineSuggestions.status, 'PENDING'),
          ),
        );
      return s!.id;
    });
    return this.getSuggestion(companyId, id);
  }

  async dismiss(
    companyId: string,
    actor: AuthenticatedUser,
    suggestionId: string,
  ): Promise<SuggestionView> {
    await this.db.transaction(async (tx) => {
      const [s] = await tx
        .select()
        .from(bankLineSuggestions)
        .where(
          and(
            eq(bankLineSuggestions.id, suggestionId),
            eq(bankLineSuggestions.companyId, companyId),
          ),
        )
        .for('update');
      if (!s) throw new NotFoundError('Suggestion', suggestionId);
      if (s.status !== 'PENDING')
        throw new BusinessRuleError(
          ErrorCodes.BANK_SUGGESTION_INVALID,
          `Suggestion is ${s.status.toLowerCase()}.`,
        );
      await tx
        .update(bankLineSuggestions)
        .set({ status: 'DISMISSED', dismissedBy: actor.id, dismissedAt: new Date() })
        .where(eq(bankLineSuggestions.id, suggestionId));
      await this.audit.record(
        {
          action: 'UPDATE',
          module: MODULE,
          entityType: 'BankLineSuggestion',
          entityId: suggestionId,
          previousValue: { status: 'PENDING' },
          newValue: { status: 'DISMISSED' },
          metadata: { editor: actor.email, reason: 'dismissed' },
          companyId,
        },
        tx,
      );
    });
    return this.getSuggestion(companyId, suggestionId);
  }

  // ------------------------------------------------------------------ queries

  async queue(companyId: string, query: BankFeedQueueQuery): Promise<PaginatedResult<QueueLine>> {
    const filters: SQL[] = [
      eq(bankStatements.companyId, companyId),
      eq(bankStatements.status, 'OPEN'),
      inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
    ];
    if (query.bankAccountId) filters.push(eq(bankStatements.bankAccountId, query.bankAccountId));
    if (query.from) filters.push(gte(bankStatementLines.lineDate, query.from));
    if (query.to) filters.push(lte(bankStatementLines.lineDate, query.to));
    if (query.search)
      filters.push(
        sql`(${bankStatementLines.description} ilike ${'%' + query.search + '%'} or ${bankStatementLines.reference} ilike ${'%' + query.search + '%'})`,
      );
    const pending = sql<number>`(select count(*) from bank_line_suggestions s where s.statement_line_id = ${bankStatementLines.id} and s.status = 'PENDING')::int`;
    if (query.suggested === 'YES') filters.push(sql`${pending} > 0`);
    if (query.suggested === 'NO') filters.push(sql`${pending} = 0`);
    const where = and(...filters);
    const base = this.db
      .select({
        line: bankStatementLines,
        statementNumber: bankStatements.statementNumber,
        bankAccountId: bankStatements.bankAccountId,
        bankAccountCode: bankAccounts.code,
        currency: bankAccounts.currency,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(where)
      .orderBy(asc(bankStatementLines.lineDate), asc(bankStatementLines.lineNumber))
      .limit(query.pageSize)
      .offset(offsetFor(query));
    const [rows, [count]] = await Promise.all([
      base,
      this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(bankStatementLines)
        .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
        .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
        .where(where),
    ]);
    const suggestions = rows.length
      ? await this.suggestionsFor(rows.map((r) => r.line.id))
      : new Map<string, SuggestionView[]>();
    const today = businessToday();
    return toPaginatedResult(
      rows.map((r) => ({
        id: r.line.id,
        statementId: r.line.statementId,
        statementNumber: r.statementNumber,
        bankAccountId: r.bankAccountId,
        bankAccountCode: r.bankAccountCode,
        currency: r.currency,
        lineDate: r.line.lineDate,
        description: r.line.description,
        reference: r.line.reference,
        amount: r.line.amount,
        status: r.line.status,
        matchNote: r.line.matchNote,
        ageDays: daysBetween(r.line.lineDate, today),
        suggestions: suggestions.get(r.line.id) ?? [],
      })),
      count?.n ?? 0,
      query,
    );
  }

  async getSuggestion(companyId: string, id: string): Promise<SuggestionView> {
    const [row] = await this.db
      .select({ s: bankLineSuggestions, ruleName: bankMatchingRules.name })
      .from(bankLineSuggestions)
      .leftJoin(bankMatchingRules, eq(bankMatchingRules.id, bankLineSuggestions.ruleId))
      .where(and(eq(bankLineSuggestions.id, id), eq(bankLineSuggestions.companyId, companyId)));
    if (!row) throw new NotFoundError('Suggestion', id);
    return { ...row.s, ruleName: row.ruleName };
  }

  async dashboard(companyId: string, asOf: string, days: number): Promise<FeedDashboard> {
    const from = addDays(asOf, -days);
    const settings = await this.rules.settings(companyId);
    const currency =
      (
        await this.db
          .select({ c: bankAccounts.currency })
          .from(bankAccounts)
          .where(eq(bankAccounts.companyId, companyId))
          .limit(1)
      )[0]?.c ?? 'PHP';
    const lines = await this.db
      .select({
        id: bankStatementLines.id,
        status: bankStatementLines.status,
        lineDate: bankStatementLines.lineDate,
        amount: bankStatementLines.amount,
        bankAccountId: bankStatements.bankAccountId,
        code: bankAccounts.code,
        name: bankAccounts.name,
        matchKind: bankLineMatches.kind,
        statementStatus: bankStatements.status,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .leftJoin(bankLineMatches, eq(bankLineMatches.statementLineId, bankStatementLines.id))
      .where(
        and(
          eq(bankStatements.companyId, companyId),
          gte(bankStatementLines.lineDate, from),
          lte(bankStatementLines.lineDate, asOf),
        ),
      );
    const applied = await this.db
      .select({
        lineId: bankLineSuggestions.statementLineId,
        source: bankLineSuggestions.source,
        appliedBy: bankLineSuggestions.appliedBy,
      })
      .from(bankLineSuggestions)
      .where(
        and(
          eq(bankLineSuggestions.companyId, companyId),
          eq(bankLineSuggestions.status, 'APPLIED'),
        ),
      );
    const appliedByLine = new Map(applied.map((a) => [a.lineId, a]));
    const explained = lines.filter(
      (l) => l.status === 'MATCHED' || l.status === 'RECONCILED' || l.status === 'DUPLICATE',
    );
    const autoMatched = explained.filter((l) => l.matchKind === 'AUTO').length;
    const viaFeed = explained.map((l) => appliedByLine.get(l.id)).filter(Boolean) as typeof applied;
    const ruleApplied = viaFeed.filter((a) => a.source === 'RULE').length;
    const documentApplied = viaFeed.filter(
      (a) => a.source === 'DOCUMENT' || a.source === 'HISTORY',
    ).length;
    const automatic = autoMatched + viaFeed.filter((a) => a.appliedBy === null).length;
    const unexplained = lines.filter(
      (l) =>
        l.statementStatus === 'OPEN' &&
        (l.status === 'UNMATCHED' || l.status === 'POSSIBLE_MATCH' || l.status === 'EXCEPTION'),
    );
    const [pendingSuggestions] = await this.db
      .select({ n: sql<number>`count(distinct ${bankLineSuggestions.statementLineId})::int` })
      .from(bankLineSuggestions)
      .where(
        and(
          eq(bankLineSuggestions.companyId, companyId),
          eq(bankLineSuggestions.status, 'PENDING'),
        ),
      );
    const stale = unexplained.filter(
      (l) => daysBetween(l.lineDate, asOf) > settings.staleAfterDays,
    ).length;
    const byBank = new Map<string, FeedDashboard['byBankAccount'][number]>();
    for (const l of lines) {
      const b = byBank.get(l.bankAccountId) ?? {
        bankAccountId: l.bankAccountId,
        code: l.code,
        name: l.name,
        imported: 0,
        unexplained: 0,
        unexplainedIn: '0',
        unexplainedOut: '0',
      };
      b.imported += 1;
      if (unexplained.includes(l)) {
        b.unexplained += 1;
        const m = Money.of(l.amount, currency);
        if (m.isNegative())
          b.unexplainedOut = Money.of(b.unexplainedOut, currency).add(m.abs()).toString();
        else b.unexplainedIn = Money.of(b.unexplainedIn, currency).add(m).toString();
      }
      byBank.set(l.bankAccountId, b);
    }
    const buckets = [
      { bucket: '0-7 days', min: 0, max: 7 },
      { bucket: '8-30 days', min: 8, max: 30 },
      { bucket: '31-90 days', min: 31, max: 90 },
      { bucket: 'over 90 days', min: 91, max: Infinity },
    ];
    const ageing = buckets.map((b) => {
      const inBucket = unexplained.filter((l) => {
        const age = daysBetween(l.lineDate, asOf);
        return age >= b.min && age <= b.max;
      });
      return {
        bucket: b.bucket,
        lines: inBucket.length,
        amount: Money.sum(
          inBucket.map((l) => Money.of(l.amount, currency).abs()),
          currency,
        ).toString(),
      };
    });
    const topRules = await this.db
      .select({
        id: bankMatchingRules.id,
        name: bankMatchingRules.name,
        hitCount: bankMatchingRules.hitCount,
        lastHitAt: bankMatchingRules.lastHitAt,
      })
      .from(bankMatchingRules)
      .where(eq(bankMatchingRules.companyId, companyId))
      .orderBy(desc(bankMatchingRules.hitCount), asc(bankMatchingRules.name))
      .limit(5);
    return {
      asOf,
      days,
      currency,
      imported: lines.length,
      explained: explained.length,
      autoMatched,
      ruleApplied,
      documentApplied,
      manual:
        explained.length -
        autoMatched -
        viaFeed.length +
        viaFeed.filter((a) => a.source === 'MANUAL').length,
      pendingLines: unexplained.length,
      pendingSuggestions: pendingSuggestions?.n ?? 0,
      staleLines: stale,
      automationRate: lines.length ? ((automatic / lines.length) * 100).toFixed(1) : '0.0',
      byBankAccount: [...byBank.values()].sort((a, b) => a.code.localeCompare(b.code)),
      topRules: topRules.map((r) => ({
        ...r,
        lastHitAt: r.lastHitAt ? r.lastHitAt.toISOString() : null,
      })),
      ageing,
    };
  }

  // ---------------------------------------------------------------- internals

  /** Creates and posts the explaining document, matches the line, audits and emits; returns what was produced. */
  private async explainInTx(
    tx: DbExecutor,
    companyId: string,
    actor: AuthenticatedUser,
    lineId: string,
    payload: BankSuggestionPayload,
    how: string,
  ) {
    const [row] = await tx
      .select({ line: bankStatementLines, statement: bankStatements, bank: bankAccounts })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(and(eq(bankStatementLines.id, lineId), eq(bankStatements.companyId, companyId)))
      .for('update', { of: bankStatementLines });
    if (!row) throw new NotFoundError('Statement line', lineId);
    const { line, statement, bank } = row;
    if (statement.status === 'RECONCILED')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        `${statement.statementNumber} is reconciled.`,
      );
    if (!(
      line.status === 'UNMATCHED' ||
      line.status === 'POSSIBLE_MATCH' ||
      line.status === 'EXCEPTION'
    ))
      throw new BusinessRuleError(
        ErrorCodes.BANK_SUGGESTION_INVALID,
        `Statement line is already ${line.status.toLowerCase()}.`,
      );
    const currency = bank.currency;
    const amount = Money.of(line.amount, currency);
    const abs = amount.abs();
    const dir = directionOf(line.amount);
    const user = actor;
    let resultType: BankLineSuggestion['resultType'];
    let resultId: string | null = null;
    let resultNumber: string | null = null;
    let journalEntryId: string | null = null;
    let noteLabel: string;

    switch (payload.action) {
      case 'IGNORE': {
        await tx
          .update(bankStatementLines)
          .set({
            status: 'DUPLICATE',
            matchNote: `Ignored (${how}): ${payload.memo ?? 'no ledger entry needed'}`,
          })
          .where(eq(bankStatementLines.id, lineId));
        resultType = 'IGNORED';
        noteLabel = 'ignored';
        break;
      }
      case 'POST_TRANSACTION': {
        const transactionType = payload.transactionType ?? defaultTransactionType(line.amount);
        const inbound = transactionType === 'DEPOSIT' || transactionType === 'INTEREST';
        if (inbound !== (dir === 'IN'))
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            `A ${transactionType.toLowerCase()} cannot explain money ${dir === 'IN' ? 'in' : 'out'}.`,
          );
        if (!payload.counterpartyAccountId)
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            'Choose the counterparty account.',
          );
        const id = await this.banking.createTransactionInTx(tx, companyId, user, {
          bankAccountId: bank.id,
          transactionType,
          transactionDate: line.lineDate,
          amount: abs.toString(),
          counterpartyAccountId: payload.counterpartyAccountId,
          reference: line.reference ?? undefined,
          memo: payload.memo ?? line.description,
          statementLineId: line.id,
        });
        journalEntryId = await this.banking.postTransactionInTx(tx, companyId, user, id);
        const [t] = await tx
          .select({ documentNumber: bankTransactions.documentNumber })
          .from(bankTransactions)
          .where(eq(bankTransactions.id, id));
        resultType = 'BANK_TRANSACTION';
        resultId = id;
        resultNumber = t?.documentNumber ?? null;
        noteLabel = `Recorded by ${resultNumber} (${how})`;
        break;
      }
      case 'RECEIVE_CUSTOMER':
      case 'PAY_VENDOR': {
        const receive = payload.action === 'RECEIVE_CUSTOMER';
        if (receive !== (dir === 'IN'))
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            `${receive ? 'A receipt' : 'A payment'} cannot explain money ${dir === 'IN' ? 'in' : 'out'}.`,
          );
        if (!payload.partyId)
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            receive ? 'Choose the customer.' : 'Choose the vendor.',
          );
        const allocations = (payload.allocations ?? []).map((a) => ({
          documentId: a.documentId,
          amount: Money.of(a.amount, currency).toString(),
        }));
        const allocated = Money.sum(
          allocations.map((a) => Money.of(a.amount, currency)),
          currency,
        );
        if (allocated.greaterThan(abs))
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            `Allocations (${allocated.toString()}) exceed the line amount (${abs.toString()}).`,
          );
        const input = {
          partyId: payload.partyId,
          paymentType: 'PAYMENT' as const,
          paymentDate: line.lineDate,
          amount: abs.toString(),
          method: 'BANK_TRANSFER' as const,
          cashAccountId: bank.glAccountId,
          reference: line.reference ?? undefined,
          externalReference: line.reference ?? undefined,
          memo: payload.memo ?? `Bank feed: ${line.description}`,
          allocations,
        };
        const id = receive
          ? await this.customerPayments.createInTx(tx, companyId, user, input)
          : await this.vendorPayments.createInTx(tx, companyId, user, input);
        if (receive) await this.customerPayments.postInTx(tx, companyId, user, id);
        else await this.vendorPayments.postInTx(tx, companyId, user, id);
        const table = receive ? customerPayments : vendorPayments;
        const [p] = await tx
          .select({ documentNumber: table.documentNumber, journalEntryId: table.journalEntryId })
          .from(table)
          .where(eq(table.id, id));
        journalEntryId = p?.journalEntryId ?? null;
        resultType = receive ? 'CUSTOMER_PAYMENT' : 'VENDOR_PAYMENT';
        resultId = id;
        resultNumber = p?.documentNumber ?? null;
        noteLabel = `Recorded by ${resultNumber} (${how})`;
        break;
      }
    }

    // Match the line to the document's line on the bank's GL account (bank transactions do this themselves on posting).
    let journalLineId: string | null = null;
    if (journalEntryId) {
      const [existing] = await tx
        .select({ journalLineId: bankLineMatches.journalLineId })
        .from(bankLineMatches)
        .where(eq(bankLineMatches.statementLineId, lineId));
      if (existing) journalLineId = existing.journalLineId;
      else {
        const [bankLine] = await tx
          .select({ id: journalLines.id })
          .from(journalLines)
          .where(
            and(
              eq(journalLines.journalEntryId, journalEntryId),
              eq(journalLines.accountId, bank.glAccountId),
            ),
          );
        if (!bankLine)
          throw new BusinessRuleError(
            ErrorCodes.BANK_SUGGESTION_INVALID,
            'The posted document has no line on this bank account.',
          );
        await tx.insert(bankLineMatches).values({
          statementLineId: lineId,
          journalLineId: bankLine.id,
          kind: 'RULE',
          matchedBy: actor.id,
        });
        await tx
          .update(bankStatementLines)
          .set({ status: 'MATCHED', matchNote: noteLabel })
          .where(eq(bankStatementLines.id, lineId));
        journalLineId = bankLine.id;
      }
      if (existing) {
        // Bank transactions match their statement line on posting (as MANUAL); the feed owns this one.
        await tx
          .update(bankLineMatches)
          .set({ kind: 'RULE' })
          .where(eq(bankLineMatches.statementLineId, lineId));
        await tx
          .update(bankStatementLines)
          .set({ matchNote: noteLabel })
          .where(eq(bankStatementLines.id, lineId));
      }
    }
    await this.audit.record(
      {
        action: 'UPDATE',
        module: MODULE,
        entityType: 'BankStatementLine',
        entityId: lineId,
        previousValue: { status: line.status },
        newValue: {
          status: payload.action === 'IGNORE' ? 'DUPLICATE' : 'MATCHED',
          action: payload.action,
          resultType,
          resultId,
          resultNumber,
        },
        metadata: { reason: how, statementNumber: statement.statementNumber, actor: actor.email },
        companyId,
        userId: actor.id,
      },
      tx,
    );
    await this.outbox.enqueue(tx, {
      eventType: 'bank_line.explained',
      companyId,
      dedupeKey: `bank_line.explained:${lineId}:${resultId ?? 'ignored'}`,
      payload: {
        statementLineId: lineId,
        statementNumber: statement.statementNumber,
        bankAccountId: bank.id,
        amount: line.amount,
        action: payload.action,
        resultType,
        resultId,
        resultNumber,
        how,
      },
    });
    return { resultType, resultId, resultNumber, journalLineId };
  }

  private async suggestionsFor(lineIds: string[]): Promise<Map<string, SuggestionView[]>> {
    const rows = await this.db
      .select({ s: bankLineSuggestions, ruleName: bankMatchingRules.name })
      .from(bankLineSuggestions)
      .leftJoin(bankMatchingRules, eq(bankMatchingRules.id, bankLineSuggestions.ruleId))
      .where(
        and(
          inArray(bankLineSuggestions.statementLineId, lineIds),
          eq(bankLineSuggestions.status, 'PENDING'),
        ),
      )
      .orderBy(asc(bankLineSuggestions.createdAt));
    const map = new Map<string, SuggestionView[]>();
    const order: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
    for (const r of rows) {
      const list = map.get(r.s.statementLineId) ?? [];
      list.push({ ...r.s, ruleName: r.ruleName });
      map.set(r.s.statementLineId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => order[a.confidence]! - order[b.confidence]!);
    return map;
  }

  private async openInvoices(companyId: string, currency: string): Promise<OpenDocument[]> {
    const rows = await this.db
      .select({
        id: invoices.id,
        documentNumber: invoices.documentNumber,
        partyId: invoices.customerId,
        partyName: customers.name,
        total: invoices.total,
        allocated: invoices.allocatedAmount,
        documentDate: invoices.documentDate,
        reference: invoices.reference,
      })
      .from(invoices)
      .innerJoin(customers, eq(customers.id, invoices.customerId))
      .where(
        and(
          eq(invoices.companyId, companyId),
          eq(invoices.documentType, 'INVOICE'),
          eq(invoices.accountingStatus, 'POSTED'),
          inArray(invoices.status, ['APPROVED', 'PARTIALLY_PAID']),
          eq(invoices.currency, currency),
        ),
      );
    return rows
      .map((r) => ({
        id: r.id,
        documentNumber: r.documentNumber,
        partyId: r.partyId,
        partyName: r.partyName,
        openAmount: Money.of(r.total, currency)
          .subtract(Money.of(r.allocated, currency))
          .toString(),
        documentDate: r.documentDate,
        reference: r.reference,
      }))
      .filter((d) => Number(d.openAmount) > 0);
  }

  private async openBills(companyId: string, currency: string): Promise<OpenDocument[]> {
    const rows = await this.db
      .select({
        id: vendorBills.id,
        documentNumber: vendorBills.documentNumber,
        partyId: vendorBills.vendorId,
        partyName: vendors.name,
        total: vendorBills.total,
        allocated: vendorBills.allocatedAmount,
        documentDate: vendorBills.documentDate,
        reference: vendorBills.reference,
      })
      .from(vendorBills)
      .innerJoin(vendors, eq(vendors.id, vendorBills.vendorId))
      .where(
        and(
          eq(vendorBills.companyId, companyId),
          eq(vendorBills.documentType, 'INVOICE'),
          eq(vendorBills.accountingStatus, 'POSTED'),
          inArray(vendorBills.status, ['APPROVED', 'PARTIALLY_PAID']),
          eq(vendorBills.currency, currency),
          eq(vendorBills.onHold, false),
        ),
      );
    return rows
      .map((r) => ({
        id: r.id,
        documentNumber: r.documentNumber,
        partyId: r.partyId,
        partyName: r.partyName,
        openAmount: Money.of(r.total, currency)
          .subtract(Money.of(r.allocated, currency))
          .toString(),
        documentDate: r.documentDate,
        reference: r.reference,
      }))
      .filter((d) => Number(d.openAmount) > 0);
  }

  /** How matched lines were explained, keyed by normalized description and direction (derived from the matches, never stored). */
  private async history(companyId: string): Promise<HistoryEntry[]> {
    const rows = await this.db
      .select({
        description: bankStatementLines.description,
        amount: bankStatementLines.amount,
        lineDate: bankStatementLines.lineDate,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      })
      .from(bankLineMatches)
      .innerJoin(bankStatementLines, eq(bankStatementLines.id, bankLineMatches.statementLineId))
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(journalLines, eq(journalLines.id, bankLineMatches.journalLineId))
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .where(
        and(
          eq(bankStatements.companyId, companyId),
          inArray(journalEntries.sourceType, ['BANK_TRANSACTION', 'AR_PAYMENT', 'AP_PAYMENT']),
        ),
      );
    if (rows.length === 0) return [];
    const txIds = rows.filter((r) => r.sourceType === 'BANK_TRANSACTION').map((r) => r.sourceId!);
    const arIds = rows.filter((r) => r.sourceType === 'AR_PAYMENT').map((r) => r.sourceId!);
    const apIds = rows.filter((r) => r.sourceType === 'AP_PAYMENT').map((r) => r.sourceId!);
    const [txs, ars, aps] = await Promise.all([
      txIds.length
        ? this.db
            .select({
              id: bankTransactions.id,
              type: bankTransactions.transactionType,
              account: bankTransactions.counterpartyAccountId,
            })
            .from(bankTransactions)
            .where(inArray(bankTransactions.id, txIds))
        : [],
      arIds.length
        ? this.db
            .select({ id: customerPayments.id, partyId: customerPayments.customerId })
            .from(customerPayments)
            .where(inArray(customerPayments.id, arIds))
        : [],
      apIds.length
        ? this.db
            .select({ id: vendorPayments.id, partyId: vendorPayments.vendorId })
            .from(vendorPayments)
            .where(inArray(vendorPayments.id, apIds))
        : [],
    ]);
    const acc = new Map<string, HistoryEntry>();
    for (const r of rows) {
      const normalized = historyKey(r.description);
      if (!normalized) continue;
      const direction = directionOf(r.amount);
      let payload: BankSuggestionPayload | null = null;
      if (r.sourceType === 'BANK_TRANSACTION') {
        const t = txs.find((x) => x.id === r.sourceId);
        if (t && t.type !== 'TRANSFER' && t.account)
          payload = {
            action: 'POST_TRANSACTION',
            transactionType: t.type,
            counterpartyAccountId: t.account,
          };
      } else if (r.sourceType === 'AR_PAYMENT') {
        const p = ars.find((x) => x.id === r.sourceId);
        if (p) payload = { action: 'RECEIVE_CUSTOMER', partyId: p.partyId };
      } else {
        const p = aps.find((x) => x.id === r.sourceId);
        if (p) payload = { action: 'PAY_VENDOR', partyId: p.partyId };
      }
      if (!payload) continue;
      const key = `${normalized}|${direction}|${payload.action}|${payload.counterpartyAccountId ?? ''}|${payload.partyId ?? ''}`;
      const e = acc.get(key) ?? {
        normalized,
        direction,
        occurrences: 0,
        payload,
        lastSeen: r.lineDate,
      };
      e.occurrences += 1;
      if (r.lineDate > e.lastSeen) e.lastSeen = r.lineDate;
      acc.set(key, e);
    }
    // One entry per description / direction: the most frequent explanation wins.
    const best = new Map<string, HistoryEntry>();
    for (const e of acc.values()) {
      const k = `${e.normalized}|${e.direction}`;
      const cur = best.get(k);
      if (!cur || e.occurrences > cur.occurrences) best.set(k, e);
    }
    return [...best.values()];
  }

  /** Daily job body: suggestions for every active company plus a review notification when lines wait. */
  async sweepAll(
    asOf: string,
  ): Promise<{ companies: number; suggested: number; autoApplied: number; notified: number }> {
    const rows = await this.db
      .select({ id: companies.id, organizationId: companies.organizationId })
      .from(companies)
      .where(eq(companies.status, 'ACTIVE'));
    const out = { companies: rows.length, suggested: 0, autoApplied: 0, notified: 0 };
    for (const c of rows) {
      const s = await this.suggest(c.id, null);
      out.suggested += s.suggested;
      out.autoApplied += s.autoApplied;
      const [pending] = await this.db
        .select({ n: sql<number>`count(*)::int` })
        .from(bankStatementLines)
        .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
        .where(
          and(
            eq(bankStatements.companyId, c.id),
            eq(bankStatements.status, 'OPEN'),
            inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          ),
        );
      if ((pending?.n ?? 0) > 0)
        out.notified += await this.notifications.notify({
          organizationId: c.organizationId,
          eventType: 'BANK_FEED_REVIEW',
          severity: 'INFO',
          title: `${pending!.n} bank feed line(s) await review`,
          body: `Suggestions were refreshed on ${asOf}; open the bank feed review queue to accept, adjust or dismiss them.`,
          link: '/banking/feed',
          entityType: 'BankFeed',
          entityId: c.id,
          permission: 'bank-feed.manage',
          companyId: c.id,
          dedupeKey: `bank-feed-review:${c.id}:${asOf}`,
        });
    }
    return out;
  }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = to.split('-').map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}
