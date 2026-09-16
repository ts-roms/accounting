# Reversals, corrections, accruals, recurring journals and prepayments

Posted journals are never edited. Corrections are new entries that reference
the original, so the chain is explicit and navigable:

```
Original (POSTED -> REVERSED)
   |  reversed_by_id
   v
Reversal (REVERSAL, reversal_of_id = original)
   |
   v
Correcting entry (DRAFT ..., correction_of_id = original)   [journal.correct]
```

## Reversal

`POST /api/v1/journal-entries/:id/reverse { reversalDate, description? }`
(`journal.reverse`) -> `AccountingPostingService.reverseEntry`: mirror lines
(debits <-> credits, foreign amounts mirrored, dimensions kept), journal type
`REVERSAL`, source `JOURNAL_REVERSAL` + original id (so it can only happen
once), reversal date >= entry date and in a postable period. The original stays
in the ledger with status `REVERSED`; audit action `REVERSE`.

## Correction

`POST /api/v1/journal-entries/:id/correct { reversalDate, correctionDate?, reason }`
(`journal.correct`) reverses the original and creates a DRAFT pre-filled with
the original lines, linked through `correction_of_id`; the draft goes through
the normal submit / approve / post controls. Year-end CLOSING entries cannot be
corrected this way (reopen the year instead).

## Accruals with automatic reversal

Give an `ACCRUAL` (or any) journal an `autoReverseDate` after its entry date.
When the entry posts, the engine posts the mirror `REVERSAL` on that date in
the same transaction and under the same authority; the reversal's period must
exist and be postable, otherwise the posting fails as a whole. The document
shows both entries; `related` lists the reversal.

```
2026-03-31  ACCRUAL   Dr 6300 Utilities 12,000 / Cr 2120 Accrued expenses 12,000
2026-04-01  REVERSAL  Dr 2120 12,000 / Cr 6300 12,000           (automatic)
```

## Recurring journals

Table `recurring_journals` (template: lines, `frequency` DAILY / WEEKLY /
MONTHLY / QUARTERLY / ANNUALLY x `interval`, `startDate`, `endDate`,
`maxOccurrences`, `mode`, `autoReverse`, branch, dimensions) and
`recurring_journal_runs` (one row per generated occurrence).

- Occurrences are anchored on the start date (`occurrenceAt`), so a month-end
  template stays on the month end (Jan 31 -> Feb 28 -> Mar 31).
- `POST /api/v1/accounting/recurring-journals/run { asOf?, recurringJournalId? }`
  (`recurring-journal.manage`) and the nightly job generate every occurrence
  due on or before `asOf`. Each template runs in its own transaction; failures
  (missing period, inactive account) are reported in `skipped` without
  blocking the others.
- **DRAFT mode** creates a DRAFT journal per occurrence for the normal
  workflow. **AUTO_POST** posts immediately through `postEvent`; switching a
  template to AUTO_POST requires `journal.post` and records
  `auto_post_approved_by` - automated posting is a deliberate, audited decision.
- `autoReverse` sets the occurrence's `autoReverseDate` to the first day of the
  following month (standing accruals).
- Idempotent: the unique `(template, run_date)` index and the run id as the
  journal's `sourceId` make reruns and concurrent workers safe. The template
  completes itself at its cap / end date; `PAUSE` / `RESUME` are audited.

UI: `/accounting/recurring-journals`.

## Prepayments

Tables `prepayments` and `prepayment_schedules`.

```
Activate:    Dr Prepaid expense (asset)   / Cr Cash, bank or payable      (GENERAL, source PREPAYMENT)
Recognise:   Dr Expense                   / Cr Prepaid expense           (ADJUSTING, source PREPAYMENT_RECOGNITION per instalment)
```

- `POST /api/v1/accounting/prepayments` (`prepayment.manage`) builds a
  straight-line schedule with `Money.allocate` (no lost minor units), one
  instalment per month dated on the month end.
- `POST .../:id/activate` (`prepayment.post`) posts the initial entry when a
  credit account is configured (omit it when an AP bill already debited the
  prepaid account) and starts the schedule.
- `POST .../recognize { asOf?, prepaymentId? }` (`prepayment.post`) and the
  nightly job post every pending instalment on or before `asOf`; the
  prepayment completes when the last one posts and `recognizedAmount` equals
  the amount. Reruns are no-ops.
- `POST .../:id/cancel { reason }`: pending instalments are cancelled; if
  nothing was recognised the initial entry is reversed, otherwise the audit row
  records the remaining balance to clear manually.

The prepayment is a subledger record: its remaining amount always equals what
the ledger holds for it, because every movement is a posted journal.

UI: `/accounting/prepayments`.
