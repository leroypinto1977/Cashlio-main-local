import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Record whatever kills the main process, before anything else can hide it.
 *
 * A failure during module loading — a missing native module, a bad import —
 * is reported by Electron as a modal and nothing else. When the app is opened
 * from Finder, which is how it is always opened, stderr goes nowhere, so the
 * only record of the fault is a dialog somebody has to photograph. Three
 * separate startup faults in this app were diagnosed that way.
 *
 * This file exists, rather than a function in index.ts, because of when it
 * runs. Imports are evaluated before any statement in the module that names
 * them, so a handler registered in the body of index.ts is registered *after*
 * every import has already had its chance to throw — which is precisely when
 * these failures happen. Importing this first is what makes it early enough.
 */
function write(label: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  const line = `[${new Date().toISOString()}] ${label}\n${detail}\n\n`
  // The home directory, not userData: this has to work when the failure is in
  // Electron's own startup, and it has to be somewhere a shopkeeper can find
  // when they are asked for it over the phone.
  for (const target of [
    path.join(os.homedir(), 'cashlio-startup-error.log'),
    path.join(os.tmpdir(), 'cashlio-startup-error.log')
  ]) {
    try {
      fs.appendFileSync(target, line)
    } catch {
      // Try the next location. Logging must never be the thing that fails.
    }
  }
  try {
    process.stderr.write(line)
  } catch {
    // No stderr when launched from Finder. The files above are the point.
  }
}

process.on('uncaughtException', (err) => write('uncaughtException', err))
process.on('unhandledRejection', (err) => write('unhandledRejection', err))
