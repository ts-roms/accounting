import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm';
import { Money } from '@accounting/money';
import type { EmployeeYtdQuery, PayrollSummaryQuery } from '@accounting/validation';
import { DRIZZLE, type Database } from '@/database/database.types';
import {
  accountMappings,
  dimensions,
  expenseClaims,
  payRuns,
  payslipLines,
  payslips,
} from '@/database/schema';
import { AccountsService } from '@/modules/accounting/accounts/accounts.service';
import type {
  IntegrityFinding,
  IntegrityReport,
} from '@/modules/accounting/integrity/integrity.service';
import { GeneralLedgerService } from '@/modules/accounting/ledger/general-ledger.service';

export interface PayrollSummary {
  from: string;
  to: string;
  currency: string;
  runs: number;
  employees: number;
  gross: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  reimbursements: string;
  net: string;
  /** Total cost to the company: gross + employer contributions. */
  employerCost: string;
  byDepartment: Array<{
    departmentId: string | null;
    department: string;
    employees: number;
    gross: string;
    employerContributions: string;
    employerCost: string;
  }>;
  byItem: Array<{ code: string; description: string; type: string; amount: string }>;
  byMonth: Array<{ month: string; runs: number; gross: string; withholding: string; net: string }>;
}

export interface WithholdingRemittance {
  from: string;
  to: string;
  currency: string;
  rows: Array<{
    month: string;
    employees: number;
    taxable: string;
    withholding: string;
    runs: string[];
  }>;
  total: string;
}

export interface EmployeeYtd {
  employeeId: string;
  year: number;
  currency: string;
  payslips: number;
  gross: string;
  taxable: string;
  withholding: string;
  deductions: string;
  employerContributions: string;
  net: string;
  byItem: Array<{ code: string; type: string; amount: string }>;
}

/**
 * Payroll reporting (Prompt #11): every figure is the sum of posted / paid
 * payslips; the integrity report proves them against the employee payable
 * in the ledger (which also carries posted expense claims).
 */
