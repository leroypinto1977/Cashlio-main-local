/**
 * Money and GST arithmetic shared by the server, the manager UI and the
 * terminal, so a receipt previewed on a counter matches the invoice the server
 * stores to the paisa.
 *
 * Two rules hold everywhere:
 *  - Selling rates are GST-INCLUSIVE, so tax is extracted from an amount
 *    rather than added to it.
 *  - Every derived figure is rounded to 2dp at the point it is computed, and
 *    remainders are absorbed by the last element, so totals always foot.
 */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export type TaxSplit = {
  taxableValue: number
  gstAmount: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
}

/**
 * Extracts GST from a tax-inclusive amount.
 * Intra-state sales split evenly into CGST + SGST; inter-state carry IGST.
 * Any odd paisa in the half-split lands on SGST so cgst + sgst === gst.
 */
export function splitGst(inclusiveAmount: number, gstPct: number, interState: boolean): TaxSplit {
  const gstAmount = round2((inclusiveAmount * gstPct) / (100 + gstPct))
  const taxableValue = round2(inclusiveAmount - gstAmount)
  if (interState) {
    return { taxableValue, gstAmount, cgstAmount: 0, sgstAmount: 0, igstAmount: gstAmount }
  }
  const cgstAmount = round2(gstAmount / 2)
  return {
    taxableValue,
    gstAmount,
    cgstAmount,
    sgstAmount: round2(gstAmount - cgstAmount),
    igstAmount: 0
  }
}

/**
 * Spreads a bill-level discount across lines in proportion to their value.
 * The last line absorbs the rounding remainder, so the returned shares sum to
 * exactly `discount` — without that, a three-way split of ₹10 loses a paisa
 * and the invoice stops footing.
 */
export function apportionDiscount(lineTotals: number[], discount: number): number[] {
  const subtotal = round2(lineTotals.reduce((s, v) => s + v, 0))
  const capped = round2(Math.min(Math.max(0, discount), subtotal))
  const shares: number[] = []
  let allocated = 0
  lineTotals.forEach((lineTotal, i) => {
    const share =
      i === lineTotals.length - 1
        ? round2(capped - allocated)
        : subtotal > 0
          ? round2(capped * (lineTotal / subtotal))
          : 0
    allocated = round2(allocated + share)
    shares.push(share)
  })
  return shares
}

export type InvoiceLineInput = {
  lineTotal: number // tax-inclusive, after any line-level discount
  gstPercentage: number
}

export type InvoiceLineTotals = TaxSplit & {
  lineTotal: number
  billDiscountAmt: number
}

export type InvoiceTotals = {
  lines: InvoiceLineTotals[]
  subtotal: number
  billDiscount: number
  totalAmount: number
  taxableValue: number
  gstAmount: number
  cgstAmount: number
  sgstAmount: number
  igstAmount: number
}

/**
 * The whole invoice in one pass: apportion the bill-level discount, then
 * derive tax from each line's DISCOUNTED value.
 *
 * Deriving tax before the discount (as the original code did) overstated GST
 * on every discounted bill, because the printed "incl. GST" figure described
 * a total the customer never paid.
 */
export function computeInvoiceTotals(
  lineInputs: InvoiceLineInput[],
  billDiscountRequested: number,
  interState: boolean
): InvoiceTotals {
  const lineTotals = lineInputs.map((l) => round2(l.lineTotal))
  const subtotal = round2(lineTotals.reduce((s, v) => s + v, 0))
  const shares = apportionDiscount(lineTotals, billDiscountRequested)
  const billDiscount = round2(shares.reduce((s, v) => s + v, 0))

  const lines = lineInputs.map((input, i) => {
    const split = splitGst(round2(lineTotals[i] - shares[i]), input.gstPercentage, interState)
    return { ...split, lineTotal: lineTotals[i], billDiscountAmt: shares[i] }
  })

  const sum = (pick: (l: InvoiceLineTotals) => number): number =>
    round2(lines.reduce((s, l) => s + pick(l), 0))

  return {
    lines,
    subtotal,
    billDiscount,
    totalAmount: round2(subtotal - billDiscount),
    taxableValue: sum((l) => l.taxableValue),
    gstAmount: sum((l) => l.gstAmount),
    cgstAmount: sum((l) => l.cgstAmount),
    sgstAmount: sum((l) => l.sgstAmount),
    igstAmount: sum((l) => l.igstAmount)
  }
}
