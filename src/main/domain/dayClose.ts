import { round2 } from '../../shared/money'
import { IST_OFFSET_MS } from './dates'

/**
 * The day book, and the count that closes it.
 *
 * At the end of trading somebody opens the drawer and counts what is in it.
 * The point of this module is to say what *should* be in there, so the two
 * numbers can be put side by side and the difference chased while anybody
 * still remembers the day.
 *
 * Expected cash is built from the Payment rows, not from the bills. That
 * distinction matters: money collected today against a credit sale from last
 * month is in today's drawer, and a bill raised today on credit is not. Only
 * the payment rows know when the money actually moved.
 */

type DbClient = {
  bill: { findMany: Function; groupBy: Function; aggregate: Function; count: Function }
  payment: { findMany: Function }
  expense: { findMany: Function }
  dayClose: { findUnique: Function; findFirst: Function; findMany: Function; create: Function }
}

/** The four tenders a shop takes money through. */
export const TENDERS = ['CASH', 'UPI', 'CARD', 'CHEQUE'] as const
export type Tender = (typeof TENDERS)[number]

export type TenderMovement = {
  method: string
  /** Money taken in through this tender. */
  collected: number
  /** Money handed back through it — always reported as a positive number. */
  refunded: number
  /** collected - refunded. */
  net: number
  count: number
}

export type DayBook = {
  businessDate: string
  /** Half-open window, as UTC instants. */
  from: string
  to: string
  sales: { billCount: number; total: number; voided: number }
  returns: { count: number; total: number }
  tenders: TenderMovement[]
  cash: {
    /** Carried in from the previous close, or 0 if there isn't one. */
    openingFloat: number
    collected: number
    refunded: number
    /** Cash taken out of the till for expenses — the courier, the tea, a part. */
    paidOut: number
    /** openingFloat + collected - refunded - paidOut. */
    expected: number
  }
  /** The expenses behind `cash.paidOut`, so a difference can be traced. */
  paidOut: Array<{ id: string; category: string; amount: number; payee: string | null; notes: string | null }>
  previousClose: { businessDate: string; countedCash: number; difference: number } | null
  /** Set once the day has been counted. A closed day is read-only. */
  closed: ClosedDay | null
  /** Blocks the count until they are dealt with. */
  blocking: string[]
}

export type ClosedDay = {
  businessDate: string
  openingFloat: number
  expectedCash: number
  cashPaidOut: number
  countedCash: number
  difference: number
  upiTotal: number
  cardTotal: number
  chequeTotal: number
  billCount: number
  salesTotal: number
  notes: string | null
  closedBy: string
  closedAt: string
}

/** `YYYY-MM-DD` for an IST calendar day, from any instant within it. */
export function istDateKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS)
  return ist.toISOString().slice(0, 10)
}

/**
 * A business date is the calendar day itself, held as UTC midnight so it
 * round-trips through a Postgres `date` column unchanged. Holding IST midnight
 * there instead would store 18:30 on the previous day and file every count
 * against the wrong date.
 */
export function businessDateFor(instant: Date = new Date()): Date {
  return new Date(`${istDateKey(instant)}T00:00:00.000Z`)
}

/** The key back out of a stored business date. */
export function businessDateKey(d: Date): string {
  return new Date(d).toISOString().slice(0, 10)
}

/**
 * Parses `YYYY-MM-DD` into the business date it names. Returns null for
 * anything else — a silently-defaulted date would close the wrong day's drawer.
 */
