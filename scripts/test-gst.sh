#!/usr/bin/env bash
# Builds the GST return against a throwaway database seeded with a month of
# deliberately varied trade — registered and unregistered, both states, a
# credit note, a void, and a product with no HSN.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${GST_DB_NAME:-cashlio_gst}"
PG_USER="${E2E_PG_USER:-postgres}"
export DATABASE_URL="postgresql://${PG_USER}:${E2E_PG_PASSWORD:-postgres}@localhost:5432/${DB_NAME}?schema=public"

psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};" -c "CREATE DATABASE ${DB_NAME};"
npx prisma migrate deploy >/dev/null
node test/gstr1.test.cjs
psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};"
