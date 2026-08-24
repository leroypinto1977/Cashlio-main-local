import { Router } from 'express'
import { lockPurchaseOrder } from '../domain/billing'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { pageArgs } from '../http/respond'
import { allocateNumber } from '../domain/numbering'
import { serializeBatch, serializePurchaseOrder } from '../domain/serializers'
import { emitProductUpsertBulk } from '../syncEvents'
import { round2 } from '../../shared/money'
import { parseQty, roundQty, computePurchaseCost } from '../../shared/units'
import { isPurchaseOrderStatus, canReceive, canCancel, isEditable, statusAfterReceipt } from '../../shared/procurement'

/**
 * Restocking: what to reorder, what is on order, what has arrived.
 */
export const router = Router()


/**
 * Products at or below their minimum stock level, grouped by the supplier they
 * are normally bought from. This is what turns "we're low on cable" into an
 * order without anyone having to remember who supplies it.
 */
router.get('/api/v1/purchase-orders/suggestions', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
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

router.get('/api/v1/purchase-orders', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.get('/api/v1/purchase-orders/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.post('/api/v1/purchase-orders', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/purchase-orders/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.post('/api/v1/purchase-orders/:id/place', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.post('/api/v1/purchase-orders/:id/cancel', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
router.post('/api/v1/purchase-orders/:id/receive', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
      // Hold the order for the rest of the transaction. Without this, two
      // deliveries booked at the same moment both read the same outstanding
      // quantity and both received in full — two batches for one delivery,
      // and stock on the books that never arrived.
      await lockPurchaseOrder(tx, id)
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
