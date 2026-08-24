import { Router } from 'express'
import { prisma } from '../prisma'
import { getServerMac } from '../machineId'
import { requireAuth } from '../http/middleware'
import { istMidnight } from '../domain/dates'
import { getLicenseStatus, checkClockTamper, refreshLicenseOnce } from '../licenseGuard'

/**
 * The dashboard's headline figures, this machine's identity, and licence state.
 */
export const router = Router()

router.get('/api/v1/system/stats', requireAuth(), async (_req, res) => {
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


router.get('/api/v1/system/self-device-id', requireAuth(), async (_req, res) => {
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
router.get('/api/v1/system/license-status', requireAuth(), async (_req, res) => {
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
router.post('/api/v1/system/license-refresh', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
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
