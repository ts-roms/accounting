-- Two-line journals between two hot accounts, lines in either order, entered through the
-- postEntry path (no counter allocation - manual journals get their number at draft time).
-- The period-balance trigger updates one row per (account, month, ...) in line order, so two
-- transactions posting A,B and B,A can deadlock. Watch pg_stat_database.deadlocks.
\set flip random(0, 1)
\set total 100
BEGIN;
INSERT INTO journal_entries (company_id, fiscal_period_id, document_number, journal_type, status, entry_date, description,
                             currency, total_debit, total_credit, source_type, approved_at)
SELECT company_id, period_id, 'JD-' || nextval('bench_seq'), 'GENERAL', 'APPROVED', date '2026-09-15', 'deadlock probe',
       currency, :total, :total, 'BENCH', now() FROM bench_ctx
RETURNING id AS eid \gset
INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, debit, credit)
SELECT ':eid'::uuid, (SELECT company_id FROM bench_ctx), g,
       (SELECT account_id FROM bench_accounts WHERE idx = CASE WHEN (g = 1) = (:flip = 1) THEN 1 ELSE 2 END),
       CASE WHEN g = 1 THEN :total ELSE 0 END, CASE WHEN g = 1 THEN 0 ELSE :total END
FROM generate_series(1, 2) g;
UPDATE journal_entries SET status = 'POSTED', posting_date = entry_date, posted_at = now() WHERE id = ':eid'::uuid;
-- the rest of the caller's transaction (audit, outbox, document status) keeps the row locks
SELECT pg_sleep(0.002);
END;
