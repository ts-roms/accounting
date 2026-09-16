# AP aging, cash requirements and DPO

- **Aging** (`GET /reports/ap-aging?asOf&partyId&branchId`) buckets open
  posted bills by days past due using `ap_settings.agingBuckets`
  (contiguous, last bucket open-ended; default current / 1-30 / 31-60 /
  61-90 / 91-120 / 120+). Balances age in base currency at the document
  rate so the total ties to the control account; unapplied credits (credit
  notes, unallocated payments) are shown separately.
- **Cash requirements** (`GET /cash-requirements`) bands the same open
  bills by due date into overdue, the configured horizons (default 7 / 30 /
  60 days) and beyond, with the discounts obtainable in each band. Held
  bills are listed but excluded from the totals.
- **DPO** = open payables ÷ (posted purchases over `dpoWindowDays` ÷
  window), countback method; shown with a six-month trend on the dashboard.
- **Discount capture rate** = discounts taken ÷ discounts offered on bills
  dated in the window whose discount date has passed.
