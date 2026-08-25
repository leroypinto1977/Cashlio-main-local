import { round2 } from '../../shared/money'
import { businessDateFor, businessDateKey, parseBusinessDate } from './dayClose'

/**
 * What the shop spends that is not stock.
 *
 * The analytics screen has always been careful to say *gross* margin, which is
 * honest but is not the number anybody means when they ask what the shop made
 * last month. Recording expenses is what lets that number be stated net, and
 * the only real subtlety is the tax: a registered shop reclaims the GST it
 * pays, so an expense of ₹1,180 with ₹180 of GST costs it ₹1,000. Netting it
 * off is also what makes expenses comparable with revenue, which the margin
 * calculation already holds ex-GST.
 */

export const EXPENSE_METHODS = ['CASH', 'UPI', 'CARD', 'CHEQUE', 'BANK'] as const
export type ExpenseMethod = (typeof EXPENSE_METHODS)[number]

export const EXPENSE_KINDS = ['FIXED', 'VARIABLE'] as const
export type ExpenseKind = (typeof EXPENSE_KINDS)[number]

export function isExpenseMethod(v: unknown): v is ExpenseMethod {
  return EXPENSE_METHODS.includes(String(v) as ExpenseMethod)
}

export function isExpenseKind(v: unknown): v is ExpenseKind {
  return EXPENSE_KINDS.includes(String(v) as ExpenseKind)
}

export type ExpenseInput = {
  categoryId: string
  amount: number
  gstAmount: number
  paidOn: Date
  method: ExpenseMethod
  paidFromTill: boolean
  payee: string | null
  reference: string | null
  notes: string | null
  isRecurring: boolean
}

export type ParseResult =
  | { ok: true; value: ExpenseInput }
  | { ok: false; error: string; message: string }

/** How far ahead an expense may be dated. Rent paid for next month is real. */
const MAX_FUTURE_DAYS = 62
/** And how far back, so a typed year cannot bury an entry in 2019. */
const MAX_PAST_DAYS = 366 * 3

/**
 * Reads a submitted expense and says precisely what is wrong with it.
 *
 * The checks that matter are the two that would quietly corrupt a total: an
 * amount that is not a number, and a GST portion larger than the amount it is
 * supposed to be inside — which would make the expense cost less than nothing.
 */
export function parseExpense(body: Record<string, unknown>): ParseResult {
  const bad = (error: string, message: string): ParseResult => ({ ok: false, error, message })

  const categoryId = String(body.categoryId ?? '').trim()
  if (!categoryId) return bad('CATEGORY_REQUIRED', 'Choose what this was spent on.')

  const amount = Number(body.amount)
  if (!Number.isFinite(amount)) return bad('AMOUNT_REQUIRED', 'Enter the amount.')
  if (amount <= 0) {
    return bad('AMOUNT_NOT_POSITIVE', 'An expense has to be more than nothing. To correct one, edit or delete it.')
  }
  if (amount > 100_000_000) {
    return bad('AMOUNT_TOO_LARGE', 'That is larger than any expense this shop is likely to have. Check the figure.')
  }

  const gstAmount = body.gstAmount === undefined || body.gstAmount === null || body.gstAmount === ''
    ? 0
    : Number(body.gstAmount)
  if (!Number.isFinite(gstAmount) || gstAmount < 0) {
    return bad('GST_INVALID', 'The GST on an expense cannot be negative.')
  }
  if (gstAmount > amount) {
    return bad(
      'GST_EXCEEDS_AMOUNT',
      `The GST (₹${round2(gstAmount).toFixed(2)}) cannot be more than the amount paid (₹${round2(amount).toFixed(2)}). It is the tax inside that figure, not on top of it.`
    )
  }

  const paidOn = body.paidOn === undefined ? businessDateFor() : parseBusinessDate(body.paidOn)
  if (!paidOn) return bad('BAD_DATE', 'Give the date as YYYY-MM-DD.')
  const today = businessDateFor()
  const dayMs = 24 * 60 * 60 * 1000
  const daysAhead = Math.round((paidOn.getTime() - today.getTime()) / dayMs)
  if (daysAhead > MAX_FUTURE_DAYS) {
    return bad('DATE_TOO_FAR_AHEAD', 'That date is more than two months away. Check the year.')
  }
  if (-daysAhead > MAX_PAST_DAYS) {
    return bad('DATE_TOO_FAR_BACK', 'That date is more than three years ago. Check the year.')
  }

  const method = isExpenseMethod(body.method) ? (body.method as ExpenseMethod) : 'CASH'
  // Only cash can come out of the till. A card payment marked as such would
  // silently pull the drawer down and turn a balanced day into a short one.
  const paidFromTill = method === 'CASH' && body.paidFromTill === true

  const trimmed = (v: unknown): string | null => {
    const s = String(v ?? '').trim()
    return s === '' ? null : s.slice(0, 200)
  }

  return {
    ok: true,
    value: {
      categoryId,
      amount: round2(amount),
      gstAmount: round2(gstAmount),
      paidOn,
      method,
      paidFromTill,
      payee: trimmed(body.payee),
      reference: trimmed(body.reference),
      notes: trimmed(body.notes),
      isRecurring: body.isRecurring === true
    }
  }
}

