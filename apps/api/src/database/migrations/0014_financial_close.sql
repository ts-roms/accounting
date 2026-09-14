CREATE TYPE "public"."close_status" AS ENUM('IN_PROGRESS', 'READY', 'APPROVED', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."close_task_kind" AS ENUM('AUTO', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."close_task_status" AS ENUM('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED', 'BLOCKED');--> statement-breakpoint
CREATE TYPE "public"."close_type" AS ENUM('MONTH', 'QUARTER', 'YEAR');--> statement-breakpoint
CREATE TABLE "close_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"close_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"kind" "close_task_kind" NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "close_task_status" DEFAULT 'PENDING' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_id" uuid,
	"reviewer_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"completed_by" uuid,
	"notes" text,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_closes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"fiscal_period_id" uuid NOT NULL,
	"close_type" "close_type" DEFAULT 'MONTH' NOT NULL,
	"status" "close_status" DEFAULT 'IN_PROGRESS' NOT NULL,
	"blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evaluated_at" timestamp with time zone,
	"started_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"approval_notes" text,
	"completed_by" uuid,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_reconciliations" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_bank_reconciliation" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_depreciation" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_fx_revaluation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_block_on_unapproved_journals" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_block_on_open_exceptions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_require_integrity_ok" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "accounting_policies" ADD COLUMN "close_lock_on_complete" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_close_id_financial_closes_id_fk" FOREIGN KEY ("close_id") REFERENCES "public"."financial_closes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "close_tasks" ADD CONSTRAINT "close_tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_fiscal_period_id_fiscal_periods_id_fk" FOREIGN KEY ("fiscal_period_id") REFERENCES "public"."fiscal_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_closes" ADD CONSTRAINT "financial_closes_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "close_tasks_close_key_uq" ON "close_tasks" USING btree ("close_id","key");--> statement-breakpoint
CREATE INDEX "close_tasks_close_idx" ON "close_tasks" USING btree ("close_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "financial_closes_period_live_uq" ON "financial_closes" USING btree ("fiscal_period_id") WHERE "financial_closes"."status" IN ('IN_PROGRESS', 'READY', 'APPROVED');--> statement-breakpoint
CREATE INDEX "financial_closes_company_status_idx" ON "financial_closes" USING btree ("company_id","status");