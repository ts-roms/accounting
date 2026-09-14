# Idempotency

Three layers keep retries from creating `Invoice A` and `Invoice B`:

## 1. `Idempotency-Key` header (API)

`idempotency/idempotency.interceptor.ts` runs on every `POST`, `PUT`, `PATCH`
and `DELETE` of an authenticated principal that sends `Idempotency-Key`
(8-128 chars of `[A-Za-z0-9_-:.]`).

```
claim (organization_id, key) via INSERT ... ON CONFLICT DO NOTHING
  inserted            -> run the handler, store status + body   (COMPLETED)
  exists, same hash   -> COMPLETED: replay stored response, header Idempotent-Replayed: true
                         IN_PROGRESS: 409 IDEMPOTENCY_IN_PROGRESS
  exists, other hash  -> 422 IDEMPOTENCY_CONFLICT
```

- The request hash covers method, path and a canonical (key-sorted) body.
- Client errors (4xx) are stored and replayed too; server errors (5xx) release
  the key so the client can retry.
- Keys live 24 h (`idempotency_keys.expires_at`); the cleanup job purges them.
- The unique index arbitrates concurrent duplicates: two identical requests in
  flight cannot both execute the handler.

## 2. Document-level idempotency keys

Invoices, customer payments and bank statements accept `idempotencyKey` in
their bodies; the domain re-reads the existing document instead of creating a
second one. Importers always set it (`int:<integration>:<entity>:<externalId>`).

## 3. Posting idempotency

`AccountingPostingService` refuses to post a second journal for the same
`(company, source_type, source_id)` and treats re-posting a posted entry as a
no-op - unchanged from Phase 2.

## Events

- Outbox rows carry a `dedupe_key` (`journal.posted:<entryId>`); a second
  enqueue is a no-op.
- Inbound webhooks are unique per `(integration, external event id)`;
  replays are acknowledged and ignored.
- Deliveries are unique per `(webhook, event)`; manual replays create a new
  row that references the original (`replayOfId`).
