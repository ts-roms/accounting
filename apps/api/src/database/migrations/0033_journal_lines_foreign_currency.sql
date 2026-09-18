ALTER TABLE "journal_lines" ADD COLUMN "foreign_currency" char(3);--> statement-breakpoint
-- Existing foreign amounts all come from manual foreign journals: their currency is the header's.
UPDATE "journal_lines" jl
SET "foreign_currency" = je."transaction_currency"
FROM "journal_entries" je
WHERE je."id" = jl."journal_entry_id"
  AND (jl."foreign_debit" IS NOT NULL OR jl."foreign_credit" IS NOT NULL)
  AND je."transaction_currency" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "journal_lines_foreign_currency_idx" ON "journal_lines" USING btree ("company_id","account_id","foreign_currency") WHERE "journal_lines"."foreign_currency" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_foreign_currency_chk" CHECK (("journal_lines"."foreign_currency" IS NULL) = ("journal_lines"."foreign_debit" IS NULL AND "journal_lines"."foreign_credit" IS NULL));
