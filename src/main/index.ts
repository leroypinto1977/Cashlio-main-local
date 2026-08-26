import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import dotenv from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startExpressServer, stopExpressServer, startSyncEventPruning } from './server'
import { setBranchCertFingerprint } from './branchCert'
import { ensureBranchCert, fingerprintOfPem, fingerprintsMatch } from './tls'
import { registerPrintingIpc } from './printing'
import { startBundledPostgres, stopBundledPostgres } from './postgres'
import { applyMigrations } from './migrate'
import { verifyBackup, testRestore, restoreOverLive, writeLastRestoreCheck } from './restore'
import { prisma } from './prisma'
import { runBackup, listBackups, getBackupStatus, getBackupDir, startBackupSchedule } from './backup'
import { startRefreshLoop, checkClockTamper } from './licenseGuard'
import { getMachineId } from './machineId'
import { randomBytes } from 'crypto'
import { dirname } from 'path'

/**
 * Per-install session secret.
 *
 * This used to ship inside the package, which meant every copy of the app
 * signed cashier sessions with the same key — anyone holding the installer
 * could mint a SUPER_ADMIN token for every shop running that build. The
 * secret is now generated once on this machine and never leaves it.
 */
function ensureSessionSecret(): void {
  if (process.env.JWT_SECRET) return
  const file = join(app.getPath('userData'), 'session.key')
  try {
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file, 'utf8').trim()
      if (existing) {
        process.env.JWT_SECRET = existing
        return
      }
    }
    const secret = randomBytes(48).toString('base64url')
    fs.mkdirSync(dirname(file), { recursive: true })
    // Owner-only: any local account that can read this can forge sessions.
    fs.writeFileSync(file, secret, { mode: 0o600 })
    process.env.JWT_SECRET = secret
    console.log('[env] generated a new session secret for this installation')
  } catch (err) {
    console.error('[env] could not establish a session secret:', err)
  }
}

/**
 * Refuses to run half-configured. Without these the app boots looking
 * healthy: logins fail with an opaque 500, or — worse — the licence guard
 * throws, hits its deliberate fail-open, and the shop runs unlicensed
 * forever with nothing to notice.
 */
function validateEnv(): string[] {
  const required: [string, string][] = [
    ['DATABASE_URL', 'the local PostgreSQL connection string'],
    ['JWT_SECRET', 'the session signing secret'],
    ['LICENSE_PUBLIC_KEY', 'the licence verification key']
  ]
  return required
    .filter(([k]) => !process.env[k])
    .map(([k, why]) => `${k} — ${why}`)
}

// Load .env at runtime. In dev, electron-vite already injects from ./.env.
// In a packaged build this reads a user-editable file in userData. Nothing
// secret ships inside the package any more.
function loadRuntimeEnv(): void {
  const candidates = [
    join(app.getPath('userData'), '.env'),
    join(process.resourcesPath || '', '.env')
  ]
  for (const p of candidates) {
    if (p && fs.existsSync(p)) {
      const parsed = dotenv.parse(fs.readFileSync(p))
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) process.env[k] = v
      }
      console.log(`[env] loaded ${p}`)
    }
  }
  // Sensible defaults so the app still boots if no .env is present.
  if (!process.env.SAAS_API_URL) process.env.SAAS_API_URL = 'http://localhost:3000'
  if (!process.env.LOCAL_SERVER_PORT) process.env.LOCAL_SERVER_PORT = '52001'
}
loadRuntimeEnv()
ensureSessionSecret()

// A rejected promise in the main process terminates Electron under Node 20+.
// Without these the manager app vanishes mid-shift, taking every till's
// server with it, and leaves nothing behind to explain why.
/**
 * Appends a line to the app's own log, creating the directory if it is not
 * there yet.
 *
 * On a first launch userData does not exist, so this used to fail silently and
 * the one crash worth reading — the one that stops the app before it can
 * create anything — was the one that never got written down.
 */
function logToFile(name: string, line: string): void {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(join(dir, name), line)
  } catch {
    // Logging must never be the thing that brings the app down.
  }
}

/** Startup progress, so a packaged app that does nothing can still be read. */
export function bootLog(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}\n`
  console.log(line.trimEnd())
  logToFile('boot.log', line)
}

function logCrash(kind: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${kind}: ${
    err instanceof Error ? (err.stack ?? err.message) : String(err)
  }\n`
  console.error(line)
  logToFile('crash.log', line)
}
process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))
process.on('uncaughtException', (err) => logCrash('uncaughtException', err))

