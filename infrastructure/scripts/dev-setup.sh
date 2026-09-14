#!/usr/bin/env bash
# One-shot local bootstrap: infra -> deps -> migrate -> seed.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ -f .env ] || { cp .env.example .env; echo "Created .env from .env.example"; }
pnpm install
pnpm build:packages
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
echo "Waiting for PostgreSQL..."
until docker exec accounting-postgres pg_isready -U accounting -d accounting >/dev/null 2>&1; do sleep 1; done
pnpm db:migrate
pnpm db:seed
echo "Done. Run 'pnpm dev' and open http://localhost:3000"
