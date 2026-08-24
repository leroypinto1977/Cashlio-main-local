import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth, requireActiveLicense } from '../http/middleware'
import { pageArgs } from '../http/respond'
import { serializePayment } from '../domain/serializers'
import { outstandingFor, lockBill, recomputeBillSettlement } from '../domain/billing'
import { emitCustomerUpsert, emitBillUpsert } from '../syncEvents'
import { round2 } from '../../shared/money'
import { isPaymentMethod, ageBucketOf, daysBetween, UNSETTLED_STATUSES } from '../../shared/credit'

/**
 * Money collected against outstanding bills, and who needs chasing.
 */
export const router = Router()

// ─── Phase 3B — Payments, receivables and follow-ups ──────────────────────────

/**
 * Records money collected against a customer's outstanding bills.
 *
 * Allocation defaults to oldest bill first, which is how a shop actually
 * settles an account. Callers can override it by naming bills explicitly.
 * It all runs in one transaction so a part-allocated payment can never be
 * left stranded.
 */
router.post('/api/v1/payments', requireActiveLicense(), requireAuth(), async (req, res) => {
  try {
    const { customerId, amount, method, reference, note, allocations, clientLocalId } = req.body

    if (!customerId) {
      return res.status(400).json({ success: false, error: 'CUSTOMER_REQUIRED' })
    }
    if (!isPaymentMethod(method)) {
      return res.status(400).json({ success: false, error: 'INVALID_PAYMENT_METHOD' })
    }
    const total = round2(Number(amount))
    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        success: false, error: 'INVALID_PAYMENT_AMOUNT',
        message: 'Enter an amount greater than zero.'
      })
    }

    if (clientLocalId) {
      const existing = await prisma.payment.findUnique({
        where: { clientLocalId: String(clientLocalId) }
      })
      if (existing) {
        return res.status(200).json({
          success: true, payments: [serializePayment(existing)], replayed: true
        })
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.findUnique({ where: { id: String(customerId) } })
      if (!customer) throw Object.assign(new Error('CUSTOMER_NOT_FOUND'), { code: 'CUSTOMER_NOT_FOUND' })

      const openBills = await tx.bill.findMany({
        where: { customerId: customer.id, status: { in: [...UNSETTLED_STATUSES] } },
        orderBy: { paidAt: 'asc' }
      })
      if (openBills.length === 0) {
        throw Object.assign(new Error('NOTHING_OUTSTANDING'), { code: 'NOTHING_OUTSTANDING' })
      }

      // Either honour the caller's allocation, or work forward from the oldest
      // bill taking as much as each one still needs.
      const plan: { billId: string; amount: number }[] = []
      if (Array.isArray(allocations) && allocations.length > 0) {
        for (const a of allocations) {
          const billId = String((a as { billId?: unknown }).billId ?? '')
          const amt = round2(Number((a as { amount?: unknown }).amount))
          const bill = openBills.find((b) => b.id === billId)
          if (!bill) {
            throw Object.assign(new Error('BILL_NOT_OUTSTANDING'), { code: 'BILL_NOT_OUTSTANDING', billId })
          }
          if (!Number.isFinite(amt) || amt <= 0) {
            throw Object.assign(new Error('INVALID_ALLOCATION'), { code: 'INVALID_ALLOCATION', billId })
          }
          // balanceDue is kept in step by recomputeBillSettlement, so it
          // already accounts for any credit notes against this bill.
          if (amt > round2(Number(bill.balanceDue))) {
            throw Object.assign(new Error('ALLOCATION_EXCEEDS_BALANCE'), {
              code: 'ALLOCATION_EXCEEDS_BALANCE', billId,
              balanceDue: round2(Number(bill.balanceDue)), requested: amt
            })
          }
          plan.push({ billId, amount: amt })
        }
        const planned = round2(plan.reduce((s, x) => s + x.amount, 0))
        if (planned !== total) {
          throw Object.assign(new Error('ALLOCATION_MISMATCH'), {
            code: 'ALLOCATION_MISMATCH', allocated: planned, amount: total
          })
        }
      } else {
        let left = total
        for (const bill of openBills) {
          if (left <= 0) break
          const due = round2(Number(bill.balanceDue))
          const take = round2(Math.min(due, left))
          if (take <= 0) continue
          plan.push({ billId: bill.id, amount: take })
          left = round2(left - take)
        }
        if (left > 0) {
          // Refusing beats parking money the shop cannot account for.
          throw Object.assign(new Error('AMOUNT_EXCEEDS_OUTSTANDING'), {
            code: 'AMOUNT_EXCEEDS_OUTSTANDING',
            outstanding: round2(total - left), amount: total, excess: left
          })
        }
      }

      // Lock every bill this collection touches, oldest first, before any of
      // it is applied. A consistent order means two concurrent collections
      // for the same customer queue rather than deadlock.
      for (const alloc of [...plan].sort((a, b) => a.billId.localeCompare(b.billId))) {
        await lockBill(tx, alloc.billId)
      }

      // Re-check every allocation against the balance as it stands now that
      // the rows are locked. The plan was built from a read taken before the
      // lock, and a concurrent collection may have settled some of it since.
      for (const alloc of plan) {
        const fresh = await tx.bill.findUniqueOrThrow({ where: { id: alloc.billId } })
        if (alloc.amount > round2(Number(fresh.balanceDue))) {
          throw Object.assign(new Error('ALLOCATION_EXCEEDS_BALANCE'), {
            code: 'ALLOCATION_EXCEEDS_BALANCE',
            billId: alloc.billId,
            balanceDue: round2(Number(fresh.balanceDue)),
            requested: alloc.amount
          })
        }
      }

      const created: unknown[] = []
      for (const [i, alloc] of plan.entries()) {
        const bill = await tx.bill.findUniqueOrThrow({ where: { id: alloc.billId } })
        const payment = await tx.payment.create({
          data: {
            billId: bill.id,
            customerId: customer.id,
            amount: alloc.amount,
            method,
            reference: reference ? String(reference).trim() : null,
            isSettlement: true,
            collectedById: req.user!.userId,
            note: note ? String(note).trim() : null,
            // Only the first row carries the key — the rest belong to the same
            // collection and are covered by this transaction.
            clientLocalId: i === 0 && clientLocalId ? String(clientLocalId) : null
          },
          include: { bill: { select: { billNumber: true, totalAmount: true } } }
        })

        // Settlement is recomputed from the rows that exist — payments and
        // credit notes — rather than derived here from the bill total. Doing
        // the arithmetic in two places meant this one forgot about returns,
        // so a customer who returned goods and then paid what they owed had
        // the value of the credit note reappear as a debt.
        await recomputeBillSettlement(tx, bill.id)
        const updated = await tx.bill.findUniqueOrThrow({
          where: { id: bill.id },
          include: { customer: { select: { name: true } }, items: true }
        })
        await emitBillUpsert(tx, updated)
        created.push(payment)
      }

      const outstanding = await outstandingFor(tx, customer.id)
      await emitCustomerUpsert(tx, customer.id)
      return { payments: created, outstanding }
    })

    return res.status(201).json({
      success: true,
      payments: result.payments.map(serializePayment),
      outstanding: result.outstanding
    })
  } catch (err: unknown) {
    const e = err as { code?: string }
    const map: Record<string, [number, string]> = {
      CUSTOMER_NOT_FOUND: [404, 'No such customer.'],
      NOTHING_OUTSTANDING: [409, 'This customer has nothing outstanding.'],
      BILL_NOT_OUTSTANDING: [409, 'That bill has no balance left to settle.'],
      INVALID_ALLOCATION: [400, 'Each allocation needs an amount greater than zero.'],
      ALLOCATION_EXCEEDS_BALANCE: [409, 'That is more than the bill still owes.'],
      ALLOCATION_MISMATCH: [400, 'The allocations do not add up to the amount collected.'],
      AMOUNT_EXCEEDS_OUTSTANDING: [409, 'That is more than this customer owes.']
    }
    if (e.code && map[e.code]) {
      const [status, message] = map[e.code]
      return res.status(status).json({ success: false, message, ...e, error: e.code })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/payments', requireAuth(), async (req, res) => {
  try {
    const { customerId, billId } = req.query
    const where = {
      customerId: customerId ? String(customerId) : undefined,
      billId: billId ? String(billId) : undefined
    }
    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: {
          bill: { select: { billNumber: true, totalAmount: true, status: true } },
          customer: { select: { name: true, phone: true } },
          collectedBy: { select: { username: true } }
        },
        orderBy: { receivedAt: 'desc' },
        ...pageArgs(req.query)
      }),
      prisma.payment.count({ where })
    ])
    return res.json({ success: true, payments: payments.map(serializePayment), total })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** A customer's open bills with their ageing, plus their credit headroom. */
