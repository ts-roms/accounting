-- EXPLAIN (ANALYZE, BUFFERS) of the statements behind the ledger reads, in the exact shape
-- GeneralLedgerService / IntegrityService emit them (Drizzle output, parameters inlined).
-- Throwaway perf database only (perf-ledger.sql); run twice and read the second (warm) run:
--
--   psql "$PERF_DB" -v company=ACME -v today=2026-09-18 -f infrastructure/scripts/perf-explain.sql
\set ON_ERROR_STOP on
\if :{?company} \else \set company ACME \endif
\if :{?today} \else \set today 2026-09-18 \endif
SELECT id AS cid FROM companies WHERE code = :'company' \gset
SELECT id AS heavy FROM accounts WHERE company_id = :'cid' AND code = 'P1HEAVY' \gset
SELECT date_trunc('month', :'today'::date)::date AS month_start,
       (date_trunc('month', :'today'::date) - interval '1 day')::date AS last_month_end,
       date_trunc('year', :'today'::date)::date AS year_start \gset
\pset pager off

\echo '=== Q1 activity(): whole months Jan..last month from the read model (trial balance / statements)'
EXPLAIN (ANALYZE, BUFFERS)
select apb.account_id, coalesce(sum(apb.debit), 0), coalesce(sum(apb.credit), 0)
from account_period_balances apb inner join accounts on accounts.id = apb.account_id
where apb.company_id = :'cid' and apb.period_start >= :'year_start' and apb.period_start <= (:'last_month_end'::date - interval '1 month' + interval '1 day')::date
group by apb.account_id;

\echo '=== Q2 lineActivity(): the same window straight from the lines (what every statement cost before 0037)'
EXPLAIN (ANALYZE, BUFFERS)
select jl.account_id, coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id inner join accounts on accounts.id = jl.account_id
where je.company_id = :'cid' and jl.company_id = :'cid' and je.status in ('POSTED', 'LOCKED', 'REVERSED')
  and je.entry_date <= :'last_month_end' and je.entry_date >= :'year_start'
group by jl.account_id;

\echo '=== Q3 partial edge: month-to-date days from the lines (every "as of today" read pays this)'
EXPLAIN (ANALYZE, BUFFERS)
select jl.account_id, coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id inner join accounts on accounts.id = jl.account_id
where je.company_id = :'cid' and jl.company_id = :'cid' and je.status in ('POSTED', 'LOCKED', 'REVERSED')
  and je.entry_date <= :'today' and je.entry_date >= :'month_start'
group by jl.account_id;

\echo '=== Q4 balance sheet as of today: all history months from the read model'
EXPLAIN (ANALYZE, BUFFERS)
select apb.account_id, coalesce(sum(apb.debit), 0), coalesce(sum(apb.credit), 0)
from account_period_balances apb inner join accounts on accounts.id = apb.account_id
where apb.company_id = :'cid' and apb.period_start >= '0001-01-01' and apb.period_start <= (:'month_start'::date - interval '1 month')::date
  and accounts.type in ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COST_OF_SALES', 'EXPENSE', 'OTHER_INCOME', 'OTHER_EXPENSE')
group by apb.account_id;

\echo '=== Q5 general ledger, heavy account: opening balance (all history before from, from the lines)'
EXPLAIN (ANALYZE, BUFFERS)
select coalesce(sum(jl.debit - jl.credit), 0)
from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id
where je.company_id = :'cid' and jl.company_id = :'cid' and jl.account_id = :'heavy'
  and je.status in ('POSTED', 'LOCKED', 'REVERSED') and je.entry_date < :'year_start';

\echo '=== Q6 general ledger, heavy account: YTD page 1 (window running balance over the whole range, then LIMIT)'
EXPLAIN (ANALYZE, BUFFERS)
select je.id, je.document_number, je.entry_date, jl.debit, jl.credit,
       sum(jl.debit - jl.credit) over (order by je.entry_date, je.document_number, jl.line_number rows between unbounded preceding and current row)
from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id
where je.company_id = :'cid' and jl.company_id = :'cid' and jl.account_id = :'heavy'
  and je.status in ('POSTED', 'LOCKED', 'REVERSED') and je.entry_date >= :'year_start' and je.entry_date <= :'today'
order by je.entry_date, je.document_number, jl.line_number
limit 100 offset 0;

\echo '=== Q7 general ledger, heavy account: YTD page 500 (OFFSET 49,900)'
EXPLAIN (ANALYZE, BUFFERS)
select je.id, je.document_number, je.entry_date, jl.debit, jl.credit,
       sum(jl.debit - jl.credit) over (order by je.entry_date, je.document_number, jl.line_number rows between unbounded preceding and current row)
from journal_lines jl inner join journal_entries je on je.id = jl.journal_entry_id
where je.company_id = :'cid' and jl.company_id = :'cid' and jl.account_id = :'heavy'
  and je.status in ('POSTED', 'LOCKED', 'REVERSED') and je.entry_date >= :'year_start' and je.entry_date <= :'today'
order by je.entry_date, je.document_number, jl.line_number
limit 100 offset 49900;

\echo '=== Q8 integrity UNBALANCED_JOURNAL (whole company, capped at 20)'
EXPLAIN (ANALYZE, BUFFERS)
select je.id, coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
from journal_entries je left join journal_lines jl on jl.journal_entry_id = je.id
where je.company_id = :'cid' and je.status in ('POSTED', 'LOCKED', 'REVERSED')
group by je.id
having coalesce(sum(jl.debit), 0) <> coalesce(sum(jl.credit), 0) or coalesce(sum(jl.debit), 0) <> je.total_debit or coalesce(sum(jl.credit), 0) <> je.total_credit
limit 20;

\echo '=== Q9 integrity PERIOD_BALANCES_VS_LEDGER (whole company)'
EXPLAIN (ANALYZE, BUFFERS)
with ledger as (
  select l.account_id, date_trunc('month', e.entry_date)::date as period_start, e.journal_type, l.branch_id, l.department_id,
         l.cost_center_id, l.project_id, sum(l.debit) as debit, sum(l.credit) as credit, count(*)::int as line_count
  from journal_lines l join journal_entries e on e.id = l.journal_entry_id
  where e.company_id = :'cid' and e.status in ('POSTED', 'LOCKED', 'REVERSED')
  group by 1, 2, 3, 4, 5, 6, 7
), stored as (
  select account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id, debit, credit, line_count
  from account_period_balances where company_id = :'cid'
)
select coalesce(s.account_id, l.account_id)
from stored s full outer join ledger l
  on l.account_id = s.account_id and l.period_start = s.period_start and l.journal_type = s.journal_type
 and l.branch_id is not distinct from s.branch_id and l.department_id is not distinct from s.department_id
 and l.cost_center_id is not distinct from s.cost_center_id and l.project_id is not distinct from s.project_id
where s.debit is distinct from l.debit or s.credit is distinct from l.credit or s.line_count is distinct from l.line_count
limit 20;

\echo '=== Q10 journal list page 1 + exact count (every journal list visit)'
EXPLAIN (ANALYZE, BUFFERS)
select count(*) from journal_entries where company_id = :'cid';

\echo '=== model shape: rows per company, rows per month, lines per model row'
select c.code,
       (select count(*) from account_period_balances b where b.company_id = c.id) as model_rows,
       (select count(*) from journal_lines l where l.company_id = c.id) as lines,
       round((select count(*) from journal_lines l where l.company_id = c.id)::numeric
             / nullif((select count(*) from account_period_balances b where b.company_id = c.id), 0), 2) as lines_per_model_row
from companies c where c.id = :'cid';
