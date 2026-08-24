/**
 * Trimming the change log terminals replay.
 *
 * Append-only with nothing removing rows meant every price edit, customer
 * change and bill since the shop opened stayed in it forever, each carrying
 * a full JSON snapshot, inside the database that gets dumped twice a day.
 *
 * Deleting by age alone would be a guess: a till switched off for a month
 * would come back to find the changes it slept through gone, with no way to
 * know it had missed them. Tills report how far they have read, and the log
 * is trimmed only below the point every one of them has passed. A till that
 * has never reported blocks pruning entirely — the safe direction to fail.
 */
import { prisma } from '../prisma'

const SYNC_EVENT_RETENTION_DAYS = 30

export async function pruneSyncEvents(now = new Date()): Promise<{ deleted: number }> {
  const cutoffDate = new Date(now.getTime() - SYNC_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000)

  const tills = await prisma.authorizedClient.findMany({
    where: { retiredAt: null },
    select: { syncCursorTxid: true }
  })

  // A till that has never reported a cursor might be anywhere in the log, so
  // nothing is deleted until every one of them has been heard from. Retired
  // tills don't count — they are not coming back for it.
  if (tills.length > 0 && tills.some((c) => c.syncCursorTxid === null)) {
    return { deleted: 0 }
  }

  const safeBelow = tills.reduce<bigint | null>((min, c) => {
    const v = c.syncCursorTxid
    if (v === null) return min
    return min === null || v < min ? v : min
  }, null)

  // Both conditions, not either: old enough that no reasonable outage covers
  // it, *and* already read by every till.
  const result =
    safeBelow === null
      ? await prisma.$executeRaw`
          DELETE FROM "SyncEvent" WHERE "createdAt" < ${cutoffDate}`
      : await prisma.$executeRaw`
          DELETE FROM "SyncEvent"
           WHERE "createdAt" < ${cutoffDate}
             AND "txid" <= ${safeBelow}::bigint`

  if (result > 0) {
    console.log(
      `[sync] pruned ${result} change-log rows older than ${SYNC_EVENT_RETENTION_DAYS} days` +
        (safeBelow === null ? ' (no tills paired)' : ` and read by every till`)
    )
  }
  return { deleted: result }
}

let pruneTimer: NodeJS.Timeout | null = null

export function startSyncEventPruning(): void {
  if (pruneTimer) return
  const tick = (): void => {
    pruneSyncEvents().catch((e) => console.error('[sync] prune failed', e))
  }
  // Not at boot: the first minutes after a restart are when terminals are
  // reconnecting and catching up.
  setTimeout(tick, 10 * 60 * 1000)
  pruneTimer = setInterval(tick, 24 * 60 * 60 * 1000)
}
