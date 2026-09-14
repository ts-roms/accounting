CREATE TYPE "public"."match_status" AS ENUM('NOT_REQUIRED', 'MATCHED', 'EXCEPTION', 'REVIEWED');--> statement-breakpoint
CREATE TYPE "public"."fulfillment_status" AS ENUM('NONE', 'PARTIAL', 'FULL');--> statement-breakpoint
CREATE TYPE "public"."goods_receipt_status" AS ENUM('DRAFT', 'CONFIRMED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('DRAFT', 'SUBMITTED', 'SENT', 'ACCEPTED', 'APPROVED', 'CONVERTED', 'REJECTED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."order_type" AS ENUM('QUOTATION', 'SALES_ORDER', 'PURCHASE_REQUEST', 'PURCHASE_ORDER');--> statement-breakpoint
CREATE TYPE "public"."return_status" AS ENUM('DRAFT', 'APPROVED', 'CREDITED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."return_type" AS ENUM('SALES', 'PURCHASE');--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'QT';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'SO';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PR';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PO';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'GR';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'SRN';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'PRN';--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"goods_receipt_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"order_line_id" uuid NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"notes" text,
	CONSTRAINT "goods_receipt_lines_qty_chk" CHECK ("goods_receipt_lines"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"vendor_id" uuid NOT NULL,
	"status" "goods_receipt_status" DEFAULT 'DRAFT' NOT NULL,
	"receipt_date" date NOT NULL,
	"reference" text,
	"notes" text,
	"idempotency_key" text,
	"cancel_reason" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) DEFAULT '1' NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"discount_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"branch_id" uuid,
	"received_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"billed_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"returned_quantity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"source_line_id" uuid,
	CONSTRAINT "order_lines_qty_chk" CHECK ("order_lines"."quantity" > 0 AND "order_lines"."amount" >= 0 AND "order_lines"."discount_percent" >= 0 AND "order_lines"."discount_percent" <= 100),
	CONSTRAINT "order_lines_fulfilment_chk" CHECK ("order_lines"."received_quantity" >= 0 AND "order_lines"."billed_quantity" >= 0 AND "order_lines"."returned_quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"order_type" "order_type" NOT NULL,
	"document_number" text NOT NULL,
	"status" "order_status" DEFAULT 'DRAFT' NOT NULL,
	"customer_id" uuid,
	"vendor_id" uuid,
	"order_date" date NOT NULL,
	"expected_date" date,
	"reference" text,
	"description" text,
	"notes" text,
	"currency" text NOT NULL,
	"subtotal" numeric(19, 4) DEFAULT '0' NOT NULL,
	"discount_total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"receipt_status" "fulfillment_status" DEFAULT 'NONE' NOT NULL,
	"billing_status" "fulfillment_status" DEFAULT 'NONE' NOT NULL,
	"source_order_id" uuid,
	"converted_order_id" uuid,
	"idempotency_key" text,
	"rejection_reason" text,
	"cancel_reason" text,
	"submitted_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orders_party_chk" CHECK (("orders"."order_type" IN ('QUOTATION', 'SALES_ORDER') AND "orders"."customer_id" IS NOT NULL AND "orders"."vendor_id" IS NULL)
        OR ("orders"."order_type" = 'PURCHASE_ORDER' AND "orders"."vendor_id" IS NOT NULL AND "orders"."customer_id" IS NULL)
        OR ("orders"."order_type" = 'PURCHASE_REQUEST' AND "orders"."customer_id" IS NULL)),
	CONSTRAINT "orders_totals_chk" CHECK ("orders"."subtotal" >= 0 AND "orders"."discount_total" >= 0 AND "orders"."total" = "orders"."subtotal" - "orders"."discount_total")
);
--> statement-breakpoint
CREATE TABLE "purchasing_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"price_tolerance_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"quantity_tolerance_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"over_receipt_tolerance_percent" numeric(19, 4) DEFAULT '0' NOT NULL,
	"require_purchase_order" boolean DEFAULT false NOT NULL,
	"require_receipt_before_bill" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchasing_settings_pct_chk" CHECK ("purchasing_settings"."price_tolerance_percent" BETWEEN 0 AND 100 AND "purchasing_settings"."quantity_tolerance_percent" BETWEEN 0 AND 100 AND "purchasing_settings"."over_receipt_tolerance_percent" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "return_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"return_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"order_line_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"account_id" uuid NOT NULL,
	"reason" text,
	CONSTRAINT "return_lines_qty_chk" CHECK ("return_lines"."quantity" > 0 AND "return_lines"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "returns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"return_type" "return_type" NOT NULL,
	"document_number" text NOT NULL,
	"status" "return_status" DEFAULT 'DRAFT' NOT NULL,
	"order_id" uuid NOT NULL,
	"customer_id" uuid,
	"vendor_id" uuid,
	"return_date" date NOT NULL,
	"reference" text,
	"reason" text,
	"currency" text NOT NULL,
	"total" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit_note_id" uuid,
	"idempotency_key" text,
	"cancel_reason" text,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"credited_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "returns_party_chk" CHECK (("returns"."return_type" = 'SALES' AND "returns"."customer_id" IS NOT NULL AND "returns"."vendor_id" IS NULL)
        OR ("returns"."return_type" = 'PURCHASE' AND "returns"."vendor_id" IS NOT NULL AND "returns"."customer_id" IS NULL)),
	CONSTRAINT "returns_total_chk" CHECK ("returns"."total" >= 0)
);
--> statement-breakpoint
ALTER TABLE "bill_lines" DROP CONSTRAINT "bill_lines_amount_chk";--> statement-breakpoint
ALTER TABLE "invoice_lines" DROP CONSTRAINT "invoice_lines_amount_chk";--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "discount_percent" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "discount_percent" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "order_line_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sales_order_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "purchase_order_id" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "match_status" "match_status" DEFAULT 'NOT_REQUIRED' NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "match_exceptions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "match_reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "match_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD COLUMN "match_review_note" text;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_source_line_id_order_lines_id_fk" FOREIGN KEY ("source_line_id") REFERENCES "public"."order_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_converted_order_id_orders_id_fk" FOREIGN KEY ("converted_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchasing_settings" ADD CONSTRAINT "purchasing_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_return_id_returns_id_fk" FOREIGN KEY ("return_id") REFERENCES "public"."returns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "returns" ADD CONSTRAINT "returns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_number_uq" ON "goods_receipt_lines" USING btree ("goods_receipt_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipt_lines_order_line_uq" ON "goods_receipt_lines" USING btree ("goods_receipt_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_company_number_uq" ON "goods_receipts" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_idempotency_uq" ON "goods_receipts" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "goods_receipts_order_idx" ON "goods_receipts" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipts_company_status_idx" ON "goods_receipts" USING btree ("company_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "order_lines_number_uq" ON "order_lines" USING btree ("order_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_company_number_uq" ON "orders" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_uq" ON "orders" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "orders_company_type_status_idx" ON "orders" USING btree ("company_id","order_type","status");--> statement-breakpoint
CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "orders_vendor_idx" ON "orders" USING btree ("vendor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "return_lines_number_uq" ON "return_lines" USING btree ("return_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "return_lines_order_line_uq" ON "return_lines" USING btree ("return_id","order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "returns_company_number_uq" ON "returns" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "returns_idempotency_uq" ON "returns" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "returns_order_idx" ON "returns" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "returns_company_type_status_idx" ON "returns" USING btree ("company_id","return_type","status");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_order_line_id_order_lines_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "public"."order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sales_order_id_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_purchase_order_id_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vendor_bills" ADD CONSTRAINT "vendor_bills_match_reviewed_by_users_id_fk" FOREIGN KEY ("match_reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bill_lines_order_line_idx" ON "bill_lines" USING btree ("order_line_id");--> statement-breakpoint
CREATE INDEX "invoice_lines_order_line_idx" ON "invoice_lines" USING btree ("order_line_id");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_amount_chk" CHECK ("bill_lines"."amount" >= 0 AND "bill_lines"."quantity" > 0 AND "bill_lines"."discount_percent" BETWEEN 0 AND 100);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_amount_chk" CHECK ("invoice_lines"."amount" >= 0 AND "invoice_lines"."quantity" > 0 AND "invoice_lines"."discount_percent" BETWEEN 0 AND 100);