function getMacAddress(): string {
  const interfaces = os.networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue
    for (const info of iface) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac
      }
    }
  }
  return 'UNKNOWN-MAC'
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
/**
 * This window talks to the server running in this same process, over a
 * certificate this machine issued itself. Chromium has no reason to trust it,
 * so the trust is stated here — and stated narrowly: exactly one fingerprint,
 * the one we just generated. Anything else is refused, which is the whole
 * point of doing it this way rather than switching certificate checking off.
 */
let ownCertFingerprint: string | null = null

app.on('certificate-error', (event, _webContents, url, _error, certificate, callback) => {
  const presented = fingerprintOfPem(certificate.data)
  if (
    ownCertFingerprint &&
    presented &&
    fingerprintsMatch(presented, ownCertFingerprint) &&
    /^https:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)
  ) {
    event.preventDefault()
    callback(true)
    return
  }
  console.error(`[tls] refusing certificate for ${url}`)
  callback(false)
})

app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.cashlio.manager')

  // The database ships inside the app, so it has to be running before anything
  // asks it a question. A failure here is fatal and has to say so plainly: the
  // shop has no data without it, and a blank window with a console error is not
  // an explanation anybody can act on.
  bootLog(`starting — packaged=${app.isPackaged} platform=${process.platform}`)
  try {
    bootLog('bringing up the database')
    const pg = await startBundledPostgres()
    bootLog(pg ? `database up on port ${pg.port}` : 'no bundled database; using DATABASE_URL')
    if (pg) {
      const { applied, error } = applyMigrations(process.env.BACKUP_PSQL_PATH!, pg.url)
      if (error) throw new Error(error)
      bootLog(`migrations: ${applied.length} applied`)
    }
  } catch (e) {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e)
    bootLog(`FATAL: ${message}`)
    dialog.showErrorBox(
      'Cashlio could not start its database',
      `${message}\n\nThe shop's data is safe — nothing has been changed. If this keeps happening, send this message to your supplier.`
    )
    app.quit()
    return
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // The MAC identifies this box on the shop's own network — it is what a till
  // is paired against. Licensing uses `get-machine-id` instead, which is tied
  // to the machine rather than to whichever adapter happened to come up first.
  ipcMain.handle('get-mac-address', () => getMacAddress())
  ipcMain.handle('get-machine-id', () => getMachineId(app.getPath('userData')))

  // Print a receipt: renderer hands us the full HTML, we render it in a
  // hidden BrowserWindow and trigger printing via webContents.print.
  // silent:true is used only when an explicit deviceName is given (future
  // "default printer" setting); otherwise the OS print dialog is shown.
  registerPrintingIpc(ipcMain, BrowserWindow)

  // ─── Local DB backup IPC ──────────────────────────────────────────────────
  // Status snapshot (count, last backup, dir, pg_dump availability).
  ipcMain.handle('backup:status', async () => getBackupStatus())
  // List all backup files in the configured dir.
  ipcMain.handle('backup:list', async () => listBackups())
  // Trigger a backup synchronously (caller awaits the result).
  ipcMain.handle('backup:run', async () => runBackup())
  // Read a backup back without restoring it: is it complete, and unchanged?
  ipcMain.handle('backup:verify', async (_e, fullPath: string) => verifyBackup(fullPath))

  /**
   * Restore a backup into a scratch database and report what came back. Safe:
   * the real database is not touched, and the scratch copy is dropped either
   * way. This is the check the schedule runs on its own each week.
   */
  ipcMain.handle('backup:test-restore', async (_e, fullPath: string) => {
    const check = await testRestore(fullPath)
    writeLastRestoreCheck(await getBackupDir(), check)
    return check
  })

  /**
   * Replace the live database with a backup, then restart.
   *
   * The server stops first so a sale cannot land in a database that is being
   * dropped, and the app relaunches afterwards because every connection this
   * process holds points at tables that no longer exist.
   */
  ipcMain.handle(
    'backup:restore',
    async (_e, args: { fullPath: string; confirmation: string }) => {
      const cfg = await prisma.shopConfig.findFirst()
      const branchName = cfg?.branchName ?? ''
      if (!branchName) {
        return {
          ok: false,
          error: 'NO_BRANCH',
          message: 'This branch has no name set, so there is nothing to confirm against.'
        }
      }
      if (args?.confirmation?.trim() !== branchName.trim()) {
        return {
          ok: false,
          error: 'CONFIRMATION_MISMATCH',
          message: `This replaces everything in the database with the contents of that file. Type the branch name — ${branchName} — to confirm.`
        }
      }
      await stopExpressServer()
      const result = await restoreOverLive({
        dumpPath: args.fullPath,
        confirmation: args.confirmation,
        branchName,
        takeSafetyBackup: async () => {
          const r = await runBackup()
          return r.ok ? { ok: true, fullPath: r.fullPath } : { ok: false, error: r.error }
        }
      })
      if (result.ok) {
        // Nothing in this process can be trusted to still be talking to the
        // same database, so it starts again rather than carrying on.
        setTimeout(() => {
          app.relaunch()
          app.exit(0)
        }, 1500)
      } else {
        // Nothing was replaced, so the shop goes back to trading.
        await startExpressServer(parseInt(process.env.LOCAL_SERVER_PORT || '52001'))
      }
      return result
    }
  )

  // Reveal backup folder in the OS file manager.
  ipcMain.handle('backup:open-folder', async () => {
    const dir = await getBackupDir()
    await shell.openPath(dir)
    return { ok: true, dir }
  })

  /**
   * Write a prepared GST return somewhere the shop can find it.
   *
   * Through the main process rather than a browser download: this file goes
   * to an accountant or straight to the portal, and the shopkeeper needs to
   * know where it landed. A save dialog answers that; a silent drop into
   * Downloads does not.
   */
  ipcMain.handle('gst:save-return', async (_e, input: { filename: string; contents: string }) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save GST return',
      defaultPath: join(app.getPath('documents'), input.filename),
      filters: [{ name: 'GST return (JSON)', extensions: ['json'] }]
    })
    if (canceled || !filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, input.contents, 'utf8')
      return { ok: true, path: filePath }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Refuse to run half-configured. A missing licence key in particular would
  // otherwise hit the licence guard's deliberate fail-open and leave the shop
  // running unlicensed with nothing to notice.
  const missing = validateEnv()
  if (missing.length > 0) {
    const detail = missing.map((m) => `  • ${m}`).join('\n')
    console.error(`[env] Refusing to start. Missing configuration:\n${detail}`)
    dialog.showErrorBox(
      'Cashlio cannot start',
      `This installation is missing required configuration:\n\n${detail}\n\n` +
        `Add it to:\n${join(app.getPath('userData'), '.env')}\n\nSee SETUP.md.`
    )
    app.quit()
    return
  }

  // Phase 4: clock-tampering check before anything else. If the user has
  // rolled their clock backwards more than an hour past the last server-issued
  // timestamp, refuse to start the API. The window keeps loading so they see
  // the explanation rather than a blank screen.
  const clock = await checkClockTamper().catch(() => ({ ok: true, driftMs: null, lastSeen: null }))
  if (!clock.ok) {
    console.error(
      `[license] Refusing to start: local clock is ${Math.round((clock.driftMs ?? 0) / 60000)} min behind server-issued time. Fix the system clock and relaunch.`
    )
    // Don't start Express, but still create the window so the user sees an error UI.
    createWindow()
    return
  }

  // Start the local express server, over TLS. Tills pin the certificate at
  // pairing, so the shop's Wi-Fi stops being a place to read sessions and
  // bills off the wire — or to answer in this server's place.
  try {
    const tls = await ensureBranchCert(app.getPath('userData'))
    setBranchCertFingerprint(tls.fingerprint)
    ownCertFingerprint = tls.fingerprint
    ipcMain.handle('get-cert-fingerprint', () => tls.fingerprint)
    console.log(`[tls] serving ${tls.hosts.join(', ')} — expires ${tls.validTo}`)
    const port = await startExpressServer(parseInt(process.env.LOCAL_SERVER_PORT || '52001'), tls)
    console.log(`Express API started on port ${port}`)
  } catch (err) {
    // A dead API means every till in the shop is offline. Say so, rather than
    // opening a normal-looking window attached to nothing.
    logCrash('expressStartFailed', err)
    dialog.showErrorBox(
      'Cashlio could not start its server',
      `The billing service failed to start, so tills cannot connect.\n\n` +
        `${err instanceof Error ? err.message : String(err)}\n\n` +
        `The most common cause is another program using port ` +
        `${process.env.LOCAL_SERVER_PORT || '52001'}.`
    )
  }

  // Phase 4: daily license refresh worker. First tick is delayed 30s by the
  // worker itself; backoff on consecutive failures. Lives for the lifetime
  // of the Electron process.
  if (process.env.SAAS_API_URL) {
    startRefreshLoop({
      saasBaseUrl: process.env.SAAS_API_URL,
      hardwareId: getMachineId(app.getPath('userData'))
    })
  } else {
    console.warn('[license] SAAS_API_URL not set — refresh loop disabled')
  }

  // Kick off the daily-backup schedule (runs ~1 minute after boot, then every 6h).
  startBackupSchedule()

  // Keep the terminals' change log from growing without bound.
  startSyncEventPruning()

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Stop the database with the app rather than leaving it running after the
// window is gone — an orphaned server holds the data directory, and the next
// launch would find it locked by a process nobody can see.
app.on('will-quit', () => {
  stopBundledPostgres()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
