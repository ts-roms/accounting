DROP INDEX "integration_sync_cursors_uq";--> statement-breakpoint
ALTER TABLE "integration_sync_cursors" ADD COLUMN "direction" "integration_direction" DEFAULT 'INBOUND' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_sync_jobs" ADD COLUMN "direction" "integration_direction" DEFAULT 'INBOUND' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_sync_cursors_uq" ON "integration_sync_cursors" USING btree ("integration_id","entity","direction");