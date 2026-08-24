// License hardening (Phase 4) — main-local side.
//
// Verifies the Ed25519-signed license JWT issued by admin-saas, runs the
// daily refresh loop, enforces the grace period, and detects clock tampering.
// The cashier auth flow uses a separate HS256 secret (JWT_SECRET) and is not
// touched here.
//
// Threat model summary:
//   * Stolen DB / binary cannot forge licenses (we only hold the public key).
//   * License copied to second machine fails hardware-id check.
//   * Setting clock backwards refuses to start (boot-time floor check).
//   * No internet for >gracePeriodDays days → bills blocked, reads still work.
//   * Revocation propagates within ~24h (next refresh).

import { jwtVerify } from 'jose'
import { createPublicKey, KeyObject } from 'node:crypto'
import { prisma } from './prisma'


// ─── Public key ──────────────────────────────────────────────────────────────

let cachedPublicKey: KeyObject | null = null
function getPublicKey(): KeyObject {
  if (cachedPublicKey) return cachedPublicKey
  const b64 = process.env.LICENSE_PUBLIC_KEY
  if (!b64) {
    throw new Error('LICENSE_PUBLIC_KEY missing — copy from admin-saas/scripts/gen-license-keys.js')
  }
  cachedPublicKey = createPublicKey({
    key: Buffer.from(b64, 'base64'),
    format: 'der',
    type: 'spki'
  })
  return cachedPublicKey
}

// ─── Claims & verification ───────────────────────────────────────────────────

export type LicenseClaims = {
  licenseKey: string
  tenantId: string
  maxBranches: number
  maxSystemsPerBranch: number
  expiresAt: string
  gracePeriodDays: number
  refreshTokenSeq: number
  branchName: string | null
  hardwareId: string
  serverNow: string
  iat?: number
  exp?: number
}

export async function verifyLicenseJwt(token: string): Promise<LicenseClaims> {
  const { payload } = await jwtVerify(token, getPublicKey(), {
    algorithms: ['EdDSA']
  })
  return payload as unknown as LicenseClaims
}

// ─── Status snapshot for runtime checks ──────────────────────────────────────

export type LicenseStatus = {
  ok: boolean
  // Hard-locked: bills must be blocked. Reads still allowed.
  locked: boolean
  /// Machine-readable code — what the guard decided.
  reason: string | null
  /// The same thing in words somebody at a counter can act on, taken from the
  /// licence server where it gave one.
  message: string | null
  // Soft-warning levels surfaced to the manager UI.
  warning: 'NONE' | 'REFRESH_OVERDUE' | 'NEAR_GRACE_END' | 'EXPIRED'
  daysUntilExpiry: number | null
  daysUntilGraceEnd: number | null
  lastRefreshAt: Date | null
  hardwareIdMismatch: boolean
}

/** Plain words for the codes the licence server can refuse with. */
function reasonForError(code: unknown): string {
  switch (code) {
    case 'LICENSE_REVOKED':
      return 'This licence has been withdrawn. Contact your supplier.'
    case 'LICENSE_EXPIRED':
      return 'This licence has expired. Renew it to start billing again.'
    case 'LICENSE_HARDWARE_MISMATCH':
      return 'This licence is registered to a different machine. Contact your supplier to move it.'
    case 'LICENSE_SEAT_LIMIT':
      return 'Every machine this licence covers is already in use. Contact your supplier to release one or add another.'
    default:
      return 'Billing is blocked by the licence server. Contact your supplier.'
  }
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const config = await prisma.shopConfig.findFirst()
  if (!config) {
    return {
      ok: false, locked: true, reason: 'NO_LICENSE',
      message: 'This installation has no licence yet. Complete setup to start billing.',
      warning: 'EXPIRED', daysUntilExpiry: null, daysUntilGraceEnd: null,
      lastRefreshAt: null, hardwareIdMismatch: false
    }
  }

  const now = Date.now()
  const expiresAt = config.licenseExpiresAt?.getTime() ?? null
  const grace = (config.gracePeriodDays ?? 30) * 24 * 60 * 60 * 1000
  const lastRefresh = config.lastRefreshAt?.getTime() ?? null
  const refreshDeadline = lastRefresh ? lastRefresh + grace : null

  let locked = config.licenseLocked
  // A lock set by the licence server carries its explanation with it; the
  // cases decided locally below supply their own.
  let reason: string | null = config.licenseLocked ? 'LICENSE_BLOCKED' : null
  let message: string | null = config.licenseLocked
    ? config.licenseLockReason ?? 'Billing is blocked by the licence server. Contact your supplier.'
    : null
  let warning: LicenseStatus['warning'] = 'NONE'

  if (expiresAt != null && expiresAt <= now) {
    locked = true
    reason = 'LICENSE_EXPIRED'
    message = 'This licence has expired. Renew it to start billing again.'
    warning = 'EXPIRED'
  } else if (refreshDeadline != null && refreshDeadline <= now) {
    // No successful refresh inside the grace window
    locked = true
    reason = 'REFRESH_OVERDUE_GRACE_EXCEEDED'
    message =
      'This shop has been offline too long for its licence to be confirmed. ' +
      'Reconnect it to the internet to start billing again.'
    warning = 'EXPIRED'
  } else if (lastRefresh != null) {
    const oneDay = 24 * 60 * 60 * 1000
    const daysSince = (now - lastRefresh) / oneDay
    if (daysSince > 1) warning = 'REFRESH_OVERDUE'
    if (refreshDeadline != null && refreshDeadline - now < 5 * oneDay) {
      warning = 'NEAR_GRACE_END'
    }
  }

  const daysUntilExpiry =
    expiresAt != null ? Math.floor((expiresAt - now) / (24 * 60 * 60 * 1000)) : null
  const daysUntilGraceEnd =
    refreshDeadline != null
      ? Math.floor((refreshDeadline - now) / (24 * 60 * 60 * 1000))
      : null

  return {
    ok: !locked,
    locked,
    reason,
    message,
    warning,
    daysUntilExpiry,
    daysUntilGraceEnd,
    lastRefreshAt: config.lastRefreshAt,
    hardwareIdMismatch: false
  }
}

