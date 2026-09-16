# Writing a connector

A connector adapts one provider to the platform. It never touches the domain or
the database: it returns external records, verifies webhooks and speaks the
provider's authentication. The platform maps and imports.

```
Create connector class  ->  extend BaseConnector, fill `descriptor`
Register provider       ->  add the class to connectors/index.ts (CONNECTOR_CLASSES)
Define authentication   ->  descriptor.authType + credentialFields (or descriptor.oauth)
Define capabilities     ->  PULL / PUSH / WEBHOOKS / INCREMENTAL_SYNC / TEST_CONNECTION / REFRESH_CREDENTIALS
Define mapping          ->  descriptor.defaultMappings per entity (users can override per integration)
Implement pull / push   ->  cursor-based pages of ExternalRecord
Implement webhooks      ->  verifyWebhook (signature over raw body) + handleWebhook (what to import)
Add tests               ->  unit-test any pure logic; add an e2e slice if the entity is new
Register connector      ->  nothing else: the registry discovers it at module init
```

## Skeleton

```ts
@Injectable()
export class AcmeBankConnector extends BaseConnector {
  readonly descriptor: ConnectorDescriptor = {
    provider: 'ACME_BANK',
    category: 'BANKING',
    name: 'Acme Bank',
    description: 'Bank feed for Acme Bank business accounts.',
    authType: 'API_KEY',
    capabilities: ['PULL', 'INCREMENTAL_SYNC', 'TEST_CONNECTION'],
    entities: ['bank-transactions'],
    configSchema: z.object({ bankAccountId: z.string().uuid(), accountNumber: z.string() }),
    credentialFields: [{ key: 'apiKey', label: 'API key', required: true }],
    defaultMappings: { 'bank-transactions': [/* MappingFieldRule[] */] },
    rateLimitPerSecond: 5,
  };

  override async connect(ctx: ConnectorContext): Promise<ConnectResult> {
    const res = await ctx.http('https://api.acmebank.example/v1/me', {
      headers: { authorization: `Bearer ${ctx.secrets.apiKey}` },
    });
    return { ok: true, externalAccountId: (await res.json()).accountId };
  }

  override async pull(ctx: ConnectorContext, req: PullRequest): Promise<PullResult> {
    const res = await ctx.http(
      `https://api.acmebank.example/v1/statements?cursor=${req.cursor ?? ''}`,
    );
    const page = await res.json();
    return {
      records: page.items.map(toRecord),
      nextCursor: page.next ?? null,
      hasMore: Boolean(page.next),
    };
  }
}
```

## Rules

- **Use `ctx.http`**, never `fetch` directly: it applies the provider rate
  limit, a timeout, error classification (`IntegrationError`) and writes a
  redacted log line per call.
- **Never log `ctx.secrets`.** `ctx.logger` is fine for ids and counts.
- **Return raw provider data** in `ExternalRecord.data`; mapping decides the
  shape. Put the provider's stable id in `externalId`.
- **Cursors are opaque strings** the platform stores per entity. Make them
  resumable: replaying the last page must be safe (importers deduplicate by
  external reference).
- **Throw `IntegrationError`** with the right code; the retry policy depends
  on it (`retries/retry-policy.ts`).
- **Webhooks**: implement `verifyWebhook` over `rawBody` (the exact bytes) and
  return a normalised `InboundWebhookEvent` with a stable `eventId`. Reuse
  `webhooks/webhook-signature.ts` for timestamped HMAC schemes.
- **OAuth**: set `descriptor.oauth` (authorize / token / revoke URLs, scopes,
  PKCE). The platform runs the flow; override `exchangeAuthorizationCode` /
  `refreshAccessToken` only when the provider is non-standard.
- **Push**: declare `PUSH`, implement `push(ctx, { entity, records })` and
  answer one result per record (`ok`, the provider's `externalId`, optional
  `metadata` such as a receipt). Records carry the `externalId` of an earlier
  push so the provider can update rather than duplicate. Reject bad records
  per result (`ok: false, error`) - throw only for transport / auth failures.
  Describe the payload with `defaultOutboundMappings` (domain view -> provider
  shape); see `DEMO_TAX_AUTHORITY`.
- **New entity?** Add an importer in `sync/importers/` that validates with the
  same Zod schema as the REST API and calls the existing domain service, then
  register it in `SyncService` and `InboundWebhooksService`; for pushes add an
  exporter in `sync/exporters/` that reads the domain view. Do not add tables
  or posting code.

## Real connectors

- **Stripe** (`connectors/stripe/`, see `connectors/stripe.md`): API-key auth,
  paginated pulls of customers and settled charges, Stripe-signed webhooks. Use
  it as the template for other REST providers: a pure `*.logic.ts` for amounts,
  cursors and normalisation, a thin connector class, and an in-memory API stub
  in the e2e test (`IntegrationsService.fetchImpl`).

## Demo connectors

`DEMO_BANK`, `DEMO_PAYMENT_GATEWAY`, `DEMO_ECOMMERCE`, `DEMO_PROCUREMENT`,
`DEMO_TAX_AUTHORITY` and `DEMO_OAUTH_CRM` read their "provider data" from
`config.fixture` and accept
demo-shaped credentials (`demo-bank-...`). They are flagged `demo: true` and
exist to exercise the whole pipeline in tests and demos. No real provider API
is assumed or invented.

## Categories the framework is designed for

Banking (feeds, statements), payment providers (Stripe / PayPal-like),
e-commerce (Shopify / WooCommerce / Lazada / Shopee-like), tax and government
(e-invoicing, e-receipts - only once an official API is documented), payroll,
CRM (Salesforce / HubSpot via OAuth), storage (S3-compatible, Google Drive,
OneDrive), communication (SMTP, SMS, messaging) and identity (OAuth 2.0 /
OIDC, Google, Microsoft Entra ID) and analytics (Power BI, warehouses). The
`IntegrationCategory` enum and `authType` list cover them; only the demo
representatives and Stripe are implemented.
