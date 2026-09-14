CREATE TYPE "public"."reconciliation_area" AS ENUM('AR', 'AP', 'INVENTORY', 'FIXED_ASSETS', 'TAX');--> statement-breakpoint
CREATE TYPE "public"."reconciliation_exception_status" AS ENUM('OPEN', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."subledger_reconciliation_status" AS ENUM('NOT_STARTED', 'IN_PROGRESS', 'RECONCILED', 'HAS_VARIANCE', 'UNDER_REVIEW', 'APPROVED');--> statement-breakpoint
ALTER TYPE "public"."attachment_entity_type" ADD VALUE 'RECONCILIATION';--> statement-breakpoint
CREATE TABLE "accounting_policies" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"reconciliation_materiality" numeric(19, 4) DEFAULT '0' NOT NULL,
	"reconciliation_stale_days" integer DEFAULT 35 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reconciliation_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "reconciliation_exception_status" DEFAULT 'OPEN' NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"reference" text,
	"raised_by" uuid,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"area" "reconciliation_area" NOT NULL,
	"as_of" date NOT NULL,
	"control_account_id" uuid NOT NULL,
	"status" "subledger_reconciliation_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"expected_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"actual_balance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"variance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"materiality" numeric(19, 4) DEFAULT '0' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"prepared_by" uuid,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliations_variance_chk" CHECK ("reconciliations"."variance" = "reconciliations"."actual_balance" - "reconciliations"."expected_balance")
);
--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD CONSTRAINT "accounting_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_raised_by_users_id_fk" FOREIGN KEY ("raised_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_exceptions" ADD CONSTRAINT "reconciliation_exceptions_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_control_account_id_accounts_id_fk" FOREIGN KEY ("control_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_exceptions_recon_idx" ON "reconciliation_exceptions" USING btree ("reconciliation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliations_company_area_account_date_uq" ON "reconciliations" USING btree ("company_id","area","control_account_id","as_of");--> statement-breakpoint
CREATE INDEX "reconciliations_company_status_idx" ON "reconciliations" USING btree ("company_id","status","as_of");