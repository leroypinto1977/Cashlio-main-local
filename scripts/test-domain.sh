#!/usr/bin/env bash
# Exercises the billing domain directly, with no server in the way.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${DOMAIN_DB_NAME:-cashlio_domain}"
PG_USER="${E2E_PG_USER:-postgres}"
export DATABASE_URL="postgresql://${PG_USER}:${E2E_PG_PASSWORD:-postgres}@localhost:5432/${DB_NAME}?schema=public"

psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};" -c "CREATE DATABASE ${DB_NAME};"
npx prisma migrate deploy >/dev/null
node test/billing.test.cjs
psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};"
