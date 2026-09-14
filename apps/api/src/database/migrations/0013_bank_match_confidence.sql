CREATE TYPE "public"."match_confidence" AS ENUM('HIGH', 'MEDIUM');--> statement-breakpoint
ALTER TYPE "public"."statement_line_status" ADD VALUE 'POSSIBLE_MATCH' BEFORE 'MATCHED';--> statement-breakpoint
ALTER TABLE "banking_settings" ADD COLUMN "auto_match_min_confidence" "match_confidence" DEFAULT 'MEDIUM' NOT NULL;