CREATE TYPE "public"."bank_account_type" AS ENUM('CURRENT', 'SAVINGS', 'TIME_DEPOSIT', 'CREDIT_LINE', 'PAYROLL', 'TRUST');--> statement-breakpoint
CREATE TYPE "public"."bank_transfer_purpose" AS ENUM('FUNDING', 'SWEEP', 'PAYROLL', 'FX', 'INVESTMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."bank_transfer_status" AS ENUM('DRAFT', 'APPROVED', 'SENT', 'SETTLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."forecast_granularity" AS ENUM('DAY', 'WEEK', 'MONTH');--> statement-breakpoint
CREATE TYPE "public"."forecast_item_direction" AS ENUM('INFLOW', 'OUTFLOW');--> statement-breakpoint
CREATE TYPE "public"."forecast_item_frequency" AS ENUM('ONCE', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUAL');--> statement-breakpoint
CREATE TYPE "public"."forecast_scenario" AS ENUM('BASE', 'OPTIMISTIC', 'PESSIMISTIC');--> statement-breakpoint
CREATE TYPE "public"."payment_file_format" AS ENUM('PESONET_CSV', 'ISO20022_PAIN001', 'POSITIVE_PAY_CSV');--> statement-breakpoint
CREATE TYPE "public"."payment_file_status" AS ENUM('GENERATED', 'TRANSMITTED', 'ACKNOWLEDGED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."petty_cash_fund_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."petty_cash_voucher_status" AS ENUM('DRAFT', 'APPROVED', 'POSTED', 'VOID');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'CASH_IN_TRANSIT';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'BTR';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PCV';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PMF';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'BANK_TRANSFER';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'PETTY_CASH_VOUCHER';--> statement-breakpoint
CREATE TABLE "bank_account_profiles" (
	"bank_account_id" uuid PRIMARY KEY NOT NULL,
	"account_type" "bank_account_type" DEFAULT 'CURRENT' NOT NULL,
	"purpose" text,
	"minimum_balance" numeric(19, 4),
	"target_balance" numeric(19, 4),
	"overdraft_limit" numeric(19, 4),
	"routing_code" text,
	"payment_file_format" "payment_file_format",
	"originator_id" text,
	"is_default_receipts" boolean DEFAULT false NOT NULL,
	"is_default_payments" boolean DEFAULT false NOT NULL,
	"signatories" text,
	"exclude_from_position" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "bank_transfer_status" DEFAULT 'DRAFT' NOT NULL,
	"purpose" "bank_transfer_purpose" DEFAULT 'FUNDING' NOT NULL,
	"from_bank_account_id" uuid NOT NULL,
	"to_bank_account_id" uuid NOT NULL,
	"transfer_date" date NOT NULL,
	"expected_settlement_date" date NOT NULL,
	"settlement_date" date,
	"amount" numeric(19, 4) NOT NULL,
	"from_currency" char(3) NOT NULL,
	"received_amount" numeric(19, 4) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"base_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"fx_difference" numeric(19, 4) DEFAULT '0' NOT NULL,
	"fee_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL,
	"reference" text,
	"bank_reference" text,
	"memo" text,
	"out_journal_entry_id" uuid,
	"in_journal_entry_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"sent_by" uuid,
	"sent_at" timestamp with time zone,
	"settled_by" uuid,
	"settled_at" timestamp with time zone,
	"cancel_reason" text,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transfers_amount_chk" CHECK ("bank_transfers"."amount" > 0 AND "bank_transfers"."received_amount" > 0 AND "bank_transfers"."fee_amount" >= 0),
	CONSTRAINT "bank_transfers_accounts_chk" CHECK ("bank_transfers"."from_bank_account_id" <> "bank_transfers"."to_bank_account_id")
);
--> statement-breakpoint
CREATE TABLE "cash_forecast_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"direction" "forecast_item_direction" NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"frequency" "forecast_item_frequency" DEFAULT 'MONTHLY' NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"bank_account_id" uuid,
	"category" text,
	"notes" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_forecast_items_amount_chk" CHECK ("cash_forecast_items"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "cash_forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"horizon_days" integer NOT NULL,
	"granularity" "forecast_granularity" NOT NULL,
	"scenario" "forecast_scenario" NOT NULL,
	"currency" char(3) NOT NULL,
	"opening_cash" numeric(19, 4) NOT NULL,
	"closing_cash" numeric(19, 4) NOT NULL,
	"minimum_cash" numeric(19, 4) NOT NULL,
	"total_inflows" numeric(19, 4) NOT NULL,
	"total_outflows" numeric(19, 4) NOT NULL,
	"buckets" jsonb NOT NULL,
	"breaches" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_file_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"beneficiary_name" text NOT NULL,
	"beneficiary_bank" text,
	"beneficiary_account" text,
	"beneficiary_routing" text,
	"remittance_info" text
);
--> statement-breakpoint
CREATE TABLE "payment_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "payment_file_status" DEFAULT 'GENERATED' NOT NULL,
	"format" "payment_file_format" NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"payment_run_id" uuid,
	"value_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"total_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"filename" text NOT NULL,
	"content" text NOT NULL,
	"checksum" text NOT NULL,
	"description" text,
	"bank_reference" text,
	"status_note" text,
	"transmitted_by" uuid,
	"transmitted_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "petty_cash_funds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" "petty_cash_fund_status" DEFAULT 'ACTIVE' NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"imprest_amount" numeric(19, 4) NOT NULL,
	"custodian_id" uuid NOT NULL,
	"branch_id" uuid,
	"voucher_approval_limit" numeric(19, 4),
	"replenish_at_percent" numeric(19, 4) DEFAULT '25' NOT NULL,
	"last_replenished_at" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_funds_imprest_chk" CHECK ("petty_cash_funds"."imprest_amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "petty_cash_voucher_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"voucher_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"tax_code_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	CONSTRAINT "petty_cash_voucher_lines_amount_chk" CHECK ("petty_cash_voucher_lines"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "petty_cash_vouchers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fund_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "petty_cash_voucher_status" DEFAULT 'DRAFT' NOT NULL,
	"voucher_date" date NOT NULL,
	"payee" text NOT NULL,
	"description" text,
	"receipt_reference" text,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"replenishment_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "petty_cash_vouchers_total_chk" CHECK ("petty_cash_vouchers"."total" >= 0)
);
--> statement-breakpoint
CREATE TABLE "treasury_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"forecast_horizon_days" integer DEFAULT 90 NOT NULL,
	"forecast_granularity" "forecast_granularity" DEFAULT 'WEEK' NOT NULL,
	"collection_probabilities" jsonb DEFAULT '{"current":"0.95","days1to30":"0.85","days31to60":"0.65","days61to90":"0.45","days91to120":"0.25","over120":"0.10"}'::jsonb NOT NULL,
	"scenarios" jsonb DEFAULT '{"BASE":{"inflowFactor":"1","outflowFactor":"1","inflowDelayDays":0},"OPTIMISTIC":{"inflowFactor":"1.1","outflowFactor":"0.95","inflowDelayDays":0},"PESSIMISTIC":{"inflowFactor":"0.8","outflowFactor":"1.05","inflowDelayDays":14}}'::jsonb NOT NULL,
	"minimum_days_cash_on_hand" integer DEFAULT 30 NOT NULL,
	"burn_window_days" integer DEFAULT 90 NOT NULL,
	"transfer_approval_threshold" numeric(19, 4),
	"unsettled_transfer_warn_days" integer DEFAULT 2 NOT NULL,
	"default_payment_file_format" "payment_file_format" DEFAULT 'PESONET_CSV' NOT NULL,
	"originator_name" text,
	"petty_cash_voucher_limit" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_account_profiles" ADD CONSTRAINT "bank_account_profiles_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_from_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("from_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_to_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("to_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_out_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("out_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_in_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("in_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_settled_by_users_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transfers" ADD CONSTRAINT "bank_transfers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_snapshots" ADD CONSTRAINT "cash_forecast_snapshots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_snapshots" ADD CONSTRAINT "cash_forecast_snapshots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_file_lines" ADD CONSTRAINT "payment_file_lines_file_id_payment_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."payment_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_file_lines" ADD CONSTRAINT "payment_file_lines_payment_id_vendor_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_payment_run_id_payment_runs_id_fk" FOREIGN KEY ("payment_run_id") REFERENCES "public"."payment_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_transmitted_by_users_id_fk" FOREIGN KEY ("transmitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_files" ADD CONSTRAINT "payment_files_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_gl_account_id_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_custodian_id_users_id_fk" FOREIGN KEY ("custodian_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_funds" ADD CONSTRAINT "petty_cash_funds_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_voucher_id_petty_cash_vouchers_id_fk" FOREIGN KEY ("voucher_id") REFERENCES "public"."petty_cash_vouchers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_voucher_lines" ADD CONSTRAINT "petty_cash_voucher_lines_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_fund_id_petty_cash_funds_id_fk" FOREIGN KEY ("fund_id") REFERENCES "public"."petty_cash_funds"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_replenishment_id_bank_transactions_id_fk" FOREIGN KEY ("replenishment_id") REFERENCES "public"."bank_transactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "petty_cash_vouchers" ADD CONSTRAINT "petty_cash_vouchers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "treasury_settings" ADD CONSTRAINT "treasury_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfers_company_number_uq" ON "bank_transfers" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transfers_idempotency_uq" ON "bank_transfers" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bank_transfers_company_status_idx" ON "bank_transfers" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "bank_transfers_from_idx" ON "bank_transfers" USING btree ("from_bank_account_id");--> statement-breakpoint
CREATE INDEX "bank_transfers_to_idx" ON "bank_transfers" USING btree ("to_bank_account_id");--> statement-breakpoint
CREATE INDEX "cash_forecast_items_company_idx" ON "cash_forecast_items" USING btree ("company_id","active");--> statement-breakpoint
CREATE INDEX "cash_forecast_snapshots_company_idx" ON "cash_forecast_snapshots" USING btree ("company_id","as_of");--> statement-breakpoint
CREATE INDEX "payment_file_lines_payment_idx" ON "payment_file_lines" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_file_lines_file_idx" ON "payment_file_lines" USING btree ("file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_files_company_number_uq" ON "payment_files" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "payment_files_company_status_idx" ON "payment_files" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "payment_files_bank_idx" ON "payment_files" USING btree ("bank_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_funds_company_code_uq" ON "petty_cash_funds" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_funds_gl_account_uq" ON "petty_cash_funds" USING btree ("gl_account_id");--> statement-breakpoint
CREATE INDEX "petty_cash_voucher_lines_voucher_idx" ON "petty_cash_voucher_lines" USING btree ("voucher_id");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_vouchers_company_number_uq" ON "petty_cash_vouchers" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "petty_cash_vouchers_idempotency_uq" ON "petty_cash_vouchers" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "petty_cash_vouchers_fund_idx" ON "petty_cash_vouchers" USING btree ("fund_id","status");