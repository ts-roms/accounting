CREATE TYPE "public"."consolidation_adjustment_status" AS ENUM('ACTIVE', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."consolidation_adjustment_type" AS ENUM('TRANSLATION', 'ELIMINATION', 'EQUITY_PICKUP', 'NON_CONTROLLING_INTEREST', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."consolidation_group_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."consolidation_method" AS ENUM('FULL', 'PROPORTIONAL', 'EQUITY');--> statement-breakpoint
CREATE TYPE "public"."consolidation_run_status" AS ENUM('DRAFT', 'FINALIZED');--> statement-breakpoint
CREATE TYPE "public"."elimination_rule_type" AS ENUM('INTERCOMPANY_BALANCES', 'INTERCOMPANY_PROFIT_LOSS', 'INVESTMENT_EQUITY', 'UNREALIZED_PROFIT', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."translation_method" AS ENUM('CURRENT_RATE', 'CLOSING_RATE');--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'INVESTMENT_IN_SUBSIDIARIES';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'GOODWILL';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'NON_CONTROLLING_INTEREST';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'CUMULATIVE_TRANSLATION_ADJUSTMENT';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'INTERCOMPANY_DIFFERENCE';--> statement-breakpoint
ALTER TYPE "public"."account_mapping_key" ADD VALUE 'SHARE_OF_ASSOCIATE_PROFIT';--> statement-breakpoint
ALTER TYPE "public"."document_type" ADD VALUE 'CON';--> statement-breakpoint
ALTER TYPE "public"."intercompany_status" ADD VALUE 'SETTLED' BEFORE 'REVERSED';--> statement-breakpoint
ALTER TYPE "public"."workflow_document_type" ADD VALUE 'CONSOLIDATION_RUN';--> statement-breakpoint
CREATE TABLE "consolidation_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"company_id" uuid,
	"account_code" text NOT NULL,
	"account_name" text NOT NULL,
	"account_type" text NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"description" text,
	CONSTRAINT "consolidation_adjustment_lines_chk" CHECK ("consolidation_adjustment_lines"."debit" >= 0 and "consolidation_adjustment_lines"."credit" >= 0 and ("consolidation_adjustment_lines"."debit" = 0 or "consolidation_adjustment_lines"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "consolidation_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"type" "consolidation_adjustment_type" NOT NULL,
	"status" "consolidation_adjustment_status" DEFAULT 'ACTIVE' NOT NULL,
	"rule_id" uuid,
	"company_id" uuid,
	"description" text NOT NULL,
	"reference" text,
	"auto_generated" boolean DEFAULT false NOT NULL,
	"total_debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"total_credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consolidation_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"method" "consolidation_method" DEFAULT 'FULL' NOT NULL,
	"ownership_percent" numeric(19, 4) DEFAULT '100' NOT NULL,
	"acquisition_date" date,
	"disposal_date" date,
	"acquisition_equity" numeric(19, 4) DEFAULT '0' NOT NULL,
	"investment_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"historical_rate" numeric(19, 8),
	"sort_order" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_group_members_percent_chk" CHECK ("consolidation_group_members"."ownership_percent" >= 0 and "consolidation_group_members"."ownership_percent" <= 100)
);
--> statement-breakpoint
CREATE TABLE "consolidation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" "consolidation_group_status" DEFAULT 'ACTIVE' NOT NULL,
	"parent_company_id" uuid NOT NULL,
	"presentation_currency" char(3) NOT NULL,
	"translation_method" "translation_method" DEFAULT 'CURRENT_RATE' NOT NULL,
	"intercompany_tolerance" numeric(19, 4) DEFAULT '0' NOT NULL,
	"require_periods_closed" boolean DEFAULT true NOT NULL,
	"accounts" jsonb NOT NULL,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consolidation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"document_number" text NOT NULL,
	"status" "consolidation_run_status" DEFAULT 'DRAFT' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"currency" char(3) NOT NULL,
	"description" text,
	"rates" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rate_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"snapshot" jsonb,
	"snapshot_at" timestamp with time zone,
	"prepared_by" uuid,
	"prepared_at" timestamp with time zone,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"finalize_note" text,
	"reopened_by" uuid,
	"reopened_at" timestamp with time zone,
	"reopen_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consolidation_runs_period_chk" CHECK ("consolidation_runs"."period_end" >= "consolidation_runs"."period_start")
);
--> statement-breakpoint
CREATE TABLE "elimination_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "elimination_rule_type" NOT NULL,
	"description" text,
	"auto_apply" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "intercompany_org_number_uq";--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD COLUMN "settlement_date" date;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD COLUMN "settlement_from_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD COLUMN "settlement_to_journal_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD COLUMN "settled_by" uuid;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD COLUMN "settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "consolidation_adjustment_lines" ADD CONSTRAINT "consolidation_adjustment_lines_adjustment_id_consolidation_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."consolidation_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustment_lines" ADD CONSTRAINT "consolidation_adjustment_lines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_run_id_consolidation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."consolidation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_rule_id_elimination_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."elimination_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_group_members" ADD CONSTRAINT "consolidation_group_members_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_group_members" ADD CONSTRAINT "consolidation_group_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_parent_company_id_companies_id_fk" FOREIGN KEY ("parent_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_prepared_by_users_id_fk" FOREIGN KEY ("prepared_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_reopened_by_users_id_fk" FOREIGN KEY ("reopened_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elimination_rules" ADD CONSTRAINT "elimination_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_adjustment_lines_uq" ON "consolidation_adjustment_lines" USING btree ("adjustment_id","line_number");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_adjustments_run_seq_uq" ON "consolidation_adjustments" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "consolidation_adjustments_run_idx" ON "consolidation_adjustments" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_group_members_uq" ON "consolidation_group_members" USING btree ("group_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_groups_org_code_uq" ON "consolidation_groups" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_runs_group_number_uq" ON "consolidation_runs" USING btree ("group_id","document_number");--> statement-breakpoint
CREATE INDEX "consolidation_runs_group_period_idx" ON "consolidation_runs" USING btree ("group_id","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "elimination_rules_group_code_uq" ON "elimination_rules" USING btree ("group_id","code");--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_settlement_from_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("settlement_from_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_settlement_to_journal_entry_id_journal_entries_id_fk" FOREIGN KEY ("settlement_to_journal_entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intercompany_transactions" ADD CONSTRAINT "intercompany_transactions_settled_by_users_id_fk" FOREIGN KEY ("settled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "intercompany_company_number_uq" ON "intercompany_transactions" USING btree ("from_company_id","document_number");