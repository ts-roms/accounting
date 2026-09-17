# Enterprise Accounting & Financial Management System

A modular-monolith accounting platform (NestJS + Next.js + PostgreSQL) designed
around one principle: **the general ledger is the single source of financial
truth**. Every business transaction becomes a balanced journal entry; every
report is derived from posted journal lines; every change is audited.

> Status: **All nine phases complete.** Accounting core, AR/AP, sales &
> purchasing, inventory, fixed assets, banking, cost dimensions, the tax
> engine, budgets, expense claims, multi-currency with FX revaluation,
> intercompany + consolidation, approval workflows, attachments and advisory
> AI assistance (document intake, classification, anomaly flags, assistant,
> forecast) are live. See
> [docs/development-roadmap.md](docs/development-roadmap.md).

## Stack

| Layer    | Technology                                                                                                                             |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS v4, shadcn-style UI (Radix), TanStack Table & Query, React Hook Form + Zod |
| Backend  | NestJS 11, REST + OpenAPI, Zod DTOs (`nestjs-zod`), pino logging                                                                       |
| Data     | PostgreSQL 16, Drizzle ORM, Redis 7 + BullMQ                                                                                           |
| Tooling  | pnpm workspaces, Turborepo, ESLint 9, Prettier, Jest, Vitest, Playwright, Docker Compose                                               |

## Quick start

Prerequisites: Node 22+, pnpm 9+, Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up              # PostgreSQL on 127.0.0.1:5433, Redis on 6379 (use 127.0.0.1, not localhost, on Windows)
pnpm build:packages
pnpm db:migrate
pnpm db:seed
pnpm dev                   # web http://localhost:3000  |  api http://localhost:3001/api/v1  |  docs /api/docs
```

Sign in with `admin@acme.local` / `P@ssw0rd123` (other demo users in
[docs/deployment.md](docs/deployment.md)).

## Repository layout

```
apps/api            NestJS API (auth, users, organizations, rbac, audit, accounting, receivables, payables, orders, sales, purchasing, inventory, fixed-assets, banking, tax, budgeting, fx, consolidation, workflows, attachments, ai, reporting, jobs)
apps/web            Next.js application
packages/types      Permission catalog, system roles, SoD defaults, shared enums
packages/validation Zod schemas shared by API and web
packages/config     API path, header and cookie constants
packages/money      Exact-decimal Money value object and formatting
packages/ui         Component library
infrastructure      docker-compose, Dockerfiles, scripts
docs                Architecture, accounting engine, database, API, security, permissions, ...
```

## Scripts

| Command                                                    | Description                                                                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm dev` / `pnpm build`                                  | Run / build everything through Turborepo                                                                                                           |
| `pnpm lint` / `pnpm typecheck` / `pnpm test`               | Quality gates across the workspace                                                                                                                 |
| `pnpm --filter @accounting/api test:e2e`                   | API integration tests against `accounting_test` (needs `pnpm infra:up`); worktrees use `accounting_test_<worktree>`, or set `TEST_DATABASE_SUFFIX` |
| `pnpm --filter @accounting/web test:e2e`                   | Playwright against a running stack                                                                                                                 |
| `pnpm db:generate` / `db:migrate` / `db:seed` / `db:reset` | Drizzle migrations and seed                                                                                                                        |
| `pnpm infra:up` / `infra:down` / `infra:logs`              | Docker infrastructure                                                                                                                              |

## Documentation

- [Architecture](docs/architecture.md)
- [Accounting engine rules](docs/accounting-engine.md)
- [Accounting core reference](docs/accounting/architecture.md) - chart, journals, posting engine, ledger, statements, dimensions, posting rules, multi-currency, period close, reversals, integrity
- [Accounting controls](docs/accounting-controls.md)
- [Subledger reconciliation](docs/reconciliation.md)
- [Database](docs/database.md)
- [API](docs/api.md)
- [Security](docs/security.md)
- [Permissions & roles](docs/permissions.md)
- [Financial reporting](docs/financial-reporting.md)
- [Tax](docs/tax.md)
- [Deployment](docs/deployment.md)
- [Development roadmap](docs/development-roadmap.md)