@Injectable()
export class PayrollReportsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly accounts: AccountsService,
    private readonly ledger: GeneralLedgerService,
  ) {}

  async summary(companyId: string, query: PayrollSummaryQuery): Promise<PayrollSummary> {
    const currency = await this.accounts.companyCurrency(companyId);
    const runs = await this.db
      .select()
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['POSTED', 'PAID']),
          gte(payRuns.periodEnd, query.from),
          lte(payRuns.periodEnd, query.to),
        ),
      )
      .orderBy(asc(payRuns.periodEnd));
    const runIds = runs.map((r) => r.id);
    const slips = runIds.length
      ? await this.db
          .select({ s: payslips, department: dimensions.name })
          .from(payslips)
          .leftJoin(dimensions, eq(dimensions.id, payslips.departmentId))
          .where(inArray(payslips.payRunId, runIds))
      : [];
    const lines = slips.length
      ? await this.db
          .select({
            code: payslipLines.code,
            description: payslipLines.description,
            type: payslipLines.type,
            amount: sql<string>`sum(${payslipLines.baseAmount})`,
          })
          .from(payslipLines)
          .where(
            inArray(
              payslipLines.payslipId,
              slips.map((s) => s.s.id),
            ),
          )
          .groupBy(payslipLines.code, payslipLines.description, payslipLines.type)
          .orderBy(asc(payslipLines.type), asc(payslipLines.code))
      : [];
    const sum = (pick: (s: (typeof slips)[number]['s']) => string, rows = slips) =>
      Money.sum(
        rows.map((r) => Money.of(pick(r.s), currency)),
        currency,
      );
    const byDept = new Map<
      string,
      {
        departmentId: string | null;
        department: string;
        employees: Set<string>;
        gross: Money;
        employer: Money;
      }
    >();
    for (const r of slips) {
      const key = r.s.departmentId ?? 'NONE';
      let d = byDept.get(key);
      if (!d)
        byDept.set(
          key,
          (d = {
            departmentId: r.s.departmentId,
            department: r.department ?? 'Unassigned',
            employees: new Set(),
            gross: Money.zero(currency),
            employer: Money.zero(currency),
          }),
        );
      d.employees.add(r.s.employeeId);
      d.gross = d.gross.add(Money.of(r.s.grossBase, currency));
      d.employer = d.employer.add(Money.of(r.s.employerContributionsBase, currency));
    }
    const byMonth = new Map<
      string,
      { runs: number; gross: Money; withholding: Money; net: Money }
    >();
    for (const r of runs) {
      const key = r.periodEnd.slice(0, 7);
      const m = byMonth.get(key) ?? {
        runs: 0,
        gross: Money.zero(currency),
        withholding: Money.zero(currency),
        net: Money.zero(currency),
      };
      m.runs += 1;
      m.gross = m.gross.add(Money.of(r.grossTotalBase, currency));
      m.withholding = m.withholding.add(Money.of(r.withholdingTotalBase, currency));
      m.net = m.net.add(Money.of(r.netTotalBase, currency));
      byMonth.set(key, m);
    }
    const gross = sum((s) => s.grossBase);
    const employer = sum((s) => s.employerContributionsBase);
    return {
      from: query.from,
      to: query.to,
      currency,
      runs: runs.length,
      employees: new Set(slips.map((s) => s.s.employeeId)).size,
      gross: gross.toString(),
      withholding: sum((s) => s.withholdingBase).toString(),
      deductions: sum((s) => s.deductionsBase).toString(),
      employerContributions: employer.toString(),
      reimbursements: sum((s) => s.reimbursementsBase).toString(),
      net: sum((s) => s.netBase).toString(),
      employerCost: gross.add(employer).toString(),
      byDepartment: [...byDept.values()]
        .map((d) => ({
          departmentId: d.departmentId,
          department: d.department,
          employees: d.employees.size,
          gross: d.gross.toString(),
          employerContributions: d.employer.toString(),
          employerCost: d.gross.add(d.employer).toString(),
        }))
        .sort((a, b) => Number(b.employerCost) - Number(a.employerCost)),
      byItem: lines.map((l) => ({
        code: l.code,
        description: l.description.split(' - ')[0]!,
        type: l.type,
        amount: Money.of(l.amount, currency).toString(),
      })),
      byMonth: [...byMonth.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, m]) => ({
          month,
          runs: m.runs,
          gross: m.gross.toString(),
          withholding: m.withholding.toString(),
          net: m.net.toString(),
        })),
    };
  }

  /** Withholding tax by month of period end - what is due to the tax authority from posted runs. */
  async withholdingRemittance(
    companyId: string,
    query: PayrollSummaryQuery,
  ): Promise<WithholdingRemittance> {
    const currency = await this.accounts.companyCurrency(companyId);
    const runs = await this.db
      .select()
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['POSTED', 'PAID']),
          gte(payRuns.periodEnd, query.from),
          lte(payRuns.periodEnd, query.to),
        ),
      )
      .orderBy(asc(payRuns.periodEnd));
    const byMonth = new Map<
      string,
      { employees: number; taxable: Money; withholding: Money; runs: string[] }
    >();
    for (const r of runs) {
      const key = r.periodEnd.slice(0, 7);
      const m = byMonth.get(key) ?? {
        employees: 0,
        taxable: Money.zero(currency),
        withholding: Money.zero(currency),
        runs: [],
      };
      m.employees += r.employeeCount;
      m.taxable = m.taxable.add(Money.of(r.taxableTotalBase, currency));
      m.withholding = m.withholding.add(Money.of(r.withholdingTotalBase, currency));
      m.runs.push(r.documentNumber);
      byMonth.set(key, m);
    }
    const rows = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({
        month,
        employees: m.employees,
        taxable: m.taxable.toString(),
        withholding: m.withholding.toString(),
        runs: m.runs,
      }));
    return {
      from: query.from,
      to: query.to,
      currency,
      rows,
      total: Money.sum(
        rows.map((r) => Money.of(r.withholding, currency)),
        currency,
      ).toString(),
    };
  }

  async employeeYtd(
    companyId: string,
    employeeId: string,
    query: EmployeeYtdQuery,
  ): Promise<EmployeeYtd> {
    const currency = await this.accounts.companyCurrency(companyId);
    const year = query.year ?? new Date().getUTCFullYear();
    const rows = await this.db
      .select({ s: payslips })
      .from(payslips)
      .innerJoin(payRuns, eq(payRuns.id, payslips.payRunId))
      .where(
        and(
          eq(payRuns.companyId, companyId),
          eq(payslips.employeeId, employeeId),
          inArray(payRuns.status, ['POSTED', 'PAID']),
          gte(payRuns.periodEnd, `${year}-01-01`),
          lte(payRuns.periodEnd, `${year}-12-31`),
        ),
      );
    const items = rows.length
      ? await this.db
          .select({
            code: payslipLines.code,
            type: payslipLines.type,
            amount: sql<string>`sum(${payslipLines.baseAmount})`,
          })
          .from(payslipLines)
          .where(
            inArray(
              payslipLines.payslipId,
              rows.map((r) => r.s.id),
            ),
          )
          .groupBy(payslipLines.code, payslipLines.type)
          .orderBy(asc(payslipLines.type), asc(payslipLines.code))
      : [];
    const sum = (pick: (s: (typeof rows)[number]['s']) => string) =>
      Money.sum(
        rows.map((r) => Money.of(pick(r.s), currency)),
        currency,
      ).toString();
    return {
      employeeId,
      year,
      currency,
      payslips: rows.length,
      gross: sum((s) => s.grossBase),
      taxable: sum((s) => s.taxableBase),
      withholding: sum((s) => s.withholdingBase),
      deductions: sum((s) => s.deductionsBase),
      employerContributions: sum((s) => s.employerContributionsBase),
      net: sum((s) => s.netBase),
      byItem: items.map((i) => ({
        code: i.code,
        type: i.type,
        amount: Money.of(i.amount, currency).toString(),
      })),
    };
  }

  // ---------------------------------------------------------------- integrity

  async integrity(companyId: string, asOf: string): Promise<IntegrityReport> {
    const currency = await this.accounts.companyCurrency(companyId);
    const findings = await Promise.all([
      this.payableVsLedger(companyId, asOf, currency),
      this.payslipTotals(companyId, currency),
      this.runsWithoutJournal(companyId),
      this.unpaidRuns(companyId, asOf, currency),
    ]);
    const status = findings.some((f) => f.count > 0 && f.severity === 'CRITICAL')
      ? 'CRITICAL'
      : findings.some((f) => f.count > 0 && f.severity === 'WARNING')
        ? 'WARNING'
        : 'OK';
    return { asOf, currency, ranAt: new Date().toISOString(), status, findings };
  }

  /** EMPLOYEE_PAYABLE balance = posted-unpaid pay runs (net less reimbursements) + posted-unpaid expense claims. */
  private async payableVsLedger(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const [mapping] = await this.db
      .select({ accountId: accountMappings.accountId })
      .from(accountMappings)
      .where(
        and(eq(accountMappings.companyId, companyId), eq(accountMappings.key, 'EMPLOYEE_PAYABLE')),
      );
    if (!mapping)
      return finding(
        'EMPLOYEE_PAYABLE_VS_LEDGER',
        'CRITICAL',
        'Employee payable equals unpaid payroll and claims',
        0,
        [],
        'No EMPLOYEE_PAYABLE mapping yet.',
      );
    const activity = await this.ledger.activity({
      companyId,
      to: asOf,
      accountIds: [mapping.accountId],
    });
    const row = activity.find((a) => a.accountId === mapping.accountId);
    const ledger = row
      ? Money.of(row.credit, currency).subtract(Money.of(row.debit, currency))
      : Money.zero(currency);
    // Runs posted by asOf and not paid by asOf owe net - reimbursements (the claims carry their own liability).
    const runs = await this.db
      .select({
        net: payRuns.netTotalBase,
        reimbursements: payRuns.reimbursementTotalBase,
        documentNumber: payRuns.documentNumber,
      })
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['POSTED', 'PAID']),
          lte(payRuns.periodEnd, asOf),
          sql`(${payRuns.paymentDate} is null or ${payRuns.paymentDate} > ${asOf})`,
        ),
      );
    const runsOwed = Money.sum(
      runs.map((r) => Money.of(r.net, currency).subtract(Money.of(r.reimbursements, currency))),
      currency,
    );
    const claims = await this.db
      .select({ total: expenseClaims.total, claimNumber: expenseClaims.claimNumber })
      .from(expenseClaims)
      .where(
        and(
          eq(expenseClaims.companyId, companyId),
          inArray(expenseClaims.status, ['POSTED', 'PAID']),
          lte(expenseClaims.claimDate, asOf),
          sql`(${expenseClaims.paymentDate} is null or ${expenseClaims.paymentDate} > ${asOf})`,
        ),
      );
    const claimsOwed = Money.sum(
      claims.map((c) => Money.of(c.total, currency)),
      currency,
    );
    const expected = runsOwed.add(claimsOwed);
    const variance = ledger.subtract(expected);
    return finding(
      'EMPLOYEE_PAYABLE_VS_LEDGER',
      'CRITICAL',
      'Employee payable equals unpaid payroll and claims',
      variance.isZero() ? 0 : 1,
      variance.isZero()
        ? []
        : [
            {
              ledger: ledger.toString(),
              payroll: runsOwed.toString(),
              claims: claimsOwed.toString(),
              variance: variance.toString(),
            },
          ],
      'Opening balances or manual journals on the employee payable account show up here.',
    );
  }

  private async payslipTotals(companyId: string, currency: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        id: payslips.id,
        employee: payslips.employeeName,
        run: payRuns.documentNumber,
        gross: payslips.gross,
        deductions: payslips.deductions,
        withholding: payslips.withholding,
        reimbursements: payslips.reimbursements,
        net: payslips.net,
        earnings: sql<string>`coalesce(sum(case when ${payslipLines.type} = 'EARNING' and ${payslipLines.expenseClaimId} is null then ${payslipLines.amount} else 0 end), 0)`,
        lineDeductions: sql<string>`coalesce(sum(case when ${payslipLines.type} = 'DEDUCTION' then ${payslipLines.amount} else 0 end), 0)`,
        lineTax: sql<string>`coalesce(sum(case when ${payslipLines.type} = 'WITHHOLDING_TAX' then ${payslipLines.amount} else 0 end), 0)`,
        lineClaims: sql<string>`coalesce(sum(case when ${payslipLines.expenseClaimId} is not null then ${payslipLines.amount} else 0 end), 0)`,
      })
      .from(payslips)
      .innerJoin(payRuns, eq(payRuns.id, payslips.payRunId))
      .leftJoin(payslipLines, eq(payslipLines.payslipId, payslips.id))
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['APPROVED', 'POSTED', 'PAID']),
        ),
      )
      .groupBy(payslips.id, payRuns.documentNumber);
    const m = (v: string) => Money.of(v, currency);
    const bad = rows.filter((r) => {
      const net = m(r.gross)
        .subtract(m(r.deductions))
        .subtract(m(r.withholding))
        .add(m(r.reimbursements));
      return !(
        m(r.earnings).equals(m(r.gross)) &&
        m(r.lineDeductions).equals(m(r.deductions)) &&
        m(r.lineTax).equals(m(r.withholding)) &&
        m(r.lineClaims).equals(m(r.reimbursements)) &&
        net.equals(m(r.net))
      );
    });
    return finding(
      'PAYSLIP_TOTALS',
      'CRITICAL',
      'Payslip lines agree with payslip totals and net pay',
      bad.length,
      bad.map((r) => ({
        payslipId: r.id,
        run: r.run,
        employee: r.employee,
        gross: r.gross,
        net: r.net,
      })),
    );
  }

  private async runsWithoutJournal(companyId: string): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({ documentNumber: payRuns.documentNumber, status: payRuns.status })
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          sql`((${payRuns.status} in ('POSTED', 'PAID', 'REVERSED') and ${payRuns.journalEntryId} is null) or (${payRuns.status} = 'PAID' and ${payRuns.paymentJournalEntryId} is null) or (${payRuns.status} = 'REVERSED' and ${payRuns.reversalJournalEntryId} is null))`,
        ),
      );
    return finding(
      'PAY_RUN_WITHOUT_JOURNAL',
      'CRITICAL',
      'Posted, paid and reversed runs carry their journals',
      rows.length,
      rows.map((r) => ({ run: r.documentNumber, status: r.status })),
    );
  }

  private async unpaidRuns(
    companyId: string,
    asOf: string,
    currency: string,
  ): Promise<IntegrityFinding> {
    const rows = await this.db
      .select({
        documentNumber: payRuns.documentNumber,
        payDate: payRuns.payDate,
        net: payRuns.netTotalBase,
        status: payRuns.status,
      })
      .from(payRuns)
      .where(
        and(
          eq(payRuns.companyId, companyId),
          inArray(payRuns.status, ['CALCULATED', 'APPROVED', 'POSTED']),
          lt(payRuns.payDate, asOf),
        ),
      )
      .orderBy(asc(payRuns.payDate));
    const total = Money.sum(
      rows.map((r) => Money.of(r.net, currency)),
      currency,
    );
    return finding(
      'PAY_RUNS_UNPAID',
      'WARNING',
      'No pay run is past its pay date without payment',
      rows.length,
      rows.map((r) => ({
        run: r.documentNumber,
        payDate: r.payDate,
        status: r.status,
        net: r.net,
      })),
      rows.length ? `${currency} ${total.toString()} past due.` : undefined,
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
