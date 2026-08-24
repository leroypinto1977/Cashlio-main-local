import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import http from 'http'
import https from 'https'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { Prisma } from '@prisma/client'
import { prisma } from './prisma'
import { getServerMac } from './machineId'
import { requireAuth, requireActiveLicense, forgetUser } from './http/middleware'
import { pageArgs, MAX_PAGE, fieldError } from './http/respond'
import {
  serializeBillItem, serializeBill, serializeBatch, serializePayment,
  serializePurchaseOrder, serializeWarranty, WARRANTY_INCLUDE
} from './domain/serializers'
import { resolveBrand, brandFields } from './domain/brands'
import { IST_OFFSET_MS, istMidnight } from './domain/dates'
import { allocateNumber, peekNumber } from './domain/numbering'
import {
  outstandingFor,
  readTenders,
  lockBill,
  recomputeBillSettlement,
  resolveSoldAt,
  createBillCore,
  planRestock,
  processReturnCore,
  type IncomingSaleItem
} from './domain/billing'
import {
  recordSync,
  emitProductUpsert,
  emitProductUpsertBulk,
  emitCustomerUpsert,
  emitBillUpsert
} from './syncEvents'
import {
  verifyLicenseJwt,
  getLicenseStatus,
  checkClockTamper,
  refreshLicenseOnce
} from './licenseGuard'
import {
  validateMobile,
  validateContactNumber,
  validateEmail,
  validateGstin,
  validateName,
  validateItemCode,
  stateCodeOf,
  codeStub,
  type FieldResult
} from '../shared/validation'
import { round2 } from '../shared/money'
import { parseQty, roundQty, computePurchaseCost, defaultMeasureFor, measuresFor } from '../shared/units'
import {
  isPaymentMethod, ageBucketOf, daysBetween, UNSETTLED_STATUSES
} from '../shared/credit'
import {
  isReturnReasonCode, isPurchaseOrderStatus,
  canReceive, canCancel, isEditable, statusAfterReceipt
} from '../shared/procurement'
import { canClaim, isWarrantyResolution, EXPIRING_SOON_DAYS } from '../shared/warranty'


/**
 * The fingerprint of the certificate this server is presenting, set at boot.
 *
 * There is no certificate authority in a shop, so a till cannot check this
 * server the way a browser checks a bank. Instead it is told the fingerprint
 * once, at pairing — a moment a manager is standing there authorising it —
 * and from then on accepts that certificate and nothing else. Pinning is a
 * stronger promise than the public web's: the till trusts *that* certificate,
 * rather than trusting whoever vouched for it.
 */
let branchCertFingerprint: string | null = null
export function setBranchCertFingerprint(fp: string | null): void {
  branchCertFingerprint = fp
}

const app = express()


/**
 * Who may read this API from a browser.
 *
 * It answered every origin with a wildcard, which meant any web page anyone in
 * the shop happened to open — an ad frame on a phone joined to the same Wi-Fi
 * is enough — could call this server from the visitor's browser and read the
 * replies. The token lives in the till's local storage and is sent by script,
 * not by a cookie, so the page could not have stolen it directly; it could,
 * however, read every customer, every bill and every price out of a server
 * that trusted it purely for being on the network.
 *
 * The only browsers meant to reach this are the app's own windows. In a
 * packaged build those load from file:, which sends `Origin: null`; in
 * development they load from a local Vite server. Nothing else is allowed a
 * CORS header at all, which is what makes a browser refuse to hand the
 * response back to the page that asked.
 *
 * Requests with no Origin header — the apps' own main processes, curl,
 * anything that is not a browser — are unaffected. That is not a hole: those
 * clients were never subject to the same-origin policy, and every route worth
 * protecting requires a token regardless.
 */
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || origin === 'null' || origin === 'file://') return callback(null, true)
      if (LOCAL_ORIGIN.test(origin)) return callback(null, true)
      // No header, rather than an error: the request still runs for non-browser
      // callers, and a browser blocks the page from reading the answer.
      return callback(null, false)
    },
    credentials: false
  })
)
app.use(express.json({ limit: '2mb' }))

// ─── Phase 1 — System & Auth ──────────────────────────────────────────────────

