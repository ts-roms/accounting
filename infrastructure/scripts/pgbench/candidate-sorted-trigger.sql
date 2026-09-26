-- The sorted, aggregated journal_entries_period_balance as first measured here; it shipped as
-- migration 0040_period_balance_lock_order.sql. Kept so a perf database still on 0037 can be
-- switched for a before / after comparison with deadlock-pair.sql / post-event.sql (prove the
-- result with perf-verify.sql).
CREATE OR REPLACE FUNCTION journal_entries_period_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  was_ledger boolean;
  is_ledger boolean;
  sign integer;
BEGIN
  was_ledger := TG_OP <> 'INSERT' AND OLD.status IN ('POSTED', 'LOCKED', 'REVERSED');
  is_ledger := TG_OP <> 'DELETE' AND NEW.status IN ('POSTED', 'LOCKED', 'REVERSED');
  IF was_ledger = is_ledger THEN RETURN COALESCE(NEW, OLD); END IF;
  sign := CASE WHEN is_ledger THEN 1 ELSE -1 END;
  INSERT INTO account_period_balances
    (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id, debit, credit, line_count)
  SELECT COALESCE(NEW.company_id, OLD.company_id), l.account_id,
         date_trunc('month', COALESCE(NEW.entry_date, OLD.entry_date))::date, COALESCE(NEW.journal_type, OLD.journal_type),
         l.branch_id, l.department_id, l.cost_center_id, l.project_id,
         sign * sum(l.debit), sign * sum(l.credit), sign * count(*)::int
  FROM journal_lines l
  WHERE l.journal_entry_id = COALESCE(NEW.id, OLD.id)
  GROUP BY l.account_id, l.branch_id, l.department_id, l.cost_center_id, l.project_id
  ORDER BY l.account_id, l.branch_id, l.department_id, l.cost_center_id, l.project_id
  ON CONFLICT (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id)
  DO UPDATE SET
    debit = account_period_balances.debit + EXCLUDED.debit,
    credit = account_period_balances.credit + EXCLUDED.credit,
    line_count = account_period_balances.line_count + EXCLUDED.line_count;
  RETURN COALESCE(NEW, OLD);
END;
$$;
