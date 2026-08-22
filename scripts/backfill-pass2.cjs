/**
 * Idempotent data backfill for the Pass 2 schema.
 *
 *  1. Turns each distinct free-text Product.brand into a Brand row and links
 *     it via brandId (the string column stays as a denormalised cache).
 *  2. Fills the purchase-GST split on existing batches. Rates entered before
 *     this change were recorded without tax, so they are treated as ex-GST and
 *     the tax is derived from the product's GST rate.
 *
 * Safe to run repeatedly — every step skips rows that are already done.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

async function backfillBrands() {
  const products = await prisma.product.findMany({
    where: { brandId: null, NOT: { brand: null } },
    select: { id: true, brand: true }
  })
  if (products.length === 0) return { created: 0, linked: 0 }

  const names = [...new Set(products.map((p) => p.brand.trim()).filter(Boolean))]
  let created = 0
  const byName = new Map()
  for (const name of names) {
    const existing = await prisma.brand.findUnique({ where: { name } })
    if (existing) {
      byName.set(name, existing.id)
    } else {
      const b = await prisma.brand.create({ data: { name } })
      byName.set(name, b.id)
      created++
    }
  }

  let linked = 0
  for (const p of products) {
    const id = byName.get(p.brand.trim())
    if (!id) continue
    await prisma.product.update({
      where: { id: p.id },
      data: { brandId: id, brand: p.brand.trim() }
    })
    linked++
  }
  return { created, linked }
}

async function backfillPurchaseGst() {
  const batches = await prisma.productBatch.findMany({
    where: { purchaseRateInclGst: 0 },
    select: { id: true, purchaseRate: true, product: { select: { gstPercentage: true } } }
  })
  let updated = 0
  for (const b of batches) {
    const exGst = Number(b.purchaseRate)
    if (exGst <= 0) continue
    const pct = Number(b.product.gstPercentage) || 0
    const gstAmount = round2((exGst * pct) / 100)
    await prisma.productBatch.update({
      where: { id: b.id },
      data: {
        purchaseGstPct: pct,
        purchaseGstAmount: gstAmount,
        purchaseRateInclGst: round2(exGst + gstAmount)
      }
    })
    updated++
  }
  return { updated }
}

;(async () => {
  const brands = await backfillBrands()
  console.log(`brands: ${brands.created} created, ${brands.linked} products linked`)
  const gst = await backfillPurchaseGst()
  console.log(`batches: ${gst.updated} purchase-GST splits filled`)
  await prisma.$disconnect()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
