CREATE TYPE "public"."accounting_status" AS ENUM('UNPOSTED', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('CASH', 'BANK_TRANSFER', 'CHECK', 'CARD', 'ONLINE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('DRAFT', 'POSTED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."payment_type" AS ENUM('PAYMENT', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."subledger_document_status" AS ENUM('DRAFT', 'APPROVED', 'PARTIALLY_PAID', 'PAID', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."subledger_document_type" AS ENUM('INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'DEFAULT_EXPENSE' BEFORE 'OUTPUT_VAT';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'INV';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'CN';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'DN';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'RCP';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'BILL';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'VCN';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'VDN';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PAY';--> statement-breakpoint
CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"bill_id" uuid NOT NULL,
	CONSTRAINT "bill_lines_amount_chk" CHECK ("bill_lines"."amount" >= 0 AND "bill_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"payment_type" "payment_type" DEFAULT 'PAYMENT' NOT NULL,
	"status" "payment_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"allocated_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"reference" text,
	"memo" text,
	"currency" char(3) NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	CONSTRAINT "customer_payments_amount_chk" CHECK ("customer_payments"."amount" > 0 AND "customer_payments"."allocated_amount" >= 0 AND "customer_payments"."allocated_amount" <= "customer_payments"."amount")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_identification_number" text,
	"email" text,
	"phone" text,
	"contact_person" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"country" char(2) DEFAULT 'PH' NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credit_limit" numeric(19, 4),
	"default_revenue_account_id" uuid
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"invoice_id" uuid NOT NULL,
	CONSTRAINT "invoice_lines_amount_chk" CHECK ("invoice_lines"."amount" >= 0 AND "invoice_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_type" "subledger_document_type" DEFAULT 'INVOICE' NOT NULL,
	"document_number" text NOT NULL,
	"status" "subledger_document_status" DEFAULT 'DRAFT' NOT NULL,
	"accounting_status" "accounting_status" DEFAULT 'UNPOSTED' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"document_date" date NOT NULL,
	"due_date" date NOT NULL,
	"reference" text,
	"description" text,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"allocated_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"idempotency_key" text,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"customer_id" uuid NOT NULL,
	"promised_payment_date" date,
	"collection_notes" text,
	CONSTRAINT "invoices_total_chk" CHECK ("invoices"."total" >= 0 AND "invoices"."total" = "invoices"."subtotal" + "invoices"."tax_total"),
	CONSTRAINT "invoices_allocated_chk" CHECK ("invoices"."allocated_amount" >= 0 AND "invoices"."allocated_amount" <= "invoices"."total"),
	CONSTRAINT "invoices_due_chk" CHECK ("invoices"."due_date" >= "invoices"."document_date")
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid,
	"credit_note_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"allocation_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocations_amount_chk" CHECK ("payment_allocations"."amount" > 0),
	CONSTRAINT "payment_allocations_source_chk" CHECK (("payment_allocations"."payment_id" IS NOT NULL)::int + ("payment_allocations"."credit_note_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "vendor_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_type" "subledger_document_type" DEFAULT 'INVOICE' NOT NULL,
	"document_number" text NOT NULL,
	"status" "subledger_document_status" DEFAULT 'DRAFT' NOT NULL,
	"accounting_status" "accounting_status" DEFAULT 'UNPOSTED' NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"document_date" date NOT NULL,
	"due_date" date NOT NULL,
	"reference" text,
	"description" text,
	"currency" char(3) NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"tax_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"allocated_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"idempotency_key" text,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_id" uuid NOT NULL,
	"vendor_invoice_number" text,
	"scheduled_payment_date" date,
	CONSTRAINT "vendor_bills_total_chk" CHECK ("vendor_bills"."total" >= 0 AND "vendor_bills"."total" = "vendor_bills"."subtotal" + "vendor_bills"."tax_total"),
	CONSTRAINT "vendor_bills_allocated_chk" CHECK ("vendor_bills"."allocated_amount" >= 0 AND "vendor_bills"."allocated_amount" <= "vendor_bills"."total"),
	CONSTRAINT "vendor_bills_due_chk" CHECK ("vendor_bills"."due_date" >= "vendor_bills"."document_date")
);
--> statement-breakpoint
CREATE TABLE "vendor_payment_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"payment_id" uuid,
	"credit_note_id" uuid,
	"amount" numeric(19, 4) NOT NULL,
	"allocation_date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_payment_allocations_amount_chk" CHECK ("vendor_payment_allocations"."amount" > 0),
	CONSTRAINT "vendor_payment_allocations_source_chk" CHECK (("vendor_payment_allocations"."payment_id" IS NOT NULL)::int + ("vendor_payment_allocations"."credit_note_id" IS NOT NULL)::int = 1)
);
--> statement-breakpoint
CREATE TABLE "vendor_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"payment_type" "payment_type" DEFAULT 'PAYMENT' NOT NULL,
	"status" "payment_status" DEFAULT 'DRAFT' NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"allocated_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"reference" text,
	"memo" text,
	"currency" char(3) NOT NULL,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"vendor_id" uuid NOT NULL,
	CONSTRAINT "vendor_payments_amount_chk" CHECK ("vendor_payments"."amount" > 0 AND "vendor_payments"."allocated_amount" >= 0 AND "vendor_payments"."allocated_amount" <= "vendor_payments"."amount")
);
--> statement-breakpoint
CREATE TABLE "vendors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"tax_identification_number" text,
	"email" text,
	"phone" text,
	"contact_person" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"province" text,
	"postal_code" text,
	"country" char(2) DEFAULT 'PH' NOT NULL,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"default_expense_account_id" uuid
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_cash_account_id_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_default_revenue_account_id_accounts_id_fk" FOREIGN KEY ("default_revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_bill_id_vendor_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_payment_id_vendor_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."vendor_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_credit_note_id_vendor_bills_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."vendor_bills"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payment_allocations" ADD CONSTRAINT "vendor_payment_allocations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_cash_account_id_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_default_expense_account_id_accounts_id_fk" FOREIGN KEY ("default_expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bill_lines_number_uq" ON "bill_lines" USING btree ("bill_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_company_number_uq" ON "customer_payments" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_payments_idempotency_uq" ON "customer_payments" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "customer_payments_customer_idx" ON "customer_payments" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_company_code_uq" ON "customers" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "customers_company_name_idx" ON "customers" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_lines_number_uq" ON "invoice_lines" USING btree ("invoice_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_company_number_uq" ON "invoices" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_idempotency_uq" ON "invoices" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_company_status_idx" ON "invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "invoices_company_due_idx" ON "invoices" USING btree ("company_id","due_date");--> statement-breakpoint
CREATE INDEX "payment_allocations_invoice_idx" ON "payment_allocations" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_payment_idx" ON "payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_company_number_uq" ON "vendor_bills" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_idempotency_uq" ON "vendor_bills" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_bills_vendor_invoice_uq" ON "vendor_bills" USING btree ("vendor_id","vendor_invoice_number");--> statement-breakpoint
CREATE INDEX "vendor_bills_vendor_idx" ON "vendor_bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "vendor_bills_company_status_idx" ON "vendor_bills" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "vendor_bills_company_due_idx" ON "vendor_bills" USING btree ("company_id","due_date");--> statement-breakpoint
CREATE INDEX "vendor_payment_allocations_bill_idx" ON "vendor_payment_allocations" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "vendor_payment_allocations_payment_idx" ON "vendor_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payments_company_number_uq" ON "vendor_payments" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_payments_idempotency_uq" ON "vendor_payments" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "vendor_payments_vendor_idx" ON "vendor_payments" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vendors_company_code_uq" ON "vendors" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "vendors_company_name_idx" ON "vendors" USING btree ("company_id","name");