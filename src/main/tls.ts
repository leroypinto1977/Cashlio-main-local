import { X509Certificate } from 'crypto'
import fs from 'fs'
import { join } from 'path'
import { networkInterfaces } from 'os'
import selfsigned from 'selfsigned'

/**
 * The certificate the branch server presents to the tills.
 *
 * Everything between a till and this server crossed the shop's Wi-Fi in
 * plain text — the cashier's session token on every request, every customer's
 * phone number, every bill. Anyone able to join that network could read it,
 * and, more to the point, could answer as the server: nothing about a plain
 * HTTP connection tells a till it is talking to the right machine, so a
 * laptop on the same network could hand out prices, take orders, and collect
 * sessions.
 *
 * There is no certificate authority in a shop, so the certificate is one this
 * machine issues itself and the till pins its fingerprint at pairing. That is
 * a stronger guarantee than the public web's, not a weaker one: a pinned
 * certificate is trusted because it is *that* certificate, rather than
 * because some authority vouched for it.
 *
 * Ten years, because the alternative is every till in the shop needing to be
 * re-paired on an afternoon nobody planned for.
 */

const CERT_FILE = 'branch-cert.pem'
const KEY_FILE = 'branch-key.pem'

export type BranchCert = {
  cert: string
  key: string
  /** Uppercase hex, colon-separated — what a till pins and compares. */
  fingerprint: string
  validTo: string
  /** The addresses this certificate is valid for. */
  hosts: string[]
}

/** Every address a till could reasonably reach this machine on. */
export function localAddresses(): string[] {
  const addrs = new Set<string>(['127.0.0.1'])
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (info.family === 'IPv4' && !info.internal) addrs.add(info.address)
    }
  }
  return [...addrs]
}

async function generate(hosts: string[]): Promise<{ cert: string; key: string }> {
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Cashlio Branch Server' }],
    {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: notAfter,
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true
        },
        { name: 'extKeyUsage', serverAuth: true },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            // A shop's server has whatever address its router handed out, and
            // that can change. Naming every current address keeps the
            // certificate usable without regenerating it — and if the address
            // does move, `certificateCoversHost` below notices.
            ...hosts.map((ip) => ({ type: 7 as const, ip }))
          ]
        }
      ]
    }
  )
  return { cert: pems.cert, key: pems.private }
}

/** True when the stored certificate still names the address given. */
export function certificateCoversHost(cert: string, host: string): boolean {
  try {
    const san = new X509Certificate(cert).subjectAltName ?? ''
    return san.split(',').some((entry) => entry.trim().endsWith(host))
  } catch {
    return false
  }
}

/**
 * Load this machine's certificate, creating one the first time.
 *
 * Regenerating is a real cost — every paired till has the old fingerprint and
 * would refuse to connect — so it only happens when there is no certificate,
 * when the stored one has expired, or when the machine has picked up an
 * address the certificate doesn't cover.
 */
export async function ensureBranchCert(userDataDir: string): Promise<BranchCert> {
  const certPath = join(userDataDir, CERT_FILE)
  const keyPath = join(userDataDir, KEY_FILE)
  const hosts = localAddresses()

  let cert: string | null = null
  let key: string | null = null
  try {
    cert = fs.readFileSync(certPath, 'utf8')
    key = fs.readFileSync(keyPath, 'utf8')
  } catch {
    // Not created yet.
  }

  let reason: string | null = null
  if (!cert || !key) {
    reason = 'no certificate yet'
  } else {
    try {
      const x = new X509Certificate(cert)
      if (new Date(x.validTo).getTime() < Date.now()) reason = 'certificate expired'
      else {
        const missing = hosts.filter((h) => !certificateCoversHost(cert!, h))
        // localhost always works; only a genuinely new LAN address matters.
        if (missing.length > 0) reason = `machine reachable on a new address (${missing.join(', ')})`
      }
    } catch {
      reason = 'certificate unreadable'
    }
  }

  if (reason) {
    console.log(`[tls] issuing a new branch certificate — ${reason}`)
    const made = await generate(hosts)
    cert = made.cert
    key = made.key
    fs.writeFileSync(certPath, cert, { mode: 0o600 })
    // The private key is the whole point. Owner-only, and never leaves here.
    fs.writeFileSync(keyPath, key, { mode: 0o600 })
  }

  const x = new X509Certificate(cert!)
  return {
    cert: cert!,
    key: key!,
    fingerprint: x.fingerprint256,
    validTo: x.validTo,
    hosts
  }
}

/**
 * The SHA-256 fingerprint of a PEM certificate.
 *
 * Electron reports the certificate it was offered as `sha256/<base64>`, which
 * doesn't compare against the colon-hex everything else here uses. Deriving it
 * from the certificate itself sidesteps the formatting question entirely.
 */
export function fingerprintOfPem(pem: string): string | null {
  try {
    return new X509Certificate(pem).fingerprint256
  } catch {
    return null
  }
}

/** Normalises a fingerprint so two spellings of the same one compare equal. */
export function normalizeFingerprint(fp: string): string {
  return (fp || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

export function fingerprintsMatch(a: string, b: string): boolean {
  const x = normalizeFingerprint(a)
  const y = normalizeFingerprint(b)
  return x.length === 64 && x === y
}
