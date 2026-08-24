import { prisma } from '../prisma'
import { round2 } from '../../shared/money'
import { roundQty, uqcFor } from '../../shared/units'
import { IST_OFFSET_MS } from './dates'

/**
 * GSTR-1 — the return of outward supplies, built from the bills already in the
 * database.
 *
 * Every figure here was worked out and stored when the sale was made: the
 * taxable value of each line, which tax heads it fell under, and the place of
 * supply. Nothing is recalculated, because the return has to agree with the
 * invoice the customer is holding, and recomputing it months later from a
 * price that may since have changed is how those two drift apart.
 *
 * What the return needs that a sale does not is *grouping*. The portal wants
 * registered customers invoice by invoice, everybody else summed by state and
 * tax rate, and every line summed again by classification code. Those are
 * three different views of the same month, which is most of what this file is.
 *
 * Scope, stated plainly: this covers what a retail counter actually produces —
 * sales, credit notes, the HSN summary and the document series. It does not
 * cover exports, SEZ supplies, advances received, reverse charge, or amendments
 * to previous periods. A shop doing any of those needs more than this, and
 * should be told so rather than filing something quietly incomplete.
 */

/** Above this, an inter-state sale to an unregistered buyer is reported invoice-wise. */
const B2CL_THRESHOLD = 250_000

export type Gstr1Period = { month: number; year: number }

