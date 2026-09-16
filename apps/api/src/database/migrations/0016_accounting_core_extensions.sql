CREATE TYPE "public"."cash_flow_activity" AS ENUM('OPERATING', 'INVESTING', 'FINANCING');--> statement-breakpoint
CREATE TYPE "public"."dimension_rule_scope" AS ENUM('ACCOUNT', 'ACCOUNT_TYPE', 'CODE_PREFIX');--> statement-breakpoint
CREATE TYPE "public"."prepayment_schedule_status" AS ENUM('PENDING', 'RECOGNIZED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."prepayment_status" AS ENUM('DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."recurring_frequency" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY');--> statement-breakpoint
CREATE TYPE "public"."recurring_journal_mode" AS ENUM('DRAFT', 'AUTO_POST');--> statement-breakpoint
CREATE TYPE "public"."recurring_journal_status" AS ENUM('ACTIVE', 'PAUSED', 'COMPLETED');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'OPENING_BALANCE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECURRING_RUN';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RECOGNIZE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'PAUSE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'RESUME';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'OPENING_BALANCE_EQUITY';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'SUSPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_subtype" ADD VALUE 'SUSPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'OTHER_INCOME';--> statement-breakpoint
ALTER TYPE "public"."account_type" ADD VALUE 'OTHER_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."journal_type" ADD VALUE 'ACCRUAL' BEFORE 'REVERSAL';--> statement-breakpoint
ALTER TYPE "public"."journal_type" ADD VALUE 'RECLASSIFICATION' BEFORE 'REVERSAL';--> statement-breakpoint
CREATE TABLE "dimension_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope" "dimension_rule_scope" NOT NULL,
	"account_id" uuid,
	"account_type" "account_type",
	"code_prefix" text,
	"dimension_type" "dimension_type" NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dimension_rules_scope_chk" CHECK (("dimension_rules"."scope" = 'ACCOUNT' AND "dimension_rules"."account_id" IS NOT NULL) OR ("dimension_rules"."scope" = 'ACCOUNT_TYPE' AND "dimension_rules"."account_type" IS NOT NULL) OR ("dimension_rules"."scope" = 'CODE_PREFIX' AND "dimension_rules"."code_prefix" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "posting_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"transaction_type" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"journal_type" "journal_type" DEFAULT 'GENERAL' NOT NULL,
	"lines" jsonb NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prepayment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"prepayment_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"recognition_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"status" "prepayment_schedule_status" DEFAULT 'PENDING' NOT NULL,
	"journal_entry_id" uuid,
	"recognized_at" timestamp with time zone,
	CONSTRAINT "prepayment_schedules_amount_chk" CHECK ("prepayment_schedules"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "prepayments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"reference" text,
	"prepaid_account_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"credit_account_id" uuid,
	"currency" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"recognized_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"start_date" date NOT NULL,
	"months" integer NOT NULL,
	"status" "prepayment_status" DEFAULT 'DRAFT' NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"initial_entry_id" uuid,
	"created_by" uuid,
	"activated_by" uuid,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prepayments_amount_chk" CHECK ("prepayments"."amount" > 0),
	CONSTRAINT "prepayments_months_chk" CHECK ("prepayments"."months" BETWEEN 1 AND 120),
	CONSTRAINT "prepayments_recognized_chk" CHECK ("prepayments"."recognized_amount" >= 0 AND "prepayments"."recognized_amount" <= "prepayments"."amount")
);
--> statement-breakpoint
CREATE TABLE "recurring_journal_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recurring_journal_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"run_date" date NOT NULL,
	"journal_entry_id" uuid,
	"reversal_entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_journals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"journal_type" "journal_type" DEFAULT 'GENERAL' NOT NULL,
	"frequency" "recurring_frequency" NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"max_occurrences" integer,
	"next_run_date" date,
	"last_run_date" date,
	"occurrences" integer DEFAULT 0 NOT NULL,
	"mode" "recurring_journal_mode" DEFAULT 'DRAFT' NOT NULL,
	"auto_reverse" boolean DEFAULT false NOT NULL,
	"branch_id" uuid,
	"lines" jsonb NOT NULL,
	"status" "recurring_journal_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"auto_post_approved_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_journals_interval_chk" CHECK ("recurring_journals"."interval" >= 1),
	CONSTRAINT "recurring_journals_range_chk" CHECK ("recurring_journals"."end_date" IS NULL OR "recurring_journals"."end_date" >= "recurring_journals"."start_date")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_reconciliation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "cash_flow_activity" "cash_flow_activity";--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "allowed_branch_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "document_date" date;--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "transaction_currency" char(3);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "exchange_rate" numeric(19, 8);--> statement-breakpoint
ALTER TABLE "journal_entries" ADD COLUMN "auto_reverse_date" date;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "foreign_debit" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "foreign_credit" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "exchange_rate" numeric(19, 8);--> statement-breakpoint
ALTER TABLE "dimension_rules" ADD CONSTRAINT "dimension_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_rules" ADD CONSTRAINT "dimension_rules_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posting_rules" ADD CONSTRAINT "posting_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayment_schedules" ADD CONSTRAINT "prepayment_schedules_prepayment_id_prepayments_id_fk" FOREIGN KEY ("prepayment_id") REFERENCES "public"."prepayments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayment_schedules" ADD CONSTRAINT "prepayment_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayment_schedules" ADD CONSTRAINT "prepayment_schedules_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_prepaid_account_id_accounts_id_fk" FOREIGN KEY ("prepaid_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_credit_account_id_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_initial_entry_id_journal_entries_id_fk" FOREIGN KEY ("initial_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepayments" ADD CONSTRAINT "prepayments_activated_by_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_recurring_journal_id_recurring_journals_id_fk" FOREIGN KEY ("recurring_journal_id") REFERENCES "public"."recurring_journals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_reversal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journal_runs" ADD CONSTRAINT "recurring_journal_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_journals" ADD CONSTRAINT "recurring_journals_auto_post_approved_by_users_id_fk" FOREIGN KEY ("auto_post_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dimension_rules_company_idx" ON "dimension_rules" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "posting_rules_company_type_uq" ON "posting_rules" USING btree ("company_id","transaction_type");--> statement-breakpoint
CREATE UNIQUE INDEX "prepayment_schedules_uq" ON "prepayment_schedules" USING btree ("prepayment_id","sequence");--> statement-breakpoint
CREATE INDEX "prepayment_schedules_due_idx" ON "prepayment_schedules" USING btree ("company_id","status","recognition_date");--> statement-breakpoint
CREATE INDEX "prepayments_company_status_idx" ON "prepayments" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journal_runs_uq" ON "recurring_journal_runs" USING btree ("recurring_journal_id","run_date");--> statement-breakpoint
CREATE INDEX "recurring_journal_runs_company_idx" ON "recurring_journal_runs" USING btree ("company_id","run_date");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_journals_company_name_uq" ON "recurring_journals" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX "recurring_journals_due_idx" ON "recurring_journals" USING btree ("company_id","status","next_run_date");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_entries_source_type_idx" ON "journal_entries" USING btree ("company_id","source_type");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_auto_reverse_chk" CHECK ("journal_entries"."auto_reverse_date" IS NULL OR "journal_entries"."auto_reverse_date" > "journal_entries"."entry_date");--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_fx_chk" CHECK (("journal_entries"."transaction_currency" IS NULL AND "journal_entries"."exchange_rate" IS NULL) OR ("journal_entries"."transaction_currency" IS NOT NULL AND "journal_entries"."exchange_rate" > 0));--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_foreign_chk" CHECK (("journal_lines"."foreign_debit" IS NULL AND "journal_lines"."foreign_credit" IS NULL) OR ("journal_lines"."foreign_debit" >= 0 AND "journal_lines"."foreign_credit" >= 0 AND ("journal_lines"."foreign_debit" = 0 OR "journal_lines"."foreign_credit" = 0)));--> statement-breakpoint
-- Posted entries stay immutable for the new header columns as well.
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
       OR NEW.document_date IS DISTINCT FROM OLD.document_date
       OR NEW.posting_date IS DISTINCT FROM OLD.posting_date
       OR NEW.description <> OLD.description
       OR NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.currency <> OLD.currency
       OR NEW.transaction_currency IS DISTINCT FROM OLD.transaction_currency
       OR NEW.exchange_rate IS DISTINCT FROM OLD.exchange_rate
       OR NEW.auto_reverse_date IS DISTINCT FROM OLD.auto_reverse_date
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
