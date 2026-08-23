/**
 * Returns and procurement vocabulary, shared by the branch server, the manager
 * UI and the terminal so all three agree on the codes they store and show.
 */

// ─── Return reasons ───────────────────────────────────────────────────────────

export type ReturnReasonCode =
  | 'DAMAGED'
  | 'DEFECTIVE'
  | 'WRONG_ITEM'
  | 'NOT_AS_DESCRIBED'
  | 'EXCESS'
  | 'CHANGED_MIND'
  | 'OTHER'

/**
 * A fixed list rather than free text, so returns can actually be reported on —
 * "how much are we losing to defective stock?" is unanswerable if every
 * cashier phrases it differently. `OTHER` keeps the escape hatch, and the note
 * on the credit note carries the detail either way.
 */
export const RETURN_REASONS: readonly { code: ReturnReasonCode; label: string; hint?: string }[] = [
  { code: 'DAMAGED', label: 'Damaged in transit', hint: 'Arrived broken or dented' },
  { code: 'DEFECTIVE', label: 'Faulty / not working' },
  { code: 'WRONG_ITEM', label: 'Wrong item supplied' },
  { code: 'NOT_AS_DESCRIBED', label: 'Not as described' },
  { code: 'EXCESS', label: 'Over-supplied', hint: 'More was billed than taken' },
  { code: 'CHANGED_MIND', label: 'Customer changed their mind' },
  { code: 'OTHER', label: 'Other' }
]

export function isReturnReasonCode(v: unknown): v is ReturnReasonCode {
  return typeof v === 'string' && RETURN_REASONS.some((r) => r.code === v)
}

export function returnReasonLabel(code: string | null | undefined): string {
  return RETURN_REASONS.find((r) => r.code === code)?.label ?? 'Not recorded'
}

/** Reasons that mean the goods came back unsellable. */
export const UNSELLABLE_REASONS: readonly ReturnReasonCode[] = ['DAMAGED', 'DEFECTIVE']

/**
 * Whether returned goods should go back on the shelf.
 *
 * Broken stock put back into a batch would be sold again, so those returns
 * refund the customer without restocking. The credit note still records the
 * quantity, which is what makes the loss visible.
 */
export function shouldRestock(code: string | null | undefined): boolean {
  return !UNSELLABLE_REASONS.includes(code as ReturnReasonCode)
}

// ─── Purchase orders ──────────────────────────────────────────────────────────

export type PurchaseOrderStatus = 'DRAFT' | 'PLACED' | 'PARTIAL' | 'RECEIVED' | 'CANCELLED'

export const PO_STATUSES: readonly PurchaseOrderStatus[] =
  ['DRAFT', 'PLACED', 'PARTIAL', 'RECEIVED', 'CANCELLED']

export const PO_STATUS_LABEL: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'Draft',
  PLACED: 'Placed',
  PARTIAL: 'Part received',
  RECEIVED: 'Received',
  CANCELLED: 'Cancelled'
}

export function isPurchaseOrderStatus(v: unknown): v is PurchaseOrderStatus {
  return typeof v === 'string' && (PO_STATUSES as readonly string[]).includes(v)
}

/** An order can only be edited while it is still a draft. */
export function isEditable(status: string): boolean {
  return status === 'DRAFT'
}

/** Goods can only arrive against an order that has actually been placed. */
export function canReceive(status: string): boolean {
  return status === 'PLACED' || status === 'PARTIAL'
}

export function canCancel(status: string): boolean {
  return status === 'DRAFT' || status === 'PLACED'
}

/**
 * Status implied by how much of an order has arrived. Receiving more than was
 * ordered still completes it — suppliers over-ship, and refusing to record
 * what physically arrived would leave the stock count wrong.
 */
export function statusAfterReceipt(
  lines: { orderedQty: number; receivedQty: number }[]
): 'PARTIAL' | 'RECEIVED' {
  const complete = lines.every((l) => l.receivedQty >= l.orderedQty)
  return complete ? 'RECEIVED' : 'PARTIAL'
}

/** How short an order still is, line by line. */
export function outstandingLines<T extends { orderedQty: number; receivedQty: number }>(
  lines: T[]
): (T & { pendingQty: number })[] {
  return lines
    .map((l) => ({ ...l, pendingQty: Math.max(0, l.orderedQty - l.receivedQty) }))
    .filter((l) => l.pendingQty > 0)
}
