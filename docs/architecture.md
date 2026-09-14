# Architecture

## Overview

The platform is a **modular monolith**: one deployable NestJS API and one Next.js
web application, sharing typed packages inside a pnpm/Turborepo workspace.

```
/apps
  /api          NestJS 11 - REST API, business modules, posting engine (Phase 2+)
  /web          Next.js 15 (App Router) - enterprise UI
/packages
  /types        Permission catalog, system roles, SoD defaults, shared enums  (compiled)
  /validation   Zod schemas shared by API DTOs and web forms                  (compiled)
  /config       Cross-app constants: API base path, header and cookie names   (compiled)
  /money        Exact-decimal Money value object + formatting                  (compiled)
  /ui           shadcn-style component library on Tailwind v4 + Radix       (source)
  /eslint-config, /tsconfig
/infrastructure
  /docker       docker-compose (PostgreSQL 16, Redis 7, app profile), Dockerfiles
  /scripts      dev-setup.sh
/docs
```

`types`, `validation` and `config` are **compiled packages** (`tsc` to `dist/`,
CommonJS + `.d.ts`) so that Nest, Jest, `tsx` scripts, Next.js and Docker builds
all consume the same artefacts. `ui` is consumed as source through Next.js
`transpilePackages`.

## Request flow

```
Browser  -->  Next.js (localhost:3000)  --rewrite /api/*-->  NestJS (localhost:3001)
                     |                                              |
              React Query + fetch                          Guards -> Pipes -> Controller
              httpOnly cookies (same-origin)               Service (transaction) -> Drizzle -> PostgreSQL
                                                           AuditService -> audit_logs (append-only)
```

The browser only ever talks to Next.js. `/api/*` is proxied server-side, which
keeps the auth cookies first-party, avoids CORS in the browser, and means no API
URL or secret is embedded in client bundles.

## Backend layering

```
Controller   - HTTP concerns only: routing, DTO validation (nestjs-zod), permission metadata
Service      - business rules; owns the PostgreSQL transaction; writes audit entries
Repository   - (not a separate layer) Drizzle queries live in services, always scoped by organization/company
Schema       - Drizzle table definitions with constraints; migrations generated + reviewed
```

Cross-cutting concerns:

| Concern           | Implementation                                                                        |
| ----------------- | ------------------------------------------------------------------------------------- |
| Request context   | `AsyncLocalStorage` (`RequestContext`) carrying correlation id, user, company, IP, UA |
| Error envelope    | `GlobalExceptionFilter` -> `{ code, message, details, correlationId }`                |
| Validation        | Zod schemas from `@accounting/validation` wrapped with `createZodDto`                 |
| Guards (in order) | `ThrottlerGuard` -> `CsrfGuard` -> `JwtAuthGuard` -> `PermissionsGuard`               |
| Logging           | `nestjs-pino` structured JSON, secrets redacted, health checks not logged             |
| Background work   | BullMQ over Redis (`JobsModule`), e.g. nightly session purge                          |
| Domain events     | `@nestjs/event-emitter` is wired for Phase 2 (`InvoicePosted` etc.)                   |

## Modules (Phase 1)

| Module                 | Responsibility                                                               |
| ---------------------- | ---------------------------------------------------------------------------- |
| `AppConfigModule`      | Validates environment with Zod at boot                                       |
| `DatabaseModule`       | `pg` pool + Drizzle instance (`DRIZZLE` token)                               |
| `AuditModule` (global) | `AuditService.record()` and the audit-trail query API                        |
| `OrganizationsModule`  | Organization, companies (legal entities), branches                           |
| `RbacModule`           | Permission catalog, roles, role assignment, SoD policies, `PermissionsGuard` |
| `UsersModule`          | Users, Argon2 password hashing                                               |
| `AuthModule`           | Login, refresh-token rotation, logout, `JwtAuthGuard`                        |
| `HealthModule`         | `/health` (DB + Redis) and `/health/live`                                    |
| `JobsModule`           | BullMQ queue registry + maintenance jobs                                     |

Planned modules follow the roadmap in `development-roadmap.md`; each will call
`AccountingPostingService` (Phase 2) rather than writing journal lines itself.

## Multi-tenancy model

```
Organization (tenant, reporting currency)
  |- Users, Roles, SoD policies, Audit trail
  |- Company A (legal entity, functional currency, fiscal calendar)   <- every ledger record
  |     |- Branch BXU / DVO / CEB
  |- Company B
```

- Users belong to one organization. Role assignments are either organization-wide
  (`user_roles.company_id IS NULL`) or scoped to one company.
- The active company is selected per request through the `X-Company-Id` header;
  `JwtAuthGuard` validates the user may act in it and resolves permissions for
  that scope. Accounting endpoints will be annotated `@CompanyScoped()`.

## Frontend structure

```
app/
  login/                 public
  (app)/                 authenticated shell (SessionProvider, Sidebar, Header)
    dashboard/
    admin/{users,roles,audit-logs,organization}/
    [...segments]/       roadmap placeholder for modules of later phases
lib/
  api/client.ts          fetch wrapper: CSRF header, company header, refresh-and-retry
  api/hooks.ts           TanStack Query hooks and cache keys
  auth/session.tsx       principal, permissions, active company
  navigation.ts          menu definition with permission gates and roadmap phases
components/
  app-shell/             sidebar, header, command menu, change-password dialog
  ui-ext/                DataTable (server-driven), PageHeader, EmptyState, ConfirmDialog, Can
```

Permission checks in the UI (`Can`, `hasPermission`) are conveniences; the API is
the only authority.