app.get('/api/v1/system/status', async (_req, res) => {
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

app.post('/api/v1/system/save-config', async (req, res) => {
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

app.post('/api/v1/system/setup-profile', async (req, res) => {
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
app.post('/api/v1/system/pair-client', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { macAddress, friendlyName } = req.body

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
      certFingerprint: branchCertFingerprint,
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

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const username = String(req.body?.username ?? '')
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
app.get('/api/v1/system/authorized-clients', requireAuth(), async (_req, res) => {
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
app.delete('/api/v1/system/authorized-clients/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

// ─── Users ────────────────────────────────────────────────────────────────────

/**
 * Until this existed the only account in a shop was the super admin created
 * at setup, which had to be typed into every till — so every SUPER_ADMIN gate
 * in this file was decorative, and the cashier *was* the admin.
 */
const ROLES = ['SUPER_ADMIN', 'CASHIER'] as const
type Role = (typeof ROLES)[number]
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

/** Usernames are typed at a till, so keep them simple and unambiguous. */
function validateUsername(raw: string): FieldResult {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return { ok: false, error: 'USERNAME_REQUIRED', message: 'Username is required.' }
  if (v.length < 3 || v.length > 32) {
    return { ok: false, error: 'USERNAME_INVALID', message: 'Username must be 3–32 characters.' }
  }
  if (!/^[a-z0-9._-]+$/.test(v)) {
    return {
      ok: false, error: 'USERNAME_INVALID',
      message: 'Username may use letters, digits, and . _ - only.'
    }
  }
  return { ok: true, value: v }
}

function validatePassword(raw: string): FieldResult {
  const v = String(raw ?? '')
  if (v.length < 8) {
    return { ok: false, error: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters.' }
  }
  if (v.length > 200) {
    return { ok: false, error: 'PASSWORD_TOO_LONG', message: 'Password is too long.' }
  }
  return { ok: true, value: v }
}

app.get('/api/v1/users', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, role: true, isActive: true, createdAt: true,
        _count: { select: { bills: true } }
      },
      orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { username: 'asc' }]
    })
    return res.json({
      success: true,
      users: users.map((u) => ({
        id: u.id, username: u.username, role: u.role, isActive: u.isActive,
        createdAt: u.createdAt, billCount: u._count.bills
      }))
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/users', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const nameCheck = validateUsername(req.body?.username)
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const passCheck = validatePassword(req.body?.password)
    if (!passCheck.ok) return fieldError(res, passCheck)
    if (!isRole(req.body?.role)) {
      return res.status(400).json({
        success: false, error: 'INVALID_ROLE', message: 'Choose either Cashier or Super Admin.'
      })
    }

    const user = await prisma.user.create({
      data: {
        username: nameCheck.value,
        passwordHash: await bcrypt.hash(passCheck.value, 10),
        role: req.body.role
      },
      select: { id: true, username: true, role: true, isActive: true, createdAt: true }
    })
    return res.status(201).json({ success: true, user })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false, error: 'USERNAME_TAKEN', message: 'That username is already in use.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/users/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const data: Record<string, unknown> = {}

    // Any of these three is somebody's access changing, and each one only
    // means something if the sessions already open stop working. Bumping
    // tokenVersion is what does that.
    let revokeSessions = false

    if (req.body?.password !== undefined) {
      const passCheck = validatePassword(req.body.password)
      if (!passCheck.ok) return fieldError(res, passCheck)
      data.passwordHash = await bcrypt.hash(passCheck.value, 10)
      revokeSessions = true
    }

    if (req.body?.isActive !== undefined) {
      const active = Boolean(req.body.isActive)
      if (!active) {
        if (id === req.user!.userId) {
          return res.status(409).json({
            success: false, error: 'CANNOT_DISABLE_SELF',
            message: 'You cannot switch off your own account.'
          })
        }
        if (target.role === 'SUPER_ADMIN') {
          const admins = await prisma.user.count({
            where: { role: 'SUPER_ADMIN', isActive: true }
          })
          if (admins <= 1) {
            return res.status(409).json({
              success: false, error: 'LAST_SUPER_ADMIN',
              message: 'This is the only active super admin. Promote someone else first.'
            })
          }
        }
      }
      data.isActive = active
      revokeSessions = true
    }

    if (req.body?.role !== undefined) {
      if (!isRole(req.body.role)) {
        return res.status(400).json({ success: false, error: 'INVALID_ROLE' })
      }
      // Never let the last super admin demote themselves — the shop would be
      // locked out of its own settings with no way back in.
      if (target.role === 'SUPER_ADMIN' && req.body.role !== 'SUPER_ADMIN') {
        const admins = await prisma.user.count({
          where: { role: 'SUPER_ADMIN', isActive: true }
        })
        if (admins <= 1) {
          return res.status(409).json({
            success: false, error: 'LAST_SUPER_ADMIN',
            message: 'This is the only super admin. Promote someone else first.'
          })
        }
      }
      if (req.body.role !== target.role) revokeSessions = true
      data.role = req.body.role
    }

    if (revokeSessions) data.tokenVersion = { increment: 1 }

    const user = await prisma.user.update({
      where: { id }, data,
      select: { id: true, username: true, role: true, isActive: true, createdAt: true }
    })
    // The cached answer is now stale, and the whole point of the bump is that
    // it takes effect at once rather than when the cache happens to expire.
    forgetUser(id)
    return res.json({ success: true, user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/users/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    if (id === req.user!.userId) {
      return res.status(409).json({
        success: false, error: 'CANNOT_DELETE_SELF',
        message: 'You cannot remove your own account.'
      })
    }
    const target = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { bills: true } } }
    })
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    if (target.role === 'SUPER_ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } })
      if (admins <= 1) {
        return res.status(409).json({
          success: false, error: 'LAST_SUPER_ADMIN',
          message: 'This is the only super admin and cannot be removed.'
        })
      }
    }

    // Bills reference their cashier, and a sale must always name who made it.
    if (target._count.bills > 0) {
      return res.status(409).json({
        success: false, error: 'USER_HAS_BILLS',
        message: `${target.username} has ${target._count.bills} bill${target._count.bills === 1 ? '' : 's'} against their name and cannot be deleted. Switch the account off instead — it ends their access and keeps the sales history intact.`,
        billCount: target._count.bills
      })
    }

    await prisma.user.delete({ where: { id } })
    forgetUser(id)
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Shop profile ─────────────────────────────────────────────────────────────

app.get('/api/v1/system/shop-profile', requireAuth(), async (_req, res) => {
  try {
    const config = await prisma.shopConfig.findFirst()
    if (!config) return res.status(404).json({ success: false, error: 'NOT_CONFIGURED' })
    return res.json({
      success: true,
      profile: {
        shopName: config.shopName,
        branchName: config.branchName,
        address: config.address,
        phone: config.phone,
        gstin: config.gstin,
        stateCode: config.stateCode
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * The shop's own details. These are printed on every invoice, and the GSTIN
 * decides whether a sale is taxed as CGST+SGST or IGST, so the state code is
 * always kept in step with the GSTIN rather than entered separately.
 */
app.put('/api/v1/system/shop-profile', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { shopName, branchName, address, phone, gstin } = req.body
    const config = await prisma.shopConfig.findFirst()
    if (!config) return res.status(404).json({ success: false, error: 'NOT_CONFIGURED' })

    const data: Record<string, unknown> = {}
    if (shopName !== undefined) {
      const c = validateName(String(shopName), 'Shop name')
      if (!c.ok) return fieldError(res, c)
      data.shopName = c.value
    }
    if (branchName !== undefined) {
      const c = validateName(String(branchName), 'Branch name')
      if (!c.ok) return fieldError(res, c)
      data.branchName = c.value
    }
    if (phone !== undefined) {
      const c = validateContactNumber(String(phone ?? ''), { required: false })
      if (!c.ok) return fieldError(res, c)
      data.phone = c.value || null
    }
    if (gstin !== undefined) {
      const c = validateGstin(String(gstin ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.gstin = c.value || null
      data.stateCode = stateCodeOf(c.value)
    }
    if (address !== undefined) data.address = address ? String(address).trim() : null

    const updated = await prisma.shopConfig.update({ where: { id: config.id }, data })
    return res.json({
      success: true,
      profile: {
        shopName: updated.shopName,
        branchName: updated.branchName,
        address: updated.address,
        phone: updated.phone,
        gstin: updated.gstin,
        stateCode: updated.stateCode
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Suggests the next free item code for a category/brand pair, e.g. PVC-FIN-003.
 * Purely advisory — the operator can overwrite it before saving.
 */
app.get('/api/v1/system/suggest-item-code', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { categoryId, brand } = req.query
    let categoryStub = 'GEN'
    if (categoryId) {
      const category = await prisma.category.findUnique({
        where: { id: String(categoryId) },
        select: { name: true }
      })
      if (category) categoryStub = codeStub(category.name) || 'GEN'
    }
    let brandName = brand ? String(brand) : ''
    if (!brandName && req.query.brandId) {
      const b = await prisma.brand.findUnique({
        where: { id: String(req.query.brandId) }, select: { name: true }
      })
      brandName = b?.name ?? ''
    }
    const brandStub = brandName ? codeStub(brandName) : ''
    const prefix = [categoryStub, brandStub].filter(Boolean).join('-')

    const existing = await prisma.product.findMany({
      where: { itemCode: { startsWith: `${prefix}-` } },
      select: { itemCode: true }
    })
    const used = new Set<number>()
    for (const p of existing) {
      const tail = p.itemCode.slice(prefix.length + 1)
      if (/^\d+$/.test(tail)) used.add(parseInt(tail, 10))
    }
    let next = 1
    while (used.has(next)) next++

    return res.json({ success: true, itemCode: `${prefix}-${String(next).padStart(3, '0')}` })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 2A — Warehouses ────────────────────────────────────────────────────

app.get('/api/v1/warehouses', requireAuth(), async (_req, res) => {
  try {
    const warehouses = await prisma.warehouse.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, warehouses })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/warehouses', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name, location } = req.body
    if (!name) return res.status(400).json({ success: false, error: 'NAME_REQUIRED' })
    const warehouse = await prisma.warehouse.create({ data: { name, location } })
    return res.status(201).json({ success: true, warehouse })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'WAREHOUSE_NAME_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/warehouses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name, location, isActive } = req.body
    const warehouse = await prisma.warehouse.update({
      where: { id: String(req.params.id) },
      data: { name, location, isActive }
    })
    return res.json({ success: true, warehouse })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/warehouses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    await prisma.warehouse.delete({ where: { id: String(req.params.id) } })
    return res.json({ success: true })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Brands ───────────────────────────────────────────────────────────────────

app.get('/api/v1/brands', requireAuth(), async (req, res) => {
  try {
    const includeInactive = req.query.includeInactive === '1'
    const brands = await prisma.brand.findMany({
      where: includeInactive ? undefined : { isActive: true },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' }
    })
    return res.json({
      success: true,
      brands: brands.map((b) => ({
        id: b.id, name: b.name, isActive: b.isActive, productCount: b._count.products
      }))
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/brands', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const check = validateName(String(req.body?.name ?? ''), 'Brand name')
    if (!check.ok) return fieldError(res, check)
    const brand = await prisma.brand.create({ data: { name: check.value } })
    return res.status(201).json({ success: true, brand })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false, error: 'BRAND_NAME_EXISTS',
        message: 'A brand with this name already exists.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/brands/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const { name, isActive } = req.body
    const data: Record<string, unknown> = {}
    if (name !== undefined) {
      const check = validateName(String(name), 'Brand name')
      if (!check.ok) return fieldError(res, check)
      data.name = check.value
    }
    if (isActive !== undefined) data.isActive = Boolean(isActive)

    const brand = await prisma.$transaction(async (tx) => {
      const updated = await tx.brand.update({ where: { id }, data })
      if (data.name) {
        // Product.brand is a denormalised copy of the brand name, so a rename
        // has to travel to every product (and out to the terminals with it).
        const affected = await tx.product.findMany({
          where: { brandId: id }, select: { id: true }
        })
        if (affected.length > 0) {
          await tx.product.updateMany({ where: { brandId: id }, data: { brand: updated.name } })
          await emitProductUpsertBulk(tx, affected.map((p) => p.id))
        }
      }
      return updated
    })
    return res.json({ success: true, brand })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'P2025') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (code === 'P2002') {
      return res.status(409).json({
        success: false, error: 'BRAND_NAME_EXISTS',
        message: 'A brand with this name already exists.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/brands/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const productCount = await prisma.product.count({ where: { brandId: id } })
    if (productCount > 0) {
      return res.status(409).json({
        success: false, error: 'BRAND_IN_USE',
        message: `${productCount} product${productCount === 1 ? '' : 's'} still use this brand. Deactivate it instead.`,
        productCount
      })
    }
    await prisma.brand.delete({ where: { id } })
    return res.json({ success: true })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 2A — Categories ────────────────────────────────────────────────────

app.get('/api/v1/categories', requireAuth(), async (_req, res) => {
  try {
    const categories = await prisma.category.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, categories })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/categories', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name } = req.body
    if (!name) return res.status(400).json({ success: false, error: 'NAME_REQUIRED' })
    const category = await prisma.category.create({ data: { name } })
    return res.status(201).json({ success: true, category })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'CATEGORY_NAME_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/categories/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name } = req.body
    const category = await prisma.category.update({
      where: { id: String(req.params.id) },
      data: { name }
    })
    return res.json({ success: true, category })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/categories/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    await prisma.category.delete({ where: { id: String(req.params.id) } })
    return res.json({ success: true })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    // P2003 = FK constraint (products exist in this category)
    if ((err as { code?: string }).code === 'P2003') {
      return res.status(409).json({ success: false, error: 'CATEGORY_HAS_PRODUCTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 2A — Suppliers ─────────────────────────────────────────────────────

app.get('/api/v1/suppliers', requireAuth(), async (_req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, suppliers })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/suppliers/:id', requireAuth(), async (req, res) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: String(req.params.id) },
      include: { products: { include: { product: true } } }
    })
    if (!supplier) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    return res.json({ success: true, supplier })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/suppliers', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name, contactPerson, phone, email, address, gstin } = req.body

    const nameCheck = validateName(String(name ?? ''), 'Supplier name')
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const phoneCheck = validateContactNumber(String(phone ?? ''))
    if (!phoneCheck.ok) return fieldError(res, phoneCheck)
    const emailCheck = validateEmail(String(email ?? ''))
    if (!emailCheck.ok) return fieldError(res, emailCheck)
    const gstCheck = validateGstin(String(gstin ?? ''))
    if (!gstCheck.ok) return fieldError(res, gstCheck)
    const contactCheck = validateName(String(contactPerson ?? ''), 'Contact person', { required: false })
    if (!contactCheck.ok) return fieldError(res, contactCheck)

    const supplier = await prisma.supplier.create({
      data: {
        name: nameCheck.value,
        contactPerson: contactCheck.value || null,
        phone: phoneCheck.value,
        email: emailCheck.value || null,
        address: address ? String(address).trim() : null,
        gstin: gstCheck.value || null
      }
    })
    return res.status(201).json({ success: true, supplier })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/suppliers/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { name, contactPerson, phone, email, address, gstin, isActive } = req.body

    const data: Record<string, unknown> = {}
    if (name !== undefined) {
      const c = validateName(String(name), 'Supplier name')
      if (!c.ok) return fieldError(res, c)
      data.name = c.value
    }
    if (contactPerson !== undefined) {
      const c = validateName(String(contactPerson ?? ''), 'Contact person', { required: false })
      if (!c.ok) return fieldError(res, c)
      data.contactPerson = c.value || null
    }
    if (phone !== undefined) {
      const c = validateContactNumber(String(phone))
      if (!c.ok) return fieldError(res, c)
      data.phone = c.value
    }
    if (email !== undefined) {
      const c = validateEmail(String(email ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.email = c.value || null
    }
    if (gstin !== undefined) {
      const c = validateGstin(String(gstin ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.gstin = c.value || null
    }
    if (address !== undefined) data.address = address ? String(address).trim() : null
    if (isActive !== undefined) data.isActive = isActive

    const supplier = await prisma.supplier.update({
      where: { id: String(req.params.id) },
      data
    })
    return res.json({ success: true, supplier })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/suppliers/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    await prisma.supplier.delete({ where: { id: String(req.params.id) } })
    return res.json({ success: true })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 2A — Products ──────────────────────────────────────────────────────

/**
 * The product catalogue.
 *
 * This returned every matching product with every one of its batches, and
 * ignored any limit it was given. Each terminal asked for the lot once an
 * hour to fill its offline cache, so a shop with a few thousand products and
 * a few years of batches moved tens of megabytes across the counter network
 * every hour, per till, and built all of it in the branch server's memory
 * first.
 *
 * It pages now. `slim=true` drops the batch lists, which is what a till
 * actually wants: it sells from stock totals and has no use for the purchase
 * history behind them.
 */
app.get('/api/v1/products', requireAuth(), async (req, res) => {
  try {
    const { search, categoryId, isActive } = req.query
    const slim = String(req.query.slim ?? '') === 'true'
    const page = pageArgs(req.query, MAX_PAGE)

    const where: Prisma.ProductWhereInput = {
      isActive: isActive === 'false' ? false : isActive === 'true' ? true : undefined,
      categoryId: categoryId ? String(categoryId) : undefined,
      OR: search
        ? [
            { name: { contains: String(search), mode: 'insensitive' } },
            { itemCode: { contains: String(search), mode: 'insensitive' } },
            { brand: { contains: String(search), mode: 'insensitive' } }
          ]
        : undefined
    }

    const [total, products] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
      where,
      include: {
        // The category is one row and the till shows it; the batches are the
        // expensive part, and only the manager screens read them.
        category: true,
        batches: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            batchCode: true,
            uniqueStockCode: true,
            purchaseRate: true,
            currentQty: true,
            receivedQty: true,
            receivedDate: true,
            warehouseId: true,
            warehouse: { select: { name: true } },
            supplierId: true,
            supplier: { select: { name: true } },
            isActive: true,
            createdAt: true
          }
        }
      },
      orderBy: { name: 'asc' },
      ...page
      })
    ])

    const result = products.map((p) => {
      const mappedBatches = p.batches.map(serializeBatch)
      const totalStock = roundQty(mappedBatches.reduce((sum, b) => sum + b.currentQty, 0))
      const base = {
        ...p,
        totalStock,
        batchCount: mappedBatches.length,
        sellingRate: Number(p.sellingRate),
        gstPercentage: Number(p.gstPercentage),
        minStockLevel: Number(p.minStockLevel)
      }
      if (slim) {
        const { batches: _b, ...rest } = base
        return rest
      }
      return { ...base, latestBatch: mappedBatches[0] ?? null, batches: mappedBatches }
    })

    return res.json({
      success: true,
      products: result,
      total,
      hasMore: page.skip + result.length < total
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/products/:id', requireAuth(), async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: String(req.params.id) },
      include: {
        category: true,
        suppliers: { include: { supplier: true } },
        batches: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          include: { warehouse: true, supplier: true }
        }
      }
    })
    if (!product) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const mappedBatches = product.batches.map(serializeBatch)
    return res.json({
      success: true,
      product: {
        ...product,
        totalStock: roundQty(product.batches.reduce((sum, b) => sum + Number(b.currentQty), 0)),
        sellingRate: Number(product.sellingRate),
        gstPercentage: Number(product.gstPercentage),
        minStockLevel: Number(product.minStockLevel),
        batches: mappedBatches,
        latestBatch: mappedBatches[0] ?? null
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/products', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const {
      itemCode, brand, brandId, name, specification, categoryId, productType,
      unitOfMeasure, sellMode, sellingRate, gstPercentage, warrantyPeriodDays,
      minStockLevel, supplierIds
    } = req.body

    if (!itemCode || !name || !categoryId) {
      return res.status(400).json({ success: false, error: 'ITEM_CODE_NAME_CATEGORY_REQUIRED' })
    }

    const codeCheck = validateItemCode(String(itemCode))
    if (!codeCheck.ok) return fieldError(res, codeCheck)
    const nameCheck = validateName(String(name), 'Product name')
    if (!nameCheck.ok) return fieldError(res, nameCheck)

    const mode = sellMode === 'LENGTH' ? 'LENGTH' : 'UNIT'
    const uom = measuresFor(mode).includes(String(unitOfMeasure))
      ? String(unitOfMeasure)
      : defaultMeasureFor(mode)

    const product = await prisma.$transaction(async (tx) => {
      const resolved = await resolveBrand(tx, { brandId, brand })
      if (resolved.kind === 'not-found') {
        throw Object.assign(new Error('BRAND_NOT_FOUND'), { code: 'BRAND_NOT_FOUND' })
      }
      const brandData = brandFields(resolved) ?? { brandId: null, brand: null }

      const created = await tx.product.create({
        data: {
          itemCode: codeCheck.value,
          ...brandData,
          name: nameCheck.value,
          specification,
          categoryId,
          productType,
          unitOfMeasure: uom,
          sellMode: mode,
          sellingRate: sellingRate ?? 0,
          gstPercentage: gstPercentage ?? 0,
          warrantyPeriodDays: warrantyPeriodDays ?? 0,
          minStockLevel: parseQty(minStockLevel ?? 0, mode),
          suppliers: supplierIds?.length
            ? { create: supplierIds.map((sid: string, i: number) => ({ supplierId: sid, isDefault: i === 0 })) }
            : undefined
        },
        include: { category: true }
      })
      await emitProductUpsert(tx, created.id)
      return created
    })

    return res.status(201).json({
      success: true,
      product: {
        ...product,
        sellingRate: Number(product.sellingRate),
        gstPercentage: Number(product.gstPercentage),
        minStockLevel: Number(product.minStockLevel)
      }
    })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'BRAND_NOT_FOUND') {
      return res.status(400).json({ success: false, error: 'BRAND_NOT_FOUND', message: 'That brand no longer exists.' })
    }
    if (code === 'P2002') {
      return res.status(409).json({ success: false, error: 'ITEM_CODE_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/products/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const {
      itemCode, brand, brandId, name, specification, categoryId, productType,
      unitOfMeasure, sellMode, sellingRate, gstPercentage, warrantyPeriodDays,
      minStockLevel, isActive
    } = req.body

    if (name != null) {
      const nameCheck = validateName(String(name), 'Product name')
      if (!nameCheck.ok) return fieldError(res, nameCheck)
    }

    // The item code is printed on receipts and referenced by stock records, so
    // it freezes once the product has been used. Until then — no batches ever
    // received and no bill lines — it stays editable, which is what you want
    // right after a typo at creation time.
    let nextItemCode: string | undefined
    if (itemCode != null) {
      const current = await prisma.product.findUnique({
        where: { id },
        select: { itemCode: true }
      })
      if (!current) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

      // Validate before comparing. Comparing the *normalised* form first meant
      // a lowercase or space-ridden version of the existing code matched it and
      // slipped through as a no-op, so bad input was quietly accepted rather
      // than answered.
      const codeCheck = validateItemCode(String(itemCode))
      if (!codeCheck.ok) return fieldError(res, codeCheck)

      if (codeCheck.value !== current.itemCode) {
        const [batchCount, billItemCount] = await Promise.all([
          prisma.productBatch.count({ where: { productId: id } }),
          prisma.billItem.count({ where: { productId: id } })
        ])
        if (batchCount > 0 || billItemCount > 0) {
          return res.status(409).json({
            success: false,
            error: 'ITEM_CODE_LOCKED',
            message:
              'This product already has stock or sales history, so its item code can no longer be changed.',
            batchCount,
            billItemCount
          })
        }
        nextItemCode = codeCheck.value
      }
    }

    const mode = sellMode === undefined ? undefined : sellMode === 'LENGTH' ? 'LENGTH' : 'UNIT'

    const product = await prisma.$transaction(async (tx) => {
      const resolved = await resolveBrand(tx, { brandId, brand })
      if (resolved.kind === 'not-found') {
        throw Object.assign(new Error('BRAND_NOT_FOUND'), { code: 'BRAND_NOT_FOUND' })
      }
      const brandData = brandFields(resolved)

      // The mode decides which units are valid, so a switch to LENGTH also
      // moves the unit of measure onto a length unit rather than leaving "pcs".
      const effectiveMode =
        mode ?? (await tx.product.findUnique({ where: { id }, select: { sellMode: true } }))?.sellMode
      const uom =
        unitOfMeasure === undefined
          ? undefined
          : measuresFor(effectiveMode).includes(String(unitOfMeasure))
            ? String(unitOfMeasure)
            : defaultMeasureFor(effectiveMode)

      const updated = await tx.product.update({
        where: { id },
        data: {
          itemCode: nextItemCode,
          ...(brandData ?? {}),
          name, specification, categoryId, productType,
          unitOfMeasure: uom,
          sellMode: mode,
          sellingRate, gstPercentage, warrantyPeriodDays, isActive,
          minStockLevel:
            minStockLevel === undefined ? undefined : parseQty(minStockLevel, effectiveMode)
        },
        include: { category: true }
      })
      await emitProductUpsert(tx, updated.id)
      return updated
    })

    return res.json({
      success: true,
      product: {
        ...product,
        sellingRate: Number(product.sellingRate),
        gstPercentage: Number(product.gstPercentage),
        minStockLevel: Number(product.minStockLevel)
      }
    })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'BRAND_NOT_FOUND') {
      return res.status(400).json({ success: false, error: 'BRAND_NOT_FOUND', message: 'That brand no longer exists.' })
    }
    if (code === 'P2002') {
      return res.status(409).json({ success: false, error: 'ITEM_CODE_EXISTS' })
    }
    if (code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.delete('/api/v1/products/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const hard = req.query.hard === '1' || req.query.hard === 'true'

    if (hard) {
      // A product that never carried stock and never sold has no history worth
      // keeping, so it can genuinely be removed — a mis-typed entry shouldn't
      // sit in the list forever. Anything else stays soft-deleted.
      const [batchCount, billItemCount] = await Promise.all([
        prisma.productBatch.count({ where: { productId: id } }),
        prisma.billItem.count({ where: { productId: id } })
      ])
      if (batchCount > 0 || billItemCount > 0) {
        return res.status(409).json({
          success: false,
          error: 'PRODUCT_IN_USE',
          message:
            'This product has stock or sales history. It can be deactivated, but not deleted.',
          batchCount,
          billItemCount
        })
      }
      await prisma.$transaction(async (tx) => {
        await tx.productSupplier.deleteMany({ where: { productId: id } })
        await tx.product.delete({ where: { id } })
        await recordSync(tx, 'product', id, 'delete', null)
      })
      return res.json({ success: true, deleted: 'permanent' })
    }

    // Soft delete — terminals see this as an upsert with isActive=false rather
    // than a true delete event so historical bills still resolve product names.
    await prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id }, data: { isActive: false } })
      await emitProductUpsert(tx, id)
    })
    return res.json({ success: true, deleted: 'deactivated' })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 2A — Batches ───────────────────────────────────────────────────────

app.get('/api/v1/system/next-batch-code', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const code = await peekNumber('BT')
    return res.json({ success: true, batchCode: code })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/products/:id/batches', requireAuth(), async (req, res) => {
  try {
    const batches = await prisma.productBatch.findMany({
      where: { productId: String(req.params.id) },
      include: { warehouse: true, supplier: true },
      orderBy: { createdAt: 'desc' }
    })
    return res.json({
      success: true,
      batches: batches.map(serializeBatch)
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/products/:id/batches', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: String(req.params.id) } })
    if (!product) return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' })

    const {
      batchCode: rawBatchCode, purchaseRate, receivedQty,
      purchaseGstPct, rateIncludesGst,
      supplierId, warehouseId, receivedDate, notes
    } = req.body

    const qty = parseQty(receivedQty ?? 0, product.sellMode)
    if (!purchaseRate || qty <= 0) {
      return res.status(400).json({ success: false, error: 'PURCHASE_RATE_AND_QTY_REQUIRED' })
    }

    // Supplier invoices quote the rate either before or after tax. Both forms
    // are stored so margin can use the ex-GST cost while the landed cost stays
    // available for stock valuation.
    const cost = computePurchaseCost(
      Number(purchaseRate),
      purchaseGstPct !== undefined ? Number(purchaseGstPct) : Number(product.gstPercentage),
      Boolean(rateIncludesGst)
    )

    const batch = await prisma.$transaction(async (tx) => {
      const batchCode = rawBatchCode?.trim() || (await allocateNumber(tx, 'BT'))
      const uniqueStockCode = `${product.itemCode}/${batchCode}`
      const created = await tx.productBatch.create({
        data: {
          productId: String(req.params.id),
          batchCode,
          uniqueStockCode,
          purchaseRate: cost.rateExGst,
          purchaseGstPct: cost.gstPct,
          purchaseGstAmount: cost.gstAmount,
          purchaseRateInclGst: cost.rateInclGst,
          receivedQty: qty,
          currentQty: qty,
          supplierId: supplierId || null,
          warehouseId: warehouseId || null,
          receivedDate: receivedDate ? new Date(receivedDate) : new Date(),
          notes: notes || null
        },
        include: { warehouse: true, supplier: true }
      })
      // Stock changed — terminals need to see the new totalStock.
      await emitProductUpsert(tx, String(req.params.id))
      return created
    })

    return res.status(201).json({ success: true, batch: serializeBatch(batch) })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'BATCH_CODE_EXISTS_FOR_PRODUCT' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/batches/:batchId', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const {
      purchaseRate, purchaseGstPct, rateIncludesGst,
      notes, isActive, warehouseId, supplierId, receivedDate, receivedQty
    } = req.body

    const batch = await prisma.$transaction(async (tx) => {
      const existing = await tx.productBatch.findUnique({
        where: { id: String(req.params.batchId) },
        include: { product: { select: { gstPercentage: true, sellMode: true } } }
      })
      if (!existing) {
        throw Object.assign(new Error('NOT_FOUND'), { code: 'P2025' })
      }

      const data: Record<string, unknown> = {
        notes,
        isActive,
        warehouseId,
        supplierId: supplierId || null,
        receivedDate: receivedDate ? new Date(receivedDate) : undefined
      }

      if (purchaseRate !== undefined) {
        const cost = computePurchaseCost(
          Number(purchaseRate),
          purchaseGstPct !== undefined
            ? Number(purchaseGstPct)
            : Number(existing.purchaseGstPct) || Number(existing.product.gstPercentage),
          Boolean(rateIncludesGst)
        )
        data.purchaseRate = cost.rateExGst
        data.purchaseGstPct = cost.gstPct
        data.purchaseGstAmount = cost.gstAmount
        data.purchaseRateInclGst = cost.rateInclGst
      }

      if (receivedQty !== undefined) {
        // Correcting the received quantity must not silently rewrite how much
        // has already been sold, so shift what's left by the same delta.
        const nextReceived = parseQty(receivedQty, existing.product.sellMode)
        const delta = roundQty(nextReceived - Number(existing.receivedQty))
        data.receivedQty = nextReceived
        data.currentQty = Math.max(0, roundQty(Number(existing.currentQty) + delta))
      }

      const updated = await tx.productBatch.update({
        where: { id: String(req.params.batchId) },
        data,
        include: { warehouse: true, supplier: true }
      })
      // isActive or receivedQty changes affect totalStock the terminal sees.
      await emitProductUpsert(tx, updated.productId)
      return updated
    })
    return res.json({ success: true, batch: serializeBatch(batch) })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 3 — Customers ──────────────────────────────────────────────────────

/** Sums outstanding for many customers in one query. */
async function outstandingByCustomer(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.bill.groupBy({
    by: ['customerId'],
    where: { customerId: { in: ids }, status: { in: [...UNSETTLED_STATUSES] } },
    _sum: { balanceDue: true }
  })
  return new Map(
    rows
      .filter((r) => r.customerId)
      .map((r) => [r.customerId as string, round2(Number(r._sum.balanceDue ?? 0))])
  )
}

app.get('/api/v1/customers', requireAuth(), async (req, res) => {
  try {
    const { search, limit, offset, autocomplete } = req.query

    // Autocomplete mode (billing screen): ?search=x&autocomplete=1 — active only, no pagination
    if (autocomplete === '1') {
      const customers = await prisma.customer.findMany({
        where: {
          isActive: true,
          ...(search ? {
            OR: [
              { name: { contains: String(search), mode: 'insensitive' } },
              { phone: { contains: String(search) } }
            ]
          } : {})
        },
        orderBy: { name: 'asc' },
        take: 20
      })
      // The terminal needs the balance to decide whether credit is available.
      const owed = await outstandingByCustomer(customers.map((c) => c.id))
      return res.json({
        success: true,
        customers: customers.map((c) => ({
          ...c,
          creditLimit: Number(c.creditLimit),
          outstanding: owed.get(c.id) ?? 0
        })),
        total: customers.length
      })
    }

    // Full list mode (customers screen): all customers, paginated, optional search
    const take = parseInt(String(limit || '50'))
    const skip = parseInt(String(offset || '0'))
    const where = search ? {
      OR: [
        { name: { contains: String(search), mode: 'insensitive' as const } },
        { phone: { contains: String(search) } }
      ]
    } : {}
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        take,
        skip,
        include: { _count: { select: { bills: true } } }
      }),
      prisma.customer.count({ where })
    ])
    const owed = await outstandingByCustomer(customers.map((c) => c.id))
    return res.json({
      success: true,
      customers: customers.map((c) => ({
        ...c,
        creditLimit: Number(c.creditLimit),
        outstanding: owed.get(c.id) ?? 0
      })),
      total
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/customers/:id', requireAuth(), async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: String(req.params.id) },
      include: {
        bills: {
          orderBy: { paidAt: 'desc' },
          take: 10,
          select: {
            id: true, billNumber: true, totalAmount: true,
            paymentMethod: true, status: true, paidAt: true,
            _count: { select: { items: true } }
          }
        }
      }
    })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    return res.json({
      success: true,
      customer: {
        ...customer,
        bills: customer.bills.map((b) => ({ ...b, totalAmount: Number(b.totalAmount) }))
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/customers', requireAuth(), async (req, res) => {
  try {
    const { name, phone, email, address, gstin, creditLimit, creditDays } = req.body

    const nameCheck = validateName(String(name ?? ''), 'Customer name')
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const phoneCheck = validateMobile(String(phone ?? ''))
    if (!phoneCheck.ok) return fieldError(res, phoneCheck)
    const emailCheck = validateEmail(String(email ?? ''))
    if (!emailCheck.ok) return fieldError(res, emailCheck)
    const gstCheck = validateGstin(String(gstin ?? ''))
    if (!gstCheck.ok) return fieldError(res, gstCheck)

    const customer = await prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          name: nameCheck.value,
          phone: phoneCheck.value,
          email: emailCheck.value || null,
          address: address ? String(address).trim() : null,
          gstin: gstCheck.value || null,
          // Only a super-admin decides how much credit a customer gets.
          ...(req.user!.role === 'SUPER_ADMIN'
            ? {
                creditLimit: Math.max(0, round2(Number(creditLimit) || 0)),
                creditDays: Math.max(0, Math.floor(Number(creditDays) || 0))
              }
            : {})
        }
      })
      await emitCustomerUpsert(tx, created.id)
      return created
    })
    return res.status(201).json({ success: true, customer })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'PHONE_ALREADY_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/customers/:id', requireAuth(), async (req, res) => {
  try {
    const { name, phone, email, address, gstin, isActive, creditLimit, creditDays } = req.body
    // Build data with only the fields that were explicitly sent
    const data: Record<string, unknown> = {}
    if (name !== undefined) {
      const c = validateName(String(name), 'Customer name')
      if (!c.ok) return fieldError(res, c)
      data.name = c.value
    }
    if (phone !== undefined) {
      const c = validateMobile(String(phone))
      if (!c.ok) return fieldError(res, c)
      data.phone = c.value
    }
    if (email !== undefined) {
      const c = validateEmail(String(email ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.email = c.value || null
    }
    if (gstin !== undefined) {
      const c = validateGstin(String(gstin ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.gstin = c.value || null
    }
    if (address !== undefined) data.address = address ? String(address).trim() : null
    if (isActive !== undefined) data.isActive = isActive
    // Credit terms are the shop owner's call, not a cashier's.
    if (req.user!.role === 'SUPER_ADMIN') {
      if (creditLimit !== undefined) data.creditLimit = Math.max(0, round2(Number(creditLimit) || 0))
      if (creditDays !== undefined) data.creditDays = Math.max(0, Math.floor(Number(creditDays) || 0))
    } else if (creditLimit !== undefined || creditDays !== undefined) {
      return res.status(403).json({
        success: false, error: 'CREDIT_TERMS_FORBIDDEN',
        message: 'Only a super admin can change credit terms.'
      })
    }
    const customer = await prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: String(req.params.id) },
        data
      })
      await emitCustomerUpsert(tx, updated.id)
      return updated
    })
    return res.json({ success: true, customer })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'P2025') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (code === 'P2002') return res.status(409).json({ success: false, error: 'PHONE_ALREADY_EXISTS' })
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 3 — Bills ──────────────────────────────────────────────────────────



app.get('/api/v1/system/next-bill-number', requireAuth(), async (_req, res) => {
  try {
    return res.json({ success: true, billNumber: await peekNumber('INV') })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/bills', requireAuth(), async (req, res) => {
  try {
    const { status, search } = req.query
    // One filter object for both the page and the count — they previously
    // diverged, so paging through search results ran off the end.
    const where = {
      status: status ? String(status) : undefined,
      OR: search
        ? [
            { billNumber: { contains: String(search), mode: 'insensitive' as const } },
            { customer: { name: { contains: String(search), mode: 'insensitive' as const } } }
          ]
        : undefined
    }
    const bills = await prisma.bill.findMany({
      where,
      include: {
        customer: { select: { name: true, phone: true } },
        cashier: { select: { username: true } },
        originDevice: { select: { friendlyName: true } },
        _count: { select: { items: true } }
      },
      orderBy: { createdAt: 'desc' },
      ...pageArgs(req.query)
    })
    const total = await prisma.bill.count({ where })
    return res.json({ success: true, bills: bills.map(serializeBill), total })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/bills/:id', requireAuth(), async (req, res) => {
  try {
    const bill = await prisma.bill.findUnique({
      where: { id: String(req.params.id) },
      include: {
        customer: true,
        cashier: { select: { username: true } },
        originDevice: { select: { friendlyName: true } },
        originalBill: { select: { id: true, billNumber: true, status: true } },
        returns: {
          select: {
            id: true, billNumber: true, status: true, totalAmount: true,
            paidAt: true, returnReason: true, returnReasonCode: true,
            items: { select: { originalBillItemId: true, quantity: true } }
          },
          orderBy: { createdAt: 'asc' }
        },
        items: {
          include: {
            batchAllocations: { select: { quantity: true, unitCost: true } },
            product: {
              select: {
                itemCode: true, name: true,
                // A returns screen has to know whether this line is cut to
                // length: half a metre of pipe comes back as 0.5, not 0.
                sellMode: true,
                batches: {
                  where: { isActive: true },
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { purchaseRate: true }
                }
              }
            }
          }
        }
      }
    })
    if (!bill) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    // For PAID bills, compute already-returned qty per line so the UI can
    // show what's still refundable without an extra round trip.
    const returnedByLineId = new Map<string, number>()
    for (const r of bill.returns) {
      for (const it of r.items) {
        if (!it.originalBillItemId) continue
        returnedByLineId.set(
          it.originalBillItemId,
          roundQty((returnedByLineId.get(it.originalBillItemId) ?? 0) + Number(it.quantity))
        )
      }
    }

    return res.json({
      success: true,
      bill: {
        ...serializeBill(bill),
        returns: bill.returns.map((r) => ({
          id: r.id,
          billNumber: r.billNumber,
          status: r.status,
          totalAmount: Number(r.totalAmount),
          paidAt: r.paidAt,
          returnReason: r.returnReason,
          returnReasonCode: r.returnReasonCode
        })),
        items: bill.items.map((it) => ({
          ...serializeBillItem(it),
          // Cost of the exact units sold, where we recorded it; older bills
          // fall back to the latest purchase rate.
          purchaseRate:
            it.batchAllocations.length > 0 && Number(it.quantity) > 0
              ? round2(
                  it.batchAllocations.reduce((s2, a) => s2 + Number(a.quantity) * Number(a.unitCost), 0) /
                    Number(it.quantity)
                )
              : it.product.batches[0]
                ? Number(it.product.batches[0].purchaseRate)
                : null,
          sellMode: it.product.sellMode,
          alreadyReturnedQty: returnedByLineId.get(it.id) ?? 0
        }))
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})


app.post('/api/v1/bills', requireActiveLicense(), requireAuth(), async (req, res) => {
  try {
    const {
      customerId, originDeviceId, items, discountAmount = 0,
      amountReceived, notes, clientLocalId
    } = req.body

    if (!originDeviceId) {
      return res.status(400).json({ success: false, error: 'ORIGIN_DEVICE_REQUIRED' })
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'BILL_ITEMS_REQUIRED' })
    }

    // Idempotency: if this clientLocalId was already processed, return the
    // existing bill. This lookup catches the ordinary case — a retry after a
    // response went missing. It cannot catch two genuinely simultaneous
    // submits, which both miss it; the unique constraint stops those, and the
    // handler below turns the resulting clash back into the same answer.
    if (clientLocalId) {
      const existing = await prisma.bill.findUnique({
        where: { clientLocalId: String(clientLocalId) },
        include: { customer: { select: { name: true } }, items: true }
      })
      if (existing) {
        return res.status(200).json({ success: true, bill: serializeBill(existing) })
      }
    }

    // Phase 3D: terminals mint their own globally-unique bill numbers
    // (e.g. "T1-00042") so they can keep working offline. Trust the client's
    // value if provided — uniqueness is enforced by the DB constraint.
    const clientBillNumber = req.body.billNumber
    const billNumber =
      typeof clientBillNumber === 'string' && clientBillNumber.trim()
        ? clientBillNumber.trim()
        : undefined
    const cashierId = req.user!.userId

    // The tender total is only known after the lines are priced, so the split
    // is read here and validated against the computed total inside the tx.
    const tender = readTenders(req.body)
    if ('error' in tender) {
      return res.status(400).json({ success: false, error: tender.error })
    }

    const bill = await prisma.$transaction((tx) => createBillCore(tx, {
      items: items as IncomingSaleItem[],
      customerId: customerId || null,
      originDeviceId,
      cashierId,
      paymentMethod: tender.method,
      amountReceived: amountReceived != null ? Number(amountReceived) : null,
      tenders: tender.tenders,
      settleInFull: tender.settleInFull,
      // Only a super-admin can put a customer past their credit limit, or
      // bill a line at something other than the catalogue price.
      allowCreditOverride:
        req.user!.role === 'SUPER_ADMIN' && Boolean(req.body.allowCreditOverride),
      allowPriceOverride:
        req.user!.role === 'SUPER_ADMIN' && Boolean(req.body.allowPriceOverride),
      discountAmount: Number(discountAmount),
      notes: notes || null,
      clientLocalId: clientLocalId ? String(clientLocalId) : null,
      soldAt: resolveSoldAt(req.body.soldAt)
    }, billNumber))

    return res.status(201).json({ success: true, bill: serializeBill(bill) })
  } catch (err: unknown) {
    // Two submits of the same sale raced past the lookup above and one lost
    // the unique constraint. The loser did not create anything, so the right
    // answer is the bill the winner made — not an error that would tempt a
    // cashier into ringing the sale up a second time.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002' &&
      String((err.meta as { target?: string | string[] } | undefined)?.target ?? '').includes(
        'clientLocalId'
      ) &&
      req.body?.clientLocalId
    ) {
      const winner = await prisma.bill.findUnique({
        where: { clientLocalId: String(req.body.clientLocalId) },
        include: { customer: { select: { name: true } }, items: true }
      })
      if (winner) {
        return res.status(200).json({ success: true, bill: serializeBill(winner) })
      }
    }
    const e = err as {
      code?: string; productName?: string; available?: number; requested?: number
      reason?: string; customerName?: string; creditLimit?: number
      currentOutstanding?: number; newBalance?: number; projectedOutstanding?: number
      overBy?: number; needsOverride?: boolean
      catalogueRate?: number; requestedRate?: number
      maxPercent?: number; maxAmount?: number
    }
    if (e.code === 'CREDIT_NOT_ALLOWED') {
      const messages: Record<string, string> = {
        NO_CUSTOMER: 'Select a customer before leaving a balance on a bill.',
        NO_CREDIT_ALLOWED: 'This customer has no credit limit set.',
        LIMIT_EXCEEDED: 'This would put the customer over their credit limit.'
      }
      return res.status(409).json({
        success: false,
        error: 'CREDIT_NOT_ALLOWED',
        message: messages[String(e.reason)] ?? 'Credit is not available for this bill.',
        reason: e.reason,
        customerName: e.customerName,
        creditLimit: e.creditLimit,
        currentOutstanding: e.currentOutstanding,
        newBalance: e.newBalance,
        projectedOutstanding: e.projectedOutstanding,
        overBy: e.overBy,
        needsOverride: e.needsOverride
      })
    }
    if (e.code === 'PRICE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        success: false,
        error: 'PRICE_OVERRIDE_NOT_ALLOWED',
        message: `"${e.productName}" is priced at ₹${e.catalogueRate}. A manager must authorise a different price.`,
        productName: e.productName,
        catalogueRate: e.catalogueRate,
        requestedRate: e.requestedRate,
        needsOverride: true
      })
    }
    if (e.code === 'INVALID_LINE_DISCOUNT') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_LINE_DISCOUNT',
        message: `That discount on "${e.productName}" is outside what a bill may carry.`,
        productName: e.productName,
        maxPercent: e.maxPercent,
        maxAmount: e.maxAmount
      })
    }
    if (e.code === 'PRODUCT_INACTIVE') {
      return res.status(409).json({
        success: false,
        error: 'PRODUCT_INACTIVE',
        message: `"${e.productName}" is no longer sold.`,
        productName: e.productName
      })
    }
    if (e.code === 'INVALID_QUANTITY') {
      return res.status(400).json({
        success: false, error: 'INVALID_QUANTITY',
        message: `Enter a quantity for "${e.productName}".`, productName: e.productName
      })
    }
    if (e.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({
        success: false,
        error: 'INSUFFICIENT_STOCK',
        productName: e.productName,
        available: e.available,
        requested: e.requested
      })
    }
    if (e.code === 'PRODUCT_NOT_FOUND') {
      return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// Process a partial or full return against an existing PAID bill. Creates a
// new Bill row with status=RETURN whose amounts are positive values
// representing the refund. Restocks each returned item to the most-recently-
// received active batch of that product (mirroring the void semantics).
//
// Body:
//   {
//     items: [{ billItemId: string, quantity: number }],
//     reason?: string,
//     originDeviceId?: string  // optional, falls back to the original bill's device
//   }
// A cashier can process a return at the counter — that is the whole point of
// having one — but voiding a bill outright stays with a super admin.
app.post('/api/v1/bills/:id/return', requireActiveLicense(), requireAuth(), async (req, res) => {
  try {
    const billId = String(req.params.id)
    const { items, reason, originDeviceId } = req.body as {
      items?: { billItemId: string; quantity: number }[]
      reason?: string
      originDeviceId?: string
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'RETURN_ITEMS_REQUIRED' })
    }

    const original = await prisma.bill.findUnique({ where: { id: billId } })
    if (!original) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const reasonCode = req.body?.reasonCode
    if (reasonCode != null && !isReturnReasonCode(reasonCode)) {
      return res.status(400).json({
        success: false, error: 'INVALID_RETURN_REASON',
        message: 'Pick one of the listed return reasons.'
      })
    }

    const result = await prisma.$transaction((tx) => processReturnCore(tx, {
      originalBillId: billId,
      returnItems: items,
      reason: reason || null,
      reasonCode: reasonCode ?? null,
      cashierId: req.user!.userId,
      originDeviceId: originDeviceId || original.originDeviceId
    }))

    return res.status(201).json({ success: true, bill: serializeBill(result) })
  } catch (err: unknown) {
    const e = err as { code?: string; currentStatus?: string; billItemId?: string; requested?: number; remaining?: number }
    if (e.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (e.code === 'ORIGINAL_NOT_PAID') return res.status(409).json({ success: false, error: 'ORIGINAL_NOT_PAID', currentStatus: e.currentStatus })
    if (e.code === 'BILL_ITEM_NOT_IN_ORIGINAL') return res.status(400).json({ success: false, error: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId: e.billItemId })
    if (e.code === 'INVALID_RETURN_LINE') return res.status(400).json({ success: false, error: 'INVALID_RETURN_LINE' })
    if (e.code === 'NO_RETURN_LINES') return res.status(400).json({ success: false, error: 'RETURN_ITEMS_REQUIRED' })
    if (e.code === 'RETURN_QTY_EXCEEDS_REMAINING') {
      return res.status(409).json({ success: false, error: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId: e.billItemId, requested: e.requested, remaining: e.remaining })
    }
    console.error('Error in /bills/:id/return:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// Atomic exchange: refund selected line(s) from an original PAID bill AND
// create a new PAID sale with the replacement product(s) — both inside a
// single DB transaction. Net difference (cash to collect/refund) is computed
// and returned.
//
// Body:
//   {
//     returnItems: [{ billItemId, quantity }],
//     replacementItems: [{ productId, quantity, unitRate?, gstPercentage?, lineDiscountPct?, lineDiscountAmt? }],
//     reason?: string,
//     paymentMethod?: 'CASH' | 'UPI' | 'CARD',  // for the new sale; defaults to original
//     amountReceived?: number,
//     originDeviceId?: string
//   }
app.post('/api/v1/bills/:id/exchange', requireActiveLicense(), requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const originalBillId = String(req.params.id)
    const {
      returnItems, replacementItems, reason,
      paymentMethod, amountReceived, originDeviceId
    } = req.body as {
      returnItems?: { billItemId: string; quantity: number }[]
      replacementItems?: Partial<IncomingSaleItem>[]
      reason?: string
      paymentMethod?: 'CASH' | 'UPI' | 'CARD'
      amountReceived?: number
      originDeviceId?: string
    }

    if (!returnItems || returnItems.length === 0) {
      return res.status(400).json({ success: false, error: 'RETURN_ITEMS_REQUIRED' })
    }
    if (!replacementItems || replacementItems.length === 0) {
      return res.status(400).json({ success: false, error: 'REPLACEMENT_ITEMS_REQUIRED' })
    }

    const original = await prisma.bill.findUnique({ where: { id: originalBillId } })
    if (!original) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    // Resolve replacement defaults from product master so the client can pass
    // just productId+quantity if it wants to use the catalog price.
    const productIds = replacementItems.map((r) => String(r.productId))
    const products = await prisma.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, sellingRate: true, gstPercentage: true, sellMode: true }
    })
    const productMap = new Map(products.map((p) => [p.id, p]))

    const resolvedReplacements: IncomingSaleItem[] = replacementItems.map((r) => {
      const p = productMap.get(String(r.productId))
      if (!p) {
        throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })
      }
      return {
        productId: String(r.productId),
        quantity: parseQty(Number(r.quantity) || 0, p.sellMode),
        unitRate: r.unitRate != null ? Number(r.unitRate) : Number(p.sellingRate),
        gstPercentage: r.gstPercentage != null ? Number(r.gstPercentage) : Number(p.gstPercentage),
        lineDiscountPct: r.lineDiscountPct != null ? Number(r.lineDiscountPct) : 0,
        lineDiscountAmt: r.lineDiscountAmt != null ? Number(r.lineDiscountAmt) : 0
      }
    })

    const cashierId = req.user!.userId
    const deviceId = originDeviceId || original.originDeviceId
    const pm = paymentMethod || (original.paymentMethod as 'CASH' | 'UPI' | 'CARD')

    const { refundBill, replacementBill } = await prisma.$transaction(async (tx) => {
      const refund = await processReturnCore(tx, {
        originalBillId,
        returnItems,
        reason: reason ? `Exchange: ${reason}` : 'Exchange',
        reasonCode: isReturnReasonCode(req.body?.reasonCode) ? req.body.reasonCode : null,
        cashierId,
        originDeviceId: deviceId
      })

      const replacement = await createBillCore(tx, {
        items: resolvedReplacements,
        customerId: original.customerId,
        originDeviceId: deviceId,
        cashierId,
        paymentMethod: pm,
        amountReceived: amountReceived != null ? Number(amountReceived) : null,
        // The refund settles the replacement; only the difference changes
        // hands, so the replacement is never left carrying a balance.
        tenders:
          // Only the difference changes hands. Anything the customer pays on
          // top of the refund is the real tender.
          amountReceived != null && Number(amountReceived) > 0
            ? [{ method: pm, amount: round2(Number(amountReceived)) }]
            : [],
        creditApplied: Number(refund.totalAmount),
        allowCreditOverride: true,
        // The replacement rate is resolved from the product master above.
        allowPriceOverride: true,
        discountAmount: 0,
        notes: `Exchange for ${original.billNumber} (refund ${refund.billNumber})`,
        clientLocalId: null
      })

      return { refundBill: refund, replacementBill: replacement }
    })

    const refundTotal = Number(refundBill.totalAmount)
    const replacementTotal = Number(replacementBill.totalAmount)
    // Positive = customer pays the difference; negative = customer receives it.
    const netDifference = replacementTotal - refundTotal

    return res.status(201).json({
      success: true,
      refundBill: serializeBill(refundBill),
      replacementBill: serializeBill(replacementBill),
      netDifference
    })
  } catch (err: unknown) {
    const e = err as {
      code?: string; currentStatus?: string; billItemId?: string; requested?: number
      remaining?: number; productName?: string; available?: number
      reason?: string; customerName?: string; creditLimit?: number
      currentOutstanding?: number; newBalance?: number; projectedOutstanding?: number
      overBy?: number; needsOverride?: boolean
      catalogueRate?: number; requestedRate?: number
      maxPercent?: number; maxAmount?: number
    }
    if (e.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (e.code === 'ORIGINAL_NOT_PAID') return res.status(409).json({ success: false, error: 'ORIGINAL_NOT_PAID', currentStatus: e.currentStatus })
    if (e.code === 'BILL_ITEM_NOT_IN_ORIGINAL') return res.status(400).json({ success: false, error: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId: e.billItemId })
    if (e.code === 'INVALID_RETURN_LINE') return res.status(400).json({ success: false, error: 'INVALID_RETURN_LINE' })
    if (e.code === 'NO_RETURN_LINES') return res.status(400).json({ success: false, error: 'RETURN_ITEMS_REQUIRED' })
    if (e.code === 'RETURN_QTY_EXCEEDS_REMAINING') {
      return res.status(409).json({ success: false, error: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId: e.billItemId, requested: e.requested, remaining: e.remaining })
    }
    if (e.code === 'CREDIT_NOT_ALLOWED') {
      const messages: Record<string, string> = {
        NO_CUSTOMER: 'Select a customer before leaving a balance on a bill.',
        NO_CREDIT_ALLOWED: 'This customer has no credit limit set.',
        LIMIT_EXCEEDED: 'This would put the customer over their credit limit.'
      }
      return res.status(409).json({
        success: false,
        error: 'CREDIT_NOT_ALLOWED',
        message: messages[String(e.reason)] ?? 'Credit is not available for this bill.',
        reason: e.reason,
        customerName: e.customerName,
        creditLimit: e.creditLimit,
        currentOutstanding: e.currentOutstanding,
        newBalance: e.newBalance,
        projectedOutstanding: e.projectedOutstanding,
        overBy: e.overBy,
        needsOverride: e.needsOverride
      })
    }
    if (e.code === 'PRICE_OVERRIDE_NOT_ALLOWED') {
      return res.status(403).json({
        success: false,
        error: 'PRICE_OVERRIDE_NOT_ALLOWED',
        message: `"${e.productName}" is priced at ₹${e.catalogueRate}. A manager must authorise a different price.`,
        productName: e.productName,
        catalogueRate: e.catalogueRate,
        requestedRate: e.requestedRate,
        needsOverride: true
      })
    }
    if (e.code === 'INVALID_LINE_DISCOUNT') {
      return res.status(400).json({
        success: false,
        error: 'INVALID_LINE_DISCOUNT',
        message: `That discount on "${e.productName}" is outside what a bill may carry.`,
        productName: e.productName,
        maxPercent: e.maxPercent,
        maxAmount: e.maxAmount
      })
    }
    if (e.code === 'PRODUCT_INACTIVE') {
      return res.status(409).json({
        success: false,
        error: 'PRODUCT_INACTIVE',
        message: `"${e.productName}" is no longer sold.`,
        productName: e.productName
      })
    }
    if (e.code === 'INVALID_QUANTITY') {
      return res.status(400).json({
        success: false, error: 'INVALID_QUANTITY',
        message: `Enter a quantity for "${e.productName}".`, productName: e.productName
      })
    }
    if (e.code === 'INSUFFICIENT_STOCK') {
      return res.status(409).json({ success: false, error: 'INSUFFICIENT_STOCK', productName: e.productName, available: e.available, requested: e.requested })
    }
    if (e.code === 'PRODUCT_NOT_FOUND') return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' })
    console.error('Error in /bills/:id/exchange:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/bills/:id/void', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const billId = String(req.params.id)

    // Every check runs inside the transaction, behind the lock that enforces
    // it. Read outside, two concurrent voids both passed and both restocked.
    await prisma.$transaction(async (tx) => {
      await lockBill(tx, billId)

      const bill = await tx.bill.findUnique({
        where: { id: billId },
        include: { items: true }
      })
      if (!bill) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      if (bill.status === 'VOID') throw Object.assign(new Error('ALREADY_VOID'), { code: 'ALREADY_VOID' })
      if (bill.status === 'RETURN') {
        throw Object.assign(new Error('CANNOT_VOID_RETURN'), { code: 'CANNOT_VOID_RETURN' })
      }

      // Money collected after the sale cannot be un-collected by voiding the
      // bill it was paid against — that would leave the cash drawer unexplained.
      const settlements = await tx.payment.count({ where: { billId, isSettlement: true } })
      if (settlements > 0) {
        throw Object.assign(new Error('BILL_HAS_SETTLEMENTS'), {
          code: 'BILL_HAS_SETTLEMENTS', settlements
        })
      }
      // If any item has been returned, restocking on void would double-count.
      const returnsExist = await tx.bill.count({ where: { originalBillId: billId, status: 'RETURN' } })
      if (returnsExist > 0) {
        throw Object.assign(new Error('BILL_HAS_RETURNS'), { code: 'BILL_HAS_RETURNS' })
      }

      // Put every unit back exactly where the sale took it from.
      for (const item of bill.items) {
        const plan = await planRestock(tx, item.id, item.productId, Number(item.quantity))
        for (const put of plan) {
          await tx.productBatch.update({
            where: { id: put.batchId },
            data: { currentQty: { increment: put.quantity } }
          })
        }
      }

      // A voided sale never happened: its cover and its tender go with it.
      // Leaving them behind showed live warranties on a cancelled sale and
      // counted the tender in the payments ledger.
      await tx.warranty.deleteMany({ where: { billId } })
      await tx.payment.deleteMany({ where: { billId, isSettlement: false } })

      const voided = await tx.bill.update({
        where: { id: billId },
        data: { status: 'VOID', balanceDue: 0, paidAmount: 0 }
      })
      await emitBillUpsert(tx, voided)
      await emitProductUpsertBulk(tx, bill.items.map((it) => it.productId))
    })

    return res.json({ success: true })
  } catch (err: unknown) {
    const e = err as { code?: string; settlements?: number }
    const map: Record<string, [number, string]> = {
      NOT_FOUND: [404, 'No such bill.'],
      ALREADY_VOID: [409, 'This bill has already been voided.'],
      CANNOT_VOID_RETURN: [409, 'A credit note cannot be voided.'],
      BILL_HAS_SETTLEMENTS: [409, 'Payments have been collected against this bill. Refund them before voiding it.'],
      BILL_HAS_RETURNS: [409, 'Goods have been returned against this bill, so it cannot be voided.']
    }
    if (e.code && map[e.code]) {
      const [status, message] = map[e.code]
      return res.status(status).json({ success: false, error: e.code, message, ...e })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Analytics Summary ─────────────────────────────────────────────────────────

// ─── Phase 3B — Payments, receivables and follow-ups ──────────────────────────

/**
 * Records money collected against a customer's outstanding bills.
 *
 * Allocation defaults to oldest bill first, which is how a shop actually
 * settles an account. Callers can override it by naming bills explicitly.
 * It all runs in one transaction so a part-allocated payment can never be
 * left stranded.
 */
app.post('/api/v1/payments', requireActiveLicense(), requireAuth(), async (req, res) => {
  try {
    const { customerId, amount, method, reference, note, allocations, clientLocalId } = req.body

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_REQUIRED' })
    }
    if (!isPaymentMethod(method)) {
      return res.status(400).json({ success: false, error: 'INVALID_PAYMENT_METHOD' })
    }
    const total = round2(Number(amount))
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        success: false, error: 'INVALID_PAYMENT_AMOUNT',
        message: 'Enter an amount greater than zero.'
      })
    }

    if (clientLocalId) {
      const existing = await prisma.payment.findUnique({
        where: { clientLocalId: String(clientLocalId) }
      })
      if (existing) {
        return res.status(200).json({
          success: true, payments: [serializePayment(existing)], replayed: true
        })
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: String(customerId) } })
      if (!customer) throw Object.assign(new Error('CUSTOMER_NOT_FOUND'), { code: 'CUSTOMER_NOT_FOUND' })

      const openBills = await tx.bill.findMany({
        where: { customerId: customer.id, status: { in: [...UNSETTLED_STATUSES] } },
        orderBy: { paidAt: 'asc' }
      })
      if (openBills.length === 0) {
        throw Object.assign(new Error('NOTHING_OUTSTANDING'), { code: 'NOTHING_OUTSTANDING' })
      }

      // Either honour the caller's allocation, or work forward from the oldest
      // bill taking as much as each one still needs.
      const plan: { billId: string; amount: number }[] = []
      if (Array.isArray(allocations) && allocations.length > 0) {
        for (const a of allocations) {
          const billId = String((a as { billId?: unknown }).billId ?? '')
          const amt = round2(Number((a as { amount?: unknown }).amount))
          const bill = openBills.find((b) => b.id === billId)
          if (!bill) {
            throw Object.assign(new Error('BILL_NOT_OUTSTANDING'), { code: 'BILL_NOT_OUTSTANDING', billId })
          }
          if (!Number.isFinite(amt) || amt <= 0) {
            throw Object.assign(new Error('INVALID_ALLOCATION'), { code: 'INVALID_ALLOCATION', billId })
          }
          // balanceDue is kept in step by recomputeBillSettlement, so it
          // already accounts for any credit notes against this bill.
          if (amt > round2(Number(bill.balanceDue))) {
            throw Object.assign(new Error('ALLOCATION_EXCEEDS_BALANCE'), {
              code: 'ALLOCATION_EXCEEDS_BALANCE', billId,
              balanceDue: round2(Number(bill.balanceDue)), requested: amt
            })
          }
          plan.push({ billId, amount: amt })
        }
        const planned = round2(plan.reduce((s, x) => s + x.amount, 0))
        if (planned !== total) {
          throw Object.assign(new Error('ALLOCATION_MISMATCH'), {
            code: 'ALLOCATION_MISMATCH', allocated: planned, amount: total
          })
        }
      } else {
        let left = total
        for (const bill of openBills) {
          if (left <= 0) break
          const due = round2(Number(bill.balanceDue))
          const take = round2(Math.min(due, left))
          if (take <= 0) continue
          plan.push({ billId: bill.id, amount: take })
          left = round2(left - take)
        }
        if (left > 0) {
          // Refusing beats parking money the shop cannot account for.
          throw Object.assign(new Error('AMOUNT_EXCEEDS_OUTSTANDING'), {
            code: 'AMOUNT_EXCEEDS_OUTSTANDING',
            outstanding: round2(total - left), amount: total, excess: left
          })
        }
      }

      // Lock every bill this collection touches, oldest first, before any of
      // it is applied. A consistent order means two concurrent collections
      // for the same customer queue rather than deadlock.
      for (const alloc of [...plan].sort((a, b) => a.billId.localeCompare(b.billId))) {
        await lockBill(tx, alloc.billId)
      }

      // Re-check every allocation against the balance as it stands now that
      // the rows are locked. The plan was built from a read taken before the
      // lock, and a concurrent collection may have settled some of it since.
      for (const alloc of plan) {
        const fresh = await tx.bill.findUniqueOrThrow({ where: { id: alloc.billId } })
        if (alloc.amount > round2(Number(fresh.balanceDue))) {
          throw Object.assign(new Error('ALLOCATION_EXCEEDS_BALANCE'), {
            code: 'ALLOCATION_EXCEEDS_BALANCE',
            billId: alloc.billId,
            balanceDue: round2(Number(fresh.balanceDue)),
            requested: alloc.amount
          })
        }
      }

      const created: unknown[] = []
      for (const [i, alloc] of plan.entries()) {
        const bill = await tx.bill.findUniqueOrThrow({ where: { id: alloc.billId } })
        const payment = await tx.payment.create({
          data: {
            billId: bill.id,
            customerId: customer.id,
            amount: alloc.amount,
            method,
            reference: reference ? String(reference).trim() : null,
            isSettlement: true,
            collectedById: req.user!.userId,
            note: note ? String(note).trim() : null,
            // Only the first row carries the key — the rest belong to the same
            // collection and are covered by this transaction.
            clientLocalId: i === 0 && clientLocalId ? String(clientLocalId) : null
          },
          include: { bill: { select: { billNumber: true, totalAmount: true } } }
        })

        // Settlement is recomputed from the rows that exist — payments and
        // credit notes — rather than derived here from the bill total. Doing
        // the arithmetic in two places meant this one forgot about returns,
        // so a customer who returned goods and then paid what they owed had
        // the value of the credit note reappear as a debt.
        await recomputeBillSettlement(tx, bill.id)
        const updated = await tx.bill.findUniqueOrThrow({
          where: { id: bill.id },
          include: { customer: { select: { name: true } }, items: true }
        })
        await emitBillUpsert(tx, updated)
        created.push(payment)
      }

      const outstanding = await outstandingFor(tx, customer.id)
      await emitCustomerUpsert(tx, customer.id)
      return { payments: created, outstanding }
    })

    return res.status(201).json({
      success: true,
      payments: result.payments.map(serializePayment),
      outstanding: result.outstanding
    })
  } catch (err: unknown) {
    const e = err as { code?: string }
    const map: Record<string, [number, string]> = {
      CUSTOMER_NOT_FOUND: [404, 'No such customer.'],
      NOTHING_OUTSTANDING: [409, 'This customer has nothing outstanding.'],
      BILL_NOT_OUTSTANDING: [409, 'That bill has no balance left to settle.'],
      INVALID_ALLOCATION: [400, 'Each allocation needs an amount greater than zero.'],
      ALLOCATION_EXCEEDS_BALANCE: [409, 'That is more than the bill still owes.'],
      ALLOCATION_MISMATCH: [400, 'The allocations do not add up to the amount collected.'],
      AMOUNT_EXCEEDS_OUTSTANDING: [409, 'That is more than this customer owes.']
    }
    if (e.code && map[e.code]) {
      const [status, message] = map[e.code]
      return res.status(status).json({ success: false, message, ...e, error: e.code })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/payments', requireAuth(), async (req, res) => {
  try {
    const { customerId, billId } = req.query
    const where = {
      customerId: customerId ? String(customerId) : undefined,
      billId: billId ? String(billId) : undefined
    }
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          bill: { select: { billNumber: true, totalAmount: true, status: true } },
          customer: { select: { name: true, phone: true } },
          collectedBy: { select: { username: true } }
        },
        orderBy: { receivedAt: 'desc' },
        ...pageArgs(req.query)
      }),
      prisma.payment.count({ where })
    ])
    return res.json({ success: true, payments: payments.map(serializePayment), total })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** A customer's open bills with their ageing, plus their credit headroom. */
app.get('/api/v1/customers/:id/outstanding', requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id)
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const bills = await prisma.bill.findMany({
      where: { customerId: id, status: { in: [...UNSETTLED_STATUSES] } },
      orderBy: { paidAt: 'asc' },
      select: {
        id: true, billNumber: true, status: true, paidAt: true, dueDate: true,
        totalAmount: true, paidAmount: true, balanceDue: true
      }
    })

    const now = new Date()
    const open = bills.map((b) => ({
      ...b,
      totalAmount: Number(b.totalAmount),
      paidAmount: Number(b.paidAmount),
      balanceDue: Number(b.balanceDue),
      ageBucket: ageBucketOf(b.dueDate, b.paidAt, now),
      daysOverdue: Math.max(0, daysBetween(b.dueDate ?? b.paidAt, now))
    }))
    const outstanding = round2(open.reduce((s, b) => s + b.balanceDue, 0))
    const creditLimit = Number(customer.creditLimit)

    return res.json({
      success: true,
      customer: {
        id: customer.id, name: customer.name, phone: customer.phone,
        creditLimit, creditDays: customer.creditDays
      },
      outstanding,
      availableCredit: round2(Math.max(0, creditLimit - outstanding)),
      overLimit: outstanding > creditLimit,
      bills: open
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Everyone who owes money, worst first, with ageing totals for the shop. */
app.get('/api/v1/receivables', requireAuth(), async (_req, res) => {
  try {
    const bills = await prisma.bill.findMany({
      where: { status: { in: [...UNSETTLED_STATUSES] }, customerId: { not: null } },
      select: {
        id: true, billNumber: true, customerId: true, paidAt: true, dueDate: true,
        balanceDue: true, totalAmount: true,
        customer: { select: { id: true, name: true, phone: true, creditLimit: true } }
      }
    })

    const now = new Date()
    type Row = {
      customerId: string; name: string; phone: string; creditLimit: number
      outstanding: number; billCount: number; oldestDays: number
      buckets: Record<string, number>
    }
    const byCustomer = new Map<string, Row>()
    const totals: Record<string, number> = { current: 0, '0-30': 0, '31-60': 0, '60+': 0 }

    for (const b of bills) {
      if (!b.customer) continue
      const bucket = ageBucketOf(b.dueDate, b.paidAt, now)
      const balance = Number(b.balanceDue)
      const age = Math.max(0, daysBetween(b.dueDate ?? b.paidAt, now))

      totals[bucket] = round2((totals[bucket] ?? 0) + balance)
      const row: Row = byCustomer.get(b.customer.id) ?? {
        customerId: b.customer.id, name: b.customer.name, phone: b.customer.phone,
        creditLimit: Number(b.customer.creditLimit),
        outstanding: 0, billCount: 0, oldestDays: 0,
        buckets: { current: 0, '0-30': 0, '31-60': 0, '60+': 0 }
      }
      row.outstanding = round2(row.outstanding + balance)
      row.billCount += 1
      row.oldestDays = Math.max(row.oldestDays, age)
      row.buckets[bucket] = round2((row.buckets[bucket] ?? 0) + balance)
      byCustomer.set(b.customer.id, row)
    }

    const customers = [...byCustomer.values()].sort((a, b) => b.outstanding - a.outstanding)
    return res.json({
      success: true,
      totalOutstanding: round2(customers.reduce((s, c) => s + c.outstanding, 0)),
      buckets: totals,
      customers
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Follow-ups ───────────────────────────────────────────────────────────────

app.get('/api/v1/followups', requireAuth(), async (req, res) => {
  try {
    const { customerId, open } = req.query
    const followUps = await prisma.customerFollowUp.findMany({
      where: {
        customerId: customerId ? String(customerId) : undefined,
        resolvedAt: open === '1' ? null : undefined
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        createdBy: { select: { username: true } }
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }]
    })
    return res.json({ success: true, followUps })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/customers/:id/followups', requireAuth(), async (req, res) => {
  try {
    const customerId = String(req.params.id)
    const note = String(req.body?.note ?? '').trim()
    if (!note) {
      return res.status(400).json({
        success: false, error: 'NOTE_REQUIRED', message: 'Write what needs following up.'
      })
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const followUp = await prisma.customerFollowUp.create({
      data: {
        customerId,
        note,
        dueAt: req.body?.dueAt ? new Date(req.body.dueAt) : null,
        createdById: req.user!.userId
      },
      include: { createdBy: { select: { username: true } } }
    })
    return res.status(201).json({ success: true, followUp })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/followups/:id', requireAuth(), async (req, res) => {
  try {
    const data: Record<string, unknown> = {}
    if (req.body?.note !== undefined) {
      const note = String(req.body.note).trim()
      if (!note) return res.status(400).json({ success: false, error: 'NOTE_REQUIRED' })
      data.note = note
    }
    if (req.body?.dueAt !== undefined) {
      data.dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null
    }
    if (req.body?.resolved !== undefined) {
      data.resolvedAt = req.body.resolved ? new Date() : null
    }
    const followUp = await prisma.customerFollowUp.update({
      where: { id: String(req.params.id) },
      data,
      include: { createdBy: { select: { username: true } } }
    })
    return res.json({ success: true, followUp })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 4 — Purchase orders ────────────────────────────────────────────────


/**
 * Products at or below their minimum stock level, grouped by the supplier they
 * are normally bought from. This is what turns "we're low on cable" into an
 * order without anyone having to remember who supplies it.
 */
app.get('/api/v1/purchase-orders/suggestions', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { isActive: true },
      include: {
        batches: { where: { isActive: true }, select: { currentQty: true, purchaseRate: true, receivedDate: true } },
        suppliers: {
          include: { supplier: { select: { id: true, name: true, isActive: true } } },
          orderBy: { isDefault: 'desc' }
        }
      }
    })

    type Row = {
      productId: string; itemCode: string; name: string; unitOfMeasure: string
      sellMode: string; totalStock: number; minStockLevel: number
      suggestedQty: number; lastRate: number; gstPercentage: number
    }
    const bySupplier = new Map<string, { supplierId: string | null; supplierName: string; items: Row[] }>()

    for (const p of products) {
      const totalStock = roundQty(p.batches.reduce((s, b) => s + Number(b.currentQty), 0))
      const minLevel = Number(p.minStockLevel)
      if (minLevel <= 0 || totalStock > minLevel) continue

      // Order back up to the minimum, with the same again as headroom, so a
      // shop is not re-ordering the same item every other day.
      const suggestedQty = roundQty(Math.max(minLevel * 2 - totalStock, minLevel))
      const latest = [...p.batches].sort(
        (a, b) => new Date(b.receivedDate).getTime() - new Date(a.receivedDate).getTime()
      )[0]
      const link = p.suppliers[0]
      const key = link?.supplier.id ?? 'none'

      const row: Row = {
        productId: p.id, itemCode: p.itemCode, name: p.name,
        unitOfMeasure: p.unitOfMeasure, sellMode: p.sellMode,
        totalStock, minStockLevel: minLevel, suggestedQty,
        lastRate: latest ? round2(Number(latest.purchaseRate)) : 0,
        gstPercentage: Number(p.gstPercentage)
      }
      const group = bySupplier.get(key) ?? {
        supplierId: link?.supplier.id ?? null,
        supplierName: link?.supplier.name ?? 'No default supplier',
        items: []
      }
      group.items.push(row)
      bySupplier.set(key, group)
    }

    const groups = [...bySupplier.values()].sort((a, b) => b.items.length - a.items.length)
    return res.json({
      success: true,
      groups,
      lowStockCount: groups.reduce((s, g) => s + g.items.length, 0)
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/purchase-orders', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { status, supplierId } = req.query
    const where = {
      status: status && isPurchaseOrderStatus(status) ? String(status) : undefined,
      supplierId: supplierId ? String(supplierId) : undefined
    }
    const [orders, total] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where,
        include: {
          supplier: { select: { name: true, phone: true } },
          createdBy: { select: { username: true } },
          items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
        },
        orderBy: { createdAt: 'desc' },
        ...pageArgs(req.query)
      }),
      prisma.purchaseOrder.count({ where })
    ])
    return res.json({ success: true, orders: orders.map(serializePurchaseOrder), total })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/purchase-orders/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const order = await prisma.purchaseOrder.findUnique({
      where: { id: String(req.params.id) },
      include: {
        supplier: true,
        createdBy: { select: { username: true } },
        items: {
          include: {
            product: {
              select: { itemCode: true, name: true, unitOfMeasure: true, sellMode: true, gstPercentage: true }
            }
          }
        }
      }
    })
    if (!order) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    return res.json({ success: true, order: serializePurchaseOrder(order) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/purchase-orders', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const { supplierId, items, expectedAt, notes, place } = req.body

    if (!supplierId) {
      return res.status(400).json({ success: false, error: 'SUPPLIER_REQUIRED' })
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, error: 'ORDER_ITEMS_REQUIRED' })
    }
    const supplier = await prisma.supplier.findUnique({ where: { id: String(supplierId) } })
    if (!supplier) return res.status(404).json({ success: false, error: 'SUPPLIER_NOT_FOUND' })

    const productIds = items.map((i: { productId?: unknown }) => String(i.productId ?? ''))
    const products = await prisma.product.findMany({ where: { id: { in: productIds } } })
    const byId = new Map(products.map((p) => [p.id, p]))

    const lines: {
      productId: string; orderedQty: number; expectedRate: number; gstPercentage: number
    }[] = []
    for (const raw of items) {
      const i = raw as {
        productId?: unknown; quantity?: unknown; expectedRate?: unknown; gstPercentage?: unknown
      }
      const product = byId.get(String(i.productId ?? ''))
      if (!product) {
        return res.status(404).json({
          success: false, error: 'PRODUCT_NOT_FOUND', productId: String(i.productId ?? '')
        })
      }
      const qty = parseQty(Number(i.quantity ?? 0), product.sellMode)
      if (qty <= 0) {
        return res.status(400).json({
          success: false, error: 'INVALID_ORDER_QUANTITY',
          message: `Enter how much of "${product.name}" to order.`, productId: product.id
        })
      }
      lines.push({
        productId: product.id,
        orderedQty: qty,
        expectedRate: round2(Number(i.expectedRate) || 0),
        gstPercentage:
          i.gstPercentage !== undefined ? round2(Number(i.gstPercentage) || 0) : Number(product.gstPercentage)
      })
    }

    const order = await prisma.$transaction(async (tx) => {
      const orderNumber = await allocateNumber(tx, 'PO')
      return tx.purchaseOrder.create({
        data: {
          orderNumber,
          supplierId: supplier.id,
          status: place ? 'PLACED' : 'DRAFT',
          placedAt: place ? new Date() : null,
          expectedAt: expectedAt ? new Date(expectedAt) : null,
          notes: notes ? String(notes).trim() : null,
          createdById: req.user!.userId,
          items: { create: lines }
        },
        include: {
          supplier: { select: { name: true, phone: true } },
          items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
        }
      })
    })

    return res.status(201).json({ success: true, order: serializePurchaseOrder(order) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/purchase-orders/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const existing = await prisma.purchaseOrder.findUnique({ where: { id } })
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (!isEditable(existing.status)) {
      return res.status(409).json({
        success: false, error: 'ORDER_NOT_EDITABLE',
        message: 'Only a draft order can be changed. Cancel it and raise a new one.',
        status: existing.status
      })
    }

    const { expectedAt, notes, items } = req.body
    const order = await prisma.$transaction(async (tx) => {
      if (Array.isArray(items)) {
        // A draft has never been sent, so replacing its lines wholesale is
        // simpler and safer than diffing them.
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } })
        for (const raw of items) {
          const i = raw as {
            productId?: unknown; quantity?: unknown; expectedRate?: unknown; gstPercentage?: unknown
          }
          const product = await tx.product.findUnique({ where: { id: String(i.productId ?? '') } })
          if (!product) throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })
          const qty = parseQty(Number(i.quantity ?? 0), product.sellMode)
          if (qty <= 0) throw Object.assign(new Error('INVALID_ORDER_QUANTITY'), { code: 'INVALID_ORDER_QUANTITY' })
          await tx.purchaseOrderItem.create({
            data: {
              purchaseOrderId: id,
              productId: product.id,
              orderedQty: qty,
              expectedRate: round2(Number(i.expectedRate) || 0),
              gstPercentage:
                i.gstPercentage !== undefined
                  ? round2(Number(i.gstPercentage) || 0)
                  : Number(product.gstPercentage)
            }
          })
        }
      }
      return tx.purchaseOrder.update({
        where: { id },
        data: {
          expectedAt: expectedAt !== undefined ? (expectedAt ? new Date(expectedAt) : null) : undefined,
          notes: notes !== undefined ? (notes ? String(notes).trim() : null) : undefined
        },
        include: {
          supplier: { select: { name: true, phone: true } },
          items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
        }
      })
    })
    return res.json({ success: true, order: serializePurchaseOrder(order) })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'PRODUCT_NOT_FOUND') return res.status(404).json({ success: false, error: 'PRODUCT_NOT_FOUND' })
    if (code === 'INVALID_ORDER_QUANTITY') return res.status(400).json({ success: false, error: 'INVALID_ORDER_QUANTITY' })
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/purchase-orders/:id/place', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({
      where: { id: String(req.params.id) },
      include: { items: true }
    })
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (existing.status !== 'DRAFT') {
      return res.status(409).json({
        success: false, error: 'ORDER_ALREADY_PLACED',
        message: 'This order has already been sent to the supplier.', status: existing.status
      })
    }
    if (existing.items.length === 0) {
      return res.status(400).json({
        success: false, error: 'ORDER_ITEMS_REQUIRED',
        message: 'Add at least one item before placing the order.'
      })
    }
    const order = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: { status: 'PLACED', placedAt: new Date() },
      include: {
        supplier: { select: { name: true, phone: true } },
        items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
      }
    })
    return res.json({ success: true, order: serializePurchaseOrder(order) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/purchase-orders/:id/cancel', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.purchaseOrder.findUnique({ where: { id: String(req.params.id) } })
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (!canCancel(existing.status)) {
      return res.status(409).json({
        success: false, error: 'ORDER_NOT_CANCELLABLE',
        message:
          existing.status === 'CANCELLED'
            ? 'This order is already cancelled.'
            : 'Goods have already arrived against this order, so it cannot be cancelled.',
        status: existing.status
      })
    }
    const order = await prisma.purchaseOrder.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED', notes: req.body?.reason ? String(req.body.reason).trim() : existing.notes },
      include: {
        supplier: { select: { name: true, phone: true } },
        items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
      }
    })
    return res.json({ success: true, order: serializePurchaseOrder(order) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Goods in. Each received line becomes a stock batch, which is why this asks
 * the same questions the batch form does — including whether the supplier's
 * rate includes GST.
 *
 * Partial deliveries are normal, so the order stays open until every line is
 * complete. Receiving is one transaction: either all the batches are created
 * and the order moves on, or nothing does.
 */
app.post('/api/v1/purchase-orders/:id/receive', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const { items, receivedDate, warehouseId, notes } = req.body

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false, error: 'RECEIVE_ITEMS_REQUIRED',
        message: 'Enter what actually arrived.'
      })
    }

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.purchaseOrder.findUnique({
        where: { id },
        include: { items: { include: { product: true } } }
      })
      if (!order) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
      if (!canReceive(order.status)) {
        throw Object.assign(new Error('ORDER_NOT_RECEIVABLE'), {
          code: 'ORDER_NOT_RECEIVABLE', status: order.status
        })
      }

      const touchedProducts: string[] = []
      const createdBatches: Awaited<ReturnType<typeof tx.productBatch.create>>[] = []

      for (const raw of items) {
        const line = raw as {
          itemId?: unknown; quantity?: unknown; purchaseRate?: unknown
          purchaseGstPct?: unknown; rateIncludesGst?: unknown; batchCode?: unknown
        }
        const orderItem = order.items.find((i) => i.id === String(line.itemId ?? ''))
        if (!orderItem) {
          throw Object.assign(new Error('ITEM_NOT_IN_ORDER'), {
            code: 'ITEM_NOT_IN_ORDER', itemId: String(line.itemId ?? '')
          })
        }
        const qty = parseQty(Number(line.quantity ?? 0), orderItem.product.sellMode)
        if (qty <= 0) continue

        const cost = computePurchaseCost(
          line.purchaseRate !== undefined ? Number(line.purchaseRate) : Number(orderItem.expectedRate),
          line.purchaseGstPct !== undefined ? Number(line.purchaseGstPct) : Number(orderItem.gstPercentage),
          Boolean(line.rateIncludesGst)
        )

        const batchCode =
          typeof line.batchCode === 'string' && line.batchCode.trim()
            ? line.batchCode.trim()
            : await allocateNumber(tx, 'BT')

        const batch = await tx.productBatch.create({
          data: {
            productId: orderItem.productId,
            batchCode,
            uniqueStockCode: `${orderItem.product.itemCode}/${batchCode}`,
            purchaseRate: cost.rateExGst,
            purchaseGstPct: cost.gstPct,
            purchaseGstAmount: cost.gstAmount,
            purchaseRateInclGst: cost.rateInclGst,
            receivedQty: qty,
            currentQty: qty,
            supplierId: order.supplierId,
            warehouseId: warehouseId || null,
            receivedDate: receivedDate ? new Date(receivedDate) : new Date(),
            notes: `Received against ${order.orderNumber}${notes ? ` — ${String(notes).trim()}` : ''}`
          },
          include: { warehouse: true, supplier: true }
        })

        await tx.purchaseOrderItem.update({
          where: { id: orderItem.id },
          data: { receivedQty: roundQty(Number(orderItem.receivedQty) + qty) }
        })
        touchedProducts.push(orderItem.productId)
        createdBatches.push(batch)
      }

      if (createdBatches.length === 0) {
        throw Object.assign(new Error('NOTHING_RECEIVED'), { code: 'NOTHING_RECEIVED' })
      }

      const after = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId: id } })
      const nextStatus = statusAfterReceipt(
        after.map((i) => ({ orderedQty: Number(i.orderedQty), receivedQty: Number(i.receivedQty) }))
      )

      const updated = await tx.purchaseOrder.update({
        where: { id },
        data: { status: nextStatus },
        include: {
          supplier: { select: { name: true, phone: true } },
          items: { include: { product: { select: { itemCode: true, name: true, unitOfMeasure: true } } } }
        }
      })

      // Stock moved, so terminals need the new totals.
      await emitProductUpsertBulk(tx, touchedProducts)
      return { order: updated, batches: createdBatches }
    })

    return res.status(201).json({
      success: true,
      order: serializePurchaseOrder(result.order),
      batches: result.batches.map(serializeBatch)
    })
  } catch (err: unknown) {
    const e = err as { code?: string; status?: string; itemId?: string }
    const map: Record<string, [number, string]> = {
      NOT_FOUND: [404, 'No such order.'],
      ORDER_NOT_RECEIVABLE: [409, 'Goods can only be received against an order that has been placed.'],
      ITEM_NOT_IN_ORDER: [400, 'That line is not part of this order.'],
      NOTHING_RECEIVED: [400, 'Enter a quantity for at least one line.']
    }
    if (e.code && map[e.code]) {
      const [status, message] = map[e.code]
      return res.status(status).json({ success: false, error: e.code, message, ...e })
    }
    if (e.code === 'P2002') {
      return res.status(409).json({
        success: false, error: 'BATCH_CODE_EXISTS_FOR_PRODUCT',
        message: 'A batch with that code already exists for this product.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 5 — Warranties ─────────────────────────────────────────────────────



/**
 * Lists cover. `status` filters on the *effective* status, so "EXPIRED" is
 * a date test rather than a stored value and "ACTIVE" excludes what has
 * lapsed.
 */
app.get('/api/v1/warranties', requireAuth(), async (req, res) => {
  try {
    const { status, search, customerId } = req.query
    const now = new Date()
    const wantStatus = status ? String(status) : undefined

    const statusWhere =
      wantStatus === 'ACTIVE' ? { status: 'ACTIVE', expiryDate: { gte: now } }
      : wantStatus === 'EXPIRED' ? { status: 'ACTIVE', expiryDate: { lt: now } }
      : wantStatus === 'CLAIMED' || wantStatus === 'RESOLVED' ? { status: wantStatus }
      : {}

    const where = {
      ...statusWhere,
      customerId: customerId ? String(customerId) : undefined,
      OR: search
        ? [
            { serialNumber: { contains: String(search), mode: 'insensitive' as const } },
            { product: { name: { contains: String(search), mode: 'insensitive' as const } } },
            { product: { itemCode: { contains: String(search), mode: 'insensitive' as const } } },
            { customer: { name: { contains: String(search), mode: 'insensitive' as const } } },
            { customer: { phone: { contains: String(search) } } },
            { bill: { billNumber: { contains: String(search), mode: 'insensitive' as const } } }
          ]
        : undefined
    }

    const [rows, total] = await Promise.all([
      prisma.warranty.findMany({
        where,
        include: WARRANTY_INCLUDE,
        orderBy: [{ status: 'asc' }, { expiryDate: 'asc' }],
        ...pageArgs(req.query)
      }),
      prisma.warranty.count({ where })
    ])
    return res.json({ success: true, warranties: rows.map((w) => serializeWarranty(w, now)), total })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** In cover today, lapsing within the notice window. Ordered soonest first. */
app.get('/api/v1/warranties/expiring-soon', requireAuth(), async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(String(req.query.days ?? EXPIRING_SOON_DAYS)) || EXPIRING_SOON_DAYS))
    const now = new Date()
    const until = new Date(now.getTime() + days * 86_400_000)
    const rows = await prisma.warranty.findMany({
      where: { status: 'ACTIVE', expiryDate: { gte: now, lte: until } },
      include: WARRANTY_INCLUDE,
      orderBy: { expiryDate: 'asc' }
    })
    return res.json({ success: true, days, warranties: rows.map((w) => serializeWarranty(w, now)) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Counts for the dashboard: in cover, expiring soon, claims open. */
app.get('/api/v1/warranties/summary', requireAuth(), async (_req, res) => {
  try {
    const now = new Date()
    const soon = new Date(now.getTime() + EXPIRING_SOON_DAYS * 86_400_000)
    const [active, expiringSoon, claimsOpen, expired] = await Promise.all([
      prisma.warranty.count({ where: { status: 'ACTIVE', expiryDate: { gte: now } } }),
      prisma.warranty.count({ where: { status: 'ACTIVE', expiryDate: { gte: now, lte: soon } } }),
      prisma.warranty.count({ where: { status: 'CLAIMED' } }),
      prisma.warranty.count({ where: { status: 'ACTIVE', expiryDate: { lt: now } } })
    ])
    return res.json({ success: true, active, expiringSoon, claimsOpen, expired })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/warranties/:id', requireAuth(), async (req, res) => {
  try {
    const w = await prisma.warranty.findUnique({
      where: { id: String(req.params.id) },
      include: WARRANTY_INCLUDE
    })
    if (!w) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    return res.json({ success: true, warranty: serializeWarranty(w) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Opens a claim. Any signed-in user can — a cashier is who the customer
 * walks up to. The serial number is asked for here, not at sale time,
 * because this is the moment someone is actually holding the unit.
 */
app.post('/api/v1/warranties/:id/claim', requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id)
    const description = String(req.body?.description ?? '').trim()
    if (!description) {
      return res.status(400).json({
        success: false, error: 'DESCRIPTION_REQUIRED',
        message: 'Describe the fault the customer is reporting.'
      })
    }

    const w = await prisma.warranty.findUnique({ where: { id } })
    if (!w) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const gate = canClaim(w.status, w.expiryDate)
    if (!gate.allowed) {
      const messages = {
        EXPIRED: `This warranty expired on ${w.expiryDate.toLocaleDateString('en-IN')}.`,
        ALREADY_CLAIMED: 'A claim is already open on this warranty.',
        ALREADY_RESOLVED: 'This warranty has already been claimed and resolved.'
      }
      return res.status(409).json({
        success: false, error: `WARRANTY_${gate.reason}`, message: messages[gate.reason!]
      })
    }

    const updated = await prisma.warranty.update({
      where: { id },
      data: {
        status: 'CLAIMED',
        claimDate: new Date(),
        claimDescription: description,
        claimedById: req.user!.userId,
        serialNumber: req.body?.serialNumber ? String(req.body.serialNumber).trim() : w.serialNumber
      },
      include: WARRANTY_INCLUDE
    })
    return res.json({ success: true, warranty: serializeWarranty(updated) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Closes a claim with what was done. Only a super admin decides this. */
app.put('/api/v1/warranties/:id/resolve', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const { resolution, notes } = req.body ?? {}
    if (!isWarrantyResolution(resolution)) {
      return res.status(400).json({
        success: false, error: 'INVALID_RESOLUTION',
        message: 'Say what was done: repaired, replaced, refunded, or rejected.'
      })
    }
    const w = await prisma.warranty.findUnique({ where: { id } })
    if (!w) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (w.status !== 'CLAIMED') {
      return res.status(409).json({
        success: false, error: 'NO_OPEN_CLAIM',
        message: 'There is no open claim on this warranty to resolve.'
      })
    }
    const updated = await prisma.warranty.update({
      where: { id },
      data: {
        status: 'RESOLVED',
        resolution,
        resolutionNotes: notes ? String(notes).trim() : null,
        resolvedById: req.user!.userId,
        resolvedAt: new Date()
      },
      include: WARRANTY_INCLUDE
    })
    return res.json({ success: true, warranty: serializeWarranty(updated) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Records or corrects the serial number on a unit, outside of a claim. */
app.put('/api/v1/warranties/:id', requireAuth(), async (req, res) => {
  try {
    const updated = await prisma.warranty.update({
      where: { id: String(req.params.id) },
      data: { serialNumber: req.body?.serialNumber ? String(req.body.serialNumber).trim() : null },
      include: WARRANTY_INCLUDE
    })
    return res.json({ success: true, warranty: serializeWarranty(updated) })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/analytics/summary', requireAuth(), async (req, res) => {
  try {
    const { period = 'today' } = req.query

    const now = new Date()
    // Shift now into IST space for calendar-level calculations
    const nowIST = new Date(now.getTime() + IST_OFFSET_MS)
    let startDate: Date | undefined
    switch (period) {
      case 'today':
        startDate = istMidnight(now)
        break
      case 'week':
        startDate = istMidnight(now, -7)
        break
      case 'month':
        // First day of the current IST month
        startDate = new Date(
          Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1) - IST_OFFSET_MS
        )
        break
      case 'year':
        // Jan 1 of the current IST year
        startDate = new Date(
          Date.UTC(nowIST.getUTCFullYear(), 0, 1) - IST_OFFSET_MS
        )
        break
      default: // 'all'
        startDate = undefined
    }

    const where = {
      // A sale is a sale whether or not the customer has paid yet. Counting
      // only PAID bills hid every credit sale until it was settled, and then
      // moved it into the revenue of the day it was billed — so the same
      // day's takings read differently a week later.
      status: { in: ['PAID', 'PARTIAL', 'CREDIT'] },
      ...(startDate ? { paidAt: { gte: startDate } } : {})
    }

    const bills = await prisma.bill.findMany({
      where,
      include: {
        items: {
          include: {
            batchAllocations: { select: { quantity: true, unitCost: true } },
            product: {
              select: {
                batches: {
                  where: { isActive: true },
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                  select: { purchaseRate: true }
                }
              }
            }
          }
        }
      }
    })

    let totalRevenue = 0
    let totalTaxableValue = 0
    let totalBillDiscounts = 0
    let totalLineDiscounts = 0
    let estimatedCOGS = 0
    let cogsItemCount = 0
    const payBreakdownAmt: Record<string, number> = { CASH: 0, UPI: 0, CARD: 0, CHEQUE: 0 }
    const payBreakdownCount: Record<string, number> = { CASH: 0, UPI: 0, CARD: 0, CHEQUE: 0 }
    const productMap: Record<
      string,
      { productName: string; itemCode: string; revenue: number; taxableValue: number; qty: number; cost: number }
    > = {}

    for (const bill of bills) {
      totalRevenue += Number(bill.totalAmount)
      totalTaxableValue += Number(bill.taxableValue ?? 0)
      totalBillDiscounts += Number(bill.discountAmount)

      for (const item of bill.items) {
        const qty = Number(item.quantity)
        const gross = qty * Number(item.unitRate)
        totalLineDiscounts += gross - Number(item.lineTotal)

        // True cost of goods: what these exact units cost when they were
        // bought, taken from the batches the sale actually consumed. Only
        // bills written before allocations existed fall back to assuming the
        // latest purchase rate. Both bases are ex-GST, matching taxable value.
        const allocated = item.batchAllocations ?? []
        let cost = 0
        let costed = false
        if (allocated.length > 0) {
          cost = round2(allocated.reduce((s2, a) => s2 + Number(a.quantity) * Number(a.unitCost), 0))
          costed = true
        } else {
          const pr = item.product.batches[0]?.purchaseRate
          if (pr) { cost = qty * Number(pr); costed = true }
        }
        if (costed) { estimatedCOGS += cost; cogsItemCount++ }

        if (!productMap[item.productId]) {
          productMap[item.productId] = { productName: item.productName, itemCode: item.itemCode, revenue: 0, taxableValue: 0, qty: 0, cost: 0 }
        }
        productMap[item.productId].revenue += Number(item.lineTotal)
        productMap[item.productId].taxableValue += Number(item.taxableValue ?? 0)
        productMap[item.productId].qty += qty
        productMap[item.productId].cost += cost
      }
    }

    // Goods that came back are not revenue. Credit notes were excluded from
    // the query and never subtracted, so a fully-returned sale still counted
    // in full — and a returned credit sale, whose settlement recompute marks
    // it PAID at zero owing, counted as revenue nobody ever paid.
    const returnAgg = await prisma.bill.aggregate({
      where: { status: 'RETURN', ...(startDate ? { paidAt: { gte: startDate } } : {}) },
      _sum: { totalAmount: true, taxableValue: true },
      _count: true
    })
    const totalReturns = round2(Number(returnAgg._sum.totalAmount ?? 0))
    const returnsTaxable = round2(Number(returnAgg._sum.taxableValue ?? 0))
    const returnCount = returnAgg._count

    // The tender split comes from the payments themselves. Attributing a
    // bill's whole total to its first tender reported a 500 cash + 500 UPI
    // sale as 1,000 cash, dropped CHEQUE entirely, and ignored every
    // collection made after the sale.
    const paymentRows = await prisma.payment.groupBy({
      by: ['method'],
      where: startDate ? { receivedAt: { gte: startDate } } : undefined,
      _sum: { amount: true },
      _count: true
    })
    for (const row of paymentRows) {
      payBreakdownAmt[row.method] = round2(Number(row._sum.amount ?? 0))
      payBreakdownCount[row.method] = row._count
    }

    const totalDiscounts = totalLineDiscounts + totalBillDiscounts
    const grossRevenuePlusDics = totalRevenue + totalDiscounts
    // Margin compares ex-GST revenue with ex-GST cost. Using the GST-inclusive
    // total against an ex-GST purchase rate overstated every margin by the tax.
    // Bills written before the tax breakdown existed have taxableValue 0, so
    // fall back to the gross total for those rather than reporting 100% margin.
    const netRevenue = round2(totalRevenue - totalReturns)
    const grossTaxable = totalTaxableValue > 0 ? totalTaxableValue : totalRevenue
    const revenueExGst = round2(grossTaxable - returnsTaxable)
    const estimatedGrossProfit = round2(revenueExGst - estimatedCOGS)
    const estimatedMarginPct = revenueExGst > 0 ? (estimatedGrossProfit / revenueExGst) * 100 : 0
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 8)

    return res.json({
      success: true,
      summary: {
        period: String(period),
        totalBills: bills.length,
        // Gross sales, what came back, and the difference.
        totalRevenue,
        totalReturns,
        netRevenue,
        returnCount,
        avgBillValue: bills.length > 0 ? totalRevenue / bills.length : 0,
        totalDiscounts,
        totalLineDiscounts,
        totalBillDiscounts,
        discountPct: grossRevenuePlusDics > 0 ? (totalDiscounts / grossRevenuePlusDics) * 100 : 0,
        estimatedCOGS,
        estimatedGrossProfit,
        estimatedMarginPct,
        revenueExGst,
        totalTaxableValue,
        hasCOGSData: cogsItemCount > 0,
        // Every method, including CHEQUE, which used to be counted in
        // revenue but omitted here so the two never reconciled.
        paymentBreakdown: payBreakdownAmt,
        paymentCounts: payBreakdownCount,
        totalCollected: round2(Object.values(payBreakdownAmt).reduce((a, b) => a + b, 0)),
        topProducts
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Overview Stats ───────────────────────────────────────────────────────────

app.get('/api/v1/system/stats', requireAuth(), async (_req, res) => {
  try {
    const today = new Date()
    const startOfDay = istMidnight(today)
    const startOfTomorrow = istMidnight(today, 1)

    const [todayBills, todaySalesAgg, totalProducts, activeCustomers, connectedTerminals] = await Promise.all([
      prisma.bill.count({ where: { status: 'PAID', paidAt: { gte: startOfDay, lt: startOfTomorrow } } }),
      prisma.bill.aggregate({
        where: { status: 'PAID', paidAt: { gte: startOfDay, lt: startOfTomorrow } },
        _sum: { totalAmount: true }
      }),
      prisma.product.count({ where: { isActive: true } }),
      prisma.customer.count({ where: { isActive: true } }),
      prisma.authorizedClient.count()
    ])

    return res.json({
      success: true,
      stats: {
        todayBills,
        todaySales: Number(todaySalesAgg._sum.totalAmount ?? 0),
        totalProducts,
        activeCustomers,
        connectedTerminals
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Manager self-device ID ───────────────────────────────────────────────────


app.get('/api/v1/system/self-device-id', requireAuth(), async (_req, res) => {
  try {
    const mac = getServerMac()
    let client = await prisma.authorizedClient.findUnique({ where: { macAddress: mac } })
    if (!client) {
      client = await prisma.authorizedClient.create({
        data: { friendlyName: 'Manager Terminal', macAddress: mac }
      })
    }
    return res.json({ success: true, deviceId: client.id })
  } catch (err) {
    console.error('Error in /self-device-id:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 4 — License Hardening ──────────────────────────────────────────────

// Read-only status snapshot for the manager UI banner.
app.get('/api/v1/system/license-status', requireAuth(), async (_req, res) => {
  try {
    const [status, clock] = await Promise.all([getLicenseStatus(), checkClockTamper()])
    return res.json({
      success: true,
      status: {
        ...status,
        lastRefreshAt: status.lastRefreshAt?.toISOString() ?? null,
        clock: { ok: clock.ok, driftMs: clock.driftMs, lastSeen: clock.lastSeen?.toISOString() ?? null }
      }
    })
  } catch (err) {
    console.error('license-status error:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// Manual refresh trigger (e.g. after the user fixes their internet). The
// daily worker covers the unattended case; this is for the impatient admin.
app.post('/api/v1/system/license-refresh', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const config = await prisma.shopConfig.findFirst()
    if (!config) return res.status(404).json({ success: false, error: 'NO_LICENSE' })
    const hwId = config.hardwareId || getServerMac()
    const r = await refreshLicenseOnce(process.env.SAAS_API_URL || '', hwId)
    return res.json({ success: r.ok, error: r.error ?? null })
  } catch (err) {
    console.error('license-refresh error:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 3D — Bidirectional Sync ────────────────────────────────────────────

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
app.get('/api/v1/sync/pull', requireAuth(), async (req, res) => {
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

/**
 * Trim the change log.
 *
 * SyncEvent is append-only and had nothing removing rows, so every price
 * edit, every customer change and every bill written since the shop opened
 * stayed in it forever — each carrying a full JSON snapshot of the row it
 * describes. On a busy counter that is hundreds of thousands of rows a year,
 * inside the database the shop also has to back up twice a day.
 *
 * What makes them safe to delete is that a terminal only ever reads forward
 * from its cursor. Anything older than every terminal's cursor can never be
 * asked for again. The retention window is generous on purpose — a till that
 * has been switched off for a fortnight should still catch up rather than
 * silently miss the changes it slept through — and rows newer than the
 * furthest-behind terminal are kept regardless of age, so a long-idle till is
 * never quietly stranded.
 */
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

/**
 * Anything that got past every route.
 *
 * Express's built-in fallbacks answer an unknown path with an HTML error
 * page, and an unhandled throw with a stack trace — the file layout of the
 * shop's server, handed to whoever asked. Neither is what a JSON API should
 * say, and a till that gets HTML where it expected JSON fails with a parse
 * error that tells the cashier nothing.
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({ success: false, error: 'NOT_FOUND', path: req.path })
})

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  // The routes catch their own errors; reaching here means something threw
  // outside one — malformed JSON in the body is the usual cause. Log the
  // detail locally, tell the caller only that it failed.
  console.error('[api] unhandled error:', err?.stack ?? err)
  if (res.headersSent) return
  res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
})

// ─── Server Export ────────────────────────────────────────────────────────────

/**
 * Start the branch API.
 *
 * Given a certificate this serves HTTPS, which is how it runs in the shop:
 * everything between a till and here used to cross the Wi-Fi in plain text,
 * including the cashier's session token on every single request. Without one
 * — the test harness, and a first boot before the certificate exists — it
 * falls back to HTTP so the server still comes up rather than leaving the
 * shop with nothing.
 */
export function startExpressServer(
  port: number = parseInt(process.env.LOCAL_SERVER_PORT || '52001'),
  tls?: { cert: string; key: string }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = tls
      ? https.createServer({ cert: tls.cert, key: tls.key }, app)
      : http.createServer(app)

    server.listen(port, '0.0.0.0', () => {
      console.log(
        `Local ${tls ? 'HTTPS' : 'HTTP'} server running on port ${port} (all interfaces)`
      )
      resolve(port)
    })
    server.on('error', (err) => {
      console.error(`Failed to bind port ${port}:`, err)
      reject(err)
    })
  })
}
