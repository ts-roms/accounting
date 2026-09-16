# Troubleshooting

Start from **Administration -> Integration Logs** (or
`GET /api/v1/integration-logs`): every operation carries `operation`,
`status`, `errorCode`, `httpStatus`, `durationMs`, `correlationId` and
redacted metadata. The same correlation id appears in the API's structured log
lines and in `audit_logs`.

| Symptom                                                        | Where to look / what it means                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Integration shows `ERROR`, `lastError: AUTHENTICATION_ERROR`   | Credentials rejected by the provider. Rotate them under the Authentication tab, then Connect.                                                                                                                      |
| `INTEGRATION_CONFIG_INVALID` on create                         | `config` failed the connector's schema; `details.issues` lists the fields.                                                                                                                                         |
| Sync job `FAILED` with `AUTHENTICATION_ERROR`                  | Retried once after a credential refresh, then left for a person. Reconnect / re-authorise.                                                                                                                         |
| Sync job `FAILED` with `RATE_LIMITED` / `TIMEOUT`              | Retried automatically (max 3, backoff, `Retry-After` honoured); check the provider status.                                                                                                                         |
| Sync `COMPLETED` but `recordsFailed > 0`                       | Open the job: `failures[]` lists external id, code and message per record (e.g. `MAPPING_ERROR`, customer not imported yet). Fix the mapping / order of entities and re-run; already-imported records are skipped. |
| `AUTHORIZATION_ERROR` per record                               | The integration lacks a scope (e.g. `invoices:post` with `autoPost`). Grant the scope on the integration.                                                                                                          |
| Sync refused: `SYNC_IN_PROGRESS`                               | One job per integration at a time; cancel the running one (it pauses at the next checkpoint) or wait.                                                                                                              |
| Inbound webhook `401 WEBHOOK_SIGNATURE_INVALID`                | Wrong webhook secret, tampered body, or timestamp older than 5 minutes (`details.reason`).                                                                                                                         |
| Inbound event stuck `FAILED`                                   | Fix the cause (mapping, missing customer), then `POST /webhooks/inbound-events/:id/replay`.                                                                                                                        |
| Outbound delivery `RETRYING`                                   | Receiver returned non-2xx or timed out; `nextAttemptAt` shows the next try.                                                                                                                                        |
| Outbound delivery `EXHAUSTED`                                  | All attempts failed; a `WEBHOOK_FAILING` notification was sent. Fix the receiver, then Replay.                                                                                                                     |
| Receiver cannot verify the signature                           | Sign `"<t>.<raw body>"` with HMAC-SHA256 of the secret; compare hex constant-time; body must be the exact bytes.                                                                                                   |
| OAuth callback lands on `?oauth=error`                         | `reason` in the URL; the integration log has `oauth.callback FAILURE`. Usually an expired state (10 min) or `invalid_grant`.                                                                                       |
| `OAUTH_STATE_INVALID`                                          | State unknown, expired or already used - restart with `oauth/start`.                                                                                                                                               |
| `IDEMPOTENCY_CONFLICT` (422)                                   | The same `Idempotency-Key` was used with a different body. Use a new key per distinct request.                                                                                                                     |
| `IDEMPOTENCY_IN_PROGRESS` (409)                                | The first request with that key is still running; retry after it finishes.                                                                                                                                         |
| API key `401 API_KEY_EXPIRED / API_KEY_REVOKED`                | Rotate or mint a new key; the old one stays in the audit trail.                                                                                                                                                    |
| API key `403 PERMISSION_DENIED` for something the owner can do | The key lacks the scope, or the scope's permission is not held by the owner in that company.                                                                                                                       |
| API key `403 COMPANY_NOT_ACCESSIBLE`                           | `X-Company-Id` is not in the key's company list (or not accessible to the owner).                                                                                                                                  |
| `429 RATE_LIMITED`                                             | Per-key quota (`rateLimitPerMinute`); `X-RateLimit-Remaining` shows the remaining budget.                                                                                                                          |
| Health `DEGRADED` / `UNHEALTHY`                                | The Health tab lists each deduction with its cause (failures, credential expiry, webhooks, latency, throttling, overdue schedule).                                                                                 |
| Delegate gets `DELEGATION_LIMIT_EXCEEDED`                      | Document amount above the delegated ceiling (or another currency). Ask the delegator to approve.                                                                                                                   |
| Delegate gets `DELEGATION_SCOPE_EXCEEDED`                      | Wrong branch or company for the delegation.                                                                                                                                                                        |
| Delegate gets `SOD_VIOLATION`                                  | They created the document themselves (or are the delegator).                                                                                                                                                       |
| Delegate gets `DELEGATION_NOT_PERMITTED`                       | The delegator no longer holds the permission; the delegation cannot lend it.                                                                                                                                       |
| Delegation approval `DELEGATION_NOT_ELIGIBLE`                  | The approver lacks the policy's permission or already decided.                                                                                                                                                     |
| Jobs never run in development                                  | Redis down: the API logs `Could not start worker`. Start Redis, or set `INTEGRATION_INLINE_JOBS=true` locally.                                                                                                     |

Useful queries:

```sql
select status, count(*) from integration_webhook_deliveries group by 1;
select event_type, status, attempts, last_error from integration_events where direction = 'INBOUND' and status <> 'PROCESSED';
select delegation_number, status, end_at, usage_count from delegations order by created_at desc;
```
