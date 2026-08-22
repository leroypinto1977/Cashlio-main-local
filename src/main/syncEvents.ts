// Sync-event log helpers (Phase 3D bidirectional sync).
//
// Every write to a synced entity (product, customer, bill) must call one of
// these helpers inside the same Prisma transaction so terminals see a
// consistent stream of changes.

import { Prisma } from '@prisma/client'
import { roundQty } from '../shared/units'

type TxClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

export type SyncEntity = 'product' | 'customer' | 'bill'
export type SyncOp = 'upsert' | 'delete'

export type ProductSyncRow = {
  id: string
  itemCode: string
  brand: string | null
  name: string
  specification: string | null
  categoryId: string
  productType: string | null
  unitOfMeasure: string
  /** 'UNIT' | 'LENGTH' — terminals use it to decide fractional quantity entry. */
  sellMode: string
  sellingRate: number
  gstPercentage: number
  warrantyPeriodDays: number
  minStockLevel: number
  isActive: boolean
  totalStock: number
}

export type CustomerSyncRow = {
  id: string
  name: string
  phone: string
  email: string | null
  address: string | null
  gstin: string | null
  isActive: boolean
  creditLimit: number
  creditDays: number
  /** What the customer owed at the moment this event was written. Terminals
   *  show it as "as of last sync" — it is a hint, not an authority. */
  outstanding: number
}

export type BillSyncRow = {
  id: string
  billNumber: string
  status: string
  totalAmount: number
  paidAt: string
  customerId: string | null
  originDeviceId: string
  cashierId: string
}

/** Insert a sync_event row inside a tx. Throws on db error — never swallow. */
export async function recordSync(
  tx: TxClient,
  entity: SyncEntity,
  entityId: string,
  op: SyncOp,
  payload: unknown
): Promise<void> {
  await tx.syncEvent.create({
    data: {
      entity,
      entityId,
      op,
      payload:
        op === 'delete' ? Prisma.JsonNull : (payload as Prisma.InputJsonValue)
    }
  })
}

/** Build a product sync payload by reading the row + summing stock. */
export async function buildProductSyncPayload(
  tx: TxClient,
  productId: string
): Promise<ProductSyncRow | null> {
  const p = await tx.product.findUnique({ where: { id: productId } })
  if (!p) return null
  const agg = await tx.productBatch.aggregate({
    where: { productId, isActive: true, currentQty: { gt: 0 } },
    _sum: { currentQty: true }
  })
  return {
    id: p.id,
    itemCode: p.itemCode,
    brand: p.brand,
    name: p.name,
    specification: p.specification,
    categoryId: p.categoryId,
    productType: p.productType,
    unitOfMeasure: p.unitOfMeasure,
    sellMode: p.sellMode,
    sellingRate: Number(p.sellingRate),
    gstPercentage: Number(p.gstPercentage),
    warrantyPeriodDays: p.warrantyPeriodDays,
    minStockLevel: Number(p.minStockLevel),
    isActive: p.isActive,
    totalStock: roundQty(Number(agg._sum.currentQty ?? 0))
  }
}

/** Convenience: build payload + record event in one call. */
export async function emitProductUpsert(tx: TxClient, productId: string): Promise<void> {
  const payload = await buildProductSyncPayload(tx, productId)
  if (!payload) return
  await recordSync(tx, 'product', productId, 'upsert', payload)
}

/** Emit one product upsert per id, deduplicating. Use after batch ops. */
export async function emitProductUpsertBulk(
  tx: TxClient,
  productIds: string[]
): Promise<void> {
  const unique = Array.from(new Set(productIds))
  for (const id of unique) {
    await emitProductUpsert(tx, id)
  }
}

export function customerToSyncRow(c: {
  id: string
  name: string
  phone: string
  email: string | null
  address: string | null
  gstin: string | null
  isActive: boolean
  creditLimit?: unknown
  creditDays?: number
}, outstanding = 0): CustomerSyncRow {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    gstin: c.gstin,
    isActive: c.isActive,
    creditLimit: Number(c.creditLimit ?? 0),
    creditDays: Number(c.creditDays ?? 0),
    outstanding
  }
}

export async function emitCustomerUpsert(
  tx: TxClient,
  customerId: string
): Promise<void> {
  const c = await tx.customer.findUnique({ where: { id: customerId } })
  if (!c) return
  // Outstanding is derived from unsettled bills rather than stored, so it is
  // summed here at the moment the event is written.
  const agg = await tx.bill.aggregate({
    where: { customerId, status: { in: ['PARTIAL', 'CREDIT'] } },
    _sum: { balanceDue: true }
  })
  const outstanding = Math.round((Number(agg._sum.balanceDue ?? 0) + Number.EPSILON) * 100) / 100
  await recordSync(tx, 'customer', customerId, 'upsert', customerToSyncRow(c, outstanding))
}

export async function emitBillUpsert(
  tx: TxClient,
  bill: {
    id: string
    billNumber: string
    status: string
    totalAmount: number | { toString(): string }
    paidAt: Date
    customerId: string | null
    originDeviceId: string
    cashierId: string
  }
): Promise<void> {
  const payload: BillSyncRow = {
    id: bill.id,
    billNumber: bill.billNumber,
    status: bill.status,
    totalAmount: Number(bill.totalAmount),
    paidAt: bill.paidAt.toISOString(),
    customerId: bill.customerId,
    originDeviceId: bill.originDeviceId,
    cashierId: bill.cashierId
  }
  await recordSync(tx, 'bill', bill.id, 'upsert', payload)
}
