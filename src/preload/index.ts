import { contextBridge, ipcRenderer } from 'electron'

/**
 * The renderer only gets what it asks for by name.
 *
 * This used to hand over @electron-toolkit's `electronAPI` whole, which
 * carries `process.env` — so anything running in the renderer could read
 * JWT_SECRET and the database password straight out of the page, and could
 * invoke any IPC channel the main process happened to register. There is no
 * way in today for a script we didn't write, but the renderer is a browser
 * showing data typed in by other people, and that is not a bet worth holding
 * open.
 *
 * Adding a channel here is deliberate. Keep the list short and specific.
 */
const INVOKE_CHANNELS = [
  'get-mac-address',
  'get-machine-id',
  'get-cert-fingerprint',
  'print-receipt',
  'backup:status',
  'backup:list',
  'backup:run',
  'backup:open-folder',
  'gst:save-return'
] as const

type InvokeChannel = (typeof INVOKE_CHANNELS)[number]

const electron = {
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
        return Promise.reject(new Error(`IPC channel not exposed: ${channel}`))
      }
      return ipcRenderer.invoke(channel as InvokeChannel, ...args)
    }
  },
  // Version strings are all the renderer ever wanted from `process`, and they
  // are not secrets. The rest of it stays in the main process.
  process: {
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node
    }
  }
}

const api = {}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electron)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electron
  // @ts-ignore (define in dts)
  window.api = api
}
