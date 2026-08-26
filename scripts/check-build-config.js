#!/usr/bin/env node
// Refuses to package a build that cannot reach its licence server.
//
// An installer with no licence server address and no verification key is one
// that cannot be set up: setup posts the licence key to a server it does not
// know, and the till refuses to bill. That is a five-second mistake to make
// and an expensive one to discover, because it is discovered on somebody
// else's computer, by somebody who cannot fix it.

const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
let file = {}
try {
  file = JSON.parse(fs.readFileSync(path.join(root, 'build-config.json'), 'utf8'))
} catch {
  // Absent is fine if the environment supplies both.
}

const saasApiUrl = process.env.SAAS_API_URL || file.saasApiUrl || ''
const licensePublicKey = process.env.LICENSE_PUBLIC_KEY || file.licensePublicKey || ''

const problems = []
if (!saasApiUrl) {
  problems.push('the licence server address (saasApiUrl / SAAS_API_URL)')
} else if (!/^https?:\/\//.test(saasApiUrl)) {
  problems.push(`the licence server address is not a URL: ${saasApiUrl}`)
} else if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(saasApiUrl)) {
  problems.push(
    `the licence server is pointed at this machine (${saasApiUrl}) — nobody else can reach that`
  )
}
if (!licensePublicKey) {
  problems.push('the licence verification key (licensePublicKey / LICENSE_PUBLIC_KEY)')
} else if (!/^[A-Za-z0-9+/=]{40,}$/.test(licensePublicKey)) {
  problems.push('the licence verification key does not look like base64 — check it was copied whole')
}

if (problems.length > 0) {
  console.error('\n  This build is missing:\n')
  for (const p of problems) console.error(`    · ${p}`)
  console.error(`
  Fill them into build-config.json, or set them in the environment for one
  build. Generate the pair with:

      node ../admin-saas/scripts/gen-license-keys.js

  The private half goes in admin-saas's environment and nowhere else. The
  public half is safe to ship and belongs here.
`)
  process.exit(1)
}

console.log(`▸ build config: ${saasApiUrl}`)
