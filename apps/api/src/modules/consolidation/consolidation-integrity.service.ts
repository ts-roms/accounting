import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accounts,
  consolidationAdjustmentLines,
  consolidationAdjustments,
  consolidationGroups,
  consolidationRuns,
  intercompanyTransactions,
  organizations,
} from '@/database/schema';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { ConsolidationRunsService } from './consolidation-runs.service';
import { IntercompanyReconciliationService } from './intercompany-reconciliation.service';

/**
 * Consolidation integrity (Prompt #9). Read-only assertions over the group
 * ledgers: every run balances, every adjustment balances, finalized runs
 * still agree with the member books they froze, intercompany postings carry
 * both legs and the intercompany accounts agree with the register.
 */
@Injectable()
export class ConsolidationIntegrityService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly runs: ConsolidationRunsService,
    private readonly intercompany: IntercompanyReconciliationService,
  ) {}

  async run(organizationId: string, asOf: string): Promise<IntegrityReport> {
    const [org] = await this.db
      .select({ baseCurrency: organizations.baseCurrency })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    const currency = org?.baseCurrency ?? 'PHP';
    const findings = await Promise.all([
      this.runsBalanced(organizationId),
      this.adjustmentsBalanced(organizationId),
      this.finalizedDrift(organizationId),
      this.groupAccountsExist(organizationId),
      this.intercompanyJournals(organizationId),
      this.intercompanyDrift(organizationId, asOf),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  private async runsBalanced(organizationId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ id: consolidationRuns.id, documentNumber: consolidationRuns.documentNumber })
      .from(consolidationRuns)
      .innerJoin(consolidationGroups, eq(consolidationGroups.id, consolidationRuns.groupId))
      .where(eq(consolidationGroups.organizationId, organizationId));
    const bad: Array<Record<string, unknown>> = [];
    for (const r of rows) {
      const detail = await this.runs.get(organizationId, r.id);
      if (!detail.totals.balanced)
        bad.push({ documentNumber: r.documentNumber, difference: detail.totals.difference });
    }
    return finding(
      'CONSOLIDATION_UNBALANCED',
      'CRITICAL',
      'Consolidated trial balances balance',
      bad.length,
      bad,
    );
  }

  private async adjustmentsBalanced(organizationId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: consolidationAdjustments.id,
        run: consolidationRuns.documentNumber,
        sequence: consolidationAdjustments.sequence,
        debit: sql<string>`coalesce(sum(${consolidationAdjustmentLines.debit}), 0)`,
        credit: sql<string>`coalesce(sum(${consolidationAdjustmentLines.credit}), 0)`,
      })
      .from(consolidationAdjustments)
      .innerJoin(consolidationRuns, eq(consolidationRuns.id, consolidationAdjustments.runId))
      .innerJoin(consolidationGroups, eq(consolidationGroups.id, consolidationRuns.groupId))
      .leftJoin(
        consolidationAdjustmentLines,
        eq(consolidationAdjustmentLines.adjustmentId, consolidationAdjustments.id),
      )
      .where(
        and(
          eq(consolidationGroups.organizationId, organizationId),
          eq(consolidationAdjustments.status, 'ACTIVE'),
        ),
      )
      .groupBy(
        consolidationAdjustments.id,
        consolidationRuns.documentNumber,
        consolidationAdjustments.sequence,
      );
    const bad = rows
      .filter((r) => Number(r.debit) !== Number(r.credit))
      .map((r) => ({ run: r.run, sequence: r.sequence, debit: r.debit, credit: r.credit }));
    return finding(
      'CONSOLIDATION_ADJUSTMENT_UNBALANCED',
      'CRITICAL',
      'Consolidation adjustments balance',
      bad.length,
      bad,
    );
  }

  /** A finalized run froze the member figures; if the books moved since, the group close no longer reflects them. */
  private async finalizedDrift(organizationId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ run: consolidationRuns, group: consolidationGroups })
      .from(consolidationRuns)
      .innerJoin(consolidationGroups, eq(consolidationGroups.id, consolidationRuns.groupId))
      .where(
        and(
          eq(consolidationGroups.organizationId, organizationId),
          eq(consolidationRuns.status, 'FINALIZED'),
        ),
      );
    const bad: Array<Record<string, unknown>> = [];
    for (const { run, group } of rows) {
      if (!run.snapshot) continue;
      const live = await this.runs.liveSnapshot(group, run);
      const key = (r: { companyId: string; code: string }) => `${r.companyId}:${r.code}`;
      const frozen = new Map(run.snapshot.map((r) => [key(r), r]));
      const current = new Map(live.map((r) => [key(r), r]));
      const drifted: string[] = [];
      for (const [k, r] of current) {
        const f = frozen.get(k);
        if (
          !f ||
          !Money.of(f.closing, run.currency).equals(Money.of(r.closing, run.currency)) ||
          !Money.of(f.period, run.currency).equals(Money.of(r.period, run.currency))
        )
          drifted.push(r.code);
      }
      for (const k of frozen.keys()) if (!current.has(k)) drifted.push(frozen.get(k)!.code);
      if (drifted.length)
        bad.push({
          documentNumber: run.documentNumber,
          periodEnd: run.periodEnd,
          accounts: [...new Set(drifted)].slice(0, 10),
        });
    }
    return finding(
      'FINALIZED_RUN_DRIFT',
      'WARNING',
      'Member books unchanged since the group close was finalized',
      bad.length,
      bad,
      'Reopen and re-prepare the run, or reverse the late entity posting.',
    );
  }

  private async groupAccountsExist(organizationId: string): Promise<IntegrityFinding> {
    const groups = await this.db
      .select()
      .from(consolidationGroups)
      .where(
        and(
          eq(consolidationGroups.organizationId, organizationId),
          eq(consolidationGroups.status, 'ACTIVE'),
        ),
      );
    const bad: Array<Record<string, unknown>> = [];
    for (const g of groups) {
      const codes = Object.values(g.accounts);
      const existing = await this.db
        .select({ code: accounts.code })
        .from(accounts)
        .where(and(eq(accounts.companyId, g.parentCompanyId), inArray(accounts.code, codes)));
      const missing = codes.filter((c) => !existing.some((e) => e.code === c));
      if (missing.length) bad.push({ group: g.code, missing });
    }
    return finding(
      'GROUP_ACCOUNTS_MISSING',
      'CRITICAL',
      'Group posting accounts exist in the parent chart',
      bad.length,
      bad,
    );
  }

  private async intercompanyJournals(organizationId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: intercompanyTransactions.documentNumber,
        status: intercompanyTransactions.status,
      })
      .from(intercompanyTransactions)
      .where(
        and(
          eq(intercompanyTransactions.organizationId, organizationId),
          or(
            and(
              inArray(intercompanyTransactions.status, ['POSTED', 'SETTLED']),
              or(
                isNull(intercompanyTransactions.fromJournalEntryId),
                isNull(intercompanyTransactions.toJournalEntryId),
              ),
            ),
            and(
              eq(intercompanyTransactions.status, 'SETTLED'),
              or(
                isNull(intercompanyTransactions.settlementFromJournalEntryId),
                isNull(intercompanyTransactions.settlementToJournalEntryId),
              ),
            ),
          ),
        ),
      );
    return finding(
      'INTERCOMPANY_WITHOUT_JOURNALS',
      'CRITICAL',
      'Intercompany charges and settlements carry both journal legs',
      rows.length,
      rows.slice(0, 20),
    );
  }

  private async intercompanyDrift(organizationId: string, asOf: string): Promise<IntegrityFinding> {
    const recon = await this.intercompany.reconcile(organizationId, { asOf });
    const bad = recon.entities
      .filter((e) => e.receivableDifference !== '0.0000' || e.payableDifference !== '0.0000')
      .map((e) => ({
        company: e.companyCode,
        receivableDifference: e.receivableDifference,
        payableDifference: e.payableDifference,
      }));
    return finding(
      'INTERCOMPANY_LEDGER_DRIFT',
      'WARNING',
      'Intercompany accounts agree with the intercompany register',
      bad.length,
      bad,
      'Postings to intercompany accounts outside the intercompany module (manual journals, opening balances) explain the difference.',
    );
  }
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
