// Receipt rendering — produces a thermal-roll HTML document for the bill that
// just got saved (or any historical bill). Widths are in mm, so the same HTML
// prints acceptably on an A4 fallback: @page sizing scales naturally.

export type ReceiptShop = {
  name: string
  branch?: string | null
  address?: string | null
  phone?: string | null
  gstin?: string | null
}

export type ReceiptItem = {
  itemCode: string
  hsnCode?: string | null
  productName: string
  quantity: number
  unitRate: number
  lineTotal: number
  gstPercentage?: number
  /** Tax-invoice fields. Absent on bills written before these were stored. */
  taxableValue?: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  billDiscountAmt?: number
}

export type ReceiptBill = {
  billNumber: string
  paidAt?: string
  paymentMethod: string
  subtotal?: number
  gstAmount?: number
  discountAmount?: number
  totalAmount: number
  taxableValue?: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  placeOfSupply?: string | null
  amountReceived?: number | null
  changeGiven?: number | null
  /** Settlement. Absent on bills written before credit billing existed. */
  paidAmount?: number
  balanceDue?: number
  dueDate?: string | null
  /** Every tender taken at the counter, so a split payment prints in full. */
  tenders?: { method: string; amount: number; reference?: string | null }[]
  /** What the customer owes in total after this bill, when they are on credit. */
  customerOutstanding?: number | null
  customerName?: string | null
  cashierName?: string | null
  status?: string
  items: ReceiptItem[]
}

/** Roll widths a counter printer takes. 80mm is the common one; 58mm is the
 *  small handheld roll. Both are sold by their *paper* width — the printable
 *  strip is narrower, and printing to the paper width clips the edges. */
export const PAPER_WIDTHS = [80, 58] as const
export type PaperWidth = (typeof PAPER_WIDTHS)[number]

const PAPER: Record<PaperWidth, { printable: number; fontPx: number; totalPx: number }> = {
  80: { printable: 72, fontPx: 11, totalPx: 13 },
  58: { printable: 48, fontPx: 9, totalPx: 11 }
}

export type ReceiptOptions = {
  /** Inject `window.print()` on load so opening the doc auto-prints. */
  autoPrint?: boolean
  /** Optional copy label (e.g. "DUPLICATE", "REPRINT"). */
  copyLabel?: string
  /** Roll width to lay the receipt out for. Defaults to 80mm. */
  paperWidthMm?: PaperWidth
}

/** Where this machine's counter printer is configured. Per-machine, because
 *  the printer is plugged into this counter and not into the shop. */
const PRINTER_KEY = 'cashlio_receipt_printer'

export type PrinterSettings = {
  /** Empty means "ask me" — the OS dialog, which is the default. */
  deviceName: string
  paperWidthMm: PaperWidth
}

export function readPrinterSettings(): PrinterSettings {
  try {
    const raw = localStorage.getItem(PRINTER_KEY)
    if (!raw) return { deviceName: '', paperWidthMm: 80 }
    const p = JSON.parse(raw) as Partial<PrinterSettings>
    const width = PAPER_WIDTHS.includes(p.paperWidthMm as PaperWidth)
      ? (p.paperWidthMm as PaperWidth)
      : 80
    return { deviceName: String(p.deviceName ?? ''), paperWidthMm: width }
  } catch {
    return { deviceName: '', paperWidthMm: 80 }
  }
}

export function writePrinterSettings(s: PrinterSettings): void {
  try {
    localStorage.setItem(PRINTER_KEY, JSON.stringify(s))
  } catch {
    // A till with storage disabled still prints, it just asks every time.
  }
}

export type Printer = { name: string; displayName: string; isDefault: boolean }

/** The printers this machine can see. Empty outside Electron. */
export async function listPrinters(): Promise<Printer[]> {
  const ipc = (window as unknown as {
    electron?: { ipcRenderer?: { invoke?: (ch: string, ...a: unknown[]) => Promise<unknown> } }
  }).electron?.ipcRenderer
  if (!ipc?.invoke) return []
  try {
    const res = await ipc.invoke('printer:list')
    // An older main process answers this channel with something else entirely;
    // a list is the only shape worth trusting.
    return Array.isArray(res) ? (res as Printer[]) : []
  } catch {
    return []
  }
}

const fmt = (n: number): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })

const esc = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

