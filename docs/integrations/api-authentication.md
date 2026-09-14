# API authentication

The REST API (`/api/v1/...`) accepts three credentials, resolved by
`JwtAuthGuard`:

| Credential      | Who                     | How                                                        |
| --------------- | ----------------------- | ---------------------------------------------------------- |
| Session cookies | Browser users           | `acct_access` / `acct_refresh` httpOnly cookies + CSRF header |
| Bearer JWT      | Non-browser first-party | `Authorization: Bearer <access token>`                     |
| Bearer API key  | External systems        | `Authorization: Bearer ak_...` (see `api-keys.md`)         |

Common to all:

- `X-Company-Id` selects the company; it must be one the principal can access
  (API keys may additionally be restricted to a company list).
- `X-Correlation-Id` is echoed back and stored on audit and integration logs.
- `Idempotency-Key` on mutating requests (see `idempotency.md`).
- Errors use the standard envelope `{ code, message, details, correlationId }`.
- Standards: URI versioning (`/api/v1`), `page` / `pageSize` / `search` /
  `sortBy` / `sortDir` pagination, Zod-validated bodies and queries, OpenAPI at
  `/api/docs` outside production.

Authorization is enforced only by NestJS guards (`@RequirePermissions`). API
keys receive *permissions derived from scopes*, intersected with the owner's
permissions, so the same guards apply unchanged. Delegated authority attaches
`delegations` to the principal; the permission guard accepts a delegated
permission and services then call `AuthorityService.assert` for scope, amount
and segregation-of-duties checks (see `delegations.md`).

## Provider-side authentication (outbound)

Connectors declare `authType`: `API_KEY`, `BASIC`, `BEARER`, `HMAC`, `OAUTH2`,
`OIDC` or `NONE`. Credentials are supplied once through `credentials` on
`POST /integrations` or `PATCH /integrations/:id`, encrypted (AES-256-GCM, key
from `INTEGRATION_ENCRYPTION_KEY`) and decrypted only into the connector
context for the duration of one call. No endpoint returns them; list / detail
responses expose only the credential kinds and expiry dates. Rotation is a
`PATCH` with the new value (audited as `IntegrationCredential` update).

## Webhook authentication (inbound)

`POST /api/v1/webhooks/inbound/:integrationId` is public at the transport level;
the connector's `verifyWebhook` authenticates the request with the
integration's webhook secret over the raw body. Timestamped signatures are
rejected outside a 5-minute window; event ids are unique per integration so a
replayed request is acknowledged (`202`, `duplicate: true`) but never processed
twice. The receiver is throttled separately (600 requests / minute / IP).
