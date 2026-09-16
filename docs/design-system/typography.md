# Typography

Fonts: **Geist Sans** for UI, **Geist Mono** for codes and figures (self-hosted
through the `geist` package; the CSS falls back to Inter / system sans and
JetBrains Mono / system mono). Numerals are tabular everywhere via
`font-feature-settings: "tnum"` on `body`.

## Scale (utilities generated in styles.css)

| Utility          | Size / line                              | Weight                         | Use                                           |
| ---------------- | ---------------------------------------- | ------------------------------ | --------------------------------------------- |
| `type-display`   | 28 / 34                                  | 600                            | hero figures on metric cards, brand statement |
| `type-h1`        | 20 / 28                                  | 600                            | page title (`PageHeader`)                     |
| `type-h2`        | 16 / 24                                  | 600                            | dialog titles, health headline                |
| `type-h3`        | 14 / 20                                  | 600                            | card titles, state titles                     |
| `type-h4`        | 13 / 20                                  | 600                            | sub-sections                                  |
| `type-body`      | 14 / 22                                  | 400                            | default text                                  |
| `type-body-sm`   | 13 / 20                                  | 400                            | dense tables, secondary copy                  |
| `type-caption`   | 12 / 16                                  | 400, muted                     | hints, timestamps                             |
| `type-label`     | 11 / 16                                  | 600, uppercase, tracked, muted | table headers, section labels, eyebrow        |
| `type-mono`      | 13 mono, tabular                         | 400                            | account codes, document numbers, IDs          |
| `type-financial` | inherits size; tabular + lining numerals |                                | currency and metrics                          |

Keep sizes small: enterprise screens favour readability and density over
large type. Do not introduce new sizes in modules; compose these.

## Numbers

- Currency in tables: `Amount` / `CurrencyDisplay variant="table"` →
  `1,250,000.00`, negatives as `(32,500.00)`, right-aligned.
- Currency on dashboards: `CurrencyDisplay variant="metric"` → `₱1,250,000.00`,
  `-₱32,500.00` (sign + tone; the symbol is slightly smaller and muted).
- Percentages: `PercentageDisplay` → `18.42%`, `+12.4%` when `signed`.
- Change: `DeltaIndicator` → `↑ +12.4% vs last month` with an sr-only
  "Up"/"Down" and a `direction` prop so an expense increase is not green.
- Codes: `AccountCode`, `DocumentNumber` (monospace).

Example:

```
Net income
₱2,450,000.00
↑ +12.4% vs last month
```
