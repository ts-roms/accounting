-- Production-like, financially valid ledger volume for performance AND correctness work.
-- Successor to perf-volume.sql (kept for reproducing the 2026-09 numbers). Load into a
-- THROWAWAY database that has been migrated and seeded - never an e2e or real database:
--
--   psql "$PERF_DB" -v journals=1000000 -v clones=3 -v years=3 -f infrastructure/scripts/perf-ledger.sql
--
-- Parameters (psql -v, all optional):
--   journals      total journals across all companies                   (default 100000)
--   clones        extra companies cloned from ACME's master data        (default 2)
--   years         years of history ending at end_date                    (default 2)
--   end_date      last entry date; the current month stays partial      (default 2026-09-18, the pinned business date)
--   heavy_share   share of journals touching the per-company heavy account (default 0.30)
--   triggers      'bulk' = load with the ledger triggers off, then rebuild the period-balance
--                 model with rebuild_account_period_balances() (fast, the documented repair path);
--                 'live' = insert DRAFT + lines, then flip to POSTED so the triggers maintain the
--                 model row by row (slow; use it to measure trigger cost)  (default bulk)
--   dims          'correlated' = department / cost centre follow the account (how real charts are
--                 used), 'random' = independent uniform picks (worst case for the period-balance
--                 model), 'none' = no dimensions (what perf-volume.sql measured)  (default correlated)
--   only          generate journals for this one company code only (e.g. PERF03 with
--                 heavy_share=0.9 for a single very heavy account)          (default: all)
--   seed          setseed() value, for a reproducible dataset             (default 0.42)
--
-- What makes it financially valid (unlike perf-volume.sql):
--   * every journal is balanced by construction in integer cents (one balancing line carries the
--     exact sum of the detail lines), so journal_entries_posted_balanced_chk and
--     UNBALANCED_JOURNAL hold;
--   * lines only hit PERF accounts created here - never a mapped control account (AR, AP,
--     inventory, fixed assets, tax, deferred revenue, payroll, leases, cash in transit, suspense),
--     never a currency-bound account, never a branch-restricted account - so every subledger
--     reconciliation and integrity check stays at zero variance;
--   * reversals are real pairs: the original is REVERSED with reversed_by_id, the mirror is a
--     POSTED REVERSAL with source JOURNAL_REVERSAL / reversal_of_id, lines swapped;
--   * DRAFT / SUBMITTED / APPROVED journals carry lines that must NOT reach the ledger or the
--     period-balance model;
--   * dimensions are PERF dimensions of the same company with no validity window.
-- Run infrastructure/scripts/perf-verify.sql afterwards: it is the pass/fail gate.
\set ON_ERROR_STOP on
\if :{?journals} \else \set journals 100000 \endif
\if :{?clones} \else \set clones 2 \endif
\if :{?years} \else \set years 2 \endif
\if :{?end_date} \else \set end_date '2026-09-18' \endif
\if :{?heavy_share} \else \set heavy_share 0.30 \endif
\if :{?triggers} \else \set triggers bulk \endif
\if :{?seed} \else \set seed 0.42 \endif
\if :{?dims} \else \set dims correlated \endif
\if :{?only} \else \set only '' \endif

SELECT setseed(:seed);
\timing on

-- ------------------------------------------------------------------ companies
-- Clones copy ACME's master data (chart, mappings, branches, fiscal calendar) so every
-- company-scoped check has what it needs. The admin is organization-wide, so the clones are
-- reachable through the API with the same session.
CREATE TEMP TABLE perf_params AS
SELECT :journals::bigint AS journals, :clones::int AS clones, :years::int AS years,
       :'end_date'::date AS end_date, :heavy_share::numeric AS heavy_share, :'dims'::text AS dims,
       nullif(:'only', '')::text AS only_code;

DO $$
DECLARE
  src uuid := (SELECT id FROM companies WHERE code = 'ACME');
  n int := (SELECT clones FROM perf_params);
  i int;
  dst uuid;
