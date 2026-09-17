import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  bankAccounts,
  bankLineMatches,
  bankLineSuggestions,
  bankMatchingRules,
  bankStatementLines,
  bankStatements,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { BankFeedRulesService } from './bank-feed-rules.service';

/**
 * Bank feed integrity (Prompt #12): applied suggestions always left a match
 * behind, rules point at real accounts, and no feed line goes stale unseen.
 */
@Injectable()
export class BankFeedIntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly rules: BankFeedRulesService,
  ) {}

  async run(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.appliedWithoutMatch(companyId),
      this.staleLines(companyId, asOf),
      this.rulesWithoutAccount(companyId),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  /** Every applied suggestion (other than IGNORE) explains a line that is matched to its document's bank ledger line. */
  private async appliedWithoutMatch(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: bankLineSuggestions.id,
        lineId: bankLineSuggestions.statementLineId,
        resultNumber: bankLineSuggestions.resultNumber,
        lineStatus: bankStatementLines.status,
        matchId: bankLineMatches.id,
      })
      .from(bankLineSuggestions)
      .innerJoin(bankStatementLines, eq(bankStatementLines.id, bankLineSuggestions.statementLineId))
      .leftJoin(
        bankLineMatches,
        eq(bankLineMatches.statementLineId, bankLineSuggestions.statementLineId),
      )
      .where(
        and(
          eq(bankLineSuggestions.companyId, companyId),
          eq(bankLineSuggestions.status, 'APPLIED'),
          sql`${bankLineSuggestions.action} <> 'IGNORE'`,
          sql`(${bankLineMatches.id} is null or ${bankStatementLines.status} not in ('MATCHED', 'RECONCILED'))`,
        ),
      );
    return finding(
      'APPLIED_WITHOUT_MATCH',
      'CRITICAL',
      'Applied suggestions left a matched statement line',
      rows.length,
      rows.map((r) => ({
        suggestionId: r.id,
        statementLineId: r.lineId,
        result: r.resultNumber,
        lineStatus: r.lineStatus,
      })),
    );
  }

  private async staleLines(companyId: string, asOf: string): Promise<IntegrityFinding> {
    const settings = await this.rules.settings(companyId);
    const cutoff = addDays(asOf, -settings.staleAfterDays);
    const rows = await this.db
      .select({
        id: bankStatementLines.id,
        statementNumber: bankStatements.statementNumber,
        bank: bankAccounts.code,
        lineDate: bankStatementLines.lineDate,
        amount: bankStatementLines.amount,
        description: bankStatementLines.description,
      })
      .from(bankStatementLines)
      .innerJoin(bankStatements, eq(bankStatements.id, bankStatementLines.statementId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, bankStatements.bankAccountId))
      .where(
        and(
          eq(bankStatements.companyId, companyId),
          eq(bankStatements.status, 'OPEN'),
          inArray(bankStatementLines.status, ['UNMATCHED', 'POSSIBLE_MATCH', 'EXCEPTION']),
          lt(bankStatementLines.lineDate, cutoff),
        ),
      );
    return finding(
      'STALE_UNMATCHED_LINES',
      'WARNING',
      `No feed line is unexplained for more than ${settings.staleAfterDays} days`,
      rows.length,
      rows.map((r) => ({
        statementLineId: r.id,
        statement: r.statementNumber,
        bank: r.bank,
        lineDate: r.lineDate,
        amount: r.amount,
        description: r.description,
      })),
    );
  }

  private async rulesWithoutAccount(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: bankMatchingRules.id,
        name: bankMatchingRules.name,
        action: bankMatchingRules.action,
      })
      .from(bankMatchingRules)
      .where(
        and(
          eq(bankMatchingRules.companyId, companyId),
          eq(bankMatchingRules.status, 'ACTIVE'),
          sql`((${bankMatchingRules.action} = 'POST_TRANSACTION' and ${bankMatchingRules.counterpartyAccountId} is null) or (${bankMatchingRules.action} in ('RECEIVE_CUSTOMER', 'PAY_VENDOR') and ${bankMatchingRules.partyId} is null))`,
        ),
      );
    return finding(
      'RULES_WITHOUT_ACCOUNT',
      'CRITICAL',
      'Active rules name the account or party they post to',
      rows.length,
      rows.map((r) => ({ ruleId: r.id, name: r.name, action: r.action })),
    );
  }
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function finding(
  check: string,
  severity: IntegrityFinding['severity'],
  title: string,
  count: number,
  samples: Array<Record<string, unknown>>,
  detail?: string,
): IntegrityFinding {
  return { check, severity, title, count, samples: samples.slice(0, 20), detail };
}
