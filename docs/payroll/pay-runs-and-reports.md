# Pay runs, payslips and reports

## Lifecycle

```
POST /payroll/runs { payFrequency, periodStart, periodEnd, payDate, description?, bankAccountId? }   payroll.manage   DRAFT
PUT  /payroll/runs/:id/inputs { inputs[{ employeeId, payItemId, amount, note? }] }                   payroll.manage   back to DRAFT
POST /payroll/runs/:id/calculate        payroll.manage    payslips built                              -> CALCULATED
POST /payroll/runs/:id/submit           payroll.manage    workflow opened, approvers notified
POST /payroll/runs/:id/approve          payroll.approve   four-eyes (delegable, SoD, workflow)        -> APPROVED
POST /payroll/runs/:id/reopen { reason } payroll.approve                                             -> CALCULATED
POST /payroll/runs/:id/post             payroll.post      one journal on the period end               -> POSTED
POST /payroll/runs/:id/pay { bankAccountId?, paymentDate?, reference? }   payroll.post   Dr payable / Cr bank -> PAID
POST /payroll/runs/:id/reverse { reason, reversalDate? }   payroll.post   unpaid runs only            -> REVERSED
DELETE /payroll/runs/:id                payroll.manage    draft / calculated only
```

`GET /payroll/runs/:id` returns the run with its `payslips[]` (each with
`lines[]`) and `inputs[]`; `GET /payroll/payslips/:id` one payslip with its
run.

## Worked example (the seed, ACME, monthly)

Pay items: `BASIC` (base salary), `ALLOW-TRANSPO` 2,000 non-taxable,
`OT` (input), `SSS-EE` 4.5% of gross capped at 30,000, `PHIC-EE` 2.5% capped
at 100,000, `HDMF-EE` 200, `LOAN` (assignment), employer `SSS-ER` 9.5% /
`PHIC-ER` 2.5% / `HDMF-ER` 200, `WTAX` progressive brackets (0% to 20,833;
15% to 33,333; 1,875 + 20% to 66,667; ...).

Ben Lim, June 2026 (28,000 base, 2,500 overtime input):

| Line                                   | Amount                           |
| -------------------------------------- | -------------------------------- |
| Basic salary                           | 28,000.00                        |
| Overtime - 10 hours ...                | 2,500.00                         |
| Transportation (non-tax)               | 2,000.00                         |
| Gross / taxable earnings               | 32,500.00 / 30,500.00            |
| SSS-EE 4.5% x 30,000 (capped)          | 1,350.00 (pre-tax)               |
| PhilHealth 2.5% x 32,500               | 812.50 (pre-tax)                 |
| Pag-IBIG                               | 200.00                           |
| Taxable pay                            | 28,337.50                        |
| Withholding (28,337.50 - 20,833) x 15% | 1,125.675                        |
| Net                                    | 29,011.825                       |
| Employer contributions                 | 3,862.50 (expense, not deducted) |

The June run (four employees) posts one journal on 2026-06-30 and is paid
from `BDO-MAIN` the same day; August is approved and awaits posting with a
pay date of 2026-09-05.

## Reports (`payroll.view`)

- `GET /payroll/reports/summary?from&to` - posted / paid runs whose period
  ends in the window: totals (gross, withholding, deductions, employer
  contributions, reimbursements, net, employer cost), `byDepartment`,
  `byItem`, `byMonth`.
- `GET /payroll/reports/withholding?from&to` - withholding tax due by month
  of period end with the runs that make it up.
- `GET /employees/:id/ytd?year` - one employee's year-to-date totals and
  lines by item.
- `GET /payroll/integrity?asOf` - see `integrity.md`.

## Expense claims through payroll

When `payroll_settings.reimburseExpenseClaims` is on, calculating a run adds
a `CLAIM` line (source `CLAIM`, non-taxable, not part of gross) to the
payslip of every employee linked to a user with POSTED expense claims. The
payroll journal ignores those lines (the claim already posted Dr expense /
Cr `EMPLOYEE_PAYABLE`); the payment debits the payable for the whole net
and marks the claims PAID with the payment journal. Paying a claim on its
own screen after the run was calculated makes the run's payment refuse until
it is recalculated.
