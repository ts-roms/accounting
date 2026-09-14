-- Posted journal entries (POSTED / LOCKED / REVERSED) are immutable.
-- The application never edits them either; these triggers make the rule hold
-- for any client, including ad-hoc SQL.

CREATE OR REPLACE FUNCTION journal_entries_guard_posted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('POSTED', 'LOCKED', 'REVERSED') THEN
    IF NEW.status NOT IN ('POSTED', 'LOCKED', 'REVERSED') THEN
      RAISE EXCEPTION 'journal entry % is posted and cannot return to %', OLD.document_number, NEW.status
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.company_id <> OLD.company_id
       OR NEW.fiscal_period_id <> OLD.fiscal_period_id
       OR NEW.document_number <> OLD.document_number
       OR NEW.journal_type <> OLD.journal_type
       OR NEW.entry_date <> OLD.entry_date
       OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
       OR NEW.description <> OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.currency <> OLD.currency
       OR NEW.total_debit <> OLD.total_debit
       OR NEW.total_credit <> OLD.total_credit
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.source_type IS DISTINCT FROM OLD.source_type
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.reversal_of_id IS DISTINCT FROM OLD.reversal_of_id
       OR NEW.posted_by IS DISTINCT FROM OLD.posted_by
       OR NEW.posted_at IS DISTINCT FROM OLD.posted_at
    THEN
      RAISE EXCEPTION 'journal entry % is posted and immutable', OLD.document_number
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_entries_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('POSTED', 'LOCKED', 'REVERSED') THEN
    RAISE EXCEPTION 'journal entry % is posted and cannot be deleted', OLD.document_number
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal_lines_guard_posted()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry_status journal_status;
  entry_id uuid;
BEGIN
  entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  SELECT status INTO entry_status FROM journal_entries WHERE id = entry_id;
  IF entry_status IN ('POSTED', 'LOCKED', 'REVERSED') THEN
    RAISE EXCEPTION 'lines of a posted journal entry are immutable (%)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER journal_entries_immutable_when_posted
  BEFORE UPDATE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard_posted();
--> statement-breakpoint
CREATE TRIGGER journal_entries_no_delete_when_posted
  BEFORE DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION journal_entries_reject_delete();
--> statement-breakpoint
CREATE TRIGGER journal_lines_immutable_when_posted
  BEFORE INSERT OR UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION journal_lines_guard_posted();
