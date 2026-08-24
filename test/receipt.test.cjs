/**
 * The receipt, and the page it prints on.
 *
 * A receipt is the one thing a customer takes away, and a thermal roll gives
 * no second chance: the width is fixed by the paper and the length is cut
 * where the print ends. Both are arithmetic, so both are checked here rather
 * than discovered on a roll in a shop.
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const buildDir = path.join(__dirname, '.build')
fs.mkdirSync(buildDir, { recursive: true })
for (const [entry, out] of [
  [path.join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'receipt.ts'), 'receipt.cjs'],
  [path.join(__dirname, '..', 'src', 'main', 'printing.ts'), 'printing.cjs']
]) {
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: path.join(buildDir, out),
    bundle: true, platform: 'node', format: 'cjs', external: ['electron']
  })
}

// The receipt module reads localStorage for the printer settings. In a browser
// that is always there; here it is stubbed so the round-trip can be checked.
const store = new Map()
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
global.window = {}

const R = require(path.join(buildDir, 'receipt.cjs'))
const P = require(path.join(buildDir, 'printing.cjs'))

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 200)) }
}
const eq = (name, a, b) => t(`${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b, { a, b })

// ─── The page a roll wants ───────────────────────────────────────────────────
console.log('\n— the page a till roll wants —')
{
  eq('no roll configured leaves the page alone', P.rollPageSize(undefined, 500), null)
  eq('an unknown width leaves it alone too', P.rollPageSize(210, 500), null)

  const p80 = P.rollPageSize(80, 500)
  eq('an 80mm roll is 80,000 microns wide', p80.width, 80000)
  const p58 = P.rollPageSize(58, 500)
  eq('a 58mm roll is 58,000 microns wide', p58.width, 58000)

  // 96 CSS px to the inch, 25,400 microns to the inch.
  const expected = Math.ceil(500 * (25400 / 96)) + 4000
  eq('height is the measured content plus a cutting tail', p80.height, expected)
  t('which is a shade over 5 inches for 500px',
    p80.height > 132000 && p80.height < 137000, p80.height)

  // The whole point: a short bill must not feed a long page.
  const short = P.rollPageSize(80, 200)
  const long = P.rollPageSize(80, 2000)
  t('a short receipt gets a short page', short.height < long.height / 5, [short.height, long.height])
  t('a long one is not cut in half', long.height > Math.ceil(2000 * (25400 / 96)), long.height)

  // A window that has not laid out yet reports 0.
  const unmeasured = P.rollPageSize(80, 0)
  t('an unmeasured page still prints', unmeasured.height >= 40000, unmeasured)
  eq('...at the minimum height', unmeasured.height, 40000)
  t('so does a nonsense measurement', P.rollPageSize(80, NaN).height === 40000)
  t('and a negative one', P.rollPageSize(80, -50).height === 40000)
}

// ─── The receipt itself ──────────────────────────────────────────────────────
console.log('\n— the receipt, on each roll —')
{
  const shop = { name: 'Sri Balaji Electricals', address: '14 Main Road', phone: '9876543210', gstin: '33AABCS1429B1Z1' }
  const bill = {
    billNumber: 'INV-2608-0042',
    paidAt: '2026-08-24T06:30:00.000Z',
    paymentMethod: 'CASH',
    subtotal: 2360, gstAmount: 360, totalAmount: 2360,
    taxableValue: 2000, cgstAmount: 180, sgstAmount: 180,
    amountReceived: 2500, changeGiven: 140,
    items: [{
      itemCode: 'FIN-WIRE-25', productName: 'Finolex 2.5sqmm Wire (90m)',
      quantity: 1, unitRate: 2360, lineTotal: 2360, gstPercentage: 18,
      taxableValue: 2000, cgstAmount: 180, sgstAmount: 180
    }]
  }

  const wide = R.buildReceiptHtml(shop, bill, { paperWidthMm: 80 })
  const narrow = R.buildReceiptHtml(shop, bill, { paperWidthMm: 58 })

  t('80mm sets an 80mm page', wide.includes('size: 80mm auto'))
  t('58mm sets a 58mm page', narrow.includes('size: 58mm auto'))
  t('the default is the common roll',
    R.buildReceiptHtml(shop, bill).includes('size: 80mm auto'))

  // The side padding is what keeps text off the unprintable edge: 80mm paper
  // prints 72mm, 58mm paper prints 48mm, so the pads are 4mm and 5mm.
  t('80mm pads 4mm a side to a 72mm strip', wide.includes('padding: 4mm 4mm'), wide.match(/padding: 4mm [\d.]+mm/)?.[0])
  t('58mm pads 5mm a side to a 48mm strip', narrow.includes('padding: 4mm 5mm'), narrow.match(/padding: 4mm [\d.]+mm/)?.[0])

  // The narrow roll has to shrink the type or the columns collide.
  const sizeOf = (html) => Number(html.match(/font-size: ([\d.]+)px;\n    line-height/)[1])
  t('the narrow roll uses smaller type', sizeOf(narrow) < sizeOf(wide), [sizeOf(narrow), sizeOf(wide)])

  // Whatever the width, the receipt still has to say what was sold and owed.
  for (const [label, html] of [['80mm', wide], ['58mm', narrow]]) {
    t(`${label} names the shop`, html.includes('Sri Balaji Electricals'))
    t(`${label} carries the bill number`, html.includes('INV-2608-0042'))
    t(`${label} carries the GSTIN`, html.includes('33AABCS1429B1Z1'))
    t(`${label} shows the item`, html.includes('Finolex 2.5sqmm Wire (90m)'))
    t(`${label} shows the total`, html.includes('2,360.00'))
    t(`${label} shows the tax split`, html.includes('180.00'))
    t(`${label} shows the change given`, html.includes('140.00'))
  }

  // A copy label has to be unmistakable, or a duplicate gets paid twice.
  t('a copy label is printed', R.buildReceiptHtml(shop, bill, { copyLabel: 'DUPLICATE' }).includes('DUPLICATE'))

  // Anything a customer typed reaches the receipt, so it has to be escaped.
  const nasty = R.buildReceiptHtml(
    { ...shop, name: '<script>alert(1)</script>' }, bill, {})
  t('markup in shop data is escaped', !nasty.includes('<script>alert'))
  t('...and shown as text', nasty.includes('&lt;script&gt;'))
}

// ─── Which printer, and which roll ──────────────────────────────────────────
console.log('\n— the counter printer setting —')
{
  store.clear()
  const fresh = R.readPrinterSettings()
  eq('with nothing saved, the dialog is asked', fresh.deviceName, '')
  eq('and the common roll is assumed', fresh.paperWidthMm, 80)

  R.writePrinterSettings({ deviceName: 'EPSON_TM_T82', paperWidthMm: 58 })
  const saved = R.readPrinterSettings()
  eq('a chosen printer round-trips', saved.deviceName, 'EPSON_TM_T82')
  eq('so does the roll width', saved.paperWidthMm, 58)

  // Anything could be in local storage — an older build, a hand edit.
  store.set('cashlio_receipt_printer', '{"deviceName":"X","paperWidthMm":210}')
  eq('an impossible width falls back', R.readPrinterSettings().paperWidthMm, 80)
  eq('...keeping the printer', R.readPrinterSettings().deviceName, 'X')
  store.set('cashlio_receipt_printer', 'not json at all')
  eq('unreadable settings do not throw', R.readPrinterSettings().deviceName, '')
  eq('...and fall back to the dialog', R.readPrinterSettings().paperWidthMm, 80)
}

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(buildDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
