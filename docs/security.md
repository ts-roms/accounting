# Security

## Authentication

- **Passwords**: Argon2id (19 MiB, t=2, p=1). Hashes are rehashed on login when
  parameters change. Never logged, never returned by any API.
- **Access token**: HS256 JWT, 15 minutes, `iss=accounting-api`,
  `aud=accounting-web`, claims `sub` (user), `sid` (session), `org`.
- **Refresh token**: 48 random bytes (base64url), 7 days. Only the SHA-256 hash
  is stored (`sessions.refresh_token_hash`). Every refresh **rotates** the token
  and links `replaced_by_session_id`; presenting a rotated token is treated as
  theft and revokes every session of the user (audited as `LOGOUT` with
  `reason=REFRESH_TOKEN_REUSE`).
- **Cookies**: `acct_access` and `acct_refresh` are `httpOnly`, `SameSite=Lax`,
  `Secure` in production (`COOKIE_SECURE`), path `/`. A `Bearer` header is also
  accepted for non-browser clients.
- **Session validity** is checked on every request (`sessions.revoked_at IS NULL`)
  so logout and password changes take effect immediately, not at token expiry.
- **Lockout**: 5 consecutive failures lock the account for 15 minutes
  (`users.locked_until`). Unknown emails still run an Argon2 verification to
  keep timing uniform. Administrators can unlock via `PATCH /users/:id/status`.
- **Rate limiting**: global 120 req/min per IP; `/auth/login` 10/min;
  `/auth/refresh` 30/min.

## Authorization

- RBAC with fine-grained permission keys (`journal.post`, `period.close`, ...).
  See `permissions.md`.
- Enforced exclusively by NestJS guards (`PermissionsGuard` via
  `@RequirePermissions()`); the frontend mirrors permissions for UX only.
- Company scoping: `X-Company-Id` must reference a company the user can access
  (organization-wide role, or a role scoped to that company).
- Segregation of duties is a configurable policy (`sod_policies`), evaluated on
  every role assignment (`BLOCK` rejects, `WARN` audits).
- Invariant: an organization always keeps at least one active `SUPER_ADMIN`.

## Web hardening

- CSRF: cookie-authenticated state-changing requests must carry
  `X-Requested-With: XMLHttpRequest` (cross-site forms cannot set custom headers)
  on top of `SameSite=Lax`.
- `helmet` security headers on the API; Next.js sends `X-Frame-Options: DENY`,
  `nosniff`, referrer and permissions policies.
- The browser never calls the API origin directly; Next.js proxies `/api/*`
  server-side (`API_INTERNAL_URL` is server-only).
- Zod validation on every body/query; unknown database errors are never
  forwarded to clients.
- SQL is parameterised by Drizzle; the only raw fragments are constant SQL
  (`CHECK` expressions, `ILIKE` with bound parameters).

## Audit trail

Every significant action writes an `audit_logs` row inside the same transaction
as the change (user, action, module, entity, before/after diff with sensitive
keys redacted, IP, user agent, correlation id). The table is append-only at the
database level (trigger), see `database.md`.

## Secrets & configuration

- All secrets come from environment variables validated at boot
  (`apps/api/src/config/env.schema.ts`). The API refuses to start with a
  `JWT_ACCESS_SECRET` shorter than 32 characters.
- `.env` is git-ignored; `.env.example` documents every variable.
- Logs redact `authorization`, `cookie`, `set-cookie` and password fields.

## Not yet implemented (tracked)

- Password reset / email verification flows (needs the notification module).
- MFA.
- IP allow-lists and session device management UI.
