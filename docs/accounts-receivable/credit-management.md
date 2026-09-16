# Credit management

## Position and summary

`CreditService.position` computes, from live data inside the caller's
transaction:

```text
netBalance        posted open invoices + debit notes - credit notes - unapplied receipts (CustomersService.balances)
pendingDocuments  unposted (draft / submitted / approved) invoices and debit notes
openOrders        approved / confirmed sales orders not fully invoiced
overdue           posted balance past due today
oldestOverdueDays days the oldest overdue document is past due
creditHold        from customer_credit_profiles
```

`summarizeCredit` (pure) derives:

```text
Credit used       = netBalance + pendingDocuments + openOrders
Available credit  = creditLimit - creditUsed     (null when no limit)
Status            ON_HOLD > OVER_LIMIT > WARNING (>90% of limit or any overdue) > GOOD
```

`GET /customers/:id/credit` returns the summary plus the profile (hold,
reason, risk rating, review date).

## Credit rules (data, not code)

`credit_rules` are evaluated by priority for a scope (`SALES_ORDER` or
`INVOICE`) when a document is submitted or approved, provided the matching
switch in `ar_settings` is on (`creditCheckOnSalesOrder`,
`creditCheckOnInvoice`).

| Trigger               | Fires when                                                       | Threshold field    |
| --------------------- | ---------------------------------------------------------------- | ------------------ |
| `EXPOSURE_OVER_LIMIT` | credit used + this document > limit x (1 + thresholdPercent/100) | `thresholdPercent` |
| `OVERDUE_BALANCE`     | overdue > thresholdAmount                                        | `thresholdAmount`  |
| `DAYS_OVERDUE`        | oldest overdue document older than thresholdDays                 | `thresholdDays`    |
| `CREDIT_HOLD`         | the customer is on hold                                          | -                  |
| `NO_CREDIT_LIMIT`     | the customer has no limit                                        | -                  |

Actions: `WARN` (finding recorded / returned as a warning),
`REQUIRE_APPROVAL` (the document must be approved by a holder of the approve
permission - natively or by delegation), `BLOCK` (submit / approve refused
with `CREDIT_CHECK_FAILED`). The worst action among the fired rules wins.
Rules may be restricted to one customer group.

Regardless of rules, a customer on **credit hold** is always blocked
(`CREDIT_HOLD`) - a hold is an explicit decision by someone with
`customer.credit-manage`.

Sales orders store the outcome on `orders.credit_check` (findings, summary,
who / when) so approvers see why an order was routed to them; invoices return
findings as `warnings`.

Example seeded policy:

```text
SALES_ORDER  EXPOSURE_OVER_LIMIT 0%   -> REQUIRE_APPROVAL
SALES_ORDER  OVERDUE_BALANCE > 250k   -> BLOCK
SALES_ORDER  DAYS_OVERDUE > 90        -> REQUIRE_APPROVAL
INVOICE      EXPOSURE_OVER_LIMIT 0%   -> WARN
INVOICE      NO_CREDIT_LIMIT          -> WARN
```

## Credit holds

`POST /customers/:id/credit-hold { hold, reason }` (or from a collection
case) updates `customer_credit_profiles`, writes an audit row
(`CREDIT_HOLD_CHANGED`), enqueues `customer.credit_hold` /
`customer.credit_released` and notifies holders of
`customer.credit-manage` (`CUSTOMER_CREDIT_HOLD`, throttled per customer).
Dunning policies can apply a hold automatically (`creditHoldSource =
DUNNING`); releasing it is always a manual, permissioned action.

## Over-limit notifications

When a check leaves a customer `OVER_LIMIT`, `CreditService.notifyOverLimit`
enqueues `customer.over_credit_limit` (deduped per customer per day) and
notifies credit managers (`CUSTOMER_OVER_CREDIT_LIMIT`, throttled).

## Payment terms

`payment_terms`: `DUE_ON_RECEIPT`, `NET_DAYS` (+days), `END_OF_MONTH`
(+days), `DAY_OF_NEXT_MONTH` (dayOfMonth). `dueDateFor` in
`receivables.logic.ts` computes the due date; invoices use the document's
term, then the customer's, then the customer's net days.
