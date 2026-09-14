# Webhooks

## Outbound (we notify others)

```
Business transaction  --same tx-->  integration_events (OUTBOUND, PENDING)   [transactional outbox]
                                          |
                     dispatch-outbox job (on commit nudge + every 30 s)
                                          |
                     integration_webhook_deliveries (one per matching subscription)
                                          |
                     deliver job: POST signed JSON -> DELIVERED | RETRYING (backoff) | EXHAUSTED
```

Subscriptions (`POST /api/v1/webhooks`) carry a name, URL, event list,
optional company, optional linked integration and `maxAttempts`. The signing
secret is generated (or supplied) and shown once; `POST /webhooks/:id/rotate-secret`
rotates it.

Delivery payload:

```json
{
  "id": "<event id>",
  "type": "invoice.posted",
  "occurredAt": "2026-03-09T12:00:00.000Z",
  "companyId": "...",
  "data": { "invoiceId": "...", "documentNumber": "INV-2026-000012", "total": "2400.0000", ... },
  "delivery": { "id": "<delivery id>", "attempt": 1 }
}
```

Headers: `X-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "t.body")>`,
`X-Webhook-Event-Id`, `X-Webhook-Event`, `X-Webhook-Delivery-Id`. Receivers
must verify the signature over the exact body and reject timestamps older than
their tolerance (5 minutes is the platform default for inbound).

Published events: `customer.created/updated`, `invoice.created/approved/posted/cancelled`,
`payment.created/completed/failed`, `journal.posted/reversed`, `period.closed`,
`webhook.test`; the remaining names in `OUTBOUND_EVENT_TYPES` are reserved for
the modules that will emit them.

Reliability:

| Concern         | Mechanism                                                                   |
| --------------- | --------------------------------------------------------------------------- |
| Lost events     | Outbox row written in the business transaction; dispatcher sweeps PENDING   |
| Duplicates      | `dedupe_key` per event, unique `(webhook, event)` delivery                  |
| Retries         | `retry-policy.ts`: exponential backoff with full jitter, `Retry-After` honoured |
| Timeout         | `WEBHOOK_TIMEOUT_MS` (default 10 s)                                          |
| Exhaustion      | `EXHAUSTED` after `maxAttempts`, `WEBHOOK_FAILING` notification              |
| Replay          | `POST /webhooks/:id/replay` (all failed, or selected delivery ids)           |
| Test            | `POST /webhooks/:id/test` sends `webhook.test` and returns the delivery      |
| History         | `GET /webhooks/deliveries` with payload, status, attempts, HTTP status, error |

## Inbound (others notify us)

`POST /api/v1/webhooks/inbound/:integrationId` with the provider's body and
signature headers:

1. The connector verifies the signature over the raw body and normalises the
   event (`eventId`, `eventType`, `payload`).
2. The event is stored in `integration_events` (INBOUND). A duplicate
   `(integration, external event id)` is acknowledged as `duplicate: true`.
3. `202 Accepted` is returned immediately; the `process-inbound` job calls
   `connector.handleWebhook`, which returns records to import. Each record goes
   through mapping and the entity importer - the same path as a sync - so a
   `payment.received` becomes a customer receipt through
   `CustomerPaymentsService` and posts through `AccountingPostingService` only
   when the integration holds `payments:post`.
4. Failures are recorded on the event (`FAILED`, `lastError`), retried for
   transient causes, and replayable through
   `POST /webhooks/inbound-events/:eventId/replay`.

Rejections: invalid or stale signature `401 WEBHOOK_SIGNATURE_INVALID`,
unknown integration `404`, disabled integration `410`.
