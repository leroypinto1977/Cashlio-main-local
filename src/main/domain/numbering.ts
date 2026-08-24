import { prisma } from '../prisma'
import { currentPeriod } from './dates'
import type { DbClient } from './db'

/**
 * Document-number series. `INV` for sales, `CN` for credit notes (returns),
 * `BT` for stock batches — deliberately distinct prefixes so a bill number can
 * never be mistaken for a batch code. Series reset each IST calendar month.
 */
export type Series = 'INV' | 'CN' | 'BT' | 'PO'

/**
 * Atomically claims the next number in a series.
 *
 * This is a single INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so two
 * concurrent bills can never be handed the same value. (The previous scheme
 * counted existing rows for the month, which collided as soon as a bill was
 * voided or a second terminal billed at the same moment.)
 *
 * Call it inside the same transaction as the row it numbers: if the write
 * rolls back, the number is released with it.
 */
export async function allocateNumber(db: DbClient, series: Series, width = 4): Promise<string> {
  const period = currentPeriod()
  const rows = await db.$queryRaw<Array<{ lastValue: number }>>`
    INSERT INTO "NumberSeries" ("series", "period", "lastValue", "updatedAt")
    VALUES (${series}, ${period}, 1, NOW())
    ON CONFLICT ("series", "period")
    DO UPDATE SET "lastValue" = "NumberSeries"."lastValue" + 1, "updatedAt" = NOW()
    RETURNING "lastValue"
  `
  const seq = Number(rows[0].lastValue)
  return `${series}-${period}-${String(seq).padStart(width, '0')}`
}

/** Read-only preview of the next number. Does NOT consume it. */
export async function peekNumber(series: Series, width = 4): Promise<string> {
  const period = currentPeriod()
  const row = await prisma.numberSeries.findUnique({
    where: { series_period: { series, period } }
  })
  const next = (row?.lastValue ?? 0) + 1
  return `${series}-${period}-${String(next).padStart(width, '0')}`
}
