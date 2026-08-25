import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { pageArgs, MAX_PAGE } from '../http/respond'
import {
  isExpenseKind,
  parseExpense,
  serializeExpense,
  totalByCategory,
  totalExpenses
} from '../domain/expenses'
import { businessDateFor, businessDateKey, parseBusinessDate } from '../domain/dayClose'
import { validateName } from '../../shared/validation'

/**
 * Expenses, and what they are spent on.
 *
 * Manager-only throughout. What the shop pays in rent and wages is not a
 * cashier's business, and the till has no use for it.
 */
export const router = Router()

// ─── Categories ──────────────────────────────────────────────────────────────

router.get('/api/v1/expense-categories', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const includeRetired = String(req.query.includeRetired ?? '') === 'true'
    const categories = await prisma.expenseCategory.findMany({
      where: includeRetired ? undefined : { isActive: true },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { expenses: true } } }
    })
    return res.json({
      success: true,
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
        isActive: c.isActive,
        expenseCount: c._count.expenses
      }))
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/expense-categories', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const nameCheck = validateName(String(req.body?.name ?? ''), 'Category name')
    if (!nameCheck.ok) {
      return res.status(400).json({ success: false, error: nameCheck.error, message: nameCheck.message })
    }
    const kind = isExpenseKind(req.body?.kind) ? String(req.body.kind) : 'FIXED'
    const created = await prisma.expenseCategory.create({ data: { name: nameCheck.value, kind } })
    return res.status(201).json({ success: true, category: created })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'CATEGORY_EXISTS',
        message: 'There is already a category with that name.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Retires a category, or brings it back. Never deletes: last year's expenses
 * still point at it, and a total that loses its label is worse than one
 * labelled with something the shop no longer spends on.
 */
