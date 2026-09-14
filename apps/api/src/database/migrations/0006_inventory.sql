CREATE TYPE "public"."adjustment_reason" AS ENUM('DAMAGE', 'SHRINKAGE', 'EXPIRY', 'COUNT_VARIANCE', 'CORRECTION', 'FOUND', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."costing_method" AS ENUM('FIFO', 'WEIGHTED_AVERAGE');--> statement-breakpoint
CREATE TYPE "public"."movement_source_type" AS ENUM('GOODS_RECEIPT', 'GOODS_RECEIPT_CANCEL', 'AR_DOCUMENT', 'AR_DOCUMENT_VOID', 'AP_DOCUMENT', 'AP_DOCUMENT_VOID', 'STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'STOCK_COUNT');--> statement-breakpoint
CREATE TYPE "public"."movement_type" AS ENUM('RECEIPT', 'ISSUE', 'TRANSFER_IN', 'TRANSFER_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'RETURN_IN', 'RETURN_OUT');--> statement-breakpoint
CREATE TYPE "public"."product_type" AS ENUM('GOODS', 'SERVICE');--> statement-breakpoint
CREATE TYPE "public"."serial_status" AS ENUM('IN_STOCK', 'ISSUED');--> statement-breakpoint
CREATE TYPE "public"."stock_direction" AS ENUM('IN', 'OUT');--> statement-breakpoint
CREATE TYPE "public"."stock_document_status" AS ENUM('DRAFT', 'POSTED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."stock_document_type" AS ENUM('ADJUSTMENT', 'TRANSFER', 'COUNT');--> statement-breakpoint
CREATE TYPE "public"."tracking_mode" AS ENUM('NONE', 'LOT', 'SERIAL');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'INVENTORY_ADJUSTMENT' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'GOODS_RECEIVED_NOT_INVOICED' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'PURCHASE_PRICE_VARIANCE' BEFORE 'SALES_REVENUE';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'ADJ';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'TRF';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'CNT';--> statement-breakpoint
CREATE TABLE "inventory_balances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"lot_id" uuid,
	"quantity_on_hand" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_balances_uq" UNIQUE NULLS NOT DISTINCT("product_id","warehouse_id","lot_id")
);
--> statement-breakpoint
CREATE TABLE "inventory_layers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"lot_id" uuid,
	"movement_id" uuid NOT NULL,
	"received_date" date NOT NULL,
	"sequence" integer NOT NULL,
	"quantity_received" numeric(19, 4) NOT NULL,
	"quantity_remaining" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	CONSTRAINT "inventory_layers_qty_chk" CHECK ("inventory_layers"."quantity_received" > 0 AND "inventory_layers"."quantity_remaining" >= 0 AND "inventory_layers"."quantity_remaining" <= "inventory_layers"."quantity_received")
);
--> statement-breakpoint
CREATE TABLE "inventory_movements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"location_id" uuid,
	"lot_id" uuid,
	"movement_type" "movement_type" NOT NULL,
	"movement_date" date NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"unit_cost" numeric(19, 4) NOT NULL,
	"total_cost" numeric(19, 4) NOT NULL,
	"balance_after" numeric(19, 4) NOT NULL,
	"source_type" "movement_source_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"source_line_id" uuid,
	"journal_entry_id" uuid,
	"reverses_movement_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inventory_movements_qty_chk" CHECK ("inventory_movements"."quantity" > 0 AND "inventory_movements"."unit_cost" >= 0 AND "inventory_movements"."total_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "inventory_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"default_costing_method" "costing_method" DEFAULT 'WEIGHTED_AVERAGE' NOT NULL,
	"allow_negative_stock" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "movement_serials" (
	"movement_id" uuid NOT NULL,
	"serial_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"parent_id" uuid,
	"inventory_account_id" uuid,
	"cogs_account_id" uuid,
	"revenue_account_id" uuid,
	"expense_account_id" uuid,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category_id" uuid,
	"product_type" "product_type" DEFAULT 'GOODS' NOT NULL,
	"tracking_mode" "tracking_mode" DEFAULT 'NONE' NOT NULL,
	"costing_method" "costing_method",
	"unit_of_measure" text DEFAULT 'pc' NOT NULL,
	"barcode" text,
	"sale_price" numeric(19, 4),
	"purchase_price" numeric(19, 4),
	"standard_cost" numeric(19, 4),
	"reorder_level" numeric(19, 4),
	"reorder_quantity" numeric(19, 4),
	"inventory_account_id" uuid,
	"cogs_account_id" uuid,
	"revenue_account_id" uuid,
	"expense_account_id" uuid,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_prices_chk" CHECK (("products"."sale_price" IS NULL OR "products"."sale_price" >= 0) AND ("products"."purchase_price" IS NULL OR "products"."purchase_price" >= 0) AND ("products"."standard_cost" IS NULL OR "products"."standard_cost" >= 0))
);
--> statement-breakpoint
CREATE TABLE "serial_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"status" serial_status DEFAULT 'IN_STOCK' NOT NULL,
	"warehouse_id" uuid,
	"lot_id" uuid,
	"last_movement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_document_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"location_id" uuid,
	"lot_number" text,
	"expiry_date" date,
	"serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"direction" "stock_direction" DEFAULT 'OUT' NOT NULL,
	"quantity" numeric(19, 4) NOT NULL,
	"expected_quantity" numeric(19, 4),
	"counted_quantity" numeric(19, 4),
	"unit_cost" numeric(19, 4),
	"total_cost" numeric(19, 4),
	"notes" text,
	CONSTRAINT "stock_document_lines_qty_chk" CHECK ("stock_document_lines"."quantity" >= 0)
);
--> statement-breakpoint
CREATE TABLE "stock_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" "stock_document_type" NOT NULL,
	"document_number" text NOT NULL,
	"status" "stock_document_status" DEFAULT 'DRAFT' NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"to_warehouse_id" uuid,
	"document_date" date NOT NULL,
	"reason" "adjustment_reason",
	"reference" text,
	"notes" text,
	"currency" text NOT NULL,
	"total_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"journal_entry_id" uuid,
	"idempotency_key" text,
	"cancel_reason" text,
	"posted_by" uuid,
	"posted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_documents_transfer_chk" CHECK (("stock_documents"."document_type" = 'TRANSFER' AND "stock_documents"."to_warehouse_id" IS NOT NULL AND "stock_documents"."to_warehouse_id" <> "stock_documents"."warehouse_id") OR ("stock_documents"."document_type" <> 'TRANSFER' AND "stock_documents"."to_warehouse_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "stock_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"lot_number" text NOT NULL,
	"expiry_date" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouse_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"warehouse_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"branch_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"address_line1" text,
	"city" text,
	"notes" text,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD COLUMN "cost_amount" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "cost_amount" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "expiry_date" date;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD COLUMN "unit_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD COLUMN "reversal_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "order_lines" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "product_id" uuid;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "warehouse_id" uuid;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "lot_number" text;--> statement-breakpoint
ALTER TABLE "return_lines" ADD COLUMN "serial_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_layers" ADD CONSTRAINT "inventory_layers_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_reverses_movement_id_inventory_movements_id_fk" FOREIGN KEY ("reverses_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_settings" ADD CONSTRAINT "inventory_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_serials" ADD CONSTRAINT "movement_serials_movement_id_inventory_movements_id_fk" FOREIGN KEY ("movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "movement_serials" ADD CONSTRAINT "movement_serials_serial_id_serial_numbers_id_fk" FOREIGN KEY ("serial_id") REFERENCES "public"."serial_numbers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_parent_id_product_categories_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_inventory_account_id_accounts_id_fk" FOREIGN KEY ("inventory_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_cogs_account_id_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_categories" ADD CONSTRAINT "product_categories_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_product_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."product_categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_inventory_account_id_accounts_id_fk" FOREIGN KEY ("inventory_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_cogs_account_id_accounts_id_fk" FOREIGN KEY ("cogs_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_revenue_account_id_accounts_id_fk" FOREIGN KEY ("revenue_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_expense_account_id_accounts_id_fk" FOREIGN KEY ("expense_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_lot_id_stock_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."stock_lots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "serial_numbers" ADD CONSTRAINT "serial_numbers_last_movement_id_inventory_movements_id_fk" FOREIGN KEY ("last_movement_id") REFERENCES "public"."inventory_movements"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_document_id_stock_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."stock_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_document_lines" ADD CONSTRAINT "stock_document_lines_location_id_warehouse_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."warehouse_locations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_posted_by_users_id_fk" FOREIGN KEY ("posted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_documents" ADD CONSTRAINT "stock_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_lots" ADD CONSTRAINT "stock_lots_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_balances_company_idx" ON "inventory_balances" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "inventory_layers_open_idx" ON "inventory_layers" USING btree ("product_id","warehouse_id","lot_id","received_date","sequence");--> statement-breakpoint
CREATE INDEX "inventory_movements_product_wh_idx" ON "inventory_movements" USING btree ("product_id","warehouse_id","movement_date");--> statement-breakpoint
CREATE INDEX "inventory_movements_source_idx" ON "inventory_movements" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "inventory_movements_company_date_idx" ON "inventory_movements" USING btree ("company_id","movement_date");--> statement-breakpoint
CREATE UNIQUE INDEX "movement_serials_uq" ON "movement_serials" USING btree ("movement_id","serial_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_categories_company_code_uq" ON "product_categories" USING btree ("company_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "products_company_sku_uq" ON "products" USING btree ("company_id","sku");--> statement-breakpoint
CREATE INDEX "products_company_name_idx" ON "products" USING btree ("company_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "serial_numbers_product_serial_uq" ON "serial_numbers" USING btree ("product_id","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_document_lines_number_uq" ON "stock_document_lines" USING btree ("document_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_company_number_uq" ON "stock_documents" USING btree ("company_id","document_number");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_documents_idempotency_uq" ON "stock_documents" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "stock_documents_company_type_status_idx" ON "stock_documents" USING btree ("company_id","document_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_lots_product_number_uq" ON "stock_lots" USING btree ("product_id","lot_number");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouse_locations_code_uq" ON "warehouse_locations" USING btree ("warehouse_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_company_code_uq" ON "warehouses" USING btree ("company_id","code");--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_lines" ADD CONSTRAINT "bill_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_reversal_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("reversal_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_lines" ADD CONSTRAINT "order_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "return_lines" ADD CONSTRAINT "return_lines_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;