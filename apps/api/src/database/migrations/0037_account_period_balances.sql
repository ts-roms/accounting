ALTER TYPE "public"."audit_action" ADD VALUE 'REBUILD';--> statement-breakpoint
CREATE TABLE "account_period_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"journal_type" "journal_type" NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "account_period_balances_key_uq" UNIQUE NULLS NOT DISTINCT("company_id","account_id","period_start","journal_type","branch_id","department_id","cost_center_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_period_balances" ADD CONSTRAINT "account_period_balances_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_period_balances_company_period_idx" ON "account_period_balances" USING btree ("company_id","period_start");--> statement-breakpoint
-- Maintenance: one row per (company, account, month, journal type, branch, dimensions).
-- Keyed exactly like the ledger reads (the line's own branch and dimensions), so full-month
-- sums here equal a scan of the lines. A line counts once its entry is in a ledger status; posted
-- entries and their lines are immutable (0003), so the only events are lines arriving on an
-- entry already in the ledger and an entry entering the ledger with its lines in place.
CREATE OR REPLACE FUNCTION account_period_balances_apply(
  p_company_id uuid, p_account_id uuid, p_entry_date date, p_journal_type journal_type,
  p_branch_id uuid, p_department_id uuid, p_cost_center_id uuid, p_project_id uuid,
  p_debit numeric, p_credit numeric, p_lines integer)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO account_period_balances
    (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id, debit, credit, line_count)
  VALUES
    (p_company_id, p_account_id, date_trunc('month', p_entry_date)::date, p_journal_type, p_branch_id, p_department_id, p_cost_center_id, p_project_id, p_debit, p_credit, p_lines)
  ON CONFLICT (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id)
  DO UPDATE SET
    debit = account_period_balances.debit + EXCLUDED.debit,
    credit = account_period_balances.credit + EXCLUDED.credit,
    line_count = account_period_balances.line_count + EXCLUDED.line_count;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_lines_period_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  e journal_entries%ROWTYPE;
  l journal_lines%ROWTYPE;
  sign integer;
BEGIN
  IF TG_OP = 'INSERT' THEN l := NEW; sign := 1;
  ELSIF TG_OP = 'DELETE' THEN l := OLD; sign := -1;
  ELSE
    -- Updates of a posted line are refused by the immutability trigger; draft lines carry nothing.
    RETURN NEW;
  END IF;
  SELECT * INTO e FROM journal_entries WHERE id = l.journal_entry_id;
  IF e.id IS NULL OR e.status NOT IN ('POSTED', 'LOCKED', 'REVERSED') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  PERFORM account_period_balances_apply(
    e.company_id, l.account_id, e.entry_date, e.journal_type,
    l.branch_id, l.department_id, l.cost_center_id, l.project_id,
    sign * l.debit, sign * l.credit, sign);
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_period_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  was_ledger boolean;
  is_ledger boolean;
  l journal_lines%ROWTYPE;
  sign integer;
BEGIN
  was_ledger := TG_OP <> 'INSERT' AND OLD.status IN ('POSTED', 'LOCKED', 'REVERSED');
  is_ledger := TG_OP <> 'DELETE' AND NEW.status IN ('POSTED', 'LOCKED', 'REVERSED');
  IF was_ledger = is_ledger THEN RETURN COALESCE(NEW, OLD); END IF;
  sign := CASE WHEN is_ledger THEN 1 ELSE -1 END;
  FOR l IN SELECT * FROM journal_lines WHERE journal_entry_id = COALESCE(NEW.id, OLD.id) LOOP
    PERFORM account_period_balances_apply(
      COALESCE(NEW.company_id, OLD.company_id), l.account_id,
      COALESCE(NEW.entry_date, OLD.entry_date), COALESCE(NEW.journal_type, OLD.journal_type),
      l.branch_id, l.department_id, l.cost_center_id, l.project_id,
      sign * l.debit, sign * l.credit, sign);
  END LOOP;
  RETURN COALESCE(NEW, OLD);
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_period_balance
  AFTER INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_lines_period_balance();
--> statement-breakpoint
CREATE TRIGGER journal_entries_period_balance
  AFTER INSERT OR UPDATE OF status OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_period_balance();
--> statement-breakpoint
-- Full rebuild for one company (repair after ad-hoc surgery; the integrity check names drift).
CREATE OR REPLACE FUNCTION rebuild_account_period_balances(p_company_id uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM account_period_balances WHERE company_id = p_company_id;
  INSERT INTO account_period_balances
    (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id, debit, credit, line_count)
  SELECT e.company_id, l.account_id, date_trunc('month', e.entry_date)::date, e.journal_type,
         l.branch_id, l.department_id, l.cost_center_id, l.project_id,
         SUM(l.debit), SUM(l.credit), COUNT(*)::int
  FROM journal_lines l
  JOIN journal_entries e ON e.id = l.journal_entry_id
  WHERE e.company_id = p_company_id AND e.status IN ('POSTED', 'LOCKED', 'REVERSED')
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
--> statement-breakpoint
-- Initial population for every company.
INSERT INTO account_period_balances
  (company_id, account_id, period_start, journal_type, branch_id, department_id, cost_center_id, project_id, debit, credit, line_count)
SELECT e.company_id, l.account_id, date_trunc('month', e.entry_date)::date, e.journal_type,
       l.branch_id, l.department_id, l.cost_center_id, l.project_id,
       SUM(l.debit), SUM(l.credit), COUNT(*)::int
FROM journal_lines l
JOIN journal_entries e ON e.id = l.journal_entry_id
WHERE e.status IN ('POSTED', 'LOCKED', 'REVERSED')
GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;
