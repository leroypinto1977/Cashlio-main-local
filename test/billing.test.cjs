/**
 * The billing domain, exercised directly.
 *
 * This is what lifting it out of the route file bought. Every one of these
 * used to need a running Express server and an HTTP round trip to reach; they
 * now call the functions the routes call, which makes it practical to test
 * the things a request cannot easily show — that a refused sale leaves no
 * trace, that a rolled-back transaction releases the number it took, that
 * FIFO consumed the batches it claims to have consumed.
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const buildDir = path.join(__dirname, '.build')
fs.mkdirSync(buildDir, { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'domain', 'billing.ts')],
  outfile: path.join(buildDir, 'billing.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['@prisma/client']
})
const B = require(path.join(buildDir, 'billing.cjs'))

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail)) }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
const eq = (name, a, b) => t(`${name} (${a} == ${b})`, near(a, b))

/** Runs the domain inside a transaction, the way a route does. */
const inTx = (fn) => prisma.$transaction(fn, { timeout: 20000 })

;(async () => {
  // ── fixture ────────────────────────────────────────────────────────────────
  const cat = await prisma.category.create({ data: { name: 'Domain Test' } })
  const admin = await prisma.user.create({ data: {
    username: 'domain_admin', passwordHash: 'x', role: 'SUPER_ADMIN' }})
  const device = await prisma.authorizedClient.create({ data: {
    friendlyName: 'Domain Till', macAddress: 'DO:MA:IN:00:00:01', terminalCode: 'D1' }})
  await prisma.shopConfig.create({ data: {
    shopName: 'Domain Test Shop', branchName: 'Main', licenseKey: 'DOMAIN-1', licenseJwt: 'x',
    gstin: '33AABCS1429B1ZQ', stateCode: '33' }})

  const product = async (code, rate, gst, qtys) => {
    const p = await prisma.product.create({ data: {
      itemCode: code, name: `Item ${code}`, categoryId: cat.id, sellingRate: rate, gstPercentage: gst }})
    let i = 0
    for (const { qty, cost } of qtys) {
      i++
      await prisma.productBatch.create({ data: {
        productId: p.id, batchCode: `B${i}`, uniqueStockCode: `${code}/B${i}`,
        purchaseRate: cost, receivedQty: qty, currentQty: qty,
        receivedDate: new Date(Date.now() - (qtys.length - i) * 86400000) }})
    }
    return p
  }

  const line = (p, quantity, over) => ({
    productId: p.id, quantity, unitRate: over ?? Number(p.sellingRate),
    gstPercentage: Number(p.gstPercentage), lineDiscountPct: 0, lineDiscountAmt: 0
  })
  const args = (items, extra = {}) => ({
    items, customerId: null, originDeviceId: device.id, cashierId: admin.id,
    paymentMethod: 'CASH', amountReceived: null, tenders: [], settleInFull: true,
    allowCreditOverride: false, discountAmount: 0, notes: null, clientLocalId: null, ...extra
  })

  console.log('\n— FIFO takes the oldest stock first —')
  {
    const p = await product('DOM-FIFO', 100, 0, [{ qty: 5, cost: 40 }, { qty: 10, cost: 60 }])
    const bill = await inTx((tx) => B.createBillCore(tx, args([line(p, 8)])))
    const allocs = await prisma.billItemBatch.findMany({
      where: { billItemId: { in: bill.items.map((i) => i.id) } },
      include: { batch: true }, orderBy: { unitCost: 'asc' }
    })
    eq('the sale spans two batches', allocs.length, 2)
    eq('the older batch is emptied first', Number(allocs[0].quantity), 5)
    eq('the remainder comes from the newer one', Number(allocs[1].quantity), 3)
    eq('...at its own cost, not an average', Number(allocs[1].unitCost), 60)
    const batches = await prisma.productBatch.findMany({ where: { productId: p.id }, orderBy: { batchCode: 'asc' } })
    eq('older batch is empty', Number(batches[0].currentQty), 0)
    eq('newer batch keeps the rest', Number(batches[1].currentQty), 7)
  }

  console.log('\n— a refused sale leaves nothing behind —')
  {
    const p = await product('DOM-SHORT', 100, 0, [{ qty: 3, cost: 40 }])
    const before = await prisma.numberSeries.findFirst({ where: { series: 'INV' } })
    const beforeSeq = before?.lastValue ?? 0

    let code = null
    try {
      await inTx((tx) => B.createBillCore(tx, args([line(p, 10)])))
    } catch (e) {
      code = e.code
    }
    t('overselling is refused', code === 'INSUFFICIENT_STOCK', code)

    const after = await prisma.numberSeries.findFirst({ where: { series: 'INV' } })
    eq('the invoice number it took is released with the rollback', after?.lastValue ?? 0, beforeSeq)
    const batch = await prisma.productBatch.findFirst({ where: { productId: p.id } })
    eq('and the stock is untouched', Number(batch.currentQty), 3)
    eq('and no bill exists', await prisma.bill.count({ where: { originDeviceId: device.id, items: { some: { productId: p.id } } } }), 0)
  }

  console.log('\n— the price comes from the catalogue —')
  {
    const p = await product('DOM-PRICE', 500, 18, [{ qty: 20, cost: 200 }])
    let code = null
    try {
      await inTx((tx) => B.createBillCore(tx, args([line(p, 1, 1)])))   // ₹1 for a ₹500 item
    } catch (e) { code = e.code }
    t('a client-supplied price is refused', code === 'PRICE_OVERRIDE_NOT_ALLOWED', code)

    const bill = await inTx((tx) =>
      B.createBillCore(tx, args([line(p, 1, 1)], { allowPriceOverride: true })))
    eq('a manager may still override it', Number(bill.items[0].unitRate), 1)

    const at = await inTx((tx) => B.createBillCore(tx, args([line(p, 2)])))
    eq('otherwise the catalogue rate is used', Number(at.totalAmount), 1000)
  }

  console.log('\n— the invoice foots exactly —')
  {
    const p1 = await product('DOM-GST18', 118, 18, [{ qty: 100, cost: 50 }])
    const p2 = await product('DOM-GST12', 112, 12, [{ qty: 100, cost: 50 }])
    const bill = await inTx((tx) =>
      B.createBillCore(tx, args([line(p1, 3), line(p2, 7)], { discountAmount: 137 })))
    eq('taxable + GST equals the total',
      Number(bill.taxableValue) + Number(bill.gstAmount), Number(bill.totalAmount))
    const lines = bill.items
    eq('the lines sum to the bill total',
      lines.reduce((s, i) => s + Number(i.lineTotal), 0) - Number(bill.discountAmount),
      Number(bill.totalAmount))
    eq('the discount is fully apportioned, to the paisa',
      lines.reduce((s, i) => s + Number(i.billDiscountAmt), 0), 137)
    eq('intra-state splits into CGST and SGST',
      Number(bill.cgstAmount) + Number(bill.sgstAmount), Number(bill.gstAmount))
    eq('and no IGST', Number(bill.igstAmount), 0)
  }

  console.log('\n— settlement follows the tenders —')
  {
    const p = await product('DOM-SETTLE', 1000, 0, [{ qty: 50, cost: 400 }])
    const cust = await prisma.customer.create({ data: {
      name: 'Domain Buyer', phone: '9000000501', creditLimit: 100000, creditDays: 30 }})

    const paid = await inTx((tx) => B.createBillCore(tx, args([line(p, 1)], {
      tenders: [{ method: 'CASH', amount: 1000 }], settleInFull: false })))
    t('paid in full reads PAID', paid.status === 'PAID', paid.status)

    const part = await inTx((tx) => B.createBillCore(tx, args([line(p, 1)], {
      customerId: cust.id, tenders: [{ method: 'CASH', amount: 400 }], settleInFull: false })))
    t('part paid reads PARTIAL', part.status === 'PARTIAL', part.status)
    eq('and carries the balance', Number(part.balanceDue), 600)

    const credit = await inTx((tx) => B.createBillCore(tx, args([line(p, 1)], {
      customerId: cust.id, tenders: [], settleInFull: false })))
    t('nothing tendered reads CREDIT', credit.status === 'CREDIT', credit.status)
    eq('...owing the whole amount', Number(credit.balanceDue), 1000)

    let code = null
    try {
      await inTx((tx) => B.createBillCore(tx, args([line(p, 1)], {
        customerId: null, tenders: [], settleInFull: false })))
    } catch (e) { code = e.code }
    t('a walk-in cannot leave a balance', code === 'CREDIT_NOT_ALLOWED', code)
  }

  console.log('\n— a return reverses what the sale took —')
  {
    const p = await product('DOM-RETURN', 200, 0, [{ qty: 4, cost: 80 }, { qty: 10, cost: 120 }])
    const sale = await inTx((tx) => B.createBillCore(tx, args([line(p, 6)])))
    const soldFrom = await prisma.billItemBatch.findMany({
      where: { billItemId: { in: sale.items.map((i) => i.id) } }, orderBy: { unitCost: 'asc' } })
    eq('the sale spanned both batches', soldFrom.length, 2)

    const ret = await inTx((tx) => B.processReturnCore(tx, {
      originalBillId: sale.id, cashierId: admin.id, originDeviceId: device.id,
      returnItems: [{ billItemId: sale.items[0].id, quantity: 6 }],
      reasonCode: 'CHANGED_MIND', reason: null
    }))
    t('a credit note is raised', ret.status === 'RETURN', ret.status)
    eq('for the full value', Number(ret.totalAmount), 1200)

    const batches = await prisma.productBatch.findMany({ where: { productId: p.id }, orderBy: { batchCode: 'asc' } })
    eq('the older batch has its units back', Number(batches[0].currentQty), 4)
    eq('and so does the newer one', Number(batches[1].currentQty), 10)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  fs.rmSync(buildDir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