export function buildReceiptHtml(
  shop: ReceiptShop,
  bill: ReceiptBill,
  opts: ReceiptOptions = {}
): string {
  const paperWidth: PaperWidth = opts.paperWidthMm === 58 ? 58 : 80
  const paper = PAPER[paperWidth]
  // Half the difference on each side, so the printable strip sits centred on
  // the roll rather than hard against one edge.
  const sidePadMm = Math.round(((paperWidth - paper.printable) / 2) * 10) / 10

  const date = bill.paidAt ? new Date(bill.paidAt) : new Date()
  const dateStr = date.toLocaleString('en-IN', { hour12: true })

  const subtotal = bill.subtotal ?? bill.items.reduce((s, it) => s + it.lineTotal, 0)
  const gstAmount = bill.gstAmount ?? 0
  const discountAmount = bill.discountAmount ?? 0
  const igstAmount = bill.igstAmount ?? 0
  const interState = igstAmount > 0
  // Older bills predate the stored breakdown; derive what we can so a reprint
  // of an old receipt still balances instead of showing blanks.
  const taxableValue = bill.taxableValue ?? Math.max(0, bill.totalAmount - gstAmount)
  const cgstAmount = bill.cgstAmount ?? (interState ? 0 : gstAmount / 2)
  const sgstAmount = bill.sgstAmount ?? (interState ? 0 : gstAmount - gstAmount / 2)

  // Rate-wise summary. A GST invoice has to show tax grouped by rate, and it
  // also makes a multi-rate basket readable at the counter.
  const byRate = new Map<number, { taxable: number; cgst: number; sgst: number; igst: number }>()
  for (const it of bill.items) {
    const rate = Number(it.gstPercentage ?? 0)
    const net = (it.lineTotal ?? 0) - (it.billDiscountAmt ?? 0)
    const lineTaxable = it.taxableValue ?? net / (1 + rate / 100)
    const lineGst = net - lineTaxable
    const entry = byRate.get(rate) ?? { taxable: 0, cgst: 0, sgst: 0, igst: 0 }
    entry.taxable += lineTaxable
    if (interState) {
      entry.igst += it.igstAmount ?? lineGst
    } else {
      entry.cgst += it.cgstAmount ?? lineGst / 2
      entry.sgst += it.sgstAmount ?? lineGst - lineGst / 2
    }
    byRate.set(rate, entry)
  }
  const taxedRates = [...byRate.entries()].filter(([rate]) => rate > 0).sort((a, b) => a[0] - b[0])
  const gstSummaryHtml =
    gstAmount > 0 && taxedRates.length > 0
      ? `<hr/>
  <div class="sm bold">GST SUMMARY</div>
  <table class="gst sm">
    <thead>
      <tr><td>Rate</td><td class="tot">Taxable</td>${
        interState ? '<td class="tot">IGST</td>' : '<td class="tot">CGST</td><td class="tot">SGST</td>'
      }</tr>
    </thead>
    <tbody>
      ${taxedRates
        .map(
          ([rate, v]) =>
            `<tr><td>${esc(rate)}%</td><td class="tot">${fmt(v.taxable)}</td>${
              interState
                ? `<td class="tot">${fmt(v.igst)}</td>`
                : `<td class="tot">${fmt(v.cgst)}</td><td class="tot">${fmt(v.sgst)}</td>`
            }</tr>`
        )
        .join('')}
    </tbody>
  </table>`
      : ''

  // "Tax invoice" is only an accurate label when the shop is GST-registered.
  const docTitle = shop.gstin ? 'TAX INVOICE' : 'RECEIPT'
  const balanceDue = bill.balanceDue ?? 0

  const itemsHtml = bill.items
    .map((it) => {
      const lineRate = `${it.quantity} × ₹${fmt(it.unitRate)}`
      // A tax invoice carries the classification per line. Shown only when the
      // product has one, so a shop below the threshold isn't given a blank
      // label to wonder about.
      const hsn = it.hsnCode ? ` · HSN ${esc(it.hsnCode)}` : ''
      return `<tr class="item">
  <td colspan="2" class="name">${esc(it.productName)}</td>
</tr>
<tr class="item-meta">
  <td class="sm">${esc(it.itemCode)}${hsn} · <span class="qty">${esc(lineRate)}</span></td>
  <td class="tot">₹${fmt(it.lineTotal)}</td>
</tr>`
    })
    .join('')

  const isVoid = bill.status === 'VOID'
  const isReturn = bill.status === 'RETURN'
  const banner =
    isVoid ? '<div class="banner void">** VOIDED **</div>' :
    isReturn ? '<div class="banner ret">** RETURN **</div>' :
    bill.status === 'CREDIT' ? '<div class="banner ret">** CREDIT — UNPAID **</div>' :
    bill.status === 'PARTIAL' ? '<div class="banner ret">** PART PAID **</div>' :
    opts.copyLabel ? `<div class="banner">** ${esc(opts.copyLabel)} **</div>` : ''

  const autoPrintScript = opts.autoPrint
    ? `<script>window.addEventListener('load',()=>{setTimeout(()=>{try{window.print()}catch(e){}},80)});</script>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Receipt ${esc(bill.billNumber)}</title>
<style>
  @page { margin: 0; size: ${paperWidth}mm auto; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  /* Explicit, so the document does not inherit a dark background from
     whatever is rendering it — the receipt is black on white paper. */
  html { background: #fff; }
  body {
    font-family: 'Menlo', 'Courier New', monospace;
    font-size: ${paper.fontPx}px;
    line-height: 1.35;
    color: #000;
    background: #fff;
    /* The side padding is what keeps the text inside the printable strip;
       printing to the paper width shaves the first and last character off
       every line. */
    padding: 4mm ${sidePadMm}mm;
    width: ${paperWidth}mm;
  }
  .center { text-align: center; }
  .right  { text-align: right; }
  .bold   { font-weight: 700; }
  .lg     { font-size: ${paper.fontPx + 3}px; }
  .sm     { font-size: ${paper.fontPx - 1.5}px; }
  .muted  { color: #444; }
  hr { border: none; border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.tot { text-align: right; white-space: nowrap; padding-left: 4px; width: ${paperWidth === 58 ? 48 : 60}px; }
  td.name { word-break: break-word; padding-top: 3px; font-weight: 600; }
  tr.item-meta td { color: #222; padding-bottom: 3px; }
  /* The quantity and the rate are one expression. On a narrow roll the line
     wraps, and it has to wrap before "3 × ₹59.00" rather than through it. */
  .qty { white-space: nowrap; }
  .row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
  .row .lbl { color: #222; }
  .grand { font-size: ${paper.totalPx}px; font-weight: 700; border-top: 1px dashed #000; padding-top: 4px; margin-top: 3px; }
  .banner { text-align: center; font-weight: 700; border: 1px dashed #000; padding: 3px; margin: 4px 0; letter-spacing: 1px; }
  .banner.void { color: #b00; border-color: #b00; }
  .banner.ret  { color: #964; border-color: #964; }
  .footer { text-align: center; font-size: ${paper.fontPx - 1.5}px; margin-top: 8px; }
  .doctype { letter-spacing: 2px; font-weight: 700; margin-top: 2px; }
  .balance { font-size: ${paper.totalPx - 1}px; font-weight: 700; border-top: 1px dashed #000; padding-top: 3px; margin-top: 3px; }
  table.gst td { padding: 1px 0; }
  table.gst thead td { border-bottom: 1px dashed #000; font-weight: 600; }
  @media print { body { width: auto; padding: 2mm; } }
</style>
</head>
<body>
  <div class="center bold lg">${esc(shop.name)}</div>
  ${shop.branch ? `<div class="center sm">${esc(shop.branch)}</div>` : ''}
  ${shop.address ? `<div class="center sm">${esc(shop.address)}</div>` : ''}
  ${shop.phone ? `<div class="center sm">Tel: ${esc(shop.phone)}</div>` : ''}
  ${shop.gstin ? `<div class="center sm">GSTIN: ${esc(shop.gstin)}</div>` : ''}
  <div class="center sm doctype">${docTitle}</div>
  ${banner}
  <hr/>
  <div class="row sm"><span class="lbl">Bill</span><span class="bold">${esc(bill.billNumber)}</span></div>
  <div class="row sm"><span class="lbl">Date</span><span>${esc(dateStr)}</span></div>
  ${bill.cashierName ? `<div class="row sm"><span class="lbl">Cashier</span><span>${esc(bill.cashierName)}</span></div>` : ''}
  ${bill.customerName ? `<div class="row sm"><span class="lbl">Customer</span><span>${esc(bill.customerName)}</span></div>` : ''}
  <hr/>
  <table>
    <tbody>
      ${itemsHtml}
    </tbody>
  </table>
  <hr/>
  <div class="row"><span class="lbl">Items total</span><span>₹${fmt(subtotal)}</span></div>
  ${discountAmount > 0 ? `<div class="row"><span class="lbl">Discount</span><span>−₹${fmt(discountAmount)}</span></div>` : ''}
  <div class="row"><span class="lbl">Taxable value</span><span>₹${fmt(taxableValue)}</span></div>
  ${
    interState
      ? `<div class="row sm"><span class="lbl">IGST</span><span>₹${fmt(igstAmount)}</span></div>`
      : gstAmount > 0
        ? `<div class="row sm"><span class="lbl">CGST</span><span>₹${fmt(cgstAmount)}</span></div>
  <div class="row sm"><span class="lbl">SGST</span><span>₹${fmt(sgstAmount)}</span></div>`
        : ''
  }
  <div class="row grand"><span>TOTAL</span><span>₹${fmt(bill.totalAmount)}</span></div>
  <div class="row sm"><span class="lbl">Payment</span><span>${esc(bill.paymentMethod)}</span></div>
  ${
    // A split payment prints every tender; a single one keeps the old line.
    bill.tenders && bill.tenders.length > 1
      ? bill.tenders
          .map(
            (t) =>
              `<div class="row sm"><span class="lbl">${esc(t.method)}${
                t.reference ? ` · ${esc(t.reference)}` : ''
              }</span><span>₹${fmt(t.amount)}</span></div>`
          )
          .join('')
      : bill.amountReceived != null
        ? `<div class="row sm"><span class="lbl">Received</span><span>₹${fmt(bill.amountReceived)}</span></div>`
        : ''
  }
  ${bill.changeGiven != null && bill.changeGiven > 0 ? `<div class="row sm"><span class="lbl">Change returned</span><span>₹${fmt(bill.changeGiven)}</span></div>` : ''}
  ${
    balanceDue > 0
      ? `<div class="row balance"><span>BALANCE DUE</span><span>₹${fmt(balanceDue)}</span></div>${
          bill.dueDate
            ? `<div class="row sm"><span class="lbl">Payable by</span><span>${esc(
                new Date(bill.dueDate).toLocaleDateString('en-IN')
              )}</span></div>`
            : ''
        }`
      : ''
  }
  ${
    bill.customerOutstanding != null && bill.customerOutstanding > 0
      ? `<div class="row sm"><span class="lbl">Total account balance</span><span>₹${fmt(bill.customerOutstanding)}</span></div>`
      : ''
  }
  ${gstSummaryHtml}
  <hr/>
  <div class="footer">Thank you for shopping with us!</div>
  ${autoPrintScript}
</body>
</html>`
}

