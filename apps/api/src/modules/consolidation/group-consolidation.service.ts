import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, lte, ne } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { AccountType, PaginatedResult, ReadinessStatus } from '@accounting/types';
import type { ConsolidationWindow } from '@accounting/validation';
import type { AuthenticatedUser } from '@/common/auth/authenticated-user';
import { BusinessRuleError, NotFoundError } from '@/common/errors/app-error';
import { ErrorCodes } from '@/common/errors/error-codes';
import { countWhere, offsetFor, toPaginatedResult } from '@/common/pagination/pagination';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  consolidationRuns,
  fiscalPeriods,
  groupAccountMappings,
  groupAccounts,
  intercompanyTransactions,
  type ConsolidationRun,
  type GroupAccount,
} from '@/database/schema';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';
import { AuditService } from '@/modules/audit/audit.service';
import { ExchangeRatesService } from '@/modules/fx/exchange-rates.service';
import { ConsolidationGroupsService, type GroupMemberView } from './consolidation-groups.service';
import {
  averageRate,
  isBalanceSheet,
  monthEndsBetween,
  naturalBalance,
  nonControllingInterest,
  ownershipFactor,
  scale,
  translate,
  translationAdjustment,
  type TranslationRates,
} from './group-consolidation.logic';

export interface GroupReportMember extends GroupMemberView {
  rates: TranslationRates;
  /** Translated cumulative translation adjustment of this member (presentation currency). */
  cta: string;
  nci: { netAssets: string; earnings: string };
}

export interface GroupReportRow {
  groupAccountId: string | null;
  code: string;
  name: string;
  type: AccountType;
  isIntercompany: boolean;
  /** Translated, ownership-scaled natural balance per member company id. */
  byCompany: Record<string, string>;
  combined: string;
  eliminations: string;
  adjustments: string;
  consolidated: string;
}

export interface GroupReport {
  group: { id: string; code: string; name: string; parentCompanyId: string };
  from: string;
  to: string;
  currency: string;
  members: GroupReportMember[];
  rows: GroupReportRow[];
  /** Member accounts with a balance but no group mapping - excluded from the rows above. */
  unmapped: Array<{
    companyId: string;
    companyCode: string;
    code: string;
    name: string;
    balance: string;
  }>;
  adjustments: Array<{ id: string; reference: string | null; description: string; total: string }>;
  totals: {
    assets: string;
    liabilities: string;
    equity: string;
    /** Equity attributable to non-controlling interests (FULL members below 100%). */
    nonControllingInterest: string;
    cumulativeTranslationAdjustment: string;
    revenue: string;
    expenses: string;
    netIncome: string;
    netIncomeToNci: string;
    eliminationCheck: string;
    adjustmentsBalanced: boolean;
    balanced: boolean;
  };
  generatedAt: string;
}

export interface ReadinessCheck {
  key: string;
  title: string;
  status: ReadinessStatus;
  detail: string;
  /** Sample offenders for drill-down. */
  items?: string[];
}

export interface ReadinessResult {
  from: string;
  to: string;
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface RunView extends Omit<ConsolidationRun, 'report' | 'readiness'> {
  report: GroupReport;
  readiness: ReadinessResult;
}

const CLOSED = new Set(['SOFT_CLOSED', 'CLOSED', 'LOCKED']);
const MODULE = 'consolidation';

/**
 * Group consolidation engine (hardening H9): every member's posted ledger,
 * mapped onto the group chart, translated with the current-rate method,
 * scaled by ownership, intercompany accounts eliminated, manual adjustments
 * applied, CTA and NCI derived. Reads only; a run stores a snapshot of the
 * result so a finalised consolidation is reproducible.
 */
@Injectable()
export class GroupConsolidationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly groups: ConsolidationGroupsService,
    private readonly ledger: GeneralLedgerService,
    private readonly rates: ExchangeRatesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ report

