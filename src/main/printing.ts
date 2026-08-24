import type { BrowserWindow as BrowserWindowType, IpcMain } from 'electron'

/**
 * Receipt printing.
 *
 * Lives here rather than in either app's entry point because the manager and
 * the till print the same receipt to the same kind of printer, and a fix made
 * in one of them was previously a fix made in only one of them.
 */

/** CSS pixels are 1/96 inch; Electron wants microns. */
const MICRONS_PER_PX = 25400 / 96
/** A few millimetres past the last line, so the cutter is not through it. */
const TAIL_MICRONS = 4000
/** Below this a printer rejects the job outright. */
const MIN_HEIGHT_MICRONS = 40_000

/**
 * The page a till roll actually wants: the roll's width, and exactly as much
 * height as the receipt came to.
 *
 * Getting this wrong is visible from across the shop — too tall and every
 * receipt trails a blank strip that gets torn off and thrown away, too short
 * and the total ends up on a second page.
 *
 * Returns null when no roll width is configured, which leaves the page alone
 * so the OS dialog can offer its own paper sizes.
 */
export function rollPageSize(
  paperWidthMm: number | undefined,
  contentHeightPx: number
): { width: number; height: number } | null {
  const widthMm = paperWidthMm === 58 ? 58 : paperWidthMm === 80 ? 80 : null
  if (widthMm === null) return null
  const px = Number(contentHeightPx)
  // A window that has not laid out yet reports 0. Falling back to the minimum
  // beats sending a zero-height page the printer will refuse.
  const measured = Number.isFinite(px) && px > 0 ? px : 0
  return {
    width: widthMm * 1000,
    height: Math.max(MIN_HEIGHT_MICRONS, Math.ceil(measured * MICRONS_PER_PX) + TAIL_MICRONS)
  }
}

/** Measures the rendered receipt and turns it into a page. */
async function buildRollPageSize(
  win: BrowserWindowType,
  paperWidthMm: number | undefined
): Promise<{ width: number; height: number } | null> {
  if (paperWidthMm !== 58 && paperWidthMm !== 80) return null
  try {
    const heightPx = (await win.webContents.executeJavaScript(
      'Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))'
    )) as number
    return rollPageSize(paperWidthMm, heightPx)
  } catch {
    // Measuring failed — printing on a default page beats not printing.
    return null
  }
}

export function registerPrintingIpc(
  ipcMain: IpcMain,
  BrowserWindow: typeof BrowserWindowType & { getAllWindows(): BrowserWindowType[] }
): void {
  // The printers this machine can see, for the counter-printer picker.
  ipcMain.handle('printer:list', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return []
    const printers = await win.webContents.getPrintersAsync()
    return printers.map((p) => {
      // Which printer is the default is platform-specific and lives in the
      // untyped options bag — `printer-is-default` on CUPS, `default` on
      // Windows. Missing means "we don't know", which is not an error.
      const opts = (p.options ?? {}) as Record<string, unknown>
      const flag = opts['printer-is-default'] ?? opts['default'] ?? opts['is-default']
      return {
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: flag === true || flag === 'true'
      }
    })
  })

  ipcMain.handle('print-receipt', async (_evt, payload: {
    html: string
    billNumber?: string
    deviceName?: string
    paperWidthMm?: number
  }) => {
    const html = payload?.html ?? ''
    if (!html) return { ok: false, error: 'NO_HTML' }
    const printWin = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    try {
      const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
      await printWin.loadURL(dataUrl)

      // A till roll has no page length — it is cut where the receipt ends. So
      // the page is measured from the rendered content rather than fixed:
      // a fixed height feeds a hand's width of blank paper after every short
      // bill, and cuts a long one in half across two pages.
      const pageSize = await buildRollPageSize(printWin, payload?.paperWidthMm)

      await new Promise<void>((resolve, reject) => {
        printWin.webContents.print(
          {
            silent: !!payload?.deviceName,
            deviceName: payload?.deviceName,
            printBackground: true,
            margins: { marginType: 'none' },
            ...(pageSize ? { pageSize } : {})
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
}
