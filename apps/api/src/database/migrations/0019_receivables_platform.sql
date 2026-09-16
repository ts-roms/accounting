CREATE TYPE "public"."customer_type" AS ENUM('INDIVIDUAL', 'BUSINESS', 'GOVERNMENT', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."collection_activity_type" AS ENUM('CALL', 'EMAIL', 'MEETING', 'LETTER', 'NOTE', 'PROMISE', 'ESCALATION', 'DUNNING', 'CREDIT_HOLD', 'DISPUTE', 'STATUS_CHANGE');--> statement-breakpoint
CREATE TYPE "public"."collection_case_status" AS ENUM('NEW', 'CONTACTED', 'PROMISED', 'ESCALATED', 'DISPUTED', 'COLLECTED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."credit_risk_rating" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."credit_rule_action" AS ENUM('WARN', 'REQUIRE_APPROVAL', 'BLOCK');--> statement-breakpoint
CREATE TYPE "public"."credit_rule_scope" AS ENUM('SALES_ORDER', 'INVOICE');--> statement-breakpoint
CREATE TYPE "public"."credit_rule_trigger" AS ENUM('EXPOSURE_OVER_LIMIT', 'OVERDUE_BALANCE', 'DAYS_OVERDUE', 'CREDIT_HOLD', 'NO_CREDIT_LIMIT');--> statement-breakpoint
CREATE TYPE "public"."customer_address_type" AS ENUM('BILLING', 'SHIPPING');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('DRAFT', 'PICKING', 'READY', 'DELIVERED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."dispute_reason" AS ENUM('INCORRECT_QUANTITY', 'INCORRECT_PRICE', 'DUPLICATE_INVOICE', 'TAX_ISSUE', 'MISSING_DELIVERY', 'CUSTOMER_REJECTION', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."dispute_resolution" AS ENUM('UPHELD', 'CREDIT_NOTE', 'PARTIAL_CREDIT', 'REJECTED', 'WITHDRAWN');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('OPEN', 'INVESTIGATING', 'RESOLVED', 'CLOSED');--> statement-breakpoint
CREATE TYPE "public"."dunning_action" AS ENUM('REMINDER', 'ESCALATION', 'CREDIT_HOLD');--> statement-breakpoint
CREATE TYPE "public"."payment_term_basis" AS ENUM('DUE_ON_RECEIPT', 'NET_DAYS', 'END_OF_MONTH', 'DAY_OF_NEXT_MONTH');--> statement-breakpoint
CREATE TYPE "public"."promise_status" AS ENUM('PENDING', 'KEPT', 'BROKEN', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."provision_method" AS ENUM('AGING_PERCENT', 'SPECIFIC');--> statement-breakpoint
CREATE TYPE "public"."provision_status" AS ENUM('DRAFT', 'POSTED', 'REVERSED');--> statement-breakpoint
CREATE TYPE "public"."refund_request_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."write_off_reason" AS ENUM('BAD_DEBT', 'SMALL_BALANCE', 'UNCOLLECTIBLE', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."write_off_status" AS ENUM('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'RECOVERED', 'REJECTED', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'BAD_DEBT_EXPENSE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'ALLOWANCE_FOR_DOUBTFUL_ACCOUNTS';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'AR_WRITE_OFF';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'BAD_DEBT_RECOVERY';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'DLV';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'WO';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'COL';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'DSP';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'RFD';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PRV';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'STMT';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'DEBIT_CARD' BEFORE 'ONLINE';--> statement-breakpoint
ALTER TYPE "public"."payment_method" ADD VALUE 'PAYMENT_GATEWAY' BEFORE 'OTHER';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'SUBMITTED' BEFORE 'POSTED';--> statement-breakpoint
ALTER TYPE "public"."payment_status" ADD VALUE 'APPROVED' BEFORE 'POSTED';--> statement-breakpoint
ALTER TYPE "public"."subledger_document_status" ADD VALUE 'SUBMITTED' BEFORE 'APPROVED';--> statement-breakpoint
ALTER TYPE "public"."subledger_document_status" ADD VALUE 'WRITTEN_OFF' BEFORE 'VOID';--> statement-breakpoint
ALTER TYPE "public"."order_status" ADD VALUE 'CONFIRMED' BEFORE 'CONVERTED';--> statement-breakpoint
ALTER TYPE "public"."movement_source_type" ADD VALUE 'DELIVERY' BEFORE 'AP_DOCUMENT';--> statement-breakpoint
ALTER TYPE "public"."movement_source_type" ADD VALUE 'DELIVERY_CANCEL' BEFORE 'AP_DOCUMENT';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'SALES_ORDER';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'INVOICE';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'CUSTOMER_PAYMENT';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'CUSTOMER_REFUND';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'WRITE_OFF';--> statement-breakpoint
CREATE TABLE "ar_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"aging_buckets" jsonb DEFAULT '[{"key":"current","label":"Current","from":-1000000,"to":0},{"key":"days1to30","label":"1-30","from":1,"to":30},{"key":"days31to60","label":"31-60","from":31,"to":60},{"key":"days61to90","label":"61-90","from":61,"to":90},{"key":"days91to120","label":"91-120","from":91,"to":120},{"key":"over120","label":"120+","from":121,"to":null}]'::jsonb NOT NULL,
	"dso_window_days" integer DEFAULT 90 NOT NULL,
	"unapplied_cash_warn_days" integer DEFAULT 30 NOT NULL,
	"small_balance_threshold" numeric(19, 4) DEFAULT '0' NOT NULL,
	"auto_case_days_overdue" integer DEFAULT 0 NOT NULL,
	"require_payment_approval" boolean DEFAULT false NOT NULL,
	"use_allowance_for_bad_debt" boolean DEFAULT true NOT NULL,
	"provision_rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credit_check_on_sales_order" boolean DEFAULT true NOT NULL,
	"credit_check_on_invoice" boolean DEFAULT true NOT NULL,
	"default_dunning_policy_id" uuid,
	"default_payment_term_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bad_debt_provisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "provision_status" DEFAULT 'DRAFT' NOT NULL,
	"as_of" date NOT NULL,
	"method" "provision_method" NOT NULL,
	"currency" char(3) NOT NULL,
	"computation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"required_allowance" numeric(19, 4) NOT NULL,
	"existing_allowance" numeric(19, 4) NOT NULL,
	"adjustment" numeric(19, 4) NOT NULL,
	"description" text,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"created_by" uuid,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"invoice_id" uuid,
	"activity_type" "collection_activity_type" NOT NULL,
	"summary" text NOT NULL,
	"details" text,
	"contact_name" text,
	"dunning_policy_id" uuid,
	"dunning_step" integer,
	"performed_by" uuid,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "collection_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "collection_case_status" DEFAULT 'NEW' NOT NULL,
	"collector_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"last_contact_at" timestamp with time zone,
	"next_action_at" date,
	"next_action" text,
	"source" text DEFAULT 'MANUAL' NOT NULL,
	"escalation_level" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scope" "credit_rule_scope" NOT NULL,
	"trigger" "credit_rule_trigger" NOT NULL,
	"action" "credit_rule_action" NOT NULL,
	"threshold_amount" numeric(19, 4),
	"threshold_percent" numeric(19, 4),
	"threshold_days" integer,
	"customer_group_id" uuid,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_type" "customer_address_type" NOT NULL,
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
CREATE TABLE "customer_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"role" text,
	"email" text,
	"phone" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_credit_profiles" (
	"customer_id" uuid PRIMARY KEY NOT NULL,
	"credit_hold" boolean DEFAULT false NOT NULL,
	"credit_hold_reason" text,
	"credit_hold_at" timestamp with time zone,
	"credit_hold_by" uuid,
	"credit_hold_source" text,
	"risk_rating" "credit_risk_rating" DEFAULT 'LOW' NOT NULL,
	"review_date" date,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"payment_term_id" uuid,
	"default_credit_limit" numeric(19, 4),
	"tax_code_id" uuid,
	"price_discount_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"dunning_policy_id" uuid,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"branch_id" uuid,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"opening_balance" numeric(19, 4) NOT NULL,
	"closing_balance" numeric(19, 4) NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generated_by" uuid,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"sales_order_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"warehouse_id" uuid,
	"shipping_address_id" uuid,
	"status" "delivery_status" DEFAULT 'DRAFT' NOT NULL,
	"delivery_date" date NOT NULL,
	"reference" text,
	"notes" text,
	"cancel_reason" text,
	"journal_entry_id" uuid,
	"reversal_journal_entry_id" uuid,
	"idempotency_key" text,
	"delivered_by" uuid,
	"delivered_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"order_line_id" uuid NOT NULL,
	"product_id" uuid,
	"warehouse_id" uuid,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"lot_number" text,
	"serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cost_amount" numeric(19, 4),
	"invoiced_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	CONSTRAINT "delivery_lines_qty_chk" CHECK ("delivery_lines"."quantity" > 0 AND "delivery_lines"."invoiced_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "dunning_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"minimum_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"case_id" uuid,
	"status" "dispute_status" DEFAULT 'OPEN' NOT NULL,
	"reason" "dispute_reason" NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"description" text NOT NULL,
	"raised_by" text,
	"assignee_id" uuid,
	"resolution" "dispute_resolution",
	"resolution_notes" text,
	"credit_note_id" uuid,
	"opened_by" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoice_disputes_amount_chk" CHECK ("invoice_disputes"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"payment_id" uuid,
	"credit_note_id" uuid,
	"status" "refund_request_status" DEFAULT 'DRAFT' NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reason" text NOT NULL,
	"method" "payment_method" DEFAULT 'BANK_TRANSFER' NOT NULL,
	"cash_account_id" uuid NOT NULL,
	"reference" text,
	"refund_payment_id" uuid,
	"decision_comment" text,
	"idempotency_key" text,
	"requested_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"paid_by" uuid,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_refunds_amount_chk" CHECK ("payment_refunds"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "payment_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"basis" "payment_term_basis" DEFAULT 'NET_DAYS' NOT NULL,
	"days" integer DEFAULT 30 NOT NULL,
	"day_of_month" integer,
	"discount_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_days" integer DEFAULT 0 NOT NULL,
	"description" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promises_to_pay" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"case_id" uuid,
	"status" "promise_status" DEFAULT 'PENDING' NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"promise_date" date NOT NULL,
	"invoice_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collector_id" uuid,
	"notes" text,
	"settled_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"evaluated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promises_amount_chk" CHECK ("promises_to_pay"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "write_off_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"document_number" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"status" "write_off_status" DEFAULT 'DRAFT' NOT NULL,
	"reason" "write_off_reason" NOT NULL,
	"justification" text NOT NULL,
	"currency" char(3) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL,
	"base_amount" numeric(19, 4) DEFAULT '0' NOT NULL,
	"write_off_date" date,
	"debit_account_id" uuid,
	"journal_entry_id" uuid,
	"recovery_journal_entry_id" uuid,
	"recovery_date" date,
	"recovery_reason" text,
	"decision_comment" text,
	"idempotency_key" text,
	"requested_by" uuid,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "write_off_requests_amount_chk" CHECK ("write_off_requests"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payment_allocations" DROP CONSTRAINT "payment_allocations_source_chk";--> statement-breakpoint
ALTER TABLE "order_lines" DROP CONSTRAINT "order_lines_fulfilment_chk";--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_type" "customer_type" DEFAULT 'BUSINESS' NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_group_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "salesperson_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "industry" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "region" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_exempt" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "tax_registration_type" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "written_off_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD COLUMN "write_off_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "external_reference" text;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "submitted_by" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "delivered_quantity" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "unit" text;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "delivery_status" "fulfillment_status" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "payment_term_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "salesperson_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "credit_check" jsonb;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ar_settings" ADD CONSTRAINT "ar_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_settings" ADD CONSTRAINT "ar_settings_default_dunning_policy_id_dunning_policies_id_fk" FOREIGN KEY ("default_dunning_policy_id") REFERENCES "public"."dunning_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ar_settings" ADD CONSTRAINT "ar_settings_default_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("default_payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bad_debt_provisions" ADD CONSTRAINT "bad_debt_provisions_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activities" ADD CONSTRAINT "collection_activities_case_id_collection_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."collection_cases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activities" ADD CONSTRAINT "collection_activities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activities" ADD CONSTRAINT "collection_activities_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activities" ADD CONSTRAINT "collection_activities_dunning_policy_id_dunning_policies_id_fk" FOREIGN KEY ("dunning_policy_id") REFERENCES "public"."dunning_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_activities" ADD CONSTRAINT "collection_activities_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cases" ADD CONSTRAINT "collection_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cases" ADD CONSTRAINT "collection_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cases" ADD CONSTRAINT "collection_cases_collector_id_users_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collection_cases" ADD CONSTRAINT "collection_cases_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_rules" ADD CONSTRAINT "credit_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_rules" ADD CONSTRAINT "credit_rules_customer_group_id_customer_groups_id_fk" FOREIGN KEY ("customer_group_id") REFERENCES "public"."customer_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_addresses" ADD CONSTRAINT "customer_addresses_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_profiles" ADD CONSTRAINT "customer_credit_profiles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_profiles" ADD CONSTRAINT "customer_credit_profiles_credit_hold_by_users_id_fk" FOREIGN KEY ("credit_hold_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_credit_profiles" ADD CONSTRAINT "customer_credit_profiles_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_tax_code_id_tax_codes_id_fk" FOREIGN KEY ("tax_code_id") REFERENCES "public"."tax_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_groups" ADD CONSTRAINT "customer_groups_dunning_policy_id_dunning_policies_id_fk" FOREIGN KEY ("dunning_policy_id") REFERENCES "public"."dunning_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_statements" ADD CONSTRAINT "customer_statements_generated_by_users_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sales_order_id_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_shipping_address_id_customer_addresses_id_fk" FOREIGN KEY ("shipping_address_id") REFERENCES "public"."customer_addresses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_delivered_by_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_lines" ADD CONSTRAINT "delivery_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dunning_policies" ADD CONSTRAINT "dunning_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_case_id_collection_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."collection_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_opened_by_users_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_disputes" ADD CONSTRAINT "invoice_disputes_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_credit_note_id_invoices_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "public"."invoices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_cash_account_id_accounts_id_fk" FOREIGN KEY ("cash_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_refund_payment_id_customer_payments_id_fk" FOREIGN KEY ("refund_payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_terms" ADD CONSTRAINT "payment_terms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_case_id_collection_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."collection_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_collector_id_users_id_fk" FOREIGN KEY ("collector_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promises_to_pay" ADD CONSTRAINT "promises_to_pay_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_debit_account_id_accounts_id_fk" FOREIGN KEY ("debit_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_recovery_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("recovery_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "write_off_requests" ADD CONSTRAINT "write_off_requests_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bad_debt_provisions_company_number_uq" ON "bad_debt_provisions" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "bad_debt_provisions_company_idx" ON "bad_debt_provisions" USING btree ("company_id","as_of");--> statement-breakpoint
CREATE INDEX "collection_activities_case_idx" ON "collection_activities" USING btree ("case_id","performed_at");--> statement-breakpoint
CREATE INDEX "collection_activities_customer_idx" ON "collection_activities" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_activities_dunning_uq" ON "collection_activities" USING btree ("invoice_id","dunning_policy_id","dunning_step");--> statement-breakpoint
CREATE UNIQUE INDEX "collection_cases_company_number_uq" ON "collection_cases" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "collection_cases_customer_idx" ON "collection_cases" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "collection_cases_company_status_idx" ON "collection_cases" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "collection_cases_collector_idx" ON "collection_cases" USING btree ("collector_id");--> statement-breakpoint
CREATE INDEX "credit_rules_company_scope_idx" ON "credit_rules" USING btree ("company_id","scope","status");--> statement-breakpoint
CREATE INDEX "customer_addresses_customer_idx" ON "customer_addresses" USING btree ("customer_id","address_type");--> statement-breakpoint
CREATE INDEX "customer_contacts_customer_idx" ON "customer_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_groups_company_code_uq" ON "customer_groups" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_statements_company_number_uq" ON "customer_statements" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "customer_statements_customer_idx" ON "customer_statements" USING btree ("customer_id","to_date");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_company_number_uq" ON "deliveries" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_idempotency_uq" ON "deliveries" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "deliveries_order_idx" ON "deliveries" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "deliveries_customer_idx" ON "deliveries" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "deliveries_company_status_idx" ON "deliveries" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_lines_number_uq" ON "delivery_lines" USING btree ("delivery_id","line_number");--> statement-breakpoint
CREATE INDEX "delivery_lines_order_line_idx" ON "delivery_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "dunning_policies_company_idx" ON "dunning_policies" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_disputes_company_number_uq" ON "invoice_disputes" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE INDEX "invoice_disputes_invoice_idx" ON "invoice_disputes" USING btree ("invoice_id","status");--> statement-breakpoint
CREATE INDEX "invoice_disputes_customer_idx" ON "invoice_disputes" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_company_number_uq" ON "payment_refunds" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_refunds_idempotency_uq" ON "payment_refunds" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "payment_refunds_customer_idx" ON "payment_refunds" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "payment_refunds_company_status_idx" ON "payment_refunds" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_terms_company_code_uq" ON "payment_terms" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "promises_customer_idx" ON "promises_to_pay" USING btree ("customer_id","status");--> statement-breakpoint
CREATE INDEX "promises_company_status_idx" ON "promises_to_pay" USING btree ("company_id","status","promise_date");--> statement-breakpoint
CREATE UNIQUE INDEX "write_off_requests_company_number_uq" ON "write_off_requests" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "write_off_requests_idempotency_uq" ON "write_off_requests" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "write_off_requests_invoice_idx" ON "write_off_requests" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "write_off_requests_customer_idx" ON "write_off_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "write_off_requests_company_status_idx" ON "write_off_requests" USING btree ("company_id","status");--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_customer_group_id_customer_groups_id_fk" FOREIGN KEY ("customer_group_id") REFERENCES "public"."customer_groups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_salesperson_id_users_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_delivery_id_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."deliveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_term_id_payment_terms_id_fk" FOREIGN KEY ("payment_term_id") REFERENCES "public"."payment_terms"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_write_off_id_write_off_requests_id_fk" FOREIGN KEY ("write_off_id") REFERENCES "public"."write_off_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_payments" ADD CONSTRAINT "vendor_payments_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_salesperson_id_users_id_fk" FOREIGN KEY ("salesperson_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customers_group_idx" ON "customers" USING btree ("customer_group_id");--> statement-breakpoint
CREATE INDEX "customers_salesperson_idx" ON "customers" USING btree ("salesperson_id");--> statement-breakpoint
CREATE INDEX "invoices_delivery_idx" ON "invoices" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "invoices_sales_order_idx" ON "invoices" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "payment_allocations_write_off_idx" ON "payment_allocations" USING btree ("write_off_id");--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_source_chk" CHECK (("payment_allocations"."payment_id" IS NOT NULL)::int + ("payment_allocations"."credit_note_id" IS NOT NULL)::int + ("payment_allocations"."write_off_id" IS NOT NULL)::int = 1);--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_fulfilment_chk" CHECK ("order_lines"."received_quantity" >= 0 AND "order_lines"."billed_quantity" >= 0 AND "order_lines"."returned_quantity" >= 0 AND "order_lines"."delivered_quantity" >= 0);