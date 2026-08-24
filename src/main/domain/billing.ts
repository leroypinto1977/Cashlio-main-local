/**
 * The billing domain: how a sale is priced, what stock it consumes, how it is
 * settled, and what happens when goods come back.
 *
 * None of this knows about HTTP. Every function takes a transaction and
 * returns rows or throws a tagged error, so the routes are left to translate
 * between the wire and this — and so this can be exercised without standing a
 * server up. It lived inside the 5,000-line route file until now, which is
 * why the only way to test any of it was through a real request.
 */
import type { TxClient, DbClient } from './db'
import { allocateNumber } from './numbering'
import { emitBillUpsert, emitProductUpsertBulk } from '../syncEvents'
import { stateCodeOf } from '../../shared/validation'
import { round2, computeInvoiceTotals } from '../../shared/money'
import { parseQty, roundQty } from '../../shared/units'
import {
  settle, checkCredit, isPaymentMethod, dueDateFor,
  UNSETTLED_STATUSES, type Tender
} from '../../shared/credit'
import { shouldRestock } from '../../shared/procurement'
import { expiryDateFor } from '../../shared/warranty'

/**
 * The largest per-line discount anyone may give without it being a price
 * override. Higher than a normal markdown, low enough that "100% off" is
 * no longer a way to walk stock out of the door.
 */
export const MAX_LINE_DISCOUNT_PCT = 90

// ─── GST ──────────────────────────────────────────────────────────────────────

/**
 * A sale is inter-state only when we know both the shop's and the customer's
 * state and they differ. A walk-in customer with no GSTIN is treated as local,
 * which is the correct default for over-the-counter retail.
 */
export async function resolveTaxContext(
  db: DbClient,
  customerId: string | null
): Promise<{ interState: boolean; placeOfSupply: string | null }> {
  const config = await db.shopConfig.findFirst({ select: { stateCode: true, gstin: true } })
  const shopState = config?.stateCode || stateCodeOf(config?.gstin) || null
  let customerState: string | null = null
  if (customerId) {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: { gstin: true }
    })
    customerState = stateCodeOf(customer?.gstin)
  }
  return {
    interState: Boolean(shopState && customerState && shopState !== customerState),
    placeOfSupply: customerState || shopState
  }
}
/**
 * What a customer currently owes: the sum of balances on bills that are still
 * part-paid or on credit. Never stored, so it cannot drift away from the bills
 * it describes.
 */
export async function outstandingFor(db: DbClient, customerId: string): Promise<number> {
  const agg = await db.bill.aggregate({
    where: { customerId, status: { in: [...UNSETTLED_STATUSES] } },
    _sum: { balanceDue: true }
  })
  return round2(Number(agg._sum.balanceDue ?? 0))
}
/**
 * Normalises whatever the client sent into a list of tenders.
 *
 * Older clients (and the terminal's offline outbox) send a single
 * `paymentMethod` with an optional `amountReceived`; newer ones send a
 * `payments` array so a bill can be split across cash and UPI. A bill with no
 * tender at all is a pure credit sale.
 */
export type TenderRead =
  | { error: string }
  | { tenders: Tender[]; settleInFull: boolean; method: string }

export function readTenders(body: Record<string, unknown>): TenderRead {
  const raw = body.payments
  if (Array.isArray(raw)) {
    const tenders: Tender[] = []
    for (const t of raw) {
      const line = t as { method?: unknown; amount?: unknown; reference?: unknown }
      if (!isPaymentMethod(line.method)) return { error: 'INVALID_PAYMENT_METHOD' }
      const amount = round2(Number(line.amount))
      if (!Number.isFinite(amount) || amount < 0) return { error: 'INVALID_PAYMENT_AMOUNT' }
      if (amount === 0) continue
      tenders.push({
        method: line.method,
        amount,
        reference: typeof line.reference === 'string' ? line.reference.trim() || null : null
      })
    }
    return { tenders, settleInFull: false, method: tenders[0]?.method ?? 'CASH' }
  }

  const method = body.paymentMethod
  if (!isPaymentMethod(method)) return { error: 'INVALID_PAYMENT_METHOD' }

  // Older clients send only a method, meaning "paid in full at the counter".
  // The total is not known until the lines are priced, so that is expressed as
  // a flag rather than a number invented here.
  const received = body.amountReceived
  if (received == null) return { tenders: [], settleInFull: true, method }

  const amount = round2(Number(received))
  if (!Number.isFinite(amount) || amount < 0) return { error: 'INVALID_PAYMENT_AMOUNT' }
  return { tenders: amount === 0 ? [] : [{ method, amount, reference: null }], settleInFull: false, method }
}
/**
 * Takes an exclusive lock on a bill for the rest of the transaction.
 *
 * Void, return and payment all used to read their preconditions outside the
 * transaction that enforced them, so two concurrent requests could both pass
 * the same check: stock restocked twice by a double void, two credit notes
 * for one return, or two payments where the second silently overwrote the
 * first and the shop lost the record of money it had taken.
 */
