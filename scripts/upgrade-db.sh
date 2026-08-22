#!/usr/bin/env bash
# Applies the current Prisma schema to your database and runs any data backfill.
#
# `--accept-data-loss` looks alarming but is required only because Prisma cannot
# tell a widening cast (integer -> numeric(12,3), for cut-length quantities)
# from a narrowing one. No rows or values are dropped; this was verified against
# a clone of a populated database.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ applying schema"
npx prisma db push --accept-data-loss
echo "▸ generating client"
npx prisma generate >/dev/null
echo "▸ backfilling data"
node scripts/backfill-pass2.cjs
echo "✓ database is up to date"
