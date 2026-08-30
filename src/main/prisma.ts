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
  const engine = fs
    .readdirSync(dir)
    .find((f) => f.endsWith('.node') && f.includes('query_engine'))
  if (engine) {
    process.env.PRISMA_QUERY_ENGINE_LIBRARY = path.join(dir, engine)
  }
}
pointAtBundledEngine()

// eslint-disable-next-line import/first -- must follow pointAtBundledEngine()
import { PrismaClient } from '@prisma/client'

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
 */
export const prisma = new PrismaClient()
