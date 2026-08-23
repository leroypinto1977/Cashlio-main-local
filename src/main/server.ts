import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { PrismaClient, Prisma } from '@prisma/client'
import os from 'os'
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
  normalizeItemCode,
  stateCodeOf,
  codeStub,
  type FieldResult
} from '../shared/validation'
import { round2, computeInvoiceTotals } from '../shared/money'
import { parseQty, roundQty, computePurchaseCost, defaultMeasureFor, measuresFor } from '../shared/units'
import {
  settle, checkCredit, isPaymentMethod, dueDateFor, ageBucketOf,
  daysBetween, UNSETTLED_STATUSES, type Tender
} from '../shared/credit'
import {
  isReturnReasonCode, shouldRestock, isPurchaseOrderStatus,
  canReceive, canCancel, isEditable, statusAfterReceipt
} from '../shared/procurement'
import {
  expiryDateFor, effectiveStatus, canClaim, isWarrantyResolution,
  daysUntilExpiry, EXPIRING_SOON_DAYS
} from '../shared/warranty'

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string }
    }
  }
}

/**
 * The largest per-line discount anyone may give without it being a price
 * override. Higher than a normal markdown, low enough that "100% off" is
 * no longer a way to walk stock out of the door.
 */
const MAX_LINE_DISCOUNT_PCT = 90

const prisma = new PrismaClient()
const app = express()

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type DbClient = TxClient | typeof prisma

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

// ─── License lock-out middleware (Phase 4) ─────────────────────────────────────
//
// Mounted on write endpoints so an expired / revoked license stops new bills
// while still letting cashiers view history. Read endpoints are intentionally
// unguarded — the user can always export their data.

