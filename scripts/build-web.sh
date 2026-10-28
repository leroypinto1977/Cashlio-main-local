#!/usr/bin/env bash
# Builds the hosted test version — the manager app as a website, with the
# branch API behind it — in Vercel's Build Output API layout (.vercel/output).
# Runs on Vercel, so `prisma generate` produces the Linux query engine.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=.vercel/output
FN=$OUT/functions/api.func
rm -rf "$OUT"

npx prisma generate

# Every push to main deploys, and a push can carry a migration: apply it before
# the new code goes live. The pooled runtime URL cannot migrate, so this needs
# the direct one.
if [ -n "${DIRECT_DATABASE_URL:-}" ]; then
  DATABASE_URL="$DIRECT_DATABASE_URL" npx prisma migrate deploy
fi
npx vite build --config vite.web.config.ts

npx esbuild src/main/webEntry.ts --bundle --platform=node --target=node22 --format=cjs \
  --external:@prisma/client --outfile="$FN/index.js" --log-level=warning

mkdir -p "$FN/node_modules/@prisma" "$FN/node_modules/.prisma"
cp -R node_modules/@prisma/client "$FN/node_modules/@prisma/client"
cp -R node_modules/.prisma/client "$FN/node_modules/.prisma/client"
rm -f "$FN"/node_modules/.prisma/client/*windows*

cat > "$FN/.vc-config.json" <<'JSON'
{ "runtime": "nodejs22.x", "handler": "index.js", "launcherType": "Nodejs", "maxDuration": 30, "regions": ["sin1"] }
JSON

cat > "$OUT/config.json" <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "^/api/(.*)$", "dest": "/api" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ]
}
JSON
