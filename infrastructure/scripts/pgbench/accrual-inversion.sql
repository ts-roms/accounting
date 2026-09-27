-- postEntry of a manual accrual (autoReverseDate set): the status flip takes the period-balance
-- row locks FIRST, then reverseEntry -> postEvent allocates from the JE counter. Every other
-- postEvent takes the counter FIRST, then the period-balance rows. Run it together with
-- post-event.sql (-D balspread=1 so both hit the heavy account's row) to expose the inversion.
\set total 100
-- -D jtype=GENERAL | ACCRUAL (the period-balance key includes the journal type)
BEGIN;
INSERT INTO journal_entries (company_id, fiscal_period_id, document_number, journal_type, status, entry_date, description,
                             currency, total_debit, total_credit, source_type, approved_at)
SELECT company_id, period_id, 'JA-' || nextval('bench_seq'), ':jtype', 'APPROVED', date '2026-09-15', 'accrual probe',
       currency, :total, :total, 'BENCH', now() FROM bench_ctx
RETURNING id AS eid \gset
INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, debit, credit)
SELECT ':eid'::uuid, (SELECT company_id FROM bench_ctx), g, (SELECT account_id FROM bench_accounts WHERE idx = CASE WHEN g = 1 THEN 1 ELSE 3 END),
       CASE WHEN g = 1 THEN :total ELSE 0 END, CASE WHEN g = 1 THEN 0 ELSE :total END
FROM generate_series(1, 2) g;
UPDATE journal_entries SET status = 'POSTED', posting_date = entry_date, posted_at = now() WHERE id = ':eid'::uuid;
-- audit + outbox of the accrual, then the auto-reversal allocates its number
SELECT pg_sleep(0.001);
INSERT INTO document_sequences (company_id, document_type, year, prefix, padding, next_number)
SELECT company_id, 'JE', 2026, 'JE', 6, 2 FROM bench_ctx
ON CONFLICT ON CONSTRAINT document_sequences_uq DO UPDATE SET next_number = document_sequences.next_number + 1, updated_at = now();
END;
