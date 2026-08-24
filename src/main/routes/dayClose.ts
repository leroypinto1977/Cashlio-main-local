import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import {
  buildDayBook,
  businessDateFor,
  closeDay,
  dayWindow,
  istDateKey,
  parseBusinessDate,
  serializeClose
} from '../domain/dayClose'

/**
 * The day book and the drawer count.
 */
export const router = Router()

/**
 * Everything that happened on one trading day, and what the drawer should
 * hold because of it. Any signed-in user may look: the cashier who counts the
 * money needs to see the figure they are counting against.
 */
router.get('/api/v1/reports/day-book', requireAuth(), async (req, res) => {
  try {
    const raw = req.query.date
    const businessDate = raw === undefined ? businessDateFor() : parseBusinessDate(raw)
    if (!businessDate) {
      return res.status(400).json({
        success: false,
        error: 'BAD_DATE',
        message: 'Give the day as YYYY-MM-DD.'
      })
    }
    const float = req.query.openingFloat
    const override = float === undefined ? undefined : Number(float)
    if (override !== undefined && !Number.isFinite(override)) {
      return res
        .status(400)
        .json({ success: false, error: 'BAD_FLOAT', message: 'Opening float must be a number.' })
    }

    const book = await buildDayBook(prisma as never, businessDate, override)
    return res.json({ success: true, book })
  } catch (err) {
    console.error('Error building day book:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Counts the drawer and freezes the day. Manager-only: this is the record
 * that says whether the shop's money is where it should be, and the person
 * being reconciled should not be the one signing it off.
 */
router.post('/api/v1/day-close', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const businessDate =
      req.body?.businessDate === undefined
        ? businessDateFor()
        : parseBusinessDate(req.body.businessDate)
    if (!businessDate) {
      return res.status(400).json({
        success: false,
        error: 'BAD_DATE',
        message: 'Give the day as YYYY-MM-DD.'
      })
    }

    const openingFloat = Number(req.body?.openingFloat ?? 0)
    const countedCash = Number(req.body?.countedCash)
    if (!Number.isFinite(openingFloat) || openingFloat < 0) {
      return res.status(400).json({
        success: false,
        error: 'BAD_FLOAT',
        message: 'Opening float must be a number, and cannot be negative.'
      })
    }
    if (!Number.isFinite(countedCash) || countedCash < 0) {
      return res.status(400).json({
        success: false,
        error: 'BAD_COUNT',
        message: 'Enter what you counted in the drawer.'
      })
    }

    const notes = String(req.body?.notes ?? '').trim() || null
    const result = await closeDay(prisma as never, {
      businessDate,
      openingFloat,
      countedCash,
      notes,
      closedById: (req as never as { user: { userId: string } }).user.userId
    })
    if (!result.ok) {
      const status = result.code === 'ALREADY_CLOSED' ? 409 : 400
      return res
        .status(status)
        .json({ success: false, error: result.code, message: result.message })
    }
    return res.json({ success: true, close: result.close })
  } catch (err) {
    console.error('Error closing the day:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * The run of past counts. A single short day means nothing; the same till
 * running short every Tuesday means something, and that only shows in a list.
 */
router.get('/api/v1/day-close/history', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '30')) || 30))
    const rows = await prisma.dayClose.findMany({
      orderBy: { businessDate: 'desc' },
      take: limit,
      include: { closedBy: { select: { username: true } } }
    })
    const closes = rows.map(serializeClose)
    const shortDays = closes.filter((c) => c.difference < 0).length
    const overDays = closes.filter((c) => c.difference > 0).length
    const netDifference = closes.reduce((s, c) => s + c.difference, 0)
    return res.json({
      success: true,
      closes,
      summary: {
        days: closes.length,
        shortDays,
        overDays,
        netDifference: Math.round(netDifference * 100) / 100
      }
    })
  } catch (err) {
    console.error('Error listing day closes:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Which days in a range have been counted — drives the "not closed yet" nudge. */
router.get('/api/v1/day-close/pending', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const days = Math.min(60, Math.max(1, parseInt(String(req.query.days ?? '7')) || 7))
    const today = businessDateFor()
    const earliest = new Date(today.getTime() - days * 24 * 60 * 60 * 1000)
    // Business dates are calendar days; the query needs the instants they cover.
    const window = { gte: dayWindow(earliest).from, lt: dayWindow(today).from }
    const [closed, traded] = await Promise.all([
      prisma.dayClose.findMany({
        where: { businessDate: { gte: earliest, lt: today } },
        select: { businessDate: true }
      }),
      prisma.bill.findMany({
        where: { paidAt: window },
        select: { paidAt: true }
      })
    ])
    const closedKeys = new Set(closed.map((c) => c.businessDate.toISOString().slice(0, 10)))
    const tradedKeys = new Set(traded.map((b) => istDateKey(new Date(b.paidAt))))
    // A day with no trade has no drawer to reconcile, so it is not pending.
    const pending = [...tradedKeys].filter((k) => !closedKeys.has(k)).sort()
    return res.json({ success: true, pending })
  } catch (err) {
    console.error('Error finding pending day closes:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
