#!/usr/bin/env bash
# Brings a database up to the current schema and runs any data backfill.
# Safe to re-run: migrations that have already been applied are skipped and
# every backfill step is idempotent.
#
# Databases created before migration files existed (built with `prisma db
# push`) need their baseline recorded once; this script detects that case and
# does it automatically rather than trying to re-create tables that exist.
set -euo pipefail
cd "$(dirname "$0")/.."

BASELINE="20260823000001_baseline"

echo "▸ checking migration state"
# A pre-migration database has our tables but no _prisma_migrations record.
HAS_TABLES=$(psql "${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')}" -qAt \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='ShopConfig'" 2>/dev/null || echo 0)
HAS_HISTORY=$(psql "${DATABASE_URL:-$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')}" -qAt \
  -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='_prisma_migrations'" 2>/dev/null || echo 0)

if [ "$HAS_TABLES" = "1" ] && [ "$HAS_HISTORY" = "0" ]; then
  echo "▸ existing database without migration history — recording baseline"
  npx prisma migrate resolve --applied "$BASELINE"
fi

echo "▸ applying migrations"
npx prisma migrate deploy
echo "▸ generating client"
npx prisma generate >/dev/null
echo "▸ backfilling data"
node scripts/backfill-pass2.cjs
node scripts/backfill-pass3.cjs
echo "✓ database is up to date"
