import { Router } from 'express'
import { Prisma } from '@prisma/client'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { pageArgs, MAX_PAGE, fieldError } from '../http/respond'
import { allocateNumber, peekNumber } from '../domain/numbering'
import { serializeBatch } from '../domain/serializers'
import { resolveBrand, brandFields } from '../domain/brands'
import { planBarcodes, applyBarcodes } from '../domain/barcodes'
import { recordSync, emitProductUpsert } from '../syncEvents'
import { validateName, validateItemCode, validateHsn } from '../../shared/validation'
import { parseQty, roundQty, computePurchaseCost, defaultMeasureFor, measuresFor } from '../../shared/units'

/**
 * Products and the stock batches behind them.
 */
export const router = Router()

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
router.get('/api/v1/products', requireAuth(), async (req, res) => {
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
            { brand: { contains: String(search), mode: 'insensitive' } },
            // Exact, not `contains`: a scanned code is complete, and a partial
            // match on a thirteen-digit number is a coincidence, not a result.
            { barcodes: { some: { code: String(search).trim().toUpperCase() } } }
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
        barcodes: { select: { code: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
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

/**
 * What a scanner just read.
 *
 * Separate from the search endpoint because a scan is not a search: it either
 * names one product or it names nothing, and the till wants to know which
 * without paging a result list. A miss returns 404 with the code, so the
 * counter can say "that barcode is not on anything" rather than showing an
 * empty list that looks like a slow network.
 */
router.get('/api/v1/products/by-barcode/:code', requireAuth(), async (req, res) => {
  try {
    const code = String(req.params.code ?? '').trim().toUpperCase()
    if (!code) return res.status(400).json({ success: false, error: 'BARCODE_REQUIRED' })

    const match = await prisma.productBarcode.findUnique({
      where: { code },
      include: {
        product: {
          include: {
            category: { select: { id: true, name: true } },
            barcodes: { select: { code: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
            batches: {
              where: { isActive: true },
              orderBy: { createdAt: 'desc' },
              select: { id: true, batchCode: true, currentQty: true, purchaseRate: true }
            }
          }
        }
      }
    })
    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'BARCODE_NOT_FOUND',
        code,
        message: `No product carries the barcode ${code}.`
      })
    }
    const p = match.product
    if (!p.isActive) {
      return res.status(404).json({
        success: false,
        error: 'PRODUCT_DISCONTINUED',
        code,
        message: `${p.name} carries that barcode, but it has been discontinued.`
      })
    }
    return res.json({
      success: true,
      product: {
        ...p,
        totalStock: roundQty(p.batches.reduce((sum, b) => sum + Number(b.currentQty), 0)),
        sellingRate: Number(p.sellingRate),
        gstPercentage: Number(p.gstPercentage),
        minStockLevel: Number(p.minStockLevel),
        batches: p.batches.map((b) => ({ ...b, currentQty: Number(b.currentQty), purchaseRate: Number(b.purchaseRate) }))
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/products/:id', requireAuth(), async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: String(req.params.id) },
      include: {
        category: true,
        suppliers: { include: { supplier: true } },
        barcodes: { select: { code: true, isPrimary: true }, orderBy: { isPrimary: 'desc' } },
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

router.post('/api/v1/products', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const {
      itemCode, brand, brandId, name, specification, categoryId, productType,
      unitOfMeasure, sellMode, sellingRate, gstPercentage, warrantyPeriodDays, hsnCode,
      minStockLevel, supplierIds, barcodes
    } = req.body

    if (!itemCode || !name || !categoryId) {
      return res.status(400).json({ success: false, error: 'ITEM_CODE_NAME_CATEGORY_REQUIRED' })
    }

    const codeCheck = validateItemCode(String(itemCode))
    if (!codeCheck.ok) return fieldError(res, codeCheck)
    const nameCheck = validateName(String(name), 'Product name')
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const hsnCheck = validateHsn(String(hsnCode ?? ''))
    if (!hsnCheck.ok) return fieldError(res, hsnCheck)
    const barcodePlan = planBarcodes(barcodes)
    if (!barcodePlan.ok) return fieldError(res, barcodePlan)

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
          hsnCode: hsnCheck.value || null,
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
      const codes = await applyBarcodes(tx, created.id, barcodePlan.codes)
      if (!codes.ok) {
        throw Object.assign(new Error('BARCODE_TAKEN'), { code: 'BARCODE_TAKEN', conflict: codes.conflict })
      }
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
    if (code === 'BARCODE_TAKEN') {
      const c = (err as { conflict: { code: string; itemCode: string; name: string; productId: string } }).conflict
      return res.status(409).json({
        success: false,
        error: 'BARCODE_TAKEN',
        message: `${c.code} is already the barcode of ${c.name} (${c.itemCode}). A barcode can only belong to one product.`,
        conflict: c
      })
    }
    if (code === 'P2002') {
      return res.status(409).json({ success: false, error: 'ITEM_CODE_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.put('/api/v1/products/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const {
      itemCode, brand, brandId, name, specification, categoryId, productType,
      unitOfMeasure, sellMode, sellingRate, gstPercentage, warrantyPeriodDays, hsnCode,
      minStockLevel, isActive, barcodes
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

    // An empty string clears the code; leaving the field out changes nothing.
    let nextHsn: string | null | undefined
    if (hsnCode !== undefined) {
      const hsnCheck = validateHsn(String(hsnCode ?? ''))
      if (!hsnCheck.ok) return fieldError(res, hsnCheck)
      nextHsn = hsnCheck.value || null
    }

    // Leaving the field out leaves the codes alone; sending [] clears them.
    const barcodePlan = barcodes === undefined ? null : planBarcodes(barcodes)
    if (barcodePlan && !barcodePlan.ok) return fieldError(res, barcodePlan)

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
          hsnCode: nextHsn,
          sellMode: mode,
          sellingRate, gstPercentage, warrantyPeriodDays, isActive,
          minStockLevel:
            minStockLevel === undefined ? undefined : parseQty(minStockLevel, effectiveMode)
        },
        include: { category: true }
      })
      if (barcodePlan && barcodePlan.ok) {
        const codes = await applyBarcodes(tx, updated.id, barcodePlan.codes)
        if (!codes.ok) {
          throw Object.assign(new Error('BARCODE_TAKEN'), { code: 'BARCODE_TAKEN', conflict: codes.conflict })
        }
      }
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
    if (code === 'BARCODE_TAKEN') {
      const c = (err as { conflict: { code: string; itemCode: string; name: string; productId: string } }).conflict
      return res.status(409).json({
        success: false,
        error: 'BARCODE_TAKEN',
        message: `${c.code} is already the barcode of ${c.name} (${c.itemCode}). A barcode can only belong to one product.`,
        conflict: c
      })
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

router.delete('/api/v1/products/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.get('/api/v1/system/next-batch-code', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const code = await peekNumber('BT')
    return res.json({ success: true, batchCode: code })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/products/:id/batches', requireAuth(), async (req, res) => {
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

router.post('/api/v1/products/:id/batches', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/batches/:batchId', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
