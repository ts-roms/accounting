CREATE TYPE "public"."dimension_type" AS ENUM('DEPARTMENT', 'COST_CENTER', 'PROJECT');--> statement-breakpoint
CREATE TYPE "public"."tax_applies_to" AS ENUM('SALES', 'PURCHASES', 'BOTH');--> statement-breakpoint
CREATE TYPE "public"."tax_kind" AS ENUM('SALES_TAX', 'WITHHOLDING');--> statement-breakpoint
CREATE TYPE "public"."tax_reporting_category" AS ENUM('TAXABLE', 'ZERO_RATED', 'EXEMPT', 'WITHHOLDING');--> statement-breakpoint
CREATE TYPE "public"."tax_side" AS ENUM('SALES', 'PURCHASES');--> statement-breakpoint
CREATE TYPE "public"."tax_source_type" AS ENUM('AR_DOCUMENT', 'AP_DOCUMENT', 'EXPENSE_CLAIM');--> statement-breakpoint
CREATE TYPE "public"."budget_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."budget_version_status" AS ENUM('DRAFT', 'APPROVED', 'SUPERSEDED');--> statement-breakpoint
CREATE TYPE "public"."expense_claim_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'POSTED', 'PAID', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'EMPLOYEE_PAYABLE' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'EXP';--> statement-breakpoint
CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dimension_type" "dimension_type" NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"start_date" date,
	"end_date" date,
	"manager_user_id" uuid,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dimensions_dates_chk" CHECK ("dimensions"."end_date" IS NULL OR "dimensions"."start_date" IS NULL OR "dimensions"."end_date" >= "dimensions"."start_date")
);
--> statement-breakpoint
CREATE TABLE "tax_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "tax_kind" NOT NULL,
	"applies_to" "tax_applies_to" NOT NULL,
	"reporting_category" "tax_reporting_category" NOT NULL,
	"sales_account_id" uuid,
	"purchase_account_id" uuid,
	"is_default_sales" boolean DEFAULT false NOT NULL,
	"is_default_purchases" boolean DEFAULT false NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_codes_accounts_chk" CHECK (("tax_codes"."applies_to" = 'PURCHASES' OR "tax_codes"."sales_account_id" IS NOT NULL) AND ("tax_codes"."applies_to" = 'SALES' OR "tax_codes"."purchase_account_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"rate_percent" numeric(19, 4) NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_rates_rate_chk" CHECK ("tax_rates"."rate_percent" >= 0 AND "tax_rates"."rate_percent" <= 100),
	CONSTRAINT "tax_rates_range_chk" CHECK ("tax_rates"."effective_to" IS NULL OR "tax_rates"."effective_to" >= "tax_rates"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "tax_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"tax_code_id" uuid NOT NULL,
	"side" "tax_side" NOT NULL,
	"source_type" "tax_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid,
	"document_number" text NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"party_id" uuid,
	"party_name" text,
	"party_tax_number" text,
	"transaction_date" date NOT NULL,
	"rate_percent" numeric(19, 4) NOT NULL,
	"base_amount" numeric(19, 4) NOT NULL,
	"tax_amount" numeric(19, 4) NOT NULL,
	"reversal_of_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"notes" text,
	CONSTRAINT "budget_lines_cell_uq" UNIQUE NULLS NOT DISTINCT("version_id","account_id","fiscal_period_id","department_id","cost_center_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "budget_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"status" "budget_version_status" DEFAULT 'DRAFT' NOT NULL,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "budget_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_claim_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"claim_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"expense_date" date NOT NULL,
	"description" text NOT NULL,
	"merchant" text,
	"receipt_reference" text,
	"account_id" uuid NOT NULL,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"tax_code_id" uuid,
	"tax_rate" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "expense_claim_lines_amount_chk" CHECK ("expense_claim_lines"."amount" > 0 AND "expense_claim_lines"."tax_amount" >= 0 AND "expense_claim_lines"."tax_amount" < "expense_claim_lines"."amount")
);
--> statement-breakpoint
CREATE TABLE "expense_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"claim_number" text NOT NULL,
	"claimant_user_id" uuid NOT NULL,
	"branch_id" uuid,
	"claim_date" date NOT NULL,
	"purpose" text NOT NULL,
	"notes" text,
	"status" "expense_claim_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"payment_journal_entry_id" uuid,
	"payment_bank_account_id" uuid,
	"payment_date" date,
	"payment_reference" text,
	"rejection_reason" text,
	"idempotency_key" text,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_claims_total_chk" CHECK ("expense_claims"."total" >= 0 AND "expense_claims"."tax_total" >= 0 AND "expense_claims"."tax_total" <= "expense_claims"."total")
);
--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_total_chk";--> statement-breakpoint
ALTER TABLE "vendor_bills" DROP CONSTRAINT "vendor_bills_total_chk";--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "tax_rate" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "withholding_tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "withholding_rate" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "withholding_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "department_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cost_center_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rate" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "withholding_tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "withholding_rate" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "withholding_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "withholding_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "withholding_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_parent_id_dimensions_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimensions" ADD CONSTRAINT "dimensions_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_sales_account_id_accounts_id_fk" FOREIGN KEY ("sales_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_codes" ADD CONSTRAINT "tax_codes_purchase_account_id_accounts_id_fk" FOREIGN KEY ("purchase_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_transactions" ADD CONSTRAINT "tax_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_version_id_budget_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."budget_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_lines" ADD CONSTRAINT "budget_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_versions" ADD CONSTRAINT "budget_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_fiscal_year_id_fiscal_years_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "public"."fiscal_years"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_claim_id_expense_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claim_lines" ADD CONSTRAINT "expense_claim_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_claimant_user_id_users_id_fk" FOREIGN KEY ("claimant_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_payment_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("payment_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_payment_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("payment_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_claims" ADD CONSTRAINT "expense_claims_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dimensions_company_type_code_uq" ON "dimensions" USING btree ("company_id","dimension_type","code");--> statement-breakpoint
CREATE INDEX "dimensions_company_type_idx" ON "dimensions" USING btree ("company_id","dimension_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_codes_company_code_uq" ON "tax_codes" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "tax_codes_company_idx" ON "tax_codes" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_code_from_uq" ON "tax_rates" USING btree ("tax_code_id","effective_from");--> statement-breakpoint
CREATE INDEX "tax_transactions_company_date_idx" ON "tax_transactions" USING btree ("company_id","transaction_date");--> statement-breakpoint
CREATE INDEX "tax_transactions_code_idx" ON "tax_transactions" USING btree ("tax_code_id","transaction_date");--> statement-breakpoint
CREATE INDEX "tax_transactions_source_idx" ON "tax_transactions" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "budget_lines_version_account_idx" ON "budget_lines" USING btree ("version_id","account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_number_uq" ON "budget_versions" USING btree ("budget_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_versions_approved_uq" ON "budget_versions" USING btree ("budget_id") WHERE "budget_versions"."status" = 'APPROVED';--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_company_code_uq" ON "budgets" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "budgets_company_year_idx" ON "budgets" USING btree ("company_id","fiscal_year_id");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claim_lines_number_uq" ON "expense_claim_lines" USING btree ("claim_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claims_company_number_uq" ON "expense_claims" USING btree ("company_id","claim_number");--> statement-breakpoint
CREATE UNIQUE INDEX "expense_claims_idempotency_uq" ON "expense_claims" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "expense_claims_company_status_idx" ON "expense_claims" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "expense_claims_claimant_idx" ON "expense_claims" USING btree ("claimant_user_id");--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_withholding_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("withholding_tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_withholding_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("withholding_tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "journal_lines_department_idx" ON "journal_lines" USING btree ("company_id","department_id");--> statement-breakpoint
CREATE INDEX "journal_lines_cost_center_idx" ON "journal_lines" USING btree ("company_id","cost_center_id");--> statement-breakpoint
CREATE INDEX "journal_lines_project_idx" ON "journal_lines" USING btree ("company_id","project_id");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_total_chk" CHECK ("invoices"."total" >= 0 AND "invoices"."total" = "invoices"."subtotal" + "invoices"."tax_total" - "invoices"."withholding_total");--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_total_chk" CHECK ("vendor_bills"."total" >= 0 AND "vendor_bills"."total" = "vendor_bills"."subtotal" + "vendor_bills"."tax_total" - "vendor_bills"."withholding_total");