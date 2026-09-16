CREATE TYPE "public"."consolidation_method" AS ENUM('FULL', 'PROPORTIONATE');--> statement-breakpoint
CREATE TYPE "public"."consolidation_run_status" AS ENUM('DRAFT', 'FINAL');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'FINALIZE';--> statement-breakpoint
CREATE TABLE "consolidation_adjustment_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"adjustment_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"group_account_id" uuid NOT NULL,
	"debit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"credit" numeric(19, 4) DEFAULT '0' NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "consolidation_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"effective_date" date NOT NULL,
	"recurring_until" date,
	"reference" text,
	"description" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consolidation_group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"ownership_pct" numeric(7, 4) DEFAULT '100' NOT NULL,
	"method" "consolidation_method" DEFAULT 'FULL' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consolidation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"presentation_currency" char(3) NOT NULL,
	"parent_company_id" uuid NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consolidation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"currency" char(3) NOT NULL,
	"status" "consolidation_run_status" DEFAULT 'DRAFT' NOT NULL,
	"report" jsonb NOT NULL,
	"readiness" jsonb NOT NULL,
	"created_by" uuid,
	"finalized_by" uuid,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"group_account_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"is_intercompany" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consolidation_adjustment_lines" ADD CONSTRAINT "consolidation_adjustment_lines_adjustment_id_consolidation_adjustments_id_fk" FOREIGN KEY ("adjustment_id") REFERENCES "public"."consolidation_adjustments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustment_lines" ADD CONSTRAINT "consolidation_adjustment_lines_group_account_id_group_accounts_id_fk" FOREIGN KEY ("group_account_id") REFERENCES "public"."group_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_adjustments" ADD CONSTRAINT "consolidation_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_group_members" ADD CONSTRAINT "consolidation_group_members_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_group_members" ADD CONSTRAINT "consolidation_group_members_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_parent_company_id_companies_id_fk" FOREIGN KEY ("parent_company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_groups" ADD CONSTRAINT "consolidation_groups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_runs" ADD CONSTRAINT "consolidation_runs_finalized_by_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_account_mappings" ADD CONSTRAINT "group_account_mappings_group_account_id_group_accounts_id_fk" FOREIGN KEY ("group_account_id") REFERENCES "public"."group_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_accounts" ADD CONSTRAINT "group_accounts_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consolidation_adjustment_lines_adj_idx" ON "consolidation_adjustment_lines" USING btree ("adjustment_id");--> statement-breakpoint
CREATE INDEX "consolidation_adjustments_group_date_idx" ON "consolidation_adjustments" USING btree ("group_id","effective_date");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_group_members_uq" ON "consolidation_group_members" USING btree ("group_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_groups_org_code_uq" ON "consolidation_groups" USING btree ("organization_id","code");--> statement-breakpoint
CREATE INDEX "consolidation_runs_group_idx" ON "consolidation_runs" USING btree ("group_id","to_date");--> statement-breakpoint
CREATE UNIQUE INDEX "group_account_mappings_uq" ON "group_account_mappings" USING btree ("group_id","account_id");--> statement-breakpoint
CREATE INDEX "group_account_mappings_company_idx" ON "group_account_mappings" USING btree ("group_id","company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "group_accounts_group_code_uq" ON "group_accounts" USING btree ("group_id","code");