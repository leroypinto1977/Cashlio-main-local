// Bringing the schema up to date, without the Prisma CLI.
//
// `prisma migrate deploy` is a development tool: it is not in a packaged app,
// and shipping the CLI and its engines to run it once at startup would be
// absurd. But the migrations themselves are just SQL, and the bundled psql can
// apply them — so this walks the same directory the CLI would, in the same
// order, and records each one in the same table so a developer's CLI and a
// shopkeeper's install never disagree about what has been applied.

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pgToolUrl, pgEnv } from './pgUrl'

/** Where the migration folders are, in development and once packaged. */
function migrationsDir(): string | null {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'prisma', 'migrations')]
    : [path.join(app.getAppPath(), 'prisma', 'migrations')]
  for (const c of candidates) if (fs.existsSync(c)) return c
  return null
}

function psql(psqlPath: string, dbUrl: string, args: string[], stdinFile?: string): { ok: boolean; err: string } {
  const { url, password } = pgToolUrl(dbUrl)
  const r = spawnSync(psqlPath, ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', ...args, url], {
    env: pgEnv(password),
    encoding: 'utf8',
    input: stdinFile ? fs.readFileSync(stdinFile, 'utf8') : undefined
  })
  return { ok: r.status === 0, err: ((r.stderr ?? '') + (r.error ? String(r.error) : '')).trim() }
}

function query(psqlPath: string, dbUrl: string, sql: string): string[] {
  const { url, password } = pgToolUrl(dbUrl)
  const r = spawnSync(psqlPath, ['--quiet', '--no-psqlrc', '-t', '-A', '-c', sql, url], {
    env: pgEnv(password), encoding: 'utf8'
  })
  if (r.status !== 0) return []
  return (r.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
}

/**
 * Applies every migration the database has not seen, oldest first.
 *
 * Stops at the first failure rather than carrying on: a half-applied schema is
 * worse than an old one, because the app will start against it and only find
 * out which half is missing when somebody tries to sell something.
 */
export function applyMigrations(psqlPath: string, dbUrl: string): { applied: string[]; error: string | null } {
  const dir = migrationsDir()
  if (!dir) return { applied: [], error: 'the migrations are missing from this build' }

  // Prisma's own bookkeeping table, created exactly as the CLI would so the two
  // can be used interchangeably on the same database.
  const created = psql(psqlPath, dbUrl, ['-c', `
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id"                  VARCHAR(36)  PRIMARY KEY,
      "checksum"            VARCHAR(64)  NOT NULL,
      "finished_at"         TIMESTAMPTZ,
      "migration_name"      VARCHAR(255) NOT NULL,
      "logs"                TEXT,
      "rolled_back_at"      TIMESTAMPTZ,
      "started_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
      "applied_steps_count" INTEGER      NOT NULL DEFAULT 0
    )`])
  if (!created.ok) return { applied: [], error: `could not prepare the migration table: ${created.err.slice(0, 300)}` }

  const done = new Set(query(psqlPath, dbUrl,
    `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`))

  const pending = fs.readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, 'migration.sql')))
    .sort()                                  // the folder names are timestamps
    .filter((n) => !done.has(n))

  const applied: string[] = []
  for (const name of pending) {
    const file = path.join(dir, name, 'migration.sql')
    const sql = fs.readFileSync(file)
    const checksum = crypto.createHash('sha256').update(sql).digest('hex')
    console.log(`[migrate] applying ${name}`)

    const run = psql(psqlPath, dbUrl, ['-f', file])
    if (!run.ok) {
      return { applied, error: `${name} failed: ${run.err.slice(0, 600)}` }
    }
    const record = psql(psqlPath, dbUrl, ['-c', `
      INSERT INTO "_prisma_migrations"
        ("id", "checksum", "migration_name", "finished_at", "applied_steps_count")
      VALUES ('${crypto.randomUUID()}', '${checksum}', '${name.replace(/'/g, "''")}', now(), 1)`])
    if (!record.ok) {
      // The schema moved but the record did not, so the next launch would try
      // it again. Say so rather than leaving it to be discovered then.
      return { applied, error: `${name} was applied but could not be recorded: ${record.err.slice(0, 300)}` }
    }
    applied.push(name)
  }
  return { applied, error: null }
}
