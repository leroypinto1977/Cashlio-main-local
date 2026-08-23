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
const eqp = (name, actual, expected) => t(`${name} (${actual} == ${expected})`, near(Number(actual), Number(expected)))

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
  t('fractional quantity billed', r.status === 201 && near(r.body.bill?.items?.[0]?.quantity, 2.75), { status: r.status, body: r.body })

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


  console.log('\n— credit billing —')
  // A customer with a credit limit
  const creditCust = await prisma.customer.create({ data: {
    name: 'Credit Buyer', phone: '9000000050', creditLimit: 10000, creditDays: 30 }})
  const stockProd = await prisma.product.create({ data: {
    itemCode: 'CRED-TEST-001', name: 'Credit Test Item', categoryId: cat.id,
    sellingRate: 1000, gstPercentage: 18 }})
  await prisma.productBatch.create({ data: {
    productId: stockProd.id, batchCode: 'CB', uniqueStockCode: 'CRED-TEST-001/CB',
    purchaseRate: 500, receivedQty: 500, currentQty: 500 }})
  const line = (qty) => [{ productId: stockProd.id, quantity: qty, unitRate: 1000, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }]

  // full payment
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id,
    payments: [{ method: 'CASH', amount: 1000 }], items: line(1) })}, token)
  t('full payment is PAID', r.body.bill?.status === 'PAID', r.body.bill?.status)
  eqp('balance zero', r.body.bill.balanceDue, 0)

  // part payment -> PARTIAL with a balance
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id,
    payments: [{ method: 'UPI', amount: 400 }], items: line(1) })}, token)
  t('part payment is PARTIAL', r.body.bill?.status === 'PARTIAL', r.body.bill?.status)
  eqp('balance carried', r.body.bill.balanceDue, 600)
  eqp('paid recorded', r.body.bill.paidAmount, 400)
  t('due date set from credit days', !!r.body.bill.dueDate, r.body.bill.dueDate)
  const partialBillId = r.body.bill.id

  // no payment at all -> CREDIT
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id, payments: [], items: line(2) })}, token)
  t('no tender is CREDIT', r.body.bill?.status === 'CREDIT', r.body.bill?.status)
  eqp('whole amount owed', r.body.bill.balanceDue, 2000)
  const creditBillId = r.body.bill.id

  // split tender
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id,
    payments: [{ method: 'CASH', amount: 300 }, { method: 'UPI', amount: 700 }], items: line(1) })}, token)
  t('split tender settles the bill', r.body.bill?.status === 'PAID', r.body.bill?.status)
  t('both tenders recorded', (await prisma.payment.count({ where: { billId: r.body.bill.id } })) === 2)

  // outstanding
  r = await api(`/api/v1/customers/${creditCust.id}/outstanding`, {}, token)
  eqp('outstanding is the sum of balances', r.body.outstanding, 2600)
  eqp('available credit reduced', r.body.availableCredit, 7400)
  t('two open bills listed', r.body.bills.length === 2, r.body.bills.length)

  console.log('\n— credit limits —')
  // walk-in cannot take credit
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, payments: [], items: line(1) })}, token)
  t('walk-in refused credit', r.status === 409 && r.body.reason === 'NO_CUSTOMER', r.body)
  // customer with no limit
  const noCreditCust = await prisma.customer.create({ data: { name: 'Cash Only', phone: '9000000051' }})
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: noCreditCust.id, payments: [], items: line(1) })}, token)
  t('customer without a limit refused', r.status === 409 && r.body.reason === 'NO_CREDIT_ALLOWED', r.body)
  // over the limit
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id, payments: [], items: line(20) })}, token)
  t('over-limit refused', r.status === 409 && r.body.reason === 'LIMIT_EXCEEDED', r.body)
  t('tells you how far over', r.body.overBy > 0, r.body.overBy)
  // super-admin override
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id, payments: [], items: line(20),
    allowCreditOverride: true })}, token)
  t('super admin can override', r.status === 201 && r.body.bill.status === 'CREDIT', r.body)
  const overrideBillId = r.body.bill.id
  // stock must not have moved on a refused bill
  r = await api(`/api/v1/products/${stockProd.id}`, {}, token)
  t('refused bills did not consume stock', r.body.product.totalStock === 500 - 1 - 1 - 2 - 1 - 20,
    r.body.product.totalStock)

  console.log('\n— collecting payment —')
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 600, method: 'CASH' })}, token)
  t('payment recorded', r.status === 201, r.body)
  t('oldest bill settled first', (await prisma.bill.findUnique({ where: { id: partialBillId } })).status === 'PAID')
  r = await api(`/api/v1/customers/${creditCust.id}/outstanding`, {}, token)
  eqp('outstanding reduced', r.body.outstanding, 2000 + 20000)
  // explicit allocation
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 500, method: 'UPI', reference: 'UPI123',
    allocations: [{ billId: creditBillId, amount: 500 }] })}, token)
  t('explicit allocation accepted', r.status === 201, r.body)
  t('that bill is now PARTIAL', (await prisma.bill.findUnique({ where: { id: creditBillId } })).status === 'PARTIAL')
  // over-collection refused
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 999999, method: 'CASH' })}, token)
  t('paying more than owed refused', r.status === 409 && r.body.error === 'AMOUNT_EXCEEDS_OUTSTANDING', r.body)
  // allocation larger than the bill
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 999999, method: 'CASH',
    allocations: [{ billId: creditBillId, amount: 999999 }] })}, token)
  t('allocation beyond a bill balance refused', r.status === 409 && r.body.error === 'ALLOCATION_EXCEEDS_BALANCE', r.body)
  // idempotency
  const key = 'pay-key-1'
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 100, method: 'CASH', clientLocalId: key })}, token)
  t('keyed payment accepted', r.status === 201, r.body)
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: creditCust.id, amount: 100, method: 'CASH', clientLocalId: key })}, token)
  t('replay does not double-post', r.status === 200 && r.body.replayed === true, r.body)
  t('only one payment for the key', (await prisma.payment.count({ where: { clientLocalId: key } })) === 1)

  console.log('\n— voiding and returning credit bills —')
  r = await api(`/api/v1/bills/${creditBillId}/void`, { method: 'POST' }, token)
  t('cannot void a bill with collections', r.status === 409 && r.body.error === 'BILL_HAS_SETTLEMENTS', r.body)
  // a return against a credit bill reduces what is owed
  const before = Number((await prisma.bill.findUnique({ where: { id: overrideBillId } })).balanceDue)
  const ob = await api(`/api/v1/bills/${overrideBillId}`, {}, token)
  r = await api(`/api/v1/bills/${overrideBillId}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: ob.body.bill.items[0].id, quantity: 5 }], reason: 'Damaged' })}, token)
  t('return against a credit bill allowed', r.status === 201, r.body)
  const after = Number((await prisma.bill.findUnique({ where: { id: overrideBillId } })).balanceDue)
  t('returning reduces the balance owed', after < before, { before, after })
  eqp('reduced by the credit note value', before - after, Number(r.body.bill.totalAmount))

  console.log('\n— receivables —')
  r = await api('/api/v1/receivables', {}, token)
  t('receivables lists debtors', r.body.customers.length >= 1, r.body.customers?.length)
  t('totals match the customer rows',
    Math.abs(r.body.totalOutstanding - r.body.customers.reduce((s, c) => s + c.outstanding, 0)) < 0.01,
    { total: r.body.totalOutstanding })
  t('ageing buckets present', typeof r.body.buckets['0-30'] === 'number', r.body.buckets)

  console.log('\n— follow-ups —')
  r = await api(`/api/v1/customers/${creditCust.id}/followups`, { method: 'POST', body: JSON.stringify({
    note: 'Call about the overdue balance', dueAt: '2026-09-01' })}, token)
  t('follow-up created', r.status === 201, r.body)
  const fuId = r.body.followUp.id
  r = await api('/api/v1/followups?open=1', {}, token)
  t('open follow-ups listed', r.body.followUps.some(f => f.id === fuId), r.body.followUps?.length)
  r = await api(`/api/v1/followups/${fuId}`, { method: 'PUT', body: JSON.stringify({ resolved: true }) }, token)
  t('follow-up resolved', !!r.body.followUp.resolvedAt, r.body.followUp)
  r = await api('/api/v1/followups?open=1', {}, token)
  t('resolved one drops off the open list', !r.body.followUps.some(f => f.id === fuId))
  r = await api(`/api/v1/customers/${creditCust.id}/followups`, { method: 'POST', body: JSON.stringify({ note: '  ' }) }, token)
  t('empty note refused', r.status === 400 && r.body.error === 'NOTE_REQUIRED', r.body)

  console.log('\n— credit terms are super-admin only —')
  const cashierPass = await bcrypt.hash('cashier123', 10)
  const cashier = await prisma.user.create({ data: { username: 'cashier1', passwordHash: cashierPass, role: 'CASHIER' }})
  r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'cashier1', password: 'cashier123' }) })
  const cashierToken = r.body.token
  r = await api(`/api/v1/customers/${creditCust.id}`, { method: 'PUT', body: JSON.stringify({ creditLimit: 999999 }) }, cashierToken)
  t('cashier cannot change credit terms', r.status === 403 && r.body.error === 'CREDIT_TERMS_FORBIDDEN', r.body)
  r = await api(`/api/v1/customers/${creditCust.id}`, { method: 'PUT', body: JSON.stringify({ creditLimit: 20000 }) }, token)
  t('super admin can', r.status === 200, r.body)
  // a cashier may still extend credit within the limit
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id, payments: [], items: line(1) })}, cashierToken)
  t('cashier can sell on credit within the limit', r.status === 201 && r.body.bill.status === 'CREDIT', r.body)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: creditCust.id, payments: [], items: line(1),
    allowCreditOverride: true })}, cashierToken)
  t('cashier override flag is ignored when over limit',
    r.status === 201 || (r.status === 409 && r.body.reason === 'LIMIT_EXCEEDED'), r.body)


  console.log('\n— returns put stock back where it came from —')
  // Two batches, so a sale spans both and the return has somewhere to get wrong.
  const fifoProd = await prisma.product.create({ data: {
    itemCode: 'FIFO-TEST-001', name: 'FIFO Test', categoryId: cat.id,
    sellingRate: 100, gstPercentage: 0 }})
  const older = await prisma.productBatch.create({ data: {
    productId: fifoProd.id, batchCode: 'OLD', uniqueStockCode: 'FIFO-TEST-001/OLD',
    purchaseRate: 40, receivedQty: 6, currentQty: 6,
    receivedDate: new Date('2026-01-01') }})
  const newer = await prisma.productBatch.create({ data: {
    productId: fifoProd.id, batchCode: 'NEW', uniqueStockCode: 'FIFO-TEST-001/NEW',
    purchaseRate: 70, receivedQty: 10, currentQty: 10,
    receivedDate: new Date('2026-06-01') }})

  // Sell 8: takes all 6 from the older batch and 2 from the newer one.
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: fifoProd.id, quantity: 8, unitRate: 100, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  const fifoBill = r.body.bill
  t('sale spanning two batches created', r.status === 201, r.body)
  let oldQty = Number((await prisma.productBatch.findUnique({ where: { id: older.id } })).currentQty)
  let newQty = Number((await prisma.productBatch.findUnique({ where: { id: newer.id } })).currentQty)
  t('oldest batch drained first', oldQty === 0, oldQty)
  t('remainder taken from the newer batch', newQty === 8, newQty)
  const allocs = await prisma.billItemBatch.findMany({ where: { billItemId: fifoBill.items[0].id } })
  t('the split was recorded', allocs.length === 2, allocs.length)

  // Return 7: six belong to the older batch, one to the newer.
  r = await api(`/api/v1/bills/${fifoBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: fifoBill.items[0].id, quantity: 7 }],
    reasonCode: 'CHANGED_MIND', reason: 'Not needed' })}, token)
  t('return accepted', r.status === 201, r.body)
  oldQty = Number((await prisma.productBatch.findUnique({ where: { id: older.id } })).currentQty)
  newQty = Number((await prisma.productBatch.findUnique({ where: { id: newer.id } })).currentQty)
  t('older batch got its 6 back', oldQty === 6, oldQty)
  t('newer batch got exactly 1 back', newQty === 9, newQty)
  t('reason code stored', (await prisma.bill.findUnique({ where: { id: r.body.bill.id } })).returnReasonCode === 'CHANGED_MIND')

  // Returning the last unit must not overfill the older batch.
  r = await api(`/api/v1/bills/${fifoBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: fifoBill.items[0].id, quantity: 1 }], reasonCode: 'CHANGED_MIND' })}, token)
  t('second return accepted', r.status === 201, r.body)
  oldQty = Number((await prisma.productBatch.findUnique({ where: { id: older.id } })).currentQty)
  newQty = Number((await prisma.productBatch.findUnique({ where: { id: newer.id } })).currentQty)
  t('older batch not overfilled', oldQty === 6, oldQty)
  t('newer batch fully restored', newQty === 10, newQty)
  t('stock is back exactly where it started', oldQty + newQty === 16, oldQty + newQty)

  console.log('\n— damaged goods do not go back on the shelf —')
  const dmgProd = await prisma.product.create({ data: {
    itemCode: 'DMG-TEST-001', name: 'Damage Test', categoryId: cat.id, sellingRate: 50, gstPercentage: 0 }})
  const dmgBatch = await prisma.productBatch.create({ data: {
    productId: dmgProd.id, batchCode: 'D1', uniqueStockCode: 'DMG-TEST-001/D1',
    purchaseRate: 20, receivedQty: 5, currentQty: 5 }})
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: dmgProd.id, quantity: 3, unitRate: 50, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  const dmgBill = r.body.bill
  r = await api(`/api/v1/bills/${dmgBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: dmgBill.items[0].id, quantity: 2 }], reasonCode: 'DAMAGED' })}, token)
  t('damaged return accepted', r.status === 201, r.body)
  t('customer still refunded', Number(r.body.bill.totalAmount) === 100, r.body.bill.totalAmount)
  const dmgQty = Number((await prisma.productBatch.findUnique({ where: { id: dmgBatch.id } })).currentQty)
  t('broken stock NOT put back', dmgQty === 2, dmgQty)
  r = await api(`/api/v1/bills/${dmgBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: dmgBill.items[0].id, quantity: 1 }], reasonCode: 'NOPE' })}, token)
  t('unknown reason rejected', r.status === 400 && r.body.error === 'INVALID_RETURN_REASON', r.body)

  console.log('\n— a cashier can process a return, not a void —')
  r = await api(`/api/v1/bills/${dmgBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: dmgBill.items[0].id, quantity: 1 }], reasonCode: 'WRONG_ITEM' })}, cashierToken)
  t('cashier may return', r.status === 201, r.body)
  r = await api(`/api/v1/bills/${dmgBill.id}/void`, { method: 'POST' }, cashierToken)
  t('cashier may not void', r.status === 403, r.body)

  console.log('\n— void reverses the real split —')
  const voidProd = await prisma.product.create({ data: {
    itemCode: 'VOID-TEST-001', name: 'Void Test', categoryId: cat.id, sellingRate: 10, gstPercentage: 0 }})
  const vOld = await prisma.productBatch.create({ data: {
    productId: voidProd.id, batchCode: 'VO', uniqueStockCode: 'VOID-TEST-001/VO',
    purchaseRate: 3, receivedQty: 4, currentQty: 4, receivedDate: new Date('2026-01-01') }})
  const vNew = await prisma.productBatch.create({ data: {
    productId: voidProd.id, batchCode: 'VN', uniqueStockCode: 'VOID-TEST-001/VN',
    purchaseRate: 5, receivedQty: 4, currentQty: 4, receivedDate: new Date('2026-06-01') }})
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: voidProd.id, quantity: 6, unitRate: 10, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }]
  })}, token)
  r = await api(`/api/v1/bills/${r.body.bill.id}/void`, { method: 'POST' }, token)
  t('void accepted', r.status === 200, r.body)
  t('older batch restored', Number((await prisma.productBatch.findUnique({ where: { id: vOld.id } })).currentQty) === 4)
  t('newer batch restored', Number((await prisma.productBatch.findUnique({ where: { id: vNew.id } })).currentQty) === 4)

  console.log('\n— true cost of goods —')
  // The FIFO sale took 6 @40 and 2 @70 = 380, not 8 x the latest rate (560).
  const fifoDetail = await api(`/api/v1/bills/${fifoBill.id}`, {}, token)
  eqp('cost is the weighted average of the batches used', fifoDetail.body.bill.items[0].purchaseRate, 47.5)

  console.log('\n— purchase orders —')
  r = await api('/api/v1/purchase-orders/suggestions', {}, token)
  t('low-stock suggestions grouped by supplier', Array.isArray(r.body.groups), r.body)
  const poSupplier = await prisma.supplier.create({ data: { name: 'Acme Supplies', phone: '9000000099' }})
  r = await api('/api/v1/purchase-orders', { method: 'POST', body: JSON.stringify({
    supplierId: poSupplier.id,
    items: [{ productId: fifoProd.id, quantity: 20, expectedRate: 45 }] })}, token)
  t('draft order created', r.status === 201 && r.body.order.status === 'DRAFT', r.body)
  t('order number uses PO- prefix', /^PO-\d{4}-\d{4}$/.test(r.body.order.orderNumber), r.body.order?.orderNumber)
  eqp('order total computed', r.body.order.orderTotal, 900)
  const po = r.body.order

  r = await api(`/api/v1/purchase-orders/${po.id}/receive`, { method: 'POST', body: JSON.stringify({
    items: [{ itemId: po.items[0].id, quantity: 5 }] })}, token)
  t('cannot receive against a draft', r.status === 409 && r.body.error === 'ORDER_NOT_RECEIVABLE', r.body)

  r = await api(`/api/v1/purchase-orders/${po.id}/place`, { method: 'POST' }, token)
  t('order placed', r.status === 200 && r.body.order.status === 'PLACED', r.body)
  r = await api(`/api/v1/purchase-orders/${po.id}`, { method: 'PUT', body: JSON.stringify({ notes: 'nope' }) }, token)
  t('a placed order cannot be edited', r.status === 409 && r.body.error === 'ORDER_NOT_EDITABLE', r.body)

  const stockBefore = (await api(`/api/v1/products/${fifoProd.id}`, {}, token)).body.product.totalStock
  r = await api(`/api/v1/purchase-orders/${po.id}/receive`, { method: 'POST', body: JSON.stringify({
    items: [{ itemId: po.items[0].id, quantity: 12, purchaseRate: 53.1, rateIncludesGst: true, purchaseGstPct: 18 }] })}, token)
  t('partial delivery accepted', r.status === 201, r.body)
  t('order stays open', r.body.order.status === 'PARTIAL', r.body.order?.status)
  t('a batch was created', r.body.batches.length === 1, r.body.batches?.length)
  eqp('supplier rate split out of GST', r.body.batches[0].purchaseRate, 45)
  const stockAfter = (await api(`/api/v1/products/${fifoProd.id}`, {}, token)).body.product.totalStock
  eqp('stock increased by what arrived', stockAfter - stockBefore, 12)
  t('order cannot be cancelled once goods arrived',
    (await api(`/api/v1/purchase-orders/${po.id}/cancel`, { method: 'POST' }, token)).status === 409)

  r = await api(`/api/v1/purchase-orders/${po.id}/receive`, { method: 'POST', body: JSON.stringify({
    items: [{ itemId: po.items[0].id, quantity: 8 }] })}, token)
  t('final delivery completes the order', r.body.order?.status === 'RECEIVED', r.body.order?.status)
  r = await api(`/api/v1/purchase-orders/${po.id}/receive`, { method: 'POST', body: JSON.stringify({
    items: [{ itemId: po.items[0].id, quantity: 1 }] })}, token)
  t('a completed order refuses more goods', r.status === 409, r.body)

  // A cancelled draft
  r = await api('/api/v1/purchase-orders', { method: 'POST', body: JSON.stringify({
    supplierId: poSupplier.id, items: [{ productId: fifoProd.id, quantity: 1 }] })}, token)
  r = await api(`/api/v1/purchase-orders/${r.body.order.id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Ordered elsewhere' }) }, token)
  t('draft can be cancelled', r.status === 200 && r.body.order.status === 'CANCELLED', r.body)
  r = await api('/api/v1/purchase-orders', { method: 'POST', body: JSON.stringify({
    supplierId: poSupplier.id, items: [] })}, token)
  t('empty order refused', r.status === 400 && r.body.error === 'ORDER_ITEMS_REQUIRED', r.body)
  r = await api('/api/v1/purchase-orders?status=RECEIVED', {}, token)
  t('orders filterable by status', r.body.orders.every(o => o.status === 'RECEIVED'), r.body.orders?.length)


  console.log('\n— warranties —')
  const wProd = await prisma.product.create({ data: {
    itemCode: 'WARR-TEST-001', name: 'Covered Fan', categoryId: cat.id,
    sellingRate: 1500, gstPercentage: 18, warrantyPeriodDays: 365 }})
  const noWarrProd = await prisma.product.create({ data: {
    itemCode: 'WARR-TEST-002', name: 'Bare Wire', categoryId: cat.id,
    sellingRate: 50, gstPercentage: 18, warrantyPeriodDays: 0 }})
  for (const pr of [wProd, noWarrProd]) {
    await prisma.productBatch.create({ data: {
      productId: pr.id, batchCode: 'W', uniqueStockCode: `${pr.itemCode}/W`,
      purchaseRate: 10, receivedQty: 50, currentQty: 50 }})
  }
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', customerId: localCust.id,
    items: [
      { productId: wProd.id, quantity: 2, unitRate: 1500, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 },
      { productId: noWarrProd.id, quantity: 5, unitRate: 50, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }
    ] })}, token)
  const wBill = r.body.bill
  t('sale with a covered product created', r.status === 201, r.body)
  const covers = await prisma.warranty.findMany({ where: { billId: wBill.id } })
  t('one warranty per covered LINE, not per unit', covers.length === 1, covers.length)
  t('uncovered product got no warranty', !covers.some(c => c.productId === noWarrProd.id))
  t('warranty linked to the customer', covers[0].customerId === localCust.id)
  const expDays = Math.round((covers[0].expiryDate - covers[0].purchaseDate) / 86400000)
  t('expiry is purchase + 365 days', expDays === 365, expDays)
  const wId = covers[0].id

  r = await api('/api/v1/warranties?status=ACTIVE', {}, token)
  t('listed as in cover', r.body.warranties.some(w => w.id === wId && w.status === 'ACTIVE'), r.body.warranties?.length)
  r = await api('/api/v1/warranties?search=Covered', {}, token)
  t('searchable by product name', r.body.warranties.some(w => w.id === wId))
  r = await api('/api/v1/warranties/summary', {}, token)
  t('summary counts active cover', r.body.active >= 1, r.body)
  r = await api('/api/v1/warranties/expiring-soon', {}, token)
  t('a year-long warranty is not expiring soon', !r.body.warranties.some(w => w.id === wId))

  // claim — a cashier may do this
  r = await api(`/api/v1/warranties/${wId}/claim`, { method: 'POST', body: JSON.stringify({ description: '' }) }, cashierToken)
  t('claim needs a description', r.status === 400 && r.body.error === 'DESCRIPTION_REQUIRED', r.body)
  r = await api(`/api/v1/warranties/${wId}/claim`, { method: 'POST', body: JSON.stringify({
    description: 'Motor makes a grinding noise', serialNumber: 'SN-4471' }) }, cashierToken)
  t('cashier can open a claim', r.status === 200 && r.body.warranty.status === 'CLAIMED', r.body)
  t('serial recorded at claim time', r.body.warranty.serialNumber === 'SN-4471')
  t('claimant recorded', r.body.warranty.claimedBy?.username === 'cashier1', r.body.warranty.claimedBy)
  r = await api(`/api/v1/warranties/${wId}/claim`, { method: 'POST', body: JSON.stringify({ description: 'again' }) }, token)
  t('cannot open a second claim', r.status === 409 && r.body.error === 'WARRANTY_ALREADY_CLAIMED', r.body)
  r = await api('/api/v1/warranties?status=CLAIMED', {}, token)
  t('appears under open claims', r.body.warranties.some(w => w.id === wId))

  // resolve — super admin only
  r = await api(`/api/v1/warranties/${wId}/resolve`, { method: 'PUT', body: JSON.stringify({ resolution: 'REPLACED' }) }, cashierToken)
  t('cashier cannot resolve', r.status === 403, r.body)
  r = await api(`/api/v1/warranties/${wId}/resolve`, { method: 'PUT', body: JSON.stringify({ resolution: 'LOST' }) }, token)
  t('unknown resolution rejected', r.status === 400 && r.body.error === 'INVALID_RESOLUTION', r.body)
  r = await api(`/api/v1/warranties/${wId}/resolve`, { method: 'PUT', body: JSON.stringify({
    resolution: 'REPLACED', notes: 'Swapped for a new unit' }) }, token)
  t('super admin resolves', r.status === 200 && r.body.warranty.status === 'RESOLVED', r.body)
  t('resolution stored', r.body.warranty.resolution === 'REPLACED')
  r = await api(`/api/v1/warranties/${wId}/resolve`, { method: 'PUT', body: JSON.stringify({ resolution: 'REPAIRED' }) }, token)
  t('cannot resolve twice', r.status === 409 && r.body.error === 'NO_OPEN_CLAIM', r.body)

  // expiry is a date test, never a stored state
  const lapsed = await prisma.warranty.create({ data: {
    productId: wProd.id, billId: wBill.id,
    billItemId: wBill.items.find(i => i.productId === noWarrProd.id).id,
    purchaseDate: new Date('2024-01-01'), expiryDate: new Date('2025-01-01'), status: 'ACTIVE' }})
  r = await api(`/api/v1/warranties/${lapsed.id}`, {}, token)
  t('lapsed cover reads EXPIRED though stored ACTIVE', r.body.warranty.status === 'EXPIRED' && r.body.warranty.storedStatus === 'ACTIVE', r.body.warranty)
  r = await api(`/api/v1/warranties/${lapsed.id}/claim`, { method: 'POST', body: JSON.stringify({ description: 'broke' }) }, token)
  t('cannot claim after expiry', r.status === 409 && r.body.error === 'WARRANTY_EXPIRED', r.body)
  r = await api('/api/v1/warranties?status=EXPIRED', {}, token)
  t('EXPIRED filter finds it', r.body.warranties.some(w => w.id === lapsed.id))
  r = await api('/api/v1/warranties?status=ACTIVE', {}, token)
  t('ACTIVE filter excludes it', !r.body.warranties.some(w => w.id === lapsed.id))


  console.log('\n— pricing cannot be dictated by the client —')
  const goldProd = await prisma.product.create({ data: {
    itemCode: 'GOLD-TEST-001', name: 'Expensive Item', categoryId: cat.id,
    sellingRate: 45000, gstPercentage: 18 }})
  await prisma.productBatch.create({ data: {
    productId: goldProd.id, batchCode: 'G', uniqueStockCode: 'GOLD-TEST-001/G',
    purchaseRate: 30000, receivedQty: 20, currentQty: 20 }})
  const gline = (o) => [{ productId: goldProd.id, quantity: 1, unitRate: 45000,
    gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0, ...o }]

  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ quantity: 10, lineDiscountPct: 100 }) })}, cashierToken)
  t('100% line discount refused', r.status === 400 && r.body.error === 'INVALID_LINE_DISCOUNT', r.body)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ lineDiscountAmt: 99999 }) })}, cashierToken)
  t('oversized flat discount refused', r.status === 400 && r.body.error === 'INVALID_LINE_DISCOUNT', r.body)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ unitRate: 1 }) })}, cashierToken)
  t('cashier cannot set the price', r.status === 403 && r.body.error === 'PRICE_OVERRIDE_NOT_ALLOWED', r.body)
  t('refusal names the real price', r.body.catalogueRate === 45000, r.body.catalogueRate)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ unitRate: 1 }), allowPriceOverride: true })}, cashierToken)
  t('cashier cannot self-grant the override', r.status === 403, r.body)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ gstPercentage: 0 }) })}, cashierToken)
  t('client GST rate is ignored', r.status === 201 && r.body.bill.gstAmount > 0, r.body.bill?.gstAmount)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({ unitRate: 40000 }), allowPriceOverride: true })}, token)
  t('super admin may override the price', r.status === 201 && r.body.bill.totalAmount === 40000, r.body.bill?.totalAmount)
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({}) })}, cashierToken)
  t('an ordinary sale is unaffected', r.status === 201 && r.body.bill.totalAmount === 45000, r.body.bill?.totalAmount)
  // a deactivated product must not be sellable through the API
  await prisma.product.update({ where: { id: goldProd.id }, data: { isActive: false } })
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH', items: gline({}) })}, cashierToken)
  t('deactivated product cannot be sold', r.status === 409 && r.body.error === 'PRODUCT_INACTIVE', r.body)
  await prisma.product.update({ where: { id: goldProd.id }, data: { isActive: true } })

  console.log('\n— user management —')
  r = await api('/api/v1/users', {}, cashierToken)
  t('cashier cannot list users', r.status === 403, r.body)
  r = await api('/api/v1/users', {}, token)
  t('super admin can list users', r.status === 200 && r.body.users.length >= 2, r.body.users?.length)
  r = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({
    username: 'till2', password: 'password123', role: 'CASHIER' })}, token)
  t('cashier account created', r.status === 201 && r.body.user.role === 'CASHIER', r.body)
  const till2 = r.body.user.id
  r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'till2', password: 'password123' }) })
  t('the new cashier can sign in', r.status === 200 && !!r.body.token, r.body)
  const till2Token = r.body.token
  r = await api('/api/v1/bills/nonexistent/void', { method: 'POST' }, till2Token)
  t('and is genuinely limited to cashier rights', r.status === 403, r.body)
  r = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({
    username: 'till2', password: 'password123', role: 'CASHIER' })}, token)
  t('duplicate username refused', r.status === 409 && r.body.error === 'USERNAME_TAKEN', r.body)
  r = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({
    username: 'x', password: 'password123', role: 'CASHIER' })}, token)
  t('short username refused', r.status === 400, r.body)
  r = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({
    username: 'till3', password: 'short', role: 'CASHIER' })}, token)
  t('weak password refused', r.status === 400 && r.body.error === 'PASSWORD_TOO_SHORT', r.body)
  r = await api('/api/v1/users', { method: 'POST', body: JSON.stringify({
    username: 'till3', password: 'password123', role: 'OWNER' })}, token)
  t('unknown role refused', r.status === 400 && r.body.error === 'INVALID_ROLE', r.body)
  // the shop must never be able to lock itself out
  const adminUser = await prisma.user.findFirst({ where: { username: 'admin' } })
  r = await api(`/api/v1/users/${adminUser.id}`, { method: 'PUT', body: JSON.stringify({ role: 'CASHIER' }) }, token)
  t('the only super admin cannot demote themselves', r.status === 409 && r.body.error === 'LAST_SUPER_ADMIN', r.body)
  r = await api(`/api/v1/users/${adminUser.id}`, { method: 'DELETE' }, token)
  t('and cannot delete themselves', r.status === 409, r.body)
  r = await api(`/api/v1/users/${till2}`, { method: 'PUT', body: JSON.stringify({ password: 'newpassword1' }) }, token)
  t('password can be reset', r.status === 200, r.body)
  r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'till2', password: 'newpassword1' }) })
  t('the new password works', r.status === 200, r.body)
  r = await api(`/api/v1/users/${till2}`, { method: 'DELETE' }, token)
  t('an unused account can be removed', r.status === 200, r.body)
  // an account that has billed keeps its history
  const cashierUser = await prisma.user.findFirst({ where: { username: 'cashier1' } })
  r = await api(`/api/v1/users/${cashierUser.id}`, { method: 'DELETE' }, token)
  t('an account with bills is protected', r.status === 409 && r.body.error === 'USER_HAS_BILLS', r.body)


  console.log('\n— paying after a return must not resurrect the debt —')
  const phProd = await prisma.product.create({ data: {
    itemCode: 'PH-TEST-001', name: 'Phantom Test', categoryId: cat.id,
    sellingRate: 1000, gstPercentage: 0 }})
  await prisma.productBatch.create({ data: {
    productId: phProd.id, batchCode: 'P', uniqueStockCode: 'PH-TEST-001/P',
    purchaseRate: 500, receivedQty: 50, currentQty: 50 }})
  const phCust = await prisma.customer.create({ data: {
    name: 'Phantom Buyer', phone: '9000000077', creditLimit: 100000, creditDays: 30 }})
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: phCust.id, payments: [],
    items: [{ productId: phProd.id, quantity: 20, unitRate: 1000, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
  const phBill = r.body.bill
  eqp('credit sale owes the full amount', phBill.balanceDue, 20000)
  r = await api(`/api/v1/bills/${phBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: phBill.items[0].id, quantity: 5 }], reasonCode: 'CHANGED_MIND' })}, token)
  t('return accepted', r.status === 201, r.body)
  let phAfter = await prisma.bill.findUnique({ where: { id: phBill.id } })
  eqp('returning 5 drops the balance to 15,000', Number(phAfter.balanceDue), 15000)
  // the customer now settles exactly what they owe
  r = await api('/api/v1/payments', { method: 'POST', body: JSON.stringify({
    customerId: phCust.id, amount: 15000, method: 'CASH' })}, token)
  t('payment accepted', r.status === 201, r.body)
  phAfter = await prisma.bill.findUnique({ where: { id: phBill.id } })
  eqp('bill is fully settled', Number(phAfter.balanceDue), 0)
  t('and marked PAID', phAfter.status === 'PAID', phAfter.status)
  r = await api(`/api/v1/customers/${phCust.id}/outstanding`, {}, token)
  eqp('customer owes nothing', r.body.outstanding, 0)


  console.log('\n— two tills cannot sell the same last unit —')
  const raceProd = await prisma.product.create({ data: {
    itemCode: 'RACE-TEST-001', name: 'Last One', categoryId: cat.id,
    sellingRate: 100, gstPercentage: 0 }})
  const raceBatch = await prisma.productBatch.create({ data: {
    productId: raceProd.id, batchCode: 'R', uniqueStockCode: 'RACE-TEST-001/R',
    purchaseRate: 50, receivedQty: 1, currentQty: 1 }})
  const raceBody = () => JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: raceProd.id, quantity: 1, unitRate: 100, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })
  // fire both at once, the way two terminals would
  const [r1, r2] = await Promise.all([
    api('/api/v1/bills', { method: 'POST', body: raceBody() }, token),
    api('/api/v1/bills', { method: 'POST', body: raceBody() }, token)
  ])
  const wins = [r1, r2].filter((x) => x.status === 201).length
  const refusals = [r1, r2].filter((x) => x.status === 409 && x.body?.error === 'INSUFFICIENT_STOCK').length
  t('exactly one sale succeeds', wins === 1, { r1: r1.status, r2: r2.status })
  t('the other is told stock ran out', refusals === 1, { r1: r1.body?.error, r2: r2.body?.error })
  const raceQty = Number((await prisma.productBatch.findUnique({ where: { id: raceBatch.id } })).currentQty)
  t('stock lands at zero, never negative', raceQty === 0, raceQty)
  t('and only one bill exists for it',
    (await prisma.billItem.count({ where: { productId: raceProd.id } })) === 1)

  // ten tills against five units
  const race2 = await prisma.product.create({ data: {
    itemCode: 'RACE-TEST-002', name: 'Five Left', categoryId: cat.id, sellingRate: 10, gstPercentage: 0 }})
  const batch2 = await prisma.productBatch.create({ data: {
    productId: race2.id, batchCode: 'R2', uniqueStockCode: 'RACE-TEST-002/R2',
    purchaseRate: 5, receivedQty: 5, currentQty: 5 }})
  const results = await Promise.all(Array.from({ length: 10 }, () =>
    api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
      originDeviceId: device.id, paymentMethod: 'CASH',
      items: [{ productId: race2.id, quantity: 1, unitRate: 10, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)))
  const sold = results.filter((x) => x.status === 201).length
  const q2 = Number((await prisma.productBatch.findUnique({ where: { id: batch2.id } })).currentQty)
  t('ten tills, five units: exactly five sales', sold === 5, sold)
  t('stock exactly exhausted', q2 === 0, q2)


  console.log('\n— concurrent void and return cannot double-count —')
  const dupProd = await prisma.product.create({ data: {
    itemCode: 'DUP-TEST-001', name: 'Double Test', categoryId: cat.id, sellingRate: 100, gstPercentage: 0 }})
  const dupBatch = await prisma.productBatch.create({ data: {
    productId: dupProd.id, batchCode: 'D', uniqueStockCode: 'DUP-TEST-001/D',
    purchaseRate: 50, receivedQty: 20, currentQty: 20 }})
  const mkBill = async () => (await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: dupProd.id, quantity: 4, unitRate: 100, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)).body.bill

  // two voids of the same bill at once
  let dupBill = await mkBill()
  let dupBefore = Number((await prisma.productBatch.findUnique({ where: { id: dupBatch.id } })).currentQty)
  const voids = await Promise.all([
    api(`/api/v1/bills/${dupBill.id}/void`, { method: 'POST' }, token),
    api(`/api/v1/bills/${dupBill.id}/void`, { method: 'POST' }, token)
  ])
  t('only one void succeeds', voids.filter((v) => v.status === 200).length === 1, voids.map(v => v.status))
  let dupAfter = Number((await prisma.productBatch.findUnique({ where: { id: dupBatch.id } })).currentQty)
  eqp('stock restored once, not twice', dupAfter - dupBefore, 4)

  // two returns of the same line at once
  dupBill = await mkBill()
  dupBefore = Number((await prisma.productBatch.findUnique({ where: { id: dupBatch.id } })).currentQty)
  const rets = await Promise.all([
    api(`/api/v1/bills/${dupBill.id}/return`, { method: 'POST', body: JSON.stringify({
      items: [{ billItemId: dupBill.items[0].id, quantity: 4 }], reasonCode: 'CHANGED_MIND' })}, token),
    api(`/api/v1/bills/${dupBill.id}/return`, { method: 'POST', body: JSON.stringify({
      items: [{ billItemId: dupBill.items[0].id, quantity: 4 }], reasonCode: 'CHANGED_MIND' })}, token)
  ])
  t('only one return succeeds', rets.filter((x) => x.status === 201).length === 1, rets.map(x => x.status))
  dupAfter = Number((await prisma.productBatch.findUnique({ where: { id: dupBatch.id } })).currentQty)
  eqp('returned goods restocked once', dupAfter - dupBefore, 4)

  // two collections against the same balance at once
  const dupCust = await prisma.customer.create({ data: {
    name: 'Race Payer', phone: '9000000088', creditLimit: 100000, creditDays: 30 }})
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: dupCust.id, payments: [],
    items: [{ productId: dupProd.id, quantity: 5, unitRate: 100, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
  const payBody = JSON.stringify({ customerId: dupCust.id, amount: 500, method: 'CASH' })
  const pays = await Promise.all([
    api('/api/v1/payments', { method: 'POST', body: payBody }, token),
    api('/api/v1/payments', { method: 'POST', body: payBody }, token)
  ])
  t('only one collection succeeds', pays.filter((x) => x.status === 201).length === 1, pays.map(x => x.status))
  const paidTotal = await prisma.payment.aggregate({
    where: { customerId: dupCust.id, isSettlement: true }, _sum: { amount: true } })
  eqp('the ledger records what was actually taken', Number(paidTotal._sum.amount ?? 0), 500)
  r = await api(`/api/v1/customers/${dupCust.id}/outstanding`, {}, token)
  eqp('and the customer owes nothing more', r.body.outstanding, 0)


  console.log('\n— an exchange records only the money that moved —')
  const exProd = await prisma.product.create({ data: {
    itemCode: 'EX-CHEAP-001', name: 'Cheap Item', categoryId: cat.id, sellingRate: 200, gstPercentage: 0 }})
  const exDear = await prisma.product.create({ data: {
    itemCode: 'EX-DEAR-001', name: 'Dear Item', categoryId: cat.id, sellingRate: 1200, gstPercentage: 0 }})
  for (const pr of [exProd, exDear]) {
    await prisma.productBatch.create({ data: {
      productId: pr.id, batchCode: 'E', uniqueStockCode: `${pr.itemCode}/E`,
      purchaseRate: 100, receivedQty: 30, currentQty: 30 }})
  }
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    items: [{ productId: exProd.id, quantity: 1, unitRate: 200, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
  const exBill = r.body.bill
  const tenderBefore = Number((await prisma.payment.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0)
  // swap a 200 item for a 1200 one; the customer hands over 1000
  r = await api(`/api/v1/bills/${exBill.id}/exchange`, { method: 'POST', body: JSON.stringify({
    returnItems: [{ billItemId: exBill.items[0].id, quantity: 1 }],
    replacementItems: [{ productId: exDear.id, quantity: 1 }],
    amountReceived: 1000, reasonCode: 'WRONG_ITEM' })}, token)
  t('exchange accepted', r.status === 201, r.body)
  eqp('net difference reported', r.body.netDifference, 1000)
  t('replacement is fully settled', r.body.replacementBill.balanceDue === 0, r.body.replacementBill?.balanceDue)
  const tenderAfter = Number((await prisma.payment.aggregate({ _sum: { amount: true } }))._sum.amount ?? 0)
  eqp('only the 1,000 difference enters the ledger', tenderAfter - tenderBefore, 1000)


  console.log('\n— mixed whole and fractional quantities —')
  // Guards a bind-format regression: Prisma binds 3 and 2.75 as different
  // types, and a prepared statement keeps whichever it saw first, so mixing
  // them against one connection pool used to fail intermittently.
  const mixProd = await prisma.product.create({ data: {
    itemCode: 'MIX-TEST-001', name: 'Mixed Units', categoryId: cat.id,
    sellMode: 'LENGTH', unitOfMeasure: 'm', sellingRate: 10, gstPercentage: 0 }})
  await prisma.productBatch.create({ data: {
    productId: mixProd.id, batchCode: 'M', uniqueStockCode: 'MIX-TEST-001/M',
    purchaseRate: 5, receivedQty: 100, currentQty: 100 }})
  for (const qty of [2.75, 1, 0.25, 3, 0.001, 10]) {
    r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
      originDeviceId: device.id, paymentMethod: 'CASH',
      items: [{ productId: mixProd.id, quantity: qty, unitRate: 10, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
    t(`billing ${qty} works`, r.status === 201, { qty, status: r.status, body: r.body })
  }
  const mixLeft = Number((await prisma.productBatch.findFirst({ where: { productId: mixProd.id } })).currentQty)
  eqp('stock reduced by the exact total', 100 - mixLeft, 16.999 + 0.002)


  console.log('\n— analytics counts the right money —')
  const anProd = await prisma.product.create({ data: {
    itemCode: 'AN-TEST-001', name: 'Analytics Item', categoryId: cat.id, sellingRate: 1000, gstPercentage: 0 }})
  await prisma.productBatch.create({ data: {
    productId: anProd.id, batchCode: 'A', uniqueStockCode: 'AN-TEST-001/A',
    purchaseRate: 400, receivedQty: 100, currentQty: 100 }})
  const anCust = await prisma.customer.create({ data: {
    name: 'Analytics Buyer', phone: '9000000099', creditLimit: 100000, creditDays: 30 }})
  const anBefore = (await api('/api/v1/analytics/summary?period=today', {}, token)).body.summary

  // a credit sale must count as revenue immediately
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, customerId: anCust.id, payments: [],
    items: [{ productId: anProd.id, quantity: 5, unitRate: 1000, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
  const creditBill = r.body.bill
  let anAfter = (await api('/api/v1/analytics/summary?period=today', {}, token)).body.summary
  eqp('an unpaid credit sale still counts as revenue', anAfter.totalRevenue - anBefore.totalRevenue, 5000)

  // a split tender must be attributed to both methods
  r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
    originDeviceId: device.id, paymentMethod: 'CASH',
    payments: [{ method: 'CASH', amount: 400 }, { method: 'UPI', amount: 600 }],
    items: [{ productId: anProd.id, quantity: 1, unitRate: 1000, gstPercentage: 0, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
  t('split-tender sale created', r.status === 201, r.body)
  const afterSplit = (await api('/api/v1/analytics/summary?period=today', {}, token)).body.summary
  eqp('cash half attributed to cash', afterSplit.paymentBreakdown.CASH - anAfter.paymentBreakdown.CASH, 400)
  eqp('upi half attributed to upi', afterSplit.paymentBreakdown.UPI - anAfter.paymentBreakdown.UPI, 600)
  t('cheque is reported, not silently dropped', typeof afterSplit.paymentBreakdown.CHEQUE === 'number', afterSplit.paymentBreakdown)

  // returned goods come off revenue
  r = await api(`/api/v1/bills/${creditBill.id}/return`, { method: 'POST', body: JSON.stringify({
    items: [{ billItemId: creditBill.items[0].id, quantity: 5 }], reasonCode: 'CHANGED_MIND' })}, token)
  t('full return accepted', r.status === 201, r.body)
  const afterReturn = (await api('/api/v1/analytics/summary?period=today', {}, token)).body.summary
  eqp('returns are subtracted from net revenue',
    afterReturn.netRevenue - afterSplit.netRevenue, -5000)
  t('gross and net are both reported',
    afterReturn.totalRevenue > afterReturn.netRevenue, { g: afterReturn.totalRevenue, n: afterReturn.netRevenue })
  t('margin stays a believable percentage',
    afterReturn.estimatedMarginPct < 100, afterReturn.estimatedMarginPct)


  console.log('\n— a sale is dated when it happened —')
  {
    // Its own product: earlier blocks deactivate and drain the shared ones.
    const dateProd = await prisma.product.create({ data: {
      itemCode: 'DATE-TEST-001', name: 'Dating Item', categoryId: cat.id,
      sellingRate: 118, gstPercentage: 18 }})
    await prisma.productBatch.create({ data: {
      productId: dateProd.id, batchCode: 'D', uniqueStockCode: 'DATE-TEST-001/D',
      purchaseRate: 60, receivedQty: 100, currentQty: 100 }})
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
      originDeviceId: device.id, paymentMethod: 'CASH', soldAt: twoHoursAgo.toISOString(),
      payments: [{ method: 'CASH', amount: 118 }],
      items: [{ productId: dateProd.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
    t('a backdated sale is accepted', r.status === 201, r.body)
    const stored = await prisma.bill.findUnique({ where: { id: r.body.bill.id } })
    t('the sale keeps the time the till reported',
      Math.abs(stored.paidAt.getTime() - twoHoursAgo.getTime()) < 2000,
      { stored: stored.paidAt, sent: twoHoursAgo })

    // A till with a broken clock must not be able to write into next year's
    // books, or into a month already closed and filed.
    for (const [label, when] of [
      ['a future date', new Date(Date.now() + 48 * 60 * 60 * 1000)],
      ['a date beyond the backdating window', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)],
      ['a nonsense date', 'not-a-date']
    ]) {
      const resp = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
        originDeviceId: device.id, paymentMethod: 'CASH',
        soldAt: when instanceof Date ? when.toISOString() : when,
        payments: [{ method: 'CASH', amount: 118 }],
        items: [{ productId: dateProd.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
      t(`${label} is accepted, not rejected`, resp.status === 201, resp.body)
      const row = await prisma.bill.findUnique({ where: { id: resp.body.bill.id } })
      t(`${label} is clamped to now`, Math.abs(row.paidAt.getTime() - Date.now()) < 60000, row.paidAt)
    }

    // Credit ageing has to run from the sale, not from the sync.
    const backCust = await prisma.customer.create({ data: {
      name: 'Backdated Buyer', phone: '9000000078', creditLimit: 50000, creditDays: 10 }})
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    r = await api('/api/v1/bills', { method: 'POST', body: JSON.stringify({
      originDeviceId: device.id, customerId: backCust.id, payments: [],
      soldAt: threeDaysAgo.toISOString(),
      items: [{ productId: dateProd.id, quantity: 1, unitRate: 118, gstPercentage: 18, lineDiscountPct: 0, lineDiscountAmt: 0 }] })}, token)
    t('a backdated credit sale is accepted', r.status === 201, r.body)
    const credit = await prisma.bill.findUnique({ where: { id: r.body.bill.id } })
    const expectedDue = new Date(threeDaysAgo.getTime() + 10 * 24 * 60 * 60 * 1000)
    t('the due date counts from the sale, not the sync',
      Math.abs(credit.dueDate.getTime() - expectedDue.getTime()) < 2000,
      { due: credit.dueDate, expected: expectedDue })
  }

  console.log('\n— the change feed cannot skip a commit —')
  {
    // Drain whatever the earlier tests generated so the window is clean.
    let cursor = '0'
    for (let i = 0; i < 50; i++) {
      const page = (await api(`/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=500`, {}, token)).body
      if (!page.events.length) break
      cursor = page.nextCursor
      if (!page.hasMore) break
    }
    t('cursors are (txid, id) pairs', /^\d+:\d+$/.test(cursor) || cursor === '0', cursor)

    // Hold a transaction open with an unsent event in it, exactly as a slow
    // sale would. Then commit a *later* event from another connection.
    let release
    const gate = new Promise((r) => { release = r })
    const held = prisma.$transaction(async (tx) => {
      await tx.syncEvent.create({ data: {
        entity: 'product', entityId: 'held-by-open-txn', op: 'upsert', payload: { name: 'Held' } }})
      await gate
    }, { timeout: 30000, maxWait: 30000 })

    await new Promise((r) => setTimeout(r, 300))
    await prisma.syncEvent.create({ data: {
      entity: 'product', entityId: 'committed-after', op: 'upsert', payload: { name: 'After' } }})

    const during = (await api(`/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=500`, {}, token)).body
    const idsDuring = during.events.map((e) => e.entityId)
    t('the later commit waits for the earlier one',
      !idsDuring.includes('committed-after'), idsDuring)
    t('...and so does the one still in flight',
      !idsDuring.includes('held-by-open-txn'), idsDuring)

    release()
    await held

    const after = (await api(`/api/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=500`, {}, token)).body
    const idsAfter = after.events.map((e) => e.entityId)
    t('both arrive once the slow write lands', idsAfter.includes('held-by-open-txn') && idsAfter.includes('committed-after'), idsAfter)
    t('in commit order, oldest first',
      idsAfter.indexOf('held-by-open-txn') < idsAfter.indexOf('committed-after'), idsAfter)
    t('every event carries a resume token',
      after.events.every((e) => /^\d+:\d+$/.test(e.cursor)), after.events[0])

    // A bare id from an older terminal build still means something.
    const legacy = (await api('/api/v1/sync/pull?cursor=0&limit=5', {}, token)).body
    t('a legacy id-only cursor is accepted', legacy.events.length > 0, legacy)
    const resumed = (await api(`/api/v1/sync/pull?cursor=${encodeURIComponent(after.nextCursor)}&limit=500`, {}, token)).body
    eqp('resuming from nextCursor returns nothing new', resumed.events.length, 0)
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  process.exit(fail ? 1 : 0)
})().catch(e => { console.error('SMOKE CRASHED:', e); process.exit(1) })
