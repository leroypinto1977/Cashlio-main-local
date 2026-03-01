import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const pkg = require('../generated/prisma/index.js')
const { PrismaClient } = pkg

const prisma = new PrismaClient()
const app = express()

app.use(cors())
app.use(express.json())

app.post('/api/v1/system/pair-client', async (req, res) => {
  try {
    const { macAddress, friendlyName } = req.body

    const config = await prisma.shopConfig.findFirst()
    if (!config || !config.licenseJwt) {
      return res.status(403).json({ success: false, error: 'NO_LICENSE_FOUND' })
    }

    // Decode JWT to find maxSystemsPerBranch
    const decoded = jwt.decode(config.licenseJwt) as { maxSystemsPerBranch?: number } | null
    const maxSystems = decoded?.maxSystemsPerBranch || 3

    // Check current authorized clients
    const currentClients = await prisma.authorizedClient.count()

    // Are we already authorized?
    const existing = await prisma.authorizedClient.findUnique({ where: { macAddress } })
    if (!existing && currentClients >= maxSystems) {
      return res.status(403).json({ success: false, error: 'LICENSE_LIMIT_REACHED' })
    }

    if (!existing) {
      await prisma.authorizedClient.create({
        data: {
          macAddress,
          friendlyName
        }
      })
    }

    const slotsRemaining = existing ? maxSystems - currentClients : maxSystems - currentClients - 1

    return res.status(200).json({
      success: true,
      message: `Authorized successfully. Slots remaining: ${slotsRemaining}`
    })
  } catch (err) {
    console.error('Error in /pair-client:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body

    // In a real scenario we use bcrypt to verify passwordHash.
    // Here we'll do a simple string match for phase 1 stubbing or assume password === passwordHash.
    const user = await prisma.user.findUnique({ where: { username } })

    if (!user || user.passwordHash !== password) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' })
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, 'LOCAL_SECRET_KEY', {
      expiresIn: '12h'
    })

    return res.status(200).json({
      success: true,
      token
    })
  } catch (err) {
    console.error('Error in /login:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

export function startExpressServer(port: number = 5000): Promise<number> {
  return new Promise((resolve, reject) => {
    try {
      app.listen(port, () => {
        console.log(`Local Express server running on port ${port}`)
        resolve(port)
      })
    } catch (err) {
      reject(err)
    }
  })
}