// ─── Boot-time clock-tampering check ─────────────────────────────────────────
//
// If the local clock is more than 24h behind the last server-issued timestamp,
// refuse to start. This stops the trivial "set clock backwards to extend
// expired license" attack. Returns the offset in ms (positive = clock is
// behind by N ms) or null if no server time has ever been recorded.

export async function checkClockTamper(): Promise<{
  ok: boolean
  driftMs: number | null
  lastSeen: Date | null
}> {
  const config = await prisma.shopConfig.findFirst()
  if (!config?.lastSeenServerTime) {
    return { ok: true, driftMs: null, lastSeen: null }
  }
  const drift = config.lastSeenServerTime.getTime() - Date.now()
  // Allow 1h slop for legitimate timezone changes / DST. Anything beyond is
  // either a tampering attempt or a serious clock issue worth surfacing.
  const ALLOWED_BACKWARD_MS = 60 * 60 * 1000
  return {
    ok: drift <= ALLOWED_BACKWARD_MS,
    driftMs: drift,
    lastSeen: config.lastSeenServerTime
  }
}

// ─── Refresh worker ─────────────────────────────────────────────────────────
//
// Calls /licenses/refresh on the SaaS. On success: updates JWT, expiry,
// lastSeenServerTime, lastRefreshAt; clears licenseLocked. On failure: just
// records the attempt and error. The grace window logic in getLicenseStatus
// handles lock-out automatically.

