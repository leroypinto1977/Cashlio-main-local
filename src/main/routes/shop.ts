import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { fieldError } from '../http/respond'
import { validateContactNumber, validateGstin, validateName, stateCodeOf, codeStub } from '../../shared/validation'

/**
 * The shop's own identity, as it appears on a tax invoice.
 */
export const router = Router()

router.get('/api/v1/system/shop-profile', requireAuth(), async (_req, res) => {
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
router.put('/api/v1/system/shop-profile', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
router.get('/api/v1/system/suggest-item-code', requireAuth(['SUPER_ADMIN']), async (req, res) => {
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
