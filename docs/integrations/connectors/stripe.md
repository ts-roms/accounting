# Stripe connector

Provider key `STRIPE` (`apps/api/src/modules/integrations/connectors/stripe/`).
The first non-demo connector: it talks to the public Stripe REST API and
receives Stripe-signed webhooks. Money it imports becomes customer receipts
through `CustomerPaymentsService`; nothing posts unless the integration holds
`payments:post` and `config.autoPost` is on.

## Setup

1. In the Stripe dashboard create a **restricted key** with read access to
   Customers, Charges, PaymentIntents and Checkout Sessions (or use the
   account secret key). Test keys (`sk_test_` / `rk_test_`) and live keys are
   both supported; the key decides the mode.
2. Administration → Integrations → Available → **Stripe** → Connect:
   - `apiKey`: the Stripe key (stored encrypted, shown never)
   - `cashAccountId`: the GL account Stripe settles into (e.g. a "Stripe
     clearing" bank/cash account)
   - `autoPost`: post receipts automatically (needs the `payments:post` scope)
   - `guestCustomerCode`: optional customer used for charges without a Stripe
     customer (guest checkouts)
   - `apiVersion` (default `2024-06-20`), `apiBaseUrl` (proxies / sandboxes)
   - scopes: `customers:write`, `payments:write` (+ `payments:post`)
3. Test connection: calls `GET /v1/account` and reports the account and mode.
4. Webhooks: in Stripe add an endpoint
   `https://<your api>/api/v1/webhooks/inbound/<integration id>` for
   `charge.succeeded`, `payment_intent.succeeded`,
   `checkout.session.completed`, `customer.created`, `customer.updated`, then
   store the endpoint's signing secret (`whsec_…`) as the integration's
   `webhookSecret` (Authentication tab → rotate credential).

## What is synchronised

| Entity      | Stripe resource     | Notes                                                                                     |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `customers` | `GET /v1/customers` | Code `STRIPE-<id>`; display name falls back to e-mail, then id; address / currency mapped |
| `payments`  | `GET /v1/charges`   | Only `succeeded`, paid, unrefunded charges; partial refunds are excluded entirely         |

Amounts are converted from Stripe's integer minor units to exact decimal
strings per currency (zero-decimal currencies such as JPY, three-decimal such
as KWD are handled). Receipts allocate to an open posted invoice when the
charge carries `metadata.invoice_reference` equal to the invoice reference;
otherwise they stay on account.

Pagination and incremental sync: Stripe lists are newest-first and page with
`starting_after`; the connector's cursor is JSON
`{ createdGt, startingAfter, maxCreated }`. Within a run the `created[gt]`
bound is fixed while pages advance (resumable at any page); when the run
completes the next incremental run starts after the newest `created` seen.

## Webhooks

`Stripe-Signature: t=<unix>,v1=<hmac>` over `t.<raw body>` is verified with the
platform's timestamped scheme (5-minute tolerance). Events whose `livemode`
does not match the key's mode are rejected (`LIVEMODE_MISMATCH`). Event ids
(`evt_…`) are unique per integration, so Stripe's retries and replays are
acknowledged without a second receipt.

| Event                        | Effect                                                                                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `charge.succeeded`           | Receipt for the charge (external id = charge id)                                                           |
| `payment_intent.succeeded`   | Receipt keyed by `latest_charge`, so it dedupes against `charge.succeeded`                                 |
| `checkout.session.completed` | Receipt only when the session has no payment intent; otherwise ignored (the intent's own event settles it) |
| `customer.created / updated` | Customer created or updated                                                                                |
| anything else                | Acknowledged and ignored with a note in the integration log                                                |

## Not imported (by design)

- Refunds, disputes and chargebacks: the domain's refund is a separate
  business document that needs unapplied credit; raise them manually.
- Payouts / balance transactions: reconcile the Stripe clearing account against
  the bank statement with the banking module.
- Stripe Connect (OAuth) and Stripe Billing invoices.

## Tests

`stripe.logic.spec.ts` (amount conversion, cursors, normalisation, event
envelopes) and `test/stripe.e2e-spec.ts`, which runs the whole path against an
in-memory Stripe API stub (`IntegrationsService.fetchImpl`): connect, paginated
full and incremental sync, guest charge, refund exclusion, signed webhooks,
forged / live-mode / replayed rejections and the resulting GL lines.
