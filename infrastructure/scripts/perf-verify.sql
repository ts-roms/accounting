-- Financial correctness gate for performance runs. A run that is fast but fails any CRITICAL
-- row here is a FAILED run. Read-only; run it after perf-ledger.sql and after every load /
-- concurrency / failure test:
--
--   psql "$PERF_DB" -f infrastructure/scripts/perf-verify.sql
--
-- Optional: -v since='2026-09-26 10:00:00+00' enables the audit checks for journals posted through
-- the API after that instant (the seed and the synthetic volume write no audit rows, so without
-- it the audit checks are skipped).
--
-- Every check is whole-ledger on purpose (this is the proof, not the dashboard); on 10M+ lines
-- it takes minutes. The same invariants are what IntegrityService runs capped at LIMIT 20.
\set ON_ERROR_STOP on
\if :{?since} \else \set since 'infinity' \endif
\timing on

CREATE TEMP TABLE verify_result (check_name text, severity text, violations bigint, detail text);

-- 1. SUM(debit) = SUM(credit) per ledger entry, and the header totals equal the lines.
INSERT INTO verify_result
SELECT 'ENTRY_BALANCED', 'CRITICAL', count(*), 'ledger entries whose lines do not balance or disagree with the header'
FROM (
  SELECT e.id FROM journal_entries e JOIN journal_lines l ON l.journal_entry_id = e.id
  WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
  GROUP BY e.id, e.total_debit, e.total_credit
  HAVING sum(l.debit) <> sum(l.credit) OR sum(l.debit) <> e.total_debit OR sum(l.credit) <> e.total_credit
) x;

-- 2. A ledger entry without lines is as wrong as an unbalanced one.
INSERT INTO verify_result
SELECT 'ENTRY_HAS_LINES', 'CRITICAL', count(*), 'ledger entries with fewer than two lines'
FROM journal_entries e
WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
  AND (SELECT count(*) FROM journal_lines l WHERE l.journal_entry_id = e.id) < 2;

-- 3. Line sign rules (also DB CHECKs - this proves nobody disabled them).
INSERT INTO verify_result
SELECT 'LINE_SIGNS', 'CRITICAL', count(*), 'lines with a negative side, both sides, or zero'
FROM journal_lines WHERE debit < 0 OR credit < 0 OR (debit <> 0 AND credit <> 0) OR (debit = 0 AND credit = 0);

-- 4. Company consistency: line company = entry company = account company; postable accounts.
INSERT INTO verify_result
SELECT 'COMPANY_CONSISTENCY', 'CRITICAL', count(*), 'lines whose entry or account belongs to another company, or a header account'
FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
WHERE l.company_id <> e.company_id OR a.company_id <> l.company_id
   OR (a.is_header AND e.status IN ('POSTED', 'LOCKED', 'REVERSED'));

-- 5. Currency: every journal is in its company's base currency.
INSERT INTO verify_result
SELECT 'BASE_CURRENCY', 'CRITICAL', count(*), 'journals not in the company base currency'
FROM journal_entries e JOIN companies c ON c.id = e.company_id WHERE e.currency <> c.base_currency;

-- 6. Period: the entry sits in the period that covers its date, of its own company.
INSERT INTO verify_result
SELECT 'PERIOD_MATCH', 'CRITICAL', count(*), 'journals outside their fiscal period'
FROM journal_entries e JOIN fiscal_periods p ON p.id = e.fiscal_period_id
WHERE e.entry_date NOT BETWEEN p.start_date AND p.end_date OR p.company_id <> e.company_id;

-- 7. Ledger entries in LOCKED periods must have been there before the lock (the trigger blocks new ones).
INSERT INTO verify_result
SELECT 'LOCKED_PERIOD_POSTING', 'CRITICAL', count(*), 'entries posted after their period was locked'
FROM journal_entries e JOIN fiscal_periods p ON p.id = e.fiscal_period_id
WHERE p.status = 'LOCKED' AND p.locked_at IS NOT NULL AND e.posted_at > p.locked_at
  AND e.status IN ('POSTED', 'LOCKED', 'REVERSED');

-- 8. Trial balance / accounting equation per company: the whole ledger nets to zero.
INSERT INTO verify_result
SELECT 'TRIAL_BALANCE', 'CRITICAL', count(*), 'companies whose ledger debits <> credits'
FROM (
  SELECT e.company_id FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
  WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
  GROUP BY e.company_id HAVING sum(l.debit) <> sum(l.credit)
) x;

