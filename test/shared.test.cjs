// Unit tests for the shared money/GST and validation modules.
// Run with: npm run test:shared
const { computeInvoiceTotals, splitGst, apportionDiscount, round2 } = require('../.test-build/money.js')
const V = require('../.test-build/validation.js')
const U = require('../.test-build/units.js')

let pass = 0, fail = 0
function check(name, cond, detail) {
  if (cond) { pass++ } else { fail++; console.log('  FAIL:', name, detail !== undefined ? JSON.stringify(detail) : '') }
}
function eq(name, actual, expected) {
  check(name, Math.abs(actual - expected) < 0.005, { actual, expected })
}

// Invariants that must hold for ANY invoice
function invariants(label, t) {
  eq(`${label}: taxable+gst == total`, round2(t.taxableValue + t.gstAmount), t.totalAmount)
  eq(`${label}: cgst+sgst+igst == gst`, round2(t.cgstAmount + t.sgstAmount + t.igstAmount), t.gstAmount)
  eq(`${label}: subtotal-discount == total`, round2(t.subtotal - t.billDiscount), t.totalAmount)
  const shareSum = round2(t.lines.reduce((s, l) => s + l.billDiscountAmt, 0))
  eq(`${label}: shares sum to discount`, shareSum, t.billDiscount)
  const lineSum = round2(t.lines.reduce((s, l) => s + round2(l.taxableValue + l.gstAmount), 0))
  eq(`${label}: line nets sum to total`, lineSum, t.totalAmount)
}

console.log('\n— GST extraction —')
let s = splitGst(1180, 18, false)
eq('1180 @18% incl -> taxable', s.taxableValue, 1000)
eq('1180 @18% incl -> gst', s.gstAmount, 180)
eq('cgst', s.cgstAmount, 90); eq('sgst', s.sgstAmount, 90); eq('igst', s.igstAmount, 0)
s = splitGst(1180, 18, true)
eq('inter-state igst', s.igstAmount, 180); eq('inter-state cgst', s.cgstAmount, 0)
s = splitGst(100, 0, false)
eq('0% gst', s.gstAmount, 0); eq('0% taxable', s.taxableValue, 100)
// odd paisa must not vanish
s = splitGst(99.99, 5, false)
eq('odd paisa: cgst+sgst==gst', round2(s.cgstAmount + s.sgstAmount), s.gstAmount)

console.log('— Discount apportionment —')
let shares = apportionDiscount([10, 10, 10], 10)
eq('3-way split of 10 sums exactly', round2(shares.reduce((a, b) => a + b, 0)), 10)
shares = apportionDiscount([33.33, 33.33, 33.34], 7.77)
eq('awkward split sums exactly', round2(shares.reduce((a, b) => a + b, 0)), 7.77)
shares = apportionDiscount([100], 500)
eq('discount clamped to subtotal', shares[0], 100)
shares = apportionDiscount([0, 0], 0)
eq('zero subtotal safe', round2(shares.reduce((a, b) => a + b, 0)), 0)

console.log('— Whole invoices —')
let t = computeInvoiceTotals([{ lineTotal: 1180, gstPercentage: 18 }], 0, false)
eq('no discount: total', t.totalAmount, 1180)
eq('no discount: gst', t.gstAmount, 180)
invariants('single line', t)

// THE reported bug: GST must be re-derived after a bill-level discount
t = computeInvoiceTotals([{ lineTotal: 1180, gstPercentage: 18 }], 180, false)
eq('after 180 discount: total', t.totalAmount, 1000)
eq('after 180 discount: gst is on 1000 not 1180', t.gstAmount, 152.54)
check('discounted gst is NOT the pre-discount 180', Math.abs(t.gstAmount - 180) > 1)
invariants('discounted', t)

t = computeInvoiceTotals(
  [{ lineTotal: 333.33, gstPercentage: 18 }, { lineTotal: 249.99, gstPercentage: 12 }, { lineTotal: 99.5, gstPercentage: 5 }],
  57.77, false)
invariants('mixed rates + discount', t)

t = computeInvoiceTotals(
  [{ lineTotal: 500, gstPercentage: 18 }, { lineTotal: 250, gstPercentage: 18 }],
  0, true)
eq('inter-state: igst carries all tax', t.igstAmount, t.gstAmount)
eq('inter-state: no cgst', t.cgstAmount, 0)
invariants('inter-state', t)

t = computeInvoiceTotals([{ lineTotal: 100, gstPercentage: 18 }, { lineTotal: 200, gstPercentage: 5 }], 1000, false)
eq('over-discount clamps to zero total', t.totalAmount, 0)
invariants('over-discounted', t)

