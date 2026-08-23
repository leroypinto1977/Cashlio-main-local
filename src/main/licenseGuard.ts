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
  reason: string | null
  // Soft-warning levels surfaced to the manager UI.
  warning: 'NONE' | 'REFRESH_OVERDUE' | 'NEAR_GRACE_END' | 'EXPIRED'
  daysUntilExpiry: number | null
  daysUntilGraceEnd: number | null
  lastRefreshAt: Date | null
  hardwareIdMismatch: boolean
}

export async function getLicenseStatus(): Promise<LicenseStatus> {
  const config = await prisma.shopConfig.findFirst()
  if (!config) {
    return {
      ok: false, locked: true, reason: 'NO_LICENSE',
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
  let reason: string | null = null
  let warning: LicenseStatus['warning'] = 'NONE'

  if (expiresAt != null && expiresAt <= now) {
    locked = true
    reason = 'LICENSE_EXPIRED'
    warning = 'EXPIRED'
  } else if (refreshDeadline != null && refreshDeadline <= now) {
    // No successful refresh inside the grace window
    locked = true
    reason = 'REFRESH_OVERDUE_GRACE_EXCEEDED'
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
      ['LICENSE_REVOKED', 'LICENSE_EXPIRED', 'LICENSE_HARDWARE_MISMATCH'].includes(data.error)
    await prisma.shopConfig.update({
      where: { id: config.id },
      data: {
        lastRefreshError: error,
        ...(isTerminal ? { licenseLocked: true } : {})
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
      hardwareId
    }
  })
  return { ok: true }
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
  const baseInterval = opts.intervalMs ?? 12 * 60 * 60 * 1000  // 12h default
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