-- 9. Assets = Liabilities + Equity + current earnings, per company (signs by account type).
INSERT INTO verify_result
SELECT 'ACCOUNTING_EQUATION', 'CRITICAL', count(*), 'companies where A <> L + E + unclosed P&L'
FROM (
  SELECT e.company_id,
         sum(CASE WHEN a.type = 'ASSET' THEN l.debit - l.credit ELSE 0 END) AS assets,
         sum(CASE WHEN a.type IN ('LIABILITY', 'EQUITY') THEN l.credit - l.debit ELSE 0 END) AS l_e,
         sum(CASE WHEN a.type NOT IN ('ASSET', 'LIABILITY', 'EQUITY') THEN l.credit - l.debit ELSE 0 END) AS earnings
  FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN accounts a ON a.id = l.account_id
  WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
  GROUP BY e.company_id
) x WHERE assets <> l_e + earnings;

-- 10. The derived model equals the lines, key by key (PERIOD_BALANCES_VS_LEDGER, uncapped).
INSERT INTO verify_result
SELECT 'PERIOD_BALANCES_VS_LEDGER', 'CRITICAL', count(*), 'model keys whose debit / credit / count differ from the lines'
FROM (
  SELECT * FROM (
    SELECT e.company_id, l.account_id, date_trunc('month', e.entry_date)::date AS period_start, e.journal_type,
           l.branch_id, l.department_id, l.cost_center_id, l.project_id,
           sum(l.debit) AS debit, sum(l.credit) AS credit, count(*)::int AS n
    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
  ) lines
  -- NULL dimensions are part of the key (UNIQUE NULLS NOT DISTINCT): join with IS NOT DISTINCT FROM.
  FULL JOIN (SELECT * FROM account_period_balances WHERE line_count <> 0 OR debit <> 0 OR credit <> 0) b
    ON b.company_id = lines.company_id AND b.account_id = lines.account_id AND b.period_start = lines.period_start
   AND b.journal_type = lines.journal_type
   AND b.branch_id IS NOT DISTINCT FROM lines.branch_id AND b.department_id IS NOT DISTINCT FROM lines.department_id
   AND b.cost_center_id IS NOT DISTINCT FROM lines.cost_center_id AND b.project_id IS NOT DISTINCT FROM lines.project_id
  WHERE lines.n IS DISTINCT FROM b.line_count OR lines.debit IS DISTINCT FROM b.debit OR lines.credit IS DISTINCT FROM b.credit
) x;

-- 11. Reversal pairs: REVERSED <-> posted REVERSAL mirror, same company, lines net to zero per account.
INSERT INTO verify_result
SELECT 'REVERSAL_PAIRS', 'CRITICAL', count(*), 'reversed entries without a matching posted mirror'
FROM journal_entries o
LEFT JOIN journal_entries r ON r.id = o.reversed_by_id
WHERE o.status = 'REVERSED'
  AND (r.id IS NULL OR r.reversal_of_id <> o.id OR r.journal_type <> 'REVERSAL'
       OR r.status NOT IN ('POSTED', 'LOCKED') OR r.company_id <> o.company_id
       OR r.total_debit <> o.total_debit OR r.entry_date < o.entry_date);
INSERT INTO verify_result
SELECT 'REVERSAL_NETS_TO_ZERO', 'CRITICAL', count(*), 'reversal pairs whose lines do not cancel per account'
FROM (
  SELECT o.id FROM journal_entries o
  JOIN journal_entries r ON r.id = o.reversed_by_id
  JOIN journal_lines l ON l.journal_entry_id IN (o.id, r.id)
  WHERE o.status = 'REVERSED'
  GROUP BY o.id, l.account_id HAVING sum(l.debit) <> sum(l.credit)
) x;
INSERT INTO verify_result
SELECT 'DOUBLE_REVERSAL', 'CRITICAL', count(*), 'originals reversed by more than one posted journal'
FROM (
  SELECT reversal_of_id FROM journal_entries
  WHERE reversal_of_id IS NOT NULL AND status IN ('POSTED', 'LOCKED', 'REVERSED')
  GROUP BY reversal_of_id HAVING count(*) > 1
) x;

-- 12. Idempotency: one journal per source document and per idempotency key (unique indexes;
--     proves they are present and were not bypassed).
INSERT INTO verify_result
SELECT 'DUPLICATE_SOURCE', 'CRITICAL', count(*), 'source documents with more than one journal'
FROM (SELECT 1 FROM journal_entries WHERE source_id IS NOT NULL
      GROUP BY company_id, source_type, source_id HAVING count(*) > 1) x;
INSERT INTO verify_result
SELECT 'DUPLICATE_IDEMPOTENCY_KEY', 'CRITICAL', count(*), 'idempotency keys used twice'
FROM (SELECT 1 FROM journal_entries WHERE idempotency_key IS NOT NULL
      GROUP BY company_id, idempotency_key HAVING count(*) > 1) x;
