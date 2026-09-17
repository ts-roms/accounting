CREATE TYPE "public"."bank_feed_action" AS ENUM('POST_TRANSACTION', 'RECEIVE_CUSTOMER', 'PAY_VENDOR', 'IGNORE');--> statement-breakpoint
CREATE TYPE "public"."bank_feed_result_type" AS ENUM('BANK_TRANSACTION', 'CUSTOMER_PAYMENT', 'VENDOR_PAYMENT', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_direction" AS ENUM('IN', 'OUT', 'ANY');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_match_mode" AS ENUM('CONTAINS', 'STARTS_WITH', 'REGEX');--> statement-breakpoint
CREATE TYPE "public"."bank_rule_status" AS ENUM('ACTIVE', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."bank_suggestion_confidence" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."bank_suggestion_source" AS ENUM('RULE', 'DOCUMENT', 'HISTORY', 'MANUAL');--> statement-breakpoint
CREATE TYPE "public"."bank_suggestion_status" AS ENUM('PENDING', 'APPLIED', 'DISMISSED', 'SUPERSEDED');--> statement-breakpoint
ALTER TYPE "public"."match_kind" ADD VALUE 'RULE';--> statement-breakpoint
CREATE TABLE "bank_feed_settings" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"auto_apply_rules" boolean DEFAULT true NOT NULL,
	"auto_apply_document_matches" boolean DEFAULT false NOT NULL,
	"stale_after_days" integer DEFAULT 7 NOT NULL,
	"history_min_occurrences" integer DEFAULT 2 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_line_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"statement_line_id" uuid NOT NULL,
	"source" "bank_suggestion_source" NOT NULL,
	"action" "bank_feed_action" NOT NULL,
	"rule_id" uuid,
	"confidence" "bank_suggestion_confidence" NOT NULL,
	"payload" jsonb NOT NULL,
	"explanation" text NOT NULL,
	"status" "bank_suggestion_status" DEFAULT 'PENDING' NOT NULL,
	"result_type" "bank_feed_result_type",
	"result_id" uuid,
	"result_number" text,
	"journal_line_id" uuid,
	"applied_by" uuid,
	"applied_at" timestamp with time zone,
	"dismissed_by" uuid,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_matching_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 100 NOT NULL,
	"status" "bank_rule_status" DEFAULT 'ACTIVE' NOT NULL,
	"bank_account_id" uuid,
	"direction" "bank_rule_direction" DEFAULT 'ANY' NOT NULL,
	"description_pattern" text,
	"description_mode" "bank_rule_match_mode" DEFAULT 'CONTAINS' NOT NULL,
	"reference_pattern" text,
	"reference_mode" "bank_rule_match_mode" DEFAULT 'CONTAINS' NOT NULL,
	"amount_min" numeric(19, 4),
	"amount_max" numeric(19, 4),
	"action" "bank_feed_action" NOT NULL,
	"transaction_type" "bank_transaction_type",
	"counterparty_account_id" uuid,
	"party_id" uuid,
	"memo" text,
	"branch_id" uuid,
	"department_id" uuid,
	"cost_center_id" uuid,
	"project_id" uuid,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_hit_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_feed_settings" ADD CONSTRAINT "bank_feed_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_statement_line_id_bank_statement_lines_id_fk" FOREIGN KEY ("statement_line_id") REFERENCES "public"."bank_statement_lines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_rule_id_bank_matching_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."bank_matching_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_journal_line_id_journal_lines_id_fk" FOREIGN KEY ("journal_line_id") REFERENCES "public"."journal_lines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_applied_by_users_id_fk" FOREIGN KEY ("applied_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_line_suggestions" ADD CONSTRAINT "bank_line_suggestions_dismissed_by_users_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_counterparty_account_id_accounts_id_fk" FOREIGN KEY ("counterparty_account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_department_id_dimensions_id_fk" FOREIGN KEY ("department_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_cost_center_id_dimensions_id_fk" FOREIGN KEY ("cost_center_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_project_id_dimensions_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."dimensions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_matching_rules" ADD CONSTRAINT "bank_matching_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_line_suggestions_line_idx" ON "bank_line_suggestions" USING btree ("statement_line_id","status");--> statement-breakpoint
CREATE INDEX "bank_line_suggestions_company_status_idx" ON "bank_line_suggestions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "bank_matching_rules_company_idx" ON "bank_matching_rules" USING btree ("company_id","status","priority");