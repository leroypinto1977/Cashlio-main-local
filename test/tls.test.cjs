/**
 * The branch server's certificate, and the pinning that makes it worth having.
 *
 * There is no certificate authority in a shop, so the server issues its own
 * and each till is told the fingerprint at pairing. That is only a real
 * guarantee if two things hold: the certificate stays the same across
 * restarts (or every till would need re-pairing), and a client pinned to one
 * certificate genuinely refuses a different one. Both are checked here
 * against a real TLS handshake rather than assumed.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const tls = require('tls')
const https = require('https')
const esbuild = require('esbuild')

const buildDir = path.join(__dirname, '.build')
fs.mkdirSync(buildDir, { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'main', 'tls.ts')],
  outfile: path.join(buildDir, 'tls.cjs'),
  bundle: true, platform: 'node', format: 'cjs', external: ['selfsigned']
})
const T = require(path.join(buildDir, 'tls.cjs'))

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : String(detail)) }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cashlio-tls-'))

;(async () => {
  console.log('\n— issuing a certificate —')
  const dirA = tmp()
  const a = await T.ensureBranchCert(dirA)
  t('a certificate is produced', a.cert.includes('BEGIN CERTIFICATE'))
  t('with a private key', a.key.includes('PRIVATE KEY'))
  t('the key is owner-only on disk',
    (fs.statSync(path.join(dirA, 'branch-key.pem')).mode & 0o777) === 0o600)
  t('it is good for years, not months',
    new Date(a.validTo).getTime() - Date.now() > 5 * 365 * 86400000, a.validTo)
  t('it covers loopback', T.certificateCoversHost(a.cert, '127.0.0.1'))
  t('...and every LAN address the machine has',
    T.localAddresses().every((h) => T.certificateCoversHost(a.cert, h)), a.hosts)

  // Re-issuing on every boot would invalidate every till's pin.
  const again = await T.ensureBranchCert(dirA)
  t('restarting does not issue a new one', again.fingerprint === a.fingerprint)

  const b = await T.ensureBranchCert(tmp())
  t('a different machine gets a different certificate', b.fingerprint !== a.fingerprint)

  console.log('\n— a client only accepts what it pinned —')
  const server = https.createServer({ cert: a.cert, key: a.key }, (_q, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"ok":true}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const connect = (opts) =>
    new Promise((resolve) => {
      const s = tls.connect(
        { host: '127.0.0.1', port, checkServerIdentity: () => undefined, ...opts },
        () => { s.destroy(); resolve('accepted') }
      )
      s.on('error', (e) => resolve(e.code || 'refused'))
    })

  t('a client that trusts nobody in particular refuses it',
    (await connect({ rejectUnauthorized: true })) !== 'accepted')
  t('a client pinned to this certificate accepts it',
    (await connect({ rejectUnauthorized: true, ca: [a.cert] })) === 'accepted')
  t('a client pinned to a different certificate refuses it',
    (await connect({ rejectUnauthorized: true, ca: [b.cert] })) !== 'accepted')

  // How a till reads the fingerprint before it has anything to trust.
  const seen = await new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const cert = s.getPeerX509Certificate()
      s.destroy()
      resolve(cert ? cert.fingerprint256 : null)
    })
    s.on('error', () => resolve(null))
  })
  t('an unpaired till can read the fingerprint without trusting it',
    T.fingerprintsMatch(seen, a.fingerprint), seen)

  console.log('\n— comparing fingerprints —')
  t('the same fingerprint written two ways compares equal',
    T.fingerprintsMatch(a.fingerprint, a.fingerprint.replace(/:/g, '').toLowerCase()))
  t('a truncated fingerprint does not match',
    !T.fingerprintsMatch(a.fingerprint.slice(0, 20), a.fingerprint))
  t('two empty strings do not match each other', !T.fingerprintsMatch('', ''))
  t('a fingerprint of the wrong length is rejected outright',
    !T.fingerprintsMatch('AB'.repeat(20), 'AB'.repeat(20)))
  t('one certificate does not match another', !T.fingerprintsMatch(a.fingerprint, b.fingerprint))
  t('a fingerprint derived from the PEM agrees',
    T.fingerprintOfPem(a.cert) === a.fingerprint)
  t('rubbish in place of a certificate yields nothing, rather than throwing',
    T.fingerprintOfPem('not a certificate') === null)

  server.close()
  console.log(`\n${pass} passed, ${fail} failed`)
  fs.rmSync(buildDir, { recursive: true, force: true })
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => { console.error(e); process.exit(1) })
