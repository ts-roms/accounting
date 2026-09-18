ALTER TABLE "employees" ADD COLUMN "currency" char(3);--> statement-breakpoint
-- Everyone so far is paid in the company base currency.
UPDATE "employees" e SET "currency" = c."base_currency" FROM "companies" c WHERE c."id" = e."company_id";--> statement-breakpoint
ALTER TABLE "employees" ALTER COLUMN "currency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "exchange_rate" numeric(19, 8) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "gross_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "taxable_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "withholding_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "deduction_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "employer_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "reimbursement_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "net_total_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_runs" ADD COLUMN "paid_base" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "payslip_lines" ADD COLUMN "base_amount" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "gross_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "taxable_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "withholding_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "deductions_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "employer_contributions_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "reimbursements_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "net_base" numeric(19, 4) DEFAULT '0' NOT NULL;--> statement-breakpoint
-- Existing runs were in base: base figures mirror the pay-currency figures, rate 1.
UPDATE "pay_runs" SET "gross_total_base" = "gross_total", "taxable_total_base" = "taxable_total", "withholding_total_base" = "withholding_total", "deduction_total_base" = "deduction_total", "employer_total_base" = "employer_total", "reimbursement_total_base" = "reimbursement_total", "net_total_base" = "net_total", "paid_base" = CASE WHEN "status" = 'PAID' THEN "net_total" ELSE NULL END;--> statement-breakpoint
UPDATE "payslips" SET "gross_base" = "gross", "taxable_base" = "taxable", "withholding_base" = "withholding", "deductions_base" = "deductions", "employer_contributions_base" = "employer_contributions", "reimbursements_base" = "reimbursements", "net_base" = "net";--> statement-breakpoint
UPDATE "payslip_lines" SET "base_amount" = "amount";
