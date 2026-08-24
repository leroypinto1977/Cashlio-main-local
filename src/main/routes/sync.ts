import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'

/**
 * The change feed terminals replay to keep their local mirror current.
 */
export const router = Router()

// Terminals call this on each sync tick with the highest event id they've
// already applied. Server returns the next batch of events ordered by id.
//
// BigInt note: Postgres BIGSERIAL maps to JS BigInt. We serialize to string in
// the response and accept stringified numbers in the query.
/**
 * The change feed terminals replay to keep their local mirror current.
 *
 * Two things make this less obvious than "everything after id N".
 *
 * A BIGSERIAL id is allocated at insert time, so it orders writes by when
 * they started, not by when they committed. Two concurrent sales can take
 * ids 100 and 101 and commit in the opposite order. A terminal that pulls in
 * between is served 101, advances its cursor, and never sees 100 — a bill on
 * the branch server that exists on no till, with nothing to indicate it went
 * missing.
 *
 * So each row records the transaction that wrote it, and this endpoint does
 * two things with it. It serves only rows whose txid is below the current
 * snapshot's xmin, which means every transaction that could still produce a
 * lower-numbered row has already finished. And it pages by (txid, id) rather
 * than by id, because a filter alone is not enough: an older transaction can
 * still hold a *higher* id, and ordering by id would step over the one it is
 * about to commit. Under (txid, id) any row that appears later necessarily
 * belongs to a transaction that was still running when we answered, and so
 * sorts after everything already served.
 *
 * The cost is latency, not correctness: a long-running transaction holds xmin
 * down and the feed waits for it. Sales are short, so this is a few
 * milliseconds in practice.
 *
 * Cursors are "<txid>:<id>". A bare number from an older build is read as
 * (0, n), which is exactly right — rows predating this scheme carry txid 0.
 */
router.get('/api/v1/sync/pull', requireAuth(), async (req, res) => {
  try {
    const raw = String(req.query.cursor ?? '0')
    const [curTxid, curId] = (() => {
      const parts = raw.split(':')
      const parse = (v: string): bigint => {
        try {
          const n = BigInt(v)
          return n < 0n ? 0n : n
        } catch {
          return 0n
        }
      }
      return parts.length === 2
        ? [parse(parts[0]), parse(parts[1])]
        : [0n, parse(parts[0])]
    })()

    const limitRaw = parseInt(String(req.query.limit ?? '500'))
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 500 : limitRaw), 2000)

    const rows = await prisma.$queryRaw<
      Array<{
        id: bigint
        txid: bigint
        entity: string
        entityId: string
        op: string
        payload: unknown
        createdAt: Date
      }>
    >`
      SELECT "id", "txid", "entity", "entityId", "op", "payload", "createdAt"
        FROM "SyncEvent"
       WHERE "txid" < (pg_snapshot_xmin(pg_current_snapshot()))::text::bigint
         AND ("txid", "id") > (${curTxid}::bigint, ${curId}::bigint)
       ORDER BY "txid" ASC, "id" ASC
       LIMIT ${limit + 1}`

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const events = page.map((r) => ({
      id: r.id.toString(),
      // What the terminal should store once it has applied this event.
      cursor: `${r.txid.toString()}:${r.id.toString()}`,
      entity: r.entity,
      entityId: r.entityId,
      op: r.op,
      payload: r.payload,
      createdAt: r.createdAt.toISOString()
    }))
    const nextCursor =
      events.length > 0 ? events[events.length - 1].cursor : `${curTxid}:${curId}`

    // Remember how far this till has read, so the log can be trimmed to the
    // point every till has passed rather than to a guess about how long one
    // might have been switched off. Best-effort: a sync that works matters
    // more than a prune that is perfectly tight.
    const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : null
    if (deviceId) {
      prisma.authorizedClient
        .update({
          where: { id: deviceId },
          data: { syncCursorTxid: curTxid, lastSyncAt: new Date() }
        })
        .catch(() => undefined)
    }

    return res.json({ success: true, events, nextCursor, hasMore })
  } catch (err) {
    console.error('Error in /sync/pull:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

