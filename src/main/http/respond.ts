import type { Response } from 'express'
import type { FieldResult } from '../../shared/validation'

/**
 * Turn `?limit=&offset=` into something safe to hand a database.
 *
 * These came straight off the query string through `parseInt`, so a caller
 * could ask for every row in the table — and on the endpoints that include
 * batches or bill lines, every related row too. That is a few keystrokes
 * away from exhausting the server's memory and taking every till in the shop
 * offline with it. `?limit=abc` was worse: NaN reached Prisma and became a
 * 500 on a screen the shop needed.
 *
 * A ceiling of 200 is above any page a person reads and far below what hurts.
 */
const DEFAULT_PAGE = 50
export const MAX_PAGE = 200

export function pageArgs(
  query: { limit?: unknown; offset?: unknown },
  fallback = DEFAULT_PAGE
): { take: number; skip: number } {
  const rawTake = parseInt(String(query.limit ?? fallback), 10)
  const rawSkip = parseInt(String(query.offset ?? 0), 10)
  return {
    take: Math.min(MAX_PAGE, Math.max(1, Number.isFinite(rawTake) ? rawTake : fallback)),
    skip: Math.max(0, Number.isFinite(rawSkip) ? rawSkip : 0)
  }
}


/** Rejects a request with the shared validator's own error code and message. */
export function fieldError(res: Response, r: Extract<FieldResult<string>, { ok: false }>) {
  return res.status(400).json({ success: false, error: r.error, message: r.message })
}
