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
  [path.join(__dirname, '..', 'src', 'main', 'printing.ts'), 'printing.cjs'],
  [path.join(__dirname, '..', 'src', 'renderer', 'src', 'lib', 'billingShortcuts.tsx'), 'shortcuts.cjs']
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
const K = require(path.join(buildDir, 'shortcuts.cjs'))

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

// ─── The keyboard layer ──────────────────────────────────────────────────────
console.log('\n— the keys a cashier uses —')
{
  const at = (over = {}) => ({
    modalOpen: false, pendingProduct: false, dropdownOpen: false,
    lineCount: 3, selectedLine: -1, canCollect: true, ...over
  })
  const act = (key, alt, over) => K.resolveShortcut(key, alt, at(over))

  eq('F2 goes to the search box', act('F2', false).type, 'focus-search')
  eq('F4 opens the customer picker', act('F4', false).type, 'open-customer')
  eq('F6 goes to the money box', act('F6', false).type, 'focus-amount')
  eq('F9 takes the money', act('F9', false).type, 'collect')

  // A key must never do what the button would refuse to do.
  eq('F9 does nothing on an unfinishable bill',
    act('F9', false, { canCollect: false }).type, 'none')

  // A modal owns the keyboard while it is open.
  for (const key of ['F2', 'F4', 'F6', 'F9']) {
    eq(`${key} is ignored while a modal is up`, act(key, false, { modalOpen: true }).type, 'none')
  }
  eq('...and Escape is left to the modal itself',
    act('Escape', false, { modalOpen: true }).type, 'none')

  // Escape backs out of one thing at a time, innermost first.
  eq('Escape cancels the quantity prompt first',
    act('Escape', false, { pendingProduct: true, dropdownOpen: true }).type, 'cancel-pending')
  eq('...then closes the dropdown',
    act('Escape', false, { dropdownOpen: true }).type, 'close-dropdown')
  eq('...and otherwise returns to the search box', act('Escape', false).type, 'focus-search')

  // A cashier types names and amounts all day: no bare key can be a command.
  for (const key of ['a', '1', '+', '-', 'Delete', 'Backspace', 'ArrowUp', 'ArrowDown']) {
    eq(`"${key}" alone types, it does not command`, act(key, false).type, 'none')
  }

  // The line actions default to the last line, which is what was just scanned.
  const up = act('ArrowUp', true)
  eq('Alt+Up steps back from the last line', JSON.stringify(up), JSON.stringify({ type: 'select-line', index: 1 }))
  eq('Alt+Down from the last line stays there',
    act('ArrowDown', true).index, 2)
  eq('Alt+Up at the top stays at the top', act('ArrowUp', true, { selectedLine: 0 }).index, 0)
  eq('Alt+Down at the end stays at the end', act('ArrowDown', true, { selectedLine: 2 }).index, 2)

  eq('Alt+= raises the selected line', JSON.stringify(act('=', true, { selectedLine: 1 })),
    JSON.stringify({ type: 'step-quantity', index: 1, direction: 1 }))
  eq('Alt++ does the same on a keyboard that sends +',
    act('+', true, { selectedLine: 1 }).direction, 1)
  eq('Alt+- lowers it', act('-', true, { selectedLine: 1 }).direction, -1)
  eq('Alt+Backspace removes it', JSON.stringify(act('Backspace', true, { selectedLine: 1 })),
    JSON.stringify({ type: 'remove-line', index: 1 }))
  eq('Alt+Delete does too', act('Delete', true, { selectedLine: 1 }).type, 'remove-line')

  // An empty cart has no line to act on.
  for (const key of ['ArrowUp', '=', '-', 'Backspace']) {
    eq(`Alt+${key} does nothing with an empty cart`,
      act(key, true, { lineCount: 0 }).type, 'none')
  }

  // A selection left pointing past the end after a removal must not act on a
  // line that is not there.
  eq('a stale selection is clamped to the last line',
    act('Backspace', true, { selectedLine: 9, lineCount: 3 }).index, 2)
  eq('...and so is a stale step', act('=', true, { selectedLine: 9, lineCount: 3 }).index, 2)

  eq('an unclaimed Alt combination is left alone', act('q', true).type, 'none')
}

console.log(`\n${pass} passed, ${fail} failed`)
try { fs.rmSync(buildDir, { recursive: true, force: true }) } catch {}
process.exit(fail ? 1 : 0)
