# Collections and dunning

## Collection cases

One open case per customer (`collection_cases`, numbered `COL-`):

```text
NEW ─contact─▶ CONTACTED ─promise─▶ PROMISED ─▶ ... ─escalate─▶ ESCALATED   (dispute opened) DISPUTED
                        └──────────── no overdue balance left ──▶ COLLECTED   manual ──▶ CLOSED
```

Cases are opened by hand (`POST /collections`), automatically when an
invoice is `ar_settings.autoCaseDaysOverdue` days overdue, or by the dunning
engine. Views add the customer's outstanding / overdue balance, days
overdue and the open promise - all derived. Activities
(`collection_activities`: call, email, meeting, letter, note, promise,
escalation, dunning, credit hold, dispute, status change) form the timeline;
contact-type activities update `lastContactAt` and move NEW to CONTACTED.

Workspace actions (`/receivables/collections/:id`): record contact, promise
to pay, escalate, credit hold (needs `customer.credit-manage`), assign
collector, view invoices, close.

## Promises to pay

`promises_to_pay`: amount, date, invoices, collector, notes.
`evaluatePromise` (pure) during the sweep: KEPT when receipts posted between
creation and the promise date cover the amount, BROKEN once the date has
passed otherwise, PENDING until then; CANCELLED is manual. Broken promises
emit `collection.promise_broken`, notify the collector (`PROMISE_BROKEN`)
and log a note on the case.

## Dunning

`dunning_policies` are ordered steps `{ daysOverdue, action, label }` with
actions `REMINDER`, `ESCALATION`, `CREDIT_HOLD` and a `minimumAmount`. The
policy that applies to an invoice is the customer group's policy, else
`ar_settings.defaultDunningPolicyId`, else nothing - **no policy, no
automatic action**.

The sweep (`ReceivablesSweepJob`, daily; `POST /collections/run-sweep
{ asOf? }` on demand):

1. `invoice.overdue` event (deduped per invoice) and `INVOICE_OVERDUE`
   notification (throttled) for every overdue posted invoice / debit note;
2. auto-opens a case when the auto-case threshold is reached;
3. runs every dunning step whose `daysOverdue` has been reached and has not
   run yet (`collection_activities` unique on invoice + policy + step keeps
   it idempotent); `ESCALATION` escalates the case, `CREDIT_HOLD` places the
   customer on hold through `CreditService.setHold` (source `DUNNING`);
   collectors are notified per step (`COLLECTION_ACTION_REQUIRED`);
   invoices with an open dispute are skipped;
4. evaluates pending promises;
5. marks cases `COLLECTED` when the customer has no overdue balance.

Seeded policy "Standard dunning": due date reminder, 7-day reminder, 30-day
escalation, 120-day credit hold, minimum 1,000.

## API

```text
GET/POST   /api/v1/collections                 filters: customerId, collectorId, status, openOnly, search
GET/PATCH  /api/v1/collections/:id
POST       /api/v1/collections/:id/activities | credit-hold
POST       /api/v1/collections/run-sweep
GET/POST   /api/v1/promises-to-pay ; PATCH /:id
GET/POST   /api/v1/dunning-policies ; PATCH /:id
```

Permissions: `collection.view`, `collection.manage`, `customer.credit-manage`
(holds), `ar-settings.manage` (policies).
