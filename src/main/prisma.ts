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
