# Security

Every external integration is untrusted. External ids, amounts, statuses and
payloads are validated before they touch the domain; nothing an integration
sends is executed or trusted for authorization.

| Concern              | Control                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Tenant isolation     | Every platform table has `organization_id`; all reads / writes filter by the principal's organization              |
| Company isolation    | Integrations bind to a company; API keys can be limited to companies; delegations are per company                  |
| Branch isolation     | Delegation scopes may pin a branch; the document's branch is compared at use                                       |
| RBAC                 | Unchanged NestJS guards; API keys map scopes to permissions capped by the owner                                    |
| API scopes           | No posting authority without an explicit `:post` scope; `journals:create` drafts only                              |
| Delegated authority  | Approval-type permissions only, bounded, scoped, SoD-checked, re-validated and recorded at use                     |
| SoD                  | Existing `sod_policies` evaluated on the delegate's combined permissions; no self-approval                         |
| Audit trail          | Append-only `audit_logs` rows for every sensitive operation (list in `architecture.md`)                            |
| Encryption at rest   | AES-256-GCM (`INTEGRATION_ENCRYPTION_KEY`) for provider credentials, OAuth tokens, webhook secrets, PKCE verifiers |
| Secret exposure      | Never returned by any endpoint, never in logs (`redaction.ts` + pino redact), never in audit rows                  |
| API key storage      | SHA-256 hash only; plaintext shown once                                                                            |
| Rate limiting        | Global per-IP throttle; per-key quota; inbound webhook throttle; per-provider token bucket                         |
| Webhook verification | HMAC-SHA256 over the raw body; timestamped scheme rejects stale requests                                           |
| Replay protection    | Unique provider event id per integration; timestamp tolerance; single-use OAuth state                              |
| Idempotency          | `Idempotency-Key`, document keys, posting source uniqueness, outbox dedupe                                         |
| CSRF                 | Cookie sessions require `X-Requested-With`; Bearer requests carry no ambient credential                            |
| OAuth                | Hashed single-use state with TTL, PKCE S256, same-origin `returnTo`, tokens encrypted                              |
| Request signing      | Outbound deliveries signed; inbound verified by the connector                                                      |
| Correlation ids      | Present on every audit row, integration log row and pino line                                                      |
| Open redirects       | `safeReturnTo` only allows relative or same-origin targets                                                         |
| Untrusted mappings   | Validated with Zod, interpreted by a pure engine - no code execution                                               |

## Accounting invariants preserved

- Integrations reach the ledger only through `InvoicesService.post`,
  `CustomerPaymentsService.post` (and by extension `AccountingPostingService`),
  and only when granted a `:post` scope. Bank feeds create statements, never
  journals.
- No endpoint accepts journal lines from a key or connector; the posting
  service still validates authority, periods, branches and dimensions.
- The transactional outbox is written _by_ the posting service inside its
  transaction; it never influences what is posted.

## Operational notes

- Set `INTEGRATION_ENCRYPTION_KEY` in production (the API refuses to start
  without it). Rotating the key requires re-encrypting `integration_credentials`
  and `integration_webhooks.secret_ciphertext` (`keyVersion` is stored for that).
- The per-key rate limiter and provider throttle are in-process; put them on
  Redis before running several API instances behind one load balancer.
- Keep `INTEGRATION_INLINE_JOBS=false` outside tests so long-running work
  never executes inside an HTTP request.