export function parseBusinessDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null
  const parsed = new Date(`${raw}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return null
  // Round-trips only for real calendar dates, so 2026-02-30 is rejected rather
  // than quietly becoming the 2nd of March.
  if (businessDateKey(parsed) !== raw) return null
  return parsed
}

/**
 * The half-open [start, end) window of instants belonging to a business date.
 * The day runs IST midnight to IST midnight, because that is when the shop's
 * day starts and ends.
 */
export function dayWindow(businessDate: Date): { from: Date; to: Date } {
  const from = new Date(businessDate.getTime() - IST_OFFSET_MS)
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) }
}

export async function buildDayBook(
  db: DbClient,
  businessDate: Date,
  openingFloatOverride?: number
): Promise<DayBook> {
  const { from, to } = dayWindow(businessDate)
  const window = { gte: from, lt: to }

  const [saleRows, returnRows, voided, payments, closeRow, prevClose, tillExpenses] = await Promise.all([
    db.bill.findMany({
      where: { paidAt: window, status: { notIn: ['VOID', 'RETURN'] } },
      select: { totalAmount: true }
    }),
    db.bill.findMany({
      where: { paidAt: window, status: 'RETURN' },
      select: { totalAmount: true }
    }),
    db.bill.count({ where: { paidAt: window, status: 'VOID' } }),
    db.payment.findMany({
      where: { receivedAt: window },
      select: { amount: true, method: true }
    }),
    db.dayClose.findUnique({
      where: { businessDate },
      include: { closedBy: { select: { username: true } } }
    }),
    db.dayClose.findFirst({
      where: { businessDate: { lt: businessDate } },
      orderBy: { businessDate: 'desc' }
    }),
    // Cash handed over the counter that was not a refund: the courier, a
    // part collected in a hurry, the tea. Without these the drawer comes up
    // short every day and the shortfall gets written off as a miscount.
    db.expense.findMany({
      where: { paidFromTill: true, paidOn: businessDate },
      include: { category: { select: { name: true } } },
      orderBy: { createdAt: 'asc' }
    })
  ])

  const movements = new Map<string, TenderMovement>()
  for (const method of TENDERS) {
    movements.set(method, { method, collected: 0, refunded: 0, net: 0, count: 0 })
  }
  for (const p of payments) {
    const method = String(p.method)
    let m = movements.get(method)
    if (!m) {
      // An unknown tender is still money; showing it beats hiding it.
      m = { method, collected: 0, refunded: 0, net: 0, count: 0 }
      movements.set(method, m)
    }
    const amount = Number(p.amount)
    if (amount < 0) m.refunded = round2(m.refunded - amount)
    else m.collected = round2(m.collected + amount)
    m.count += 1
  }
  for (const m of movements.values()) m.net = round2(m.collected - m.refunded)

  const cashMovement = movements.get('CASH') as TenderMovement
  const previousCounted = prevClose ? round2(Number(prevClose.countedCash)) : 0
  const openingFloat =
    openingFloatOverride !== undefined
      ? round2(openingFloatOverride)
      : closeRow
        ? round2(Number(closeRow.openingFloat))
        : previousCounted

  // The gross figure, not the net-of-GST one: what left the drawer is what
  // was handed over, tax included.
  const paidOut = round2(
    tillExpenses.reduce((s: number, e: any) => s + Number(e.amount), 0)
  )

  const salesTotal = round2(saleRows.reduce((s: number, b: any) => s + Number(b.totalAmount), 0))
  const returnsTotal = round2(returnRows.reduce((s: number, b: any) => s + Number(b.totalAmount), 0))

  const blocking: string[] = []
  const now = new Date()
  if (to.getTime() > now.getTime() && !closeRow) {
    blocking.push(
      'This day is still trading. Counting the drawer now will miss anything sold after the count.'
    )
  }

  return {
    businessDate: businessDateKey(businessDate),
    from: from.toISOString(),
    to: to.toISOString(),
    sales: { billCount: saleRows.length, total: salesTotal, voided },
    returns: { count: returnRows.length, total: returnsTotal },
    tenders: [...movements.values()].filter((m) => m.count > 0 || TENDERS.includes(m.method as Tender)),
    cash: {
      openingFloat,
      collected: cashMovement.collected,
      refunded: cashMovement.refunded,
      paidOut,
      expected: round2(openingFloat + cashMovement.net - paidOut)
    },
    paidOut: tillExpenses.map((e: any) => ({
      id: e.id,
      category: e.category?.name ?? '',
      amount: round2(Number(e.amount)),
      payee: e.payee ?? null,
      notes: e.notes ?? null
    })),
    previousClose: prevClose
      ? {
          businessDate: businessDateKey(prevClose.businessDate),
          countedCash: previousCounted,
          difference: round2(Number(prevClose.difference))
        }
      : null,
    closed: closeRow ? serializeClose(closeRow) : null,
    blocking
  }
}

export function serializeClose(row: any): ClosedDay {
  return {
    businessDate: businessDateKey(row.businessDate),
    openingFloat: round2(Number(row.openingFloat)),
    expectedCash: round2(Number(row.expectedCash)),
    cashPaidOut: round2(Number(row.cashPaidOut ?? 0)),
    countedCash: round2(Number(row.countedCash)),
    difference: round2(Number(row.difference)),
    upiTotal: round2(Number(row.upiTotal)),
    cardTotal: round2(Number(row.cardTotal)),
    chequeTotal: round2(Number(row.chequeTotal)),
    billCount: row.billCount,
    salesTotal: round2(Number(row.salesTotal)),
    notes: row.notes ?? null,
    closedBy: row.closedBy?.username ?? '',
    closedAt: new Date(row.closedAt).toISOString()
  }
}

export type CloseDayArgs = {
  businessDate: Date
  openingFloat: number
  countedCash: number
  notes: string | null
  closedById: string
}

export type CloseDayResult =
  | { ok: true; close: ClosedDay }
  | { ok: false; code: string; message: string }

/**
 * Freezes the day. The figures written here are the ones that were on screen
 * when the drawer was counted, so the record still reconciles after later
 * returns move the underlying totals.
 */
export async function closeDay(db: DbClient, args: CloseDayArgs): Promise<CloseDayResult> {
  const existing = await db.dayClose.findUnique({ where: { businessDate: args.businessDate } })
  if (existing) {
    return {
      ok: false,
      code: 'ALREADY_CLOSED',
      message: `${businessDateKey(args.businessDate)} was already counted. A drawer count cannot be redone.`
    }
  }

  const book = await buildDayBook(db, args.businessDate, args.openingFloat)
  const difference = round2(args.countedCash - book.cash.expected)
  if (difference !== 0 && !args.notes) {
    return {
      ok: false,
      code: 'DIFFERENCE_NEEDS_NOTE',
      message:
        difference < 0
          ? `The drawer is short by ₹${Math.abs(difference).toFixed(2)}. Say what you think happened before closing.`
          : `The drawer is over by ₹${difference.toFixed(2)}. Say what you think happened before closing.`
    }
  }

  const byMethod = (m: string): number =>
    round2(book.tenders.find((t) => t.method === m)?.net ?? 0)

  const created = await db.dayClose.create({
    data: {
      businessDate: args.businessDate,
      openingFloat: round2(args.openingFloat),
      expectedCash: book.cash.expected,
      cashPaidOut: book.cash.paidOut,
      countedCash: round2(args.countedCash),
      difference,
      upiTotal: byMethod('UPI'),
      cardTotal: byMethod('CARD'),
      chequeTotal: byMethod('CHEQUE'),
      billCount: book.sales.billCount,
      salesTotal: book.sales.total,
      notes: args.notes,
      closedById: args.closedById
    },
    include: { closedBy: { select: { username: true } } }
  })
  return { ok: true, close: serializeClose(created) }
}
