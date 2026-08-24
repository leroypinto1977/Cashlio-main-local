import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { pageArgs } from '../http/respond'
import { serializeWarranty, WARRANTY_INCLUDE } from '../domain/serializers'
import { canClaim, isWarrantyResolution, EXPIRING_SOON_DAYS } from '../../shared/warranty'

/**
 * Cover sold with a product, and the claims made against it.
 */
export const router = Router()



/**
 * Lists cover. `status` filters on the *effective* status, so "EXPIRED" is
 * a date test rather than a stored value and "ACTIVE" excludes what has
 * lapsed.
 */
router.get('/api/v1/warranties', requireAuth(), async (req, res) => {
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
router.get('/api/v1/warranties/expiring-soon', requireAuth(), async (req, res) => {
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
router.get('/api/v1/warranties/summary', requireAuth(), async (_req, res) => {
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

router.get('/api/v1/warranties/:id', requireAuth(), async (req, res) => {
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
router.post('/api/v1/warranties/:id/claim', requireAuth(), async (req, res) => {
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
router.put('/api/v1/warranties/:id/resolve', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
router.put('/api/v1/warranties/:id', requireAuth(), async (req, res) => {
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
