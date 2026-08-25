import { validateBarcode } from '../../shared/validation'

/**
 * The codes a product can be scanned by.
 *
 * A product's barcodes are edited as a set — the screen shows a list, and what
 * comes back is the list as it should now be. Reconciling that against what is
 * stored keeps the rows that survived, so a code's id and the day it was added
 * are not churned every time the product is saved for an unrelated reason.
 */

type TxClient = {
  productBarcode: { findMany: Function; deleteMany: Function; createMany: Function; updateMany: Function; update: Function }
  product: { findMany: Function }
}

export type PlannedBarcode = { code: string; isPrimary: boolean }

export type BarcodePlan =
  | { ok: true; codes: PlannedBarcode[] }
  | { ok: false; error: string; message: string }

/** Longest list a product can carry. Past this it is two products. */
export const MAX_BARCODES_PER_PRODUCT = 12

/**
 * Validates a submitted barcode list and settles which code is the primary.
 *
 * Accepts either bare strings or `{ code, isPrimary }`, because the till sends
 * the first form when it adds a code it just scanned and the product screen
 * sends the second.
 */
export function planBarcodes(raw: unknown): BarcodePlan {
  if (raw == null) return { ok: true, codes: [] }
  if (!Array.isArray(raw)) {
    return { ok: false, error: 'BARCODES_NOT_A_LIST', message: 'Barcodes must be sent as a list.' }
  }
  if (raw.length > MAX_BARCODES_PER_PRODUCT) {
    return {
      ok: false,
      error: 'TOO_MANY_BARCODES',
      message: `A product can carry at most ${MAX_BARCODES_PER_PRODUCT} barcodes. More than that usually means these are separate products.`
    }
  }

  const codes: PlannedBarcode[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const isObject = entry != null && typeof entry === 'object'
    const rawCode = isObject ? (entry as { code?: unknown }).code : entry
    const check = validateBarcode(String(rawCode ?? ''))
    if (!check.ok) return { ok: false, error: check.error, message: check.message }

    // A code repeated in the same submission is a slip, not a conflict — the
    // scanner fired twice, or a row was pasted. Saying so beats a unique-index
    // error that names a row the person cannot see.
    if (seen.has(check.value)) {
      return {
        ok: false,
        error: 'BARCODE_REPEATED',
        message: `${check.value} is in the list twice.`
      }
    }
    seen.add(check.value)
    codes.push({
      code: check.value,
      isPrimary: isObject ? (entry as { isPrimary?: unknown }).isPrimary === true : false
    })
  }

  // Exactly one primary, always. Nothing flagged means the first one leads,
  // which is the order they were entered in.
  const flagged = codes.filter((c) => c.isPrimary)
  if (flagged.length !== 1 && codes.length > 0) {
    for (const c of codes) c.isPrimary = false
    ;(flagged[0] ?? codes[0]).isPrimary = true
  }
  return { ok: true, codes }
}

export type BarcodeConflict = {
  code: string
  productId: string
  itemCode: string
  name: string
}

/**
 * Replaces a product's barcodes with the planned set.
 *
 * Returns the conflicting code if one of them already belongs to a different
 * product — named, because "that barcode is taken" without saying by what
 * leaves somebody searching the catalogue by hand.
 */
export async function applyBarcodes(
  tx: TxClient,
  productId: string,
  codes: PlannedBarcode[]
): Promise<{ ok: true } | { ok: false; conflict: BarcodeConflict }> {
  if (codes.length > 0) {
    const clashes = await tx.product.findMany({
      where: {
        id: { not: productId },
        barcodes: { some: { code: { in: codes.map((c) => c.code) } } }
      },
      select: {
        id: true,
        itemCode: true,
        name: true,
        barcodes: { select: { code: true } }
      }
    })
    for (const other of clashes) {
      const taken = other.barcodes.find((b: { code: string }) =>
        codes.some((c) => c.code === b.code)
      )
      if (taken) {
        return {
          ok: false,
          conflict: { code: taken.code, productId: other.id, itemCode: other.itemCode, name: other.name }
        }
      }
    }
  }

  const existing = await tx.productBarcode.findMany({ where: { productId } })
  const wanted = new Map(codes.map((c) => [c.code, c]))
  const gone = existing.filter((e: { code: string }) => !wanted.has(e.code))
  if (gone.length > 0) {
    await tx.productBarcode.deleteMany({ where: { id: { in: gone.map((g: { id: string }) => g.id) } } })
  }

  // Clear the primary flag before setting the new one: the partial unique
  // index allows one per product, and moving the flag between two existing
  // rows would otherwise collide half-way through.
  await tx.productBarcode.updateMany({ where: { productId, isPrimary: true }, data: { isPrimary: false } })

  const kept = new Map(existing.map((e: { code: string; id: string }) => [e.code, e]))
  const fresh = codes.filter((c) => !kept.has(c.code))
  if (fresh.length > 0) {
    await tx.productBarcode.createMany({
      data: fresh.map((c) => ({ productId, code: c.code, isPrimary: false }))
    })
  }
  const primary = codes.find((c) => c.isPrimary)
  if (primary) {
    await tx.productBarcode.updateMany({
      where: { productId, code: primary.code },
      data: { isPrimary: true }
    })
  }
  return { ok: true }
}
