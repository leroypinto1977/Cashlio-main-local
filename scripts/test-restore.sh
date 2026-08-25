#!/usr/bin/env bash
# Backs up a database with real trade in it, then reads it back.
#
# The whole point of this suite is that it uses a real pg_dump, a real psql and
# a real Postgres: a backup that has only ever been checked against a mock is
# in exactly the state this phase exists to fix.
set -euo pipefail
cd "$(dirname "$0")/.."

DB_NAME="${RESTORE_DB_NAME:-cashlio_restore}"
PG_USER="${E2E_PG_USER:-postgres}"
export DATABASE_URL="postgresql://${PG_USER}:${E2E_PG_PASSWORD:-postgres}@localhost:5432/${DB_NAME}?schema=public"

if ! command -v pg_dump >/dev/null 2>&1 || ! command -v psql >/dev/null 2>&1; then
  echo "pg_dump and psql are needed to test the backup path." >&2
  exit 1
fi

psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};" -c "CREATE DATABASE ${DB_NAME};"
npx prisma migrate deploy >/dev/null

mkdir -p .test-build
npx esbuild src/main/restore.ts --bundle --platform=node --format=cjs \
  --outfile=.test-build/restore.cjs --external:@prisma/client --external:electron --log-level=error
# The backup runner too, so the path a shop actually runs is the one tested.
npx esbuild src/main/backup.ts --bundle --platform=node --format=cjs \
  --outfile=.test-build/backup.cjs --external:@prisma/client --external:electron --log-level=error

node test/restore.test.cjs
status=$?

psql -U "$PG_USER" -q -c "DROP DATABASE IF EXISTS ${DB_NAME};"
exit $status
