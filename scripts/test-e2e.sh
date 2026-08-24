#!/usr/bin/env bash
# Boots the Express server against a throwaway Postgres database and runs the
# end-to-end suite. Never touches your development database.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${E2E_DB_NAME:-cashlio_e2e}"
PG_USER="${E2E_PG_USER:-postgres}"
export DATABASE_URL="postgresql://${PG_USER}:${E2E_PG_PASSWORD:-postgres}@localhost:5432/${DB_NAME}?schema=public"

if ! command -v psql >/dev/null 2>&1; then
  echo "psql not found on PATH — install PostgreSQL client tools to run the e2e suite." >&2
  exit 1
fi

echo "▸ recreating scratch database ${DB_NAME}"
psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};" -c "CREATE DATABASE ${DB_NAME};"

# Built from the migration files, not db push, so every test run also proves
# the migrations produce a schema the server actually works against.
echo "▸ applying migrations"
npx prisma migrate deploy >/dev/null

echo "▸ bundling server"
mkdir -p .test-build
npx esbuild src/main/server.ts src/main/licenseGuard.ts --bundle --platform=node --format=cjs \
  --outdir=.test-build \
  --out-extension:.js=.cjs \
  --external:@prisma/client --external:bcryptjs --external:jsonwebtoken \
  --external:express --external:cors --external:jose --log-level=error

echo "▸ running tests"
node test/e2e.test.cjs

echo "▸ dropping scratch database"
psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};"
