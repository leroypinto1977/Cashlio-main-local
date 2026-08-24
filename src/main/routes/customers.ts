import { Router } from 'express'
import { prisma } from '../prisma'
import { requireAuth } from '../http/middleware'
import { fieldError } from '../http/respond'
import { emitCustomerUpsert } from '../syncEvents'
import { validateMobile, validateEmail, validateGstin, validateName } from '../../shared/validation'
import { round2 } from '../../shared/money'
import { UNSETTLED_STATUSES } from '../../shared/credit'

/**
 * Customers and their credit terms.
 */
export const router = Router()

/** Sums outstanding for many customers in one query. */
async function outstandingByCustomer(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.bill.groupBy({
    by: ['customerId'],
    where: { customerId: { in: ids }, status: { in: [...UNSETTLED_STATUSES] } },
    _sum: { balanceDue: true }
  })
  return new Map(
    rows
      .filter((r) => r.customerId)
      .map((r) => [r.customerId as string, round2(Number(r._sum.balanceDue ?? 0))])
  )
}

router.get('/api/v1/customers', requireAuth(), async (req, res) => {
  try {
    const { search, limit, offset, autocomplete } = req.query

    // Autocomplete mode (billing screen): ?search=x&autocomplete=1 — active only, no pagination
    if (autocomplete === '1') {
      const customers = await prisma.customer.findMany({
        where: {
          isActive: true,
          ...(search ? {
            OR: [
              { name: { contains: String(search), mode: 'insensitive' } },
              { phone: { contains: String(search) } }
            ]
          } : {})
        },
        orderBy: { name: 'asc' },
        take: 20
      })
      // The terminal needs the balance to decide whether credit is available.
      const owed = await outstandingByCustomer(customers.map((c) => c.id))
      return res.json({
        success: true,
        customers: customers.map((c) => ({
          ...c,
          creditLimit: Number(c.creditLimit),
          outstanding: owed.get(c.id) ?? 0
        })),
        total: customers.length
      })
    }

    // Full list mode (customers screen): all customers, paginated, optional search
    const take = parseInt(String(limit || '50'))
    const skip = parseInt(String(offset || '0'))
    const where = search ? {
      OR: [
        { name: { contains: String(search), mode: 'insensitive' as const } },
        { phone: { contains: String(search) } }
      ]
    } : {}
    const [customers, total] = await Promise.all([
      prisma.customer.findMany({
        where,
        orderBy: { name: 'asc' },
        take,
        skip,
        include: { _count: { select: { bills: true } } }
      }),
      prisma.customer.count({ where })
    ])
    const owed = await outstandingByCustomer(customers.map((c) => c.id))
    return res.json({
      success: true,
      customers: customers.map((c) => ({
        ...c,
        creditLimit: Number(c.creditLimit),
        outstanding: owed.get(c.id) ?? 0
      })),
      total
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.get('/api/v1/customers/:id', requireAuth(), async (req, res) => {
  try {
    const customer = await prisma.customer.findUnique({
      where: { id: String(req.params.id) },
      include: {
        bills: {
          orderBy: { paidAt: 'desc' },
          take: 10,
          select: {
            id: true, billNumber: true, totalAmount: true,
            paymentMethod: true, status: true, paidAt: true,
            _count: { select: { items: true } }
          }
        }
      }
    })
    if (!customer) return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    return res.json({
      success: true,
      customer: {
        ...customer,
        bills: customer.bills.map((b) => ({ ...b, totalAmount: Number(b.totalAmount) }))
      }
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/customers', requireAuth(), async (req, res) => {
  try {
    const { name, phone, email, address, gstin, creditLimit, creditDays } = req.body

    const nameCheck = validateName(String(name ?? ''), 'Customer name')
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const phoneCheck = validateMobile(String(phone ?? ''))
    if (!phoneCheck.ok) return fieldError(res, phoneCheck)
    const emailCheck = validateEmail(String(email ?? ''))
    if (!emailCheck.ok) return fieldError(res, emailCheck)
    const gstCheck = validateGstin(String(gstin ?? ''))
    if (!gstCheck.ok) return fieldError(res, gstCheck)

    const customer = await prisma.$transaction(async (tx) => {
      const created = await tx.customer.create({
        data: {
          name: nameCheck.value,
          phone: phoneCheck.value,
          email: emailCheck.value || null,
          address: address ? String(address).trim() : null,
          gstin: gstCheck.value || null,
          // Only a super-admin decides how much credit a customer gets.
          ...(req.user!.role === 'SUPER_ADMIN'
            ? {
                creditLimit: Math.max(0, round2(Number(creditLimit) || 0)),
                creditDays: Math.max(0, Math.floor(Number(creditDays) || 0))
              }
            : {})
        }
      })
      await emitCustomerUpsert(tx, created.id)
      return created
    })
    return res.status(201).json({ success: true, customer })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({ success: false, error: 'PHONE_ALREADY_EXISTS' })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.put('/api/v1/customers/:id', requireAuth(), async (req, res) => {
  try {
    const { name, phone, email, address, gstin, isActive, creditLimit, creditDays } = req.body
    // Build data with only the fields that were explicitly sent
    const data: Record<string, unknown> = {}
    if (name !== undefined) {
      const c = validateName(String(name), 'Customer name')
      if (!c.ok) return fieldError(res, c)
      data.name = c.value
    }
    if (phone !== undefined) {
      const c = validateMobile(String(phone))
      if (!c.ok) return fieldError(res, c)
      data.phone = c.value
    }
    if (email !== undefined) {
      const c = validateEmail(String(email ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.email = c.value || null
    }
    if (gstin !== undefined) {
      const c = validateGstin(String(gstin ?? ''))
      if (!c.ok) return fieldError(res, c)
      data.gstin = c.value || null
    }
    if (address !== undefined) data.address = address ? String(address).trim() : null
    if (isActive !== undefined) data.isActive = isActive
    // Credit terms are the shop owner's call, not a cashier's.
    if (req.user!.role === 'SUPER_ADMIN') {
      if (creditLimit !== undefined) data.creditLimit = Math.max(0, round2(Number(creditLimit) || 0))
      if (creditDays !== undefined) data.creditDays = Math.max(0, Math.floor(Number(creditDays) || 0))
    } else if (creditLimit !== undefined || creditDays !== undefined) {
      return res.status(403).json({
        success: false, error: 'CREDIT_TERMS_FORBIDDEN',
        message: 'Only a super admin can change credit terms.'
      })
    }
    const customer = await prisma.$transaction(async (tx) => {
      const updated = await tx.customer.update({
        where: { id: String(req.params.id) },
        data
      })
      await emitCustomerUpsert(tx, updated.id)
      return updated
    })
    return res.json({ success: true, customer })
  } catch (err: unknown) {
    const code = (err as { code?: string }).code
    if (code === 'P2025') return res.status(404).json({ success: false, error: 'NOT_FOUND' })
    if (code === 'P2002') return res.status(409).json({ success: false, error: 'PHONE_ALREADY_EXISTS' })
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