export type RateBucket = {
  rate: number
  taxableValue: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export type Gstr1Invoice = {
  invoiceNumber: string
  invoiceDate: string
  invoiceValue: number
  placeOfSupply: string | null
  reverseCharge: 'N'
  items: RateBucket[]
}

export type Gstr1CreditNote = Gstr1Invoice & {
  noteType: 'C'
  againstInvoice: string | null
  againstInvoiceDate: string | null
}

export type Gstr1 = {
  gstin: string | null
  /** `MMYYYY`, the filing period the portal expects. */
  fp: string
  periodLabel: string
  b2b: { ctin: string; customerName: string; invoices: Gstr1Invoice[] }[]
  b2cl: { pos: string; invoices: Gstr1Invoice[] }[]
  b2cs: {
    supplyType: 'INTER' | 'INTRA'
    pos: string | null
    rate: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
    cess: number
  }[]
  cdnr: { ctin: string; customerName: string; notes: Gstr1CreditNote[] }[]
  cdnur: Gstr1CreditNote[]
  hsn: {
    hsnCode: string
    description: string
    uqc: string
    quantity: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
    cess: number
  }[]
  documents: { from: string; to: string; total: number; cancelled: number }[]
  totals: {
    invoiceCount: number
    creditNoteCount: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
    totalTax: number
  }
  /** Everything that would make this return wrong if filed as it stands. */
  readiness: { blocking: string[]; warnings: string[] }
}

/** The IST month boundaries a filing period covers, as UTC instants. */
export function periodBounds(p: Gstr1Period): { from: Date; to: Date } {
  const from = new Date(Date.UTC(p.year, p.month - 1, 1) - IST_OFFSET_MS)
  const to = new Date(Date.UTC(p.year, p.month, 1) - IST_OFFSET_MS)
  return { from, to }
}

export function filingPeriod(p: Gstr1Period): string {
  return `${String(p.month).padStart(2, '0')}${p.year}`
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** Adds a line's tax into a bucket keyed by rate, creating it if needed. */
function addToBuckets(buckets: Map<number, RateBucket>, line: TaxLine): void {
  const rate = round2(Number(line.gstPercentage))
  const b = buckets.get(rate) ?? {
    rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0
  }
  b.taxableValue = round2(b.taxableValue + Number(line.taxableValue))
  b.igst = round2(b.igst + Number(line.igstAmount))
  b.cgst = round2(b.cgst + Number(line.cgstAmount))
  b.sgst = round2(b.sgst + Number(line.sgstAmount))
  buckets.set(rate, b)
}

type TaxLine = {
  gstPercentage: unknown
  taxableValue: unknown
  igstAmount: unknown
  cgstAmount: unknown
  sgstAmount: unknown
  quantity: unknown
  hsnCode: string | null
  productName: string
  unitOfMeasure: string
}

const asDate = (d: Date): string =>
  `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`

/**
 * Builds the return for one month.
 *
 * Voided bills are left out entirely — a void is a bill that never happened,
 * as distinct from a credit note, which is a sale that happened and was then
 * given back. The portal needs to see the second and must not see the first.
 */
export async function buildGstr1(p: Gstr1Period): Promise<Gstr1> {
  const { from, to } = periodBounds(p)
  const config = await prisma.shopConfig.findFirst({
    select: { gstin: true, stateCode: true }
  })
  const shopState = config?.stateCode ?? config?.gstin?.slice(0, 2) ?? null

  const bills = await prisma.bill.findMany({
    where: {
      paidAt: { gte: from, lt: to },
      status: { in: ['PAID', 'PARTIAL', 'CREDIT', 'RETURN'] }
    },
    include: {
      customer: { select: { name: true, gstin: true } },
      originalBill: { select: { billNumber: true, paidAt: true } },
      items: {
        select: {
          gstPercentage: true, taxableValue: true, igstAmount: true,
          cgstAmount: true, sgstAmount: true, quantity: true,
          hsnCode: true, productName: true, unitOfMeasure: true
        }
      }
    },
    orderBy: { paidAt: 'asc' }
  })

  const b2b = new Map<string, { ctin: string; customerName: string; invoices: Gstr1Invoice[] }>()
  const b2cl = new Map<string, { pos: string; invoices: Gstr1Invoice[] }>()
  const b2cs = new Map<string, Gstr1['b2cs'][number]>()
  const cdnr = new Map<string, { ctin: string; customerName: string; notes: Gstr1CreditNote[] }>()
  const cdnur: Gstr1CreditNote[] = []
  const hsn = new Map<string, Gstr1['hsn'][number]>()
  const missingHsn = new Set<string>()

  let invoiceCount = 0
  let creditNoteCount = 0
  const totals = { taxableValue: 0, igst: 0, cgst: 0, sgst: 0 }

  for (const bill of bills) {
    const isCreditNote = bill.status === 'RETURN'
    const gstin = bill.customer?.gstin?.trim().toUpperCase() || null
    const pos = bill.placeOfSupply ?? shopState
    const interState = Boolean(shopState && pos && pos !== shopState)

    const buckets = new Map<number, RateBucket>()
    for (const line of bill.items) {
      addToBuckets(buckets, line)

      // The HSN summary spans the whole month, across every kind of supply.
      // A credit note reduces it, so its lines are subtracted.
      const sign = isCreditNote ? -1 : 1
      const code = line.hsnCode?.trim() || ''
      if (!code) {
        missingHsn.add(line.productName)
        continue
      }
      const uqc = uqcFor(line.unitOfMeasure)
      const rate = round2(Number(line.gstPercentage))
      const key = `${code}|${uqc}|${rate}`
      const h = hsn.get(key) ?? {
        hsnCode: code, description: line.productName, uqc,
        quantity: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0
      }
      h.quantity = roundQty(h.quantity + sign * Number(line.quantity))
      h.taxableValue = round2(h.taxableValue + sign * Number(line.taxableValue))
      h.igst = round2(h.igst + sign * Number(line.igstAmount))
      h.cgst = round2(h.cgst + sign * Number(line.cgstAmount))
      h.sgst = round2(h.sgst + sign * Number(line.sgstAmount))
      hsn.set(key, h)
    }

    const items = [...buckets.values()].sort((a, b) => b.rate - a.rate)
    const value = round2(Number(bill.totalAmount))

    if (isCreditNote) {
      creditNoteCount++
      const note: Gstr1CreditNote = {
        noteType: 'C',
        invoiceNumber: bill.billNumber,
        invoiceDate: asDate(bill.paidAt),
        invoiceValue: value,
        placeOfSupply: pos,
        reverseCharge: 'N',
        againstInvoice: bill.originalBill?.billNumber ?? null,
        againstInvoiceDate: bill.originalBill ? asDate(bill.originalBill.paidAt) : null,
        items
      }
      if (gstin) {
        const g = cdnr.get(gstin) ?? {
          ctin: gstin, customerName: bill.customer?.name ?? '', notes: []
        }
        g.notes.push(note)
        cdnr.set(gstin, g)
      } else {
        cdnur.push(note)
      }
      // A credit note reduces the month's liability.
      for (const it of items) {
        totals.taxableValue = round2(totals.taxableValue - it.taxableValue)
        totals.igst = round2(totals.igst - it.igst)
        totals.cgst = round2(totals.cgst - it.cgst)
        totals.sgst = round2(totals.sgst - it.sgst)
      }
      continue
    }

    invoiceCount++
    for (const it of items) {
      totals.taxableValue = round2(totals.taxableValue + it.taxableValue)
      totals.igst = round2(totals.igst + it.igst)
      totals.cgst = round2(totals.cgst + it.cgst)
      totals.sgst = round2(totals.sgst + it.sgst)
    }

    const invoice: Gstr1Invoice = {
      invoiceNumber: bill.billNumber,
      invoiceDate: asDate(bill.paidAt),
      invoiceValue: value,
      placeOfSupply: pos,
      reverseCharge: 'N',
      items
    }

    if (gstin) {
      // Registered buyer: reported invoice by invoice so they can claim it.
      const g = b2b.get(gstin) ?? {
        ctin: gstin, customerName: bill.customer?.name ?? '', invoices: []
      }
      g.invoices.push(invoice)
      b2b.set(gstin, g)
    } else if (interState && value > B2CL_THRESHOLD) {
      // A large inter-state sale to somebody unregistered is still named.
      const key = pos ?? '—'
      const g = b2cl.get(key) ?? { pos: key, invoices: [] }
      g.invoices.push(invoice)
      b2cl.set(key, g)
    } else {
      // Everybody else is summed by state and rate — the counter's bread and
      // butter, and the reason a shop's return is short rather than thousands
      // of lines long.
      for (const it of items) {
        const supplyType = interState ? 'INTER' : 'INTRA'
        const key = `${supplyType}|${pos ?? ''}|${it.rate}`
        const row = b2cs.get(key) ?? {
          supplyType: supplyType as 'INTER' | 'INTRA',
          pos, rate: it.rate, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0
        }
        row.taxableValue = round2(row.taxableValue + it.taxableValue)
        row.igst = round2(row.igst + it.igst)
        row.cgst = round2(row.cgst + it.cgst)
        row.sgst = round2(row.sgst + it.sgst)
        b2cs.set(key, row)
      }
    }
  }

  // The document series issued in the period, including anything voided —
  // the portal asks what numbers were used, not only what was sold.
  const documents = await buildDocumentSummary(from, to)

  const blocking: string[] = []
  const warnings: string[] = []
  if (!config?.gstin) {
    blocking.push('The shop has no GSTIN on its profile, so the return cannot be addressed.')
  }
  if (!shopState) {
    blocking.push('The shop has no state code, so intra- and inter-state supplies cannot be told apart.')
  }
  if (missingHsn.size > 0) {
    const names = [...missingHsn].slice(0, 5).join(', ')
    blocking.push(
      `${missingHsn.size} product${missingHsn.size === 1 ? '' : 's'} sold this period ` +
        `${missingHsn.size === 1 ? 'has' : 'have'} no HSN code, so the HSN summary is incomplete: ` +
        `${names}${missingHsn.size > 5 ? ', and others' : ''}.`
    )
  }
  const othUqc = [...hsn.values()].filter((h) => h.uqc === 'OTH')
  if (othUqc.length > 0) {
    warnings.push(
      `${othUqc.length} HSN line${othUqc.length === 1 ? '' : 's'} report a unit of OTH because ` +
        `the unit sold has no official code. This is accepted but imprecise.`
    )
  }
  if (invoiceCount === 0 && creditNoteCount === 0) {
    warnings.push('There were no sales in this period — a nil return.')
  }

  return {
    gstin: config?.gstin ?? null,
    fp: filingPeriod(p),
    periodLabel: `${MONTHS[p.month - 1]} ${p.year}`,
    b2b: [...b2b.values()],
    b2cl: [...b2cl.values()],
    b2cs: [...b2cs.values()].sort((a, b) => b.rate - a.rate),
    cdnr: [...cdnr.values()],
    cdnur,
    hsn: [...hsn.values()].sort((a, b) => a.hsnCode.localeCompare(b.hsnCode)),
    documents,
    totals: {
      invoiceCount,
      creditNoteCount,
      taxableValue: totals.taxableValue,
      igst: totals.igst,
      cgst: totals.cgst,
      sgst: totals.sgst,
      totalTax: round2(totals.igst + totals.cgst + totals.sgst)
    },
    readiness: { blocking, warnings }
  }
}

/**
 * Which document numbers were used in the period, and how many were cancelled.
 *
 * The portal asks this separately from the sales themselves: it wants to see
 * that the series has no gaps in it, so a voided bill still counts as a number
 * issued.
 */
async function buildDocumentSummary(
  from: Date,
  to: Date
): Promise<Gstr1['documents']> {
  const rows = await prisma.bill.findMany({
    where: { paidAt: { gte: from, lt: to } },
    select: { billNumber: true, status: true },
    orderBy: { billNumber: 'asc' }
  })
  if (rows.length === 0) return []

  // Group by series prefix — invoices and credit notes are separate series and
  // are declared separately.
  const bySeries = new Map<string, { numbers: string[]; cancelled: number }>()
  for (const r of rows) {
    const prefix = r.billNumber.split('-').slice(0, 2).join('-')
    const g = bySeries.get(prefix) ?? { numbers: [], cancelled: 0 }
    g.numbers.push(r.billNumber)
    if (r.status === 'VOID') g.cancelled++
    bySeries.set(prefix, g)
  }

  return [...bySeries.values()].map((g) => {
    const sorted = [...g.numbers].sort()
    return {
      from: sorted[0],
      to: sorted[sorted.length - 1],
      total: sorted.length,
      cancelled: g.cancelled
    }
  })
}

/**
 * The same return in the shape the GST portal's offline tool accepts.
 *
 * Kept separate from the structure above on purpose: the readable form is what
 * the screen shows and what a person checks, and this is a mechanical
 * translation of it into the portal's abbreviations. When the portal changes
 * its schema — and it does — only this function moves.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export function toPortalJson(r: Gstr1): Record<string, any> {
  const itms = (items: RateBucket[]): any[] =>
    items.map((it, i) => ({
      num: i + 1,
      itm_det: {
        rt: it.rate,
        txval: it.taxableValue,
        iamt: it.igst,
        camt: it.cgst,
        samt: it.sgst,
        csamt: it.cess
      }
    }))

  const out: Record<string, any> = { gstin: r.gstin, fp: r.fp, version: 'GST3.0.4' }

  if (r.b2b.length) {
    out.b2b = r.b2b.map((g) => ({
      ctin: g.ctin,
      inv: g.invoices.map((inv) => ({
        inum: inv.invoiceNumber,
        idt: inv.invoiceDate,
        val: inv.invoiceValue,
        pos: inv.placeOfSupply,
        rchrg: inv.reverseCharge,
        inv_typ: 'R',
        itms: itms(inv.items)
      }))
    }))
  }
  if (r.b2cl.length) {
    out.b2cl = r.b2cl.map((g) => ({
      pos: g.pos,
      inv: g.invoices.map((inv) => ({
        inum: inv.invoiceNumber,
        idt: inv.invoiceDate,
        val: inv.invoiceValue,
        itms: itms(inv.items)
      }))
    }))
  }
  if (r.b2cs.length) {
    out.b2cs = r.b2cs.map((row) => ({
      sply_ty: row.supplyType,
      pos: row.pos,
      typ: 'OE',
      rt: row.rate,
      txval: row.taxableValue,
      iamt: row.igst,
      camt: row.cgst,
      samt: row.sgst,
      csamt: row.cess
    }))
  }
  if (r.cdnr.length) {
    out.cdnr = r.cdnr.map((g) => ({
      ctin: g.ctin,
      nt: g.notes.map((n) => ({
        ntty: n.noteType,
        nt_num: n.invoiceNumber,
        nt_dt: n.invoiceDate,
        val: n.invoiceValue,
        pos: n.placeOfSupply,
        rchrg: n.reverseCharge,
        inum: n.againstInvoice,
        idt: n.againstInvoiceDate,
        itms: itms(n.items)
      }))
    }))
  }
  if (r.hsn.length) {
    out.hsn = {
      data: r.hsn.map((h, i) => ({
        num: i + 1,
        hsn_sc: h.hsnCode,
        desc: h.description,
        uqc: h.uqc,
        qty: h.quantity,
        txval: h.taxableValue,
        iamt: h.igst,
        camt: h.cgst,
        samt: h.sgst,
        csamt: h.cess
      }))
    }
  }
  if (r.documents.length) {
    out.doc_issue = {
      doc_det: [
        {
          doc_num: 1,
          docs: r.documents.map((d, i) => ({
            num: i + 1,
            from: d.from,
            to: d.to,
            totnum: d.total,
            cancel: d.cancelled,
            net_issue: d.total - d.cancelled
          }))
        }
      ]
    }
  }
  return out
}
/* eslint-enable @typescript-eslint/no-explicit-any */
