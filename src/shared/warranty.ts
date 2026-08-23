/**
 * Warranty vocabulary shared by the branch server, manager UI and terminal.
 *
 * A warranty's lifecycle is ACTIVE → CLAIMED → RESOLVED. "Expired" is never
 * stored: it is whether the expiry date has passed, worked out when asked, so
 * a row can never be stale about it.
 */

export type WarrantyStoredStatus = 'ACTIVE' | 'CLAIMED' | 'RESOLVED'
export type WarrantyStatus = WarrantyStoredStatus | 'EXPIRED'

export type WarrantyResolution = 'REPAIRED' | 'REPLACED' | 'REFUNDED' | 'REJECTED'

export const WARRANTY_RESOLUTIONS: readonly { code: WarrantyResolution; label: string; hint: string }[] = [
  { code: 'REPAIRED', label: 'Repaired', hint: 'Fixed and returned to the customer' },
  { code: 'REPLACED', label: 'Replaced', hint: 'A new unit was given' },
  { code: 'REFUNDED', label: 'Refunded', hint: 'Money returned instead' },
  { code: 'REJECTED', label: 'Rejected', hint: 'Not covered — misuse, out of cover, or not a fault' }
]

export function isWarrantyResolution(v: unknown): v is WarrantyResolution {
  return typeof v === 'string' && WARRANTY_RESOLUTIONS.some((r) => r.code === v)
}

export const WARRANTY_STATUS_LABEL: Record<WarrantyStatus, string> = {
  ACTIVE: 'In cover',
  EXPIRED: 'Expired',
  CLAIMED: 'Claim open',
  RESOLVED: 'Resolved'
}

/** Days of notice before expiry that count as "expiring soon". */
export const EXPIRING_SOON_DAYS = 30

export function expiryDateFor(purchaseDate: Date | string, warrantyPeriodDays: number): Date {
  const d = new Date(purchaseDate)
  d.setDate(d.getDate() + Math.max(0, Math.floor(warrantyPeriodDays)))
  return d
}

/**
 * The status a warranty should display. An open or resolved claim keeps its
 * own status regardless of the date — a claim filed in cover is still a
 * claim after the cover ends.
 */
export function effectiveStatus(
  stored: string,
  expiryDate: Date | string,
  now: Date | string = new Date()
): WarrantyStatus {
  if (stored === 'CLAIMED' || stored === 'RESOLVED') return stored
  return new Date(expiryDate).getTime() < new Date(now).getTime() ? 'EXPIRED' : 'ACTIVE'
}

export function daysUntilExpiry(expiryDate: Date | string, now: Date | string = new Date()): number {
  return Math.ceil((new Date(expiryDate).getTime() - new Date(now).getTime()) / 86_400_000)
}

/** Whether a claim may be opened: in cover, and no claim already open. */
export function canClaim(stored: string, expiryDate: Date | string, now: Date | string = new Date()): {
  allowed: boolean
  reason?: 'EXPIRED' | 'ALREADY_CLAIMED' | 'ALREADY_RESOLVED'
} {
  if (stored === 'CLAIMED') return { allowed: false, reason: 'ALREADY_CLAIMED' }
  if (stored === 'RESOLVED') return { allowed: false, reason: 'ALREADY_RESOLVED' }
  if (effectiveStatus(stored, expiryDate, now) === 'EXPIRED') return { allowed: false, reason: 'EXPIRED' }
  return { allowed: true }
}
