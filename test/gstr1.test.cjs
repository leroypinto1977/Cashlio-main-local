/**
 * The GST return, built from a month of deliberately varied trade.
 *
 * The point of these is that the return has to *agree with the invoices* —
 * so most assertions compare a section's totals against the bills that fed it,
 * rather than against a number written down here.
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const buildDir = path.join(__dirname, '.build')
fs.mkdirSync(buildDir, { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'domain', 'gstr1.ts')],
  outfile: path.join(buildDir, 'gstr1.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['@prisma/client']
})
const G = require(path.join(buildDir, 'gstr1.cjs'))

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 220)) }
}
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.02
const eq = (name, a, b) => t(`${name} (${a} == ${b})`, near(a, b))

;(async () => {
  // ── A shop in Tamil Nadu (33), trading in one month ───────────────────────
  const MONTH = 6, YEAR = 2026
  const on = (day, month = MONTH) => new Date(Date.UTC(YEAR, month - 1, day, 6, 0, 0))

  await prisma.shopConfig.create({ data: {
    shopName: 'GST Test Traders', branchName: 'Main', licenseKey: 'GST-1', licenseJwt: 'x',
    gstin: '33AABCS1429B1Z1', stateCode: '33' }})
  const user = await prisma.user.create({ data: {
    username: 'gstadmin', passwordHash: 'x', role: 'SUPER_ADMIN' }})
  const device = await prisma.authorizedClient.create({ data: {
    friendlyName: 'GST Till', macAddress: 'GS:TT:00:00:00:01', terminalCode: 'G1' }})
  const cat = await prisma.category.create({ data: { name: 'GST Goods' } })

  const product = async (code, hsn, rate, gst, uom = 'pcs') =>
    prisma.product.create({ data: {
      itemCode: code, name: `Item ${code}`, categoryId: cat.id, hsnCode: hsn,
      sellingRate: rate, gstPercentage: gst, unitOfMeasure: uom }})

  const cable = await product('GST-CABLE', '854442', 100, 18, 'm')
  const lamp = await product('GST-LAMP', '940540', 200, 12)
  const noHsn = await product('GST-NOHSN', null, 50, 5)

  const customer = async (name, gstin) => prisma.customer.create({ data: {
    name, phone: '90000' + String(Math.floor(10000 + Math.random() * 89999)), gstin }})
  const registeredLocal = await customer('Local Contractor', '33AAGCR8899K1ZI')
  const registeredFar = await customer('Bengaluru Builder', '29AAECS7788N1Z8')
  const walkInFar = await customer('Kerala Walk-in', null)

  /** Writes a bill directly, with the tax split already worked out. */
  const bill = async (opts) => {
    const { number, day, month, customerId, pos, interState, lines, status = 'PAID', originalBillId } = opts
    let taxable = 0, gst = 0, total = 0
    const items = lines.map((l) => {
      const lineTotal = Math.round(l.qty * l.rate * 100) / 100
      const tv = Math.round((lineTotal / (1 + l.gst / 100)) * 100) / 100
      const tax = Math.round((lineTotal - tv) * 100) / 100
      taxable += tv; gst += tax; total += lineTotal
      return {
        productId: l.product.id, itemCode: l.product.itemCode, productName: l.product.name,
        unitOfMeasure: l.product.unitOfMeasure, hsnCode: l.product.hsnCode,
        quantity: l.qty, unitRate: l.rate, gstPercentage: l.gst,
        lineGstAmount: tax, lineTotal, taxableValue: tv,
        cgstAmount: interState ? 0 : Math.round((tax / 2) * 100) / 100,
        sgstAmount: interState ? 0 : Math.round((tax - tax / 2) * 100) / 100,
        igstAmount: interState ? tax : 0
      }
    })
    return prisma.bill.create({ data: {
      billNumber: number, status, customerId: customerId ?? null,
      originDeviceId: device.id, cashierId: user.id, originalBillId: originalBillId ?? null,
      subtotal: total, gstAmount: gst, totalAmount: total, taxableValue: taxable,
      cgstAmount: interState ? 0 : Math.round((gst / 2) * 100) / 100,
      sgstAmount: interState ? 0 : Math.round((gst - gst / 2) * 100) / 100,
      igstAmount: interState ? gst : 0,
      placeOfSupply: pos, paymentMethod: 'CASH', paidAmount: total, balanceDue: 0,
      paidAt: on(day, month), items: { create: items } }, include: { items: true } })
  }

  // Registered, in state → B2B with CGST + SGST
  const b2bLocal = await bill({ number: 'INV-2606-0001', day: 3, customerId: registeredLocal.id,
    pos: '33', interState: false, lines: [{ product: cable, qty: 10, rate: 100, gst: 18 }] })
  // Registered, another state → B2B with IGST
  const b2bFar = await bill({ number: 'INV-2606-0002', day: 5, customerId: registeredFar.id,
    pos: '29', interState: true, lines: [{ product: lamp, qty: 4, rate: 200, gst: 12 }] })
  // Walk-ins, in state → B2CS
  await bill({ number: 'INV-2606-0003', day: 7, pos: '33', interState: false,
    lines: [{ product: cable, qty: 5, rate: 100, gst: 18 }] })
  await bill({ number: 'INV-2606-0004', day: 9, pos: '33', interState: false,
    lines: [{ product: cable, qty: 3, rate: 100, gst: 18 }, { product: lamp, qty: 2, rate: 200, gst: 12 }] })
  // Large inter-state walk-in → B2CL
  const big = await bill({ number: 'INV-2606-0005', day: 11, customerId: walkInFar.id,
    pos: '32', interState: true, lines: [{ product: lamp, qty: 1500, rate: 200, gst: 12 }] })
  // A voided bill — a number issued, but never a supply
  await bill({ number: 'INV-2606-0006', day: 12, pos: '33', interState: false, status: 'VOID',
    lines: [{ product: cable, qty: 1, rate: 100, gst: 18 }] })
  // Credit note against the registered local sale → CDNR
  await bill({ number: 'CN-2606-0001', day: 20, customerId: registeredLocal.id, pos: '33',
    interState: false, status: 'RETURN', originalBillId: b2bLocal.id,
    lines: [{ product: cable, qty: 2, rate: 100, gst: 18 }] })
  // A product with no HSN, sold — the readiness check should notice
  await bill({ number: 'INV-2606-0007', day: 22, pos: '33', interState: false,
    lines: [{ product: noHsn, qty: 6, rate: 50, gst: 5 }] })
  // Outside the period entirely
  await bill({ number: 'INV-2607-0001', day: 3, month: 7, pos: '33', interState: false,
    lines: [{ product: cable, qty: 99, rate: 100, gst: 18 }] })

  const r = await G.buildGstr1({ month: MONTH, year: YEAR })

  console.log('\n— the period is the period —')
  t('the filing period is MMYYYY', r.fp === '062026', r.fp)
  t('and reads as a month', r.periodLabel === 'June 2026', r.periodLabel)
  const allNumbers = [
    ...r.b2b.flatMap((g) => g.invoices.map((i) => i.invoiceNumber)),
    ...r.b2cl.flatMap((g) => g.invoices.map((i) => i.invoiceNumber)),
    ...r.cdnr.flatMap((g) => g.notes.map((n) => n.invoiceNumber))
  ]
  t('July’s invoice is not in June’s return', !allNumbers.includes('INV-2607-0001'), allNumbers)
  t('a voided bill is not reported as a supply', !allNumbers.includes('INV-2606-0006'), allNumbers)

  console.log('\n— registered buyers are named —')
  eq('two registered customers', r.b2b.length, 2)
  const local = r.b2b.find((g) => g.ctin === '33AAGCR8899K1ZI')
  t('the in-state one is there', Boolean(local), r.b2b.map((g) => g.ctin))
  eq('with its one invoice', local.invoices.length, 1)
  eq('at the right value', local.invoices[0].invoiceValue, 1000)
  t('taxed as CGST + SGST', local.invoices[0].items[0].cgst > 0 && local.invoices[0].items[0].igst === 0,
    local.invoices[0].items[0])
  const far = r.b2b.find((g) => g.ctin === '29AAECS7788N1Z8')
  t('the out-of-state one is taxed as IGST',
    far.invoices[0].items[0].igst > 0 && far.invoices[0].items[0].cgst === 0, far.invoices[0].items[0])
  t('...and its place of supply is the buyer’s state', far.invoices[0].placeOfSupply === '29',
    far.invoices[0].placeOfSupply)

  console.log('\n— a large inter-state walk-in is named too —')
  eq('one B2CL group', r.b2cl.length, 1)
  t('for the right state', r.b2cl[0].pos === '32', r.b2cl[0].pos)
  t('naming the invoice', r.b2cl[0].invoices[0].invoiceNumber === 'INV-2606-0005')
  t('because it is over the threshold', big.totalAmount > 250000, Number(big.totalAmount))

  console.log('\n— everybody else is summed —')
  const cs18 = r.b2cs.find((x) => x.rate === 18 && x.supplyType === 'INTRA')
  const cs12 = r.b2cs.find((x) => x.rate === 12 && x.supplyType === 'INTRA')
  t('an 18% intra-state bucket exists', Boolean(cs18), r.b2cs)
  t('and a 12% one', Boolean(cs12), r.b2cs)
  // 5 + 3 cable at ₹100 incl 18% = 800 gross → 677.97 taxable
  eq('the 18% bucket sums both walk-in sales', cs18.taxableValue, 677.97)
  t('rates are not mixed together', cs18.rate !== cs12.rate)
  t('walk-ins are never listed by invoice number',
    !JSON.stringify(r.b2cs).includes('INV-2606-0003'))

  console.log('\n— a credit note reduces the month —')
  eq('one registered credit note', r.cdnr.length, 1)
  const note = r.cdnr[0].notes[0]
  t('marked as a credit', note.noteType === 'C', note.noteType)
  t('against the invoice it reverses', note.againstInvoice === 'INV-2606-0001', note.againstInvoice)
  t('with that invoice’s date', /^\d\d-06-2026$/.test(note.againstInvoiceDate), note.againstInvoiceDate)
  eq('for the value returned', note.invoiceValue, 200)

  console.log('\n— the return agrees with the invoices —')
  const sales = await prisma.bill.findMany({
    where: { billNumber: { startsWith: 'INV-2606' }, status: { in: ['PAID', 'PARTIAL', 'CREDIT'] } } })
  const notes = await prisma.bill.findMany({ where: { billNumber: { startsWith: 'CN-2606' } } })
  const expectedTaxable =
    sales.reduce((s, b) => s + Number(b.taxableValue), 0) -
    notes.reduce((s, b) => s + Number(b.taxableValue), 0)
  eq('taxable value matches the bills, net of credit notes', r.totals.taxableValue, expectedTaxable)
  const expectedTax =
    sales.reduce((s, b) => s + Number(b.gstAmount), 0) -
    notes.reduce((s, b) => s + Number(b.gstAmount), 0)
  eq('and so does the tax', r.totals.totalTax, expectedTax)
  eq('invoices counted', r.totals.invoiceCount, sales.length)
  eq('credit notes counted', r.totals.creditNoteCount, notes.length)

  console.log('\n— the HSN summary —')
  const cableHsn = r.hsn.find((h) => h.hsnCode === '854442')
  t('cable is summarised under its code', Boolean(cableHsn), r.hsn.map((h) => h.hsnCode))
  t('in metres, as MTR', cableHsn.uqc === 'MTR', cableHsn.uqc)
  // 10 + 5 + 3 sold, 2 returned
  eq('quantity is net of the return', cableHsn.quantity, 16)
  const lampHsn = r.hsn.find((h) => h.hsnCode === '940540')
  eq('lamps in pieces', lampHsn.quantity, 1506)
  t('...as PCS', lampHsn.uqc === 'PCS', lampHsn.uqc)
  t('a product with no HSN is not invented into the summary',
    r.hsn.every((h) => h.hsnCode), r.hsn.map((h) => h.hsnCode))

  console.log('\n— it says what would make the filing wrong —')
  t('the missing HSN is reported as blocking',
    r.readiness.blocking.some((b) => /HSN/.test(b)), r.readiness)
  t('...naming the product', r.readiness.blocking.some((b) => /GST-NOHSN/.test(b)),
    r.readiness.blocking)
  t('nothing blocking is invented about the GSTIN',
    !r.readiness.blocking.some((b) => /GSTIN/.test(b)), r.readiness.blocking)

  console.log('\n— the document series —')
  t('the invoice series is declared', r.documents.some((d) => d.from.startsWith('INV-2606')), r.documents)
  const inv = r.documents.find((d) => d.from.startsWith('INV-2606'))
  eq('counting every number issued, including the voided one', inv.total, 7)
  eq('and saying how many were cancelled', inv.cancelled, 1)

  console.log('\n— the portal’s own shape —')
  const j = G.toPortalJson(r)
  t('addressed with the shop’s GSTIN', j.gstin === '33AABCS1429B1Z1', j.gstin)
  t('for the filing period', j.fp === '062026', j.fp)
  t('b2b uses the portal’s keys', j.b2b[0].inv[0].inum && j.b2b[0].inv[0].itms[0].itm_det.rt !== undefined,
    j.b2b[0].inv[0])
  t('b2cs is a flat list of rate buckets', Array.isArray(j.b2cs) && j.b2cs[0].sply_ty, j.b2cs[0])
  t('credit notes are typed C', j.cdnr[0].nt[0].ntty === 'C', j.cdnr[0].nt[0].ntty)
  t('the HSN summary is numbered', j.hsn.data[0].num === 1, j.hsn.data[0])
  const invDoc = j.doc_issue.doc_det[0].docs.find((d) => d.from.startsWith('INV-2606'))
  t('the document series reports its net', invDoc && invDoc.net_issue === 6, invDoc)
  t('dates are DD-MM-YYYY as the portal wants',
    /^\d{2}-\d{2}-\d{4}$/.test(j.b2b[0].inv[0].idt), j.b2b[0].inv[0].idt)
  t('empty sections are left out rather than sent empty', !('cdnur' in j), Object.keys(j))
  t('it survives being serialised', JSON.parse(JSON.stringify(j)).fp === '062026')

  console.log('\n— a month with nothing in it —')
  const nil = await G.buildGstr1({ month: 1, year: 2020 })
  eq('no invoices', nil.totals.invoiceCount, 0)
  eq('no tax', nil.totals.totalTax, 0)
  t('and it says so', nil.readiness.warnings.some((w) => /nil return/i.test(w)), nil.readiness)
  t('the portal form is still addressable', G.toPortalJson(nil).gstin === '33AABCS1429B1Z1')

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  fs.rmSync(buildDir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1) })
