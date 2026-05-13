// Receipt rendering — produces an 80mm-thermal-friendly HTML document
// for the bill that just got saved (or any historical bill).
// The same HTML prints acceptably on A4 fallback because @page sizing
// scales naturally; widths are in mm.

export type ReceiptShop = {
  name: string
  branch?: string | null
  address?: string | null
  phone?: string | null
  gstin?: string | null
}

export type ReceiptItem = {
  itemCode: string
  productName: string
  quantity: number
  unitRate: number
  lineTotal: number
  gstPercentage?: number
}

export type ReceiptBill = {
  billNumber: string
  paidAt?: string
  paymentMethod: string
  subtotal?: number
  gstAmount?: number
  discountAmount?: number
  totalAmount: number
  amountReceived?: number | null
  changeGiven?: number | null
  customerName?: string | null
  cashierName?: string | null
  status?: string
  items: ReceiptItem[]
}

export type ReceiptOptions = {
  /** Inject `window.print()` on load so opening the doc auto-prints. */
  autoPrint?: boolean
  /** Optional copy label (e.g. "DUPLICATE", "REPRINT"). */
  copyLabel?: string
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
  const date = bill.paidAt ? new Date(bill.paidAt) : new Date()
  const dateStr = date.toLocaleString('en-IN', { hour12: true })

  const subtotal = bill.subtotal ?? bill.items.reduce((s, it) => s + it.lineTotal, 0)
  const gstAmount = bill.gstAmount ?? 0
  const discountAmount = bill.discountAmount ?? 0

  const itemsHtml = bill.items
    .map((it) => {
      const lineRate = `${it.quantity} × ₹${fmt(it.unitRate)}`
      return `<tr class="item">
  <td colspan="2" class="name">${esc(it.productName)}</td>
</tr>
<tr class="item-meta">
  <td class="sm">${esc(it.itemCode)} · ${esc(lineRate)}</td>
  <td class="tot">₹${fmt(it.lineTotal)}</td>
</tr>`
    })
    .join('')

  const isVoid = bill.status === 'VOID'
  const isReturn = bill.status === 'RETURN'
  const banner =
    isVoid ? '<div class="banner void">** VOIDED **</div>' :
    isReturn ? '<div class="banner ret">** RETURN **</div>' :
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
  @page { margin: 0; size: 80mm auto; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Menlo', 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.35;
    color: #000;
    padding: 4mm 3mm;
    width: 80mm;
  }
  .center { text-align: center; }
  .right  { text-align: right; }
  .bold   { font-weight: 700; }
  .lg     { font-size: 14px; }
  .sm     { font-size: 9.5px; }
  .muted  { color: #444; }
  hr { border: none; border-top: 1px dashed #000; margin: 4px 0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1px 0; vertical-align: top; }
  td.tot { text-align: right; white-space: nowrap; padding-left: 4px; width: 60px; }
  td.name { word-break: break-word; padding-top: 3px; font-weight: 600; }
  tr.item-meta td { color: #222; padding-bottom: 3px; }
  .row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
  .row .lbl { color: #222; }
  .grand { font-size: 13px; font-weight: 700; border-top: 1px dashed #000; padding-top: 4px; margin-top: 3px; }
  .banner { text-align: center; font-weight: 700; border: 1px dashed #000; padding: 3px; margin: 4px 0; letter-spacing: 1px; }
  .banner.void { color: #b00; border-color: #b00; }
  .banner.ret  { color: #964; border-color: #964; }
  .footer { text-align: center; font-size: 9.5px; margin-top: 8px; }
  @media print { body { width: auto; padding: 2mm; } }
</style>
</head>
<body>
  <div class="center bold lg">${esc(shop.name)}</div>
  ${shop.branch ? `<div class="center sm">${esc(shop.branch)}</div>` : ''}
  ${shop.address ? `<div class="center sm">${esc(shop.address)}</div>` : ''}
  ${shop.phone ? `<div class="center sm">Tel: ${esc(shop.phone)}</div>` : ''}
  ${shop.gstin ? `<div class="center sm">GSTIN: ${esc(shop.gstin)}</div>` : ''}
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
  <div class="row"><span class="lbl">Subtotal</span><span>₹${fmt(subtotal)}</span></div>
  ${gstAmount > 0 ? `<div class="row sm"><span class="lbl">incl. GST</span><span>₹${fmt(gstAmount)}</span></div>` : ''}
  ${discountAmount > 0 ? `<div class="row"><span class="lbl">Discount</span><span>−₹${fmt(discountAmount)}</span></div>` : ''}
  <div class="row grand"><span>TOTAL</span><span>₹${fmt(bill.totalAmount)}</span></div>
  <div class="row sm"><span class="lbl">Payment</span><span>${esc(bill.paymentMethod)}</span></div>
  ${bill.amountReceived != null ? `<div class="row sm"><span class="lbl">Received</span><span>₹${fmt(bill.amountReceived)}</span></div>` : ''}
  ${bill.changeGiven != null && bill.changeGiven > 0 ? `<div class="row sm"><span class="lbl">Change</span><span>₹${fmt(bill.changeGiven)}</span></div>` : ''}
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
  const html = buildReceiptHtml(shop, bill, { ...opts, autoPrint: true })
  const ipc = (window as unknown as { electron?: { ipcRenderer?: { invoke?: (ch: string, ...a: unknown[]) => Promise<unknown> } } }).electron?.ipcRenderer
  if (ipc?.invoke) {
    try {
      const result = (await ipc.invoke('print-receipt', { html, billNumber: bill.billNumber })) as PrintReceiptResult
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
