# Lease accounting - architecture

Prompt #13 adds lessee accounting (IFRS 16 / ASC 842 single model) beside the
fixed-asset register, plus two register extensions (asset split, register
rollforward). A lease is captured as data; everything in the ledger is an
explicit posting decision guarded by `lease.post`. Everything is
company-scoped.

## Module layout (`apps/api/src/modules/leases`)

| File                       | Responsibility                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `lease.logic.ts`           | Pure: month arithmetic, payment placement, present value, classification, `buildLeaseSchedule` (with the rounding plug), maturity buckets. |
| `leases-config.service.ts` | `lease_settings` (thresholds, default rate, automatic runs) and account resolution (lease override -> company mapping).                    |
| `leases.service.ts`        | Contracts (CRUD, preview), commencement, instalment payment, remeasurement, termination, completion, due-payment lookup.                   |
| `lease-runs.service.ts`    | Runs: preview / create / reverse, the scheduler entry point (`runAllCompanies`).                                                           |
| `lease-reports.service.ts` | Register, maturity analysis, dashboard, integrity (see `integrity.md`).                                                                    |
| `leases.job.ts`            | `lease-runs` job (H8 registry): automatic runs where enabled, reminders otherwise, instalment reminders.                                   |
| `leases.controller.ts`     | `/leases/*` (see `docs/api.md`).                                                                                                           |

`LeasesModule` imports `AccountingModule` (posting gateway, accounts,
numbering, dimensions), `BankingModule` (bank accounts for payments),
`JobsModule` and `RbacModule`. Fixed-asset extensions live in
`modules/fixed-assets` (`FixedAssetsService.split`, `AssetReportsService`).

## Data

- `lease_settings` - `shortTermThresholdMonths` (default 12),
  `lowValueThreshold` (0 disables), `autoPostRuns`, `defaultDiscountRate`.
- `leases` - the contract (lessor, category, commencement, term, payment,
  frequency `MONTHLY / QUARTERLY / ANNUAL`, timing `IN_ADVANCE / IN_ARREARS`,
  annual rate, initial direct costs, incentives, underlying asset value,
  classification override), the carrying figures (`initialLiability`,
  `liabilityBalance`, `rouCost`, `rouAccumulatedDepreciation`), optional
  account overrides, usual bank account, dimensions, the commencement /
  termination journals, `status` (`DRAFT -> ACTIVE -> COMPLETED |
TERMINATED`) and `classification` (`FINANCE`, `SHORT_TERM`, `LOW_VALUE`).
- `lease_schedule_lines` - one line per month: opening liability, interest,
  depreciation, payment (+ date), closing liability, `status` (`PENDING ->
POSTED`, `CANCELLED` when superseded), the run and journal that posted it,
  and the payment (date, bank account, journal) once paid.
- `lease_runs` - one ADJUSTING journal per run (`LRN-` numbers): period end,
  interest / depreciation totals, status `POSTED / REVERSED`.
- `lease_events` - every change to the carrying amounts (commencement,
  interest, depreciation, payment, remeasurement, termination) with the
  signed liability / right-of-use effect and the journal. Integrity and the
  register rollforward replay these.

Accounts resolve lease override -> mapping: `RIGHT_OF_USE_ASSET`,
`ROU_ACCUMULATED_DEPRECIATION`, `LEASE_LIABILITY`, `LEASE_INTEREST_EXPENSE`,
`DEPRECIATION_EXPENSE`, `LEASE_EXPENSE` (exempt leases); termination uses
`GAIN_LOSS_ON_DISPOSAL`, initial direct costs default to
`FIXED_ASSET_CLEARING`. Never by id.

## Engine (`lease.logic.ts`)

- Monthly compounding at `annualRate / 12`; the liability is the present
  value of the payments not yet made at commencement (in advance: month 0
  undiscounted; in arrears: end of each period).
- Right-of-use cost = liability + initial direct costs - incentives,
  depreciated straight line over the term (`Money.allocate`, remainder on
  the earliest months).
- One line per month; interest accretes on the balance carried into the month
  (after an in-advance payment); payments fall on the months the frequency
  dictates. Each interest figure is rounded to four places; the residual is
  plugged into the last interest-bearing month so the liability ends at
  exactly zero without touching a payment.
- `classify`: override > term <= short-term threshold > underlying asset
  value <= low-value threshold > `FINANCE`.

## Accounting decisions

- **Commencement** (`LEASE_COMMENCEMENT`, dated the posting date): Dr
  right-of-use asset / Cr lease liability at present value; initial direct
  costs Cr and incentives Dr the clearing account (or the account given).
  Exempt leases only get their payment schedule.
- **Runs** (`LEASE_RUN`, ADJUSTING, dated `periodEnd`): every pending month
  of an active finance lease ending on or before the period end, one pair of
  lines per lease: Dr lease interest expense / Cr liability, Dr depreciation
  expense / Cr ROU accumulated depreciation. Reversal (`reverseEntry`)
  reopens the months and restores the register; runs reverse latest first
  and never once a lease has been terminated.
- **Instalments** (`LEASE_PAYMENT`, source identity = the schedule line):
  Dr lease liability / Cr bank for finance leases, Dr lease expense / Cr
  bank for exempt leases. Payments go in schedule order; an in-arrears
  instalment needs its month's run first (the interest it settles must be on
  the liability). The register liability is therefore commencement PV +
  posted interest - paid instalments, and may differ from the schedule
  while an instalment is early or late (integrity reconciles the two).
- **Remeasurement** (`LEASE_REMEASUREMENT`, source identity = the event):
  from the start of a pending month that opens a payment period, the
  remaining payments (new term / payment / rate) are re-discounted; the
  change in the liability is Dr / Cr right-of-use asset, pending months are
  cancelled and rebuilt, and the remaining carrying amount depreciates over
  the remaining term. A reduction below the carrying amount is refused.
- **Termination** (`LEASE_TERMINATION`): the whole remaining liability, the
  ROU cost and its accumulated depreciation leave the books; the difference
  is a gain (liability released exceeds the carrying amount) or loss on
  `GAIN_LOSS_ON_DISPOSAL`. Pending months are cancelled. Any instalment
  already posted but unpaid is released with the liability - settle it first
  if it is still owed.
- **Completion** is derived: every month posted and every instalment paid.
- Journal lines carry the lease's branch and dimensions; validated by the
  gateway like any other posting.

## Integrations

- Financial close: `LEASE_RUNS_POSTED` (policy
  `accounting_policies.close_require_lease_runs`) fails while a finance
  lease has pending months ending in the period.
- Treasury: unpaid instalments are `LEASE_PAYMENTS` forecast flows on their
  payment date (the lease's usual bank account when known); paid instalments
  join the burn-rate window.
- Register rollforward: right-of-use assets appear as their own class (see
  `fixed-assets.md`).
- Events: `lease.commenced`, `lease.run_posted`, `lease.run_reversed`,
  `lease.terminated`; notifications `LEASE_RUN_DUE`, `LEASE_PAYMENT_DUE`;
  API-key scope `lease:read`.

## Web (`apps/web`)

`/leases` (register list, create / edit with schedule preview),
`/leases/:id` (carrying amounts, schedule, history, commence / pay /
remeasure / terminate), `/leases/runs` (runs with preview, reversal, policy
card), `/leases/reports` (register, maturity, integrity) under Finance >
Leases; `/fixed-assets/rollforward` and the asset Split action under Fixed
Assets.
