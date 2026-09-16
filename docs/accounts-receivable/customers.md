# Customers

## Customer master

`customers` carries the Phase 3 party fields plus the enterprise master data:

| Field                                                         | Notes                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `code`, `name`, `legalName`, `displayName`                    | code unique per company                                                                    |
| `customerType`                                                | `INDIVIDUAL`, `BUSINESS`, `GOVERNMENT`, `OTHER`                                            |
| `customerGroupId`                                             | pricing / credit / terms / dunning defaults ([credit-management.md](credit-management.md)) |
| `paymentTermId`, `paymentTermsDays`                           | named term wins; explicit net days are kept for callers that only know days                |
| `creditLimit`                                                 | the one place the limit lives (credit hold / risk are on the credit profile)               |
| `salespersonId`, `branchId`                                   | ownership and reporting                                                                    |
| `industry`, `region`                                          | free text used for segmentation                                                            |
| `taxIdentificationNumber`, `taxExempt`, `taxRegistrationType` | BIR-oriented fields; tax codes on lines drive the actual tax                               |
| `currency`                                                    | the currency the customer is invoiced in                                                   |

Contacts (`customer_contacts`, one primary) and addresses
(`customer_addresses`, `BILLING` / `SHIPPING`, one default per type) are
separate tables; the head-office address on the customer row remains for
statements.

### Defaults on create

```text
paymentTermId  = input ?? (explicit paymentTermsDays given ? none : group term ?? company default term)
paymentTermsDays = input ?? term.days (NET_DAYS) ?? 30
creditLimit    = input ?? group.defaultCreditLimit
```

### API

```text
GET/POST    /api/v1/customers                 filters: status, customerGroupId, customerType, salespersonId, creditHold, overdueOnly, search
GET/PATCH   /api/v1/customers/:id
GET         /api/v1/customers/:id/credit       credit summary (see credit-management.md)
PATCH       /api/v1/customers/:id/credit       limit / risk / review (customer.credit-manage)
POST        /api/v1/customers/:id/credit-hold  { hold, reason }
POST/PATCH/DELETE /api/v1/customers/:id/contacts[/:contactId]
POST/PATCH/DELETE /api/v1/customers/:id/addresses[/:addressId]
GET         /api/v1/customers/:id/statement?from&to
```

`GET /customers/:id` returns the customer with `balance` (outstanding,
overdue, unapplied credit, net - all derived), `contacts`, `addresses` and
`creditProfile`.

## Customer groups

`customer_groups` hold `paymentTermId`, `defaultCreditLimit`, `taxCodeId`,
`priceDiscountPercent` and `dunningPolicyId`. Groups are referenced by credit
rules (`customerGroupId` restricts a rule) and by the dunning engine (group
policy beats the company default). Seeded groups: Retail, Wholesale,
Corporate, Government, International.

## Audit

Customer creation / update, credit limit changes (`kind: CREDIT_LIMIT_CHANGED`),
credit holds (`kind: CREDIT_HOLD_CHANGED`) and contact / address changes are
audit rows under module `RECEIVABLES`. Webhook events: `customer.created`,
`customer.updated`, `customer.credit_hold`, `customer.credit_released`,
`customer.over_credit_limit`.

## Screens

`/sales/customers` (list with group / term / hold columns) and
`/sales/customers/:id` with the credit card (limit, used, available, status,
hold), the Profile & contacts tab and the Collections tab (cases, promises,
disputes).
