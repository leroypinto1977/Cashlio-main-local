/**
 * The shop keeps IST time. Every calendar boundary — what counts as "today",
 * which month a document number belongs to — has to be worked out in IST, or
 * a sale at 10pm lands on tomorrow's books for a shop that is still open.
 */
export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/**
 * Returns the start of a calendar day in IST, expressed as a UTC Date.
 * Passing offset=1 gives tomorrow's IST midnight, offset=-1 gives yesterday's, etc.
 */
export function istMidnight(base: Date = new Date(), offset = 0): Date {
  const istMs = base.getTime() + IST_OFFSET_MS
  const ist = new Date(istMs)
  const midnightUTC = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offset)
  return new Date(midnightUTC - IST_OFFSET_MS)
}

/** `YYMM` in IST — the period document-number series reset on. */
export function currentPeriod(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const yy = String(ist.getUTCFullYear()).slice(2)
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0')
  return `${yy}${mm}`
}
