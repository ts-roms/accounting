# Plaid connector (bank feeds)

Provider key `PLAID` (`apps/api/src/modules/integrations/connectors/plaid/`).
The bank-side real connector: it talks to the Plaid REST API
(`sandbox.plaid.com` / `production.plaid.com`) and receives Plaid-signed
webhooks. Transactions become **bank statements** through
`StatementsService.import` - evidence for reconciliation in the banking
module, never ledger entries. The GL bank balance stays the truth; a feed
only tells you what the bank says happened.

## Setup

1. In the Plaid dashboard note the **client id** and the **secret** of the
   environment you use (sandbox for testing, production for real banks).
2. Link the bank once with **Plaid Link** (the dashboard's Link demo or your
   own Link page) and copy the `public-…` token it returns. In sandbox,
   `POST /sandbox/public_token/create` produces one without a browser.
3. Administration → Integrations → Available → **Plaid** → Connect:
   - credentials: `username` = client id, `password` = secret,
     `bearerToken` = the `public-…` token (or an existing `access-…` token)
   - `bankAccountId`: the internal bank account this feed belongs to
   - `environment`: `SANDBOX` (default) or `PRODUCTION`
   - `plaidAccountId`: which account of the item to feed; optional when the
     item exposes exactly one depository account
   - `openingBalance`: the bank balance at the feed's start - the first
     statement opens with it and every later one continues from there
   - `includePending`: import uncleared transactions too (default off)
   - scopes: `banking:read`, `banking:write` (`bank-statement.import`)

   Connect exchanges the public token for the item's access token
   (`/item/public_token/exchange`) and stores it encrypted; the public token
   itself is never kept. `Test connection` calls `/accounts/get` and reports
   the selected account, currency and current balance.

4. Webhooks: in the Plaid dashboard set the item's webhook URL to
   `https://<your api>/api/v1/webhooks/inbound/<integration id>`. No shared
   secret is needed - Plaid signs every delivery with an ES256 JWT in the
   `Plaid-Verification` header (see below).
5. Optional: a cron `syncSchedule` on the integration pulls on a timer even
   without webhooks.

## What is synchronised

| Entity              | Plaid endpoint       | Notes                                                                                                 |
| ------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| `bank-transactions` | `/transactions/sync` | One statement per posting date and page; lines carry the `transaction_id` (or `CHK <n>`) as reference |

- **Amounts**: Plaid sends floats with the bank's sign convention (positive =
  money out). They are converted to exact 2-decimal strings and the sign is
  flipped so a statement line reads like the API (positive = money in).
- **Statements**: within a page, posted transactions of the selected account
  are grouped by `date`; each group becomes a statement whose opening balance
  is the running balance carried in the cursor and whose closing balance is
  opening + lines - so `StatementsService`' balance check always holds and the
  statements chain across pages and runs. A date that straddles two pages
  yields two statements for that day; both reconcile normally.
- **Statement ids** are deterministic (`<account>:<date>:<sha256 of the
transaction ids>`), so replaying a page after a crash re-imports nothing.
- **Cursor**: `{ cursor: <Plaid sync cursor>, balance: <running balance> }`.
  `INCREMENTAL` continues from it; `FULL` starts over from `openingBalance`
  (Plaid re-sends history, the deterministic ids skip what already exists).
- **Pending** transactions are skipped unless `includePending` is on: a
  statement is evidence of what cleared, and Plaid re-delivers the posted
  version with a new id. `modified` / `removed` entries are logged on the
  integration log and not applied - imported statement lines are kept as
  delivered; reconciliation is where a wrong line gets excluded.

## Errors

Plaid answers HTTP 400 for almost everything and puts the truth in
`error_type` / `error_code`. The connector reclassifies them so the retry
policy and the operator see the right thing:

| Plaid                                                                | Platform code          | Effect                                                                   |
| -------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------ |
| `ITEM_LOGIN_REQUIRED`, `INVALID_ACCESS_TOKEN`, `INVALID_API_KEYS`, … | `AUTHENTICATION_ERROR` | Integration goes `ERROR`, no retry - re-link the bank (new public token) |
| `RATE_LIMIT_EXCEEDED`                                                | `RATE_LIMITED`         | Retried with backoff                                                     |
| `API_ERROR`, `INSTITUTION_ERROR`, HTTP 5xx                           | `PROVIDER_ERROR`       | Retried with backoff                                                     |
| other `ITEM_ERROR`                                                   | `AUTHORIZATION_ERROR`  | Not retried; shown on the job                                            |
| `INVALID_INPUT` / `INVALID_REQUEST`                                  | `VALIDATION_ERROR`     | Not retried; shown on the job                                            |

## Webhooks

Plaid signs each delivery with a JWT (`alg: ES256`, header `kid`) whose
payload carries `iat` and `request_body_sha256`. The connector:

1. parses the JWT and fetches the public key for its `kid` through
   `/webhook_verification_key/get` (throttled, logged like any call; an
   unknown key or a lookup failure rejects the delivery),
2. rejects tokens older than five minutes, bodies whose SHA-256 differs from
   the claim, expired keys and any algorithm other than ES256,
3. verifies the ES256 signature (JOSE raw `r||s`),
4. maps `webhook_type.webhook_code` to an event; `TRANSACTIONS` /
   `SYNC_UPDATES_AVAILABLE` (also `INITIAL_UPDATE`, `HISTORICAL_UPDATE`,
   `DEFAULT_UPDATE`) triggers an incremental sync, `ITEM.ERROR` is recorded
   with the Plaid error code, everything else is acknowledged and ignored.

Deliveries are deduplicated by `type:code:item:body hash`, so Plaid's retries
of the same payload are acknowledged without a second sync.

## Security notes

- Client id and secret are sent as `PLAID-CLIENT-ID` / `PLAID-SECRET`
  headers (never in request bodies), and only the throttled `ctx.http`
  client is used, so the integration log records calls without secrets.
- The access token is a `BEARER` credential in `integration_credentials`
  (AES-256-GCM); rotating it is a normal credential rotation.
- Nothing in the connector can post: statements go through the same import
  path as a manually uploaded file, and reconciliation approval remains
  four-eyes in the banking module.

## Testing

- `plaid.logic.spec.ts` covers amount conversion, statement building,
  cursors, account selection, error classification and JWT verification with
  a generated P-256 key.
- `test/plaid.e2e-spec.ts` runs the connector against an in-memory Plaid
  (`IntegrationsService.fetchImpl`): public-token exchange and encrypted
  storage, paginated `/transactions/sync` into chained statements with no
  journal side effects, incremental no-op, signed / tampered / stale /
  unknown-key webhooks, webhook-triggered sync, replay dedupe and
  `ITEM_LOGIN_REQUIRED` handling.
