# Accounting dimensions

Source: `apps/api/src/modules/accounting/dimensions/`.

## Dimensions

One table `dimensions` with `dimension_type` `DEPARTMENT`, `COST_CENTER`,
`PROJECT` (hierarchical, dated, with a manager). Journal lines, document lines,
budget lines and expense-claim lines carry typed columns `department_id`,
`cost_center_id`, `project_id` (`dimensionColumns()`); the branch is a fourth,
line-level dimension (`branch_id`).

`DimensionsService.validateRefs(tx, companyId, lines, asOf)` runs inside every
writing transaction: the referenced dimension must exist in the company, be
`ACTIVE`, have the type the column implies and (projects) be open on the date.

Reports accept dimension filters (`departmentId`, `costCenterId`, `projectId`,
`branchId`) on the ledger, trial balance and income statement.

Adding a new dimension type = add it to `DIMENSION_TYPES`, extend
`dimensionColumns()` (a migration adds the column to every line table) and
`DIMENSION_FIELDS`; validation and rules pick it up automatically.

## Dimension rules

Table `dimension_rules`: "accounts in scope must carry dimension X".

| Scope          | Matches                                    |
| -------------- | ------------------------------------------ |
| `ACCOUNT`      | one account                                |
| `ACCOUNT_TYPE` | every account of a type (e.g. `EXPENSE`)   |
| `CODE_PREFIX`  | accounts whose code starts with the prefix |

Examples: "6100 Salaries requires a department", "Project revenue (42\*)
requires a project".

Enforcement: `DimensionRulesService.assertLines` runs in
`AccountingPostingService` for **both** posting paths (manual documents and
module events) before any ledger row is written -> `DIMENSION_REQUIRED` with
the violating line, rule and dimension. Drafts can be saved without the
dimension; posting cannot proceed. Rules added after posting show up in the
integrity checker (`DIMENSION_RULE`). The matcher
(`dimension-rules.logic.ts`) is pure and unit tested.

## API

```
GET/POST /api/v1/dimensions, PATCH /api/v1/dimensions/:id           dimension.view / dimension.manage
GET      /api/v1/accounting/dimension-rules                          dimension.view
POST     /api/v1/accounting/dimension-rules                          posting-rule.manage
PATCH    /api/v1/accounting/dimension-rules/:id                      posting-rule.manage (rename / enable / disable)
```

UI: `/budgeting/dimensions` (dimensions), `/accounting/posting-rules` ->
"Dimension rules" tab.
