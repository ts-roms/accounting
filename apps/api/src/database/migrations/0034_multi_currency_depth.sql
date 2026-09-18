ALTER TYPE "public"."fx_side" ADD VALUE 'BANK';--> statement-breakpoint
ALTER TYPE "public"."fx_side" ADD VALUE 'LEASE';--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_events" ADD COLUMN "liability_change_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_events" ADD COLUMN "rou_change_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD COLUMN "depreciation_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "lease_schedule_lines" ADD COLUMN "interest_base" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "liability_balance_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "rou_cost_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "leases" ADD COLUMN "rou_accumulated_depreciation_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Everything booked so far was in the company base currency: base = contract amounts, rate 1.
UPDATE "bank_transactions" SET "base_amount" = "amount";--> statement-breakpoint
UPDATE "leases" SET "liability_balance_base" = "liability_balance", "rou_cost_base" = "rou_cost", "rou_accumulated_depreciation_base" = "rou_accumulated_depreciation";--> statement-breakpoint
UPDATE "lease_schedule_lines" SET "depreciation_base" = "depreciation", "interest_base" = CASE WHEN "status" = 'POSTED' THEN "interest" ELSE NULL END;--> statement-breakpoint
UPDATE "lease_events" SET "liability_change_base" = "liability_change", "rou_change_base" = "rou_change";
