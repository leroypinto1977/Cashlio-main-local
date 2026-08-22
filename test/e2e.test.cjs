// End-to-end tests: boots the real Express server against a scratch Postgres
// database and exercises numbering, GST, validation and product lifecycle.
// Run with: npm run test:e2e   (requires a local Postgres and psql on PATH)
process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:5432/cashlio_e2e?schema=public'
process.env.JWT_SECRET = 'smoke-test-secret'
process.env.LOCAL_SERVER_PORT = '52999'
process.chdir('/Users/leroy/Desktop/Projects/Cashlio/main-local')

const { PrismaClient } = require('@prisma/client')
const bcrypt = require('bcryptjs')
const prisma = new PrismaClient()
const BASE = 'http://127.0.0.1:52999'

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok  ', name) }
  else { fail++; console.log('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : '') }
}
const near = (a, b) => Math.abs(a - b) < 0.005

async function api(path, opts = {}, token) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {})
    }
  })
  let body = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

;(async () => {
  // ── seed ──
  await prisma.shopConfig.create({ data: {
    shopName: 'Smoke Electricals', branchName: 'Main', licenseKey: 'SMOKE-1', licenseJwt: 'x',
    gstin: '27ABCDE1234F1Z0', stateCode: '27', address: '1 Test Road', phone: '9876543210'
  }})
  const admin = await prisma.user.create({ data: {
    username: 'admin', passwordHash: await bcrypt.hash('password123', 10), role: 'SUPER_ADMIN' }})
  const device = await prisma.authorizedClient.create({ data: {
    friendlyName: 'Counter 1', macAddress: 'AA:BB:CC:DD:EE:01', terminalCode: 'T1' }})
  const cat = await prisma.category.create({ data: { name: 'Pipes' } })
  // Two products so we can check multi-line apportionment
  const p1 = await prisma.product.create({ data: {
    itemCode: 'PVC-FIN-001', name: 'PVC Pipe 25mm', categoryId: cat.id,
    sellingRate: 118, gstPercentage: 18, unitOfMeasure: 'pcs' }})
  const p2 = await prisma.product.create({ data: {
    itemCode: 'WIRE-HAV-002', name: 'Wire 1.5mm Red', categoryId: cat.id,
    sellingRate: 105, gstPercentage: 5, unitOfMeasure: 'pcs' }})
  for (const p of [p1, p2]) {
    await prisma.productBatch.create({ data: {
      productId: p.id, batchCode: 'SEED', uniqueStockCode: `${p.itemCode}/SEED`,
      purchaseRate: 50, receivedQty: 100, currentQty: 100 }})
  }
  // GST customer in the SAME state -> CGST/SGST
  const localCust = await prisma.customer.create({ data: {
    name: 'Local Buyer', phone: '9000000001', gstin: '27ABCDE1234F1Z0' }})
  // GST customer in ANOTHER state -> IGST
  const farCust = await prisma.customer.create({ data: {
    name: 'Far Buyer', phone: '9000000002', gstin: '29ABCDE1234F1ZW' }})

  const { startExpressServer } = require('../.test-build/server.cjs')
  await startExpressServer(52999)

  console.log('\n— auth —')
  let r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'password123' }) })
  t('login succeeds', r.status === 200 && !!r.body.token)
  const token = r.body.token

  console.log('\n— numbering —')
  r = await api('/api/v1/system/next-bill-number', {}, token)
  t('bill number uses INV- prefix', /^INV-\d{4}-\d{4}$/.test(r.body.billNumber), r.body.billNumber)
  const preview1 = r.body.billNumber
  r = await api('/api/v1/system/next-bill-number', {}, token)
  t('preview does not consume a number', r.body.billNumber === preview1, r.body.billNumber)
  r = await api('/api/v1/system/next-batch-code', {}, token)
  t('batch code uses BT- prefix and differs from bills', /^BT-\d{4}-\d{4}$/.test(r.body.batchCode), r.body.batchCode)

  console.log('\n— tax invoice: no discount —')
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', amountReceived: 118,
    items: [{ productId: p1.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  let b = r.body.bill
  t('bill created', r.status === 201, r.body)
  t('billNumber allocated as INV-', /^INV-/.test(b.billNumber), b.billNumber)
  t('subtotal 118', near(b.subtotal, 118), b.subtotal)
  t('taxable 100', near(b.taxableValue, 100), b.taxableValue)
  t('gst 18', near(b.gstAmount, 18), b.gstAmount)
  t('cgst 9', near(b.cgstAmount, 9), b.cgstAmount)
  t('sgst 9', near(b.sgstAmount, 9), b.sgstAmount)
  t('igst 0 (intra-state)', near(b.igstAmount, 0), b.igstAmount)
  t('taxable+gst == total', near(b.taxableValue + b.gstAmount, b.totalAmount))

  console.log('\n— tax invoice: bill discount (the reported bug) —')
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'UPI', discountAmount: 18,
    items: [{ productId: p1.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  b = r.body.bill
  t('total is 100 after 18 discount', near(b.totalAmount, 100), b.totalAmount)
  t('GST recomputed on 100, not 118', near(b.gstAmount, 15.25), b.gstAmount)
  t('GST is NOT the pre-discount 18', !near(b.gstAmount, 18), b.gstAmount)
  t('subtotal (118) differs from total (100)', !near(b.subtotal, b.totalAmount), { s: b.subtotal, tot: b.totalAmount })
  t('taxable+gst == total', near(b.taxableValue + b.gstAmount, b.totalAmount))
  t('line carries apportioned discount', near(b.items[0].billDiscountAmt, 18), b.items[0].billDiscountAmt)

  console.log('\n— multi-line apportionment —')
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CARD', discountAmount: 33.33, customerId: localCust.id,
    items: [
      { productId: p1.id, quantity: 3, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 },
      { productId: p2.id, quantity: 2, unitRate: 105, gstPercentage: 5, lineDiscountPct: 10, lineDiscountAmt: 0 }
    ]
  })}, token)
  b = r.body.bill
  const shareSum = b.items.reduce((s, i) => s + i.billDiscountAmt, 0)
  t('discount shares sum exactly', near(shareSum, b.discountAmount), { shareSum, d: b.discountAmount })
  t('taxable+gst == total', near(b.taxableValue + b.gstAmount, b.totalAmount))
  t('cgst+sgst == gst', near(b.cgstAmount + b.sgstAmount, b.gstAmount))
  t('line nets sum to total', near(b.items.reduce((s, i) => s + i.taxableValue + i.lineGstAmount, 0), b.totalAmount))

  console.log('\n— inter-state -> IGST —')
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'UPI', customerId: farCust.id,
    items: [{ productId: p1.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  b = r.body.bill
  t('igst carries the tax', near(b.igstAmount, 18), b.igstAmount)
  t('cgst/sgst are zero', near(b.cgstAmount, 0) && near(b.sgstAmount, 0))
  t('placeOfSupply is buyer state 29', b.placeOfSupply === '29', b.placeOfSupply)
  const paidBillId = b.id

  console.log('\n— credit note —')
  r = await api(`/api/v1/bills/${paidBillId}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: b.items[0].id, quantity: 1 }], reason: 'Damaged'
  })}, token)
  const cn = r.body.bill
  t('return created', r.status === 201, r.body)
  t('credit note uses CN- prefix', /^CN-\d{4}-\d{4}$/.test(cn.billNumber), cn.billNumber)
  t('credit note mirrors IGST', near(cn.igstAmount, 18), cn.igstAmount)
  t('credit note foots', near(cn.taxableValue + cn.gstAmount, cn.totalAmount))

  console.log('\n— validation —')
  r = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: 'Bad', phone: '12345' }) }, token)
  t('short phone rejected', r.status === 400 && r.body.error === 'PHONE_INVALID', r.body)
  r = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: 'Bad GST', phone: '9000000009', gstin: '27AAAAA0000A1Z5' }) }, token)
  t('bad GSTIN checksum rejected', r.status === 400 && r.body.error === 'GSTIN_CHECKSUM', r.body)
  t('rejection explains the fix', /last character/.test(r.body.message || ''), r.body.message)
  r = await api('/api/v1/customers', { method: 'POST', body: JSON.stringify({ name: 'Good', phone: '+91 90000 00010', gstin: '27ABCDE1234F1Z0' }) }, token)
  t('valid customer accepted', r.status === 201, r.body)
  t('phone normalized to digits', r.body.customer?.phone === '9000000010', r.body.customer?.phone)
  r = await api('/api/v1/products', { method: 'POST', body: JSON.stringify({ itemCode: 'bad code!!', name: 'X', categoryId: cat.id }) }, token)
  t('invalid item code rejected', r.status === 400, r.body)

  console.log('\n— product lifecycle —')
  const unused = await prisma.product.create({ data: { itemCode: 'TMP-001', name: 'Typo Product', categoryId: cat.id, sellingRate: 10, gstPercentage: 0 }})
  r = await api(`/api/v1/products/${unused.id}`, { method: 'PUT', body: JSON.stringify({ itemCode: 'FIXED-001' }) }, token)
  t('item code editable while unused', r.status === 200 && r.body.product.itemCode === 'FIXED-001', r.body)
  r = await api(`/api/v1/products/${p1.id}`, { method: 'PUT', body: JSON.stringify({ itemCode: 'NOPE-001' }) }, token)
  t('item code locked once sold', r.status === 409 && r.body.error === 'ITEM_CODE_LOCKED', r.body)
  r = await api(`/api/v1/products/${unused.id}?hard=1`, { method: 'DELETE' }, token)
  t('unused product hard-deletes', r.status === 200 && r.body.deleted === 'permanent', r.body)
  t('really gone', (await prisma.product.count({ where: { id: unused.id } })) === 0)
  r = await api(`/api/v1/products/${p1.id}?hard=1`, { method: 'DELETE' }, token)
  t('used product refuses hard delete', r.status === 409 && r.body.error === 'PRODUCT_IN_USE', r.body)
  r = await api(`/api/v1/products/${p1.id}`, { method: 'DELETE' }, token)
  t('used product deactivates instead', r.status === 200 && r.body.deleted === 'deactivated', r.body)
  t('soft-deleted product still exists', (await prisma.product.count({ where: { id: p1.id, isActive: false } })) === 1)
  r = await api('/api/v1/products?isActive=true', {}, token)
  t('active filter hides it', !r.body.products.some(p => p.id === p1.id))
  r = await api('/api/v1/products?isActive=false', {}, token)
  t('inactive filter shows it', r.body.products.some(p => p.id === p1.id))

  console.log('\n— setup lockout —')
  r = await api('/api/v1/system/setup-profile', { method: 'POST', body: JSON.stringify({
    shopName: 'Hijack', branchName: 'X', adminUsername: 'attacker', adminPassword: 'password123' }) })
  t('second setup-profile refused', r.status === 409 && r.body.error === 'SETUP_ALREADY_COMPLETED', r.body)

  console.log('\n— analytics reflects the sales —')
  r = await api('/api/v1/analytics/summary?period=today', {}, token)
  const sum = r.body.summary
  t('analytics counts todays bills', sum.totalBills >= 4, sum.totalBills)
  t('analytics revenue > 0', sum.totalRevenue > 0, sum.totalRevenue)

  console.log('\n— shop profile —')
  r = await api('/api/v1/system/status')
  t('status exposes gstin for receipts', r.body.gstin === '27ABCDE1234F1Z0', r.body)
  t('status exposes address', r.body.address === '1 Test Road', r.body.address)
  r = await api('/api/v1/system/shop-profile', { method: 'PUT', body: JSON.stringify({ gstin: '29ABCDE1234F1ZW' }) }, token)
  t('shop gstin update derives state', r.body.profile?.stateCode === '29', r.body)
  r = await api('/api/v1/system/shop-profile', { method: 'PUT', body: JSON.stringify({ gstin: 'BADGSTIN123456' }) }, token)
  t('bad shop gstin rejected', r.status === 400, r.body)


  console.log('\n— brands —')
  r = await api('/api/v1/brands', { method: 'POST', body: JSON.stringify({ name: 'Finolex' }) }, token)
  t('brand created', r.status === 201, r.body)
  const brandId = r.body.brand.id
  r = await api('/api/v1/brands', { method: 'POST', body: JSON.stringify({ name: 'Finolex' }) }, token)
  t('duplicate brand refused', r.status === 409 && r.body.error === 'BRAND_NAME_EXISTS', r.body)
  r = await api('/api/v1/products', { method: 'POST', body: JSON.stringify({
    itemCode: 'PIPE-FIN-010', name: 'Pipe A', categoryId: cat.id, brandId, sellingRate: 100, gstPercentage: 18 })}, token)
  t('product accepts brandId', r.status === 201, r.body)
  t('brand name denormalised onto product', r.body.product.brand === 'Finolex', r.body.product.brand)
  const brandedId = r.body.product.id
  // renaming the brand must travel to its products
  r = await api(`/api/v1/brands/${brandId}`, { method: 'PUT', body: JSON.stringify({ name: 'Finolex Ltd' }) }, token)
  t('brand renamed', r.status === 200, r.body)
  t('rename propagates to product', (await prisma.product.findUnique({ where: { id: brandedId } })).brand === 'Finolex Ltd')
  r = await api(`/api/v1/brands/${brandId}`, { method: 'DELETE' }, token)
  t('in-use brand refuses delete', r.status === 409 && r.body.error === 'BRAND_IN_USE', r.body)
  // a bare brand name find-or-creates
  r = await api('/api/v1/products', { method: 'POST', body: JSON.stringify({
    itemCode: 'PIPE-HAV-011', name: 'Pipe B', categoryId: cat.id, brand: 'Havells', sellingRate: 100, gstPercentage: 18 })}, token)
  t('bare brand name auto-creates brand', r.status === 201 && r.body.product.brand === 'Havells', r.body.product)
  r = await api('/api/v1/brands', {}, token)
  t('brand list shows product counts', r.body.brands.find(b => b.name === 'Havells')?.productCount === 1, r.body.brands)
  // "— No brand —" in the picker sends null, which must actually clear it
  r = await api(`/api/v1/products/${brandedId}`, { method: 'PUT', body: JSON.stringify({ brandId: null }) }, token)
  t('brandId null clears the brand', r.status === 200 && r.body.product.brand === null, r.body.product)
  t('brandId also cleared in db', (await prisma.product.findUnique({ where: { id: brandedId } })).brandId === null)
  // omitting brand entirely must leave it untouched
  r = await api(`/api/v1/products/${brandedId}`, { method: 'PUT', body: JSON.stringify({ brandId }) }, token)
  r = await api(`/api/v1/products/${brandedId}`, { method: 'PUT', body: JSON.stringify({ name: 'Pipe A renamed' }) }, token)
  t('omitting brand leaves it unchanged', r.body.product.brand === 'Finolex Ltd', r.body.product.brand)
  r = await api(`/api/v1/products/${brandedId}`, { method: 'PUT', body: JSON.stringify({ brandId: 'not-a-real-id' }) }, token)
  t('unknown brandId rejected', r.status === 400 && r.body.error === 'BRAND_NOT_FOUND', r.body)

  console.log('\n— purchase cost GST split —')
  const gstProd = await prisma.product.create({ data: {
    itemCode: 'GST-TEST-001', name: 'GST Test', categoryId: cat.id, sellingRate: 236, gstPercentage: 18 }})
  r = await api(`/api/v1/products/${gstProd.id}/batches`, { method: 'POST', body: JSON.stringify({
    purchaseRate: 118, receivedQty: 10, rateIncludesGst: true })}, token)
  t('batch created with incl-GST rate', r.status === 201, r.body)
  t('ex-GST cost derived', near(r.body.batch.purchaseRate, 100), r.body.batch.purchaseRate)
  t('gst amount derived', near(r.body.batch.purchaseGstAmount, 18), r.body.batch.purchaseGstAmount)
  t('landed cost kept', near(r.body.batch.purchaseRateInclGst, 118), r.body.batch.purchaseRateInclGst)
  r = await api(`/api/v1/products/${gstProd.id}/batches`, { method: 'POST', body: JSON.stringify({
    purchaseRate: 100, receivedQty: 5, rateIncludesGst: false })}, token)
  t('ex-GST entry gives same landed cost', near(r.body.batch.purchaseRateInclGst, 118), r.body.batch.purchaseRateInclGst)
  const editBatchId = r.body.batch.id
  // correcting receivedQty must preserve what was already sold
  r = await api(`/api/v1/batches/${editBatchId}`, { method: 'PUT', body: JSON.stringify({ receivedQty: 8 }) }, token)
  t('receivedQty edit shifts remaining by the delta', near(r.body.batch.currentQty, 8), r.body.batch.currentQty)

  console.log('\n— cut-length products —')
  r = await api('/api/v1/products', { method: 'POST', body: JSON.stringify({
    itemCode: 'PIPE-CUT-020', name: 'PVC Pipe (cut)', categoryId: cat.id,
    sellMode: 'LENGTH', unitOfMeasure: 'm', sellingRate: 60, gstPercentage: 18 })}, token)
  t('length product created', r.status === 201, r.body)
  t('sellMode stored', r.body.product.sellMode === 'LENGTH', r.body.product.sellMode)
  t('unit coerced to a length unit', r.body.product.unitOfMeasure === 'm', r.body.product.unitOfMeasure)
  const cutId = r.body.product.id
  r = await api(`/api/v1/products/${cutId}/batches`, { method: 'POST', body: JSON.stringify({
    purchaseRate: 40, receivedQty: 12.5, rateIncludesGst: false })}, token)
  t('fractional stock received', near(r.body.batch.receivedQty, 12.5), r.body.batch.receivedQty)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', amountReceived: 500,
    items: [{ productId: cutId, quantity: 2.75, unitRate: 60, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  t('fractional quantity billed', r.status === 201 && near(r.body.bill.items[0].quantity, 2.75), r.body.bill?.items?.[0]?.quantity)
  t('line total = 2.75 x 60', near(r.body.bill.items[0].lineTotal, 165), r.body.bill.items[0].lineTotal)
  t('invoice still foots', near(r.body.bill.taxableValue + r.body.bill.gstAmount, r.body.bill.totalAmount))
  const cutBill = r.body.bill
  r = await api(`/api/v1/products/${cutId}`, {}, token)
  t('stock reduced fractionally', near(r.body.product.totalStock, 9.75), r.body.product.totalStock)
  // whole-unit products must refuse fractions
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', amountReceived: 500,
    items: [{ productId: gstProd.id, quantity: 2.5, unitRate: 236, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  t('unit product floors fractional qty to 2', r.status === 201 && near(r.body.bill.items[0].quantity, 2), r.body.bill?.items?.[0]?.quantity)
  // fractional return
  r = await api(`/api/v1/bills/${cutBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: cutBill.items[0].id, quantity: 1.25 }], reason: 'Short cut' })}, token)
  t('fractional return accepted', r.status === 201 && near(r.body.bill.items[0].quantity, 1.25), r.body.bill?.items?.[0]?.quantity)
  r = await api(`/api/v1/products/${cutId}`, {}, token)
  t('returned length restocked', near(r.body.product.totalStock, 11), r.body.product.totalStock)
  r = await api(`/api/v1/bills/${cutBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: cutBill.items[0].id, quantity: 5 }], reason: 'Too much' })}, token)
  t('over-return refused', r.status === 409 && r.body.error === 'RETURN_QTY_EXCEEDS_REMAINING', r.body)

  console.log('\n— margin uses ex-GST on both sides —')
  r = await api('/api/v1/analytics/summary?period=today', {}, token)
  const a = r.body.summary
  t('taxable value reported', a.totalTaxableValue > 0, a.totalTaxableValue)
  t('margin computed on ex-GST revenue', a.revenueExGst <= a.totalRevenue, { ex: a.revenueExGst, gross: a.totalRevenue })
  t('margin is a sane percentage', a.estimatedMarginPct < 100, a.estimatedMarginPct)

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('SMOKE CRASHED:', e); process.exit(1) })