  async report(
    organizationId: string,
    groupId: string,
    window: ConsolidationWindow,
  ): Promise<GroupReport> {
    const group = await this.groups.load(this.db, organizationId, groupId);
    const currency = group.presentationCurrency;
    const members = await this.groups.members(groupId);
    if (members.length === 0)
      throw new BusinessRuleError(
        ErrorCodes.VALIDATION_FAILED,
        'The consolidation group has no members.',
      );
    const chart = await this.db
      .select()
      .from(groupAccounts)
      .where(eq(groupAccounts.groupId, groupId))
      .orderBy(asc(groupAccounts.sortOrder), asc(groupAccounts.code));
    const chartById = new Map(chart.map((g) => [g.id, g]));
    const mappings = await this.db
      .select({
        accountId: groupAccountMappings.accountId,
        groupAccountId: groupAccountMappings.groupAccountId,
      })
      .from(groupAccountMappings)
      .where(eq(groupAccountMappings.groupId, groupId));
    const mapOf = new Map(mappings.map((m) => [m.accountId, m.groupAccountId]));

    const rows = new Map<string, GroupReportRow>();
    const rowFor = (g: GroupAccount): GroupReportRow => {
      let row = rows.get(g.id);
      if (!row) {
        row = {
          groupAccountId: g.id,
          code: g.code,
          name: g.name,
          type: g.type,
          isIntercompany: g.isIntercompany,
          byCompany: {},
          combined: '0',
          eliminations: '0',
          adjustments: '0',
          consolidated: '0',
        };
        rows.set(g.id, row);
      }
      return row;
    };
    const unmapped: GroupReport['unmapped'] = [];
    const reportMembers: GroupReportMember[] = [];
    let totalCta = Money.zero(currency);
    let totalNci = Money.zero(currency);
    let totalNciEarnings = Money.zero(currency);

    for (const member of members) {
      const rates = await this.translationRates(
        organizationId,
        member.baseCurrency,
        currency,
        window,
      );
      const factor = ownershipFactor(member.method, member.ownershipPct);
      const [cumulative, period, memberChart] = await Promise.all([
        this.ledger.activity({ companyId: member.companyId, to: window.to }),
        this.ledger.activity({ companyId: member.companyId, from: window.from, to: window.to }),
        this.db
          .select()
          .from(accounts)
          .where(and(eq(accounts.companyId, member.companyId), eq(accounts.isHeader, false))),
      ]);
      const periodById = new Map(period.map((a) => [a.accountId, a]));
      const cumulativeById = new Map(cumulative.map((a) => [a.accountId, a]));
      const totals = {
        assets: Money.zero(currency),
        liabilities: Money.zero(currency),
        equity: Money.zero(currency),
        earnings: Money.zero(currency),
      };
      for (const account of memberChart) {
        const bs = isBalanceSheet(account.type);
        // Balance sheet: cumulative balance at closing. P&L: the window's activity at average,
        // plus earlier activity of the year still on the account (before a year-end close) at closing.
        const cum = cumulativeById.get(account.id);
        const per = periodById.get(account.id);
        if (!cum && !per) continue;
        const base = member.baseCurrency;
        let translated: Money;
        if (bs) {
          const bal = cum
            ? naturalBalance(account.type, Money.of(cum.debit, base), Money.of(cum.credit, base))
            : Money.zero(base);
          translated = translate(account.type, bal, rates, currency);
        } else {
          const periodBal = per
            ? naturalBalance(account.type, Money.of(per.debit, base), Money.of(per.credit, base))
            : Money.zero(base);
          const cumBal = cum
            ? naturalBalance(account.type, Money.of(cum.debit, base), Money.of(cum.credit, base))
            : Money.zero(base);
          const earlier = cumBal.subtract(periodBal);
          translated = periodBal
            .convert(currency, rates.average)
            .add(earlier.convert(currency, rates.closing));
        }
        translated = scale(translated, factor);
        if (translated.isZero()) continue;
        if (account.type === 'ASSET') totals.assets = totals.assets.add(translated);
        else if (account.type === 'LIABILITY')
          totals.liabilities = totals.liabilities.add(translated);
        else if (account.type === 'EQUITY') totals.equity = totals.equity.add(translated);
        else {
          const debitSide =
            account.type === 'EXPENSE' ||
            account.type === 'COST_OF_SALES' ||
            account.type === 'OTHER_EXPENSE';
          totals.earnings = debitSide
            ? totals.earnings.subtract(translated)
            : totals.earnings.add(translated);
        }
        const groupAccountId = mapOf.get(account.id);
        const target = groupAccountId ? chartById.get(groupAccountId) : undefined;
        if (!target) {
          unmapped.push({
            companyId: member.companyId,
            companyCode: member.code,
            code: account.code,
            name: account.name,
            balance: translated.toString(),
          });
          continue;
        }
        const row = rowFor(target);
        row.byCompany[member.companyId] = Money.of(row.byCompany[member.companyId] ?? '0', currency)
          .add(translated)
          .toString();
      }
      const cta = translationAdjustment(totals);
      const nci = nonControllingInterest(
        member.method,
        member.ownershipPct,
        totals.assets.subtract(totals.liabilities),
        totals.earnings,
        currency,
      );
      totalCta = totalCta.add(cta);
      totalNci = totalNci.add(nci.netAssets);
      totalNciEarnings = totalNciEarnings.add(nci.earnings);
      reportMembers.push({
        ...member,
        rates,
        cta: cta.toString(),
        nci: { netAssets: nci.netAssets.toString(), earnings: nci.earnings.toString() },
      });
    }

    // Manual adjustments in the presentation currency, by group account.
    const adjustments = await this.groups.adjustmentsFor(groupId, window.from, window.to);
    const adjustmentByAccount = new Map<string, Money>();
    let adjDebits = Money.zero(currency);
    let adjCredits = Money.zero(currency);
    for (const adj of adjustments)
      for (const line of adj.lines) {
        const target = chartById.get(line.groupAccountId);
        if (!target) continue;
        const debit = Money.of(line.debit, currency);
        const credit = Money.of(line.credit, currency);
        adjDebits = adjDebits.add(debit);
        adjCredits = adjCredits.add(credit);
        const natural = naturalBalance(target.type, debit, credit);
        adjustmentByAccount.set(
          target.id,
          (adjustmentByAccount.get(target.id) ?? Money.zero(currency)).add(natural),
        );
        rowFor(target);
      }

    const ordered = chart.filter((g) => rows.has(g.id)).map((g) => rows.get(g.id)!);
    let eliminationCheck = Money.zero(currency);
    for (const row of ordered) {
      const combined = Money.sum(
        Object.values(row.byCompany).map((v) => Money.of(v, currency)),
        currency,
      );
      row.combined = combined.toString();
      const adjustment = adjustmentByAccount.get(row.groupAccountId!) ?? Money.zero(currency);
      row.adjustments = adjustment.toString();
      if (row.isIntercompany) {
        row.eliminations = combined.negate().toString();
        row.consolidated = adjustment.toString();
        // Intra-group receivables (debit side) must mirror intra-group payables / income.
        const debitSide =
          row.type === 'ASSET' ||
          row.type === 'EXPENSE' ||
          row.type === 'COST_OF_SALES' ||
          row.type === 'OTHER_EXPENSE';
        eliminationCheck = eliminationCheck.add(debitSide ? combined : combined.negate());
      } else {
        row.eliminations = '0.0000';
        row.consolidated = combined.add(adjustment).toString();
      }
    }
    const total = (pred: (r: GroupReportRow) => boolean) =>
      Money.sum(
        ordered.filter(pred).map((r) => Money.of(r.consolidated, currency)),
        currency,
      );
    const assets = total((r) => r.type === 'ASSET');
    const liabilities = total((r) => r.type === 'LIABILITY');
    const equity = total((r) => r.type === 'EQUITY');
    const revenue = total((r) => r.type === 'REVENUE' || r.type === 'OTHER_INCOME');
    const expenses = total(
      (r) => r.type === 'EXPENSE' || r.type === 'COST_OF_SALES' || r.type === 'OTHER_EXPENSE',
    );
    const netIncome = revenue.subtract(expenses);
    // Eliminated intercompany balances and unmapped accounts are the only figures outside the rows; when
    // they net to zero the consolidated balance sheet closes through earnings + CTA.
    const unmappedNet = unmapped.reduce(
      (m, u) => m.add(Money.of(u.balance, currency)),
      Money.zero(currency),
    );
    const adjustmentsBalanced = adjDebits.equals(adjCredits);
    const closes = assets
      .subtract(liabilities)
      .subtract(equity)
      .subtract(netIncome)
      .subtract(totalCta);
    return {
      group: {
        id: group.id,
        code: group.code,
        name: group.name,
        parentCompanyId: group.parentCompanyId,
      },
      from: window.from,
      to: window.to,
      currency,
      members: reportMembers,
      rows: ordered,
      unmapped,
      adjustments: adjustments.map((a) => ({
        id: a.id,
        reference: a.reference,
        description: a.description,
        total: a.total,
      })),
      totals: {
        assets: assets.toString(),
        liabilities: liabilities.toString(),
        equity: equity.toString(),
        nonControllingInterest: totalNci.toString(),
        cumulativeTranslationAdjustment: totalCta.toString(),
        revenue: revenue.toString(),
        expenses: expenses.toString(),
        netIncome: netIncome.toString(),
        netIncomeToNci: totalNciEarnings.toString(),
        eliminationCheck: eliminationCheck.toString(),
        adjustmentsBalanced,
        balanced:
          eliminationCheck.isZero() &&
          adjustmentsBalanced &&
          unmappedNet.isZero() &&
          closes.isZero(),
      },
      generatedAt: new Date().toISOString(),
    };
  }

