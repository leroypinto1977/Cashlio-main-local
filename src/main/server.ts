import express from 'express'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const app = express()

app.use(cors())
app.use(express.json())

app.get('/api/v1/system/status', async (_req, res) => {
  try {
    const config = await prisma.shopConfig.findFirst()
    if (!config) {
      return res.status(200).json({ setupDone: false })
    }
    const userCount = await prisma.user.count()
    return res.status(200).json({
      setupDone: userCount > 0,
      shopName: config.shopName,
      branchName: config.branchName
    })
  } catch (err) {
    console.error('Error in /system/status:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/system/save-config', async (req, res) => {
  try {
    const { licenseKey, hardwareId = 'STATIC-MAC-FOR-MVP', branchName = 'PENDING_SETUP', shopName = 'My Shop' } = req.body

    // Guard: prevent re-activation if a config already exists for this key
    const existingConfig = await prisma.shopConfig.findUnique({ where: { licenseKey } })
    if (existingConfig) {
      return res.status(409).json({ success: false, error: 'LICENSE_ALREADY_ACTIVATED' })
    }

    // PROXY TO SAAS API (Node handles this, bypassing Browser CORS entirely)
    const saasBaseUrl = process.env.SAAS_API_URL
    console.log(`Proxying activation to ${saasBaseUrl}/api/v1/licenses/activate`);
    const saasRes = await fetch(`${saasBaseUrl}/api/v1/licenses/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ licenseKey, hardwareId })
    });

    const saasData = await saasRes.json().catch(() => ({}));
    if (!saasRes.ok || !saasData.success) {
      console.error('SaaS Reacted to Activation with:', saasData);
      return res.status(saasRes.status || 400).json(saasData);
    }

    const licenseJwt = saasData.jwt || saasData.token
    if (!licenseJwt) {
      return res.status(500).json({ success: false, error: 'INVALID_LICENSE_RESPONSE' })
    }

    const config = await prisma.shopConfig.create({
      data: {
        licenseKey,
        licenseJwt,
        branchName,
        shopName
      }
    })

    return res.status(200).json({ success: true, config, jwt: licenseJwt })
  } catch (err) {
    console.error('Error saving config:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/system/setup-profile', async (req, res) => {
  try {
    const { branchName, shopName, adminUsername, adminPassword, location, gst } = req.body

    console.log(`Setting up profile for ${shopName} at ${location} (GST: ${gst})`)

    const config = await prisma.shopConfig.findFirst()
    if (!config) {
      return res.status(400).json({ success: false, error: 'LICENSE_NOT_ACTIVATED' })
    }

    // PROXY TO SAAS explicitly using Node fetch to bypass all CORS
    try {
       await fetch(`${process.env.SAAS_API_URL}/api/v1/licenses/update-profile`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            licenseKey: config.licenseKey,
            branchName: branchName
          })
       });
    } catch(proxyErr) {
       console.error('Non-fatal error: SaaS proxy failed for profile sync', proxyErr);
    }

    await prisma.shopConfig.update({
      where: { id: config.id },
      data: { shopName, branchName }
    })

    // Create SUPER_ADMIN user with hashed password
    const passwordHash = await bcrypt.hash(adminPassword, 10)
    await prisma.user.create({
      data: {
        username: adminUsername,
        passwordHash,
        role: 'SUPER_ADMIN'
      }
    })

    return res.status(200).json({ success: true })
  } catch (err) {
    console.error('Error in setup-profile:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

app.post('/api/v1/system/pair-client', async (req, res) => {
  try {
    const { macAddress, friendlyName } = req.body

    const config = await prisma.shopConfig.findFirst()
    if (!config || !config.licenseJwt) {
      return res.status(403).json({ success: false, error: 'NO_LICENSE_FOUND' })
    }

    // Verify JWT to ensure it hasn't been tampered with before trusting capacity limits
    let decoded: { maxSystemsPerBranch?: number } | null = null
    try {
      decoded = jwt.verify(config.licenseJwt, process.env.JWT_SECRET as string) as { maxSystemsPerBranch?: number }
    } catch {
      return res.status(403).json({ success: false, error: 'INVALID_LICENSE_JWT' })
    }
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

    const user = await prisma.user.findUnique({ where: { username } })

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ success: false, error: 'INVALID_CREDENTIALS' })
    }

    const token = jwt.sign({ userId: user.id, role: user.role }, process.env.JWT_SECRET as string, {
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

app.get('/api/v1/system/authorized-clients', async (_req, res) => {
  try {
    const clients = await prisma.authorizedClient.findMany({
      orderBy: { authorizedAt: 'desc' }
    })
    return res.status(200).json({ success: true, clients })
  } catch (err) {
    console.error('Error fetching authorized clients:', err)
    return res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' })
  }
})

export function startExpressServer(port: number = parseInt(process.env.LOCAL_SERVER_PORT || '52001')): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      console.log(`Local Express server running on port ${port} (all interfaces)`)
      resolve(port)
    })
    server.on('error', (err) => {
      console.error(`Failed to bind port ${port}:`, err)
      reject(err)
    })
  })
}
