import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The manager app as a plain website, served from the same origin as its API.
// See scripts/build-web.sh.
export default defineConfig({
  root: resolve('src/renderer'),
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  define: {
    'import.meta.env.VITE_LOCAL_API_URL': 'window.location.origin'
  },
  plugins: [react()],
  build: { outDir: resolve('.vercel/output/static'), emptyOutDir: true }
})
