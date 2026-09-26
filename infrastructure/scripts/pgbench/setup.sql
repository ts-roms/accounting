-- Fixture for the pgbench posting scenarios (throwaway perf database only; run after
-- perf-ledger.sql). Creates bench_accounts / bench_ctx and a BENCH counter row.
\set ON_ERROR_STOP on
DROP TABLE IF EXISTS bench_accounts, bench_ctx;
CREATE SEQUENCE IF NOT EXISTS bench_seq;
CREATE TABLE bench_ctx AS
SELECT c.id AS company_id, c.organization_id, fp.id AS period_id, c.base_currency AS currency
FROM companies c JOIN fiscal_periods fp ON fp.company_id = c.id AND date '2026-09-15' BETWEEN fp.start_date AND fp.end_date
WHERE c.code = coalesce(nullif(:'company', ''), 'ACME');
-- idx 1 = the heavy account; 2.. = PERF accounts (never control accounts).
CREATE TABLE bench_accounts AS
SELECT (row_number() OVER (ORDER BY a.code = 'P1HEAVY' DESC, a.code))::int AS idx, a.id AS account_id
FROM accounts a JOIN bench_ctx x ON x.company_id = a.company_id
WHERE a.code ~ '^P[1-8]' AND NOT a.is_header;
ALTER TABLE bench_accounts ADD PRIMARY KEY (idx);
SELECT count(*) AS bench_accounts FROM bench_accounts;