export async function lockBill(tx: TxClient, billId: string): Promise<void> {
  await tx.$executeRaw`SELECT "id" FROM "Bill" WHERE "id" = ${billId} FOR UPDATE`
}

/**
 * The same, for a purchase order.
 *
 * Receiving read the order, decided what was still outstanding, and wrote the
 * batches — with nothing holding the row in between. Two deliveries booked at
 * the same moment both saw the same "still outstanding" and both received in
 * full: two batches for one delivery, and stock the shop does not have.
 */
export async function lockPurchaseOrder(tx: TxClient, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT "id" FROM "PurchaseOrder" WHERE "id" = ${orderId} FOR UPDATE`
}

/**
 * Recomputes a bill's settlement from the records that actually exist: what
 * has been collected against it, less anything returned. Storing the result
 * keeps queries cheap, but it is always derivable from payments and credit
 * notes, so it cannot silently drift.
 */
export async function recomputeBillSettlement(tx: TxClient, billId: string): Promise<void> {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    select: {
      id: true, totalAmount: true, status: true,
      payments: { select: { amount: true } },
      returns: { where: { status: 'RETURN' }, select: { totalAmount: true } }
    }
  })
  if (!bill || bill.status === 'VOID' || bill.status === 'RETURN') return

  const total = round2(Number(bill.totalAmount))
  const paid = round2(bill.payments.reduce((s, p) => s + Number(p.amount), 0))
  const returned = round2(bill.returns.reduce((s, r) => s + Number(r.totalAmount), 0))
  const balanceDue = round2(Math.max(0, total - paid - returned))

  await tx.bill.update({
    where: { id: bill.id },
    data: {
      paidAmount: paid,
      balanceDue,
      status: balanceDue <= 0 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'CREDIT'
    }
  })
}
// ─── Bill core helpers ────────────────────────────────────────────────────────
// Shared between POST /bills, POST /bills/:id/return, and POST /bills/:id/exchange
// so the same FIFO / pro-ration / serialization logic is used everywhere.

export type IncomingSaleItem = {
  productId: string
  quantity: number
  unitRate: number
  gstPercentage: number
  lineDiscountPct: number
  lineDiscountAmt: number
}

export type CreateBillArgs = {
  items: IncomingSaleItem[]
  customerId: string | null
  originDeviceId: string
  cashierId: string
  paymentMethod: string
  amountReceived: number | null
  tenders: Tender[]
  /// Treat the bill as settled in full whatever the total turns out to be.
  /// Used for the legacy client shape, where "no amountReceived" has always
  /// meant "paid in full at the counter".
  settleInFull?: boolean
  /// Value carried over from a credit note rather than tendered. The
  /// replacement half of an exchange is paid for by the refund; recording
  /// that as a cash tender overstated takings by the refund amount.
  creditApplied?: number
  /// Set by a SUPER_ADMIN to let a bill exceed the customer's credit limit.
  allowCreditOverride: boolean
  /// Set by a SUPER_ADMIN to bill a line at something other than the
  /// catalogue price. A cashier's request for this is ignored.
  allowPriceOverride?: boolean
  discountAmount: number
  notes: string | null
  clientLocalId: string | null
  /// When the sale actually happened, as reported by the terminal. An offline
  /// bill can reach the server hours later; stamping it with arrival time puts
  /// takings on the wrong day and ages credit from the wrong date. Clamped
  /// before it gets here — see `resolveSoldAt`.
  soldAt?: Date
}

/**
 * Decide the time a sale happened.
 *
 * The terminal knows; the server only knows when the bill arrived, which for
 * an offline bill can be hours or a day later. So the terminal's clock is
 * preferred — but it is a machine in a shop, and a wrong one would let a sale
 * land in next year's books or on a day already closed and reported.
 *
 * So it is trusted only within a window: never ahead of the server (a few
 * minutes of skew allowed), and never more than a fortnight back, which is
 * far longer than any real outage and short enough to bound the damage.
 * Anything outside falls back to now, which is at worst the behaviour we
 * already had.
 */
const SOLD_AT_MAX_BACKDATE_MS = 14 * 24 * 60 * 60 * 1000
const SOLD_AT_MAX_SKEW_MS = 5 * 60 * 1000
export function resolveSoldAt(raw: unknown, now = new Date()): Date {
  if (raw == null || raw === '') return now
  const t = new Date(String(raw))
  const ms = t.getTime()
  if (!Number.isFinite(ms)) return now
  if (ms > now.getTime() + SOLD_AT_MAX_SKEW_MS) return now
  if (ms < now.getTime() - SOLD_AT_MAX_BACKDATE_MS) return now
  return t
}

// Performs FIFO stock deduction and creates a PAID Bill row inside a tx.
// Throws { code: 'INSUFFICIENT_STOCK' | 'PRODUCT_NOT_FOUND', ... } on failure.
export async function createBillCore(tx: TxClient, args: CreateBillArgs, billNumber?: string) {
  // Allocated inside the tx: if the sale rolls back, the number is released.
  const invoiceNumber = billNumber || (await allocateNumber(tx, 'INV'))
  // The moment of sale, not the moment of arrival. Everything dated off the
  // bill — the day's takings, credit ageing, warranty cover — hangs on this.
  const soldAt = args.soldAt ?? new Date()
  type FinalLine = {
    productId: string; itemCode: string; productName: string; unitOfMeasure: string
    hsnCode: string | null
    quantity: number; unitRate: number; gstPercentage: number
    lineDiscountPct: number; lineDiscountAmt: number
    lineGstAmount: number; lineTotal: number
    billDiscountAmt: number; taxableValue: number
    cgstAmount: number; sgstAmount: number; igstAmount: number
    /** Which batches this line was taken from, oldest first. */
    allocations: { batchId: string; quantity: number; unitCost: number }[]
    warrantyPeriodDays: number
  }
  const lines: FinalLine[] = []

  for (const rawItem of args.items) {
    const product = await tx.product.findUnique({ where: { id: rawItem.productId } })
    if (!product) throw Object.assign(new Error('PRODUCT_NOT_FOUND'), { code: 'PRODUCT_NOT_FOUND' })

    // A deactivated product must not be sellable through the API just because
    // it is still reachable by id.
    if (!product.isActive) {
      throw Object.assign(new Error('PRODUCT_INACTIVE'), {
        code: 'PRODUCT_INACTIVE', productName: product.name
      })
    }

    // Price and tax come from the product master, never from the request.
    //
    // These used to be taken from the request body unchecked, which meant
    // anyone who could reach the API could bill any item at any price: a
    // 100% line discount, or a unit rate of 1, emptied the stock room for
    // nothing and left a clean PAID invoice behind. A stale terminal mirror
    // did the same thing accidentally. A genuine price override is still
    // possible, but only a super admin may ask for one.
    const catalogueRate = round2(Number(product.sellingRate))
    const requestedRate = round2(Number(rawItem.unitRate))
    const wantsOverride =
      Number.isFinite(requestedRate) && requestedRate >= 0 && requestedRate !== catalogueRate

    if (wantsOverride && !args.allowPriceOverride) {
      throw Object.assign(new Error('PRICE_OVERRIDE_NOT_ALLOWED'), {
        code: 'PRICE_OVERRIDE_NOT_ALLOWED',
        productName: product.name,
        catalogueRate,
        requestedRate
      })
    }
    const unitRate = wantsOverride ? requestedRate : catalogueRate

    // Discounts are bounded so they cannot be used as a back door to the
    // same result the rate check just closed.
    const lineDiscountPct = Number(rawItem.lineDiscountPct) || 0
    const lineDiscountAmt = Number(rawItem.lineDiscountAmt) || 0
    if (lineDiscountPct < 0 || lineDiscountPct > MAX_LINE_DISCOUNT_PCT) {
      throw Object.assign(new Error('INVALID_LINE_DISCOUNT'), {
        code: 'INVALID_LINE_DISCOUNT', productName: product.name,
        maxPercent: MAX_LINE_DISCOUNT_PCT
      })
    }

    // Cut-length products bill in fractions of their unit; everything else is
    // floored to whole pieces regardless of what the client sent.
    const item = {
      ...rawItem,
      quantity: parseQty(rawItem.quantity, product.sellMode),
      unitRate,
      // The statutory rate for this product. A wrong rate here is a filing
      // offence for the shop, so it is not the client's to choose.
      gstPercentage: round2(Number(product.gstPercentage)),
      lineDiscountPct,
      lineDiscountAmt
    }
    if (item.quantity <= 0) {
      throw Object.assign(new Error('INVALID_QUANTITY'), {
        code: 'INVALID_QUANTITY', productName: product.name
      })
    }

    const maxFlatDiscount = round2(item.quantity * unitRate * (MAX_LINE_DISCOUNT_PCT / 100))
    if (lineDiscountAmt < 0 || lineDiscountAmt > maxFlatDiscount) {
      throw Object.assign(new Error('INVALID_LINE_DISCOUNT'), {
        code: 'INVALID_LINE_DISCOUNT', productName: product.name,
        maxAmount: maxFlatDiscount
      })
    }

    const stockAgg = await tx.productBatch.aggregate({
      where: { productId: item.productId, isActive: true, currentQty: { gt: 0 } },
      _sum: { currentQty: true }
    })
    const available = roundQty(Number(stockAgg._sum.currentQty ?? 0))
    if (available < item.quantity) {
      throw Object.assign(
        new Error('INSUFFICIENT_STOCK'),
        { code: 'INSUFFICIENT_STOCK', productName: product.name, available, requested: item.quantity }
      )
    }

    const batches = await tx.productBatch.findMany({
      where: { productId: item.productId, isActive: true, currentQty: { gt: 0 } },
      orderBy: { receivedDate: 'asc' }
    })
    let remaining = item.quantity
    const allocations: { batchId: string; quantity: number; unitCost: number }[] = []
    for (const batch of batches) {
      if (remaining <= 0) break
      const batchQty = Number(batch.currentQty)
      const want = roundQty(Math.min(batchQty, remaining))
      if (want <= 0) continue

      // Deduct conditionally, in one statement, so the database decides
      // whether the stock was there.
      //
      // Reading the quantity and then writing back the difference let two
      // tills selling the last unit both pass the availability check and both
      // write the same result: two bills, one unit, no error, and a
      // discrepancy nobody sees until a stock count. The WHERE clause makes
      // that impossible — the loser simply updates no rows.
      // The quantity is bound as text and cast, not as a JS number. Prisma
      // binds 3 as an integer and 2.75 as a double, and a prepared statement
      // keeps whichever type it saw first — so a fractional quantity landing
      // on a connection that had already run a whole one failed with a bind
      // format error, intermittently and only for cut-length products.
      const wantParam = want.toFixed(3)
      const taken = await tx.$executeRaw`
        UPDATE "ProductBatch"
           SET "currentQty" = "currentQty" - ${wantParam}::numeric,
               "updatedAt"  = NOW()
         WHERE "id" = ${batch.id}
           AND "currentQty" >= ${wantParam}::numeric
      `
      if (taken === 0) continue // another till took it first; try the next batch

      // Remembering the split is what lets a later return put the goods back
      // where they came from, and gives this line a true cost of goods.
      allocations.push({
        batchId: batch.id,
        quantity: want,
        unitCost: round2(Number(batch.purchaseRate))
      })
      remaining = roundQty(remaining - want)
    }

    // The pre-check above is advisory; this is the authoritative one. If a
    // concurrent sale drained the batches between the two, we get here short
    // and the whole transaction rolls back rather than shipping goods that
    // were never in stock.
    if (remaining > 0) {
      throw Object.assign(new Error('INSUFFICIENT_STOCK'), {
        code: 'INSUFFICIENT_STOCK',
        productName: product.name,
        available: roundQty(item.quantity - remaining),
        requested: item.quantity
      })
    }

    const base = item.quantity * item.unitRate
    const pctDisc = base * (item.lineDiscountPct / 100)
    const flatDisc = item.lineDiscountAmt
    const lineTotal = round2(Math.max(0, base - pctDisc - flatDisc))

    lines.push({
      productId: item.productId,
      itemCode: product.itemCode,
      productName: product.name,
      unitOfMeasure: product.unitOfMeasure,
      // Copied at the moment of sale, like the code and name above it: the
      // return is filed from the invoice as issued, not from what the product
      // record says months later.
      hsnCode: product.hsnCode,
      quantity: item.quantity,
      unitRate: item.unitRate,
      gstPercentage: item.gstPercentage,
      lineDiscountPct: item.lineDiscountPct,
      lineDiscountAmt: item.lineDiscountAmt,
      // Tax is derived below, once the bill-level discount has been shared out.
      lineGstAmount: 0,
      lineTotal,
      billDiscountAmt: 0,
      taxableValue: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      allocations,
      warrantyPeriodDays: product.warrantyPeriodDays
    })
  }

  const { interState, placeOfSupply } = await resolveTaxContext(tx, args.customerId)
  const totals = computeInvoiceTotals(lines, args.discountAmount, interState)
  lines.forEach((l, i) => {
    const t = totals.lines[i]
    l.billDiscountAmt = t.billDiscountAmt
    l.lineGstAmount = t.gstAmount
    l.taxableValue = t.taxableValue
    l.cgstAmount = t.cgstAmount
    l.sgstAmount = t.sgstAmount
    l.igstAmount = t.igstAmount
  })
  const { subtotal, billDiscount, totalAmount, taxableValue, gstAmount, cgstAmount, sgstAmount, igstAmount } = totals
  // What was actually handed over decides how much is still owed.
  const tenders: Tender[] = args.settleInFull
    ? [{ method: args.paymentMethod, amount: totalAmount }]
    : args.tenders

  // Credit carried from a refund is not money that changed hands, so it
  // settles the bill without appearing as a tender in the payments ledger.
  const creditApplied = round2(Math.min(Math.max(0, args.creditApplied ?? 0), totalAmount))
  const settlement = settle(round2(totalAmount - creditApplied), tenders)

  const customer = args.customerId
    ? await tx.customer.findUnique({
        where: { id: args.customerId },
        select: { id: true, name: true, creditLimit: true, creditDays: true }
      })
    : null
  const creditDays = customer ? Number(customer.creditDays) : 0

  if (settlement.balanceDue > 0) {
    const currentOutstanding = customer ? await outstandingFor(tx, customer.id) : 0
    const credit = checkCredit({
      hasCustomer: Boolean(customer),
      creditLimit: customer ? Number(customer.creditLimit) : 0,
      currentOutstanding,
      newBalance: settlement.balanceDue
    })

    // A super-admin may wave a customer past their limit, but nobody can put a
    // balance on a walk-in — there would be nobody to chase for it.
    const overridden = credit.needsOverride && args.allowCreditOverride
    if (!credit.allowed && !overridden) {
      throw Object.assign(new Error('CREDIT_NOT_ALLOWED'), {
        code: 'CREDIT_NOT_ALLOWED',
        reason: credit.reason,
        customerName: customer?.name,
        ...credit
      })
    }
  }

  const changeGiven = settlement.changeGiven > 0 ? settlement.changeGiven : null

  const created = await tx.bill.create({
    data: {
      billNumber: invoiceNumber,
      clientLocalId: args.clientLocalId,
      status: settlement.status,
      customerId: args.customerId,
      originDeviceId: args.originDeviceId,
      cashierId: args.cashierId,
      subtotal,
      gstAmount,
      discountAmount: billDiscount,
      totalAmount,
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      placeOfSupply,
      paymentMethod: tenders[0]?.method ?? args.paymentMethod,
      amountReceived: settlement.tendered > 0 ? settlement.tendered : null,
      changeGiven,
      paidAmount: round2(settlement.paidAmount + creditApplied),
      balanceDue: settlement.balanceDue,
      paidAt: soldAt,
      dueDate: settlement.balanceDue > 0 ? dueDateFor(soldAt, creditDays) : null,
      notes: args.notes,
      payments: {
        create: tenders.map((t) => ({
          customerId: args.customerId,
          amount: t.amount,
          method: t.method,
          reference: t.reference ?? null,
          isSettlement: false,
          collectedById: args.cashierId
        }))
      },
      items: {
        create: lines.map(({ allocations, warrantyPeriodDays: _w, ...line }) => ({
          ...line,
          batchAllocations: { create: allocations }
        }))
      }
    },
    include: { customer: { select: { name: true } }, items: true }
  })
  // Cover starts the moment the sale is made, so it is created here rather
  // than later from a report — a warranty that has to be remembered into
  // existence is one that gets forgotten. Lines are created in order, so
  // they pair with `lines` by index.
  for (const [i, line] of lines.entries()) {
    if (line.warrantyPeriodDays <= 0) continue
    const item = created.items[i]
    if (!item) continue
    await tx.warranty.create({
      data: {
        productId: line.productId,
        billId: created.id,
        billItemId: item.id,
        customerId: args.customerId,
        purchaseDate: soldAt,
        expiryDate: expiryDateFor(soldAt, line.warrantyPeriodDays)
      }
    })
  }

  // Emit one bill-upsert + one product-upsert per affected product so terminals
  // see the new totalStock without polling.
  await emitBillUpsert(tx, created)
  await emitProductUpsertBulk(tx, lines.map((l) => l.productId))
  return created
}

export type ReturnLineRequest = { billItemId: string; quantity: number }
export type ProcessReturnArgs = {
  originalBillId: string
  returnItems: ReturnLineRequest[]
  reason: string | null
  reasonCode: string | null
  cashierId: string
  originDeviceId: string
  billNumber?: string
}

/**
 * Works out which batches returned goods belong back in.
 *
 * A sale records the batches it took from, so a return can reverse exactly
 * that split rather than guessing. Quantities already returned against the
 * same line are subtracted first, so returning three units twice cannot put
 * six back into a batch that only gave three.
 *
 * Bills written before allocations were recorded have nothing to reverse; for
 * those we fall back to the newest active batch, which is what the old code
 * always did.
 */
export async function planRestock(
  tx: TxClient,
  originalBillItemId: string,
  productId: string,
  quantity: number
): Promise<{ batchId: string; quantity: number; unitCost: number }[]> {
  const taken = await tx.billItemBatch.findMany({
    where: { billItemId: originalBillItemId },
    orderBy: { createdAt: 'asc' }
  })

  if (taken.length === 0) {
    const batch = await tx.productBatch.findFirst({
      where: { productId, isActive: true },
      orderBy: { receivedDate: 'desc' }
    })
    return batch
      ? [{ batchId: batch.id, quantity, unitCost: round2(Number(batch.purchaseRate)) }]
      : []
  }

  // How much has already gone back into each batch for this line.
  const priorReturns = await tx.billItemBatch.findMany({
    where: { billItem: { originalBillItemId, bill: { status: 'RETURN' } } },
    select: { batchId: true, quantity: true }
  })
  const returnedByBatch = new Map<string, number>()
  for (const r of priorReturns) {
    returnedByBatch.set(r.batchId, roundQty((returnedByBatch.get(r.batchId) ?? 0) + Number(r.quantity)))
  }

  const plan: { batchId: string; quantity: number; unitCost: number }[] = []
  let left = roundQty(quantity)
  for (const alloc of taken) {
    if (left <= 0) break
    const capacity = roundQty(Number(alloc.quantity) - (returnedByBatch.get(alloc.batchId) ?? 0))
    if (capacity <= 0) continue
    const put = roundQty(Math.min(capacity, left))
    plan.push({ batchId: alloc.batchId, quantity: put, unitCost: round2(Number(alloc.unitCost)) })
    left = roundQty(left - put)
  }

  // Anything left over (only possible if the sale's own records are short)
  // goes back into the batch it was most likely taken from.
  if (left > 0 && plan.length > 0) {
    plan[plan.length - 1].quantity = roundQty(plan[plan.length - 1].quantity + left)
  }
  return plan
}

// Performs the return half of a refund/exchange inside a tx. Validates against
// already-returned qty per line; restocks; creates a RETURN bill.
// Throws { code: 'ORIGINAL_NOT_PAID' | 'BILL_ITEM_NOT_IN_ORIGINAL' | 'RETURN_QTY_EXCEEDS_REMAINING' | 'NO_RETURN_LINES', ... }.
export async function processReturnCore(tx: TxClient, args: ProcessReturnArgs) {
  // Lock first: the already-returned tally below decides how much may still
  // come back, and two concurrent returns reading it unlocked both passed.
  await lockBill(tx, args.originalBillId)

  const original = await tx.bill.findUnique({
    where: { id: args.originalBillId },
    include: { items: true }
  })
  if (!original) throw Object.assign(new Error('NOT_FOUND'), { code: 'NOT_FOUND' })
  // A part-paid or credit bill can be returned against too; the refund comes
  // off what is still owed before any cash changes hands.
  if (!['PAID', 'PARTIAL', 'CREDIT'].includes(original.status)) {
    throw Object.assign(new Error('ORIGINAL_NOT_PAID'), { code: 'ORIGINAL_NOT_PAID', currentStatus: original.status })
  }

  const priorReturnLines = await tx.billItem.findMany({
    where: {
      originalBillItemId: { in: original.items.map((i) => i.id) },
      bill: { status: 'RETURN' }
    },
    select: { originalBillItemId: true, quantity: true }
  })
  const alreadyReturned = new Map<string, number>()
  for (const r of priorReturnLines) {
    if (!r.originalBillItemId) continue
    alreadyReturned.set(
      r.originalBillItemId,
      roundQty((alreadyReturned.get(r.originalBillItemId) ?? 0) + Number(r.quantity))
    )
  }

  const reqByItem = new Map<string, number>()
  for (const r of args.returnItems) {
    const qty = roundQty(Number(r.quantity))
    if (!r.billItemId || !Number.isFinite(qty) || qty <= 0) {
      throw Object.assign(new Error('INVALID_RETURN_LINE'), { code: 'INVALID_RETURN_LINE' })
    }
    reqByItem.set(r.billItemId, (reqByItem.get(r.billItemId) ?? 0) + qty)
  }
  if (reqByItem.size === 0) throw Object.assign(new Error('NO_RETURN_LINES'), { code: 'NO_RETURN_LINES' })

  type FinalReturnLine = {
    originalItem: typeof original.items[number]
    quantity: number
    lineTotal: number
    lineGstAmount: number
    lineDiscountPct: number
    lineDiscountAmt: number
    billDiscountAmt: number
    taxableValue: number
    cgstAmount: number
    sgstAmount: number
    igstAmount: number
    /** Where the goods were put back, mirroring the sale's own split. */
    restockPlan: { batchId: string; quantity: number; unitCost: number }[]
  }
  const returnLines: FinalReturnLine[] = []

  for (const [billItemId, qty] of reqByItem) {
    const orig = original.items.find((i) => i.id === billItemId)
    if (!orig) {
      throw Object.assign(new Error('BILL_ITEM_NOT_IN_ORIGINAL'), { code: 'BILL_ITEM_NOT_IN_ORIGINAL', billItemId })
    }
    const remaining = roundQty(Number(orig.quantity) - (alreadyReturned.get(orig.id) ?? 0))
    if (qty > remaining) {
      throw Object.assign(new Error('RETURN_QTY_EXCEEDS_REMAINING'),
        { code: 'RETURN_QTY_EXCEEDS_REMAINING', billItemId, requested: qty, remaining })
    }

    const ratio = qty / Number(orig.quantity)
    returnLines.push({
      originalItem: orig,
      quantity: qty,
      lineTotal: round2(Number(orig.lineTotal) * ratio),
      lineDiscountPct: Number(orig.lineDiscountPct),
      lineDiscountAmt: round2(Number(orig.lineDiscountAmt) * ratio),
      // Tax is re-derived below from the refunded amount rather than pro-rated
      // from the original, so credit notes for bills written before the
      // tax-invoice fields existed still come out correct.
      lineGstAmount: 0,
      billDiscountAmt: 0,
      taxableValue: 0,
      cgstAmount: 0,
      sgstAmount: 0,
      igstAmount: 0,
      restockPlan: []
    })
  }

  // Goods that came back broken must not go back on the shelf — they would
  // only be sold again. The credit note still records the quantity, which is
  // what makes the loss visible in reporting.
  const restock = shouldRestock(args.reasonCode)

  if (restock) {
    for (const l of returnLines) {
      l.restockPlan = await planRestock(tx, l.originalItem.id, l.originalItem.productId, l.quantity)
      for (const put of l.restockPlan) {
        await tx.productBatch.update({
          where: { id: put.batchId },
          data: { currentQty: { increment: put.quantity } }
        })
      }
    }
  }

  const subtotal = round2(returnLines.reduce((s, l) => s + l.lineTotal, 0))
  const origSubtotal = Number(original.subtotal) || 0
  const origDiscount = Number(original.discountAmount) || 0
  const discountAmount = round2(origSubtotal > 0 ? origDiscount * (subtotal / origSubtotal) : 0)
  const { interState, placeOfSupply } = await resolveTaxContext(tx, original.customerId)

  // A credit note is calculated exactly like a sale, so it mirrors the invoice
  // it refunds. Tax is re-derived rather than pro-rated from the original,
  // which also fixes returns against bills written before these fields existed.
  const refundTotals = computeInvoiceTotals(
    returnLines.map((l) => ({
      lineTotal: l.lineTotal,
      gstPercentage: Number(l.originalItem.gstPercentage)
    })),
    discountAmount,
    interState
  )
  returnLines.forEach((l, i) => {
    const t = refundTotals.lines[i]
    l.billDiscountAmt = t.billDiscountAmt
    l.lineGstAmount = t.gstAmount
    l.taxableValue = t.taxableValue
    l.cgstAmount = t.cgstAmount
    l.sgstAmount = t.sgstAmount
    l.igstAmount = t.igstAmount
  })
  const { totalAmount, taxableValue, gstAmount, cgstAmount, sgstAmount, igstAmount } = refundTotals

  const created = await tx.bill.create({
    data: {
      billNumber: args.billNumber || (await allocateNumber(tx, 'CN')),
      status: 'RETURN',
      customerId: original.customerId,
      originDeviceId: args.originDeviceId,
      cashierId: args.cashierId,
      subtotal,
      gstAmount,
      discountAmount,
      totalAmount,
      taxableValue,
      cgstAmount,
      sgstAmount,
      igstAmount,
      placeOfSupply,
      paymentMethod: original.paymentMethod,
      amountReceived: null,
      changeGiven: null,
      notes: args.reason ? `Return: ${args.reason}` : 'Return',
      originalBillId: original.id,
      returnReason: args.reason || null,
      returnReasonCode: args.reasonCode || null,
      items: {
        create: returnLines.map((l) => ({
          productId: l.originalItem.productId,
          itemCode: l.originalItem.itemCode,
          productName: l.originalItem.productName,
          unitOfMeasure: l.originalItem.unitOfMeasure,
          // A credit note is filed against the same classification the sale
          // was, so it carries the code the original line carried.
          hsnCode: l.originalItem.hsnCode,
          quantity: l.quantity,
          unitRate: l.originalItem.unitRate,
          gstPercentage: l.originalItem.gstPercentage,
          lineDiscountPct: l.lineDiscountPct,
          lineDiscountAmt: l.lineDiscountAmt,
          lineGstAmount: l.lineGstAmount,
          lineTotal: l.lineTotal,
          billDiscountAmt: l.billDiscountAmt,
          taxableValue: l.taxableValue,
          cgstAmount: l.cgstAmount,
          sgstAmount: l.sgstAmount,
          igstAmount: l.igstAmount,
          originalBillItemId: l.originalItem.id,
          batchAllocations: { create: l.restockPlan }
        }))
      }
    },
    include: { customer: { select: { name: true, phone: true } }, items: true }
  })
  await emitBillUpsert(tx, created)
  await emitProductUpsertBulk(
    tx,
    returnLines.map((l) => l.originalItem.productId)
  )
  // Returning goods against an unsettled bill reduces what the customer owes
  // rather than handing back money they never paid.
  await recomputeBillSettlement(tx, original.id)
  return created
}