router.put('/api/v1/expense-categories/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const data: { name?: string; kind?: string; isActive?: boolean } = {}
    if (req.body?.name !== undefined) {
      const nameCheck = validateName(String(req.body.name), 'Category name')
      if (!nameCheck.ok) {
        return res.status(400).json({ success: false, error: nameCheck.error, message: nameCheck.message })
      }
      data.name = nameCheck.value
    }
    if (isExpenseKind(req.body?.kind)) data.kind = String(req.body.kind)
    if (typeof req.body?.isActive === 'boolean') data.isActive = req.body.isActive

    const updated = await prisma.expenseCategory.update({ where: { id: String(req.params.id) }, data })
    return res.json({ success: true, category: updated })
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'P2025') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (code === 'P2002') {
      return res.status(409).json({
        success: false,
        error: 'CATEGORY_EXISTS',
        message: 'There is already a category with that name.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

// ─── Expenses ────────────────────────────────────────────────────────────────

/** Resolves ?from= / ?to= into a range of business dates. */
function readRange(query: Record<string, unknown>): { from: Date; to: Date } | null {
  const to = query.to === undefined ? businessDateFor() : parseBusinessDate(query.to)
  if (!to) return null
  // A month back by default: long enough to see the pattern, short enough to
  // load instantly on a shop's own machine.
  const from =
    query.from === undefined
      ? new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000)
      : parseBusinessDate(query.from)
  if (!from) return null
  return { from, to }
}

router.get('/api/v1/expenses', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const range = readRange(req.query as Record<string, unknown>)
    if (!range) {
      return res.status(400).json({ success: false, error: 'BAD_DATE', message: 'Give dates as YYYY-MM-DD.' })
    }
    const page = pageArgs(req.query, MAX_PAGE)
    const where = {
      paidOn: { gte: range.from, lte: range.to },
      ...(req.query.categoryId ? { categoryId: String(req.query.categoryId) } : {})
    }

    const [total, rows] = await Promise.all([
      prisma.expense.count({ where }),
      prisma.expense.findMany({
        where,
        include: { category: true, recordedBy: { select: { username: true } } },
        orderBy: [{ paidOn: 'desc' }, { createdAt: 'desc' }],
        ...page
      })
    ])
    const expenses = rows.map(serializeExpense)
    return res.json({
      success: true,
      expenses,
      total,
      from: businessDateKey(range.from),
      to: businessDateKey(range.to),
      // Totals for the page shown, and for the whole range — the second is the
      // one that means anything, and computing it from a page would be wrong.
      pageTotals: totalExpenses(expenses)
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/** The range totalled and broken down, whatever the paging. */
router.get('/api/v1/expenses/summary', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const range = readRange(req.query as Record<string, unknown>)
    if (!range) {
      return res.status(400).json({ success: false, error: 'BAD_DATE', message: 'Give dates as YYYY-MM-DD.' })
    }
    const rows = await prisma.expense.findMany({
      where: { paidOn: { gte: range.from, lte: range.to } },
      include: { category: true }
    })
    const expenses = rows.map((r) => serializeExpense({ ...r, recordedBy: null }))
    return res.json({
      success: true,
      from: businessDateKey(range.from),
      to: businessDateKey(range.to),
      totals: totalExpenses(expenses),
      byCategory: totalByCategory(expenses)
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

/**
 * Monthly costs that have not been entered for a month yet.
 *
 * Nothing is created automatically: an expense nobody entered is an expense
 * nobody checked, and a rent figure that quietly repeats itself after the rent
 * went up is worse than a missing one. This only points at the gap.
 */
router.get('/api/v1/expenses/recurring-due', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const anchor = req.query.month === undefined ? businessDateFor() : parseBusinessDate(String(req.query.month))
    if (!anchor) {
      return res.status(400).json({ success: false, error: 'BAD_DATE', message: 'Give the month as YYYY-MM-DD.' })
    }
    const y = anchor.getUTCFullYear()
    const m = anchor.getUTCMonth()
    const monthStart = new Date(Date.UTC(y, m, 1))
    const monthEnd = new Date(Date.UTC(y, m + 1, 0))

    // The last time each recurring cost was recorded, and what it came to.
    const recurring = await prisma.expense.findMany({
      where: { isRecurring: true, paidOn: { lt: monthStart } },
      include: { category: true },
      orderBy: { paidOn: 'desc' }
    })
    const alreadyThisMonth = await prisma.expense.findMany({
      where: { isRecurring: true, paidOn: { gte: monthStart, lte: monthEnd } },
      select: { categoryId: true }
    })
    const covered = new Set(alreadyThisMonth.map((e) => e.categoryId))

    const seen = new Set<string>()
    const due: Array<{
      categoryId: string
      name: string
      lastAmount: number
      lastGstAmount: number
      lastPaidOn: string
      lastMethod: string
      payee: string | null
    }> = []
    for (const e of recurring) {
      if (seen.has(e.categoryId) || covered.has(e.categoryId)) continue
      seen.add(e.categoryId)
      due.push({
        categoryId: e.categoryId,
        name: e.category.name,
        lastAmount: Number(e.amount),
        lastGstAmount: Number(e.gstAmount),
        lastPaidOn: businessDateKey(e.paidOn),
        lastMethod: e.method,
        payee: e.payee
      })
    }
    return res.json({ success: true, month: businessDateKey(monthStart), due })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/expenses', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const parsed = parseExpense(req.body ?? {})
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error, message: parsed.message })
    }
    const category = await prisma.expenseCategory.findUnique({ where: { id: parsed.value.categoryId } })
    if (!category) {
      return res.status(400).json({ success: false, error: 'CATEGORY_NOT_FOUND', message: 'That category no longer exists.' })
    }

    const created = await prisma.expense.create({
      data: { ...parsed.value, recordedById: (req as never as { user: { userId: string } }).user.userId },
      include: { category: true, recordedBy: { select: { username: true } } }
    })
    return res.status(201).json({ success: true, expense: serializeExpense(created) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.put('/api/v1/expenses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const existing = await prisma.expense.findUnique({ where: { id: String(req.params.id) } })
    if (!existing) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    // An edit is the whole expense again, so it goes through the same checks a
    // new one does — a correction that skipped them could put GST above the
    // amount, which nothing downstream expects.
    const parsed = parseExpense({
      categoryId: existing.categoryId,
      amount: existing.amount,
      gstAmount: existing.gstAmount,
      paidOn: businessDateKey(existing.paidOn),
      method: existing.method,
      paidFromTill: existing.paidFromTill,
      payee: existing.payee,
      reference: existing.reference,
      notes: existing.notes,
      isRecurring: existing.isRecurring,
      ...(req.body ?? {})
    })
    if (!parsed.ok) {
      return res.status(400).json({ success: false, error: parsed.error, message: parsed.message })
    }

    const updated = await prisma.expense.update({
      where: { id: existing.id },
      data: parsed.value,
      include: { category: true, recordedBy: { select: { username: true } } }
    })
    return res.json({ success: true, expense: serializeExpense(updated) })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.delete('/api/v1/expenses/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    await prisma.expense.delete({ where: { id: String(req.params.id) } })
    return res.json({ success: true })
  } catch (err) {
    if ((err as { code?: string }).code === 'P2025') {
      return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
