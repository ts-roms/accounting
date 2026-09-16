# API keys and scopes

`POST /api/v1/api-keys` mints a key of the form `ak_<8-char prefix><random>`.
The plaintext is returned **once**; only its SHA-256 is stored (`api_keys.key_hash`).

| Field                | Meaning                                                                   |
| -------------------- | ------------------------------------------------------------------------- |
| `scopes`             | Granular API scopes (below). At least one.                                |
| `companyIds`         | Companies the key may act in; empty = every company the owner can access. |
| `expiresAt`          | Optional expiry; expired keys answer `401 API_KEY_EXPIRED`.               |
| `rateLimitPerMinute` | Fixed-window quota per key (`429 RATE_LIMITED`, `X-RateLimit-Remaining`). |

Lifecycle: `ACTIVE -> REVOKED` (`DELETE /api-keys/:id`), `ACTIVE -> EXPIRED`
(time), rotation `POST /api-keys/:id/rotate` issues a new secret and revokes
the old one immediately or after `graceMinutes`. Every step is audited
(`CREATE`, `ROTATE`, `REVOKE`).

Using a key:

```
Authorization: Bearer ak_d39BTbeLU7ZXH6kTBEXKbKgZhhaTkhAt0H1Gd
X-Company-Id: <company uuid>
Idempotency-Key: order-5001-invoice        (optional, recommended for writes)
```

## Authority model

A key acts as its **owner**, narrowed to its scopes:

```
effective permissions = permissions(scopes) ∩ owner's permissions in the selected company
```

- The creator can only grant scopes whose permissions they hold
  (`422 SCOPE_NOT_GRANTABLE` otherwise).
- If the owner later loses a permission (or is deactivated), the key loses it too.
- No scope maps to approval or posting authority unless it is an explicit
  `:post` scope (`invoices:post`, `bills:post`, `payments:post`). `journals:create` only
  drafts. Keys never receive delegated authority and never hold roles.

## Scopes

| Scope                  | Permissions granted                                                  |
| ---------------------- | -------------------------------------------------------------------- |
| `companies:read`       | company.view, branch.view                                            |
| `customers:read/write` | customer.view (+ customer.manage)                                    |
| `vendors:read/write`   | vendor.view (+ vendor.manage)                                        |
| `invoices:read/write`  | invoice.view, customer.view (+ invoice.create)                       |
| `invoices:post`        | invoice.view, invoice.approve, invoice.post                          |
| `bills:read/write`     | bill.view, vendor.view (+ bill.create)                               |
| `bills:post`           | bill.view, bill.approve, bill.post                                   |
| `payments:read/write`  | invoice.view, bill.view / customer-payment.create                    |
| `payments:post`        | invoice.view, customer-payment.post                                  |
| `products:read/write`  | product.view (+ product.manage)                                      |
| `inventory:read/write` | inventory.view (+ inventory.adjust)                                  |
| `journals:read`        | journal.view, account.view                                           |
| `journals:create`      | journal.view, account.view, journal.create (DRAFT only)              |
| `reports:read`         | reports.view, account.view                                           |
| `banking:read/write`   | bank-account.view (+ bank-statement.import, bank-transaction.create) |
| `webhooks:manage`      | webhook.manage                                                       |
| `integrations:manage`  | integration.view, integration.manage                                 |

The catalogue with the exact permission lists is served by
`GET /api/v1/api-keys/scopes` (source: `packages/types/src/integrations.ts`).
Integrations themselves carry the same scopes (`integration_scopes`); a sync or
webhook job acts as the integration's creator narrowed to those scopes.
