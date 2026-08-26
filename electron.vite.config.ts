import { resolve } from 'path'
import { readFileSync } from 'fs'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

/**
 * What the built app knows before it is ever run.
 *
 * The licence server's address and the key that verifies what it signs are
 * baked in at build time rather than left in a file somebody has to place by
 * hand on the machine it is installed on. Neither is a secret, and asking a
 * shopkeeper to create a dotfile in AppData before their till will work is a
 * step that will not survive contact with a shop.
 *
 * Environment variables still win, so a developer can point a build at a
 * local licence server without editing anything tracked.
 */
function buildConfig(): { saasApiUrl: string; licensePublicKey: string } {
  let file = { saasApiUrl: '', licensePublicKey: '' }
  try {
    file = JSON.parse(readFileSync(resolve('build-config.json'), 'utf8'))
  } catch {
    // Absent or unreadable: environment only. The app itself checks whether
    // what it ended up with is usable.
  }
  return {
    saasApiUrl: process.env.SAAS_API_URL || file.saasApiUrl || '',
    licensePublicKey: process.env.LICENSE_PUBLIC_KEY || file.licensePublicKey || ''
  }
}

export default defineConfig({
  main: {
    define: {
      __BUILD_CONFIG__: JSON.stringify(buildConfig())
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()]
  }
})
