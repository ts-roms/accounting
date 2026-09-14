# OAuth 2.0 / OpenID Connect

`oauth/oauth.service.ts` implements the authorisation-code flow with PKCE for
any connector that declares `descriptor.oauth`.

```
POST /integrations/:id/oauth/start      -> { authorizationUrl, expiresAt }
   state = 32 random bytes (stored as SHA-256, 10 min TTL, single use)
   code_verifier (PKCE S256) stored encrypted
GET  /integrations/oauth/callback?state&code   (public; the provider redirects here)
   state validated and consumed -> code exchanged -> tokens encrypted -> 302 to the web app
POST /integrations/:id/oauth/refresh    -> refresh_token grant, new access token stored
POST /integrations/:id/oauth/disconnect -> revoke (connector or revokeUrl) + wipe tokens
```

- `clientId` lives in the integration `config`; the client secret is stored as
  the `apiKey` credential (encrypted).
- Redirect URI: `${OAUTH_REDIRECT_BASE_URL ?? WEB_BASE_URL}/api/v1/integrations/oauth/callback`.
  Register it with the provider.
- After the callback the browser is sent to `returnTo` only if it is a
  relative path or same-origin with `WEB_BASE_URL` (open-redirect protection);
  `?oauth=success|error` tells the detail page what happened.
- Tokens are never logged, never returned and never written to the audit
  trail; the audit records `CONNECT` with the external account id and expiry.
- The maintenance job `oauth-token-refresh` refreshes tokens expiring within
  15 minutes; a failed refresh raises a `CREDENTIALS_EXPIRING` notification and
  marks the connection `EXPIRED` on a definitive 401.
- `oauth_connections` keeps one row per integration with status
  `PENDING -> CONNECTED -> EXPIRED | REVOKED | FAILED`.
- Providers with non-standard token endpoints (or mocks) override
  `exchangeAuthorizationCode` / `refreshAccessToken` / `revokeTokens` on the
  connector. `DEMO_OAUTH_CRM` does exactly that so the full flow is covered by
  `test/integrations.e2e-spec.ts` without a network.
- OIDC providers (Google, Microsoft identity platform) use the same flow with
  `authType: 'OIDC'`; the `id_token` is parsed by `parseTokenResponse` and can
  be used by a connector to read the account identity.
