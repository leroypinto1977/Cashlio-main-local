/**
 * Idempotent data backfill for the Pass 3 (credit billing) schema.
 *
 * Every bill written before settlement tracking existed was paid in full at
 * the counter, so each one is marked fully settled and given the Payment row
 * that records the tender. Void bills and credit notes carry no payment.
 *
 * Safe to run repeatedly — bills that already have a payment are skipped.
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

async function backfillSettlement() {
  const bills = await prisma.bill.findMany({
    where: { payments: { none: {} } },
    select: {
      id: true, status: true, totalAmount: true, paymentMethod: true,
      cashierId: true, customerId: true, paidAt: true, paidAmount: true
    }
  })

  let settled = 0
  let skipped = 0
  for (const bill of bills) {
    const total = round2(Number(bill.totalAmount))

    // Voids and credit notes were never collected against.
    if (bill.status === 'VOID' || bill.status === 'RETURN') {
      await prisma.bill.update({
        where: { id: bill.id },
        data: { paidAmount: 0, balanceDue: 0 }
      })
      skipped++
      continue
    }

    await prisma.$transaction([
      prisma.bill.update({
        where: { id: bill.id },
        data: { paidAmount: total, balanceDue: 0, status: 'PAID' }
      }),
      prisma.payment.create({
        data: {
          billId: bill.id,
          customerId: bill.customerId,
          amount: total,
          method: bill.paymentMethod || 'CASH',
          isSettlement: false,
          receivedAt: bill.paidAt,
          collectedById: bill.cashierId,
          note: 'Recorded from bill history'
        }
      })
    ])
    settled++
  }
  return { settled, skipped }
}

;(async () => {
  const r = await backfillSettlement()
  console.log(`bills: ${r.settled} marked settled with a payment row, ${r.skipped} void/credit-note left at zero`)
  await prisma.$disconnect()
})().catch(async (e) => {
  console.error(e)
  await prisma.$disconnect()
  process.exit(1)
})
