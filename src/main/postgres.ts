// The database that ships inside the app.
//
// A shopkeeper cannot be asked to install PostgreSQL before they can open
// their till, so a copy of it travels in the installer and this module owns its
// life: laying down a data directory on first launch, starting the server on a
// private port, applying the migrations, and stopping it cleanly on quit.
//
// Nothing here is a substitute for a real database. It *is* a real PostgreSQL —
// the same binaries the official installer lays down — kept private to this
// application. That matters: the sale path depends on `SELECT … FOR UPDATE`
// row locks and on transaction ids for the sync cursor, and neither exists in
// the embedded databases that would otherwise be the easy answer.

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import { spawnSync } from 'node:child_process'

const DB_NAME = 'cashlio'
const DB_USER = 'cashlio'

/** Where the bundled binaries live, in development and once packaged. */
function binDir(): string | null {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'postgres', 'bin'),
       path.join(process.resourcesPath, 'postgres', platform, 'bin')]
    : [path.join(app.getAppPath(), 'resources', 'postgres', platform, 'bin')]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, process.platform === 'win32' ? 'postgres.exe' : 'postgres'))) return c
  }
  return null
}

const exe = (dir: string, name: string): string =>
  path.join(dir, process.platform === 'win32' ? `${name}.exe` : name)

function dataDir(): string {
  return path.join(app.getPath('userData'), 'pgdata')
}

/** The password is generated once and never leaves this machine. */
function passwordFile(): string {
  return path.join(app.getPath('userData'), '.pgpass-init')
}

function readOrCreatePassword(): string {
  const file = passwordFile()
  try {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim()
  } catch {
    // Unreadable: fall through and write a fresh one. An initialised cluster
    // would then refuse the new password, which surfaces loudly rather than
    // silently connecting as somebody else.
  }
  const pw = crypto.randomBytes(24).toString('base64url')
  fs.writeFileSync(file, pw, { mode: 0o600 })
  return pw
}

/** A port nobody else is on. Asked of the OS rather than guessed. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })
}

/** The port a running cluster is already on, so a restart reuses it. */
function portFile(): string {
  return path.join(app.getPath('userData'), '.pgport')
}

function run(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env
): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8' })
  return {
    ok: r.status === 0,
    stdout: r.stdout ?? '',
    stderr: (r.stderr ?? '') + (r.error ? String(r.error) : '')
  }
}

export type PostgresHandle = {
  url: string
  port: number
  binDir: string
  dataDir: string
}

let handle: PostgresHandle | null = null

/**
 * Brings the bundled database up, and hands back how to reach it.
 *
 * Returns null when no bundled runtime is present — a development checkout
 * pointing at a PostgreSQL the developer installed themselves. The caller
 * keeps whatever DATABASE_URL it already had in that case.
 */
export async function startBundledPostgres(): Promise<PostgresHandle | null> {
  if (handle) return handle
  const bin = binDir()
  if (!bin) {
    console.log('[pg] no bundled PostgreSQL found — using DATABASE_URL as configured')
    return null
  }

  const data = dataDir()
  const password = readOrCreatePassword()
  const initialised = fs.existsSync(path.join(data, 'PG_VERSION'))

  if (!initialised) {
    console.log('[pg] first launch — creating the database')
    fs.mkdirSync(path.dirname(data), { recursive: true })
    const pwFile = path.join(app.getPath('userData'), '.pginit')
    fs.writeFileSync(pwFile, password, { mode: 0o600 })
    // scram-sha-256 for host connections, so nothing on the machine can
    // connect as the shop without the password this app generated. `C` locale
    // and UTF-8 keep initdb from depending on whatever the machine has
    // installed, which is the usual reason it fails on a stranger's computer.
    const init = run(exe(bin, 'initdb'), [
      '-D', data,
      '-U', DB_USER,
      '--pwfile', pwFile,
      '--auth-host=scram-sha-256',
      '--auth-local=trust',
      '--encoding=UTF8',
      '--locale=C'
    ])
    try { fs.unlinkSync(pwFile) } catch { /* best effort */ }
    if (!init.ok) {
      throw new Error(`could not create the database: ${init.stderr.trim().slice(0, 500)}`)
    }
  }

  // Reuse the port a previous run settled on, so a restart does not strand
  // anything that remembered it.
  let port = 0
  try {
    const saved = parseInt(fs.readFileSync(portFile(), 'utf8').trim(), 10)
    if (Number.isFinite(saved) && saved > 0) port = saved
  } catch { /* first run */ }
  if (!port) port = await freePort()
  fs.writeFileSync(portFile(), String(port))

  const logFile = path.join(app.getPath('userData'), 'postgres.log')
  // -h 127.0.0.1 binds to the loopback only: the shop's database is not on the
  // shop's Wi-Fi. Tills reach the shop through the Express server, which has
  // its own TLS and pairing, not through this.
  const start = run(exe(bin, 'pg_ctl'), [
    '-D', data, '-l', logFile, '-w', '-t', '30',
    '-o', `-p ${port} -h 127.0.0.1`,
    'start'
  ])
  if (!start.ok && !/already running/i.test(start.stdout + start.stderr)) {
    const tail = (() => {
      try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-8).join('\n') } catch { return '' }
    })()
    throw new Error(`the database would not start: ${start.stderr.trim().slice(0, 300)}\n${tail}`)
  }

  const adminUrl = `postgresql://${DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`
  const exists = run(exe(bin, 'psql'), ['-t', '-A', '-c',
    `SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'`, adminUrl])
  if (exists.ok && exists.stdout.trim() !== '1') {
    const created = run(exe(bin, 'psql'), ['-c', `CREATE DATABASE "${DB_NAME}"`, adminUrl])
    if (!created.ok) throw new Error(`could not create the shop database: ${created.stderr.trim().slice(0, 300)}`)
  }

  const url = `postgresql://${DB_USER}:${encodeURIComponent(password)}@127.0.0.1:${port}/${DB_NAME}?schema=public`
  handle = { url, port, binDir: bin, dataDir: data }

  // Everything downstream reads these. The backup path in particular shells
  // out to pg_dump and psql by name, and on a machine with no PostgreSQL
  // installed there is no name to find — which is how a backup schedule ends
  // up never once producing a backup.
  process.env.DATABASE_URL = url
  process.env.BACKUP_PG_DUMP_PATH = exe(bin, 'pg_dump')
  process.env.BACKUP_PSQL_PATH = exe(bin, 'psql')

  console.log(`[pg] running on 127.0.0.1:${port}`)
  return handle
}

export function stopBundledPostgres(): void {
  if (!handle) return
  const { binDir: bin, dataDir: data } = handle
  handle = null
  // -m fast rolls back anything open and shuts down rather than waiting for
  // clients to disconnect politely, which they will not do while quitting.
  const r = run(exe(bin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'])
  console.log(r.ok ? '[pg] stopped' : `[pg] stop reported: ${r.stderr.trim().slice(0, 200)}`)
}

/** Kept for the migration runner, which needs the tools without the URL. */
export function currentHandle(): PostgresHandle | null {
  return handle
}
