# Tax (implemented in Phase 7)

Implementation: `apps/api/src/modules/tax` - codes / rates (`TaxCodesService`),
the engine (`TaxEngineService`: per-line computation, balancing journal lines,
`tax_transactions` register, reversal), reports (`TaxReportsService`). The
seeded Philippine defaults (VAT12, VAT0, EXEMPT, EWT1, EWT2) are data only;
withholding is computed on the document (invoice / bill) and reduces what the
counterparty settles. BIR-specific formats remain report presets over the same
register.

## Principles

- Tax rules are **data**, never code: `tax_codes` (e.g. `VAT12`, `VAT0`,
  `EXEMPT`, `EWT1`, `EWT2`), `tax_rates` (effective-dated), and per-line
  `tax_transactions` recorded at posting time.
- Documents (invoices, bills, expense claims) reference a tax code per line; the
  tax engine computes amounts and returns the accounting lines (input/output tax
  and withholding) that the posting service adds to the journal.
- Account mapping per tax code: output VAT payable, input VAT receivable,
  withholding tax payable/receivable.

## Philippine deployment considerations

- Base currency default `PHP`; company TIN stored on `companies`.
- VAT (12%), zero-rated and exempt classifications; input vs output VAT.
- Expanded withholding tax (EWT) and final withholding on vendor payments;
  creditable withholding on customer receipts.
- Tax periods (monthly/quarterly) with close status, mirroring fiscal periods.
- BIR-oriented reports (e.g. VAT relief summaries, withholding certificates,
  books of accounts extracts) are produced from `tax_transactions` and the GL by
  a dedicated `PhilippineTaxReportingModule` so the core engine stays
  jurisdiction-neutral.
- Electronic invoicing integration is designed as an outbound adapter consuming
  posted invoices; no claim of BIR accreditation or certification is made until
  the required registration is actually completed.

## Extensibility

Other jurisdictions add tax codes, rates and report modules without touching
the posting engine.
