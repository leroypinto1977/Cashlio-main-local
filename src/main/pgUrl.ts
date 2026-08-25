/**
 * Turning a Prisma connection string into one the Postgres tools accept.
 *
 * Prisma's URL carries query parameters libpq has never heard of, and libpq
 * does not ignore what it does not recognise — it refuses the whole URL:
 *
 *   pg_dump: error: invalid URI query parameter: "schema"
 *
 * `?schema=public` is on the end of every Prisma Postgres URL by default, so
 * handing DATABASE_URL straight to pg_dump fails on a completely standard
 * setup. It exits non-zero, no file is written, and the only trace is a line
 * in a log nobody reads — which is how a shop ends up with a backup schedule
 * that has never once produced a backup.
 */

/**
 * Parameters Prisma understands and libpq does not. Everything else is left
 * alone: `sslmode`, `sslcert`, `connect_timeout` and `application_name` are
 * real libpq options and stripping them would break connections that work.
 */
const PRISMA_ONLY_PARAMS = [
  'schema',
  'connection_limit',
  'pool_timeout',
  'socket_timeout',
  'pgbouncer',
  'statement_cache_size',
  'sslidentity',
  'sslpassword'
]

export type PgToolUrl = {
  /** Safe to hand to pg_dump, psql, pg_restore. */
  url: string
  /** The schema Prisma was pointed at, if it named one. */
  schema: string | null
  /** The password, lifted out so it can go in the environment instead of the
   *  argument vector, where `ps` shows it to every account on the machine. */
  password: string | null
}

export function pgToolUrl(dbUrl: string): PgToolUrl {
  try {
    const u = new URL(dbUrl)
    const schema = u.searchParams.get('schema')
    for (const p of PRISMA_ONLY_PARAMS) u.searchParams.delete(p)
    const password = u.password ? decodeURIComponent(u.password) : null
    u.password = ''
    return { url: u.toString(), schema: schema || null, password }
  } catch {
    // Not a URL we can parse — hand it over untouched rather than mangling a
    // connection string that works.
    return { url: dbUrl, schema: null, password: null }
  }
}

/** The same URL, pointed at a different database on the same server. */
export function pgToolUrlFor(dbUrl: string, dbName: string): PgToolUrl {
  const base = pgToolUrl(dbUrl)
  try {
    const u = new URL(base.url)
    u.pathname = `/${dbName}`
    return { ...base, url: u.toString() }
  } catch {
    return base
  }
}

/** The environment a Postgres tool should run with, password included. */
export function pgEnv(password: string | null): NodeJS.ProcessEnv {
  return password ? { ...process.env, PGPASSWORD: password } : process.env
}
