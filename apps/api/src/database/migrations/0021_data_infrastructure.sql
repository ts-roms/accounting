CREATE TYPE "public"."import_status" AS ENUM('VALIDATED', 'COMMITTED', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."import_type" AS ENUM('CHART_OF_ACCOUNTS', 'CUSTOMERS', 'VENDORS', 'PRODUCTS', 'OPENING_BALANCES', 'JOURNAL_ENTRIES', 'BANK_TRANSACTIONS');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'IMPORT' BEFORE 'RECOGNIZE';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'EXPORT' BEFORE 'RECOGNIZE';--> statement-breakpoint
ALTER TYPE "public"."adjustment_reason" ADD VALUE 'OPENING';--> statement-breakpoint
CREATE TABLE "numbering_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"branch_id" uuid,
	"prefix" text NOT NULL,
	"format" text DEFAULT '{PREFIX}-{YEAR}-{SEQ}' NOT NULL,
	"padding" integer DEFAULT 6 NOT NULL,
	"reset_yearly" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "numbering_rules_uq" UNIQUE NULLS NOT DISTINCT("company_id","document_type","branch_id"),
	CONSTRAINT "numbering_rules_padding_chk" CHECK ("numbering_rules"."padding" BETWEEN 3 AND 12),
	CONSTRAINT "numbering_rules_format_chk" CHECK (position('{SEQ}' in "numbering_rules"."format") > 0)
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" "import_type" NOT NULL,
	"status" "import_status" DEFAULT 'VALIDATED' NOT NULL,
	"file_name" text NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"valid_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"branch_id" uuid,
	"created_by" uuid,
	"committed_by" uuid,
	"committed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "document_sequences_uq";--> statement-breakpoint
ALTER TABLE "document_sequences" ADD COLUMN "branch_id" uuid;--> statement-breakpoint
ALTER TABLE "numbering_rules" ADD CONSTRAINT "numbering_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "numbering_rules" ADD CONSTRAINT "numbering_rules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_committed_by_users_id_fk" FOREIGN KEY ("committed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_jobs_company_idx" ON "import_jobs" USING btree ("company_id","created_at");--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sequences" ADD CONSTRAINT "document_sequences_uq" UNIQUE NULLS NOT DISTINCT("company_id","document_type","year","branch_id");