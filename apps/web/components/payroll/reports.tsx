'use client';
import * as React from 'react';
import { ShieldCheck } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@accounting/ui';
import {
  usePayrollIntegrity,
  usePayrollSummary,
  useWithholdingRemittance,
} from '@/lib/api/payroll-hooks';
import { Amount, today } from '@/components/accounting/primitives';
import { PageHeader } from '@/components/ui-ext/page';
import { Kpi, StatusBadge } from '@/components/receivables/shared';
import { QueryState } from '@/components/treasury/shared';
import { ITEM_TYPE_LABEL } from './pay-items';

/** Payroll cost, withholding remittance and integrity - every figure from posted / paid payslips. */
export function PayrollReportsPage() {
  const now = today();
  const [from, setFrom] = React.useState(`${now.slice(0, 4)}-01-01`);
  const [to, setTo] = React.useState(now);
  const summary = usePayrollSummary({ from, to });
  const withholding = useWithholdingRemittance({ from, to });
  const integrity = usePayrollIntegrity(to);
  return (
    <>
      <PageHeader
        title="Payroll Reports"
        description="Cost of payroll by month, department and pay item, the withholding tax due by month, and the checks that prove the employee payable against the ledger."
        actions={
          <div className="flex gap-2">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-40"
              aria-label="From"
            />
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-40"
              aria-label="To"
            />
          </div>
        }
      />
      <QueryState query={summary}>
        {(s) => (
          <>
            <div className="grid gap-3 sm:grid-cols-5">
              <Kpi label="Pay runs" value={s.runs} hint={`${s.employees} employee(s)`} />
              <Kpi label="Gross pay" value={s.gross} currency={s.currency} />
              <Kpi label="Withholding" value={s.withholding} currency={s.currency} />
              <Kpi
                label="Employer contributions"
                value={s.employerContributions}
                currency={s.currency}
              />
              <Kpi
                label="Total employer cost"
                value={s.employerCost}
                currency={s.currency}
                hint="gross + employer contributions"
              />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By month</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Month</TableHead>
                        <TableHead>Runs</TableHead>
                        <TableHead className="text-right">Gross</TableHead>
                        <TableHead className="text-right">Withholding</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.byMonth.map((m) => (
                        <TableRow key={m.month} data-testid="payroll-month-row">
                          <TableCell>{m.month}</TableCell>
                          <TableCell>{m.runs}</TableCell>
                          <TableCell>
                            <Amount value={m.gross} currency={s.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={m.withholding} currency={s.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={m.net} currency={s.currency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By department</CardTitle>
                  <CardDescription>Employer cost = gross + employer contributions.</CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Department</TableHead>
                        <TableHead>Employees</TableHead>
                        <TableHead className="text-right">Gross</TableHead>
                        <TableHead className="text-right">Employer cost</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.byDepartment.map((d) => (
                        <TableRow
                          key={d.departmentId ?? 'none'}
                          data-testid="payroll-department-row"
                        >
                          <TableCell>{d.department}</TableCell>
                          <TableCell>{d.employees}</TableCell>
                          <TableCell>
                            <Amount value={d.gross} currency={s.currency} />
                          </TableCell>
                          <TableCell>
                            <Amount value={d.employerCost} currency={s.currency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">By pay item</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Item</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {s.byItem.map((i) => (
                        <TableRow key={`${i.code}-${i.description}`}>
                          <TableCell>
                            <div>{i.description}</div>
                            <div className="font-mono text-xs text-muted-foreground">{i.code}</div>
                          </TableCell>
                          <TableCell>
                            {ITEM_TYPE_LABEL[i.type as keyof typeof ITEM_TYPE_LABEL] ?? i.type}
                          </TableCell>
                          <TableCell>
                            <Amount value={i.amount} currency={s.currency} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
              <QueryState query={withholding}>
                {(w) => (
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm">Withholding tax remittance</CardTitle>
                      <CardDescription>
                        Due to the tax authority by month of period end, from posted runs.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="p-0">
                      <Table>
                        <TableHeader>
                          <TableRow className="hover:bg-transparent">
                            <TableHead>Month</TableHead>
                            <TableHead>Employees</TableHead>
                            <TableHead className="text-right">Taxable</TableHead>
                            <TableHead className="text-right">Withheld</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {w.rows.map((r) => (
                            <TableRow key={r.month} data-testid="withholding-row">
                              <TableCell>
                                <div>{r.month}</div>
                                <div className="font-mono text-[11px] text-muted-foreground">
                                  {r.runs.join(', ')}
                                </div>
                              </TableCell>
                              <TableCell>{r.employees}</TableCell>
                              <TableCell>
                                <Amount value={r.taxable} currency={w.currency} />
                              </TableCell>
                              <TableCell>
                                <Amount value={r.withholding} currency={w.currency} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                        <TableFooter>
                          <TableRow>
                            <TableCell colSpan={3}>Total</TableCell>
                            <TableCell>
                              <Amount value={w.total} currency={w.currency} />
                            </TableCell>
                          </TableRow>
                        </TableFooter>
                      </Table>
                    </CardContent>
                  </Card>
                )}
              </QueryState>
            </div>
          </>
        )}
      </QueryState>
      <QueryState query={integrity}>
        {(rep) => (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <ShieldCheck className="h-4 w-4" /> Integrity <StatusBadge status={rep.status} />
              </CardTitle>
              <CardDescription>
                The employee payable in the ledger must equal unpaid payroll plus unpaid expense
                claims.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Check</TableHead>
                    <TableHead>Severity</TableHead>
                    <TableHead className="text-right">Findings</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rep.findings.map((f) => (
                    <TableRow key={f.check} data-testid="payroll-integrity-row">
                      <TableCell>
                        <div className="text-sm">{f.title}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">
                          {f.check}
                          {f.detail ? ` - ${f.detail}` : ''}
                        </div>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={f.severity} />
                      </TableCell>
                      <TableCell
                        className={`text-right ${f.count ? 'text-destructive' : 'text-positive'}`}
                      >
                        {f.count}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        )}
      </QueryState>
    </>
  );
}