BEGIN
  FOR i IN 1..n LOOP
    IF EXISTS (SELECT 1 FROM companies WHERE code = 'PERF' || lpad(i::text, 2, '0')) THEN CONTINUE; END IF;
    INSERT INTO companies (organization_id, code, name, base_currency, fiscal_year_start_month, country)
    SELECT organization_id, 'PERF' || lpad(i::text, 2, '0'), 'Perf Company ' || i, base_currency,
           fiscal_year_start_month, country
    FROM companies WHERE id = src RETURNING id INTO dst;

    CREATE TEMP TABLE acc_map ON COMMIT DROP AS
      SELECT id AS old_id, gen_random_uuid() AS new_id FROM accounts WHERE company_id = src;
    INSERT INTO accounts (id, company_id, code, name, type, subtype, normal_balance, parent_id, is_header,
                          is_system, currency, description, status, is_intercompany, is_reconciliation,
                          cash_flow_activity)
    SELECT m.new_id, dst, a.code, a.name, a.type, a.subtype, a.normal_balance, pm.new_id, a.is_header,
           a.is_system, a.currency, a.description, a.status, a.is_intercompany, a.is_reconciliation,
           a.cash_flow_activity
    FROM accounts a JOIN acc_map m ON m.old_id = a.id LEFT JOIN acc_map pm ON pm.old_id = a.parent_id;
    INSERT INTO account_mappings (company_id, key, account_id)
    SELECT dst, am.key, m.new_id FROM account_mappings am JOIN acc_map m ON m.old_id = am.account_id
    WHERE am.company_id = src;
    INSERT INTO branches (company_id, code, name, is_head_office, country)
    SELECT dst, code, name, is_head_office, country FROM branches WHERE company_id = src;
    INSERT INTO fiscal_years (company_id, name, start_date, end_date, status)
    SELECT dst, name, start_date, end_date, status FROM fiscal_years WHERE company_id = src;
    INSERT INTO fiscal_periods (fiscal_year_id, company_id, period_number, name, start_date, end_date, status)
    SELECT ny.id, dst, p.period_number, p.name, p.start_date, p.end_date, p.status
    FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id
    JOIN fiscal_years ny ON ny.company_id = dst AND ny.name = y.name
    WHERE p.company_id = src;
    DROP TABLE acc_map;
  END LOOP;
END $$;

CREATE TEMP TABLE perf_companies AS
SELECT c.id AS company_id, c.code,
       -- Company skew: ACME is the big one, clones get geometrically less.
       CASE WHEN c.code = 'ACME' THEN 1.0 ELSE 0.6 ^ (substr(c.code, 5)::int) END AS weight
FROM companies c
WHERE c.code = 'ACME' OR (c.code ~ '^PERF[0-9]{2}$' AND substr(c.code, 5)::int <= (SELECT clones FROM perf_params));
ALTER TABLE perf_companies ADD COLUMN share numeric;
UPDATE perf_companies SET share = weight / (SELECT sum(weight) FROM perf_companies);
-- only=CODE: every journal of this run goes to that company (master data is still ensured for all).
UPDATE perf_companies SET share = CASE WHEN code = (SELECT only_code FROM perf_params) THEN 1 ELSE 0 END
WHERE (SELECT only_code FROM perf_params) IS NOT NULL;

