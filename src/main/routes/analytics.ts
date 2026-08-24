import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { IST_OFFSET_MS, istMidnight } from '../domain/dates'
import { round2 } from '../../shared/money'

/**
 * What the shop earned, and on what.
 */
export const router = Router()

router.get('/api/v1/analytics/summary', requireAuth(), async (req, res) => {
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
