/**
 * Turning database rows into the shapes the apps expect.
 *
 * Prisma hands back Decimal objects, which serialise to JSON as strings and
 * then quietly become string concatenation the moment anything adds them up.
 * Every number a client sees passes through here and comes out a number.
 */
import { round2 } from '../../shared/money'
import { roundQty } from '../../shared/units'
import { effectiveStatus, daysUntilExpiry } from '../../shared/warranty'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function serializeBillItem(it: any): any {
  return {
    ...it,
    quantity: Number(it.quantity),
    unitRate: Number(it.unitRate),
    gstPercentage: Number(it.gstPercentage),
    lineDiscountPct: Number(it.lineDiscountPct),
    lineDiscountAmt: Number(it.lineDiscountAmt),
    lineGstAmount: Number(it.lineGstAmount),
    lineTotal: Number(it.lineTotal),
    billDiscountAmt: Number(it.billDiscountAmt ?? 0),
    taxableValue: Number(it.taxableValue ?? 0),
    cgstAmount: Number(it.cgstAmount ?? 0),
    sgstAmount: Number(it.sgstAmount ?? 0),
    igstAmount: Number(it.igstAmount ?? 0)
  }
}

/** Single place that turns Prisma Decimals into JSON numbers for a bill. */
export function serializeBill(b: any): any {
  return {
    ...b,
    subtotal: Number(b.subtotal),
    gstAmount: Number(b.gstAmount),
    discountAmount: Number(b.discountAmount),
    totalAmount: Number(b.totalAmount),
    taxableValue: Number(b.taxableValue ?? 0),
    cgstAmount: Number(b.cgstAmount ?? 0),
    sgstAmount: Number(b.sgstAmount ?? 0),
    igstAmount: Number(b.igstAmount ?? 0),
    paidAmount: Number(b.paidAmount ?? 0),
    balanceDue: Number(b.balanceDue ?? 0),
    amountReceived: b.amountReceived != null ? Number(b.amountReceived) : null,
    changeGiven: b.changeGiven != null ? Number(b.changeGiven) : null,
    ...(Array.isArray(b.items) ? { items: b.items.map(serializeBillItem) } : {})
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Batch rows carry three Decimal money columns and two Decimal quantities. */
export function serializeBatch(b: any): any {
  return {
    ...b,
    purchaseRate: Number(b.purchaseRate),
    purchaseGstPct: Number(b.purchaseGstPct ?? 0),
    purchaseGstAmount: Number(b.purchaseGstAmount ?? 0),
    purchaseRateInclGst: Number(b.purchaseRateInclGst ?? 0),
    receivedQty: Number(b.receivedQty),
    currentQty: Number(b.currentQty)
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function serializePayment(p: any): any {
  return {
    ...p,
    amount: Number(p.amount),
    ...(p.bill ? { bill: { ...p.bill, totalAmount: Number(p.bill.totalAmount) } } : {})
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
export function serializePurchaseOrder(po: any): any {
  const items = (po.items ?? []).map((i: any) => ({
    ...i,
    orderedQty: Number(i.orderedQty),
    receivedQty: Number(i.receivedQty),
    pendingQty: roundQty(Number(i.orderedQty) - Number(i.receivedQty)),
    expectedRate: Number(i.expectedRate),
    gstPercentage: Number(i.gstPercentage),
    lineTotal: round2(Number(i.orderedQty) * Number(i.expectedRate))
  }))
  return {
    ...po,
    items,
    itemCount: items.length,
    orderTotal: round2(items.reduce((s: number, i: any) => s + i.lineTotal, 0))
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export const WARRANTY_INCLUDE = {
  product: { select: { itemCode: true, name: true, unitOfMeasure: true, warrantyPeriodDays: true } },
  bill: { select: { billNumber: true, paidAt: true, status: true } },
  billItem: { select: { quantity: true, unitRate: true, lineTotal: true } },
  customer: { select: { id: true, name: true, phone: true } },
  claimedBy: { select: { username: true } },
  resolvedBy: { select: { username: true } }
} as const

/* eslint-disable @typescript-eslint/no-explicit-any */
export function serializeWarranty(w: any, now = new Date()): any {
  return {
    ...w,
    status: effectiveStatus(w.status, w.expiryDate, now),
    storedStatus: w.status,
    daysUntilExpiry: daysUntilExpiry(w.expiryDate, now),
    billItem: w.billItem
      ? {
          quantity: Number(w.billItem.quantity),
          unitRate: Number(w.billItem.unitRate),
          lineTotal: Number(w.billItem.lineTotal)
        }
      : undefined
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
