-- Period-balance maintenance in a deterministic lock order.
--
-- 0037 applied an entry's lines one upsert per line, in whatever order the lines came back
-- (no ORDER BY). Two transactions posting journals that touch the same model rows in opposite
-- line order (Dr cash / Cr AR against Dr AR / Cr cash in the same month) each held one row and
-- waited for the other: a deadlock, one of them rolled back after deadlock_timeout.
--
-- Now an entry entering or leaving the ledger applies ONE upsert per distinct model key, in
-- key order. Same arithmetic (sums of the entry's lines per key are what the per-line upserts
-- added up to), so the model stays equal to the lines; PERIOD_BALANCES_VS_LEDGER proves it.
-- A journal with many lines on the same key also does fewer upserts.
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
    (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id,
     debit, credit, line_count)
  SELECT COALESCE(NEW.company_id, OLD.company_id), l.account_id,
         date_trunc('month', COALESCE(NEW.entry_date, OLD.entry_date))::date,
         COALESCE(NEW.journal_type, OLD.journal_type),
         l.branch_id, l.department_id, l.cost_center_id, l.project_id,
         sign * sum(l.debit), sign * sum(l.credit), sign * count(*)::int
  FROM journal_lines l
  WHERE l.journal_entry_id = COALESCE(NEW.id, OLD.id)
  GROUP BY l.account_id, l.branch_id, l.department_id, l.cost_center_id, l.project_id
  -- The lock order: every transaction takes the model rows of one entry in the same order.
  ORDER BY l.account_id, l.branch_id NULLS FIRST, l.department_id NULLS FIRST,
           l.cost_center_id NULLS FIRST, l.project_id NULLS FIRST
  ON CONFLICT (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id)
  DO UPDATE SET
    debit = account_period_balances.debit + EXCLUDED.debit,
    credit = account_period_balances.credit + EXCLUDED.credit,
    line_count = account_period_balances.line_count + EXCLUDED.line_count;
  RETURN COALESCE(NEW, OLD);
END;
$$;
