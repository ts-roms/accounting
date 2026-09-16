# Posting rules and account mapping

Source: `apps/api/src/modules/accounting/posting-rules/`.

Two layers keep account ids out of business logic:

1. **Account mappings** (`account_mappings`, `AccountsService.resolveMapped`):
   one account per well-known key (`ACCOUNTS_RECEIVABLE`, `OUTPUT_VAT`,
   `INVENTORY`, `RETAINED_EARNINGS`, ...). Entity-level mappings extend it:
   product category -> revenue / COGS / inventory accounts, asset category ->
   cost / depreciation accounts, tax code -> tax account, bank account -> GL
   account, customer / vendor defaults.
2. **Posting rules** (`posting_rules`): a declarative Dr / Cr template per
   transaction type that says which mapping, fixed account or caller-supplied
   account each line uses and which amount it carries.

## Rule shape

```json
{
  "transactionType": "CUSTOMER_INVOICE",
  "journalType": "GENERAL",
  "lines": [
    {
      "side": "DEBIT",
      "accountSource": "MAPPING",
      "mappingKey": "ACCOUNTS_RECEIVABLE",
      "amountKey": "GROSS"
    },
    { "side": "CREDIT", "accountSource": "CONTEXT", "accountKey": "REVENUE", "amountKey": "NET" },
    { "side": "CREDIT", "accountSource": "MAPPING", "mappingKey": "OUTPUT_VAT", "amountKey": "TAX" }
  ]
}
```

| `accountSource` | Account comes from                                                                          |
| --------------- | ------------------------------------------------------------------------------------------- |
| `MAPPING`       | `account_mappings[mappingKey]` of the company                                               |
| `ACCOUNT`       | a fixed postable account of the company                                                     |
| `CONTEXT`       | `accounts[accountKey]` supplied by the caller (e.g. the product category's revenue account) |

`amountKey` names an amount the caller supplies (`NET`, `TAX`, `GROSS`,
`WITHHOLDING`, ...).

## Resolution (`resolvePostingRule`, pure)

- A zero amount drops the line (an invoice without tax has no tax line).
- A negative amount flips the side, so credit notes reuse the invoice rule.
- A missing amount key, an unresolvable account or an unbalanced result throws
  `POSTING_RULE_UNRESOLVED` - a rule can never hand the engine a lopsided entry.
- Descriptions and dimensions from the context are copied onto every line.

## Using a rule from a module

```ts
const rule = await this.postingRules.resolve(tx, companyId, 'VENDOR_BILL', {
  amounts: { NET: '100', TAX: '12', GROSS: '112' },
  accounts: { EXPENSE: line.accountId },
  description: bill.documentNumber,
  dimensions: { departmentId: line.departmentId },
});
await this.posting.postEvent(
  tx,
  {
    companyId,
    entryDate,
    description,
    journalType: rule.journalType,
    lines: rule.lines,
    sourceType: 'AP_DOCUMENT',
    sourceId: bill.id,
    actor,
  },
  { permission: P['bill.post'] },
);
```

The existing subledgers (Phases 3-8) resolve their accounts through mappings
directly; the rule layer is the abstraction new transaction types should adopt.
Seeded rules: `CUSTOMER_INVOICE`, `VENDOR_BILL`, `CUSTOMER_RECEIPT`,
`VENDOR_PAYMENT`.

## API and UI

```
GET   /api/v1/accounting/posting-rules              posting-rule.view (includes `requirements`: amount / account / mapping keys)
POST  /api/v1/accounting/posting-rules              posting-rule.manage
PATCH /api/v1/accounting/posting-rules/:id          posting-rule.manage (lines, status)
POST  /api/v1/accounting/posting-rules/:id/simulate posting-rule.view - resolve against sample amounts, nothing posted
```

`/accounting/posting-rules` lists rules, lets a manager create / disable them
and "Try" a rule with sample amounts. Changes are audited (`PostingRule`).
