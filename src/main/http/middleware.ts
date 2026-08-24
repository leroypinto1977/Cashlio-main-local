import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../prisma'
import { getLicenseStatus, refreshIfStale } from '../licenseGuard'
import { getServerMac } from '../machineId'

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string }
    }
  }
}

// ─── License lock-out middleware (Phase 4) ─────────────────────────────────────
//
// Mounted on write endpoints so an expired / revoked license stops new bills
// while still letting cashiers view history. Read endpoints are intentionally
// unguarded — the user can always export their data.

export function requireActiveLicense() {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Ride the licence check along with the shop's own trading, so a licence
      // withdrawn overnight is noticed on the first sale of the day rather
      // than whenever the four-hourly loop next happens to fire. It does not
      // block: a shop on a bad line has to keep billing.
      if (process.env.SAAS_API_URL) {
        refreshIfStale(process.env.SAAS_API_URL, getServerMac())
      }
      const status = await getLicenseStatus()
      if (status.locked) {
        return res.status(402).json({
          success: false,
          error: 'LICENSE_LOCKED',
          reason: status.reason,
          // What to tell the person standing at the till.
          message: status.message,
          daysUntilExpiry: status.daysUntilExpiry,
          daysUntilGraceEnd: status.daysUntilGraceEnd
        })
      }
      return next()
    } catch (e) {
      console.error('License guard threw:', e)
      // Fail-open during transient DB hiccups so a corrupt licence row doesn't
      // brick the shop. The next refresh will surface the real issue.
      return next()
    }
  }
}

// ─── Auth Middleware ───────────────────────────────────────────────────────────

/**
 * Who a token-holder currently is, according to the database.
 *
 * The role used to come out of the token and was never questioned again, so a
 * cashier promoted to super-admin for an afternoon stayed one until their
 * token expired, and a dismissed one kept full access for twelve hours. The
 * database decides now.
 *
 * Every request would otherwise become an extra query, so answers are held
 * briefly. The window is short and — more to the point — every route that
 * changes a user drops that user's entry, so dismissing someone takes effect
 * on their next request rather than ten seconds later.
 */
type AuthUser = { role: string; isActive: boolean; tokenVersion: number }
const USER_CACHE_TTL_MS = 10_000
const userCache = new Map<string, { at: number; user: AuthUser | null }>()

export function forgetUser(userId: string): void {
  userCache.delete(userId)
}

async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const hit = userCache.get(userId)
  if (hit && Date.now() - hit.at < USER_CACHE_TTL_MS) return hit.user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, isActive: true, tokenVersion: true }
  })
  userCache.set(userId, { at: Date.now(), user })
  return user
}

export function requireAuth(roles?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED' })
    }
    let decoded: { userId: string; role: string; tv?: number }
    try {
      decoded = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET as string) as {
        userId: string
        role: string
        tv?: number
      }
    } catch {
      return res.status(401).json({ success: false, error: 'INVALID_TOKEN' })
    }

    let current: AuthUser | null
    try {
      current = await loadAuthUser(decoded.userId)
    } catch (e) {
      // The database is the authority on identity. If it cannot be reached we
      // refuse rather than fall back to the token's own claims, which is
      // exactly the situation this check exists to cover.
      console.error('Auth lookup failed:', e)
      return res.status(503).json({ success: false, error: 'AUTH_UNAVAILABLE' })
    }

    if (!current) {
      return res.status(401).json({ success: false, error: 'ACCOUNT_REMOVED' })
    }
    if (!current.isActive) {
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_DISABLED',
        message: 'This account has been switched off. Ask a manager.'
      })
    }
    // A password change, a demotion or a dismissal bumps this, which ends any
    // session issued before it — the point of being able to sign someone out.
    if ((decoded.tv ?? 0) !== current.tokenVersion) {
      return res.status(401).json({ success: false, error: 'SESSION_REVOKED' })
    }

    req.user = { userId: decoded.userId, role: current.role }
    if (roles && !roles.includes(current.role)) {
      return res.status(403).json({ success: false, error: 'FORBIDDEN' })
    }
    return next()
  }
}
