ALTER TYPE "public"."audit_action" ADD VALUE 'PERIOD_SOFT_CLOSE' BEFORE 'YEAR_CLOSE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'PERIOD_LOCK' BEFORE 'YEAR_CLOSE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'CORRECT' BEFORE 'YEAR_CLOSE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECONCILIATION_APPROVE' BEFORE 'YEAR_CLOSE';--> statement-breakpoint
ALTER TYPE "public"."fiscal_period_status" ADD VALUE 'SOFT_CLOSED' BEFORE 'CLOSED';--> statement-breakpoint
ALTER TYPE "public"."fiscal_period_status" ADD VALUE 'LOCKED';--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "reopen_reason" text;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD COLUMN "locked_by" uuid;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "correction_of_id" uuid;--> statement-breakpoint
ALTER TABLE "fiscal_periods" ADD CONSTRAINT "fiscal_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_correction_of_id_journal_entries_id_fk" FOREIGN KEY ("correction_of_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_correction_idx" ON "journal_entries" USING btree ("correction_of_id");--> statement-breakpoint
-- A LOCKED fiscal period is final: no journal may become part of the ledger in
-- it, whatever client issues the write. (SOFT_CLOSED / CLOSED are enforced by
-- the posting service, which knows who is posting and why.)
CREATE OR REPLACE FUNCTION journal_entries_guard_locked_period()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  period_status text;
BEGIN
  IF NEW.status IN ('POSTED', 'LOCKED', 'REVERSED')
     AND (TG_OP = 'INSERT' OR OLD.status NOT IN ('POSTED', 'LOCKED', 'REVERSED')) THEN
    SELECT status INTO period_status FROM fiscal_periods WHERE id = NEW.fiscal_period_id;
    IF period_status = 'LOCKED' THEN
      RAISE EXCEPTION 'fiscal period of journal entry % is locked', NEW.document_number
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS journal_entries_guard_locked_period ON journal_entries;
--> statement-breakpoint
CREATE TRIGGER journal_entries_guard_locked_period
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION journal_entries_guard_locked_period();