export async function refreshLicenseOnce(saasBaseUrl: string, hardwareId: string): Promise<{
  ok: boolean
  error?: string
}> {
  const config = await prisma.shopConfig.findFirst()
  if (!config) return { ok: false, error: 'NO_LICENSE' }

  await prisma.shopConfig.update({
    where: { id: config.id },
    data: { lastRefreshAttempt: new Date() }
  })

  let resp: Response
  try {
    resp = await fetch(`${saasBaseUrl}/api/v1/licenses/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey: config.licenseKey, hardwareId })
    })
  } catch (e) {
    const error = (e as Error).message || 'NETWORK_ERROR'
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: { lastRefreshError: error }
    })
    return { ok: false, error }
  }

  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || !data?.success) {
    const error = data?.error || `HTTP_${resp.status}`
    // 403 LICENSE_REVOKED is terminal — lock immediately.
    const isTerminal =
      resp.status === 403 &&
      typeof data?.error === 'string' &&
      [
        'LICENSE_REVOKED',
        'LICENSE_EXPIRED',
        'LICENSE_HARDWARE_MISMATCH',
        // Every seat on the licence is taken by another machine. Retrying will
        // not free one, so this locks rather than sitting in the grace window
        // pretending it might come good.
        'LICENSE_SEAT_LIMIT'
      ].includes(data.error)
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: {
        lastRefreshError: error,
        ...(isTerminal
          ? {
              licenseLocked: true,
              // Keep the server's own words. A shop told only that its licence
              // is locked cannot act; told that the subscription is unpaid, it
              // can.
              // The server's own words where it gave any — a seat refusal
              // names how many machines are in use, which is more use than
              // anything this end could compose.
              licenseLockReason:
                typeof data?.revokeReason === 'string' && data.revokeReason.trim()
                  ? data.revokeReason.trim()
                  : typeof data?.message === 'string' && data.message.trim()
                    ? data.message.trim()
                    : reasonForError(data?.error)
            }
          : {})
      }
    })
    return { ok: false, error }
  }

  let claims: LicenseClaims
  try {
    claims = await verifyLicenseJwt(data.jwt)
  } catch {
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: { lastRefreshError: 'INVALID_JWT_SIGNATURE' }
    })
    return { ok: false, error: 'INVALID_JWT_SIGNATURE' }
  }

  // The licence server bumps refreshTokenSeq when a licence is revoked or
  // transferred. A token carrying a number *below* the highest this shop has
  // already seen was minted before that happened — either a replay of the copy
  // on disk, or a response from something standing in for the licence server.
  // Either way it is not evidence of a live licence.
  if (typeof claims.refreshTokenSeq === 'number' && claims.refreshTokenSeq < config.refreshTokenSeq) {
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: {
        lastRefreshError: 'STALE_LICENSE_TOKEN',
        licenseLocked: true,
        licenseLockReason:
          'This licence was withdrawn or moved to another machine. Contact your supplier.'
      }
    })
    return { ok: false, error: 'STALE_LICENSE_TOKEN' }
  }

  // Defensive: server's hardwareId in the claims must match what we sent
  if (claims.hardwareId && claims.hardwareId !== hardwareId) {
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: { lastRefreshError: 'HARDWARE_ID_MISMATCH_IN_CLAIMS' }
    })
    return { ok: false, error: 'HARDWARE_ID_MISMATCH_IN_CLAIMS' }
  }

  await prisma.shopConfig.update({
    where: { id: config.id },
    data: {
      licenseJwt: data.jwt,
      licenseExpiresAt: new Date(claims.expiresAt),
      lastSeenServerTime: new Date(claims.serverNow),
      lastRefreshAt: new Date(),
      lastRefreshError: null,
      licenseLocked: false,
      licenseLockReason: null,
      // The licence server decides how long this shop may run offline and how
      // current its token must be. Both used to be read from whatever was
      // stored at activation, so shortening a tenant's grace period had no
      // effect on the shop it was shortened for.
      gracePeriodDays: claims.gracePeriodDays ?? config.gracePeriodDays,
      refreshTokenSeq: Math.max(config.refreshTokenSeq, claims.refreshTokenSeq ?? 0),
      hardwareId
    }
  })
  return { ok: true }
}

export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000

/**
 * Check the licence if it hasn't been checked lately, without making anybody
 * wait for it.
 *
 * The periodic loop alone leaves a gap: a shop that opens at nine has no
 * reason to have refreshed since the small hours, so a licence revoked
 * overnight goes unnoticed until the next tick. Calling this as bills are
 * written means the check rides along with the shop's own activity — the
 * first sale of the day triggers it.
 *
 * Deliberately fire-and-forget. A shop on a bad line must be able to keep
 * billing while this fails in the background; blocking a sale on a network
 * call to decide whether the sale is allowed would take the shop down every
 * time the internet did.
 */
let refreshInFlight = false
export function refreshIfStale(saasBaseUrl: string, hardwareId: string): void {
  if (refreshInFlight) return
  refreshInFlight = true
  void (async () => {
    try {
      const config = await prisma.shopConfig.findFirst()
      const last = config?.lastRefreshAt?.getTime() ?? 0
      if (Date.now() - last < REFRESH_INTERVAL_MS) return
      await refreshLicenseOnce(saasBaseUrl, hardwareId)
    } catch (e) {
      console.error('[license] opportunistic refresh failed:', e)
    } finally {
      refreshInFlight = false
    }
  })()
}

/**
 * Long-running refresh loop. Calls refreshLicenseOnce every `intervalMs`,
 * with exponential backoff after consecutive failures (up to 6h between
 * attempts). Designed to run for the lifetime of the Electron process.
 */
export function startRefreshLoop(opts: {
  saasBaseUrl: string
  hardwareId: string
  intervalMs?: number
}): { stop: () => void } {
  // Twice a day meant a revoked shop could keep billing for half a day before
  // its own server heard about it. Four-hourly costs the licence server six
  // calls per shop per day and closes most of that window; `refreshIfStale`
  // below closes the rest by checking when a shop actually starts trading.
  const baseInterval = opts.intervalMs ?? REFRESH_INTERVAL_MS
  let consecutiveFailures = 0
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const r = await refreshLicenseOnce(opts.saasBaseUrl, opts.hardwareId)
      consecutiveFailures = r.ok ? 0 : consecutiveFailures + 1
    } catch (e) {
      console.error('[license] refresh tick threw:', e)
      consecutiveFailures++
    }
    if (stopped) return
    // Backoff: 12h, 24h, 48h, 96h, 6h floor… capped at 6h between retries
    // once we're failing hard. The grace window is what protects the user
    // here, not the retry cadence.
    const backoff = Math.min(baseInterval * Math.pow(2, consecutiveFailures), 6 * 60 * 60 * 1000)
    const next = consecutiveFailures > 0 ? backoff : baseInterval
    timer = setTimeout(tick, next)
  }

  // First tick after a short warmup so a paused laptop coming back online
  // refreshes promptly without contending with boot work.
  timer = setTimeout(tick, 30_000)
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}