// fuzz: random baskets must always foot
for (let i = 0; i < 3000; i++) {
  const n = 1 + (i % 5)
  const rates = [0, 5, 12, 18, 28]
  const lines = Array.from({ length: n }, (_, k) => ({
    lineTotal: round2(((i * 37 + k * 91) % 500000) / 100),
    gstPercentage: rates[(i + k) % rates.length]
  }))
  const disc = round2(((i * 13) % 20000) / 100)
  invariants(`fuzz#${i}`, computeInvoiceTotals(lines, disc, i % 3 === 0))
}

console.log('— Validation —')
check('valid GSTIN accepted', V.validateGstin('27AAPFU0939F1ZV').ok)
check('bad checksum rejected', !V.validateGstin('27AAPFU0939F1ZX').ok)
check('bad state code rejected', !V.validateGstin('99AAPFU0939F1ZV').ok)
check('short gstin rejected', !V.validateGstin('27AAPFU').ok)
check('empty gstin ok when optional', V.validateGstin('').ok)
check('synthetic placeholder is valid', V.validateGstin('27ABCDE1234F1Z0').ok)
check('mobile +91 stripped', V.validateMobile('+91 98765 43210').value === '9876543210')
check('mobile leading 0 stripped', V.validateMobile('09876543210').value === '9876543210')
check('9-digit mobile rejected', !V.validateMobile('987654321').ok)
check('mobile starting 5 rejected', !V.validateMobile('5876543210').ok)
check('landline ok for supplier', V.validateContactNumber('0224 2345678').ok)
check('landline rejected for customer', !V.validateMobile('02242345678').ok)
check('email lowercased', V.validateEmail('A@B.COM').value === 'a@b.com')
check('bad email rejected', !V.validateEmail('nope@').ok)
check('item code normalized', V.normalizeItemCode('pvc fin 25mm') === 'PVC-FIN-25MM')
check('item code valid', V.validateItemCode('WIRE-HAV-1.5-RED').ok)
check('item code with space normalizes then passes', V.validateItemCode('pvc fin 25mm').ok)
check('single char item code rejected', !V.validateItemCode('A').ok)
check('stateCodeOf', V.stateCodeOf('27AAPFU0939F1ZV') === '27')
check('stateCodeOf null on junk', V.stateCodeOf('nonsense') === null)
check('name with & allowed', V.validateName("Sharma & Sons").ok)
check('name with emoji rejected', !V.validateName('Shop 🎉').ok)


console.log('— Units & cut-length —')
eq('roundQty 3dp', U.roundQty(14.5006), 14.501)
check('LENGTH keeps decimals', U.parseQty('2.5', 'LENGTH') === 2.5)
check('UNIT floors to whole pieces', U.parseQty('2.9', 'UNIT') === 2)
check('UNIT rejects fractional-only', U.parseQty('0.5', 'UNIT') === 0)
check('negative rejected', U.parseQty('-3', 'LENGTH') === 0)
check('garbage rejected', U.parseQty('abc', 'LENGTH') === 0)
check('comma tolerated', U.parseQty('1,250.5', 'LENGTH') === 1250.5)
check('step differs by mode', U.qtyStep('LENGTH') === 0.001 && U.qtyStep('UNIT') === 1)
check('format trims zeros', U.formatQty(3.0) === '3')
check('format keeps decimals', U.formatQty(14.5) === '14.5')
check('format with unit', U.formatQtyWithUnit(14.5, 'm') === '14.5 m')
check('length measures offered', U.measuresFor('LENGTH').includes('m'))
check('unit measures offered', U.measuresFor('UNIT').includes('pcs'))
check('default measure per mode', U.defaultMeasureFor('LENGTH') === 'm' && U.defaultMeasureFor('UNIT') === 'pcs')

console.log('— Purchase cost GST split —')
let c = U.computePurchaseCost(100, 18, false)   // rate entered EXCLUDING gst
eq('ex-gst: base', c.rateExGst, 100)
eq('ex-gst: tax', c.gstAmount, 18)
eq('ex-gst: landed', c.rateInclGst, 118)
c = U.computePurchaseCost(118, 18, true)        // rate entered INCLUDING gst
eq('incl-gst: base', c.rateExGst, 100)
eq('incl-gst: tax', c.gstAmount, 18)
eq('incl-gst: landed', c.rateInclGst, 118)
c = U.computePurchaseCost(100, 0, false)
eq('zero-rated base', c.rateExGst, 100)
eq('zero-rated landed', c.rateInclGst, 100)
// both entry modes must describe the same physical cost
for (const [rate, pct] of [[250, 12], [99.99, 5], [1234.56, 28], [7.5, 18]]) {
  const ex = U.computePurchaseCost(rate, pct, false)
  const inc = U.computePurchaseCost(ex.rateInclGst, pct, true)
  check(`round-trip ex->incl->ex @${pct}%`, Math.abs(inc.rateExGst - ex.rateExGst) <= 0.01, { ex, inc })
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
