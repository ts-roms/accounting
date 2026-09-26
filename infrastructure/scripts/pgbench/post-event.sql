-- One postEvent-equivalent transaction: the statements AccountingPostingService issues, in order,
-- with the same locks. Variables (-D): balspread = how many accounts the balancing line spreads
-- over (1 = every journal hits the heavy account: one hot period-balance row per month),
-- counter = 1 to allocate from the JE counter row (the gapless numbering lock), 0 = use a
-- sequence (what the ledger would cost without that serialization point); minlines / maxlines =
-- lines per journal (2 / 6 typical, 300 / 300 for a payroll-sized batch); audit = 1 to write the
-- audit row (0 only to measure what the audit trail costs - never a production option).
\set nlines random(:minlines, :maxlines)
\set bal random(1, :balspread)
\set acc random(2, 400)
\set total 100 * (:nlines - 1)
BEGIN;
-- findExisting (idempotency / source identity)
SELECT id FROM journal_entries WHERE company_id = (SELECT company_id FROM bench_ctx) AND source_type = 'BENCH' AND source_id = '00000000-0000-4000-8000-000000000001';
-- company currency, accounts, branches, period (validateLines / validateForPosting / resolvePeriod)
SELECT base_currency FROM companies WHERE id = (SELECT company_id FROM bench_ctx);
SELECT id, status, is_header, currency FROM accounts WHERE id IN (SELECT account_id FROM bench_accounts WHERE idx IN (:bal, :acc, :acc + 1));
SELECT id, status FROM fiscal_periods WHERE id = (SELECT period_id FROM bench_ctx);
-- numbering: counter row lock held until COMMIT (counter=1) or a non-blocking sequence (counter=0)
\if :counter
INSERT INTO document_sequences (company_id, document_type, year, prefix, padding, next_number)
SELECT company_id, 'JE', 2026, 'JE', 6, 2 FROM bench_ctx
ON CONFLICT ON CONSTRAINT document_sequences_uq DO UPDATE SET next_number = document_sequences.next_number + 1, updated_at = now()
RETURNING next_number - 1 AS seqno \gset
\else
SELECT nextval('bench_seq') AS seqno \gset
\endif
INSERT INTO journal_entries (company_id, fiscal_period_id, document_number, journal_type, status, entry_date, description,
                             currency, total_debit, total_credit, source_type, approved_at)
SELECT company_id, period_id, 'JB-' || :counter || '-' || :seqno, 'GENERAL', 'APPROVED', date '2026-09-15', 'bench posting',
       currency, :total, :total, 'BENCH', now() FROM bench_ctx
RETURNING id AS eid \gset
INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, debit, credit)
SELECT ':eid'::uuid, (SELECT company_id FROM bench_ctx), g,
       (SELECT account_id FROM bench_accounts WHERE idx = CASE WHEN g = 1 THEN :bal ELSE 2 + ((:acc + g * 37) % 398) END),
       CASE WHEN g = 1 THEN 0 ELSE 100 END, CASE WHEN g = 1 THEN :total ELSE 0 END
FROM generate_series(1, :nlines) g;
-- postEntry: lock, re-read lines, re-validate, flip status (fires the period-balance trigger)
SELECT id, status FROM journal_entries WHERE id = ':eid'::uuid FOR UPDATE;
SELECT account_id, debit, credit FROM journal_lines WHERE journal_entry_id = ':eid'::uuid ORDER BY line_number;
UPDATE journal_entries SET status = 'POSTED', posting_date = entry_date, posted_at = now() WHERE id = ':eid'::uuid;
\if :audit
INSERT INTO audit_logs (organization_id, company_id, action, module, entity_type, entity_id, previous_value, new_value, metadata)
SELECT organization_id, company_id, 'POST', 'ACCOUNTING', 'JournalEntry', ':eid', '{"status":"APPROVED"}', '{"status":"POSTED"}',
       jsonb_build_object('lines', :nlines, 'bench', true) FROM bench_ctx;
\endif
INSERT INTO integration_events (organization_id, company_id, direction, event_type, dedupe_key, payload)
SELECT organization_id, company_id, 'OUTBOUND', 'journal.posted', 'bench:' || ':eid', jsonb_build_object('id', ':eid') FROM bench_ctx;
END;
