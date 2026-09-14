import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  AGING_BUCKETS,
  INCOME_STATEMENT_TYPES,
  LEDGER_STATUSES,
  P,
  type AiForecastMetric,
  type PaginatedResult,
} from '@accounting/types';
import type { AiAskInput, AiForecastQuery, PaginationQuery } from '@accounting/validation';
import { formatMoney, Money } from '@accounting/money';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { NotFoundError, PermissionDeniedError } from '@/common/errors/app-error';
import { offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  aiConversations,
  aiMessages,
  journalEntries,
  journalLines,
  type AiConversation,
  type AiMessage,
} from '@/database/schema';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ApReportsService } from '@/modules/payables/ap-reports.service';
import { ArReportsService } from '@/modules/receivables/ar-reports.service';
import { ReportingService } from '@/modules/reporting/reporting.service';
import { AiAnomalyService } from './ai-anomaly.service';
import { AiProviderService } from './ai-provider.service';
import {
  addMonths,
  forecastSeries,
  parseQuestion,
  type ForecastResult,
  type ParsedQuestion,
} from './ai.logic';

const MODULE = 'AI';

export interface AnswerSource {
  label: string;
  value: string;
  /** Where the number comes from, for the "show me" link. */
  report: string;
  href?: string;
}

export interface AskResult {
  conversationId: string;
  question: AiMessage;
  answer: AiMessage & { sources: AnswerSource[] };
  intent: ParsedQuestion['intent'];
}

export interface ConversationDetail extends AiConversation {
  messages: AiMessage[];
}

export interface ForecastReport extends ForecastResult {
  metric: AiForecastMetric;
  currency: string;
  asOf: string;
  note: string;
}

/**
 * Q&A over the company's own posted data. The assistant never reaches the
 * database directly: every fact comes from the same report services the UI
 * uses, filtered by the asker's permissions, and the answer cites them. A
 * model provider may phrase the answer; it cannot add numbers.
 */
