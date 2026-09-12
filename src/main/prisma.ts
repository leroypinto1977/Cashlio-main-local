import path from 'node:path'
import fs from 'node:fs'

/**
 * Point Prisma at the engine that ships beside the app.
 *
 * The query engine is a native binary in a dot-directory that the packager
 * does not collect, and it cannot be loaded from inside an asar in any case.
 * It travels as a plain resource instead, and this says where — before
 * @prisma/client is imported, because it reads the variable at load time.
 *
 * Getting this wrong does not raise an error. The import hangs looking for an
 * engine it will never find, which happens before a window is drawn or a line
 * is logged, so the application looks as though it never started at all.
 */
function pointAtBundledEngine(): void {
  if (process.env.PRISMA_QUERY_ENGINE_LIBRARY) return
  const resources = process.resourcesPath
  if (!resources) return
  const dir = path.join(resources, 'prisma-engine')
  if (!fs.existsSync(dir)) return

  // Match the engine to the platform rather than taking the first file that
  // looks like one. A build carries an engine per entry in binaryTargets, and
  // 'libquery_engine-darwin-arm64.dylib.node' sorts ahead of
  // 'query_engine-windows.dll.node' — so picking the first match handed the
  // Windows build a macOS library.
  const wanted = process.platform === 'win32' ? 'windows' : process.platform
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.node') && f.includes('query_engine'))
  const engine = candidates.find((f) => f.includes(wanted))

  if (!engine) {
    // Loud, because the alternative is silent: Prisma with no engine hangs at
    // import, before a window exists or a line is logged, and the application
    // simply looks as though it never started.
    throw new Error(
      `No Prisma query engine for ${process.platform} in ${dir}. ` +
        `Found: ${candidates.length ? candidates.join(', ') : 'nothing'}.`
    )
  }
  process.env.PRISMA_QUERY_ENGINE_LIBRARY = path.join(dir, engine)
}
pointAtBundledEngine()

// eslint-disable-next-line import/first -- must follow pointAtBundledEngine()
import { PrismaClient } from '@prisma/client'

let client: PrismaClient | null = null

/**
 * Built on first use, not on import.
 *
 * Prisma reads DATABASE_URL when the client is constructed, and in a packaged
 * build nobody knows that value yet at import time: the bundled PostgreSQL
 * picks a free port while starting, which happens later, inside whenReady.
 * Constructing at module scope captured an empty environment and every query
 * failed with "Environment variable not found: DATABASE_URL" — the database
 * itself being up and correct the whole time.
 */
function client_(): PrismaClient {
  if (!client) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'The database was asked for before its address was known. ' +
          'startBundledPostgres() sets DATABASE_URL and must run first.'
      )
    }
    client = new PrismaClient()
  }
  return client
}

/**
 * The one database client this process uses.
 *
 * There used to be three — one in the API, one in the licence guard, one in
 * the backup job — and each brings its own connection pool sized from the
 * CPU count. On an ordinary counter machine that was roughly fifty
 * connections held open against a Postgres whose default ceiling is a
 * hundred, on a server that is also running that Postgres. Nothing here
 * needs its own pool: they are three parts of one application talking to one
 * local database.
 *
 * A proxy, so that every existing `prisma.bill.findMany()` keeps working
 * unchanged while the client underneath is not built until something first
 * asks for it.
 */
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const real = client_()
    const value = Reflect.get(real, property, real)
    return typeof value === 'function' ? value.bind(real) : value
  }
})
