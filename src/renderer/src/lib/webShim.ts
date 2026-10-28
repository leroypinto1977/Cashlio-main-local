/**
 * Stands in for the Electron preload when the manager app is opened in a
 * plain browser — the hosted test build.
 *
 * Only what has a browser equivalent works: receipts print through the
 * browser's own dialog and a GST return downloads. Backups, printer lists
 * and certificate pinning belong to the desktop app and say so.
 */
const DESKTOP_ONLY = 'Available in the desktop app only.'

function download(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  a.click()
  URL.revokeObjectURL(url)
}

const handlers: Record<string, (...args: never[]) => unknown> = {
  // The server activates as itself (MACHINE_ID); this only has to pass validation.
  'get-machine-id': () => 'hosted-web-preview',
  'get-cert-fingerprint': () => null,
  'printer:list': () => [],
  'print-receipt': ({ html }: { html: string }) => {
    const w = window.open('', '_blank', 'width=380,height=640')
    if (!w) return { ok: false, error: 'POPUP_BLOCKED' }
    w.document.write(html)
    w.document.close()
    return { ok: true }
  },
  'gst:save-return': ({ filename, contents }: { filename: string; contents: string }) => {
    download(filename, contents)
    return { ok: true, path: `your Downloads folder (${filename})` }
  },
  'backup:status': () => {
    throw new Error(DESKTOP_ONLY)
  }
}

if (!window.electron) {
  window.electron = {
    ipcRenderer: {
      async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
        const handler = handlers[channel]
        if (!handler) return { ok: false, error: DESKTOP_ONLY }
        return (handler as (...a: unknown[]) => unknown)(...args)
      }
    },
    process: { versions: { electron: 'web', chrome: navigator.userAgent, node: 'web' } }
  }
  window.api = {}
}
