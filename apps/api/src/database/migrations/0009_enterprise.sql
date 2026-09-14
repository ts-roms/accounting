CREATE TYPE "public"."approval_decision" AS ENUM('APPROVE', 'REJECT');--> statement-breakpoint
CREATE TYPE "public"."approval_request_status" AS ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."attachment_entity_type" AS ENUM('JOURNAL_ENTRY', 'INVOICE', 'BILL', 'CUSTOMER_PAYMENT', 'VENDOR_PAYMENT', 'EXPENSE_CLAIM', 'FIXED_ASSET', 'BANK_STATEMENT', 'ORDER', 'CUSTOMER', 'VENDOR');--> statement-breakpoint
CREATE TYPE "public"."exchange_rate_source" AS ENUM('MANUAL', 'IMPORT', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."fx_adjustment_type" AS ENUM('REALIZED', 'REVALUATION', 'REVALUATION_REVERSAL');--> statement-breakpoint
CREATE TYPE "public"."fx_side" AS ENUM('AR', 'AP');--> statement-breakpoint
CREATE TYPE "public"."intercompany_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."workflow_document_type" AS ENUM('JOURNAL_ENTRY', 'VENDOR_PAYMENT', 'PURCHASE_ORDER', 'EXPENSE_CLAIM');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'UNREALIZED_FX_GAIN';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'UNREALIZED_FX_LOSS';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'INTERCOMPANY_RECEIVABLE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'INTERCOMPANY_PAYABLE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'ICT';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'FXR';--> statement-breakpoint
CREATE TABLE "approval_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"step" integer NOT NULL,
	"decision" "approval_decision" NOT NULL,
	"comment" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_id" uuid NOT NULL,
	"document_type" "workflow_document_type" NOT NULL,
	"document_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency" char(3) NOT NULL,
	"steps" jsonb NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"status" "approval_request_status" DEFAULT 'PENDING' NOT NULL,
	"requested_by" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" "workflow_document_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"min_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"max_amount" numeric(19, 4),
	"priority" integer DEFAULT 100 NOT NULL,
	"allow_self_approval" boolean DEFAULT false NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approval_workflows_band_chk" CHECK ("approval_workflows"."min_amount" >= 0 AND ("approval_workflows"."max_amount" IS NULL OR "approval_workflows"."max_amount" > "approval_workflows"."min_amount"))
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"entity_type" "attachment_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"description" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attachments_size_chk" CHECK ("attachments"."size_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_currency" char(3) NOT NULL,
	"to_currency" char(3) NOT NULL,
	"rate_date" date NOT NULL,
	"rate" numeric(19, 8) NOT NULL,
	"source" "exchange_rate_source" DEFAULT 'MANUAL' NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_rates_rate_chk" CHECK ("exchange_rates"."rate" > 0 AND "exchange_rates"."from_currency" <> "exchange_rates"."to_currency")
);
--> statement-breakpoint
CREATE TABLE "fx_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"side" "fx_side" NOT NULL,
	"adjustment_type" "fx_adjustment_type" NOT NULL,
	"adjustment_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"journal_entry_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fx_revaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_number" text NOT NULL,
	"as_of_date" date NOT NULL,
	"reversal_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unrealized_gain" numeric(19, 4) DEFAULT '0' NOT NULL,
	"unrealized_loss" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intercompany_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"from_company_id" uuid NOT NULL,
	"to_company_id" uuid NOT NULL,
	"transaction_date" date NOT NULL,
	"description" text NOT NULL,
	"reference" text,
	"currency" char(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"from_account_id" uuid NOT NULL,
	"to_account_id" uuid NOT NULL,
	"status" "intercompany_status" DEFAULT 'DRAFT' NOT NULL,
	"from_journal_entry_id" uuid,
	"to_journal_entry_id" uuid,
	"idempotency_key" text,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intercompany_amount_chk" CHECK ("intercompany_transactions"."amount" > 0 AND "intercompany_transactions"."from_company_id" <> "intercompany_transactions"."to_company_id")
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_intercompany" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "control_base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "currency" char(3) DEFAULT 'PHP' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "base_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "base_total" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "control_base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendors" ADD COLUMN "currency" char(3) DEFAULT 'PHP' NOT NULL;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decisions" ADD CONSTRAINT "approval_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_id_approval_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."approval_workflows"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_workflows" ADD CONSTRAINT "approval_workflows_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_adjustments" ADD CONSTRAINT "fx_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_adjustments" ADD CONSTRAINT "fx_adjustments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_revaluations" ADD CONSTRAINT "fx_revaluations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_company_id_companies_id_fk" FOREIGN KEY ("from_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_company_id_companies_id_fk" FOREIGN KEY ("to_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_account_id_accounts_id_fk" FOREIGN KEY ("from_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_account_id_accounts_id_fk" FOREIGN KEY ("to_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_from_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("from_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_to_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("to_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_decisions_request_idx" ON "approval_decisions" USING btree ("request_id","step");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_decisions_user_step_uq" ON "approval_decisions" USING btree ("request_id","step","decided_by");--> statement-breakpoint
CREATE INDEX "approval_requests_document_idx" ON "approval_requests" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "approval_requests_company_status_idx" ON "approval_requests" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "approval_requests_open_uq" ON "approval_requests" USING btree ("document_type","document_id") WHERE "approval_requests"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "approval_workflows_company_type_idx" ON "approval_workflows" USING btree ("company_id","document_type","status");--> statement-breakpoint
CREATE INDEX "attachments_entity_idx" ON "attachments" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "attachments_company_idx" ON "attachments" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "exchange_rates_pair_date_uq" ON "exchange_rates" USING btree ("organization_id","from_currency","to_currency","rate_date");--> statement-breakpoint
CREATE INDEX "fx_adjustments_company_side_idx" ON "fx_adjustments" USING btree ("company_id","side","adjustment_date");--> statement-breakpoint
CREATE INDEX "fx_adjustments_source_idx" ON "fx_adjustments" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_revaluations_company_number_uq" ON "fx_revaluations" USING btree ("company_id","run_number");--> statement-breakpoint
CREATE INDEX "fx_revaluations_company_date_idx" ON "fx_revaluations" USING btree ("company_id","as_of_date");--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_org_number_uq" ON "intercompany_transactions" USING btree ("organization_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_idempotency_uq" ON "intercompany_transactions" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "intercompany_from_idx" ON "intercompany_transactions" USING btree ("from_company_id","transaction_date");--> statement-breakpoint
CREATE INDEX "intercompany_to_idx" ON "intercompany_transactions" USING btree ("to_company_id","transaction_date");--> statement-breakpoint
UPDATE "customers" c SET "currency" = co."base_currency" FROM "companies" co WHERE co."id" = c."company_id";--> statement-breakpoint
UPDATE "vendors" v SET "currency" = co."base_currency" FROM "companies" co WHERE co."id" = v."company_id";--> statement-breakpoint
UPDATE "invoices" SET "base_total" = "total";--> statement-breakpoint
UPDATE "vendor_bills" SET "base_total" = "total";--> statement-breakpoint
UPDATE "customer_payments" SET "base_amount" = "amount", "control_base_amount" = "amount";--> statement-breakpoint
UPDATE "vendor_payments" SET "base_amount" = "amount", "control_base_amount" = "amount";
