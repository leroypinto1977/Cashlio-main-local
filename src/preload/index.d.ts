declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        /** Only the channels named in the preload's allow-list resolve. */
        invoke(channel: string, ...args: unknown[]): Promise<unknown>
      }
      process: {
        versions: { electron: string; chrome: string; node: string }
      }
    }
    api: unknown
  }
}

export {}
