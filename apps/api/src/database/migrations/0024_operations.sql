CREATE TYPE "public"."integrity_run_status" AS ENUM('OK', 'WARNING', 'CRITICAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."job_run_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED_LOCKED');--> statement-breakpoint
CREATE TYPE "public"."job_trigger" AS ENUM('SCHEDULED', 'MANUAL', 'STARTUP');--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'JOB_RUN';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'QUEUE_RETRY';--> statement-breakpoint
ALTER TYPE "public"."audit_action" ADD VALUE 'QUEUE_DISCARD';--> statement-breakpoint
CREATE TABLE "integrity_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"status" "integrity_run_status" NOT NULL,
	"critical_count" integer DEFAULT 0 NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"notified" boolean DEFAULT false NOT NULL,
	"job_run_id" uuid,
	"triggered_by" uuid,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"trigger" "job_trigger" DEFAULT 'SCHEDULED' NOT NULL,
	"status" "job_run_status" DEFAULT 'RUNNING' NOT NULL,
	"instance_id" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"result" jsonb,
	"error" text,
	"triggered_by" uuid
);
--> statement-breakpoint
ALTER TABLE "integrity_runs" ADD CONSTRAINT "integrity_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_runs" ADD CONSTRAINT "integrity_runs_job_run_id_job_runs_id_fk" FOREIGN KEY ("job_run_id") REFERENCES "public"."job_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrity_runs" ADD CONSTRAINT "integrity_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_runs" ADD CONSTRAINT "job_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integrity_runs_company_ran_idx" ON "integrity_runs" USING btree ("company_id","ran_at");--> statement-breakpoint
CREATE INDEX "job_runs_name_started_idx" ON "job_runs" USING btree ("job_name","started_at");--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status","started_at");