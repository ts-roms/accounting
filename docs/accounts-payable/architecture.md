# Accounts payable & procure-to-pay - architecture

Prompt #7 extends the AP subledger (`modules/payables`) into an enterprise
procure-to-pay platform. Nothing here bypasses the accounting engine: every
ledger effect goes through `AccountingPostingService.postEvent` with its own
source identity, accounts resolve through `AccountsService.resolveMapped`,
and the AP subledger is always derived from posted documents.

```text
 Vendor master ─▶ Purchase order ─▶ Goods receipt ─▶ Bill ─▶ Payment run ─▶ Vendor payment
 (groups, holds,   submit/approve   Dr inventory     submit/approve/post   propose/approve   Dr AP / Cr cash
  bank accounts)   vendor gate      Cr GRNI          due date + discount   execute           Cr purchase discount
                                                     payment hold                            remittance file
                                    ─────────────── GRNI analysis ─────────────▶ AP accrual (Dr expense / Cr accrued)
```

## Modules and files

| Concern                   | Where                                                                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Policy (settings, groups) | `ap-config.service.ts` - `ap_settings`, `vendor_groups`; payment terms shared with AR                                              |
| Vendor master             | `vendors.service.ts` - contacts, addresses, bank accounts, profile, onboarding, holds                                              |
| Bills                     | `bills.service.ts` - submit / approve / post / void, payment terms, discount window, events                                        |
| Payment holds             | `bill-holds.service.ts` - `bill_holds` + `vendor_bills.on_hold` mirror                                                             |
| Vendor payments           | `vendor-payments.service.ts` - `createInTx` / `postInTx`, submit / approve, discount capture                                       |
| Payment runs              | `payment-runs.service.ts` - propose (pure `proposePaymentRun`), approve, execute, remittance                                       |
| Accruals / GRNI           | `ap-accruals.service.ts` - received-not-billed analysis, period-end accrual + auto-reversal                                        |
| Reporting                 | `ap-reports.service.ts` (aging, statement, reconciliation), `ap-dashboard.service.ts`                                              |
| Integrity                 | `ap-integrity.service.ts` - 19 read-only checks                                                                                    |
| Daily sweep               | `payables.job.ts` - due-soon, discount-lapsing and aged-GRNI alerts                                                                |
| Pure rules                | `payables.logic.ts` (+ spec) - discount windows, run proposal, cash requirements, DPO, GRNI value, remittance CSV                  |
| Purchase orders           | `modules/orders` - `submit / approve / reject` transitions, vendor gate, `purchase_order.*` events                                 |
| Integrations              | `sync/importers/purchase-orders.importer.ts`; events + notifications in `packages/types/src/integrations.ts`                       |
| Web                       | `apps/web/components/payables/*`, routes `/payables/*`, AP panels injected into `components/subledger/*` where `cfg.side === 'AP'` |

## Invariants

- **AP subledger = GL control.** `ApReportsService.reconciliation` =
  bills + debit notes − credit notes − payments (control amount, which
  already includes discounts taken and realized FX) + refunds + FX
  adjustments. `SubledgerBalancesService` reuses it; the integrity checker
  and the e2e suite assert `difference = 0` after every step.
- **Discounts are allocations.** An early-payment discount settles part of a
  bill without cash: a `vendor_payment_allocations` row with
  `discount_payment_id` (third allocation source, exactly one of payment /
  credit note / discount). The payment posts `Cr PURCHASE_DISCOUNT`; the bill
  tracks `discount_taken_amount`; voiding the payment releases the discount.
- **Holds never touch the ledger.** A payment hold keeps the liability
  posted and only blocks settlement (`lockTargets` marks the bill on hold;
  runs skip it; `HELD_BILL_SETTLED` integrity check).
- **Vendor state gates documents.** `VendorsService.assertUsable` rejects
  purchase orders, bills and payments for vendors that are `ON_HOLD`,
  `BLOCKED`, `INACTIVE` or `PENDING` under `requireVendorApproval`.
- **Runs never post.** A payment run only selects; execution calls
  `VendorPaymentsService.createInTx` + `postInTx({ approvedUpstream: true })`
  per vendor, each in its own transaction, so one failure never blocks the
  other vendors.
- **Accruals reverse themselves.** Posting an accrual posts the accrual
  journal and the reversal journal (dated on the reversal date) in one
  transaction; the accrual entry is marked `REVERSED` immediately.
- **Policy is data.** Terms, groups, approval thresholds, duplicate handling,
  aging buckets, horizons and warning windows live in tables, never in code.

## Source identities

`AP_DOCUMENT`, `AP_DOCUMENT_VOID`, `AP_PAYMENT`, `AP_PAYMENT_VOID`,
`AP_PAYMENT_ALLOCATION` (realized FX), `GOODS_RECEIPT`, `AP_ACCRUAL`,
`AP_ACCRUAL_REVERSAL`.

## Account mappings

`ACCOUNTS_PAYABLE` (required), `GOODS_RECEIVED_NOT_INVOICED`,
`PURCHASE_PRICE_VARIANCE`, `PURCHASE_DISCOUNT` (seed: 5400),
`ACCRUED_EXPENSE` (seed: 2120).
