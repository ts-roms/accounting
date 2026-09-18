# Payroll & employee expenses - architecture

Prompt #11 adds the last operational subledger: employees and pay items as
master data, pay runs that calculate payslips, post one payroll journal and
pay the net from a bank account, reimbursement of posted expense claims
through payroll, payroll reports, a financial-close check, a treasury
forecast source, pay-date reminders and integrity checks. Everything is
company-scoped and the payslips (plus posted expense claims) are the
subledger of the `EMPLOYEE_PAYABLE` account.

## Module layout (`apps/api/src/modules/payroll`)

| File                         | Responsibility                                                                                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payroll.logic.ts`           | Pure engine: progressive brackets, capped percent-of-gross, `buildPayslip` (earnings -> gross / taxable, deductions, employer cost, withholding, reimbursements, net), effective windows, period ends. |
| `employees.service.ts`       | Employee master (numbered from the `EMP` rule), field-level history, effective-dated pay item assignments, one user per employee.                                                                      |
| `payroll-config.service.ts`  | Pay items (`pay_items`) and `payroll_settings`.                                                                                                                                                        |
| `pay-runs.service.ts`        | Pay runs: create, inputs, calculate, submit / approve / reopen, post, pay, reverse, delete.                                                                                                            |
| `payroll-reports.service.ts` | Summary (by month / department / item), withholding remittance, employee YTD, integrity checks.                                                                                                        |
| `payroll.job.ts`             | `payroll-reminders` daily job (H8 registry).                                                                                                                                                           |
| `payroll.controller.ts`      | `/employees/*` and `/payroll/*` (see `docs/api.md`).                                                                                                                                                   |

`PayrollModule` imports `BudgetingModule` for `ExpenseClaimsService` (the
claim hooks `postedClaimsForUsers` / `settleThroughPayroll`) and
`BankingModule` for the paying bank account; nothing imports payroll except
`AppModule` (treasury's forecast and the financial close read the tables).

## Data

- `employees` - number, optional `userId` (unique per company), names,
  employment type, `payFrequency`, `baseSalary` per period, hire /
  termination dates, status, branch and dimensions, TIN, payment method and
  bank details.
- `pay_items` - code, `type` (`EARNING`, `DEDUCTION`, `WITHHOLDING_TAX`,
  `EMPLOYER_CONTRIBUTION`), `calculation` (`BASE_SALARY`, `FIXED`,
  `PERCENT_OF_GROSS` + `maxBase`, `BRACKET`), `taxable`, `appliesToAll`,
  optional expense / liability accounts, sort order, status.
- `employee_pay_items` - recurring assignments with amount / rate override
  and an effective window.
- `payroll_settings` - default frequency, payroll bank account, whether
  posted claims are reimbursed through runs, reminder days.
- `pay_runs` (`PYR`) - frequency, period, pay date, status
  `DRAFT -> CALCULATED -> APPROVED -> POSTED -> PAID` (or `REVERSED`),
  totals, bank account, the three journals, who did what and when.
- `pay_run_inputs` - one-off amounts (overtime, bonus, unpaid leave).
- `payslips` + `payslip_lines` - one payslip per employee with a snapshot of
  the employee (name, dimensions, bank details) and every line with its
  resolved account (`accountId`, plus `offsetAccountId` for employer
  contributions), source (`BASE / COMPANY / ASSIGNMENT / INPUT / CLAIM`) and
  the reimbursed `expenseClaimId`.
- `accounting_policies.close_require_payroll_posted` - whether the
  `PAYROLL_POSTED` close check blocks.

## Accounting decisions

- **Policy is data.** No rate, bracket, contribution cap or account lives in
  code. A pay item without its own account posts to the company mappings:
  earnings -> `SALARY_EXPENSE`, employer contributions ->
  `EMPLOYER_CONTRIBUTION_EXPENSE` / `STATUTORY_CONTRIBUTIONS_PAYABLE`,
  deductions -> `STATUTORY_CONTRIBUTIONS_PAYABLE` (give loans their own
  liability account), withholding -> `WITHHOLDING_TAX_PAYABLE`.
- **Who applies.** For a run: active employees on the run's frequency whose
  employment covers the period. Items: the base salary item always; company
  items (`appliesToAll`); assignments active in the period; run inputs. An
  input replaces the recurring amount of the same item for that employee;
  several inputs of one item add up.
- **Arithmetic** (`buildPayslip`): earnings set gross and taxable pay
  (non-taxable earnings excluded); percent-of-gross deductions are pre-tax
  (statutory), fixed deductions (loans) are not; withholding brackets apply
  to taxable pay less pre-tax deductions; employer contributions are
  computed from gross but never touch the employee's net; reimbursed claims
  are neither gross nor taxable. Net = gross - deductions - withholding +
  reimbursements; a negative net refuses the calculation.
- **Approval is four-eyes.** `payroll.approve` is delegable
  (`AuthorityService.assert` with the net as amount), SoD-checked against
  the preparer (`payroll.manage` vs `payroll.approve`, WARN by default) and
  workflow-gated (`PAY_RUN` document type) when a workflow is configured;
  `submit` opens the request and notifies approvers. Inputs are locked
  after approval; `reopen` withdraws it.
- **One journal per run**, dated on the period end (`PAY_RUN` source,
  permission `payroll.post`): Dr earning accounts and employer expense, Cr
  deduction / withholding / employer liabilities and `EMPLOYEE_PAYABLE` for
  the net owed, aggregated by account and the payslip's branch /
  dimensions. Reimbursed claims add nothing here - their own posting already
  carries the expense and the payable - so the payable credit is net less
  reimbursements.
- **Payment** posts Dr `EMPLOYEE_PAYABLE` / Cr the bank's GL account for the
  full net (`PAY_RUN_PAYMENT`), then `ExpenseClaimsService.settleThroughPayroll`
  marks the reimbursed claims PAID with that journal; a claim paid or
  cancelled since the calculation makes the payment refuse (recalculate).
- **Reversal** mirrors the payroll journal for unpaid runs only; a paid
  run's bank payment is a separate document and stays. Reversed runs free
  their period for a new run (periods may not otherwise overlap per
  frequency).
- **Foreign-currency pay.** An employee has a pay currency (`currency`,
  default the base); a pay run has one too and takes only employees paid in
  it (periods may not overlap per frequency _and_ currency). Base salary,
  assignment amounts and run inputs are in the pay currency; pay items are
  company policy written in base - fixed amounts, contribution caps and
  bracket tables convert at the run's rate (the period-end rate, override
  allowed), brackets being read on the base-converted taxable pay and the tax
  converted back. Every payslip line carries `baseAmount`; payslip and run
  base figures are sums of those, so the payroll journal (base) ties to the
  run's `netTotalBase` exactly. Payment: cash at the payment rate from a bank
  in the pay currency (foreign amount on the bank line) or in base; the
  payable is relieved at the run's base and the difference is realized FX
  (`paidBase` records what left). Foreign-currency runs do not reimburse
  expense claims (claims are base documents). Reports, the forecast and the
  `EMPLOYEE_PAYABLE` integrity check read the base figures.
- **Views are restricted.** `employee.view` and `payroll.view` are not in
  the viewer bundle (like `audit.view`); accounting, finance and audit roles
  hold them explicitly.

## Integrations

- Financial close: automatic task `PAYROLL_POSTED` (no run whose period ends
  in the fiscal period is still draft / calculated / approved), gated by
  `closeRequirePayrollPosted`.
- Treasury: calculated / approved / posted-unpaid runs are `PAYROLL`
  forecast outflows on their pay date (payroll bank account when known); paid
  runs count towards the average daily outflow used for the liquidity floor.
- Notifications / events: `PAY_RUN_APPROVAL_REQUIRED`, `PAY_RUN_DUE`;
  outbound `pay_run.approved / posted / paid / reversed`; API scope
  `payroll:read`.

## Web (`apps/web`)

Payroll section: `/payroll/runs[/:id]`, `/payroll/payslips/:id`,
`/payroll/employees[/:id]`, `/payroll/pay-items` (items + settings),
`/payroll/reports`. Approval and posting use `OperationDialog`; the run
lifecycle is a `StepTimeline`.