router.get('/api/v1/customers/:id/outstanding', requireAuth(), async (req, res) => {
  try {
    const id = String(req.params.id)
    const customer = await prisma.customer.findUnique({ where: { id } })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const bills = await prisma.bill.findMany({
      where: { customerId: id, status: { in: [...UNSETTLED_STATUSES] } },
      orderBy: { paidAt: 'asc' },
      select: {
        id: true, billNumber: true, status: true, paidAt: true, dueDate: true,
        totalAmount: true, paidAmount: true, balanceDue: true
      }
    })

    const now = new Date()
    const open = bills.map((b) => ({
      ...b,
      totalAmount: Number(b.totalAmount),
      paidAmount: Number(b.paidAmount),
      balanceDue: Number(b.balanceDue),
      ageBucket: ageBucketOf(b.dueDate, b.paidAt, now),
      daysOverdue: Math.max(0, daysBetween(b.dueDate ?? b.paidAt, now))
    }))
    const outstanding = round2(open.reduce((s, b) => s + b.balanceDue, 0))
    const creditLimit = Number(customer.creditLimit)

    return res.json({
      success: true,
      customer: {
        id: customer.id, name: customer.name, phone: customer.phone,
        creditLimit, creditDays: customer.creditDays
      },
      outstanding,
      availableCredit: round2(Math.max(0, creditLimit - outstanding)),
      overLimit: outstanding > creditLimit,
      bills: open
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** Everyone who owes money, worst first, with ageing totals for the shop. */
router.get('/api/v1/receivables', requireAuth(), async (_req, res) => {
  try {
    const bills = await prisma.bill.findMany({
      where: { status: { in: [...UNSETTLED_STATUSES] }, customerId: { not: null } },
      select: {
        id: true, billNumber: true, customerId: true, paidAt: true, dueDate: true,
        balanceDue: true, totalAmount: true,
        customer: { select: { id: true, name: true, phone: true, creditLimit: true } }
      }
    })

    const now = new Date()
    type Row = {
      customerId: string; name: string; phone: string; creditLimit: number
      outstanding: number; billCount: number; oldestDays: number
      buckets: Record<string, number>
    }
    const byCustomer = new Map<string, Row>()
    const totals: Record<string, number> = { current: 0, '0-30': 0, '31-60': 0, '60+': 0 }

    for (const b of bills) {
      if (!b.customer) continue
      const bucket = ageBucketOf(b.dueDate, b.paidAt, now)
      const balance = Number(b.balanceDue)
      const age = Math.max(0, daysBetween(b.dueDate ?? b.paidAt, now))

      totals[bucket] = round2((totals[bucket] ?? 0) + balance)
      const row: Row = byCustomer.get(b.customer.id) ?? {
        customerId: b.customer.id, name: b.customer.name, phone: b.customer.phone,
        creditLimit: Number(b.customer.creditLimit),
        outstanding: 0, billCount: 0, oldestDays: 0,
        buckets: { current: 0, '0-30': 0, '31-60': 0, '60+': 0 }
      }
      row.outstanding = round2(row.outstanding + balance)
      row.billCount += 1
      row.oldestDays = Math.max(row.oldestDays, age)
      row.buckets[bucket] = round2((row.buckets[bucket] ?? 0) + balance)
      byCustomer.set(b.customer.id, row)
    }

    const customers = [...byCustomer.values()].sort((a, b) => b.outstanding - a.outstanding)
    return res.json({
      success: true,
      totalOutstanding: round2(customers.reduce((s, c) => s + c.outstanding, 0)),
      buckets: totals,
      customers
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Follow-ups ───────────────────────────────────────────────────────────────

router.get('/api/v1/followups', requireAuth(), async (req, res) => {
  try {
    const { customerId, open } = req.query
    const followUps = await prisma.customerFollowUp.findMany({
      where: {
        customerId: customerId ? String(customerId) : undefined,
        resolvedAt: open === '1' ? null : undefined
      },
      include: {
        customer: { select: { id: true, name: true, phone: true } },
        createdBy: { select: { username: true } }
      },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }]
    })
    return res.json({ success: true, followUps })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/customers/:id/followups', requireAuth(), async (req, res) => {
  try {
    const customerId = String(req.params.id)
    const note = String(req.body?.note ?? '').trim()
    if (!note) {
      return res.status(400).json({
        success: false, error: 'NOTE_REQUIRED', message: 'Write what needs following up.'
      })
    }
    const customer = await prisma.customer.findUnique({ where: { id: customerId } })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const followUp = await prisma.customerFollowUp.create({
      data: {
        customerId,
        note,
        dueAt: req.body?.dueAt ? new Date(req.body.dueAt) : null,
        createdById: req.user!.userId
      },
      include: { createdBy: { select: { username: true } } }
    })
    return res.status(201).json({ success: true, followUp })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.put('/api/v1/followups/:id', requireAuth(), async (req, res) => {
  try {
    const data: Record<string, unknown> = {}
    if (req.body?.note !== undefined) {
      const note = String(req.body.note).trim()
      if (!note) return res.status(400).json({ success: false, error: 'NOTE_REQUIRED' })
      data.note = note
    }
    if (req.body?.dueAt !== undefined) {
      data.dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null
    }
    if (req.body?.resolved !== undefined) {
      data.resolvedAt = req.body.resolved ? new Date() : null
    }
    const followUp = await prisma.customerFollowUp.update({
      where: { id: String(req.params.id) },
      data,
      include: { createdBy: { select: { username: true } } }
    })
    return res.json({ success: true, followUp })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