@Injectable()
export class AiAssistantService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly provider: AiProviderService,
    private readonly reports: ReportingService,
    private readonly ledger: GeneralLedgerService,
    private readonly ar: ArReportsService,
    private readonly ap: ApReportsService,
    private readonly anomalies: AiAnomalyService,
  ) {}

  async conversations(
    companyId: string,
    actor: AuthenticatedUser,
    query: PaginationQuery,
  ): Promise<PaginatedResult<AiConversation>> {
    const where = and(
      eq(aiConversations.companyId, companyId),
      eq(aiConversations.userId, actor.id),
    );
    const [rows, [count]] = await Promise.all([
      this.db
        .select()
        .from(aiConversations)
        .where(where)
        .orderBy(desc(aiConversations.updatedAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      this.db
        .select({ total: sql<number>`count(*)::int` })
        .from(aiConversations)
        .where(where),
    ]);
    return toPaginatedResult(rows, count?.total ?? 0, query);
  }

  async conversation(
    companyId: string,
    actor: AuthenticatedUser,
    id: string,
  ): Promise<ConversationDetail> {
    const [row] = await this.db
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.id, id),
          eq(aiConversations.companyId, companyId),
          eq(aiConversations.userId, actor.id),
        ),
      );
    if (!row) throw new NotFoundError('Conversation', id);
    const messages = await this.db
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.conversationId, id))
      .orderBy(asc(aiMessages.createdAt));
    return { ...row, messages };
  }

  async ask(
    companyId: string,
    actor: AuthenticatedUser,
    input: AiAskInput,
    today = new Date().toISOString().slice(0, 10),
  ): Promise<AskResult> {
    const parsed = parseQuestion(input.question, today);
    const currency = await this.ledger.currency(companyId);
    const { sources, template } = await this.facts(companyId, actor, parsed, currency, today);
    const phrased = sources.length
      ? await this.provider.phrase({
          question: input.question,
          periodLabel: parsed.periodLabel,
          currency,
          facts: sources.map((s) => ({ label: s.label, value: s.value })),
        })
      : null;
    const content = phrased?.text || template;

    return this.db.transaction(async (tx) => {
      let conversationId = input.conversationId ?? null;
      if (conversationId) {
        const [existing] = await tx
          .select({ id: aiConversations.id })
          .from(aiConversations)
          .where(
            and(
              eq(aiConversations.id, conversationId),
              eq(aiConversations.companyId, companyId),
              eq(aiConversations.userId, actor.id),
            ),
          );
        if (!existing) throw new NotFoundError('Conversation', conversationId);
        await tx
          .update(aiConversations)
          .set({ updatedAt: new Date() })
          .where(eq(aiConversations.id, conversationId));
      } else {
        const [created] = await tx
          .insert(aiConversations)
          .values({ companyId, userId: actor.id, title: input.question.slice(0, 80) })
          .returning({ id: aiConversations.id });
        conversationId = created!.id;
      }
      const [question] = await tx
        .insert(aiMessages)
        .values({ conversationId, role: 'USER', content: input.question, sources: [] })
        .returning();
      const [answer] = await tx
        .insert(aiMessages)
        .values({
          conversationId,
          role: 'ASSISTANT',
          content,
          sources,
          provider: phrased ? 'ANTHROPIC' : 'HEURISTIC',
          model: phrased?.model ?? null,
        })
        .returning();
      await this.audit.record(
        {
          action: 'CREATE',
          module: MODULE,
          entityType: 'AiMessage',
          entityId: answer!.id,
          newValue: { intent: parsed.intent, period: parsed.periodLabel, sources: sources.length },
          metadata: { actor: actor.email },
          companyId,
        },
        tx,
      );
      return {
        conversationId,
        question: question!,
        answer: { ...answer!, sources },
        intent: parsed.intent,
      };
    });
  }

  /** Monthly history of a metric from posted lines, projected forward. */
  async forecast(
    companyId: string,
    query: AiForecastQuery,
    today = new Date().toISOString().slice(0, 10),
  ): Promise<ForecastReport> {
    const currency = await this.ledger.currency(companyId);
    const lastMonth = addMonths(today.slice(0, 7), -1);
    const firstMonth = addMonths(lastMonth, -(query.history - 1));
    const from = `${firstMonth}-01`;
    const to = `${lastMonth}-${new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5, 7)), 0)).getUTCDate().toString().padStart(2, '0')}`;
    const typeFilter =
      query.metric === 'REVENUE'
        ? sql`${accounts.type} = 'REVENUE'`
        : query.metric === 'EXPENSES'
          ? sql`${accounts.type} in ('EXPENSE', 'COST_OF_SALES')`
          : query.metric === 'NET_INCOME'
            ? inArray(accounts.type, [...INCOME_STATEMENT_TYPES])
            : sql`${accounts.subtype} in ('CASH', 'BANK')`;
    const rows = await this.db
      .select({
        period: sql<string>`to_char(${journalEntries.entryDate}, 'YYYY-MM')`,
        debit: sql<string>`coalesce(sum(${journalLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalLines.journalEntryId))
      .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(journalEntries.status, [...LEDGER_STATUSES]),
          gte(journalEntries.entryDate, from),
          lte(journalEntries.entryDate, to),
          typeFilter,
        ),
      )
      .groupBy(sql`to_char(${journalEntries.entryDate}, 'YYYY-MM')`);
    const byPeriod = new Map(rows.map((r) => [r.period, r]));
    const history = [];
    for (let i = 0; i < query.history; i++) {
      const period = addMonths(firstMonth, i);
      const r = byPeriod.get(period);
      const debit = Money.of(r?.debit ?? '0', currency);
      const credit = Money.of(r?.credit ?? '0', currency);
      // Revenue and net income are credit-natural; expenses and cash are debit-natural.
      const value =
        query.metric === 'REVENUE' || query.metric === 'NET_INCOME'
          ? credit.subtract(debit)
          : debit.subtract(credit);
      history.push({ period, value: value.toString() });
    }
    const result = forecastSeries(history, query.horizon);
    const note =
      query.metric === 'CASH'
        ? 'Monthly net cash movement (receipts less payments) through cash and bank accounts; not the balance.'
        : 'Monthly posted activity; the band is one standard deviation of the fit residuals. A baseline for planning, not a commitment.';
    return { ...result, metric: query.metric, currency, asOf: today, note };
  }

  // ------------------------------------------------------------------- facts

  private async facts(
    companyId: string,
    actor: AuthenticatedUser,
    q: ParsedQuestion,
    currency: string,
    today: string,
  ): Promise<{ sources: AnswerSource[]; template: string }> {
    const fmt = (v: string) => `${currency} ${formatMoney(v, currency, { accounting: false })}`;
    const need = (perm: string) => {
      if (!actor.permissions.has(perm)) throw new PermissionDeniedError([perm]);
    };
    const period = q.periodLabel;
    const asOf = q.pointInTime ? (q.to > today ? today : q.to) : q.to;
    switch (q.intent) {
      case 'REVENUE':
      case 'EXPENSES':
      case 'COST_OF_SALES':
      case 'GROSS_PROFIT':
      case 'NET_INCOME': {
        need(P['reports.view']);
        const is = await this.reports.incomeStatement(companyId, { from: q.from, to: q.to });
        const href = `/reports/income-statement?from=${q.from}&to=${q.to}`;
        const sources: AnswerSource[] = [
          {
            label: `Revenue (${period})`,
            value: fmt(is.revenue.total),
            report: 'Income statement',
            href,
          },
          {
            label: `Cost of sales (${period})`,
            value: fmt(is.costOfSales.total),
            report: 'Income statement',
            href,
          },
          {
            label: `Gross profit (${period})`,
            value: fmt(is.grossProfit),
            report: 'Income statement',
            href,
          },
          {
            label: `Operating expenses (${period})`,
            value: fmt(is.expenses.total),
            report: 'Income statement',
            href,
          },
          {
            label: `Net income (${period})`,
            value: fmt(is.netIncome),
            report: 'Income statement',
            href,
          },
        ];
        const pick = { REVENUE: 0, COST_OF_SALES: 1, GROSS_PROFIT: 2, EXPENSES: 3, NET_INCOME: 4 }[
          q.intent
        ];
        const main = sources[pick]!;
        const top =
          q.intent === 'EXPENSES'
            ? is.expenses.rows
                .filter((r) => !r.isHeader && Number(r.amount) !== 0)
                .sort((a, b) => Number(b.amount) - Number(a.amount))
                .slice(0, 3)
            : [];
        const template =
          `${main.label.replace(/ \(.*\)$/, '')} for ${period} is ${main.value}` +
          (q.intent === 'NET_INCOME' || q.intent === 'GROSS_PROFIT'
            ? ` (revenue ${sources[0]!.value}, cost of sales ${sources[1]!.value}, operating expenses ${sources[3]!.value}).`
            : q.intent === 'EXPENSES' && top.length
              ? `; the largest lines are ${top.map((r) => `${r.name} ${fmt(r.amount)}`).join(', ')}.`
              : '.') +
          ' Figures come from posted journal lines only.';
        return { sources, template };
      }
      case 'TOP_EXPENSES': {
        need(P['reports.view']);
        const is = await this.reports.incomeStatement(companyId, { from: q.from, to: q.to });
        const rows = is.expenses.rows
          .filter((r) => !r.isHeader && Number(r.amount) !== 0)
          .sort((a, b) => Number(b.amount) - Number(a.amount))
          .slice(0, 5);
        const sources = rows.map((r) => ({
          label: `${r.code} ${r.name} (${period})`,
          value: fmt(r.amount),
          report: 'Income statement',
          href: `/accounting/general-ledger?accountId=${r.accountId}&from=${q.from}&to=${q.to}`,
        }));
        const template = rows.length
          ? `Largest expense accounts for ${period}: ${rows.map((r, i) => `${i + 1}. ${r.name} ${fmt(r.amount)}`).join('; ')}. Total operating expenses ${fmt(is.expenses.total)}.`
          : `No expenses were posted for ${period}.`;
        return { sources, template };
      }
      case 'CASH': {
        need(P['reports.view']);
        const activity = await this.ledger.activity({ companyId, to: asOf });
        const cashAccounts = await this.db
          .select({ id: accounts.id, code: accounts.code, name: accounts.name })
          .from(accounts)
          .where(
            and(eq(accounts.companyId, companyId), inArray(accounts.subtype, ['CASH', 'BANK'])),
          );
        let total = Money.zero(currency);
        const sources: AnswerSource[] = [];
        for (const acc of cashAccounts) {
          const a = activity.find((x) => x.accountId === acc.id);
          const bal = Money.of(a?.debit ?? '0', currency).subtract(
            Money.of(a?.credit ?? '0', currency),
          );
          if (bal.isZero()) continue;
          total = total.add(bal);
          sources.push({
            label: `${acc.code} ${acc.name} (as of ${asOf})`,
            value: fmt(bal.toString()),
            report: 'Balance sheet',
            href: `/accounting/general-ledger?accountId=${acc.id}&to=${asOf}`,
          });
        }
        sources.unshift({
          label: `Cash and bank (as of ${asOf})`,
          value: fmt(total.toString()),
          report: 'Balance sheet',
          href: `/reports/balance-sheet?asOf=${asOf}`,
        });
        return {
          sources,
          template: `Cash and bank balances total ${fmt(total.toString())} as of ${asOf}${sources.length > 1 ? ` across ${sources.length - 1} account(s)` : ''}.`,
        };
      }
      case 'AR_OUTSTANDING':
      case 'AR_OVERDUE':
      case 'TOP_CUSTOMERS': {
        need(P['invoice.view']);
        const aging = await this.ar.aging(companyId, { asOf });
        const overdueTotal = overdueOf(aging.totals, currency);
        const href = `/receivables/aging?asOf=${asOf}`;
        const sources: AnswerSource[] = [
          {
            label: `Receivables outstanding (as of ${asOf})`,
            value: fmt(aging.totals.outstanding),
            report: 'AR aging',
            href,
          },
          {
            label: `Receivables overdue (as of ${asOf})`,
            value: fmt(overdueTotal.toString()),
            report: 'AR aging',
            href,
          },
        ];
        const top = [...aging.rows].sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
        for (const r of top)
          sources.push({
            label: `${r.name} (net due)`,
            value: fmt(r.net),
            report: 'AR aging',
            href: `${href}&partyId=${r.partyId}`,
          });
        const template =
          q.intent === 'TOP_CUSTOMERS'
            ? `Customers owing the most as of ${asOf}: ${top.map((r, i) => `${i + 1}. ${r.name} ${fmt(r.net)}`).join('; ') || 'none'}.`
            : `Receivables outstanding total ${fmt(aging.totals.outstanding)} as of ${asOf}, of which ${fmt(overdueTotal.toString())} is past due${top[0] ? `; the largest balance is ${top[0].name} at ${fmt(top[0].net)}` : ''}.`;
        return { sources, template };
      }
      case 'AP_OUTSTANDING':
      case 'AP_OVERDUE':
      case 'TOP_VENDORS': {
        need(P['bill.view']);
        const aging = await this.ap.aging(companyId, { asOf });
        const overdueTotal = overdueOf(aging.totals, currency);
        const href = `/payables/aging?asOf=${asOf}`;
        const sources: AnswerSource[] = [
          {
            label: `Payables outstanding (as of ${asOf})`,
            value: fmt(aging.totals.outstanding),
            report: 'AP aging',
            href,
          },
          {
            label: `Payables overdue (as of ${asOf})`,
            value: fmt(overdueTotal.toString()),
            report: 'AP aging',
            href,
          },
        ];
        const top = [...aging.rows].sort((a, b) => Number(b.net) - Number(a.net)).slice(0, 5);
        for (const r of top)
          sources.push({
            label: `${r.name} (net due)`,
            value: fmt(r.net),
            report: 'AP aging',
            href: `${href}&partyId=${r.partyId}`,
          });
        const template =
          q.intent === 'TOP_VENDORS'
            ? `Vendors we owe the most as of ${asOf}: ${top.map((r, i) => `${i + 1}. ${r.name} ${fmt(r.net)}`).join('; ') || 'none'}.`
            : `Payables outstanding total ${fmt(aging.totals.outstanding)} as of ${asOf}, of which ${fmt(overdueTotal.toString())} is past due${top[0] ? `; the largest balance is ${top[0].name} at ${fmt(top[0].net)}` : ''}.`;
        return { sources, template };
      }
      case 'TRIAL_BALANCE': {
        need(P['reports.view']);
        const tb = await this.reports.trialBalance(companyId, {
          from: q.from,
          to: q.to,
          includeZero: false,
        });
        const sources: AnswerSource[] = [
          {
            label: `Total debits (${period})`,
            value: fmt(tb.totals.closingDebit),
            report: 'Trial balance',
            href: `/accounting/trial-balance?from=${q.from}&to=${q.to}`,
          },
          {
            label: `Total credits (${period})`,
            value: fmt(tb.totals.closingCredit),
            report: 'Trial balance',
            href: `/accounting/trial-balance?from=${q.from}&to=${q.to}`,
          },
        ];
        return {
          sources,
          template: `The trial balance for ${period} ${tb.balanced ? 'balances' : 'does NOT balance'}: debits ${sources[0]!.value}, credits ${sources[1]!.value}.`,
        };
      }
      case 'ANOMALIES': {
        need(P['ai.view']);
        const s = await this.anomalies.summary(companyId);
        const sources: AnswerSource[] = [
          {
            label: 'Open anomaly flags',
            value: String(s.open),
            report: 'AI anomalies',
            href: '/ai/anomalies',
          },
          {
            label: 'High severity',
            value: String(s.high),
            report: 'AI anomalies',
            href: '/ai/anomalies?severity=HIGH',
          },
        ];
        return {
          sources,
          template: `There are ${s.open} open anomaly flag(s): ${s.high} high, ${s.medium} medium and ${s.low} low severity. Run a scan from the anomalies page to refresh them.`,
        };
      }
      case 'FORECAST': {
        need(P['reports.view']);
        const metric: AiForecastMetric = /expense|spend|cost/.test(q.intent)
          ? 'EXPENSES'
          : 'REVENUE';
        const f = await this.forecast(companyId, { metric, history: 12, horizon: 3 }, today);
        const sources = f.forecast.map((p) => ({
          label: `${metric === 'REVENUE' ? 'Revenue' : 'Expenses'} forecast ${p.period}`,
          value: fmt(p.value),
          report: 'AI forecast',
          href: `/ai/forecast?metric=${metric}`,
        }));
        return {
          sources,
          template: f.forecast.length
            ? `Based on the last 12 months (${f.method}), ${metric.toLowerCase()} is projected at ${f.forecast.map((p) => `${p.period}: ${fmt(p.value)}`).join(', ')}. This is a statistical baseline, not advice.`
            : 'Not enough posted history to forecast yet.',
        };
      }
      case 'HELP':
      default:
        return {
          sources: [],
          template:
            'I can answer questions from your posted ledger: revenue, expenses, gross profit or net income for a period ("revenue last month", "net income Q2 2026"), cash and bank balances, receivables and payables outstanding or overdue, top customers, vendors or expense accounts, whether the trial balance balances, open anomaly flags, and a simple forecast. I do not post, approve or give investment advice.',
        };
    }
  }
}

/** Everything past its due date: every aging bucket except "current". */
function overdueOf(totals: Record<string, string>, currency: string): Money {
  return AGING_BUCKETS.filter((b) => b.key !== 'current').reduce(
    (m, b) => m.add(Money.of(totals[b.key] ?? '0', currency)),
    Money.zero(currency),
  );
}
