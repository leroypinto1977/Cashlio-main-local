// Unit tests for the shared money/GST and validation modules.
// Run with: npm run test:shared
const { computeInvoiceTotals, splitGst, apportionDiscount, round2 } = require('../.test-build/money.js')
const V = require('../.test-build/validation.js')
const U = require('../.test-build/units.js')
const C = require('../.test-build/credit.js')
const P = require('../.test-build/procurement.js')

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


console.log('— Settlement —')
let st = C.settle(1000, [{ method: 'CASH', amount: 1000 }])
check('exact cash is PAID', st.status === 'PAID' && st.balanceDue === 0 && st.changeGiven === 0)
st = C.settle(1000, [{ method: 'CASH', amount: 1200 }])
eq('cash overpay gives change', st.changeGiven, 200)
eq('paid caps at total', st.paidAmount, 1000)
eq('no balance', st.balanceDue, 0)
st = C.settle(1000, [{ method: 'CARD', amount: 1200 }])
eq('card overpay gives no change', st.changeGiven, 0)
st = C.settle(3500, [{ method: 'UPI', amount: 2000 }])
check('part payment is PARTIAL', st.status === 'PARTIAL')
eq('balance carried', st.balanceDue, 1500)
eq('paid recorded', st.paidAmount, 2000)
st = C.settle(3500, [])
check('no tender is CREDIT', st.status === 'CREDIT')
eq('whole amount owed', st.balanceDue, 3500)
st = C.settle(3500, [{ method: 'CASH', amount: 1000 }, { method: 'UPI', amount: 2500 }])
check('split tender settles', st.status === 'PAID' && st.balanceDue === 0)
eq('split total counted', st.paidAmount, 3500)
check('statusFor PAID', C.statusFor(100, 100) === 'PAID')
check('statusFor PARTIAL', C.statusFor(100, 40) === 'PARTIAL')
check('statusFor CREDIT', C.statusFor(100, 0) === 'CREDIT')
check('overpay still PAID', C.statusFor(100, 120) === 'PAID')
// settlement must always balance
for (let i = 0; i < 2000; i++) {
  const total = C ? Math.round(((i * 97) % 500000)) / 100 : 0
  const tendered = Math.round(((i * 53) % 600000)) / 100
  const s2 = C.settle(total, tendered > 0 ? [{ method: i % 2 ? 'CASH' : 'CARD', amount: tendered }] : [])
  check(`fuzz#${i} paid+balance == total`, Math.abs(s2.paidAmount + s2.balanceDue - Math.max(0, total)) < 0.005,
    { total, tendered, s2 })
}

console.log('— Credit limits —')
let cc = C.checkCredit({ hasCustomer: true, creditLimit: 10000, currentOutstanding: 0, newBalance: 1500 })
check('within limit allowed', cc.allowed && !cc.needsOverride)
cc = C.checkCredit({ hasCustomer: false, creditLimit: 0, currentOutstanding: 0, newBalance: 500 })
check('walk-in refused', !cc.allowed && cc.reason === 'NO_CUSTOMER')
check('walk-in cannot be overridden', !cc.needsOverride)
cc = C.checkCredit({ hasCustomer: true, creditLimit: 0, currentOutstanding: 0, newBalance: 500 })
check('no credit granted needs override', !cc.allowed && cc.needsOverride && cc.reason === 'NO_CREDIT_ALLOWED')
cc = C.checkCredit({ hasCustomer: true, creditLimit: 1000, currentOutstanding: 800, newBalance: 500 })
check('over limit needs override', !cc.allowed && cc.needsOverride && cc.reason === 'LIMIT_EXCEEDED')
eq('over-by reported', cc.overBy, 300)
eq('projected outstanding', cc.projectedOutstanding, 1300)
cc = C.checkCredit({ hasCustomer: false, creditLimit: 0, currentOutstanding: 0, newBalance: 0 })
check('fully paid never blocked', cc.allowed)
cc = C.checkCredit({ hasCustomer: true, creditLimit: 1000, currentOutstanding: 1000, newBalance: 0 })
check('at limit but paying in full is fine', cc.allowed)

console.log('— Ageing —')
const now = new Date('2026-08-22T12:00:00Z')
check('inside credit period is current', C.ageBucketOf(new Date('2026-09-01'), new Date('2026-08-01'), now) === 'current')
check('just overdue is 0-30', C.ageBucketOf(new Date('2026-08-20'), new Date('2026-07-20'), now) === '0-30')
check('a month overdue is 31-60', C.ageBucketOf(new Date('2026-07-10'), new Date('2026-06-10'), now) === '31-60')
check('long overdue is 60+', C.ageBucketOf(new Date('2026-05-01'), new Date('2026-04-01'), now) === '60+')
check('no due date falls back to bill date', C.ageBucketOf(null, new Date('2026-08-10'), now) === '0-30')
eq('daysBetween', C.daysBetween(new Date('2026-08-01'), new Date('2026-08-22')), 21)
check('dueDateFor adds credit days', C.dueDateFor(new Date('2026-08-01'), 30).toISOString().startsWith('2026-08-31'))
check('no credit days means no due date', C.dueDateFor(new Date('2026-08-01'), 0) === null)


console.log('— Return reasons —')
check('known code accepted', P.isReturnReasonCode('DAMAGED'))
check('unknown code rejected', !P.isReturnReasonCode('SOMETHING'))
check('label resolves', P.returnReasonLabel('DEFECTIVE').length > 0)
check('missing code has a label', P.returnReasonLabel(null) === 'Not recorded')
check('damaged goods do not go back on the shelf', !P.shouldRestock('DAMAGED'))
check('faulty goods do not go back', !P.shouldRestock('DEFECTIVE'))
check('changed mind does go back', P.shouldRestock('CHANGED_MIND'))
check('wrong item goes back', P.shouldRestock('WRONG_ITEM'))
check('no reason still restocks', P.shouldRestock(null))

console.log('— Purchase order state —')
check('draft is editable', P.isEditable('DRAFT'))
check('placed is not editable', !P.isEditable('PLACED'))
check('placed can receive', P.canReceive('PLACED'))
check('partial can receive', P.canReceive('PARTIAL'))
check('draft cannot receive', !P.canReceive('DRAFT'))
check('received cannot receive again', !P.canReceive('RECEIVED'))
check('draft cancellable', P.canCancel('DRAFT'))
check('placed cancellable', P.canCancel('PLACED'))
check('partially received not cancellable', !P.canCancel('PARTIAL'))
check('short delivery stays PARTIAL',
  P.statusAfterReceipt([{ orderedQty: 10, receivedQty: 4 }]) === 'PARTIAL')
check('complete delivery is RECEIVED',
  P.statusAfterReceipt([{ orderedQty: 10, receivedQty: 10 }]) === 'RECEIVED')
check('over-delivery still completes',
  P.statusAfterReceipt([{ orderedQty: 10, receivedQty: 12 }]) === 'RECEIVED')
check('one short line holds the order open',
  P.statusAfterReceipt([{ orderedQty: 5, receivedQty: 5 }, { orderedQty: 5, receivedQty: 1 }]) === 'PARTIAL')
let out = P.outstandingLines([{ orderedQty: 10, receivedQty: 4 }, { orderedQty: 3, receivedQty: 3 }])
check('only short lines are outstanding', out.length === 1 && out[0].pendingQty === 6, out)
check('valid status accepted', P.isPurchaseOrderStatus('RECEIVED'))
check('junk status rejected', !P.isPurchaseOrderStatus('SHIPPED'))

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