  /** Closing rate on the last day; average of the month-end closing rates inside the window. */
  private async translationRates(
    organizationId: string,
    from: string,
    to: string,
    window: ConsolidationWindow,
  ): Promise<TranslationRates> {
    if (from === to) return { closing: '1', average: '1' };
    const closing = await this.rates.rateFor(organizationId, from, to, window.to);
    const samples: string[] = [];
    for (const day of monthEndsBetween(window.from, window.to))
      samples.push(await this.rates.rateFor(organizationId, from, to, day));
    return { closing, average: averageRate(samples) };
  }

  // --------------------------------------------------------------- readiness

  async readiness(
    organizationId: string,
    groupId: string,
    window: ConsolidationWindow,
  ): Promise<ReadinessResult> {
    const group = await this.groups.load(this.db, organizationId, groupId);
    const members = await this.groups.members(groupId);
    const checks: ReadinessCheck[] = [];
    const push = (c: ReadinessCheck) => checks.push(c);

    push({
      key: 'MEMBERS',
      title: 'Group members',
      status: members.length >= 2 ? 'PASS' : members.length === 1 ? 'WARN' : 'FAIL',
      detail: `${members.length} member${members.length === 1 ? '' : 's'} (parent ${group.parentCompanyId === members.find((m) => m.isParent)?.companyId ? 'included' : 'missing'})`,
    });

    // Exchange rates for every foreign member.
    const missingRates: string[] = [];
    for (const m of members) {
      if (m.baseCurrency === group.presentationCurrency) continue;
      try {
        await this.translationRates(
          organizationId,
          m.baseCurrency,
          group.presentationCurrency,
          window,
        );
      } catch {
        missingRates.push(`${m.code} (${m.baseCurrency}->${group.presentationCurrency})`);
      }
    }
    push({
      key: 'RATES',
      title: 'Translation rates',
      status: missingRates.length ? 'FAIL' : 'PASS',
      detail: missingRates.length
        ? `No closing / average rate for ${missingRates.join(', ')}`
        : 'Closing and average rates available for every member',
      items: missingRates,
    });

    // Member periods covering `to` should be closed (soft close acceptable).
    const openPeriods: string[] = [];
    for (const m of members) {
      const [period] = await this.db
        .select({ name: fiscalPeriods.name, status: fiscalPeriods.status })
        .from(fiscalPeriods)
        .where(
          and(
            eq(fiscalPeriods.companyId, m.companyId),
            lte(fiscalPeriods.startDate, window.to),
            gte(fiscalPeriods.endDate, window.to),
          ),
        );
      if (!period) openPeriods.push(`${m.code}: no fiscal period covers ${window.to}`);
      else if (!CLOSED.has(period.status))
        openPeriods.push(`${m.code}: ${period.name} is ${period.status}`);
    }
    push({
      key: 'PERIODS',
      title: 'Member periods closed',
      status: openPeriods.length ? 'WARN' : 'PASS',
      detail: openPeriods.length
        ? openPeriods.join('; ')
        : `Every member period covering ${window.to} is closed`,
      items: openPeriods,
    });

    // Intercompany transactions between members inside the window must be posted.
    const memberIds = members.map((m) => m.companyId);
    const unposted = memberIds.length
      ? await this.db
          .select({
            documentNumber: intercompanyTransactions.documentNumber,
            status: intercompanyTransactions.status,
          })
          .from(intercompanyTransactions)
          .where(
            and(
              eq(intercompanyTransactions.organizationId, organizationId),
              inArray(intercompanyTransactions.fromCompanyId, memberIds),
              inArray(intercompanyTransactions.toCompanyId, memberIds),
              gte(intercompanyTransactions.transactionDate, window.from),
              lte(intercompanyTransactions.transactionDate, window.to),
              ne(intercompanyTransactions.status, 'POSTED'),
              ne(intercompanyTransactions.status, 'REVERSED'),
            ),
          )
      : [];
    push({
      key: 'INTERCOMPANY_POSTED',
      title: 'Intercompany transactions posted',
      status: unposted.length ? 'FAIL' : 'PASS',
      detail: unposted.length
        ? `${unposted.length} intra-group transaction${unposted.length === 1 ? '' : 's'} still ${unposted[0]!.status}`
        : 'Every intra-group transaction in the window is posted or reversed',
      items: unposted.map((u) => `${u.documentNumber} (${u.status})`),
    });

    // Mapping completeness, intercompany mirror and adjustments come from the report itself.
    let report: GroupReport | null = null;
    try {
      report = await this.report(organizationId, groupId, window);
    } catch (err) {
      push({
        key: 'REPORT',
        title: 'Consolidation builds',
        status: 'FAIL',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (report) {
      push({
        key: 'MAPPINGS',
        title: 'Group chart mappings',
        status: report.unmapped.length ? 'FAIL' : 'PASS',
        detail: report.unmapped.length
          ? `${report.unmapped.length} member account${report.unmapped.length === 1 ? '' : 's'} with a balance but no group account`
          : 'Every member account with a balance maps to a group account',
        items: report.unmapped
          .slice(0, 20)
          .map((u) => `${u.companyCode}:${u.code} ${u.name} (${u.balance})`),
      });
      const check = Money.of(report.totals.eliminationCheck, report.currency);
      push({
        key: 'INTERCOMPANY_BALANCED',
        title: 'Intercompany balances mirror',
        status: check.isZero() ? 'PASS' : 'FAIL',
        detail: check.isZero()
          ? 'Intra-group receivables, payables and charges net to zero'
          : `Intra-group balances differ by ${report.totals.eliminationCheck} ${report.currency}`,
      });
      push({
        key: 'ADJUSTMENTS',
        title: 'Consolidation adjustments balanced',
        status: report.totals.adjustmentsBalanced ? 'PASS' : 'FAIL',
        detail: `${report.adjustments.length} adjustment${report.adjustments.length === 1 ? '' : 's'} apply to this window`,
      });
      push({
        key: 'BALANCED',
        title: 'Consolidated balance sheet closes',
        status: report.totals.balanced ? 'PASS' : 'FAIL',
        detail: report.totals.balanced
          ? `Assets = liabilities + equity + net income + CTA (${report.totals.cumulativeTranslationAdjustment} ${report.currency})`
          : 'The translated group balance sheet does not close',
      });
    }
    return {
      from: window.from,
      to: window.to,
      ready: checks.every((c) => c.status !== 'FAIL'),
      checks,
    };
  }

  // -------------------------------------------------------------------- runs

  async createRun(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    window: ConsolidationWindow,
  ): Promise<RunView> {
    const group = await this.groups.load(this.db, organizationId, groupId);
    const readiness = await this.readiness(organizationId, groupId, window);
    const report = await this.report(organizationId, groupId, window);
    const [row] = await this.db
      .insert(consolidationRuns)
      .values({
        groupId,
        fromDate: window.from,
        toDate: window.to,
        currency: group.presentationCurrency,
        status: 'DRAFT',
        report,
        readiness,
        createdBy: actor.id,
      })
      .returning();
    await this.audit.record({
      action: 'CREATE',
      module: MODULE,
      entityType: 'ConsolidationRun',
      entityId: row!.id,
      newValue: {
        groupId,
        from: window.from,
        to: window.to,
        ready: readiness.ready,
        balanced: report.totals.balanced,
      },
      organizationId,
    });
    return this.runView(row!);
  }

  /** A FINAL run is the reference set of figures; it needs every readiness check to pass. */
  async finalize(
    organizationId: string,
    actor: AuthenticatedUser,
    groupId: string,
    runId: string,
  ): Promise<RunView> {
    await this.groups.load(this.db, organizationId, groupId);
    const [run] = await this.db
      .select()
      .from(consolidationRuns)
      .where(and(eq(consolidationRuns.id, runId), eq(consolidationRuns.groupId, groupId)));
    if (!run) throw new NotFoundError('Consolidation run', runId);
    if (run.status === 'FINAL')
      throw new BusinessRuleError(
        ErrorCodes.DOCUMENT_INVALID_STATE,
        'This consolidation run is already final.',
      );
    const readiness = run.readiness as ReadinessResult;
    if (!readiness.ready)
      throw new BusinessRuleError(
        ErrorCodes.CONSOLIDATION_NOT_READY,
        'Every readiness check must pass before a consolidation is finalised.',
        { failing: readiness.checks.filter((c) => c.status === 'FAIL').map((c) => c.key) },
      );
    const [updated] = await this.db
      .update(consolidationRuns)
      .set({ status: 'FINAL', finalizedBy: actor.id, finalizedAt: new Date() })
      .where(eq(consolidationRuns.id, runId))
      .returning();
    await this.audit.record({
      action: 'FINALIZE',
      module: MODULE,
      entityType: 'ConsolidationRun',
      entityId: runId,
      previousValue: { status: 'DRAFT' },
      newValue: { status: 'FINAL', from: run.fromDate, to: run.toDate },
      organizationId,
    });
    return this.runView(updated!);
  }

  async runs(
    organizationId: string,
    groupId: string,
    query: { page: number; pageSize: number },
  ): Promise<PaginatedResult<Omit<RunView, 'report'> & { totals: GroupReport['totals'] }>> {
    await this.groups.load(this.db, organizationId, groupId);
    const where = eq(consolidationRuns.groupId, groupId);
    const [rows, total] = await Promise.all([
      this.db
        .select()
        .from(consolidationRuns)
        .where(where)
        .orderBy(desc(consolidationRuns.toDate), desc(consolidationRuns.createdAt))
        .limit(query.pageSize)
        .offset(offsetFor(query)),
      countWhere(this.db, consolidationRuns, where),
    ]);
    return toPaginatedResult(
      rows.map((r) => {
        const { report, ...rest } = this.runView(r);
        return { ...rest, totals: report.totals };
      }),
      total,
      query,
    );
  }

  async run(organizationId: string, groupId: string, runId: string): Promise<RunView> {
    await this.groups.load(this.db, organizationId, groupId);
    const [row] = await this.db
      .select()
      .from(consolidationRuns)
      .where(and(eq(consolidationRuns.id, runId), eq(consolidationRuns.groupId, groupId)));
    if (!row) throw new NotFoundError('Consolidation run', runId);
    return this.runView(row);
  }

  private runView(row: ConsolidationRun): RunView {
    return {
      ...row,
      report: row.report as GroupReport,
      readiness: row.readiness as ReadinessResult,
    };
  }
}