/** What an expense actually costs the shop: the tax comes back. */
export function netCost(amount: unknown, gstAmount: unknown): number {
  return round2(Math.max(0, Number(amount ?? 0) - Number(gstAmount ?? 0)))
}

export type ExpenseRow = {
  id: string
  category: { id: string; name: string; kind: string }
  amount: number
  gstAmount: number
  netCost: number
  paidOn: string
  method: string
  paidFromTill: boolean
  payee: string | null
  reference: string | null
  notes: string | null
  isRecurring: boolean
  recordedBy: string
  createdAt: string
}

export function serializeExpense(e: {
  id: string
  category: { id: string; name: string; kind: string }
  amount: unknown
  gstAmount: unknown
  paidOn: Date
  method: string
  paidFromTill: boolean
  payee: string | null
  reference: string | null
  notes: string | null
  isRecurring: boolean
  recordedBy?: { username: string } | null
  createdAt: Date
}): ExpenseRow {
  return {
    id: e.id,
    category: { id: e.category.id, name: e.category.name, kind: e.category.kind },
    amount: round2(Number(e.amount)),
    gstAmount: round2(Number(e.gstAmount)),
    netCost: netCost(e.amount, e.gstAmount),
    paidOn: businessDateKey(e.paidOn),
    method: e.method,
    paidFromTill: e.paidFromTill,
    payee: e.payee,
    reference: e.reference,
    notes: e.notes,
    isRecurring: e.isRecurring,
    recordedBy: e.recordedBy?.username ?? '',
    createdAt: new Date(e.createdAt).toISOString()
  }
}

export type CategoryTotal = {
  categoryId: string
  name: string
  kind: string
  amount: number
  netCost: number
  count: number
}

/** Totals by category, biggest first — which is the order they get looked at. */
export function totalByCategory(rows: ExpenseRow[]): CategoryTotal[] {
  const map = new Map<string, CategoryTotal>()
  for (const r of rows) {
    const entry = map.get(r.category.id) ?? {
      categoryId: r.category.id,
      name: r.category.name,
      kind: r.category.kind,
      amount: 0,
      netCost: 0,
      count: 0
    }
    entry.amount = round2(entry.amount + r.amount)
    entry.netCost = round2(entry.netCost + r.netCost)
    entry.count += 1
    map.set(r.category.id, entry)
  }
  return [...map.values()].sort((a, b) => b.netCost - a.netCost)
}

export type ExpenseTotals = {
  /** What was handed over, GST included. */
  paid: number
  /** GST inside that, which a registered shop reclaims. */
  gst: number
  /** What it actually cost — the figure net profit is worked out from. */
  net: number
  /** Costs that are there whether or not the shop sells anything. */
  fixed: number
  variable: number
  count: number
}

export function totalExpenses(rows: ExpenseRow[]): ExpenseTotals {
  let paid = 0, gst = 0, net = 0, fixed = 0, variable = 0
  for (const r of rows) {
    paid = round2(paid + r.amount)
    gst = round2(gst + r.gstAmount)
    net = round2(net + r.netCost)
    if (r.category.kind === 'FIXED') fixed = round2(fixed + r.netCost)
    else variable = round2(variable + r.netCost)
  }
  return { paid, gst, net, fixed, variable, count: rows.length }
}
