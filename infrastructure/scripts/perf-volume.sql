-- Synthetic GL volume for performance work (ACME only). Load into a THROWAWAY database:
--   docker exec -i accounting-postgres psql -U accounting -d accounting_ci < infrastructure/scripts/perf-volume.sql
-- The journals credit the AR / AP control accounts directly, so subledger reconciliations
-- show variance afterwards - never run this against a database used for e2e tests.
-- 40,000 posted GENERAL journals x 2 lines dated Jan-Sep 2026 across postable
-- expense / cash / AR / revenue accounts. Inserted as DRAFT with lines, then
-- flipped to POSTED (the immutability triggers only guard posted rows).
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE gen_entries AS
WITH co AS (SELECT id AS company_id, base_currency FROM companies WHERE code = 'ACME'),
     admin AS (SELECT id AS user_id FROM users WHERE email = 'admin@acme.local'),
     n AS (SELECT generate_series(1, 40000) AS i),
     dated AS (
       SELECT i, (date '2026-01-01' + ((i * 7) % 270))::date AS entry_date FROM n
     )
SELECT gen_random_uuid() AS id,
       co.company_id,
       fp.id AS fiscal_period_id,
       'PERF-' || lpad(d.i::text, 6, '0') AS document_number,
       d.entry_date,
       'Perf audit journal ' || d.i AS description,
       co.base_currency AS currency,
       (100 + (d.i % 900))::numeric(19,4) AS amount,
       admin.user_id,
       d.i
FROM dated d
CROSS JOIN co
CROSS JOIN admin
JOIN fiscal_periods fp
  ON fp.company_id = co.company_id AND fp.start_date <= d.entry_date AND fp.end_date >= d.entry_date;

INSERT INTO journal_entries (id, company_id, fiscal_period_id, document_number, journal_type, status, entry_date,
                             description, currency, total_debit, total_credit, source_type, created_by)
SELECT id, company_id, fiscal_period_id, document_number, 'GENERAL', 'DRAFT', entry_date,
       description, currency, amount, amount, 'PERF_AUDIT', user_id
FROM gen_entries;

-- Debit side: rotate over expense accounts; credit side: rotate over cash / AP / revenue-ish accounts.
CREATE TEMP TABLE dr_accounts AS
SELECT row_number() OVER (ORDER BY code) - 1 AS rn, id, count(*) OVER () AS cnt
FROM accounts WHERE company_id = (SELECT company_id FROM gen_entries LIMIT 1)
  AND is_header = false AND status = 'ACTIVE' AND type = 'EXPENSE';
CREATE TEMP TABLE cr_accounts AS
SELECT row_number() OVER (ORDER BY code) - 1 AS rn, id, count(*) OVER () AS cnt
FROM accounts WHERE company_id = (SELECT company_id FROM gen_entries LIMIT 1)
  AND is_header = false AND status = 'ACTIVE' AND code IN ('1130', '1180', '2100', '2110', '4100', '4900');

INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, description, debit, credit)
SELECT g.id, g.company_id, 1, d.id, g.description, g.amount, 0
FROM gen_entries g JOIN dr_accounts d ON d.rn = (g.i % d.cnt);
INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, description, debit, credit)
SELECT g.id, g.company_id, 2, c.id, g.description, 0, g.amount
FROM gen_entries g JOIN cr_accounts c ON c.rn = (g.i % c.cnt);

UPDATE journal_entries SET status = 'POSTED', posting_date = entry_date, posted_at = now(), posted_by = created_by
WHERE id IN (SELECT id FROM gen_entries);

SELECT count(*) AS entries FROM journal_entries WHERE source_type = 'PERF_AUDIT';
SELECT count(*) AS lines FROM journal_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'PERF_AUDIT');
COMMIT;
ANALYZE journal_entries; ANALYZE journal_lines;
