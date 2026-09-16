# Field mapping

`mapping/mapping.logic.ts` is a pure engine: `applyMapping(rules, input, ctx)`
turns an external record into the input the domain expects. Every integration
resolves its mapping per entity as: an active row in `integration_mappings`,
else the connector's `defaultMappings`, else nothing.

## Rule shape

```json
{
  "target": "email", // dotted path in the output
  "source": "customer.email", // dotted path in the input (arrays: items.0.price)
  "default": "PHP", // used when the source is missing / empty
  "transforms": [{ "name": "lower" }],
  "when": { "path": "status", "op": "in", "value": ["paid", "settled"] },
  "required": true // missing after transforms -> mapping error
}
```

Transforms (run in order): `trim`, `upper`, `lower`, `toString`, `toNumber`,
`toInteger`, `toDecimal` (decimal **string**, `arg` = scale, default 4),
`toBoolean`, `toDate` (-> `YYYY-MM-DD`), `negate`, `abs`, `multiply` / `divide`
(`arg` = factor, exact decimals via `Money`), `template` (`arg` = `"EC-{value}"`
or `"{first} {last}"`), `lookup` (`arg` = table name in `lookups`; `"*"` is the
fallback key), `default`, `convertCurrency` (`arg` = `{from, to}`; converts
**only** with an explicit rate in `ctx.rates`, never a guessed one), `mapEach`
(`arg` = nested rules applied to each array element - invoice lines),
`first`, `count`.

Conditions: `eq`, `ne`, `in`, `notIn`, `exists`, `missing`, `gt`, `gte`,
`lt`, `lte`, `matches` (regex).

Errors are collected per target, so a bad record fails once with every
problem listed (`MAPPING_ERROR` in the sync job's `failures`).

## Example (e-commerce order -> invoice)

```json
[
  {
    "target": "customerExternalId",
    "source": "customer_id",
    "transforms": [{ "name": "toString" }],
    "required": true
  },
  {
    "target": "documentDate",
    "source": "created_at",
    "transforms": [{ "name": "toDate" }],
    "required": true
  },
  { "target": "reference", "source": "order_number" },
  {
    "target": "lines",
    "source": "line_items",
    "required": true,
    "transforms": [
      {
        "name": "mapEach",
        "arg": [
          { "target": "description", "source": "title", "required": true },
          {
            "target": "quantity",
            "source": "quantity",
            "transforms": [{ "name": "toDecimal" }],
            "default": "1"
          },
          {
            "target": "unitPrice",
            "source": "price",
            "transforms": [{ "name": "toDecimal" }],
            "required": true
          }
        ]
      }
    ]
  }
]
```

The importer then validates the result with the same Zod schema as the REST
API (`createInvoiceSchema`) - mapping can only produce what a user could type.

## Endpoints

- `GET /integrations/:id/mappings` - stored mappings and connector defaults (`defaults` inbound, `outboundDefaults` for pushes)
- `POST /integrations/:id/mappings` - upsert (versioned, audited)
- `DELETE /integrations/:id/mappings/:mappingId`
- `POST /integrations/:id/mappings/preview` - dry-run a sample record (`direction: OUTBOUND` previews a push payload from a domain view)
- `GET /integrations/:id/external-references` - internal <-> external ids

## External references

`integration_external_references` links `(integration, entityType, externalId)`
to one internal id, and one internal id to one external id per integration.
Importers consult it first, which makes re-runs, replays and overlapping
cursor pages idempotent. User-supplied mappings are validated (Zod) and never
executed as code.