// ─── Print bridge ────────────────────────────────────────────────────────────

export type PrintReceiptResult = { ok: boolean; error?: string }

/**
 * Sends the bill to the Electron main process for silent/dialog printing.
 * Falls back to opening a new browser window with auto-print when run
 * outside Electron (dev in a plain browser).
 */
export async function printReceipt(
  shop: ReceiptShop,
  bill: ReceiptBill,
  opts: ReceiptOptions = {}
): Promise<PrintReceiptResult> {
  const printer = readPrinterSettings()
  const paperWidthMm = opts.paperWidthMm ?? printer.paperWidthMm
  const html = buildReceiptHtml(shop, bill, { ...opts, paperWidthMm, autoPrint: true })
  const ipc = (window as unknown as { electron?: { ipcRenderer?: { invoke?: (ch: string, ...a: unknown[]) => Promise<unknown> } } }).electron?.ipcRenderer
  if (ipc?.invoke) {
    try {
      const result = (await ipc.invoke('print-receipt', {
        html,
        billNumber: bill.billNumber,
        // With a printer chosen the receipt goes straight to it. Without one
        // the OS dialog still opens, which is the right default: a shop that
        // has not set a counter printer has not told us where to send paper.
        deviceName: printer.deviceName || undefined,
        paperWidthMm
      })) as PrintReceiptResult
      return result ?? { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message || 'PRINT_FAILED' }
    }
  }
  // Browser fallback
  const w = window.open('', '_blank', 'width=380,height=640')
  if (!w) return { ok: false, error: 'POPUP_BLOCKED' }
  w.document.write(html)
  w.document.close()
  return { ok: true }
}
