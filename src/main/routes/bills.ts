import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma'
import { requireAuth, requireActiveLicense } from '../http/middleware'
import { pageArgs } from '../http/respond'
import { peekNumber } from '../domain/numbering'
import { serializeBillItem, serializeBill } from '../domain/serializers'
import { readTenders, lockBill, resolveSoldAt, createBillCore, planRestock, processReturnCore, recordRefundTender } from '../domain/billing'
import type { IncomingSaleItem } from '../domain/billing'
import { emitProductUpsertBulk, emitBillUpsert } from '../syncEvents'
import { round2 } from '../../shared/money'
import { parseQty, roundQty } from '../../shared/units'
import { isReturnReasonCode } from '../../shared/procurement'

/**
 * Sales: making them, reading them, returning against them, voiding them.
 */
export const router = Router()



router.get('/api/v1/system/next-bill-number', requireAuth(), async (_req, res) => {
  try {
    return res.json({ success: true, billNumber: await peekNumber('INV') })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/bills', requireAuth(), async (req, res) => {
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

router.get('/api/v1/bills/:id', requireAuth(), async (req, res) => {
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


router.post('/api/v1/bills', requireActiveLicense(), requireAuth(), async (req, res) => {
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
router.post('/api/v1/bills/:id/return', requireActiveLicense(), requireAuth(), async (req, res) => {
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
router.post('/api/v1/bills/:id/exchange', requireActiveLicense(), requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
        originDeviceId: deviceId,
        // Nothing is handed over yet — how much of this is money back and how
        // much goes onto the replacement is only known once it is priced.
        deferRefund: true
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
        // Only the part of the return the customer had actually paid for can
        // be spent on the replacement. Value that went to clearing their own
        // debt is already gone and cannot be handed over twice.
        creditApplied: refund.refundPaidOut,
        allowCreditOverride: true,
        // The replacement rate is resolved from the product master above.
        allowPriceOverride: true,
        discountAmount: 0,
        notes: `Exchange for ${original.billNumber} (refund ${refund.billNumber})`,
        clientLocalId: null
      })

      // The replacement soaks up as much of the refund as it costs; anything
      // left over is money the shop gives back across the counter.
      const cashBack = round2(Math.max(0, refund.refundPaidOut - Number(replacement.totalAmount)))
      await recordRefundTender(tx, {
        returnBillId: refund.id,
        receivedAt: refund.createdAt,
        customerId: original.customerId,
        amount: cashBack,
        method: pm,
        cashierId,
        note: `Exchange difference on ${original.billNumber}`
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

router.post('/api/v1/bills/:id/void', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
