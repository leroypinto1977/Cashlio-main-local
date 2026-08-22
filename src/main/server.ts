import express, { Request, Response, NextFunction } from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
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

declare global {
  namespace Express {
    interface Request {
      user?: { userId: string; role: string }
    }
  }
}

const prisma = new PrismaClient()
const app = express()

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]
type DbClient = TxClient | typeof prisma

app.use(cors())
app.use(express.json())

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

function requireAuth(roles?: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'UNAUTHORIZED' })
    }
    try {
      const decoded = jwt.verify(
        authHeader.slice(7),
        process.env.JWT_SECRET as string
      ) as { userId: string; role: string }
      req.user = decoded
      if (roles && !roles.includes(decoded.role)) {
        return res.status(403).json({ success: false, error: 'FORBIDDEN' })
      }
      return next()
    } catch {
      return res.status(401).json({ success: false, error: 'INVALID_TOKEN' })
    }
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

async function nextBatchCode(): Promise<string> {
  const now = new Date()
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const prefix = `B${yyyy}-${mm}-`

  // Count batches already created this month
  const startOfMonth = new Date(yyyy, now.getMonth(), 1)
  const endOfMonth = new Date(yyyy, now.getMonth() + 1, 0, 23, 59, 59, 999)
  const count = await prisma.productBatch.count({
    where: { createdAt: { gte: startOfMonth, lte: endOfMonth } }
  })

  const seq = String(count + 1).padStart(3, '0')
  return `${prefix}${seq}`
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
      data: { username: String(adminUsername).trim(), passwordHash, role: 'SUPER_ADMIN' }
    })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Error in setup-profile:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/system/pair-client', async (req, res) => {
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

    const currentClients = await prisma.authorizedClient.count()
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

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body
    const user = await prisma.user.findUnique({ where: { username } })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' })
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET as string,
      { expiresIn: '12h' }
    )

    return res.status(200).json({ success: true, token })
  } catch (err) {
    console.error('Error in /login:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.get('/api/v1/system/authorized-clients', async (_req, res) => {
  try {
    const clients = await prisma.authorizedClient.findMany({ orderBy: { authorizedAt: 'desc' } })
    return res.status(200).json({ success: true, clients })
  } catch (err) {
    console.error('Error fetching authorized clients:', err)
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
      const mappedBatches = p.batches.map((b) => ({
        ...b,
        purchaseRate: Number(b.purchaseRate)
      }))
      return {
        ...p,
        totalStock: p.batches.reduce((sum, b) => sum + b.currentQty, 0),
        batchCount: mappedBatches.length,
        latestBatch: mappedBatches[0] ?? null,
        batches: mappedBatches,
        sellingRate: Number(p.sellingRate),
        gstPercentage: Number(p.gstPercentage)
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

    const mappedBatches = product.batches.map((b) => ({ ...b, purchaseRate: Number(b.purchaseRate) }))
    return res.json({
      success: true,
      product: {
        ...product,
        totalStock: product.batches.reduce((sum, b) => sum + b.currentQty, 0),
        sellingRate: Number(product.sellingRate),
        gstPercentage: Number(product.gstPercentage),
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
      itemCode, brand, name, specification, categoryId, productType,
      unitOfMeasure, sellingRate, gstPercentage, warrantyPeriodDays, minStockLevel, supplierIds
    } = req.body

    if (!itemCode || !name || !categoryId) {
      return res.status(400).json({ success: false, error: 'ITEM_CODE_NAME_CATEGORY_REQUIRED' })
    }

    const product = await prisma.$transaction(async (tx) => {
      const created = await tx.product.create({
        data: {
          itemCode,
          brand,
          name,
          specification,
          categoryId,
          productType,
          unitOfMeasure: unitOfMeasure || 'pcs',
          sellingRate: sellingRate ?? 0,
          gstPercentage: gstPercentage ?? 0,
          warrantyPeriodDays: warrantyPeriodDays ?? 0,
          minStockLevel: minStockLevel ?? 0,
          suppliers: supplierIds?.length
            ? { create: supplierIds.map((sid: string, i: number) => ({ supplierId: sid, isDefault: i === 0 })) }
            : undefined
        },
        include: { category: true }
      })
      await emitProductUpsert(tx, created.id)
      return created
    })

    return res.status(201).json({ success: true, product: { ...product, sellingRate: Number(product.sellingRate), gstPercentage: Number(product.gstPercentage) } })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'ITEM_CODE_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.put('/api/v1/products/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const {
      brand, name, specification, categoryId, productType,
      unitOfMeasure, sellingRate, gstPercentage, warrantyPeriodDays, minStockLevel, isActive
    } = req.body

    const product = await prisma.$transaction(async (tx) => {
      const updated = await tx.product.update({
        where: { id: String(req.params.id) },
        data: {
          brand, name, specification, categoryId, productType,
          unitOfMeasure, sellingRate, gstPercentage, warrantyPeriodDays, minStockLevel, isActive
        },
        include: { category: true }
      })
      await emitProductUpsert(tx, updated.id)
      return updated
    })

    return res.json({ success: true, product: { ...product, sellingRate: Number(product.sellingRate), gstPercentage: Number(product.gstPercentage) } })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
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
      batches: batches.map((b) => ({
        ...b,
        purchaseRate: Number(b.purchaseRate)
      }))
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
      supplierId, warehouseId, receivedDate, notes
    } = req.body

    if (!purchaseRate || !receivedQty) {
      return res.status(400).json({ success: false, error: 'PURCHASE_RATE_AND_QTY_REQUIRED' })
    }

    const batchCode = rawBatchCode?.trim() || (await nextBatchCode())
    const uniqueStockCode = `${product.itemCode}/${batchCode}`

    const batch = await prisma.$transaction(async (tx) => {
      const created = await tx.productBatch.create({
        data: {
          productId: String(req.params.id),
          batchCode,
          uniqueStockCode,
          purchaseRate,
          receivedQty: Number(receivedQty),
          currentQty: Number(receivedQty),
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

    return res.status(201).json({
      success: true,
      batch: { ...batch, purchaseRate: Number(batch.purchaseRate) }
    })
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
    const { purchaseRate, notes, isActive, warehouseId, supplierId, receivedDate, receivedQty } = req.body
    const batch = await prisma.$transaction(async (tx) => {
      const updated = await tx.productBatch.update({
        where: { id: String(req.params.batchId) },
        data: {
          purchaseRate, notes, isActive, warehouseId,
          supplierId: supplierId || null,
          receivedDate: receivedDate ? new Date(receivedDate) : undefined,
          receivedQty: receivedQty !== undefined ? Number(receivedQty) : undefined
        },
        include: { warehouse: true, supplier: true }
      })
      // isActive or receivedQty changes affect totalStock the terminal sees.
      await emitProductUpsert(tx, updated.productId)
      return updated
    })
    return res.json({
      success: true,
      batch: { ...batch, purchaseRate: Number(batch.purchaseRate) }
    })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Phase 3 — Customers ──────────────────────────────────────────────────────

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
      return res.json({ success: true, customers, total: customers.length })
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
    return res.json({ success: true, customers, total })
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
    const { name, phone, email, address, gstin } = req.body

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
          gstin: gstCheck.value || null
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
    const { name, phone, email, address, gstin, isActive } = req.body
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
            paidAt: true, returnReason: true,
            items: { select: { originalBillItemId: true, quantity: true } }
          },
          orderBy: { createdAt: 'asc' }
        },
        items: {
          include: {
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
        returnedByLineId.set(it.originalBillItemId, (returnedByLineId.get(it.originalBillItemId) ?? 0) + it.quantity)
      }
    }

    return res.json({
      success: true,
      bill: {
        ...bill,
        subtotal: Number(bill.subtotal),
        gstAmount: Number(bill.gstAmount),
        discountAmount: Number(bill.discountAmount),
        totalAmount: Number(bill.totalAmount),
        amountReceived: bill.amountReceived ? Number(bill.amountReceived) : null,
        changeGiven: bill.changeGiven ? Number(bill.changeGiven) : null,
        returns: bill.returns.map((r) => ({
          id: r.id,
          billNumber: r.billNumber,
          status: r.status,
          totalAmount: Number(r.totalAmount),
          paidAt: r.paidAt,
          returnReason: r.returnReason
        })),
        items: bill.items.map((it) => ({
          ...serializeBillItem(it),
          purchaseRate: it.product.batches[0] ? Number(it.product.batches[0].purchaseRate) : null,
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
  paymentMethod: 'CASH' | 'UPI' | 'CARD'
  amountReceived: number | null
  discountAmount: number
  notes: string | null
  clientLocalId: string | null
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

// Performs FIFO stock deduction and creates a PAID Bill row inside a tx.
// Throws { code: 'INSUFFICIENT_STOCK' | 'PRODUCT_NOT_FOUND', ... } on failure.
async function createBillCore(tx: TxClient, args: CreateBillArgs, billNumber: string) {
  type FinalLine = {
    productId: string; itemCode: string; productName: string; unitOfMeasure: string
    quantity: number; unitRate: number; gstPercentage: number
    lineDiscountPct: number; lineDiscountAmt: number
    lineGstAmount: number; lineTotal: number
  }
  const lines: FinalLine[] = []

  for (const item of args.items) {
    const product = await tx.product.findUnique({ where: { id: item.productId } })
    if (!product) throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })

    const stockAgg = await tx.productBatch.aggregate({
      where: { productId: item.productId, isActive: true, currentQty: { gt: 0 } },
      _sum: { currentQty: true }
    })
    const available = stockAgg._sum.currentQty ?? 0
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
    for (const batch of batches) {
      if (remaining <= 0) break
      const deduct = Math.min(batch.currentQty, remaining)
      await tx.productBatch.update({
        where: { id: batch.id },
        data: { currentQty: batch.currentQty - deduct }
      })
      remaining -= deduct
    }

    const base = item.quantity * item.unitRate
    const pctDisc = base * (item.lineDiscountPct / 100)
    const flatDisc = item.lineDiscountAmt
    const lineTotal = Math.max(0, base - pctDisc - flatDisc)
    const lineGstAmount = lineTotal * item.gstPercentage / (100 + item.gstPercentage)

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
      igstAmount: 0
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
  const changeGiven = args.paymentMethod === 'CASH' && args.amountReceived != null
    ? round2(Math.max(0, args.amountReceived - totalAmount))
    : null

  const created = await tx.bill.create({
    data: {
      billNumber: invoiceNumber,
      clientLocalId: args.clientLocalId,
      status: 'PAID',
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
      paymentMethod: args.paymentMethod,
      amountReceived: args.paymentMethod === 'CASH' && args.amountReceived != null ? args.amountReceived : null,
      changeGiven,
      notes: args.notes,
      items: { create: lines }
    },
    include: { customer: { select: { name: true } }, items: true }
  })
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
  cashierId: string
  originDeviceId: string
  billNumber?: string
}

// Performs the return half of a refund/exchange inside a tx. Validates against
// already-returned qty per line; restocks; creates a RETURN bill.
// Throws { code: 'ORIGINAL_NOT_PAID' | 'BILL_ITEM_NOT_IN_ORIGINAL' | 'RETURN_QTY_EXCEEDS_REMAINING' | 'NO_RETURN_LINES', ... }.
async function processReturnCore(tx: TxClient, args: ProcessReturnArgs) {
  const original = await tx.bill.findUnique({
    where: { id: args.originalBillId },
    include: { items: true }
  })
  if (!original) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
  if (original.status !== 'PAID') {
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
    alreadyReturned.set(r.originalBillItemId, (alreadyReturned.get(r.originalBillItemId) ?? 0) + r.quantity)
  }

  const reqByItem = new Map<string, number>()
  for (const r of args.returnItems) {
    const qty = Math.floor(Number(r.quantity))
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
  }
  const returnLines: FinalReturnLine[] = []

  for (const [billItemId, qty] of reqByItem) {
    const orig = original.items.find((i) => i.id === billItemId)
    if (!orig) {
      throw Object.assign(new Error('BILL_ITEM_NOT_IN_ORIGINAL'), { code: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId })
    }
    const remaining = orig.quantity - (alreadyReturned.get(orig.id) ?? 0)
    if (qty > remaining) {
      throw Object.assign(new Error('RETURN_QTY_EXCEEDS_REMAINING'),
        { code: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId, requested: qty, remaining })
    }

    const ratio = qty / orig.quantity
    returnLines.push({
      originalItem: orig,
      quantity: qty,
      lineTotal: Number(orig.lineTotal) * ratio,
      lineGstAmount: Number(orig.lineGstAmount) * ratio,
      lineDiscountPct: Number(orig.lineDiscountPct),
      lineDiscountAmt: Number(orig.lineDiscountAmt) * ratio
    })
  }

  // Restock: most-recently-received active batch per product
  for (const l of returnLines) {
    const batch = await tx.productBatch.findFirst({
      where: { productId: l.originalItem.productId, isActive: true },
      orderBy: { receivedDate: 'desc' }
    })
    if (batch) {
      await tx.productBatch.update({
        where: { id: batch.id },
        data: { currentQty: { increment: l.quantity } }
      })
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
          originalBillItemId: l.originalItem.id
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
  return created
}

app.post('/api/v1/bills', requireActiveLicense(), requireAuth(), async (req, res) => {
  try {
    const {
      customerId, originDeviceId, items, discountAmount = 0,
      paymentMethod, amountReceived, notes, clientLocalId
    } = req.body

    if (!originDeviceId) {
      return res.status(400).json({ success: false, error: 'ORIGIN_DEVICE_REQUIRED' })
    }
    if (!paymentMethod || !['CASH', 'UPI', 'CARD'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, error: 'INVALID_PAYMENT_METHOD' })
    }
    if (!items || items.length === 0) {
      return res.status(400).json({ success: false, error: 'BILL_ITEMS_REQUIRED' })
    }

    // Idempotency: if this clientLocalId was already processed, return the existing bill
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

    const bill = await prisma.$transaction((tx) => createBillCore(tx, {
      items: items as IncomingSaleItem[],
      customerId: customerId || null,
      originDeviceId,
      cashierId,
      paymentMethod,
      amountReceived: amountReceived != null ? Number(amountReceived) : null,
      discountAmount: Number(discountAmount),
      notes: notes || null,
      clientLocalId: clientLocalId ? String(clientLocalId) : null
    }, billNumber))

    return res.status(201).json({ success: true, bill: serializeBill(bill) })
  } catch (err: unknown) {
    const e = err as { code?: string; productName?: string; available?: number; requested?: number }
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
app.post('/api/v1/bills/:id/return', requireActiveLicense(), requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

    const result = await prisma.$transaction((tx) => processReturnCore(tx, {
      originalBillId: billId,
      returnItems: items,
      reason: reason || null,
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
      select: { id: true, sellingRate: true, gstPercentage: true }
    })
    const productMap = new Map(products.map((p) => [p.id, p]))

    const resolvedReplacements: IncomingSaleItem[] = replacementItems.map((r) => {
      const p = productMap.get(String(r.productId))
      if (!p) {
        throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })
      }
      return {
        productId: String(r.productId),
        quantity: Math.max(1, Math.floor(Number(r.quantity) || 0)),
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
    const e = err as { code?: string; currentStatus?: string; billItemId?: string; requested?: number; remaining?: number; productName?: string; available?: number }
    if (e.code === 'NOT_FOUND') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (e.code === 'ORIGINAL_NOT_PAID') return res.status(409).json({ success: false, error: 'ORIGINAL_NOT_PAID', currentStatus: e.currentStatus })
    if (e.code === 'BILL_ITEM_NOT_IN_ORIGINAL') return res.status(400).json({ success: false, error: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId: e.billItemId })
    if (e.code === 'INVALID_RETURN_LINE') return res.status(400).json({ success: false, error: 'INVALID_RETURN_LINE' })
    if (e.code === 'NO_RETURN_LINES') return res.status(400).json({ success: false, error: 'RETURN_ITEMS_REQUIRED' })
    if (e.code === 'RETURN_QTY_EXCEEDS_REMAINING') {
      return res.status(409).json({ success: false, error: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId: e.billItemId, requested: e.requested, remaining: e.remaining })
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
    const bill = await prisma.bill.findUnique({
      where: { id: billId },
      include: { items: true }
    })
    if (!bill) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (bill.status === 'VOID') {
      return res.status(409).json({ success: false, error: 'ALREADY_VOID' })
    }
    if (bill.status === 'RETURN') {
      return res.status(409).json({ success: false, error: 'CANNOT_VOID_RETURN' })
    }
    // If any item has been returned, restocking on void would double-count.
    const returnsExist = await prisma.bill.count({ where: { originalBillId: billId, status: 'RETURN' } })
    if (returnsExist > 0) {
      return res.status(409).json({ success: false, error: 'BILL_HAS_RETURNS' })
    }

    await prisma.$transaction(async (tx) => {
      // Restore stock FIFO (add back to most-recent batch per product)
      for (const item of bill.items) {
        const batches = await tx.productBatch.findMany({
          where: { productId: item.productId, isActive: true },
          orderBy: { receivedDate: 'desc' },
          take: 1
        })
        if (batches.length > 0) {
          await tx.productBatch.update({
            where: { id: batches[0].id },
            data: { currentQty: { increment: item.quantity } }
          })
        }
      }
      const voided = await tx.bill.update({
        where: { id: billId },
        data: { status: 'VOID' }
      })
      await emitBillUpsert(tx, voided)
      await emitProductUpsertBulk(tx, bill.items.map((it) => it.productId))
    })

    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Analytics Summary ─────────────────────────────────────────────────────────

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
      status: 'PAID',
      ...(startDate ? { paidAt: { gte: startDate } } : {})
    }

    const bills = await prisma.bill.findMany({
      where,
      include: {
        items: {
          include: {
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
    let totalBillDiscounts = 0
    let totalLineDiscounts = 0
    let estimatedCOGS = 0
    let cogsItemCount = 0
    const payBreakdownAmt: Record<string, number> = { CASH: 0, UPI: 0, CARD: 0 }
    const payBreakdownCount: Record<string, number> = { CASH: 0, UPI: 0, CARD: 0 }
    const productMap: Record<string, { productName: string; itemCode: string; revenue: number; qty: number; cost: number }> = {}

    for (const bill of bills) {
      totalRevenue += Number(bill.totalAmount)
      totalBillDiscounts += Number(bill.discountAmount)
      payBreakdownAmt[bill.paymentMethod] = (payBreakdownAmt[bill.paymentMethod] || 0) + Number(bill.totalAmount)
      payBreakdownCount[bill.paymentMethod] = (payBreakdownCount[bill.paymentMethod] || 0) + 1

      for (const item of bill.items) {
        const gross = item.quantity * Number(item.unitRate)
        totalLineDiscounts += gross - Number(item.lineTotal)

        const pr = item.product.batches[0]?.purchaseRate
        const cost = pr ? item.quantity * Number(pr) : 0
        if (pr) { estimatedCOGS += cost; cogsItemCount++ }

        if (!productMap[item.productId]) {
          productMap[item.productId] = { productName: item.productName, itemCode: item.itemCode, revenue: 0, qty: 0, cost: 0 }
        }
        productMap[item.productId].revenue += Number(item.lineTotal)
        productMap[item.productId].qty += item.quantity
        productMap[item.productId].cost += cost
      }
    }

    const totalDiscounts = totalLineDiscounts + totalBillDiscounts
    const grossRevenuePlusDics = totalRevenue + totalDiscounts
    const estimatedGrossProfit = totalRevenue - estimatedCOGS
    const estimatedMarginPct = totalRevenue > 0 ? (estimatedGrossProfit / totalRevenue) * 100 : 0
    const topProducts = Object.values(productMap).sort((a, b) => b.revenue - a.revenue).slice(0, 8)

    return res.json({
      success: true,
      summary: {
        period: String(period),
        totalBills: bills.length,
        totalRevenue,
        avgBillValue: bills.length > 0 ? totalRevenue / bills.length : 0,
        totalDiscounts,
        totalLineDiscounts,
        totalBillDiscounts,
        discountPct: grossRevenuePlusDics > 0 ? (totalDiscounts / grossRevenuePlusDics) * 100 : 0,
        estimatedCOGS,
        estimatedGrossProfit,
        estimatedMarginPct,
        hasCOGSData: cogsItemCount > 0,
        paymentBreakdown: { CASH: payBreakdownAmt.CASH, UPI: payBreakdownAmt.UPI, CARD: payBreakdownAmt.CARD },
        paymentCounts: { CASH: payBreakdownCount.CASH, UPI: payBreakdownCount.UPI, CARD: payBreakdownCount.CARD },
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
app.get('/api/v1/sync/pull', requireAuth(), async (req, res) => {
  try {
    const cursorStr = String(req.query.cursor ?? '0')
    const cursor = (() => {
      try { return BigInt(cursorStr) } catch { return 0n }
    })()
    const limitRaw = parseInt(String(req.query.limit ?? '500'))
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 500 : limitRaw), 2000)

    const rows = await prisma.syncEvent.findMany({
      where: { id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: limit + 1
    })
    const hasMore = rows.length > limit
    const events = (hasMore ? rows.slice(0, limit) : rows).map((r) => ({
      id: r.id.toString(),
      entity: r.entity,
      entityId: r.entityId,
      op: r.op,
      payload: r.payload,
      createdAt: r.createdAt.toISOString()
    }))
    const nextCursor =
      events.length > 0 ? events[events.length - 1].id : cursor.toString()
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
