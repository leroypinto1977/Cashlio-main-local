/**
 * Quantity handling for products that are sold by the piece and products that
 * are cut to length (pipe, tube, wire).
 *
 * Stock for a LENGTH product is a pool of its unit of measure — 14.5 m across
 * however many batches — rather than a set of individually tracked offcuts.
 * Quantities carry three decimals everywhere: database, API and UI.
 */

export type SellMode = 'UNIT' | 'LENGTH'

/** Units offered for each mode. The first entry is the default. */
export const UNIT_MEASURES = ['pcs', 'box', 'set', 'pair', 'kg', 'ltr'] as const
export const LENGTH_MEASURES = ['m', 'ft', 'cm', 'in'] as const

export const QTY_DECIMALS = 3

export function isLengthMode(sellMode: string | null | undefined): boolean {
  return sellMode === 'LENGTH'
}

/** Quantities are stored to 3dp; round consistently so stock never drifts. */
export function roundQty(n: number): number {
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

/**
 * Parses user input. Whole-unit products are floored to integers so a cashier
 * can't sell 2.5 switches; cut-length products keep their decimals.
 */
export function parseQty(raw: string | number, sellMode: string | null | undefined): number {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/,/g, ''))
  if (!Number.isFinite(n) || n <= 0) return 0
  return isLengthMode(sellMode) ? roundQty(n) : Math.floor(n)
}

/** Smallest sellable increment — drives the `step` on quantity inputs. */
export function qtyStep(sellMode: string | null | undefined): number {
  return isLengthMode(sellMode) ? 0.001 : 1
}

/** 3 -> "3", 14.5 -> "14.5", 0.25 -> "0.25". Never shows padding zeros. */
export function formatQty(n: number | string | null | undefined): string {
  const v = Number(n ?? 0)
  if (!Number.isFinite(v)) return '0'
  return String(roundQty(v))
}

/** "14.5 m" / "3 pcs" — the form used in stock readouts and on receipts. */
export function formatQtyWithUnit(
  n: number | string | null | undefined,
  unitOfMeasure: string | null | undefined
): string {
  return `${formatQty(n)} ${unitOfMeasure || 'pcs'}`.trim()
}

/**
 * The unit codes a GST return recognises.
 *
 * GSTR-1's HSN summary will not accept "pcs" or "m" — it wants the government's
 * own Unit Quantity Codes. The shop should go on saying "m" on a receipt; this
 * is only for the filing.
 */
const UQC: Record<string, string> = {
  pcs: 'PCS',
  box: 'BOX',
  set: 'SET',
  pair: 'PRS',
  kg: 'KGS',
  ltr: 'LTR',
  m: 'MTR',
  cm: 'CMS'
  // Feet and inches have no code on the government's list, so they fall to
  // OTH below. That is the honest answer rather than converting behind the
  // shop's back and filing a quantity it never sold.
}

export function uqcFor(unitOfMeasure: string | null | undefined): string {
  return UQC[(unitOfMeasure || '').trim().toLowerCase()] ?? 'OTH'
}

/** Units valid for a mode, used to keep the two dropdowns consistent. */
export function measuresFor(sellMode: string | null | undefined): readonly string[] {
  return isLengthMode(sellMode) ? LENGTH_MEASURES : UNIT_MEASURES
}

/** Coerces a unit of measure to one that makes sense for the mode. */
export function defaultMeasureFor(sellMode: string | null | undefined): string {
  return isLengthMode(sellMode) ? LENGTH_MEASURES[0] : UNIT_MEASURES[0]
}

// ─── Purchase cost ────────────────────────────────────────────────────────────

export type PurchaseCost = {
  rateExGst: number
  gstPct: number
  gstAmount: number
  rateInclGst: number
}

/**
 * Supplier invoices quote a rate either before or after tax. Both are recorded
 * so margin can be computed on the ex-GST cost while the landed cost stays
 * visible for stock valuation.
 */
export function computePurchaseCost(
  enteredRate: number,
  gstPct: number,
  enteredIncludesGst: boolean
): PurchaseCost {
  const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100
  const rate = Number.isFinite(enteredRate) && enteredRate > 0 ? enteredRate : 0
  const pct = Number.isFinite(gstPct) && gstPct > 0 ? gstPct : 0

  if (enteredIncludesGst) {
    const gstAmount = round2((rate * pct) / (100 + pct))
    const rateExGst = round2(rate - gstAmount)
    return { rateExGst, gstPct: pct, gstAmount, rateInclGst: round2(rate) }
  }
  const gstAmount = round2((rate * pct) / 100)
  return { rateExGst: round2(rate), gstPct: pct, gstAmount, rateInclGst: round2(rate + gstAmount) }
}
