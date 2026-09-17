# Payroll integrity

`GET /payroll/integrity?asOf` (`payroll.view`), company-scoped, same shape as
the other integrity reports.

| Check                        | Severity | Assertion                                                                                                                                                                                                           |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMPLOYEE_PAYABLE_VS_LEDGER` | CRITICAL | The `EMPLOYEE_PAYABLE` credit balance at `asOf` equals net pay (less reimbursed claims) of runs posted by then and not paid by then, plus posted-unpaid expense claims.                                             |
| `PAYSLIP_TOTALS`             | CRITICAL | For approved / posted / paid runs: earning lines = gross, deduction lines = deductions, withholding lines = withholding, claim lines = reimbursements, and net = gross - deductions - withholding + reimbursements. |
| `PAY_RUN_WITHOUT_JOURNAL`    | CRITICAL | Posted / paid / reversed runs carry their posting (and payment / reversal) journals.                                                                                                                                |
| `PAY_RUNS_UNPAID`            | WARNING  | No calculated / approved / posted run is past its pay date without payment.                                                                                                                                         |

The Payroll Reports page shows the report under the cost and withholding
tables. Opening balances or manual journals on the employee payable account
surface as an `EMPLOYEE_PAYABLE_VS_LEDGER` variance by design.
