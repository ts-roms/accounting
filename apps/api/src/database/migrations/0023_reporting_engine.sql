CREATE TYPE "public"."report_basis" AS ENUM('PERIOD', 'AS_OF');--> statement-breakpoint
CREATE TYPE "public"."report_category" AS ENUM('FINANCIAL', 'MANAGEMENT', 'CUSTOM');--> statement-breakpoint
CREATE TABLE "report_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" "report_category" DEFAULT 'CUSTOM' NOT NULL,
	"basis" "report_basis" DEFAULT 'PERIOD' NOT NULL,
	"layout" jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"status" "entity_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_definitions" ADD CONSTRAINT "report_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "report_definitions_company_code_uq" ON "report_definitions" USING btree ("company_id","code");--> statement-breakpoint
CREATE INDEX "report_definitions_company_idx" ON "report_definitions" USING btree ("company_id","category","status");