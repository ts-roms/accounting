CREATE TYPE "public"."ai_anomaly_type" AS ENUM('DUPLICATE_DOCUMENT', 'UNUSUAL_AMOUNT', 'ROUND_AMOUNT', 'WEEKEND_POSTING', 'BACKDATED_ENTRY', 'MANUAL_CONTROL_POSTING', 'SAME_PERSON_LIFECYCLE');--> statement-breakpoint
CREATE TYPE "public"."ai_document_kind" AS ENUM('BILL', 'EXPENSE_CLAIM', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."ai_document_status" AS ENUM('EXTRACTED', 'NEEDS_REVIEW', 'DRAFTED', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."ai_message_role" AS ENUM('USER', 'ASSISTANT');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('HEURISTIC', 'ANTHROPIC');--> statement-breakpoint
CREATE TYPE "public"."ai_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."ai_suggestion_status" AS ENUM('OPEN', 'ACCEPTED', 'DISMISSED');--> statement-breakpoint
ALTER TYPE "public"."attachment_entity_type" ADD VALUE 'AI_DOCUMENT';--> statement-breakpoint
CREATE TABLE "ai_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "ai_document_status" DEFAULT 'EXTRACTED' NOT NULL,
	"kind" "ai_document_kind" DEFAULT 'UNKNOWN' NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"attachment_id" uuid,
	"source_text" text,
	"extracted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0' NOT NULL,
	"provider" "ai_provider" DEFAULT 'HEURISTIC' NOT NULL,
	"model" text,
	"vendor_id" uuid,
	"draft_bill_id" uuid,
	"draft_expense_claim_id" uuid,
	"error" text,
	"created_by" uuid,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_documents_confidence_chk" CHECK ("ai_documents"."confidence" >= 0 AND "ai_documents"."confidence" <= 1)
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" "ai_message_role" NOT NULL,
	"content" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" "ai_provider",
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"status" "ai_suggestion_status" DEFAULT 'OPEN' NOT NULL,
	"anomaly_type" "ai_anomaly_type" NOT NULL,
	"severity" "ai_severity" DEFAULT 'MEDIUM' NOT NULL,
	"fingerprint" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_number" text,
	"entity_date" text,
	"title" text NOT NULL,
	"detail" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5' NOT NULL,
	"provider" "ai_provider" DEFAULT 'HEURISTIC' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_attachment_id_attachments_id_fk" FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_vendor_id_vendors_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."vendors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_draft_bill_id_vendor_bills_id_fk" FOREIGN KEY ("draft_bill_id") REFERENCES "public"."vendor_bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_draft_expense_claim_id_expense_claims_id_fk" FOREIGN KEY ("draft_expense_claim_id") REFERENCES "public"."expense_claims"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_documents" ADD CONSTRAINT "ai_documents_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_suggestions" ADD CONSTRAINT "ai_suggestions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_conversations_user_idx" ON "ai_conversations" USING btree ("company_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_documents_company_status_idx" ON "ai_documents" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_messages_conversation_idx" ON "ai_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_suggestions_fingerprint_uq" ON "ai_suggestions" USING btree ("company_id","fingerprint");--> statement-breakpoint
CREATE INDEX "ai_suggestions_company_status_idx" ON "ai_suggestions" USING btree ("company_id","status","severity");--> statement-breakpoint
CREATE INDEX "ai_suggestions_entity_idx" ON "ai_suggestions" USING btree ("entity_type","entity_id");