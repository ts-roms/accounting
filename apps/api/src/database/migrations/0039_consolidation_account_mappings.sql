CREATE TABLE "consolidation_account_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"group_account_code" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consolidation_account_mappings" ADD CONSTRAINT "consolidation_account_mappings_group_id_consolidation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."consolidation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_account_mappings" ADD CONSTRAINT "consolidation_account_mappings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consolidation_account_mappings" ADD CONSTRAINT "consolidation_account_mappings_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consolidation_account_mappings_uq" ON "consolidation_account_mappings" USING btree ("group_id","account_id");--> statement-breakpoint
CREATE INDEX "consolidation_account_mappings_company_idx" ON "consolidation_account_mappings" USING btree ("group_id","company_id");