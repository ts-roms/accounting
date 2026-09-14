ALTER TYPE "public"."audit_action" ADD VALUE 'ESCALATE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'SOD_WARNING';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'VENDOR_BILL';--> statement-breakpoint
CREATE TABLE "field_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"audit_log_id" bigint NOT NULL,
	"organization_id" uuid,
	"company_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"field" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"changed_by" uuid,
	"changed_by_email" text,
	"reason" text,
	"correlation_id" text,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "financial_closes_period_live_uq";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_suspense" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD COLUMN "deadline_hours" integer;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD COLUMN "escalation_permission" text;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_block_on_suspense" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "suspense_materiality" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "suspense_max_age_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_audit_log_id_audit_logs_id_fk" FOREIGN KEY ("audit_log_id") REFERENCES "public"."audit_logs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_changes" ADD CONSTRAINT "field_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_changes_entity_idx" ON "field_changes" USING btree ("entity_type","entity_id","changed_at");--> statement-breakpoint
CREATE INDEX "field_changes_company_idx" ON "field_changes" USING btree ("company_id","changed_at");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "financial_closes_period_live_uq" ON "financial_closes" USING btree ("fiscal_period_id") WHERE "financial_closes"."status" IN ('IN_PROGRESS', 'READY', 'APPROVED');--> statement-breakpoint
-- Field-level history is append-only like the audit trail it derives from.
CREATE OR REPLACE FUNCTION field_changes_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'field_changes is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER field_changes_immutable
  BEFORE UPDATE OR DELETE ON "field_changes"
  FOR EACH ROW EXECUTE FUNCTION field_changes_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER field_changes_no_truncate
  BEFORE TRUNCATE ON "field_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION field_changes_reject_mutation();