-- ------------------------------------------------------------ fiscal calendar
-- Monthly OPEN periods for every history year that is missing (years stay open: no CLOSING
-- journals are generated, and the balance sheet's current earnings cover unclosed years).
INSERT INTO fiscal_years (company_id, name, start_date, end_date, status)
SELECT pc.company_id, 'FY' || y, make_date(y, 1, 1), make_date(y, 12, 31), 'OPEN'
FROM perf_companies pc
CROSS JOIN generate_series(extract(year FROM (SELECT end_date FROM perf_params))::int - (SELECT years FROM perf_params) + 1,
                           extract(year FROM (SELECT end_date FROM perf_params))::int) y
WHERE NOT EXISTS (SELECT 1 FROM fiscal_years f WHERE f.company_id = pc.company_id AND f.start_date = make_date(y, 1, 1));
INSERT INTO fiscal_periods (fiscal_year_id, company_id, period_number, name, start_date, end_date, status)
SELECT fy.id, fy.company_id, m, to_char(make_date(extract(year FROM fy.start_date)::int, m, 1), 'Mon YYYY'),
       make_date(extract(year FROM fy.start_date)::int, m, 1),
       (make_date(extract(year FROM fy.start_date)::int, m, 1) + interval '1 month - 1 day')::date, 'OPEN'
FROM fiscal_years fy JOIN perf_companies pc ON pc.company_id = fy.company_id
CROSS JOIN generate_series(1, 12) m
WHERE NOT EXISTS (SELECT 1 FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id);

-- ------------------------------------------------------ PERF chart + dimensions
-- ~420 postable accounts per company. Realistic enterprise charts run to hundreds or thousands
-- of accounts; the seeded 70 would make every account "hot".
CREATE TEMP TABLE perf_account_plan (type account_type, normal normal_balance, prefix text, n int, side text);
INSERT INTO perf_account_plan VALUES
  ('EXPENSE',       'DEBIT',  'P6', 220, 'D'),
  ('COST_OF_SALES', 'DEBIT',  'P5',  30, 'D'),
  ('ASSET',         'DEBIT',  'P1',  70, 'D'),
  ('REVENUE',       'CREDIT', 'P4',  45, 'C'),
  ('LIABILITY',     'CREDIT', 'P2',  45, 'C'),
  ('OTHER_INCOME',  'CREDIT', 'P7',   5, 'C'),
  ('OTHER_EXPENSE', 'DEBIT',  'P8',   5, 'D');
INSERT INTO accounts (company_id, code, name, type, normal_balance, is_header, status)
SELECT pc.company_id, p.prefix || lpad(g::text, 4, '0'), 'Perf ' || lower(p.type::text) || ' ' || g, p.type, p.normal, false, 'ACTIVE'
FROM perf_companies pc CROSS JOIN perf_account_plan p CROSS JOIN generate_series(1, p.n) g
ON CONFLICT (company_id, code) DO NOTHING;
-- The heavy account: a settlement clearing account on one side of heavy_share of all journals
-- (the "10M lines on one account" case at the 30M-line scale).
INSERT INTO accounts (company_id, code, name, type, normal_balance, is_header, status)
SELECT company_id, 'P1HEAVY', 'Perf settlement clearing (heavy)', 'ASSET', 'DEBIT', false, 'ACTIVE' FROM perf_companies
ON CONFLICT (company_id, code) DO NOTHING;

INSERT INTO branches (company_id, code, name, country)
SELECT pc.company_id, 'PB' || lpad(g::text, 2, '0'), 'Perf branch ' || g, 'PH'
FROM perf_companies pc CROSS JOIN generate_series(1, 12) g
ON CONFLICT DO NOTHING;
INSERT INTO dimensions (company_id, dimension_type, code, name)
SELECT pc.company_id, t.dt::dimension_type, t.pfx || lpad(g::text, 3, '0'), 'Perf ' || t.dt || ' ' || g
FROM perf_companies pc
CROSS JOIN (VALUES ('DEPARTMENT', 'PD', 25), ('COST_CENTER', 'PC', 40), ('PROJECT', 'PP', 60)) t(dt, pfx, n)
CROSS JOIN LATERAL generate_series(1, t.n) g
ON CONFLICT DO NOTHING;

-- Weighted pick tables: 1000 slots per company and side. Tiers by random rank inside the side:
-- top 5 % of accounts take 60 % of the slots, next 15 % take 30 %, the remaining 80 % take 10 %.
CREATE TEMP TABLE perf_ranked AS
SELECT a.company_id, a.id AS account_id, p.side,
       percent_rank() OVER (PARTITION BY a.company_id, p.side ORDER BY random()) AS pr
FROM accounts a
JOIN perf_account_plan p ON a.code LIKE p.prefix || '%' AND a.type = p.type
JOIN perf_companies pc ON pc.company_id = a.company_id
WHERE a.code <> 'P1HEAVY';
ALTER TABLE perf_ranked ADD COLUMN tier text;
UPDATE perf_ranked SET tier = CASE WHEN pr < 0.05 THEN 'hot' WHEN pr < 0.20 THEN 'medium' ELSE 'cold' END;
CREATE TEMP TABLE perf_slots AS
WITH w AS (
  SELECT r.*, CASE tier WHEN 'hot' THEN 0.60 WHEN 'medium' THEN 0.30 ELSE 0.10 END
              / count(*) OVER (PARTITION BY company_id, side, tier) AS wt
  FROM perf_ranked r
), c AS (
  SELECT w.*, sum(wt) OVER (PARTITION BY company_id, side ORDER BY pr ROWS UNBOUNDED PRECEDING) AS cum
  FROM w
)
SELECT company_id, side,
       array_agg(account_id ORDER BY s) AS slots
FROM (
  SELECT c.company_id, c.side, s,
         (SELECT c2.account_id FROM c c2 WHERE c2.company_id = c.company_id AND c2.side = c.side
            AND c2.cum >= (s - 0.5) / 1000.0 ORDER BY c2.cum LIMIT 1) AS account_id
  FROM (SELECT DISTINCT company_id, side FROM c) c CROSS JOIN generate_series(1, 1000) s
) x GROUP BY company_id, side;
CREATE TEMP TABLE perf_dims AS
SELECT pc.company_id,
       (SELECT array_agg(id ORDER BY code) FROM branches b WHERE b.company_id = pc.company_id AND b.status = 'ACTIVE' AND b.code LIKE 'PB%') AS branches,
       (SELECT array_agg(id ORDER BY code) FROM dimensions d WHERE d.company_id = pc.company_id AND d.code LIKE 'PD%') AS depts,
       (SELECT array_agg(id ORDER BY code) FROM dimensions d WHERE d.company_id = pc.company_id AND d.code LIKE 'PC%') AS ccs,
       (SELECT array_agg(id ORDER BY code) FROM dimensions d WHERE d.company_id = pc.company_id AND d.code LIKE 'PP%') AS projects,
       (SELECT id FROM accounts a WHERE a.company_id = pc.company_id AND a.code = 'P1HEAVY') AS heavy,
       (SELECT base_currency FROM companies c WHERE c.id = pc.company_id) AS currency,
       (SELECT id FROM users WHERE email = 'admin@acme.local') AS admin_id
FROM perf_companies pc;

-- ------------------------------------------------------------------- journals
-- Month weights: 2 %/month growth, December +40 % (year-end), so later months are denser.
CREATE TEMP TABLE perf_months AS
WITH m AS (
  SELECT generate_series(date_trunc('year', (SELECT end_date FROM perf_params)) - make_interval(years => (SELECT years FROM perf_params) - 1),
                         date_trunc('month', (SELECT end_date FROM perf_params)), interval '1 month')::date AS month_start
)
SELECT month_start,
       least((month_start + interval '1 month - 1 day')::date, (SELECT end_date FROM perf_params)) AS month_end,
       power(1.02, row_number() OVER (ORDER BY month_start)) * CASE WHEN extract(month FROM month_start) = 12 THEN 1.4 ELSE 1 END
       * ((least((month_start + interval '1 month - 1 day')::date, (SELECT end_date FROM perf_params)) - month_start + 1)::numeric
          / extract(day FROM (month_start + interval '1 month - 1 day'))) AS weight
FROM m;

CREATE TEMP TABLE perf_plan AS
SELECT pc.company_id, m.month_start, m.month_end,
       greatest(1, round((SELECT journals FROM perf_params) * pc.share * m.weight / (SELECT sum(weight) FROM perf_months)))::bigint AS n
FROM perf_companies pc CROSS JOIN perf_months m;

CREATE TEMP TABLE perf_seq (company_id uuid PRIMARY KEY, next_no bigint);
INSERT INTO perf_seq SELECT company_id, coalesce((
  SELECT max(substr(document_number, 4)::bigint) FROM journal_entries e
  WHERE e.company_id = pc.company_id AND e.document_number ~ '^PJ-[0-9]+$'), 0) + 1
FROM perf_companies pc;

SELECT (:'triggers' = 'bulk') AS bulk \gset
\if :bulk
ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_period_balance;
ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_immutable_when_posted;
ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_period_balance;
\endif

-- One month of one company per call: bounded memory, one commit each, progress visible.
CREATE OR REPLACE PROCEDURE perf_generate_month(p_company uuid, p_from date, p_to date, p_n bigint, p_bulk boolean)
LANGUAGE plpgsql AS $$
DECLARE
  first_no bigint;
BEGIN
  UPDATE perf_seq SET next_no = next_no + p_n WHERE company_id = p_company RETURNING next_no - p_n INTO first_no;

  CREATE TEMP TABLE g_entries ON COMMIT DROP AS
  WITH e AS (
    SELECT i, random() AS r_lines, random() AS r_status, random() AS r_type, random() AS r_heavy, random() AS r_side,
           -- Month-end skew: u^0.55 bunches dates towards the end of the month.
           p_from + least((p_to - p_from), floor((p_to - p_from + 1) * power(random(), 0.55))::int) AS entry_date
    FROM generate_series(0, p_n - 1) i
  )
  SELECT gen_random_uuid() AS id, p_company AS company_id, i, entry_date,
         'PJ-' || lpad((first_no + i)::text, 9, '0') AS document_number,
         -- Lines per journal: 55 % 2, 30 % 3-6, 12 % 7-20, 2.5 % 21-60, 0.5 % 100-300 (mean ~6).
         CASE WHEN r_lines < 0.55 THEN 2
              WHEN r_lines < 0.85 THEN 3 + floor(random() * 4)::int
              WHEN r_lines < 0.97 THEN 7 + floor(random() * 14)::int
              WHEN r_lines < 0.995 THEN 21 + floor(random() * 40)::int
              ELSE 100 + floor(random() * 201)::int END AS n_lines,
         CASE WHEN r_status < 0.020 THEN 'DRAFT' WHEN r_status < 0.030 THEN 'SUBMITTED'
              WHEN r_status < 0.035 THEN 'APPROVED' WHEN r_status < 0.065 THEN 'REVERSED'
              ELSE 'POSTED' END::journal_status AS status,
         CASE WHEN entry_date >= p_to - 2 AND r_type < 0.35 THEN 'ADJUSTING'
              WHEN r_type < 0.04 THEN 'ACCRUAL' WHEN r_type < 0.07 THEN 'RECLASSIFICATION'
              ELSE 'GENERAL' END::journal_type AS journal_type,
         r_heavy < (SELECT heavy_share FROM perf_params) AS heavy,
         CASE WHEN r_side < 0.5 THEN 'D' ELSE 'C' END AS detail_side
  FROM e;

  -- Detail lines 2..n on detail_side; line 1 balances them exactly on the other side.
  CREATE TEMP TABLE g_lines ON COMMIT DROP AS
  SELECT g.id AS entry_id, g.company_id, l AS line_number,
         s.slots[1 + floor(random() * 1000)::int] AS account_id,
         -- Log-uniform cents between 10.00 and 250,000.00.
         floor(exp(ln(1000) + random() * (ln(25000000) - ln(1000))))::bigint AS cents,
         g.detail_side, g.entry_date
  FROM g_entries g
  JOIN perf_slots s ON s.company_id = g.company_id AND s.side = g.detail_side
  CROSS JOIN LATERAL generate_series(2, g.n_lines) l;

  INSERT INTO journal_entries (id, company_id, branch_id, fiscal_period_id, document_number, journal_type, status,
                               entry_date, posting_date, description, currency, total_debit, total_credit,
                               source_type, created_by, posted_by, posted_at)
  SELECT g.id, g.company_id, NULL, fp.id, g.document_number, g.journal_type,
         CASE WHEN p_bulk THEN g.status ELSE 'DRAFT' END,
         g.entry_date, CASE WHEN p_bulk AND g.status IN ('POSTED', 'REVERSED') THEN g.entry_date END,
         'Perf ledger journal ' || g.document_number, d.currency,
         t.total, t.total, 'PERF_LEDGER', d.admin_id,
         CASE WHEN p_bulk AND g.status IN ('POSTED', 'REVERSED') THEN d.admin_id END,
         CASE WHEN p_bulk AND g.status IN ('POSTED', 'REVERSED') THEN now() END
  FROM g_entries g
  JOIN perf_dims d ON d.company_id = g.company_id
  JOIN fiscal_periods fp ON fp.company_id = g.company_id AND g.entry_date BETWEEN fp.start_date AND fp.end_date
  JOIN (SELECT entry_id, (sum(cents) / 100.0)::numeric(19,4) AS total FROM g_lines GROUP BY entry_id) t ON t.entry_id = g.id;

  INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, description, debit, credit,
                             branch_id, department_id, cost_center_id, project_id)
  SELECT l.entry_id, l.company_id, l.line_number, l.account_id, NULL,
         CASE WHEN l.detail_side = 'D' THEN l.cents / 100.0 ELSE 0 END,
         CASE WHEN l.detail_side = 'C' THEN l.cents / 100.0 ELSE 0 END,
         CASE WHEN x.mode <> 'none' AND random() < 0.8 THEN d.branches[1 + floor(power(random(), 1.5) * array_length(d.branches, 1))::int] END,
         CASE WHEN x.mode = 'random' AND random() < 0.6 THEN d.depts[1 + floor(random() * array_length(d.depts, 1))::int]
              -- correlated: an account is used by one "home" department 80 % of the time, a neighbour otherwise.
              WHEN x.mode = 'correlated' AND random() < 0.6 THEN d.depts[1 + (x.h + CASE WHEN random() < 0.8 THEN 0 ELSE 1 + floor(random() * 2)::int END) % array_length(d.depts, 1)] END,
         CASE WHEN x.mode = 'random' AND random() < 0.3 THEN d.ccs[1 + floor(random() * array_length(d.ccs, 1))::int]
              WHEN x.mode = 'correlated' AND random() < 0.3 THEN d.ccs[1 + (x.h / 7 + CASE WHEN random() < 0.8 THEN 0 ELSE 1 END) % array_length(d.ccs, 1)] END,
         CASE WHEN x.mode <> 'none' AND random() < 0.1 THEN d.projects[1 + floor(random() * array_length(d.projects, 1))::int] END
  FROM g_lines l JOIN perf_dims d ON d.company_id = l.company_id
  CROSS JOIN LATERAL (SELECT (SELECT dims FROM perf_params) AS mode, abs(hashtext(l.account_id::text)) AS h) x;

  -- Balancing line 1: the heavy account for heavy journals, otherwise a pick from the other side.
  INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, debit, credit, branch_id)
  SELECT g.id, g.company_id, 1,
         CASE WHEN g.heavy THEN d.heavy
              ELSE s.slots[1 + floor(random() * 1000)::int] END,
         CASE WHEN g.detail_side = 'C' THEN t.total ELSE 0 END,
         CASE WHEN g.detail_side = 'D' THEN t.total ELSE 0 END,
         CASE WHEN (SELECT dims FROM perf_params) <> 'none' AND random() < 0.8 THEN d.branches[1 + floor(power(random(), 1.5) * array_length(d.branches, 1))::int] END
  FROM g_entries g
  JOIN perf_dims d ON d.company_id = g.company_id
  JOIN perf_slots s ON s.company_id = g.company_id AND s.side = CASE g.detail_side WHEN 'D' THEN 'C' ELSE 'D' END
  JOIN (SELECT entry_id, (sum(cents) / 100.0)::numeric(19,4) AS total FROM g_lines GROUP BY entry_id) t ON t.entry_id = g.id;

  -- Mirrors of the REVERSED originals: posted REVERSAL journals a few days later (same month).
  CREATE TEMP TABLE g_rev ON COMMIT DROP AS
  SELECT gen_random_uuid() AS id, g.id AS original_id, g.company_id,
         least(p_to, g.entry_date + 1 + floor(random() * 5)::int) AS entry_date,
         'PJ-' || lpad((first_no + g.i)::text, 9, '0') || 'R' AS document_number
  FROM g_entries g WHERE g.status = 'REVERSED';
  INSERT INTO journal_entries (id, company_id, fiscal_period_id, document_number, journal_type, status, entry_date,
                               posting_date, description, reference, currency, total_debit, total_credit,
                               source_type, source_id, reversal_of_id, created_by, posted_by, posted_at)
  SELECT r.id, r.company_id, fp.id, r.document_number, 'REVERSAL', CASE WHEN p_bulk THEN 'POSTED' ELSE 'DRAFT' END::journal_status,
         r.entry_date, CASE WHEN p_bulk THEN r.entry_date END, 'Reversal of ' || o.document_number, o.document_number,
         o.currency, o.total_debit, o.total_credit, 'JOURNAL_REVERSAL', o.id, o.id, o.created_by,
         CASE WHEN p_bulk THEN o.created_by END, CASE WHEN p_bulk THEN now() END
  FROM g_rev r JOIN journal_entries o ON o.id = r.original_id
  JOIN fiscal_periods fp ON fp.company_id = r.company_id AND r.entry_date BETWEEN fp.start_date AND fp.end_date;
  INSERT INTO journal_lines (journal_entry_id, company_id, line_number, account_id, description, debit, credit,
                             branch_id, department_id, cost_center_id, project_id)
  SELECT r.id, l.company_id, l.line_number, l.account_id, l.description, l.credit, l.debit,
         l.branch_id, l.department_id, l.cost_center_id, l.project_id
  FROM g_rev r JOIN journal_lines l ON l.journal_entry_id = r.original_id;

  IF NOT p_bulk THEN
    -- The live path: entries enter the ledger through a status change, like postEntry does.
    UPDATE journal_entries e SET status = 'POSTED', posting_date = e.entry_date, posted_by = e.created_by, posted_at = now()
    WHERE e.id IN (SELECT id FROM g_entries WHERE status IN ('POSTED', 'REVERSED') UNION ALL SELECT id FROM g_rev);
    UPDATE journal_entries e SET status = g.status FROM g_entries g WHERE e.id = g.id AND g.status IN ('SUBMITTED', 'APPROVED');
    UPDATE journal_entries e SET status = 'REVERSED' FROM g_rev r WHERE e.id = r.original_id;
  END IF;
  UPDATE journal_entries e SET reversed_by_id = r.id FROM g_rev r WHERE e.id = r.original_id;
