CREATE TYPE "public"."revenue_policy_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."revenue_recognition_method" AS ENUM('POINT_IN_TIME', 'RATABLE', 'MILESTONE');--> statement-breakpoint
CREATE TYPE "public"."revenue_run_status" AS ENUM('POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."revenue_schedule_line_status" AS ENUM('PENDING', 'RECOGNIZED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."revenue_schedule_status" AS ENUM('ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'DEFERRED_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'RRN';--> statement-breakpoint
CREATE TABLE "revenue_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"method" "revenue_recognition_method" NOT NULL,
	"description" text,
	"default_term_months" integer,
	"auto_recognize" boolean DEFAULT true NOT NULL,
	"status" "revenue_policy_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_recognition_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"period_end" date NOT NULL,
	"description" text,
	"status" "revenue_run_status" DEFAULT 'POSTED' NOT NULL,
	"currency" text NOT NULL,
	"total_amount" numeric(19, 4) NOT NULL,
	"line_count" integer NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"reversed_at" timestamp with time zone,
	"reversal_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_schedule_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"schedule_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"recognition_date" date,
	"amount" numeric(19, 4) NOT NULL,
	"status" "revenue_schedule_line_status" DEFAULT 'PENDING' NOT NULL,
	"milestone_name" text,
	"milestone_percent" numeric(19, 4),
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"completion_note" text,
	"run_id" uuid,
	"journal_entry_id" uuid,
	"recognized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_schedule_lines_amount_chk" CHECK ("revenue_schedule_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "revenue_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"invoice_line_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"method" "revenue_recognition_method" NOT NULL,
	"description" text NOT NULL,
	"currency" text NOT NULL,
	"total_amount" numeric(19, 4) NOT NULL,
	"recognized_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deferred_account_id" uuid NOT NULL,
	"revenue_account_id" uuid NOT NULL,
	"service_start_date" date,
	"service_end_date" date,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"status" "revenue_schedule_status" DEFAULT 'ACTIVE' NOT NULL,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revenue_schedules_amount_chk" CHECK ("revenue_schedules"."total_amount" > 0 AND "revenue_schedules"."recognized_amount" >= 0 AND "revenue_schedules"."recognized_amount" <= "revenue_schedules"."total_amount")
);
--> statement-breakpoint
CREATE TABLE "revenue_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"auto_recognize" boolean DEFAULT false NOT NULL,
	"overdue_grace_days" integer DEFAULT 0 NOT NULL,
	"default_policy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "revenue_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "service_start_date" date;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "service_end_date" date;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "milestones" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "revenue_policy_id" uuid;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_revenue_recognition" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "revenue_policies" ADD CONSTRAINT "revenue_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_recognition_runs" ADD CONSTRAINT "revenue_recognition_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_recognition_runs" ADD CONSTRAINT "revenue_recognition_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_recognition_runs" ADD CONSTRAINT "revenue_recognition_runs_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_recognition_runs" ADD CONSTRAINT "revenue_recognition_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_schedule_id_revenue_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."revenue_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_run_id_revenue_recognition_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."revenue_recognition_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedule_lines" ADD CONSTRAINT "revenue_schedule_lines_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_invoice_line_id_invoice_lines_id_fk" FOREIGN KEY ("invoice_line_id") REFERENCES "public"."invoice_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_policy_id_revenue_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."revenue_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_deferred_account_id_accounts_id_fk" FOREIGN KEY ("deferred_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_schedules" ADD CONSTRAINT "revenue_schedules_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_settings" ADD CONSTRAINT "revenue_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_settings" ADD CONSTRAINT "revenue_settings_default_policy_id_revenue_policies_id_fk" FOREIGN KEY ("default_policy_id") REFERENCES "public"."revenue_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_policies_company_code_uq" ON "revenue_policies" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_runs_company_number_uq" ON "revenue_recognition_runs" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "revenue_runs_company_period_idx" ON "revenue_recognition_runs" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_schedule_lines_sequence_uq" ON "revenue_schedule_lines" USING btree ("schedule_id","sequence");--> statement-breakpoint
CREATE INDEX "revenue_schedule_lines_status_date_idx" ON "revenue_schedule_lines" USING btree ("status","recognition_date");--> statement-breakpoint
CREATE INDEX "revenue_schedule_lines_run_idx" ON "revenue_schedule_lines" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_schedules_invoice_line_uq" ON "revenue_schedules" USING btree ("invoice_line_id");--> statement-breakpoint
CREATE INDEX "revenue_schedules_company_status_idx" ON "revenue_schedules" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "revenue_schedules_invoice_idx" ON "revenue_schedules" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "revenue_schedules_customer_idx" ON "revenue_schedules" USING btree ("customer_id");--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_revenue_policy_id_revenue_policies_id_fk" FOREIGN KEY ("revenue_policy_id") REFERENCES "public"."revenue_policies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_revenue_policy_id_revenue_policies_id_fk" FOREIGN KEY ("revenue_policy_id") REFERENCES "public"."revenue_policies"("id") ON DELETE set null ON UPDATE no action;