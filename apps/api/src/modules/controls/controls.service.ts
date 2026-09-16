import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CloseStatus, FiscalPeriodStatus } from '@accounting/types';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  auditLogs,
  financialCloses,
  fiscalPeriods,
  fiscalYears,
  reconciliationExceptions,
} from '@/database/schema';
import { IntegrityService } from '@/modules/accounting/integrity/integrity.service';
import { FinancialCloseService } from '@/modules/financial-close/financial-close.service';
import { SodService } from '@/modules/rbac/sod.service';
import { ReconciliationsService } from '@/modules/reconciliation/reconciliations.service';
import { SuspenseService } from '@/modules/accounting/suspense/suspense.service';
import { ApprovalsService } from '@/modules/workflows/approvals.service';

export type ControlSeverity = 'OK' | 'INFO' | 'WARNING' | 'CRITICAL';

export interface ControlTile {
  key: string;
  title: string;
  /** Number or amount (decimal string) depending on `kind`. */
  value: string;
  kind: 'count' | 'amount' | 'percent' | 'text';
  severity: ControlSeverity;
  detail: string | null;
  /** Where to drill down in the web app. */
  href: string;
}

export interface ControlDashboard {
  asOf: string;
  currency: string;
  generatedAt: string;
  status: ControlSeverity;
  tiles: ControlTile[];
}

/**
 * Financial control dashboard (hardening phase 5): one read-only view over the
 * controls the other modules already enforce - integrity findings, pending
 * and overdue approvals, reconciliation variances, suspense balances, open
 * exceptions, the open period and its close. Nothing here is stored.
 */
