CREATE TYPE "public"."ap_accrual_source" AS ENUM('RECEIVED_NOT_BILLED', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."ap_accrual_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."bill_hold_reason" AS ENUM('PRICE_DISCREPANCY', 'QUANTITY_DISCREPANCY', 'QUALITY_ISSUE', 'MISSING_RECEIPT', 'DUPLICATE_SUSPECTED', 'VENDOR_DISPUTE', 'DOCUMENTATION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."bill_hold_status" AS ENUM('ACTIVE', 'RELEASED');--> statement-breakpoint
CREATE TYPE "public"."payment_run_line_status" AS ENUM('SELECTED', 'EXCLUDED', 'PAID', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."payment_run_selection_mode" AS ENUM('DUE', 'DUE_OR_DISCOUNT', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."payment_run_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'EXECUTING', 'COMPLETED', 'PARTIALLY_COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."vendor_address_type" AS ENUM('REMIT_TO', 'ORDER_FROM', 'RETURN_TO');--> statement-breakpoint
CREATE TYPE "public"."vendor_hold_reason" AS ENUM('COMPLIANCE', 'QUALITY', 'DISPUTE', 'DUPLICATE', 'TAX_DOCUMENTS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."vendor_risk_rating" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."vendor_status" AS ENUM('PENDING', 'APPROVED', 'ON_HOLD', 'BLOCKED', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."vendor_type" AS ENUM('SUPPLIER', 'CONTRACTOR', 'SERVICE_PROVIDER', 'UTILITY', 'GOVERNMENT', 'EMPLOYEE', 'OTHER');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'PURCHASE_DISCOUNT';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'ACCRUED_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PMR';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'ACR';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'PAYMENT_RUN';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'VENDOR';--> statement-breakpoint
CREATE TABLE "ap_accrual_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"accrual_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"vendor_id" uuid,
	"order_id" uuid,
	"order_line_id" uuid,
	"description" text NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	CONSTRAINT "ap_accrual_lines_amount_chk" CHECK ("ap_accrual_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "ap_accruals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "ap_accrual_status" DEFAULT 'DRAFT' NOT NULL,
	"source" "ap_accrual_source" NOT NULL,
	"accrual_date" date NOT NULL,
	"reversal_date" date NOT NULL,
	"description" text,
	"total_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"reversed_by" uuid,
	"reversed_at" timestamp with time zone,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ap_accruals_dates_chk" CHECK ("ap_accruals"."reversal_date" > "ap_accruals"."accrual_date")
);
--> statement-breakpoint
CREATE TABLE "ap_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"aging_buckets" jsonb DEFAULT '[{"key":"current","label":"Current","from":-1000000,"to":0},{"key":"days1to30","label":"1-30","from":1,"to":30},{"key":"days31to60","label":"31-60","from":31,"to":60},{"key":"days61to90","label":"61-90","from":61,"to":90},{"key":"days91to120","label":"91-120","from":91,"to":120},{"key":"over120","label":"120+","from":121,"to":null}]'::jsonb NOT NULL,
	"dpo_window_days" integer DEFAULT 90 NOT NULL,
	"cash_requirement_horizons" jsonb DEFAULT '[7,30,60]'::jsonb NOT NULL,
	"due_soon_days" integer DEFAULT 7 NOT NULL,
	"discount_warn_days" integer DEFAULT 3 NOT NULL,
	"grni_age_warn_days" integer DEFAULT 30 NOT NULL,
	"require_payment_approval" boolean DEFAULT false NOT NULL,
	"require_run_approval" boolean DEFAULT true NOT NULL,
	"bill_approval_threshold" numeric(19, 4),
	"require_vendor_approval" boolean DEFAULT false NOT NULL,
	"require_po_for_stock_bills" boolean DEFAULT false NOT NULL,
	"block_duplicate_vendor_invoice" boolean DEFAULT false NOT NULL,
	"default_payment_term_id" uuid,
	"default_cash_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "bill_hold_status" DEFAULT 'ACTIVE' NOT NULL,
	"reason" "bill_hold_reason" NOT NULL,
	"note" text,
	"placed_by" uuid,
	"placed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"release_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_run_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "payment_run_line_status" DEFAULT 'SELECTED' NOT NULL,
	"open_amount" numeric(19, 4) NOT NULL,
	"discount_available" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_taken" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"due_date" date NOT NULL,
	"discount_date" date,
	"payment_id" uuid,
	"failure_reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_run_lines_amount_chk" CHECK ("payment_run_lines"."amount" >= 0 AND "payment_run_lines"."discount_taken" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"status" "payment_run_status" DEFAULT 'DRAFT' NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"currency" char(3) NOT NULL,
	"payment_date" date NOT NULL,
	"pay_through_date" date NOT NULL,
	"selection_mode" "payment_run_selection_mode" DEFAULT 'DUE_OR_DISCOUNT' NOT NULL,
	"method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"vendor_group_id" uuid,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"maximum_amount" numeric(19, 4),
	"description" text,
	"total_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_discount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"line_count" integer DEFAULT 0 NOT NULL,
	"vendor_count" integer DEFAULT 0 NOT NULL,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_note" text,
	"executed_by" uuid,
	"executed_at" timestamp with time zone,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"address_type" "vendor_address_type" NOT NULL,
	"label" text,
	"attention" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"country" char(2) DEFAULT 'PH' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"bank_name" text NOT NULL,
	"label" text,
	"account_name" text NOT NULL,
	"account_number" text NOT NULL,
	"routing_code" text,
	"currency" char(3) NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_by" uuid,
	"verified_at" timestamp with time zone,
	"notes" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"role" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"receives_remittance" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_payment_term_id" uuid,
	"default_withholding_tax_code_id" uuid,
	"default_expense_account_id" uuid,
	"require_bill_approval" boolean DEFAULT false NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_profiles" (
	"vendor_id" uuid PRIMARY KEY NOT NULL,
	"risk_rating" "vendor_risk_rating" DEFAULT 'LOW' NOT NULL,
	"payment_method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"minimum_payment_amount" numeric(19, 4),
	"require_bill_approval" boolean DEFAULT false NOT NULL,
	"allow_bills_without_po" boolean DEFAULT true NOT NULL,
	"hold_reason" "vendor_hold_reason",
	"hold_note" text,
	"hold_by" uuid,
	"hold_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"review_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" DROP CONSTRAINT "vendor_payment_allocations_source_chk";--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "discount_date" date;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "discount_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "discount_taken_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "goods_receipt_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "on_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD COLUMN "discount_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "payment_run_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "discount_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "vendor_type" "vendor_type" DEFAULT 'SUPPLIER' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "vendor_status" "vendor_status" DEFAULT 'APPROVED' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "vendor_group_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "default_withholding_tax_code_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "buyer_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "tax_registration_type" text;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_accrual_id_ap_accruals_id_fk" FOREIGN KEY ("accrual_id") REFERENCES "public"."ap_accruals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accrual_lines" ADD CONSTRAINT "ap_accrual_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_reversed_by_users_id_fk" FOREIGN KEY ("reversed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_accruals" ADD CONSTRAINT "ap_accruals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_settings" ADD CONSTRAINT "ap_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_settings" ADD CONSTRAINT "ap_settings_default_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("default_payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ap_settings" ADD CONSTRAINT "ap_settings_default_cash_account_id_accounts_id_fk" FOREIGN KEY ("default_cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_holds" ADD CONSTRAINT "bill_holds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_holds" ADD CONSTRAINT "bill_holds_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_holds" ADD CONSTRAINT "bill_holds_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_holds" ADD CONSTRAINT "bill_holds_placed_by_users_id_fk" FOREIGN KEY ("placed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_holds" ADD CONSTRAINT "bill_holds_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_run_id_payment_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."payment_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_run_lines" ADD CONSTRAINT "payment_run_lines_payment_id_vendor_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_cash_account_id_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_vendor_group_id_vendor_groups_id_fk" FOREIGN KEY ("vendor_group_id") REFERENCES "public"."vendor_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_cancelled_by_users_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_runs" ADD CONSTRAINT "payment_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_addresses" ADD CONSTRAINT "vendor_addresses_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bank_accounts" ADD CONSTRAINT "vendor_bank_accounts_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_groups" ADD CONSTRAINT "vendor_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_groups" ADD CONSTRAINT "vendor_groups_default_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("default_payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_groups" ADD CONSTRAINT "vendor_groups_default_withholding_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("default_withholding_tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_groups" ADD CONSTRAINT "vendor_groups_default_expense_account_id_accounts_id_fk" FOREIGN KEY ("default_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_hold_by_users_id_fk" FOREIGN KEY ("hold_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ap_accrual_lines_accrual_idx" ON "ap_accrual_lines" USING btree ("accrual_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_accruals_company_number_uq" ON "ap_accruals" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "ap_accruals_idempotency_uq" ON "ap_accruals" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ap_accruals_company_date_idx" ON "ap_accruals" USING btree ("company_id","accrual_date");--> statement-breakpoint
CREATE INDEX "bill_holds_bill_idx" ON "bill_holds" USING btree ("bill_id","status");--> statement-breakpoint
CREATE INDEX "bill_holds_company_status_idx" ON "bill_holds" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_run_lines_run_bill_uq" ON "payment_run_lines" USING btree ("run_id","bill_id");--> statement-breakpoint
CREATE INDEX "payment_run_lines_run_idx" ON "payment_run_lines" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "payment_run_lines_bill_idx" ON "payment_run_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_runs_company_number_uq" ON "payment_runs" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_runs_idempotency_uq" ON "payment_runs" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_runs_company_status_idx" ON "payment_runs" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "payment_runs_company_date_idx" ON "payment_runs" USING btree ("company_id","payment_date");--> statement-breakpoint
CREATE INDEX "vendor_addresses_vendor_idx" ON "vendor_addresses" USING btree ("vendor_id","address_type");--> statement-breakpoint
CREATE INDEX "vendor_bank_accounts_vendor_idx" ON "vendor_bank_accounts" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_contacts_vendor_idx" ON "vendor_contacts" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_groups_company_code_uq" ON "vendor_groups" USING btree ("company_id","code");--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_discount_payment_id_vendor_payments_id_fk" FOREIGN KEY ("discount_payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_payment_run_id_payment_runs_id_fk" FOREIGN KEY ("payment_run_id") REFERENCES "public"."payment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_vendor_group_id_vendor_groups_id_fk" FOREIGN KEY ("vendor_group_id") REFERENCES "public"."vendor_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_withholding_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("default_withholding_tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_buyer_id_users_id_fk" FOREIGN KEY ("buyer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vendor_bills_on_hold_idx" ON "vendor_bills" USING btree ("company_id","on_hold");--> statement-breakpoint
CREATE INDEX "vendor_payment_allocations_discount_idx" ON "vendor_payment_allocations" USING btree ("discount_payment_id");--> statement-breakpoint
CREATE INDEX "vendor_payments_run_idx" ON "vendor_payments" USING btree ("payment_run_id");--> statement-breakpoint
CREATE INDEX "vendors_group_idx" ON "vendors" USING btree ("vendor_group_id");--> statement-breakpoint
CREATE INDEX "vendors_status_idx" ON "vendors" USING btree ("company_id","vendor_status");--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_source_chk" CHECK (("vendor_payment_allocations"."payment_id" IS NOT NULL)::int + ("vendor_payment_allocations"."credit_note_id" IS NOT NULL)::int + ("vendor_payment_allocations"."discount_payment_id" IS NOT NULL)::int = 1);