INSERT INTO verify_result
SELECT 'DUPLICATE_DOCUMENT_NUMBER', 'CRITICAL', count(*), 'document numbers used twice in a company'
FROM (SELECT 1 FROM journal_entries GROUP BY company_id, document_number HAVING count(*) > 1) x;

-- 13. Numbering: API-allocated JE numbers are gapless per company / year up to the counter
--     (a rolled-back posting rolls its number back). Gaps can come from deleted drafts, so WARNING.
INSERT INTO verify_result
SELECT 'JE_NUMBER_GAPS', 'WARNING', coalesce(sum(s.next_number - 1 - x.used), 0),
       'JE numbers allocated by the counter but not present (deleted drafts are legitimate)'
FROM document_sequences s
JOIN LATERAL (
  SELECT count(*) AS used FROM journal_entries e
  WHERE e.company_id = s.company_id AND e.document_number LIKE s.prefix || '-' || s.year || '-%'
) x ON true
WHERE s.document_type = 'JE' AND s.branch_id IS NULL AND s.year > 0;
INSERT INTO verify_result
SELECT 'JE_NUMBER_BEYOND_COUNTER', 'CRITICAL', count(*), 'JE numbers above the counter (counter not advanced atomically)'
FROM journal_entries e
JOIN document_sequences s ON s.company_id = e.company_id AND s.document_type = 'JE' AND s.branch_id IS NULL
  AND e.document_number ~ ('^' || s.prefix || '-' || s.year || '-[0-9]+$')
WHERE substring(e.document_number FROM '[0-9]+$')::bigint >= s.next_number;

-- 14. Audit: every journal posted through the application after :since has its POST audit row,
--     and no POST audit row points at a journal that does not exist (a rolled-back posting).
INSERT INTO verify_result
SELECT 'POST_WITHOUT_AUDIT', 'CRITICAL', count(*), 'journals posted since :since without a POST audit row'
FROM journal_entries e
WHERE e.posted_at >= :'since'::timestamptz AND e.source_type IS DISTINCT FROM 'PERF_LEDGER'
  AND e.source_type IS DISTINCT FROM 'PERF_AUDIT'
  AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.entity_type = 'JournalEntry' AND a.entity_id = e.id::text AND a.action = 'POST');
INSERT INTO verify_result
SELECT 'ORPHAN_POST_AUDIT', 'CRITICAL', count(*), 'POST audit rows for journals that do not exist'
FROM audit_logs a
WHERE a.entity_type = 'JournalEntry' AND a.action = 'POST' AND a.occurred_at >= :'since'::timestamptz
  AND NOT EXISTS (SELECT 1 FROM journal_entries e WHERE e.id::text = a.entity_id);
INSERT INTO verify_result
SELECT 'DUPLICATE_POST_AUDIT', 'WARNING', count(*), 'journals with more than one POST audit row'
FROM (SELECT entity_id FROM audit_logs WHERE entity_type = 'JournalEntry' AND action = 'POST'
        -- the separate SoD-warning audit row (approver = poster under a WARN policy) is expected
        AND NOT (metadata ? 'sodWarnings')
        AND occurred_at >= :'since'::timestamptz GROUP BY entity_id HAVING count(*) > 1) x;

-- 15. Synthetic volume never touches a mapped (control / subledger) account.
INSERT INTO verify_result
SELECT 'PERF_ON_CONTROL_ACCOUNT', 'CRITICAL', count(*), 'synthetic lines on a mapped account (breaks subledger reconciliation)'
FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
JOIN account_mappings m ON m.account_id = l.account_id
WHERE e.source_type IN ('PERF_LEDGER') OR (e.source_type = 'JOURNAL_REVERSAL' AND e.document_number LIKE 'PJ-%');

-- 16. Non-ledger journals: their lines must not be in the model (covered by 10) and must not be LOCKED periods.
INSERT INTO verify_result
SELECT 'OPEN_DOCUMENTS_IN_LOCKED_PERIOD', 'WARNING', count(*), 'draft / submitted / approved journals in locked periods'
FROM journal_entries e JOIN fiscal_periods p ON p.id = e.fiscal_period_id
WHERE p.status = 'LOCKED' AND e.status IN ('DRAFT', 'SUBMITTED', 'APPROVED');

SELECT check_name, severity, violations,
       CASE WHEN violations = 0 THEN 'PASS' WHEN severity = 'CRITICAL' THEN 'FAIL' ELSE 'WARN' END AS result, detail
FROM verify_result ORDER BY (violations > 0 AND severity = 'CRITICAL') DESC, check_name;
SELECT count(*) FILTER (WHERE violations > 0 AND severity = 'CRITICAL') = 0 AS passed FROM verify_result \gset
\if :passed
\echo 'perf-verify: PASS'
\else
DO $$ BEGIN RAISE EXCEPTION 'perf-verify: FAIL - the run is not financially correct'; END $$;
\endif
