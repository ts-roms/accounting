CREATE TYPE "public"."lease_classification" AS ENUM('FINANCE', 'SHORT_TERM', 'LOW_VALUE');--> statement-breakpoint
CREATE TYPE "public"."lease_event_type" AS ENUM('COMMENCEMENT', 'INTEREST', 'DEPRECIATION', 'PAYMENT', 'REMEASUREMENT', 'TERMINATION');--> statement-breakpoint
CREATE TYPE "public"."lease_line_status" AS ENUM('PENDING', 'POSTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."lease_payment_frequency" AS ENUM('MONTHLY', 'QUARTERLY', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "public"."lease_payment_timing" AS ENUM('IN_ADVANCE', 'IN_ARREARS');--> statement-breakpoint
CREATE TYPE "public"."lease_run_status" AS ENUM('POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."lease_status" AS ENUM('DRAFT', 'ACTIVE', 'COMPLETED', 'TERMINATED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'RIGHT_OF_USE_ASSET';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'ROU_ACCUMULATED_DEPRECIATION';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'LEASE_LIABILITY';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'LEASE_INTEREST_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'LEASE_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'LSE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'LRN';--> statement-breakpoint
ALTER TYPE "public"."asset_event_type" ADD VALUE 'SPLIT';--> statement-breakpoint
CREATE TABLE "lease_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"event_type" "lease_event_type" NOT NULL,
	"event_date" date NOT NULL,
	"liability_change" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rou_change" numeric(19, 4) DEFAULT '0' NOT NULL,
	"liability_after" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rou_carrying_after" numeric(19, 4) DEFAULT '0' NOT NULL,
	"run_id" uuid,
	"journal_entry_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"period_end" date NOT NULL,
	"description" text,
	"status" "lease_run_status" DEFAULT 'POSTED' NOT NULL,
	"currency" char(3) NOT NULL,
	"interest_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"depreciation_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"lease_count" integer DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lease_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"opening_liability" numeric(19, 4) DEFAULT '0' NOT NULL,
	"interest" numeric(19, 4) DEFAULT '0' NOT NULL,
	"depreciation" numeric(19, 4) DEFAULT '0' NOT NULL,
	"payment" numeric(19, 4) DEFAULT '0' NOT NULL,
	"payment_date" date,
	"closing_liability" numeric(19, 4) DEFAULT '0' NOT NULL,
	"status" "lease_line_status" DEFAULT 'PENDING' NOT NULL,
	"run_id" uuid,
	"journal_entry_id" uuid,
	"posted_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"paid_date" date,
	"paid_bank_account_id" uuid,
	"payment_journal_entry_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lease_schedule_lines_amounts_chk" CHECK ("lease_schedule_lines"."interest" >= 0 AND "lease_schedule_lines"."depreciation" >= 0 AND "lease_schedule_lines"."payment" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lease_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"short_term_threshold_months" integer DEFAULT 12 NOT NULL,
	"low_value_threshold" numeric(19, 4) DEFAULT '0' NOT NULL,
	"auto_post_runs" boolean DEFAULT false NOT NULL,
	"default_discount_rate" numeric(19, 4) DEFAULT '8' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lease_number" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"vendor_id" uuid,
	"asset_category_id" uuid,
	"status" "lease_status" DEFAULT 'DRAFT' NOT NULL,
	"classification" "lease_classification" DEFAULT 'FINANCE' NOT NULL,
	"classification_override" "lease_classification",
	"commencement_date" date NOT NULL,
	"term_months" integer NOT NULL,
	"payment_amount" numeric(19, 4) NOT NULL,
	"payment_frequency" "lease_payment_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"payment_timing" "lease_payment_timing" DEFAULT 'IN_ADVANCE' NOT NULL,
	"annual_discount_rate" numeric(19, 4),
	"initial_direct_costs" numeric(19, 4) DEFAULT '0' NOT NULL,
	"lease_incentives" numeric(19, 4) DEFAULT '0' NOT NULL,
	"underlying_asset_value" numeric(19, 4),
	"currency" char(3) NOT NULL,
	"initial_liability" numeric(19, 4) DEFAULT '0' NOT NULL,
	"liability_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rou_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rou_accumulated_depreciation" numeric(19, 4) DEFAULT '0' NOT NULL,
	"rou_asset_account_id" uuid,
	"rou_accumulated_account_id" uuid,
	"liability_account_id" uuid,
	"interest_expense_account_id" uuid,
	"depreciation_expense_account_id" uuid,
	"lease_expense_account_id" uuid,
	"bank_account_id" uuid,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"location" text,
	"reference" text,
	"commencement_journal_entry_id" uuid,
	"commenced_at" timestamp with time zone,
	"termination_date" date,
	"termination_gain_loss" numeric(19, 4),
	"termination_journal_entry_id" uuid,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leases_amounts_chk" CHECK ("leases"."payment_amount" > 0 AND "leases"."term_months" > 0 AND "leases"."initial_direct_costs" >= 0 AND "leases"."lease_incentives" >= 0 AND "leases"."liability_balance" >= 0 AND "leases"."rou_cost" >= 0 AND "leases"."rou_accumulated_depreciation" >= 0 AND "leases"."rou_accumulated_depreciation" <= "leases"."rou_cost")
);
--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_lease_runs" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_run_id_lease_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lease_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_events" ADD CONSTRAINT "lease_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_runs" ADD CONSTRAINT "lease_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_runs" ADD CONSTRAINT "lease_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_runs" ADD CONSTRAINT "lease_runs_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_runs" ADD CONSTRAINT "lease_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_lease_id_leases_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."leases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_run_id_lease_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."lease_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_paid_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("paid_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD CONSTRAINT "lease_schedule_lines_payment_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lease_settings" ADD CONSTRAINT "lease_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_asset_category_id_asset_categories_id_fk" FOREIGN KEY ("asset_category_id") REFERENCES "public"."asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_rou_asset_account_id_accounts_id_fk" FOREIGN KEY ("rou_asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_rou_accumulated_account_id_accounts_id_fk" FOREIGN KEY ("rou_accumulated_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_interest_expense_account_id_accounts_id_fk" FOREIGN KEY ("interest_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_depreciation_expense_account_id_accounts_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_lease_expense_account_id_accounts_id_fk" FOREIGN KEY ("lease_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_commencement_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("commencement_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_termination_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("termination_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leases" ADD CONSTRAINT "leases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lease_events_lease_idx" ON "lease_events" USING btree ("lease_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "lease_runs_company_number_uq" ON "lease_runs" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "lease_runs_company_period_idx" ON "lease_runs" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE INDEX "lease_schedule_lines_lease_idx" ON "lease_schedule_lines" USING btree ("lease_id","sequence");--> statement-breakpoint
CREATE INDEX "lease_schedule_lines_status_idx" ON "lease_schedule_lines" USING btree ("company_id","status","period_end");--> statement-breakpoint
CREATE INDEX "lease_schedule_lines_run_idx" ON "lease_schedule_lines" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leases_company_number_uq" ON "leases" USING btree ("company_id","lease_number");--> statement-breakpoint
CREATE INDEX "leases_company_status_idx" ON "leases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "leases_vendor_idx" ON "leases" USING btree ("vendor_id");