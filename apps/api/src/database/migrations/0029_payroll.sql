CREATE TYPE "public"."employee_payment_method" AS ENUM('BANK', 'CASH', 'CHECK');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('ACTIVE', 'ON_LEAVE', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."employment_type" AS ENUM('FULL_TIME', 'PART_TIME', 'CONTRACTOR');--> statement-breakpoint
CREATE TYPE "public"."pay_frequency" AS ENUM('MONTHLY', 'SEMI_MONTHLY', 'WEEKLY');--> statement-breakpoint
CREATE TYPE "public"."pay_item_calculation" AS ENUM('FIXED', 'PERCENT_OF_GROSS', 'BRACKET', 'BASE_SALARY');--> statement-breakpoint
CREATE TYPE "public"."pay_item_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."pay_item_type" AS ENUM('EARNING', 'DEDUCTION', 'WITHHOLDING_TAX', 'EMPLOYER_CONTRIBUTION');--> statement-breakpoint
CREATE TYPE "public"."pay_run_status" AS ENUM('DRAFT', 'CALCULATED', 'APPROVED', 'POSTED', 'PAID', 'REVERSED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'SALARY_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'EMPLOYER_CONTRIBUTION_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'STATUTORY_CONTRIBUTIONS_PAYABLE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'EMP';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PYR';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'PAY_RUN';--> statement-breakpoint
CREATE TABLE "employee_pay_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_id" uuid NOT NULL,
	"pay_item_id" uuid NOT NULL,
	"amount" numeric(19, 4),
	"rate" numeric(19, 4),
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"employee_number" text NOT NULL,
	"user_id" uuid,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text,
	"job_title" text,
	"employment_type" "employment_type" DEFAULT 'FULL_TIME' NOT NULL,
	"pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"base_salary" numeric(19, 4) NOT NULL,
	"hire_date" date NOT NULL,
	"termination_date" date,
	"status" "employee_status" DEFAULT 'ACTIVE' NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"tax_identification_number" text,
	"payment_method" "employee_payment_method" DEFAULT 'BANK' NOT NULL,
	"bank_name" text,
	"bank_account_number" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_salary_chk" CHECK ("employees"."base_salary" >= 0)
);
--> statement-breakpoint
CREATE TABLE "pay_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "pay_item_type" NOT NULL,
	"calculation" "pay_item_calculation" NOT NULL,
	"description" text,
	"amount" numeric(19, 4),
	"rate" numeric(19, 4),
	"max_base" numeric(19, 4),
	"brackets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"applies_to_all" boolean DEFAULT false NOT NULL,
	"expense_account_id" uuid,
	"liability_account_id" uuid,
	"sort_order" integer DEFAULT 100 NOT NULL,
	"status" "pay_item_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_run_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"pay_item_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"pay_frequency" "pay_frequency" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"pay_date" date NOT NULL,
	"description" text,
	"status" "pay_run_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" text NOT NULL,
	"employee_count" integer DEFAULT 0 NOT NULL,
	"gross_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"taxable_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"withholding_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deduction_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reimbursement_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"bank_account_id" uuid,
	"journal_entry_id" uuid,
	"payment_journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"payment_date" date,
	"payment_reference" text,
	"reversal_reason" text,
	"calculated_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"reversed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pay_runs_period_chk" CHECK ("pay_runs"."period_end" >= "pay_runs"."period_start")
);
--> statement-breakpoint
CREATE TABLE "payroll_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"default_pay_frequency" "pay_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"payroll_bank_account_id" uuid,
	"reimburse_expense_claims" boolean DEFAULT true NOT NULL,
	"pay_date_reminder_days" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslip_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payslip_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"pay_item_id" uuid,
	"expense_claim_id" uuid,
	"type" "pay_item_type" NOT NULL,
	"code" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"account_id" uuid NOT NULL,
	"offset_account_id" uuid,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_number" text NOT NULL,
	"employee_name" text NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"base_salary" numeric(19, 4) NOT NULL,
	"gross" numeric(19, 4) DEFAULT '0' NOT NULL,
	"taxable" numeric(19, 4) DEFAULT '0' NOT NULL,
	"withholding" numeric(19, 4) DEFAULT '0' NOT NULL,
	"deductions" numeric(19, 4) DEFAULT '0' NOT NULL,
	"employer_contributions" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reimbursements" numeric(19, 4) DEFAULT '0' NOT NULL,
	"net" numeric(19, 4) DEFAULT '0' NOT NULL,
	"payment_method" "employee_payment_method" DEFAULT 'BANK' NOT NULL,
	"bank_name" text,
	"bank_account_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_payroll_posted" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "employee_pay_items" ADD CONSTRAINT "employee_pay_items_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_pay_items" ADD CONSTRAINT "employee_pay_items_pay_item_id_pay_items_id_fk" FOREIGN KEY ("pay_item_id") REFERENCES "public"."pay_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_items" ADD CONSTRAINT "pay_items_liability_account_id_accounts_id_fk" FOREIGN KEY ("liability_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_inputs" ADD CONSTRAINT "pay_run_inputs_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_inputs" ADD CONSTRAINT "pay_run_inputs_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_run_inputs" ADD CONSTRAINT "pay_run_inputs_pay_item_id_pay_items_id_fk" FOREIGN KEY ("pay_item_id") REFERENCES "public"."pay_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_payment_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD CONSTRAINT "pay_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_payroll_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("payroll_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_payslip_id_payslips_id_fk" FOREIGN KEY ("payslip_id") REFERENCES "public"."payslips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_pay_item_id_pay_items_id_fk" FOREIGN KEY ("pay_item_id") REFERENCES "public"."pay_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_expense_claim_id_expense_claims_id_fk" FOREIGN KEY ("expense_claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD CONSTRAINT "payslip_lines_offset_account_id_accounts_id_fk" FOREIGN KEY ("offset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslips" ADD CONSTRAINT "payslips_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_pay_items_employee_idx" ON "employee_pay_items" USING btree ("employee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_number_uq" ON "employees" USING btree ("company_id","employee_number");--> statement-breakpoint
CREATE UNIQUE INDEX "employees_company_user_uq" ON "employees" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "employees_company_status_idx" ON "employees" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_items_company_code_uq" ON "pay_items" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "pay_run_inputs_run_idx" ON "pay_run_inputs" USING btree ("pay_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_runs_company_number_uq" ON "pay_runs" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "pay_runs_company_period_idx" ON "pay_runs" USING btree ("company_id","period_end");--> statement-breakpoint
CREATE INDEX "pay_runs_company_status_idx" ON "pay_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_lines_sequence_uq" ON "payslip_lines" USING btree ("payslip_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "payslips_run_employee_uq" ON "payslips" USING btree ("pay_run_id","employee_id");--> statement-breakpoint
CREATE INDEX "payslips_employee_idx" ON "payslips" USING btree ("employee_id");