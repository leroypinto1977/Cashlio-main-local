import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../prisma'
import { requireAuth, forgetUser } from '../http/middleware'
import { fieldError } from '../http/respond'
import { isRole, validateUsername, validatePassword } from '../domain/accounts'

/**
 * Who may sign in, and what they are allowed to do.
 */
export const router = Router()

router.get('/api/v1/users', requireAuth(['SUPER_ADMIN']), async (_req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, role: true, isActive: true, createdAt: true,
        _count: { select: { bills: true } }
      },
      orderBy: [{ isActive: 'desc' }, { role: 'asc' }, { username: 'asc' }]
    })
    return res.json({
      success: true,
      users: users.map((u) => ({
        id: u.id, username: u.username, role: u.role, isActive: u.isActive,
        createdAt: u.createdAt, billCount: u._count.bills
      }))
    })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.post('/api/v1/users', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const nameCheck = validateUsername(req.body?.username)
    if (!nameCheck.ok) return fieldError(res, nameCheck)
    const passCheck = validatePassword(req.body?.password)
    if (!passCheck.ok) return fieldError(res, passCheck)
    if (!isRole(req.body?.role)) {
      return res.status(400).json({
        success: false, error: 'INVALID_ROLE', message: 'Choose either Cashier or Super Admin.'
      })
    }

    const user = await prisma.user.create({
      data: {
        username: nameCheck.value,
        passwordHash: await bcrypt.hash(passCheck.value, 10),
        role: req.body.role
      },
      select: { id: true, username: true, role: true, isActive: true, createdAt: true }
    })
    return res.status(201).json({ success: true, user })
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      return res.status(409).json({
        success: false, error: 'USERNAME_TAKEN', message: 'That username is already in use.'
      })
    }
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.put('/api/v1/users/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    const target = await prisma.user.findUnique({ where: { id } })
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    const data: Record<string, unknown> = {}

    // Any of these three is somebody's access changing, and each one only
    // means something if the sessions already open stop working. Bumping
    // tokenVersion is what does that.
    let revokeSessions = false

    if (req.body?.password !== undefined) {
      const passCheck = validatePassword(req.body.password)
      if (!passCheck.ok) return fieldError(res, passCheck)
      data.passwordHash = await bcrypt.hash(passCheck.value, 10)
      revokeSessions = true
    }

    if (req.body?.isActive !== undefined) {
      const active = Boolean(req.body.isActive)
      if (!active) {
        if (id === req.user!.userId) {
          return res.status(409).json({
            success: false, error: 'CANNOT_DISABLE_SELF',
            message: 'You cannot switch off your own account.'
          })
        }
        if (target.role === 'SUPER_ADMIN') {
          const admins = await prisma.user.count({
            where: { role: 'SUPER_ADMIN', isActive: true }
          })
          if (admins <= 1) {
            return res.status(409).json({
              success: false, error: 'LAST_SUPER_ADMIN',
              message: 'This is the only active super admin. Promote someone else first.'
            })
          }
        }
      }
      data.isActive = active
      revokeSessions = true
    }

    if (req.body?.role !== undefined) {
      if (!isRole(req.body.role)) {
        return res.status(400).json({ success: false, error: 'INVALID_ROLE' })
      }
      // Never let the last super admin demote themselves — the shop would be
      // locked out of its own settings with no way back in.
      if (target.role === 'SUPER_ADMIN' && req.body.role !== 'SUPER_ADMIN') {
        const admins = await prisma.user.count({
          where: { role: 'SUPER_ADMIN', isActive: true }
        })
        if (admins <= 1) {
          return res.status(409).json({
            success: false, error: 'LAST_SUPER_ADMIN',
            message: 'This is the only super admin. Promote someone else first.'
          })
        }
      }
      if (req.body.role !== target.role) revokeSessions = true
      data.role = req.body.role
    }

    if (revokeSessions) data.tokenVersion = { increment: 1 }

    const user = await prisma.user.update({
      where: { id }, data,
      select: { id: true, username: true, role: true, isActive: true, createdAt: true }
    })
    // The cached answer is now stale, and the whole point of the bump is that
    // it takes effect at once rather than when the cache happens to expire.
    forgetUser(id)
    return res.json({ success: true, user })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

router.delete('/api/v1/users/:id', requireAuth(['SUPER_ADMIN']), async (req, res) => {
  try {
    const id = String(req.params.id)
    if (id === req.user!.userId) {
      return res.status(409).json({
        success: false, error: 'CANNOT_DELETE_SELF',
        message: 'You cannot remove your own account.'
      })
    }
    const target = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { bills: true } } }
    })
    if (!target) return res.status(404).json({ success: false, error: 'NOT_FOUND' })

    if (target.role === 'SUPER_ADMIN') {
      const admins = await prisma.user.count({ where: { role: 'SUPER_ADMIN' } })
      if (admins <= 1) {
        return res.status(409).json({
          success: false, error: 'LAST_SUPER_ADMIN',
          message: 'This is the only super admin and cannot be removed.'
        })
      }
    }

    // Bills reference their cashier, and a sale must always name who made it.
    if (target._count.bills > 0) {
      return res.status(409).json({
        success: false, error: 'USER_HAS_BILLS',
        message: `${target.username} has ${target._count.bills} bill${target._count.bills === 1 ? '' : 's'} against their name and cannot be deleted. Switch the account off instead — it ends their access and keeps the sales history intact.`,
        billCount: target._count.bills
      })
    }

    await prisma.user.delete({ where: { id } })
    forgetUser(id)
    return res.json({ success: true })
  } catch (err) {
    console.error(err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})
