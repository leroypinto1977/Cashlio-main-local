import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { networkInterfaces, platform } from 'os'
import fs from 'fs'
import { join } from 'path'

/**
 * A stable identifier for the machine this branch server runs on.
 *
 * The licence used to be bound to whatever `os.networkInterfaces()` happened
 * to return first. That is not stable: a laptop with both Wi-Fi and Ethernet
 * can hand back either depending on which came up first, so the same machine
 * could report two different identities across two boots and fail its own
 * hardware check. Plugging in a dock or starting a VPN did the same thing.
 *
 * Each platform publishes something better — an identity tied to the machine
 * rather than to a network adapter:
 *
 *   macOS    IOPlatformUUID from the I/O registry
 *   Windows  MachineGuid from the registry
 *   Linux    /etc/machine-id
 *
 * What comes back is hashed before it leaves this process. The licence server
 * needs to tell installations apart, not know a customer's platform UUID, and
 * a leaked licence database should not hand anybody a list of real machine
 * identifiers.
 *
 * Worth being straight about the limit: this is supplied by software running
 * on the customer's own machine, so somebody determined can make it say
 * whatever they like. What it buys is that casually copying an installation
 * onto a second machine stops working, and that the seller can see how many
 * machines a licence is actually running on. It is a lock on the door, not a
 * vault.
 */

const SALT = 'cashlio.machine.v1'

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** The platform's own machine identity, before hashing. */
function rawPlatformId(): string | null {
  const os = platform()

  if (os === 'darwin') {
    const out = run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const m = out?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    return m?.[1] ?? null
  }

  if (os === 'win32') {
    const out = run('reg', [
      'query',
      'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
      '/v',
      'MachineGuid',
      '/reg:64'
    ])
    const m = out?.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
    return m?.[1] ?? null
  }

  for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim()
      if (v) return v
    } catch {
      // Try the next one.
    }
  }
  return null
}

/**
 * Last resort when the platform gives us nothing: every non-internal MAC,
 * sorted, so the answer doesn't depend on the order the adapters came up in.
 * Still not great — unplugging an adapter changes it — which is why it is
 * only reached for when there is no platform identity, and why the result is
 * written to disk below so it survives the hardware moving around.
 */
function macFallback(): string {
  const macs: string[] = []
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') macs.push(info.mac)
    }
  }
  return macs.sort().join(',') || 'unknown-machine'
}

let cached: string | null = null

/**
 * The identifier this installation reports to the licence server.
 *
 * `userDataDir` is where the answer is remembered. Once a machine has told the
 * licence server who it is, changing its mind — because a network card was
 * swapped, or the platform command failed once — would read as a different
 * machine and fail the hardware check on a shop that had done nothing wrong.
 */
export function getMachineId(userDataDir?: string): string {
  if (cached) return cached

  const file = userDataDir ? join(userDataDir, 'machine.id') : null
  if (file) {
    try {
      const saved = fs.readFileSync(file, 'utf8').trim()
      if (/^[0-9a-f]{64}$/.test(saved)) {
        cached = saved
        return saved
      }
    } catch {
      // Not written yet, or unreadable — derive it below.
    }
  }

  const raw = rawPlatformId() ?? macFallback()
  const id = createHash('sha256').update(`${SALT}:${platform()}:${raw}`).digest('hex')

  if (file) {
    try {
      fs.writeFileSync(file, id, { mode: 0o600 })
    } catch (e) {
      // A machine that cannot remember its own id still works; it just
      // re-derives it each boot, which is what we did before.
      console.error('[machine] could not persist the machine id:', e)
    }
  }

  cached = id
  return id
}

/** Test seam: forget the memoised value so a different source can be read. */
export function resetMachineIdCache(): void {
  cached = null
}

/**
 * This machine's MAC, as the shop's network sees it.
 *
 * Distinct from `getMachineId` above and not a substitute for it: this says
 * which box on the LAN, which is what a till is paired against. Licensing
 * uses the machine identity instead, because a MAC moves when a network card
 * does.
 */
export function getServerMac(): string {
  for (const iface of Object.values(networkInterfaces())) {
    for (const info of iface ?? []) {
      if (!info.internal && info.mac && info.mac !== '00:00:00:00:00:00') {
        return info.mac
      }
    }
  }
  return '00:00:00:00:00:00'
}