function requireActiveLicense() {
  return async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const status = await getLicenseStatus()
      if (status.locked) {
        return res.status(402).json({
          success: false,
          error: 'LICENSE_LOCKED',
          reason: status.reason,
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

function forgetUser(userId: string): void {
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

function requireAuth(roles?: string[]) {
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

// IST is UTC+5:30. All date-boundary calculations must use IST so that
// "today" in the UI matches the actual calendar day the user is on.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000

/**
 * Returns the start of a calendar day in IST, expressed as a UTC Date.
 * Passing offset=1 gives tomorrow's IST midnight, offset=-1 gives yesterday's, etc.
 */
function istMidnight(base: Date = new Date(), offset = 0): Date {
  const istMs = base.getTime() + IST_OFFSET_MS
  const ist = new Date(istMs)
  const midnightUTC = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offset)
  return new Date(midnightUTC - IST_OFFSET_MS)
}

/**
 * Document-number series. `INV` for sales, `CN` for credit notes (returns),
 * `BT` for stock batches — deliberately distinct prefixes so a bill number can
 * never be mistaken for a batch code. Series reset each IST calendar month.
 */
type Series = 'INV' | 'CN' | 'BT' | 'PO'

function currentPeriod(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS)
  const yy = String(ist.getUTCFullYear()).slice(2)
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0')
  return `${yy}${mm}`
}

/**
 * Atomically claims the next number in a series.
 *
 * This is a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so two
 * concurrent bills can never be handed the same value. (The previous scheme
 * counted existing rows for the month, which collided as soon as a bill was
 * voided or a second terminal billed at the same moment.)
 *
 * Call it inside the same transaction as the row it numbers: if the write
 * rolls back, the number is released with it.
 */
async function allocateNumber(db: DbClient, series: Series, width = 4): Promise<string> {
  const period = currentPeriod()
  const rows = await db.$queryRaw<Array<{ lastValue: number }>>`
    INSERT INTO "NumberSeries" ("series", "period", "lastValue", "updatedAt")
    VALUES (${series}, ${period}, 1, NOW())
    ON CONFLICT ("series", "period")
    DO UPDATE SET "lastValue" = "NumberSeries"."lastValue" + 1, "updatedAt" = NOW()
    RETURNING "lastValue"
  `
  const seq = Number(rows[0].lastValue)
  return `${series}-${period}-${String(seq).padStart(width, '0')}`
}

/** Read-only preview of the next number. Does NOT consume it. */
async function peekNumber(series: Series, width = 4): Promise<string> {
  const period = currentPeriod()
  const row = await prisma.numberSeries.findUnique({
    where: { series_period: { series, period } }
  })
  const next = (row?.lastValue ?? 0) + 1
  return `${series}-${period}-${String(next).padStart(width, '0')}`
}

// ─── GST ──────────────────────────────────────────────────────────────────────

/**
 * A sale is inter-state only when we know both the shop's and the customer's
 * state and they differ. A walk-in customer with no GSTIN is treated as local,
 * which is the correct default for over-the-counter retail.
 */
async function resolveTaxContext(
  db: DbClient,
  customerId: string | null
): Promise<{ interState: boolean; placeOfSupply: string | null }> {
  const config = await db.shopConfig.findFirst({ select: { stateCode: true, gstin: true } })
  const shopState = config?.stateCode || stateCodeOf(config?.gstin) || null
  let customerState: string | null = null
  if (customerId) {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: { gstin: true }
    })
    customerState = stateCodeOf(customer?.gstin)
  }
  return {
    interState: Boolean(shopState && customerState && shopState !== customerState),
    placeOfSupply: customerState || shopState
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializeBillItem(it: any): any {
  return {
    ...it,
    quantity: Number(it.quantity),
    unitRate: Number(it.unitRate),
    gstPercentage: Number(it.gstPercentage),
    lineDiscountPct: Number(it.lineDiscountPct),
    lineDiscountAmt: Number(it.lineDiscountAmt),
    lineGstAmount: Number(it.lineGstAmount),
    lineTotal: Number(it.lineTotal),
    billDiscountAmt: Number(it.billDiscountAmt ?? 0),
    taxableValue: Number(it.taxableValue ?? 0),
    cgstAmount: Number(it.cgstAmount ?? 0),
    sgstAmount: Number(it.sgstAmount ?? 0),
    igstAmount: Number(it.igstAmount ?? 0)
  }
}

/** Single place that turns Prisma Decimals into JSON numbers for a bill. */
function serializeBill(b: any): any {
  return {
    ...b,
    subtotal: Number(b.subtotal),
    gstAmount: Number(b.gstAmount),
    discountAmount: Number(b.discountAmount),
    totalAmount: Number(b.totalAmount),
    taxableValue: Number(b.taxableValue ?? 0),
    cgstAmount: Number(b.cgstAmount ?? 0),
    sgstAmount: Number(b.sgstAmount ?? 0),
    igstAmount: Number(b.igstAmount ?? 0),
    paidAmount: Number(b.paidAmount ?? 0),
    balanceDue: Number(b.balanceDue ?? 0),
    amountReceived: b.amountReceived != null ? Number(b.amountReceived) : null,
    changeGiven: b.changeGiven != null ? Number(b.changeGiven) : null,
    ...(Array.isArray(b.items) ? { items: b.items.map(serializeBillItem) } : {})
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Resolves the brand for a product write. Accepts a `brandId` from the picker,
 * or a bare name (find-or-create) so an inline "+ Add brand" and older clients
 * both work. Returns both the id and the denormalised name to store.
 */
type BrandResolution =
  | { kind: 'unchanged' }
  | { kind: 'cleared' }
  | { kind: 'resolved'; brandId: string; brand: string }
  | { kind: 'not-found' }

async function resolveBrand(
  tx: TxClient,
  input: { brandId?: unknown; brand?: unknown }
): Promise<BrandResolution> {
  if (input.brandId === null || input.brand === null) return { kind: 'cleared' }

  if (typeof input.brandId === 'string' && input.brandId.trim()) {
    const found = await tx.brand.findUnique({ where: { id: input.brandId.trim() } })
    return found
      ? { kind: 'resolved', brandId: found.id, brand: found.name }
      : { kind: 'not-found' }
  }

  if (typeof input.brand === 'string') {
    const name = input.brand.trim()
    if (!name) return { kind: 'cleared' }
    const existing = await tx.brand.findUnique({ where: { name } })
    const brand = existing ?? (await tx.brand.create({ data: { name } }))
    return { kind: 'resolved', brandId: brand.id, brand: brand.name }
  }

  return { kind: 'unchanged' }
}

/** Turns a resolution into the fields to write, or null when nothing changes. */
function brandFields(r: BrandResolution): { brandId: string | null; brand: string | null } | null {
  if (r.kind === 'cleared') return { brandId: null, brand: null }
  if (r.kind === 'resolved') return { brandId: r.brandId, brand: r.brand }
  return null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Batch rows carry three Decimal money columns and two Decimal quantities. */
function serializeBatch(b: any): any {
  return {
    ...b,
    purchaseRate: Number(b.purchaseRate),
    purchaseGstPct: Number(b.purchaseGstPct ?? 0),
    purchaseGstAmount: Number(b.purchaseGstAmount ?? 0),
    purchaseRateInclGst: Number(b.purchaseRateInclGst ?? 0),
    receivedQty: Number(b.receivedQty),
    currentQty: Number(b.currentQty)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * What a customer currently owes: the sum of balances on bills that are still
 * part-paid or on credit. Never stored, so it cannot drift away from the bills
 * it describes.
 */
async function outstandingFor(db: DbClient, customerId: string): Promise<number> {
  const agg = await db.bill.aggregate({
    where: { customerId, status: { in: [...UNSETTLED_STATUSES] } },
    _sum: { balanceDue: true }
  })
  return round2(Number(agg._sum.balanceDue ?? 0))
}

/**
 * Normalises whatever the client sent into a list of tenders.
 *
 * Older clients (and the terminal's offline outbox) send a single
 * `paymentMethod` with an optional `amountReceived`; newer ones send a
 * `payments` array so a bill can be split across cash and UPI. A bill with no
 * tender at all is a pure credit sale.
 */
type TenderRead =
  | { error: string }
  | { tenders: Tender[]; settleInFull: boolean; method: string }

function readTenders(body: Record<string, unknown>): TenderRead {
  const raw = body.payments
  if (Array.isArray(raw)) {
    const tenders: Tender[] = []
    for (const t of raw) {
      const line = t as { method?: unknown; amount?: unknown; reference?: unknown }
      if (!isPaymentMethod(line.method)) return { error: 'INVALID_PAYMENT_METHOD' }
      const amount = round2(Number(line.amount))
      if (!Number.isFinite(amount) || amount < 0) return { error: 'INVALID_PAYMENT_AMOUNT' }
      if (amount === 0) continue
      tenders.push({
        method: line.method,
        amount,
        reference: typeof line.reference === 'string' ? line.reference.trim() || null : null
      })
    }
    return { tenders, settleInFull: false, method: tenders[0]?.method ?? 'CASH' }
  }

  const method = body.paymentMethod
  if (!isPaymentMethod(method)) return { error: 'INVALID_PAYMENT_METHOD' }

  // Older clients send only a method, meaning "paid in full at the counter".
  // The total is not known until the lines are priced, so that is expressed as
  // a flag rather than a number invented here.
  const received = body.amountReceived
  if (received == null) return { tenders: [], settleInFull: true, method }

  const amount = round2(Number(received))
  if (!Number.isFinite(amount) || amount < 0) return { error: 'INVALID_PAYMENT_AMOUNT' }
  return { tenders: amount === 0 ? [] : [{ method, amount, reference: null }], settleInFull: false, method }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializePayment(p: any): any {
  return {
    ...p,
    amount: Number(p.amount),
    ...(p.bill ? { bill: { ...p.bill, totalAmount: Number(p.bill.totalAmount) } } : {})
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Takes an exclusive lock on a bill for the rest of the transaction.
 *
 * Void, return and payment all used to read their preconditions outside the
 * transaction that enforced them, so two concurrent requests could both pass
 * the same check: stock restocked twice by a double void, two credit notes
 * for one return, or two payments where the second silently overwrote the
 * first and the shop lost the record of money it had taken.
 */
async function lockBill(tx: TxClient, billId: string): Promise<void> {
  await tx.$executeRaw`SELECT "id" FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`
}

/**
 * Recomputes a bill's settlement from the records that actually exist: what
 * has been collected against it, less anything returned. Storing the result
 * keeps queries cheap, but it is always derivable from payments and credit
 * notes, so it cannot silently drift.
 */
async function recomputeBillSettlement(tx: TxClient, billId: string): Promise<void> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: {
      id: true, totalAmount: true, status: true,
      payments: { select: { amount: true } },
      returns: { where: { status: 'RETURN' }, select: { totalAmount: true } }
    }
  })
  if (!bill || bill.status === 'VOID' || bill.status === 'RETURN') return

  const total = round2(Number(bill.totalAmount))
  const paid = round2(bill.payments.reduce((s, p) => s + Number(p.amount), 0))
  const returned = round2(bill.returns.reduce((s, r) => s + Number(r.totalAmount), 0))
  const balanceDue = round2(Math.max(0, total - paid - returned))

  await tx.bill.update({
    where: { id: bill.id },
    data: {
      paidAmount: paid,
      balanceDue,
      status: balanceDue <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'CREDIT'
    }
  })
}

/** Rejects a request with the shared validator's own error code and message. */
function fieldError(res: Response, r: Extract<FieldResult<string>, { ok: false }>) {
  return res.status(400).json({ success: false, error: r.error, message: r.message })
}

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
    const { licenseKey, hardwareId = 'STATIC-MAC-FOR-MVP', branchName = 'PENDING_SETUP', shopName = 'My Shop' } = req.body

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
    const clients = await prisma.authorizedClient.findMany({
      where: { retiredAt: null },
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

app.get('/api/v1/products', requireAuth(), async (req, res) => {
  try {
    const { search, categoryId, isActive } = req.query

    const products = await prisma.product.findMany({
      where: {
        isActive: isActive === 'false' ? false : isActive === 'true' ? true : undefined,
        categoryId: categoryId ? String(categoryId) : undefined,
        OR: search
          ? [
              { name: { contains: String(search), mode: 'insensitive' } },
              { itemCode: { contains: String(search), mode: 'insensitive' } },
              { brand: { contains: String(search), mode: 'insensitive' } }
            ]
          : undefined
      },
      include: {
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
      orderBy: { name: 'asc' }
    })

    const result = products.map((p) => {
      const mappedBatches = p.batches.map(serializeBatch)
      return {
        ...p,
        totalStock: roundQty(mappedBatches.reduce((sum, b) => sum + b.currentQty, 0)),
        batchCount: mappedBatches.length,
        latestBatch: mappedBatches[0] ?? null,
        batches: mappedBatches,
        sellingRate: Number(p.sellingRate),
        gstPercentage: Number(p.gstPercentage),
        minStockLevel: Number(p.minStockLevel)
      }
    })

    return res.json({ success: true, products: result })
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

      if (normalizeItemCode(String(itemCode)) !== current.itemCode) {
        const codeCheck = validateItemCode(String(itemCode))
        if (!codeCheck.ok) return fieldError(res, codeCheck)

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
    const { status, search, limit = '50', offset = '0' } = req.query
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
      take: parseInt(String(limit)),
      skip: parseInt(String(offset))
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
          alreadyReturnedQty: returnedByLineId.get(it.id) ?? 0
        }))
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Bill core helpers ────────────────────────────────────────────────────────
// Shared between POST /bills, POST /bills/:id/return, and POST /bills/:id/exchange
// so the same FIFO / pro-ration / serialization logic is used everywhere.

type IncomingSaleItem = {
  productId: string
  quantity: number
  unitRate: number
  gstPercentage: number
  lineDiscountPct: number
  lineDiscountAmt: number
}

type CreateBillArgs = {
  items: IncomingSaleItem[]
  customerId: string | null
  originDeviceId: string
  cashierId: string
  paymentMethod: string
  amountReceived: number | null
  tenders: Tender[]
  /// Treat the bill as settled in full whatever the total turns out to be.
  /// Used for the legacy client shape, where "no amountReceived" has always
  /// meant "paid in full at the counter".
  settleInFull?: boolean
  /// Value carried over from a credit note rather than tendered. The
  /// replacement half of an exchange is paid for by the refund; recording
  /// that as a cash tender overstated takings by the refund amount.
  creditApplied?: number
  /// Set by a SUPER_ADMIN to let a bill exceed the customer's credit limit.
  allowCreditOverride: boolean
  /// Set by a SUPER_ADMIN to bill a line at something other than the
  /// catalogue price. A cashier's request for this is ignored.
  allowPriceOverride?: boolean
  discountAmount: number
  notes: string | null
  clientLocalId: string | null
  /// When the sale actually happened, as reported by the terminal. An offline
  /// bill can reach the server hours later; stamping it with arrival time puts
  /// takings on the wrong day and ages credit from the wrong date. Clamped
  /// before it gets here — see `resolveSoldAt`.
  soldAt?: Date
}

/**
 * Decide the time a sale happened.
 *
 * The terminal knows; the server only knows when the bill arrived, which for
 * an offline bill can be hours or a day later. So the terminal's clock is
 * preferred — but it is a machine in a shop, and a wrong one would let a sale
 * land in next year's books or on a day already closed and reported.
 *
 * So it is trusted only within a window: never ahead of the server (a few
 * minutes of skew allowed), and never more than a fortnight back, which is
 * far longer than any real outage and short enough to bound the damage.
 * Anything outside falls back to now, which is at worst the behaviour we
 * already had.
 */
const SOLD_AT_MAX_BACKDATE_MS = 14 * 24 * 60 * 60 * 1000
const SOLD_AT_MAX_SKEW_MS = 5 * 60 * 1000
function resolveSoldAt(raw: unknown, now = new Date()): Date {
  if (raw == null || raw === '') return now
  const t = new Date(String(raw))
  const ms = t.getTime()
  if (!Number.isFinite(ms)) return now
  if (ms > now.getTime() + SOLD_AT_MAX_SKEW_MS) return now
  if (ms < now.getTime() - SOLD_AT_MAX_BACKDATE_MS) return now
  return t
}

// Performs FIFO stock deduction and creates a PAID Bill row inside a tx.
// Throws { code: 'INSUFFICIENT_STOCK' | 'PRODUCT_NOT_FOUND', ... } on failure.
async function createBillCore(tx: TxClient, args: CreateBillArgs, billNumber?: string) {
  // Allocated inside the tx: if the sale rolls back, the number is released.
  const invoiceNumber = billNumber || (await allocateNumber(tx, 'INV'))
  // The moment of sale, not the moment of arrival. Everything dated off the
  // bill — the day's takings, credit ageing, warranty cover — hangs on this.
  const soldAt = args.soldAt ?? new Date()
  type FinalLine = {
    productId: string; itemCode: string; productName: string; unitOfMeasure: string
    quantity: number; unitRate: number; gstPercentage: number
    lineDiscountPct: number; lineDiscountAmt: number
    lineGstAmount: number; lineTotal: number
    billDiscountAmt: number; taxableValue: number
    cgstAmount: number; sgstAmount: number; igstAmount: number
    /** Which batches this line was taken from, oldest first. */
    allocations: { batchId: string; quantity: number; unitCost: number }[]
    warrantyPeriodDays: number
  }
  const lines: FinalLine[] = []

  for (const rawItem of args.items) {
    const product = await tx.product.findUnique({ where: { id: rawItem.productId } })
    if (!product) throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })

    // A deactivated product must not be sellable through the API just because
    // it is still reachable by id.
    if (!product.isActive) {
      throw Object.assign(new Error('PRODUCT_INACTIVE'), {
        code: 'PRODUCT_INACTIVE', productName: product.name
      })
    }

    // Price and tax come from the product master, never from the request.
    //
    // These used to be taken from the request body unchecked, which meant
    // anyone who could reach the API could bill any item at any price: a
    // 100% line discount, or a unit rate of 1, emptied the stock room for
    // nothing and left a clean PAID invoice behind. A stale terminal mirror
    // did the same thing accidentally. A genuine price override is still
    // possible, but only a super admin may ask for one.
    const catalogueRate = round2(Number(product.sellingRate))
    const requestedRate = round2(Number(rawItem.unitRate))
    const wantsOverride =
      Number.isFinite(requestedRate) && requestedRate >= 0 && requestedRate !== catalogueRate

    if (wantsOverride && !args.allowPriceOverride) {
      throw Object.assign(new Error('PRICE_OVERRIDE_NOT_ALLOWED'), {
        code: 'PRICE_OVERRIDE_NOT_ALLOWED',
        productName: product.name,
        catalogueRate,
        requestedRate
      })
    }
    const unitRate = wantsOverride ? requestedRate : catalogueRate

    // Discounts are bounded so they cannot be used as a back door to the
    // same result the rate check just closed.
    const lineDiscountPct = Number(rawItem.lineDiscountPct) || 0
    const lineDiscountAmt = Number(rawItem.lineDiscountAmt) || 0
    if (lineDiscountPct < 0 || lineDiscountPct > MAX_LINE_DISCOUNT_PCT) {
      throw Object.assign(new Error('INVALID_LINE_DISCOUNT'), {
        code: 'INVALID_LINE_DISCOUNT', productName: product.name,
        maxPercent: MAX_LINE_DISCOUNT_PCT
      })
    }

    // Cut-length products bill in fractions of their unit; everything else is
    // floored to whole pieces regardless of what the client sent.
    const item = {
      ...rawItem,
      quantity: parseQty(rawItem.quantity, product.sellMode),
      unitRate,
      // The statutory rate for this product. A wrong rate here is a filing
      // offence for the shop, so it is not the client's to choose.
      gstPercentage: round2(Number(product.gstPercentage)),
      lineDiscountPct,
      lineDiscountAmt
    }
    if (item.quantity <= 0) {
      throw Object.assign(new Error('INVALID_QUANTITY'), {
        code: 'INVALID_QUANTITY', productName: product.name
      })
    }

    const maxFlatDiscount = round2(item.quantity * unitRate * (MAX_LINE_DISCOUNT_PCT / 100))
    if (lineDiscountAmt < 0 || lineDiscountAmt > maxFlatDiscount) {
      throw Object.assign(new Error('INVALID_LINE_DISCOUNT'), {
        code: 'INVALID_LINE_DISCOUNT', productName: product.name,
        maxAmount: maxFlatDiscount
      })
    }

    const stockAgg = await tx.productBatch.aggregate({
      where: { productId: item.productId, isActive: true, currentQty: { gt: 0 } },
      _sum: { currentQty: true }
    })
    const available = roundQty(Number(stockAgg._sum.currentQty ?? 0))
    if (available < item.quantity) {
      throw Object.assign(
        new Error('INSUFFICIENT_STOCK'),
        { code: 'INSUFFICIENT_STOCK', productName: product.name, available, requested: item.quantity }
      )
    }

    const batches = await tx.productBatch.findMany({
      where: { productId: item.productId, isActive: true, currentQty: { gt: 0 } },
      orderBy: { receivedDate: 'asc' }
    })
    let remaining = item.quantity
    const allocations: { batchId: string; quantity: number; unitCost: number }[] = []
    for (const batch of batches) {
      if (remaining <= 0) break
      const batchQty = Number(batch.currentQty)
      const want = roundQty(Math.min(batchQty, remaining))
      if (want <= 0) continue

      // Deduct conditionally, in one statement, so the database decides
      // whether the stock was there.
      //
      // Reading the quantity and then writing back the difference let two
      // tills selling the last unit both pass the availability check and both
      // write the same result: two bills, one unit, no error, and a
      // discrepancy nobody sees until a stock count. The WHERE clause makes
      // that impossible — the loser simply updates no rows.
      // The quantity is bound as text and cast, not as a JS number. Prisma
      // binds 3 as an integer and 2.75 as a double, and a prepared statement
      // keeps whichever type it saw first — so a fractional quantity landing
      // on a connection that had already run a whole one failed with a bind
      // format error, intermittently and only for cut-length products.
      const wantParam = want.toFixed(3)
      const taken = await tx.$executeRaw`
        UPDATE "ProductBatch"
           SET "currentQty" = "currentQty" - ${wantParam}::numeric,
               "updatedAt"  = NOW()
         WHERE "id" = ${batch.id}
           AND "currentQty" >= ${wantParam}::numeric
      `
      if (taken === 0) continue // another till took it first; try the next batch

      // Remembering the split is what lets a later return put the goods back
      // where they came from, and gives this line a true cost of goods.
      allocations.push({
        batchId: batch.id,
        quantity: want,
        unitCost: round2(Number(batch.purchaseRate))
      })
      remaining = roundQty(remaining - want)
    }

    // The pre-check above is advisory; this is the authoritative one. If a
    // concurrent sale drained the batches between the two, we get here short
    // and the whole transaction rolls back rather than shipping goods that
    // were never in stock.
    if (remaining > 0) {
      throw Object.assign(new Error('INSUFFICIENT_STOCK'), {
        code: 'INSUFFICIENT_STOCK',
        productName: product.name,
        available: roundQty(item.quantity - remaining),
        requested: item.quantity
      })
    }

    const base = item.quantity * item.unitRate
    const pctDisc = base * (item.lineDiscountPct / 100)
    const flatDisc = item.lineDiscountAmt
    const lineTotal = round2(Math.max(0, base - pctDisc - flatDisc))

    lines.push({
      productId: item.productId,
      itemCode: product.itemCode,
      productName: product.name,
      unitOfMeasure: product.unitOfMeasure,
      quantity: item.quantity,
      unitRate: item.unitRate,
      gstPercentage: item.gstPercentage,
      lineDiscountPct: item.lineDiscountPct,
      lineDiscountAmt: item.lineDiscountAmt,
      // Tax is derived below, once the bill-level discount has been shared out.
      lineGstAmount: 0,
      lineTotal,
      billDiscountAmt: 0,
      taxableValue: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      allocations,
      warrantyPeriodDays: product.warrantyPeriodDays
    })
  }

  const { interState, placeOfSupply } = await resolveTaxContext(tx, args.customerId)
  const totals = computeInvoiceTotals(lines, args.discountAmount, interState)
  lines.forEach((l, i) => {
    const t = totals.lines[i]
    l.billDiscountAmt = t.billDiscountAmt
    l.lineGstAmount = t.gstAmount
    l.taxableValue = t.taxableValue
    l.cgstAmount = t.cgstAmount
    l.sgstAmount = t.sgstAmount
    l.igstAmount = t.igstAmount
  })
  const { subtotal, billDiscount, totalAmount, taxableValue, gstAmount, cgstAmount, sgstAmount, igstAmount } = totals
  // What was actually handed over decides how much is still owed.
  const tenders: Tender[] = args.settleInFull
    ? [{ method: args.paymentMethod, amount: totalAmount }]
    : args.tenders

  // Credit carried from a refund is not money that changed hands, so it
  // settles the bill without appearing as a tender in the payments ledger.
  const creditApplied = round2(Math.min(Math.max(0, args.creditApplied ?? 0), totalAmount))
  const settlement = settle(round2(totalAmount - creditApplied), tenders)

  const customer = args.customerId
    ? await tx.customer.findUnique({
        where: { id: args.customerId },
        select: { id: true, name: true, creditLimit: true, creditDays: true }
      })
    : null
  const creditDays = customer ? Number(customer.creditDays) : 0

  if (settlement.balanceDue > 0) {
    const currentOutstanding = customer ? await outstandingFor(tx, customer.id) : 0
    const credit = checkCredit({
      hasCustomer: Boolean(customer),
      creditLimit: customer ? Number(customer.creditLimit) : 0,
      currentOutstanding,
      newBalance: settlement.balanceDue
    })

    // A super-admin may wave a customer past their limit, but nobody can put a
    // balance on a walk-in — there would be nobody to chase for it.
    const overridden = credit.needsOverride && args.allowCreditOverride
    if (!credit.allowed && !overridden) {
      throw Object.assign(new Error('CREDIT_NOT_ALLOWED'), {
        code: 'CREDIT_NOT_ALLOWED',
        reason: credit.reason,
        customerName: customer?.name,
        ...credit
      })
    }
  }

  const changeGiven = settlement.changeGiven > 0 ? settlement.changeGiven : null

  const created = await tx.bill.create({
    data: {
      billNumber: invoiceNumber,
      clientLocalId: args.clientLocalId,
      status: settlement.status,
      customerId: args.customerId,
      originDeviceId: args.originDeviceId,
      cashierId: args.cashierId,
      subtotal,
      gstAmount,
      discountAmount: billDiscount,
      totalAmount,
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      placeOfSupply,
      paymentMethod: tenders[0]?.method ?? args.paymentMethod,
      amountReceived: settlement.tendered > 0 ? settlement.tendered : null,
      changeGiven,
      paidAmount: round2(settlement.paidAmount + creditApplied),
      balanceDue: settlement.balanceDue,
      paidAt: soldAt,
      dueDate: settlement.balanceDue > 0 ? dueDateFor(soldAt, creditDays) : null,
      notes: args.notes,
      payments: {
        create: tenders.map((t) => ({
          customerId: args.customerId,
          amount: t.amount,
          method: t.method,
          reference: t.reference ?? null,
          isSettlement: false,
          collectedById: args.cashierId
        }))
      },
      items: {
        create: lines.map(({ allocations, warrantyPeriodDays: _w, ...line }) => ({
          ...line,
          batchAllocations: { create: allocations }
        }))
      }
    },
    include: { customer: { select: { name: true } }, items: true }
  })
  // Cover starts the moment the sale is made, so it is created here rather
  // than later from a report — a warranty that has to be remembered into
  // existence is one that gets forgotten. Lines are created in order, so
  // they pair with `lines` by index.
  for (const [i, line] of lines.entries()) {
    if (line.warrantyPeriodDays <= 0) continue
    const item = created.items[i]
    if (!item) continue
    await tx.warranty.create({
      data: {
        productId: line.productId,
        billId: created.id,
        billItemId: item.id,
        customerId: args.customerId,
        purchaseDate: soldAt,
        expiryDate: expiryDateFor(soldAt, line.warrantyPeriodDays)
      }
    })
  }

  // Emit one bill-upsert + one product-upsert per affected product so terminals
  // see the new totalStock without polling.
  await emitBillUpsert(tx, created)
  await emitProductUpsertBulk(tx, lines.map((l) => l.productId))
  return created
}

type ReturnLineRequest = { billItemId: string; quantity: number }
type ProcessReturnArgs = {
  originalBillId: string
  returnItems: ReturnLineRequest[]
  reason: string | null
  reasonCode: string | null
  cashierId: string
  originDeviceId: string
  billNumber?: string
}

/**
 * Works out which batches returned goods belong back in.
 *
 * A sale records the batches it took from, so a return can reverse exactly
 * that split rather than guessing. Quantities already returned against the
 * same line are subtracted first, so returning three units twice cannot put
 * six back into a batch that only gave three.
 *
 * Bills written before allocations were recorded have nothing to reverse; for
 * those we fall back to the newest active batch, which is what the old code
 * always did.
 */
async function planRestock(
  tx: TxClient,
  originalBillItemId: string,
  productId: string,
  quantity: number
): Promise<{ batchId: string; quantity: number; unitCost: number }[]> {
  const taken = await tx.billItemBatch.findMany({
    where: { billItemId: originalBillItemId },
    orderBy: { createdAt: 'asc' }
  })

  if (taken.length === 0) {
    const batch = await tx.productBatch.findFirst({
      where: { productId, isActive: true },
      orderBy: { receivedDate: 'desc' }
    })
    return batch
      ? [{ batchId: batch.id, quantity, unitCost: round2(Number(batch.purchaseRate)) }]
      : []
  }

  // How much has already gone back into each batch for this line.
  const priorReturns = await tx.billItemBatch.findMany({
    where: { billItem: { originalBillItemId, bill: { status: 'RETURN' } } },
    select: { batchId: true, quantity: true }
  })
  const returnedByBatch = new Map<string, number>()
  for (const r of priorReturns) {
    returnedByBatch.set(r.batchId, roundQty((returnedByBatch.get(r.batchId) ?? 0) + Number(r.quantity)))
  }

  const plan: { batchId: string; quantity: number; unitCost: number }[] = []
  let left = roundQty(quantity)
  for (const alloc of taken) {
    if (left <= 0) break
    const capacity = roundQty(Number(alloc.quantity) - (returnedByBatch.get(alloc.batchId) ?? 0))
    if (capacity <= 0) continue
    const put = roundQty(Math.min(capacity, left))
    plan.push({ batchId: alloc.batchId, quantity: put, unitCost: round2(Number(alloc.unitCost)) })
    left = roundQty(left - put)
  }

  // Anything left over (only possible if the sale's own records are short)
  // goes back into the batch it was most likely taken from.
  if (left > 0 && plan.length > 0) {
    plan[plan.length - 1].quantity = roundQty(plan[plan.length - 1].quantity + left)
  }
  return plan
}

// Performs the return half of a refund/exchange inside a tx. Validates against
// already-returned qty per line; restocks; creates a RETURN bill.
// Throws { code: 'ORIGINAL_NOT_PAID' | 'BILL_ITEM_NOT_IN_ORIGINAL' | 'RETURN_QTY_EXCEEDS_REMAINING' | 'NO_RETURN_LINES', ... }.
async function processReturnCore(tx: TxClient, args: ProcessReturnArgs) {
  // Lock first: the already-returned tally below decides how much may still
  // come back, and two concurrent returns reading it unlocked both passed.
  await lockBill(tx, args.originalBillId)

  const original = await tx.bill.findUnique({
    where: { id: args.originalBillId },
    include: { items: true }
  })
  if (!original) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
  // A part-paid or credit bill can be returned against too; the refund comes
  // off what is still owed before any cash changes hands.
  if (!['PAID', 'PARTIAL', 'CREDIT'].includes(original.status)) {
    throw Object.assign(new Error('ORIGINAL_NOT_PAID'), { code: 'ORIGINAL_NOT_PAID', currentStatus: original.status })
  }

  const priorReturnLines = await tx.billItem.findMany({
    where: {
      originalBillItemId: { in: original.items.map((i) => i.id) },
      bill: { status: 'RETURN' }
    },
    select: { originalBillItemId: true, quantity: true }
  })
  const alreadyReturned = new Map<string, number>()
  for (const r of priorReturnLines) {
    if (!r.originalBillItemId) continue
    alreadyReturned.set(
      r.originalBillItemId,
      roundQty((alreadyReturned.get(r.originalBillItemId) ?? 0) + Number(r.quantity))
    )
  }

  const reqByItem = new Map<string, number>()
  for (const r of args.returnItems) {
    const qty = roundQty(Number(r.quantity))
    if (!r.billItemId || !Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('INVALID_RETURN_LINE'), { code: 'INVALID_RETURN_LINE' })
    }
    reqByItem.set(r.billItemId, (reqByItem.get(r.billItemId) ?? 0) + qty)
  }
  if (reqByItem.size === 0) throw Object.assign(new Error('NO_RETURN_LINES'), { code: 'NO_RETURN_LINES' })

  type FinalReturnLine = {
    originalItem: typeof original.items[number]
    quantity: number
    lineTotal: number
    lineGstAmount: number
    lineDiscountPct: number
    lineDiscountAmt: number
    billDiscountAmt: number
    taxableValue: number
    cgstAmount: number
    sgstAmount: number
    igstAmount: number
    /** Where the goods were put back, mirroring the sale's own split. */
    restockPlan: { batchId: string; quantity: number; unitCost: number }[]
  }
  const returnLines: FinalReturnLine[] = []

  for (const [billItemId, qty] of reqByItem) {
    const orig = original.items.find((i) => i.id === billItemId)
    if (!orig) {
      throw Object.assign(new Error('BILL_ITEM_NOT_IN_ORIGINAL'), { code: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId })
    }
    const remaining = roundQty(Number(orig.quantity) - (alreadyReturned.get(orig.id) ?? 0))
    if (qty > remaining) {
      throw Object.assign(new Error('RETURN_QTY_EXCEEDS_REMAINING'),
        { code: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId, requested: qty, remaining })
    }

    const ratio = qty / Number(orig.quantity)
    returnLines.push({
      originalItem: orig,
      quantity: qty,
      lineTotal: round2(Number(orig.lineTotal) * ratio),
      lineDiscountPct: Number(orig.lineDiscountPct),
      lineDiscountAmt: round2(Number(orig.lineDiscountAmt) * ratio),
      // Tax is re-derived below from the refunded amount rather than pro-rated
      // from the original, so credit notes for bills written before the
      // tax-invoice fields existed still come out correct.
      lineGstAmount: 0,
      billDiscountAmt: 0,
      taxableValue: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      restockPlan: []
    })
  }

  // Goods that came back broken must not go back on the shelf — they would
  // only be sold again. The credit note still records the quantity, which is
  // what makes the loss visible in reporting.
  const restock = shouldRestock(args.reasonCode)

  if (restock) {
    for (const l of returnLines) {
      l.restockPlan = await planRestock(tx, l.originalItem.id, l.originalItem.productId, l.quantity)
      for (const put of l.restockPlan) {
        await tx.productBatch.update({
          where: { id: put.batchId },
          data: { currentQty: { increment: put.quantity } }
        })
      }
    }
  }

  const subtotal = round2(returnLines.reduce((s, l) => s + l.lineTotal, 0))
  const origSubtotal = Number(original.subtotal) || 0
  const origDiscount = Number(original.discountAmount) || 0
  const discountAmount = round2(origSubtotal > 0 ? origDiscount * (subtotal / origSubtotal) : 0)
  const { interState, placeOfSupply } = await resolveTaxContext(tx, original.customerId)

  // A credit note is calculated exactly like a sale, so it mirrors the invoice
  // it refunds. Tax is re-derived rather than pro-rated from the original,
  // which also fixes returns against bills written before these fields existed.
  const refundTotals = computeInvoiceTotals(
    returnLines.map((l) => ({
      lineTotal: l.lineTotal,
      gstPercentage: Number(l.originalItem.gstPercentage)
    })),
    discountAmount,
    interState
  )
  returnLines.forEach((l, i) => {
    const t = refundTotals.lines[i]
    l.billDiscountAmt = t.billDiscountAmt
    l.lineGstAmount = t.gstAmount
    l.taxableValue = t.taxableValue
    l.cgstAmount = t.cgstAmount
    l.sgstAmount = t.sgstAmount
    l.igstAmount = t.igstAmount
  })
  const { totalAmount, taxableValue, gstAmount, cgstAmount, sgstAmount, igstAmount } = refundTotals

  const created = await tx.bill.create({
    data: {
      billNumber: args.billNumber || (await allocateNumber(tx, 'CN')),
      status: 'RETURN',
      customerId: original.customerId,
      originDeviceId: args.originDeviceId,
      cashierId: args.cashierId,
      subtotal,
      gstAmount,
      discountAmount,
      totalAmount,
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      placeOfSupply,
      paymentMethod: original.paymentMethod,
      amountReceived: null,
      changeGiven: null,
      notes: args.reason ? `Return: ${args.reason}` : 'Return',
      originalBillId: original.id,
      returnReason: args.reason || null,
      returnReasonCode: args.reasonCode || null,
      items: {
        create: returnLines.map((l) => ({
          productId: l.originalItem.productId,
          itemCode: l.originalItem.itemCode,
          productName: l.originalItem.productName,
          unitOfMeasure: l.originalItem.unitOfMeasure,
          quantity: l.quantity,
          unitRate: l.originalItem.unitRate,
          gstPercentage: l.originalItem.gstPercentage,
          lineDiscountPct: l.lineDiscountPct,
          lineDiscountAmt: l.lineDiscountAmt,
          lineGstAmount: l.lineGstAmount,
          lineTotal: l.lineTotal,
          billDiscountAmt: l.billDiscountAmt,
          taxableValue: l.taxableValue,
          cgstAmount: l.cgstAmount,
          sgstAmount: l.sgstAmount,
          igstAmount: l.igstAmount,
          originalBillItemId: l.originalItem.id,
          batchAllocations: { create: l.restockPlan }
        }))
      }
    },
    include: { customer: { select: { name: true, phone: true } }, items: true }
  })
  await emitBillUpsert(tx, created)
  await emitProductUpsertBulk(
    tx,
    returnLines.map((l) => l.originalItem.productId)
  )
  // Returning goods against an unsettled bill reduces what the customer owes
  // rather than handing back money they never paid.
  await recomputeBillSettlement(tx, original.id)
  return created
}

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
    const { customerId, billId, limit = '50', offset = '0' } = req.query
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
        take: parseInt(String(limit)),
        skip: parseInt(String(offset))
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

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializePurchaseOrder(po: any): any {
  const items = (po.items ?? []).map((i: any) => ({
    ...i,
    orderedQty: Number(i.orderedQty),
    receivedQty: Number(i.receivedQty),
    pendingQty: roundQty(Number(i.orderedQty) - Number(i.receivedQty)),
    expectedRate: Number(i.expectedRate),
    gstPercentage: Number(i.gstPercentage),
    lineTotal: round2(Number(i.orderedQty) * Number(i.expectedRate))
  }))
  return {
    ...po,
    items,
    itemCount: items.length,
    orderTotal: round2(items.reduce((s: number, i: any) => s + i.lineTotal, 0))
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
    const { status, supplierId, limit = '50', offset = '0' } = req.query
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
        take: parseInt(String(limit)),
        skip: parseInt(String(offset))
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

const WARRANTY_INCLUDE = {
  product: { select: { itemCode: true, name: true, unitOfMeasure: true, warrantyPeriodDays: true } },
  bill: { select: { billNumber: true, paidAt: true, status: true } },
  billItem: { select: { quantity: true, unitRate: true, lineTotal: true } },
  customer: { select: { id: true, name: true, phone: true } },
  claimedBy: { select: { username: true } },
  resolvedBy: { select: { username: true } }
} as const

/* eslint-disable @typescript-eslint/no-explicit-any */
function serializeWarranty(w: any, now = new Date()): any {
  return {
    ...w,
    status: effectiveStatus(w.status, w.expiryDate, now),
    storedStatus: w.status,
    daysUntilExpiry: daysUntilExpiry(w.expiryDate, now),
    billItem: w.billItem
      ? {
          quantity: Number(w.billItem.quantity),
          unitRate: Number(w.billItem.unitRate),
          lineTotal: Number(w.billItem.lineTotal)
        }
      : undefined
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Lists cover. `status` filters on the *effective* status, so "EXPIRED" is
 * a date test rather than a stored value and "ACTIVE" excludes what has
 * lapsed.
 */
app.get('/api/v1/warranties', requireAuth(), async (req, res) => {
  try {
    const { status, search, customerId, limit = '50', offset = '0' } = req.query
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
        take: parseInt(String(limit)),
        skip: parseInt(String(offset))
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

function getServerMac(): string {
  const ifaces = os.networkInterfaces()
  for (const iface of Object.values(ifaces)) {
    for (const info of iface ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac
      }
    }
  }
  return '00:00:00:00:00:00'
}

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
    return res.json({ success: true, events, nextCursor, hasMore })
  } catch (err) {
    console.error('Error in /sync/pull:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Server Export ────────────────────────────────────────────────────────────

export function startExpressServer(port: number = parseInt(process.env.LOCAL_SERVER_PORT || '52001')): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Local Express server running on port ${port} (all interfaces)`)
      resolve(port)
    })
    server.on('error', (err) => {
      console.error(`Failed to bind port ${port}:`, err)
      reject(err)
    })
  })
}
