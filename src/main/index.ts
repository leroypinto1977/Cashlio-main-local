import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import os from 'os'
import fs from 'fs'
import dotenv from 'dotenv'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { startExpressServer } from './server'
import { runBackup, listBackups, getBackupStatus, getBackupDir, startBackupSchedule } from './backup'
import { startRefreshLoop, checkClockTamper } from './licenseGuard'

// Load .env at runtime. In dev, electron-vite already injects from ./.env.
// In a packaged build, look in (1) a user-editable file in userData and
// (2) the bundled resources/.env that ships with the DMG. First file wins.
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
app.whenReady().then(async () => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))

  // Expose real MAC address to the renderer securely via IPC
  ipcMain.handle('get-mac-address', () => getMacAddress())

  // Print a receipt: renderer hands us the full HTML, we render it in a
  // hidden BrowserWindow and trigger printing via webContents.print.
  // silent:true is used only when an explicit deviceName is given (future
  // "default printer" setting); otherwise the OS print dialog is shown.
  ipcMain.handle('print-receipt', async (_evt, payload: { html: string; billNumber?: string; deviceName?: string }) => {
    const html = payload?.html ?? ''
    if (!html) return { ok: false, error: 'NO_HTML' }
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    try {
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
      await printWin.loadURL(dataUrl)
      await new Promise<void>((resolve, reject) => {
        printWin.webContents.print(
          {
            silent: !!payload?.deviceName,
            deviceName: payload?.deviceName,
            printBackground: true,
            margins: { marginType: 'none' }
          },
          (success, failureReason) => {
            if (success) resolve()
            else reject(new Error(failureReason || 'PRINT_CANCELLED'))
          }
        )
      })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    } finally {
      if (!printWin.isDestroyed()) printWin.close()
    }
  })

  // ─── Local DB backup IPC ──────────────────────────────────────────────────
  // Status snapshot (count, last backup, dir, pg_dump availability).
  ipcMain.handle('backup:status', async () => getBackupStatus())
  // List all backup files in the configured dir.
  ipcMain.handle('backup:list', async () => listBackups())
  // Trigger a backup synchronously (caller awaits the result).
  ipcMain.handle('backup:run', async () => runBackup())
  // Reveal backup folder in the OS file manager.
  ipcMain.handle('backup:open-folder', async () => {
    const dir = await getBackupDir()
    await shell.openPath(dir)
    return { ok: true, dir }
  })

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

  // Start the local express server
  try {
    const port = await startExpressServer(parseInt(process.env.LOCAL_SERVER_PORT || '52001'))
    console.log(`Express API started on port ${port}`)
  } catch (err) {
    console.error('Failed to start Express API', err)
  }

  // Phase 4: daily license refresh worker. First tick is delayed 30s by the
  // worker itself; backoff on consecutive failures. Lives for the lifetime
  // of the Electron process.
  if (process.env.SAAS_API_URL) {
    startRefreshLoop({
      saasBaseUrl: process.env.SAAS_API_URL,
      hardwareId: getMacAddress()
    })
  } else {
    console.warn('[license] SAAS_API_URL not set — refresh loop disabled')
  }

  // Kick off the daily-backup schedule (runs ~1 minute after boot, then every 6h).
  startBackupSchedule()

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

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
