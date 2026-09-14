CREATE TYPE "public"."asset_event_type" AS ENUM('CAPITALIZATION', 'DEPRECIATION', 'TRANSFER', 'IMPAIRMENT', 'REVALUATION', 'DISPOSAL', 'WRITE_OFF');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('DRAFT', 'ACTIVE', 'FULLY_DEPRECIATED', 'DISPOSED', 'WRITTEN_OFF');--> statement-breakpoint
CREATE TYPE "public"."bank_transaction_status" AS ENUM('DRAFT', 'POSTED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."bank_transaction_type" AS ENUM('DEPOSIT', 'WITHDRAWAL', 'TRANSFER', 'BANK_FEE', 'INTEREST');--> statement-breakpoint
CREATE TYPE "public"."depreciation_method" AS ENUM('STRAIGHT_LINE', 'DECLINING_BALANCE');--> statement-breakpoint
CREATE TYPE "public"."depreciation_run_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."match_kind" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_status" AS ENUM('IN_PROGRESS', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."statement_line_status" AS ENUM('UNMATCHED', 'MATCHED', 'DUPLICATE', 'EXCEPTION', 'RECONCILED');--> statement-breakpoint
CREATE TYPE "public"."statement_status" AS ENUM('OPEN', 'RECONCILED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'FIXED_ASSET_COST' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'ACCUMULATED_DEPRECIATION' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'DEPRECIATION_EXPENSE' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'FIXED_ASSET_CLEARING' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'GAIN_LOSS_ON_DISPOSAL' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'IMPAIRMENT_LOSS' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'REVALUATION_SURPLUS' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'FA';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'DEP';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'BTX';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'STM';--> statement-breakpoint
CREATE TABLE "asset_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"useful_life_months" integer DEFAULT 60 NOT NULL,
	"depreciation_method" "depreciation_method" DEFAULT 'STRAIGHT_LINE' NOT NULL,
	"declining_rate_percent" numeric(19, 4),
	"asset_account_id" uuid,
	"accumulated_depreciation_account_id" uuid,
	"depreciation_expense_account_id" uuid,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_categories_life_chk" CHECK ("asset_categories"."useful_life_months" > 0)
);
--> statement-breakpoint
CREATE TABLE "asset_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"event_type" "asset_event_type" NOT NULL,
	"event_date" date NOT NULL,
	"amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"book_value_after" numeric(19, 4) NOT NULL,
	"depreciation_run_id" uuid,
	"fiscal_period_id" uuid,
	"journal_entry_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"bank_name" text,
	"account_number" text,
	"currency" char(3) NOT NULL,
	"gl_account_id" uuid NOT NULL,
	"branch_id" uuid,
	"notes" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_line_matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"journal_line_id" uuid NOT NULL,
	"kind" "match_kind" NOT NULL,
	"reconciliation_id" uuid,
	"matched_by" uuid,
	"matched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"status" "reconciliation_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"statement_date" date NOT NULL,
	"statement_balance" numeric(19, 4) NOT NULL,
	"ledger_balance" numeric(19, 4) NOT NULL,
	"deposits_in_transit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"outstanding_payments" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unrecorded_credits" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unrecorded_debits" numeric(19, 4) DEFAULT '0' NOT NULL,
	"difference" numeric(19, 4) DEFAULT '0' NOT NULL,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_statement_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"statement_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"line_date" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"amount" numeric(19, 4) NOT NULL,
	"balance" numeric(19, 4),
	"status" "statement_line_status" DEFAULT 'UNMATCHED' NOT NULL,
	"match_note" text,
	CONSTRAINT "bank_statement_lines_amount_chk" CHECK ("bank_statement_lines"."amount" <> 0)
);
--> statement-breakpoint
CREATE TABLE "bank_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_number" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"status" "statement_status" DEFAULT 'OPEN' NOT NULL,
	"statement_date" date NOT NULL,
	"opening_balance" numeric(19, 4) NOT NULL,
	"closing_balance" numeric(19, 4) NOT NULL,
	"file_name" text,
	"idempotency_key" text,
	"imported_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"transaction_type" "bank_transaction_type" NOT NULL,
	"status" "bank_transaction_status" DEFAULT 'DRAFT' NOT NULL,
	"transaction_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"counterparty_account_id" uuid,
	"to_bank_account_id" uuid,
	"reference" text,
	"memo" text,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text,
	"void_reason" text,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_amount_chk" CHECK ("bank_transactions"."amount" > 0),
	CONSTRAINT "bank_transactions_sides_chk" CHECK (("bank_transactions"."transaction_type" = 'TRANSFER' AND "bank_transactions"."to_bank_account_id" IS NOT NULL AND "bank_transactions"."to_bank_account_id" <> "bank_transactions"."bank_account_id")
        OR ("bank_transactions"."transaction_type" <> 'TRANSFER' AND "bank_transactions"."counterparty_account_id" IS NOT NULL AND "bank_transactions"."to_bank_account_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "banking_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"match_date_tolerance_days" integer DEFAULT 3 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "depreciation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_number" text NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"status" "depreciation_run_status" DEFAULT 'DRAFT' NOT NULL,
	"run_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"total_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"asset_count" integer DEFAULT 0 NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_asset_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"auto_post_depreciation" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"asset_number" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid NOT NULL,
	"status" "asset_status" DEFAULT 'DRAFT' NOT NULL,
	"acquisition_date" date NOT NULL,
	"in_service_date" date NOT NULL,
	"acquisition_cost" numeric(19, 4) NOT NULL,
	"salvage_value" numeric(19, 4) DEFAULT '0' NOT NULL,
	"useful_life_months" integer NOT NULL,
	"depreciation_method" "depreciation_method" NOT NULL,
	"declining_rate_percent" numeric(19, 4),
	"cost" numeric(19, 4) NOT NULL,
	"accumulated_depreciation" numeric(19, 4) DEFAULT '0' NOT NULL,
	"depreciated_months" integer DEFAULT 0 NOT NULL,
	"location" text,
	"branch_id" uuid,
	"serial_number" text,
	"vendor_id" uuid,
	"reference" text,
	"currency" char(3) NOT NULL,
	"capitalization_journal_entry_id" uuid,
	"capitalized_at" timestamp with time zone,
	"disposal_date" date,
	"disposal_proceeds" numeric(19, 4),
	"disposal_gain_loss" numeric(19, 4),
	"disposal_journal_entry_id" uuid,
	"idempotency_key" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fixed_assets_amounts_chk" CHECK ("fixed_assets"."acquisition_cost" > 0 AND "fixed_assets"."salvage_value" >= 0 AND "fixed_assets"."salvage_value" < "fixed_assets"."acquisition_cost" AND "fixed_assets"."cost" >= 0 AND "fixed_assets"."accumulated_depreciation" >= 0 AND "fixed_assets"."accumulated_depreciation" <= "fixed_assets"."cost" AND "fixed_assets"."useful_life_months" > 0),
	CONSTRAINT "fixed_assets_dates_chk" CHECK ("fixed_assets"."in_service_date" >= "fixed_assets"."acquisition_date")
);
--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_asset_account_id_accounts_id_fk" FOREIGN KEY ("asset_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_accumulated_depreciation_account_id_accounts_id_fk" FOREIGN KEY ("accumulated_depreciation_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_categories" ADD CONSTRAINT "asset_categories_depreciation_expense_account_id_accounts_id_fk" FOREIGN KEY ("depreciation_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_asset_id_fixed_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."fixed_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_depreciation_run_id_depreciation_runs_id_fk" FOREIGN KEY ("depreciation_run_id") REFERENCES "public"."depreciation_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_events" ADD CONSTRAINT "asset_events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_gl_account_id_accounts_id_fk" FOREIGN KEY ("gl_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_matches" ADD CONSTRAINT "bank_line_matches_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_matches" ADD CONSTRAINT "bank_line_matches_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_matches" ADD CONSTRAINT "bank_line_matches_matched_by_users_id_fk" FOREIGN KEY ("matched_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_reconciliations" ADD CONSTRAINT "bank_reconciliations_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statement_lines" ADD CONSTRAINT "bank_statement_lines_statement_id_bank_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."bank_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_statements" ADD CONSTRAINT "bank_statements_imported_by_users_id_fk" FOREIGN KEY ("imported_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_counterparty_account_id_accounts_id_fk" FOREIGN KEY ("counterparty_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_to_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("to_bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "banking_settings" ADD CONSTRAINT "banking_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "depreciation_runs" ADD CONSTRAINT "depreciation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_asset_settings" ADD CONSTRAINT "fixed_asset_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_category_id_asset_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."asset_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_capitalization_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("capitalization_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_disposal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("disposal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fixed_assets" ADD CONSTRAINT "fixed_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_categories_company_code_uq" ON "asset_categories" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "asset_events_asset_idx" ON "asset_events" USING btree ("asset_id","event_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_company_code_uq" ON "bank_accounts" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_gl_account_uq" ON "bank_accounts" USING btree ("gl_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_line_matches_statement_line_uq" ON "bank_line_matches" USING btree ("statement_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_line_matches_journal_line_uq" ON "bank_line_matches" USING btree ("journal_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_reconciliations_statement_uq" ON "bank_reconciliations" USING btree ("statement_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_lines_number_uq" ON "bank_statement_lines" USING btree ("statement_id","line_number");--> statement-breakpoint
CREATE INDEX "bank_statement_lines_status_idx" ON "bank_statement_lines" USING btree ("statement_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_company_number_uq" ON "bank_statements" USING btree ("company_id","statement_number");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statements_idempotency_uq" ON "bank_statements" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bank_statements_account_idx" ON "bank_statements" USING btree ("bank_account_id","statement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_company_number_uq" ON "bank_transactions" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_transactions_idempotency_uq" ON "bank_transactions" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "bank_transactions_account_date_idx" ON "bank_transactions" USING btree ("bank_account_id","transaction_date");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_runs_company_number_uq" ON "depreciation_runs" USING btree ("company_id","run_number");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_runs_idempotency_uq" ON "depreciation_runs" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "depreciation_runs_period_uq" ON "depreciation_runs" USING btree ("company_id","fiscal_period_id") WHERE "depreciation_runs"."status" <> 'REVERSED';--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_company_number_uq" ON "fixed_assets" USING btree ("company_id","asset_number");--> statement-breakpoint
CREATE UNIQUE INDEX "fixed_assets_idempotency_uq" ON "fixed_assets" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "fixed_assets_company_status_idx" ON "fixed_assets" USING btree ("company_id","status");