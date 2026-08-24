import { Router } from 'express'
import { getBranchCertFingerprint } from '../branchCert'
import { validateUsername, validatePassword } from '../domain/accounts'
import { normalizeMac } from '../../shared/validation'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { fieldError } from '../http/respond'
import { verifyLicenseJwt, getLicenseStatus } from '../licenseGuard'
import { validateGstin, validateName, stateCodeOf } from '../../shared/validation'

/**
 * Setup, pairing, sign-in and the tills allowed to connect.
 */
export const router = Router()

router.get('/api/v1/system/status', async (_req, res) => {
  try {
    const config = await prisma.shopConfig.findFirst()
    if (!config) {
      return res.status(200).json({ setupDone: false })
    }
    const userCount = await prisma.user.count()
    return res.status(200).json({
      setupDone: userCount > 0,
      shopName: config.shopName,
      branchName: config.branchName,
      // Terminals print these on every receipt, so they travel with status.
      address: config.address,
      phone: config.phone,
      gstin: config.gstin,
      stateCode: config.stateCode
    })
  } catch (err) {
    console.error('Error in /system/status:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/system/save-config', async (req, res) => {
  try {
    const { licenseKey, hardwareId, branchName = 'PENDING_SETUP', shopName = 'My Shop' } = req.body

    // This used to fall back to a fixed placeholder, which would have given
    // every installation in the world the same identity — collapsing the
    // licence server's per-machine seat counting into a single shared row.
    // Better to refuse to activate than to activate as somebody else.
    if (typeof hardwareId !== 'string' || hardwareId.trim().length < 8) {
      return res.status(400).json({
        success: false,
        error: 'HARDWARE_ID_REQUIRED',
        message: 'This machine could not be identified, so the licence cannot be activated.'
      })
    }

    const existingConfig = await prisma.shopConfig.findUnique({ where: { licenseKey } })
    if (existingConfig) {
      return res.status(409).json({ success: false, error: 'LICENSE_ALREADY_ACTIVATED' })
    }

    const saasBaseUrl = process.env.SAAS_API_URL
    console.log(`Proxying activation to ${saasBaseUrl}/api/v1/licenses/activate`)
    const saasRes = await fetch(`${saasBaseUrl}/api/v1/licenses/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, hardwareId })
    })

    const saasData = await saasRes.json().catch(() => ({}))
    if (!saasRes.ok || !saasData.success) {
      console.error('SaaS Reacted to Activation with:', saasData)
      return res.status(saasRes.status || 400).json(saasData)
    }

    const licenseJwt = saasData.jwt || saasData.token
    if (!licenseJwt) {
      return res.status(500).json({ success: false, error: 'INVALID_LICENSE_RESPONSE' })
    }

    // Phase 4: verify the JWT signature up front and snapshot the hard expiry
    // + serverNow into the config. This lets us enforce the grace window even
    // if the SaaS goes offline immediately after activation.
    let claims: Awaited<ReturnType<typeof verifyLicenseJwt>>
    try {
      claims = await verifyLicenseJwt(licenseJwt)
    } catch {
      return res.status(500).json({ success: false, error: 'LICENSE_JWT_VERIFY_FAILED' })
    }

    const config = await prisma.shopConfig.create({
      data: {
        licenseKey,
        licenseJwt,
        branchName,
        shopName,
        hardwareId,
        licenseExpiresAt: new Date(claims.expiresAt),
        lastSeenServerTime: new Date(claims.serverNow),
        lastRefreshAt: new Date(),
        gracePeriodDays: claims.gracePeriodDays ?? 30
      }
    })

    return res.status(200).json({ success: true, config, jwt: licenseJwt })
  } catch (err) {
    console.error('Error saving config:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/system/setup-profile', async (req, res) => {
  try {
    const { branchName, shopName, adminUsername, adminPassword, location, gst } = req.body
    console.log(`Setting up profile for ${shopName} at ${location} (GST: ${gst})`)

    const config = await prisma.shopConfig.findFirst()
    if (!config) {
      return res.status(400).json({ success: false, error: 'LICENSE_NOT_ACTIVATED' })
    }

    // This route is unauthenticated because it runs before any account exists.
    // Once one does, it must stop working — otherwise anyone on the LAN could
    // call it and hand themselves a SUPER_ADMIN account.
    const existingUsers = await prisma.user.count()
    if (existingUsers > 0) {
      return res.status(409).json({ success: false, error: 'SETUP_ALREADY_COMPLETED' })
    }

    const shopCheck = validateName(String(shopName ?? ''), 'Shop name')
    if (!shopCheck.ok) return fieldError(res, shopCheck)
    const branchCheck = validateName(String(branchName ?? ''), 'Branch name')
    if (!branchCheck.ok) return fieldError(res, branchCheck)
    if (!adminUsername || String(adminUsername).trim().length < 3) {
      return res.status(400).json({
        success: false, error: 'USERNAME_INVALID',
        message: 'Username must be at least 3 characters.'
      })
    }
    if (!adminPassword || String(adminPassword).length < 8) {
      return res.status(400).json({
        success: false, error: 'PASSWORD_TOO_SHORT',
        message: 'Password must be at least 8 characters.'
      })
    }
    const gstCheck = validateGstin(String(gst ?? ''))
    if (!gstCheck.ok) return fieldError(res, gstCheck)

    try {
      await fetch(`${process.env.SAAS_API_URL}/api/v1/licenses/update-profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ licenseKey: config.licenseKey, branchName })
      })
    } catch (proxyErr) {
      console.error('Non-fatal: SaaS proxy failed for profile sync', proxyErr)
    }

    await prisma.shopConfig.update({
      where: { id: config.id },
      data: {
        shopName: shopCheck.value,
        branchName: branchCheck.value,
        address: location ? String(location).trim() : null,
        gstin: gstCheck.value || null,
        stateCode: stateCodeOf(gstCheck.value)
      }
    })

    const passwordHash = await bcrypt.hash(String(adminPassword), 10)
    await prisma.user.create({
      data: { username: String(adminUsername).trim().toLowerCase(), passwordHash, role: 'SUPER_ADMIN' }
    })

    // Optionally create the first till account in the same step. Without a
    // cashier the shop has to run every terminal as the super admin, which
    // makes every role gate in this file meaningless.
    let cashierCreated = false
    if (req.body?.cashierUsername) {
      const cashierName = validateUsername(req.body.cashierUsername)
      if (!cashierName.ok) return fieldError(res, cashierName)
      const cashierPass = validatePassword(req.body?.cashierPassword)
      if (!cashierPass.ok) return fieldError(res, cashierPass)
      if (cashierName.value === String(adminUsername).trim().toLowerCase()) {
        return res.status(409).json({
          success: false, error: 'USERNAME_TAKEN',
          message: 'The till account needs a different username from the manager account.'
        })
      }
      await prisma.user.create({
        data: {
          username: cashierName.value,
          passwordHash: await bcrypt.hash(cashierPass.value, 10),
          role: 'CASHIER'
        }
      })
      cashierCreated = true
    }

    return res.status(200).json({ success: true, cashierCreated })
  } catch (err) {
    console.error('Error in setup-profile:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Admit a till to this branch.
 *
 * This used to answer anyone. On a shop's Wi-Fi that meant a stranger could
 * burn every seat the licence allows with invented MAC addresses, and there
 * was no way to take one back. Pairing is now a manager's act: the till
 * collects a super-admin's credentials once, at setup, and never stores them.
 */
router.post('/api/v1/system/pair-client', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { friendlyName } = req.body
    // One canonical spelling, or the same physical till pairs twice and takes
    // two of the licence's seats with it.
    const macAddress = normalizeMac(String(req.body?.macAddress ?? ''))
    if (!macAddress) {
      return res.status(400).json({
        success: false, error: 'MAC_REQUIRED',
        message: 'This terminal could not identify itself on the network.'
      })
    }

    const config = await prisma.shopConfig.findFirst()
    if (!config?.licenseJwt) {
      return res.status(403).json({ success: false, error: 'NO_LICENSE_FOUND' })
    }

    // Phase 4: license JWTs are Ed25519-signed by admin-saas. We verify with
    // the public key only. If the JWT is expired but the license hasn't been
    // hard-locked yet, fall back to the cached claims — refresh will re-issue
    // a fresh token; we don't want to block pairing during a brief outage.
    let decoded: { maxSystemsPerBranch?: number } | null = null
    try {
      decoded = await verifyLicenseJwt(config.licenseJwt)
    } catch {
      const status = await getLicenseStatus()
      if (status.locked) {
        return res.status(403).json({ success: false, error: 'INVALID_LICENSE_JWT' })
      }
      // Expired JWT but inside grace window — accept cached values.
      decoded = { maxSystemsPerBranch: undefined }
    }
    const maxSystems = decoded?.maxSystemsPerBranch || 3

    // Retired tills don't hold a seat — that is the point of retiring them.
    const currentClients = await prisma.authorizedClient.count({ where: { retiredAt: null } })
    const existing = await prisma.authorizedClient.findUnique({ where: { macAddress } })
    if (!existing && currentClients >= maxSystems) {
      return res.status(403).json({ success: false, error: 'LICENSE_LIMIT_REACHED' })
    }

    let client = existing
    if (!client) {
      // Allocate a terminal code (T1, T2, …). Used by terminals to mint
      // globally-unique bill numbers offline. Counts existing codes rather
      // than client rows so re-pairing a renamed terminal doesn't burn slots.
      const allCodes = await prisma.authorizedClient.findMany({
        where: { terminalCode: { not: null } },
        select: { terminalCode: true }
      })
      const usedNums = new Set(
        allCodes
          .map((c) => c.terminalCode!.match(/^T(\d+)$/)?.[1])
          .filter(Boolean)
          .map((n) => Number(n))
      )
      let n = 1
      while (usedNums.has(n)) n++
      const terminalCode = `T${n}`

      client = await prisma.authorizedClient.create({
        data: { macAddress, friendlyName, terminalCode }
      })
    } else if (!client.terminalCode) {
      // Backfill: client paired before Phase 3D — assign a code on next pair.
      const allCodes = await prisma.authorizedClient.findMany({
        where: { terminalCode: { not: null } },
        select: { terminalCode: true }
      })
      const usedNums = new Set(
        allCodes
          .map((c) => c.terminalCode!.match(/^T(\d+)$/)?.[1])
          .filter(Boolean)
          .map((n) => Number(n))
      )
      let n = 1
      while (usedNums.has(n)) n++
      client = await prisma.authorizedClient.update({
        where: { id: client.id },
        data: { terminalCode: `T${n}` }
      })
    }

    const slotsRemaining = existing ? maxSystems - currentClients : maxSystems - currentClients - 1
    return res.status(200).json({
      success: true,
      clientId: client.id,
      terminalCode: client.terminalCode,
      // The one moment this can be handed over safely: a manager has just
      // authorised this till in person. From here the till accepts only this
      // certificate, so nothing on the network can answer in our place.
      certFingerprint: getBranchCertFingerprint(),
      message: `Authorized successfully. Slots remaining: ${slotsRemaining}`
    })
  } catch (err) {
    console.error('Error in /pair-client:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Failed sign-in attempts, per username and per source address.
 *
 * A shop password is four to five characters of whatever the owner could
 * remember, on a server that answers to anyone on the same Wi-Fi. Without a
 * limit, guessing the whole space takes minutes. Held in memory rather than
 * the database: the counter should not survive a restart of the server, and
 * writing a row per failed guess is its own denial of service.
 *
 * Keyed on both the username and the address so one person hammering an
 * account cannot lock out the shop from a different till, and one machine
 * cannot sweep every username from the same place.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_MAX_FAILURES = 10
const loginFailures = new Map<string, { count: number; first: number }>()

function loginKeys(username: string, ip: string): string[] {
  return [`u:${username.toLowerCase()}`, `a:${ip}`]
}

function loginBlockedFor(keys: string[], now = Date.now()): number {
  let waitMs = 0
  for (const k of keys) {
    const e = loginFailures.get(k)
    if (!e) continue
    if (now - e.first > LOGIN_WINDOW_MS) {
      loginFailures.delete(k)
      continue
    }
    if (e.count >= LOGIN_MAX_FAILURES) {
      waitMs = Math.max(waitMs, LOGIN_WINDOW_MS - (now - e.first))
    }
  }
  return waitMs
}

function noteLoginFailure(keys: string[], now = Date.now()): void {
  for (const k of keys) {
    const e = loginFailures.get(k)
    if (!e || now - e.first > LOGIN_WINDOW_MS) loginFailures.set(k, { count: 1, first: now })
    else e.count++
  }
  // The map is keyed by username and address, both attacker-chosen, so it
  // needs a ceiling of its own.
  if (loginFailures.size > 5000) {
    for (const [k, e] of loginFailures) {
      if (now - e.first > LOGIN_WINDOW_MS) loginFailures.delete(k)
    }
  }
}

function clearLoginFailures(keys: string[]): void {
  for (const k of keys) loginFailures.delete(k)
}

router.post('/api/v1/auth/login', async (req, res) => {
  try {
    // Accounts are stored lower-case, so "Manager" and "MANAGER" are the same
    // account as "manager". Looking the raw string up meant a cashier whose
    // keyboard capitalised the first letter was told their password was wrong
    // — and each attempt counted toward the ten that lock them out.
    const username = String(req.body?.username ?? '').trim().toLowerCase()
    const password = String(req.body?.password ?? '')
    const keys = loginKeys(username, req.ip ?? 'unknown')

    const waitMs = loginBlockedFor(keys)
    if (waitMs > 0) {
      const minutes = Math.max(1, Math.ceil(waitMs / 60000))
      return res.status(429).json({
        success: false,
        error: 'TOO_MANY_ATTEMPTS',
        message: `Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        retryAfterSeconds: Math.ceil(waitMs / 1000)
      })
    }

    const user = username ? await prisma.user.findUnique({ where: { username } }) : null

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      noteLoginFailure(keys)
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' })
    }

    // A dismissed cashier's password still matches; their account is what
    // stopped being valid. Say so rather than implying they mistyped it.
    if (!user.isActive) {
      return res.status(403).json({
        success: false,
        error: 'ACCOUNT_DISABLED',
        message: 'This account has been switched off. Ask a manager.'
      })
    }

    clearLoginFailures(keys)

    const token = jwt.sign(
      // `tv` pins the session to the account as it stands now. Bump the user's
      // tokenVersion and every token issued before it stops working.
      { userId: user.id, role: user.role, tv: user.tokenVersion },
      process.env.JWT_SECRET as string,
      { expiresIn: '12h' }
    )

    return res.status(200).json({ success: true, token })
  } catch (err) {
    console.error('Error in /login:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// The MAC address and id of every till in the shop is a map of the network
// for anyone who asks, so this asks for a token.
router.get('/api/v1/system/authorized-clients', requireAuth(), async (_req, res) => {
  try {
    // Named fields rather than the whole row: syncCursorTxid is a BigInt,
    // which JSON cannot serialise, and it is bookkeeping nobody needs to see.
    const clients = await prisma.authorizedClient.findMany({
      where: { retiredAt: null },
      select: {
        id: true,
        friendlyName: true,
        macAddress: true,
        terminalCode: true,
        authorizedAt: true,
        lastSyncAt: true
      },
      orderBy: { authorizedAt: 'desc' }
    })
    return res.status(200).json({ success: true, clients })
  } catch (err) {
    console.error('Error fetching authorized clients:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Take a till back off the branch, freeing its licence seat.
 *
 * Without this a mistyped pairing, a replaced machine or a stolen one
 * occupied a seat permanently — the shop had to call support to sell a till.
 * Bills name the terminal they were rung up on, so a till that has traded
 * cannot be erased; unpairing it clears the MAC and the terminal code, which
 * is what actually returns the seat, and leaves the row for the history.
 */
router.delete('/api/v1/system/authorized-clients/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const client = await prisma.authorizedClient.findUnique({
      where: { id },
      include: { _count: { select: { bills: true } } }
    })
    if (!client) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    if (client._count.bills > 0) {
      await prisma.authorizedClient.update({
        where: { id },
        data: {
          retiredAt: new Date(),
          // The MAC and the terminal code are unique, and this machine may be
          // re-paired or replaced by one reusing the code, so they are freed
          // here rather than held by a row nobody uses any more.
          macAddress: `RETIRED:${id}`,
          terminalCode: null,
          friendlyName: `${client.friendlyName} (retired)`
        }
      })
      return res.json({ success: true, retired: true, billCount: client._count.bills })
    }

    await prisma.authorizedClient.delete({ where: { id } })
    return res.json({ success: true, retired: false })
  } catch (err) {
    console.error('Error unpairing client:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