END $$;

-- CALL with COMMIT between months cannot run inside DO in a transaction block; psql autocommit is on.
SELECT format('CALL perf_generate_month(%L, %L, %L, %s, %s);', company_id, month_start, month_end, n,
              CASE WHEN :'triggers' = 'bulk' THEN 'true' ELSE 'false' END)
FROM perf_plan ORDER BY month_start, company_id \gexec

\if :bulk
ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_period_balance;
ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_immutable_when_posted;
ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_period_balance;
-- The documented repair path, also the rebuild-time measurement.
SELECT pc.code, rebuild_account_period_balances(pc.company_id) AS period_balance_rows FROM perf_companies pc ORDER BY pc.code;
\endif

ANALYZE journal_entries; ANALYZE journal_lines; ANALYZE account_period_balances;
SELECT pc.code,
       (SELECT count(*) FROM journal_entries e WHERE e.company_id = pc.company_id) AS entries,
       (SELECT count(*) FROM journal_lines l WHERE l.company_id = pc.company_id) AS lines,
       (SELECT count(*) FROM journal_lines l WHERE l.company_id = pc.company_id AND l.account_id = d.heavy) AS heavy_lines,
       (SELECT count(*) FROM account_period_balances b WHERE b.company_id = pc.company_id) AS period_balance_rows
FROM perf_companies pc JOIN perf_dims d USING (company_id) ORDER BY pc.code;
SELECT pg_size_pretty(pg_total_relation_size('journal_lines')) AS journal_lines,
       pg_size_pretty(pg_total_relation_size('journal_entries')) AS journal_entries,
       pg_size_pretty(pg_total_relation_size('account_period_balances')) AS period_balances,
       pg_size_pretty(pg_database_size(current_database())) AS database;