@Injectable()
export class ControlsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly integrity: IntegrityService,
    private readonly approvals: ApprovalsService,
    private readonly reconciliations: ReconciliationsService,
    private readonly suspense: SuspenseService,
    private readonly closes: FinancialCloseService,
    private readonly sod: SodService,
  ) {}

  async dashboard(
    companyId: string,
    organizationId: string,
    asOf: string,
  ): Promise<ControlDashboard> {
    const [integrity, approvals, recon, suspense, period, sodConflicts, sodWarnings] =
      await Promise.all([
        this.integrity.run(companyId, asOf),
        this.approvals.pendingSummary(companyId),
        this.reconciliations.summary(companyId, asOf),
        this.suspense.monitor(companyId, asOf),
        this.openPeriod(companyId),
        this.sod.userConflicts(organizationId),
        this.recentSodWarnings(companyId),
      ]);
    const finding = (check: string) => integrity.findings.find((f) => f.check === check);
    const unbalanced = finding('UNBALANCED_JOURNAL')?.count ?? 0;
    const criticalFindings = integrity.findings.filter(
      (f) => f.count > 0 && f.severity === 'CRITICAL',
    );
    const warningFindings = integrity.findings.filter(
      (f) => f.count > 0 && f.severity === 'WARNING',
    );
    const variances = recon.areas.filter((a) => !a.live.withinMateriality);
    const stale = recon.areas.filter((a) => a.stale);
    const openExceptions = await this.openExceptions(companyId);
    const close = period ? await this.liveClose(companyId, period.id) : null;

    const tiles: ControlTile[] = [
      {
        key: 'UNBALANCED_JOURNALS',
        title: 'Unbalanced journals',
        value: String(unbalanced),
        kind: 'count',
        severity: unbalanced > 0 ? 'CRITICAL' : 'OK',
        detail: null,
        href: '/accounting/integrity',
      },
      {
        key: 'INTEGRITY',
        title: 'Integrity findings',
        value: String(criticalFindings.length + warningFindings.length),
        kind: 'count',
        severity:
          criticalFindings.length > 0 ? 'CRITICAL' : warningFindings.length > 0 ? 'WARNING' : 'OK',
        detail:
          criticalFindings.length + warningFindings.length > 0
            ? [...criticalFindings, ...warningFindings].map((f) => f.check).join(', ')
            : `${integrity.findings.length} checks pass`,
        href: '/accounting/integrity',
      },
      {
        key: 'PENDING_APPROVALS',
        title: 'Pending approvals',
        value: String(approvals.pending),
        kind: 'count',
        severity: approvals.overdue > 0 ? 'WARNING' : approvals.pending > 0 ? 'INFO' : 'OK',
        detail: approvals.overdue > 0 ? `${approvals.overdue} past deadline` : null,
        href: '/admin/approvals',
      },
      {
        key: 'RECONCILIATION_VARIANCES',
        title: 'Reconciliation variances',
        value: String(variances.length),
        kind: 'count',
        severity: variances.length > 0 ? 'WARNING' : stale.length > 0 ? 'INFO' : 'OK',
        detail:
          variances.length > 0
            ? variances.map((a) => `${a.area} ${a.live.variance}`).join(', ')
            : stale.length > 0
              ? `${stale.length} area(s) not reconciled recently`
              : null,
        href: '/accounting/reconciliation',
      },
      {
        key: 'SUSPENSE_BALANCE',
        title: 'Suspense balance',
        value: suspense.totalBalance,
        kind: 'amount',
        severity:
          suspense.requiresInvestigation > 0
            ? 'WARNING'
            : suspense.totalBalance !== '0.0000'
              ? 'INFO'
              : 'OK',
        detail:
          suspense.requiresInvestigation > 0
            ? `${suspense.requiresInvestigation} account(s) require investigation`
            : `${suspense.accounts.length} account(s) watched`,
        href: '/accounting/suspense',
      },
      {
        key: 'OPEN_EXCEPTIONS',
        title: 'Unresolved exceptions',
        value: String(openExceptions),
        kind: 'count',
        severity: openExceptions > 0 ? 'WARNING' : 'OK',
        detail: openExceptions > 0 ? 'Open reconciliation exceptions' : null,
        href: '/accounting/reconciliation',
      },
      {
        key: 'SOD_CONFLICTS',
        title: 'Segregation-of-duties conflicts',
        value: String(sodConflicts.length),
        kind: 'count',
        severity: sodConflicts.some((c) => c.enforcement === 'BLOCK')
          ? 'CRITICAL'
          : sodConflicts.length > 0
            ? 'WARNING'
            : 'OK',
        detail:
          sodWarnings > 0
            ? `${sodWarnings} warned override(s) in the last 30 days`
            : sodConflicts.length > 0
              ? 'Users holding both sides of a policy'
              : null,
        href: '/admin/roles',
      },
      {
        key: 'FAILED_JOBS',
        title: 'Failed accounting jobs',
        value: 'n/a',
        kind: 'text',
        severity: 'INFO',
        detail: 'Job failure tracking arrives with the reliability phase (H8)',
        href: '/admin/audit-logs',
      },
      {
        key: 'OPEN_PERIOD',
        title: 'Open period',
        value: period?.name ?? 'None',
        kind: 'text',
        severity: period ? (period.status === 'SOFT_CLOSED' ? 'INFO' : 'OK') : 'WARNING',
        detail: period ? period.status.replace('_', ' ') : 'No open fiscal period',
        href: '/accounting/period-closing',
      },
      {
        key: 'CLOSE_PROGRESS',
        title: 'Close progress',
        value: close ? String(close.progress) : '0',
        kind: 'percent',
        severity: close
          ? close.status === 'APPROVED' || close.status === 'READY'
            ? 'OK'
            : close.blockers > 0
              ? 'WARNING'
              : 'INFO'
          : 'INFO',
        detail: close
          ? `${close.status.replace('_', ' ')} - ${close.blockers} blocker(s)`
          : 'No close started for the open period',
        href: close ? `/accounting/financial-close/${close.id}` : '/accounting/financial-close',
      },
    ];
    const rank: Record<ControlSeverity, number> = { OK: 0, INFO: 1, WARNING: 2, CRITICAL: 3 };
    const status = tiles.reduce<ControlSeverity>(
      (worst, t) => (rank[t.severity] > rank[worst] ? t.severity : worst),
      'OK',
    );
    return {
      asOf,
      currency: integrity.currency,
      generatedAt: new Date().toISOString(),
      status,
      tiles,
    };
  }

  /** Earliest period that is still open (or soft-closed): the one being worked. */
  private async openPeriod(
    companyId: string,
  ): Promise<{ id: string; name: string; status: FiscalPeriodStatus } | null> {
    const [row] = await this.db
      .select({ id: fiscalPeriods.id, name: fiscalPeriods.name, status: fiscalPeriods.status })
      .from(fiscalPeriods)
      .innerJoin(fiscalYears, eq(fiscalYears.id, fiscalPeriods.fiscalYearId))
      .where(
        and(
          eq(fiscalYears.companyId, companyId),
          inArray(fiscalPeriods.status, ['OPEN', 'SOFT_CLOSED']),
        ),
      )
      .orderBy(asc(fiscalPeriods.startDate))
      .limit(1);
    return row ?? null;
  }

  private async liveClose(
    companyId: string,
    fiscalPeriodId: string,
  ): Promise<{ id: string; status: CloseStatus; progress: number; blockers: number } | null> {
    const [row] = await this.db
      .select({ id: financialCloses.id })
      .from(financialCloses)
      .where(
        and(
          eq(financialCloses.fiscalPeriodId, fiscalPeriodId),
          inArray(financialCloses.status, ['IN_PROGRESS', 'READY', 'APPROVED']),
        ),
      );
    if (!row) return null;
    const detail = await this.closes.get(companyId, row.id);
    return {
      id: detail.id,
      status: detail.status,
      progress: detail.progress,
      blockers: detail.blockers.filter((b) => b.blocking).length,
    };
  }

  private async openExceptions(companyId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(reconciliationExceptions)
      .where(
        and(
          eq(reconciliationExceptions.companyId, companyId),
          eq(reconciliationExceptions.status, 'OPEN'),
        ),
      );
    return row?.n ?? 0;
  }

  private async recentSodWarnings(companyId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          eq(auditLogs.action, 'SOD_WARNING'),
          sql`${auditLogs.occurredAt} > now() - interval '30 days'`,
        ),
      );
    return row?.n ?? 0;
  }
}
