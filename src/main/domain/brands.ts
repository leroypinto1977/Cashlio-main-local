/**
 * Brands are a controlled list, so a product can name one by id or by a name
 * that must already exist. Accepting free text here is what let "Finolex" and
 * "FINOLEX" become two brands nobody could filter by.
 */
import type { TxClient } from './db'

export type BrandResolution =
  | { kind: 'unchanged' }
  | { kind: 'cleared' }
  | { kind: 'resolved'; brandId: string; brand: string }
  | { kind: 'not-found' }

export async function resolveBrand(
  tx: TxClient,
  input: { brandId?: unknown; brand?: unknown }
): Promise<BrandResolution> {
  if (input.brandId === null || input.brand === null) return { kind: 'cleared' }

  if (typeof input.brandId === 'string' && input.brandId.trim()) {
    const found = await tx.brand.findUnique({ where: { id: input.brandId.trim() } })
    return found
      ? { kind: 'resolved', brandId: found.id, brand: found.name }
      : { kind: 'not-found' }
  }

  if (typeof input.brand === 'string') {
    const name = input.brand.trim()
    if (!name) return { kind: 'cleared' }
    const existing = await tx.brand.findUnique({ where: { name } })
    const brand = existing ?? (await tx.brand.create({ data: { name } }))
    return { kind: 'resolved', brandId: brand.id, brand: brand.name }
  }

  return { kind: 'unchanged' }
}

/** Turns a resolution into the fields to write, or null when nothing changes. */
export function brandFields(r: BrandResolution): { brandId: string | null; brand: string | null } | null {
  if (r.kind === 'cleared') return { brandId: null, brand: null }
  if (r.kind === 'resolved') return { brandId: r.brandId, brand: r.brand }
  return null
}
