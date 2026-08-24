import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { fieldError } from '../http/respond'
import { emitProductUpsertBulk } from '../syncEvents'
import { validateContactNumber, validateEmail, validateGstin, validateName } from '../../shared/validation'

/**
 * Warehouses, brands, categories and suppliers — the lists a product is filed under.
 */
export const router = Router()

router.get('/api/v1/warehouses', requireAuth(), async (_req, res) => {
  try {
    const warehouses = await prisma.warehouse.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, warehouses })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/warehouses', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/warehouses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.delete('/api/v1/warehouses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.get('/api/v1/brands', requireAuth(), async (req, res) => {
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

router.post('/api/v1/brands', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/brands/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.delete('/api/v1/brands/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.get('/api/v1/categories', requireAuth(), async (_req, res) => {
  try {
    const categories = await prisma.category.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, categories })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/categories', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/categories/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.delete('/api/v1/categories/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.get('/api/v1/suppliers', requireAuth(), async (_req, res) => {
  try {
    const suppliers = await prisma.supplier.findMany({ orderBy: { name: 'asc' } })
    return res.json({ success: true, suppliers })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/suppliers/:id', requireAuth(), async (req, res) => {
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

router.post('/api/v1/suppliers', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.put('/api/v1/suppliers/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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

router.delete('/api/v1/suppliers/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
