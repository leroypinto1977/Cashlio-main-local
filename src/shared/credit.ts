/**
 * Settlement arithmetic — how much of a bill has been paid, what is still
 * owed, and what that makes the bill's status.
 *
 * Shared by the branch server, the manager UI and the terminal so the figure a
 * cashier sees while taking payment is the figure the server stores.
 */

import { round2 } from './money'

export type PaymentMethod = 'CASH' | 'UPI' | 'CARD' | 'CHEQUE'
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['CASH', 'UPI', 'CARD', 'CHEQUE']

/** One tender taken at the counter. A split payment is simply several. */
export type Tender = {
  method: string
  amount: number
  reference?: string | null
}

export type BillStatus = 'PAID' | 'PARTIAL' | 'CREDIT' | 'VOID' | 'RETURN'

export type Settlement = {
  paidAmount: number
  balanceDue: number
  changeGiven: number
  status: 'PAID' | 'PARTIAL' | 'CREDIT'
  tendered: number
}

export function isPaymentMethod(m: unknown): m is PaymentMethod {
  return typeof m === 'string' && (PAYMENT_METHODS as readonly string[]).includes(m)
}

export function sumTenders(tenders: Tender[]): number {
  return round2(tenders.reduce((s, t) => s + (Number(t.amount) || 0), 0))
}

/**
 * Works out settlement from what was actually handed over.
 *
 * Change is only ever given against cash — you cannot hand back the excess of
 * a card swipe — so an over-tender on a cashless method is treated as paying
 * the bill exactly rather than generating change.
 */
export function settle(totalAmount: number, tenders: Tender[]): Settlement {
  const total = round2(Math.max(0, totalAmount))
  const tendered = sumTenders(tenders)
  const hasCash = tenders.some((t) => t.method === 'CASH' && Number(t.amount) > 0)

  const paidAmount = round2(Math.min(tendered, total))
  const balanceDue = round2(Math.max(0, total - tendered))
  const changeGiven = hasCash ? round2(Math.max(0, tendered - total)) : 0

  const status: Settlement['status'] =
    balanceDue <= 0 ? 'PAID' : paidAmount > 0 ? 'PARTIAL' : 'CREDIT'

  return { paidAmount, balanceDue, changeGiven, status, tendered }
}

/** Status implied by an amount already paid against a total. */
export function statusFor(totalAmount: number, paidAmount: number): 'PAID' | 'PARTIAL' | 'CREDIT' {
  const balance = round2(round2(totalAmount) - round2(paidAmount))
  if (balance <= 0) return 'PAID'
  return paidAmount > 0 ? 'PARTIAL' : 'CREDIT'
}

/** Statuses that still owe money and therefore count toward outstanding. */
export const UNSETTLED_STATUSES = ['PARTIAL', 'CREDIT'] as const

// ─── Credit limits ────────────────────────────────────────────────────────────

export type CreditCheck = {
  allowed: boolean
  /** True when only a super-admin can wave this through. */
  needsOverride: boolean
  currentOutstanding: number
  newBalance: number
  projectedOutstanding: number
  creditLimit: number
  overBy: number
  reason?: 'NO_CUSTOMER' | 'NO_CREDIT_ALLOWED' | 'LIMIT_EXCEEDED'
}

/**
 * Decides whether a customer may carry a new balance.
 *
 * A walk-in with no customer record cannot take credit at all — there would be
 * nobody to chase. A customer whose limit is zero has not been granted credit.
 * Anything above the limit is refused for a cashier but can be overridden by a
 * super-admin, which is the shop owner's call to make.
 */
export function checkCredit(args: {
  hasCustomer: boolean
  creditLimit: number
  currentOutstanding: number
  newBalance: number
}): CreditCheck {
  const creditLimit = round2(Math.max(0, args.creditLimit))
  const currentOutstanding = round2(Math.max(0, args.currentOutstanding))
  const newBalance = round2(Math.max(0, args.newBalance))
  const projectedOutstanding = round2(currentOutstanding + newBalance)
  const overBy = round2(Math.max(0, projectedOutstanding - creditLimit))

  const base = { currentOutstanding, newBalance, projectedOutstanding, creditLimit, overBy }

  if (newBalance <= 0) return { ...base, allowed: true, needsOverride: false, overBy: 0 }
  if (!args.hasCustomer) {
    return { ...base, allowed: false, needsOverride: false, reason: 'NO_CUSTOMER' }
  }
  if (creditLimit <= 0) {
    return { ...base, allowed: false, needsOverride: true, reason: 'NO_CREDIT_ALLOWED' }
  }
  if (overBy > 0) {
    return { ...base, allowed: false, needsOverride: true, reason: 'LIMIT_EXCEEDED' }
  }
  return { ...base, allowed: true, needsOverride: false }
}

// ─── Ageing ───────────────────────────────────────────────────────────────────

export type AgeBucket = 'current' | '0-30' | '31-60' | '60+'

export const AGE_BUCKETS: readonly AgeBucket[] = ['current', '0-30', '31-60', '60+']

/** Whole days between two instants, floored. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  return Math.floor((b - a) / 86_400_000)
}

/**
 * Buckets a balance by how long it has been overdue. A bill inside its credit
 * period is "current" rather than zero-days-overdue — the distinction is what
 * tells a manager who actually needs chasing.
 */
export function ageBucketOf(
  dueDate: Date | string | null | undefined,
  billDate: Date | string,
  now: Date | string = new Date()
): AgeBucket {
  const reference = dueDate ? new Date(dueDate) : new Date(billDate)
  const overdue = daysBetween(reference, now)
  if (overdue < 0) return 'current'
  if (overdue <= 30) return '0-30'
  if (overdue <= 60) return '31-60'
  return '60+'
}

/** Due date for a balance carried under a customer's credit terms. */
export function dueDateFor(billDate: Date | string, creditDays: number): Date | null {
  const days = Number(creditDays)
  if (!Number.isFinite(days) || days <= 0) return null
  const d = new Date(billDate)
  d.setDate(d.getDate() + Math.floor(days))
  return d
}
