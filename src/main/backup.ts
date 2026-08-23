// Local Postgres backup runner.
//
// Runs `pg_dump` against the configured DATABASE_URL, gzips the output, and
// writes to `~/Cashlio Backups/<branchName>/cashlio-YYYYMMDD-HHmm.sql.gz`.
// Designed to be called from a daily timer (24h since last backup) and
// on-demand from the Settings UI.
//
// Assumes `pg_dump` is on PATH. If not, set BACKUP_PG_DUMP_PATH in .env.
//
// Retention: keeps the most recent 30 backups; older files are pruned each
// time a new backup completes successfully.

import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { prisma } from './prisma'

const RETENTION_COUNT = 30
const FILE_PREFIX = 'cashlio-'
const FILE_SUFFIX = '.sql.gz'



const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_\- ]+/g, '').trim() || 'branch'

function pad2(n: number): string { return n < 10 ? `0${n}` : `${n}` }
function fileNameForNow(d = new Date()): string {
  const stamp =
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-` +
    `${pad2(d.getHours())}${pad2(d.getMinutes())}`
  return `${FILE_PREFIX}${stamp}${FILE_SUFFIX}`
}

/**
 * Take the password out of a Postgres URL so it can be passed by environment
 * instead of on the command line. Returns the URL unchanged if there is none
 * (peer or trust authentication, or a password already in ~/.pgpass).
 */
function splitPassword(dbUrl: string): { url: string; password: string | null } {
  try {
    const u = new URL(dbUrl)
    if (!u.password) return { url: dbUrl, password: null }
    const password = decodeURIComponent(u.password)
    u.password = ''
    return { url: u.toString(), password }
  } catch {
    // Not a URL we can parse — hand it over untouched rather than mangling a
    // connection string that works.
    return { url: dbUrl, password: null }
  }
}

export async function getBackupDir(): Promise<string> {
  let branchName = 'branch'
  try {
    const cfg = await prisma.shopConfig.findFirst()
    if (cfg?.branchName) branchName = cfg.branchName
  } catch {
    // ShopConfig may not exist yet (pre-setup). Fall back to default.
  }
  const dir = path.join(app.getPath('home'), 'Cashlio Backups', sanitize(branchName))
  fs.mkdirSync(dir, { recursive: true })
  // A dump is the whole shop: every customer, every price, every password
  // hash. It was landing in the home directory at whatever the umask gave —
  // typically readable by any account on the machine, and squarely inside the
  // folders that consumer cloud-sync tools back up by default. Owner-only.
  try {
    fs.chmodSync(dir, 0o700)
  } catch {
    // Some filesystems (a network or FAT-formatted backup drive) don't carry
    // POSIX modes. Nothing to be done there; the backup itself still runs.
  }
  return dir
}

export type BackupFile = {
  filename: string
  fullPath: string
  sizeBytes: number
  createdAt: string  // ISO
}

export async function listBackups(): Promise<BackupFile[]> {
  const dir = await getBackupDir()
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(FILE_SUFFIX))
  return files
    .map((f) => {
      const fp = path.join(dir, f)
      const stat = fs.statSync(fp)
      return { filename: f, fullPath: fp, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export type BackupStatus = {
  dir: string
  count: number
  lastBackupAt: string | null
  totalSizeBytes: number
  pgDumpAvailable: boolean
}

async function checkPgDump(): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = process.env.BACKUP_PG_DUMP_PATH || 'pg_dump'
    const child = spawn(cmd, ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const dir = await getBackupDir()
  const files = await listBackups()
  return {
    dir,
    count: files.length,
    lastBackupAt: files[0]?.createdAt ?? null,
    totalSizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    pgDumpAvailable: await checkPgDump()
  }
}

async function pruneOldBackups(dir: string): Promise<number> {
  const all = (await listBackups())
  // Keep RETENTION_COUNT most-recent (already sorted desc by createdAt).
  const toRemove = all.slice(RETENTION_COUNT)
  let removed = 0
  for (const f of toRemove) {
    try {
      fs.unlinkSync(f.fullPath)
      removed++
    } catch (e) {
      console.error('[backup] failed to prune', f.fullPath, e)
    }
  }
  if (removed > 0) console.log(`[backup] pruned ${removed} old backup(s) in ${dir}`)
  return removed
}

export type BackupResult =
  | { ok: true; filename: string; fullPath: string; sizeBytes: number; durationMs: number }
  | { ok: false; error: string }

let backupInProgress = false

export async function runBackup(): Promise<BackupResult> {
  if (backupInProgress) return { ok: false, error: 'BACKUP_ALREADY_RUNNING' }
  backupInProgress = true

  const started = Date.now()
  try {
    const dbUrl = process.env.DATABASE_URL
    if (!dbUrl) return { ok: false, error: 'DATABASE_URL_MISSING' }

    if (!(await checkPgDump())) {
      return { ok: false, error: 'PG_DUMP_NOT_FOUND' }
    }

    const dir = await getBackupDir()
    const filename = fileNameForNow()
    const fullPath = path.join(dir, filename)
    const tmpPath = `${fullPath}.partial`

    const cmd = process.env.BACKUP_PG_DUMP_PATH || 'pg_dump'
    // The connection string carries the database password, and an argument
    // vector is public: `ps` shows it to every account on the machine for as
    // long as the dump runs, twice a day. Postgres reads the same URL from
    // the environment, which is not listed to other users.
    const { url: safeUrl, password } = splitPassword(dbUrl)
    // --no-owner / --no-acl makes restores portable across users; --clean
    // includes DROPs so a restore can fully replace the existing schema.
    const child = spawn(cmd, ['--no-owner', '--no-acl', '--clean', '--if-exists', safeUrl], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: password ? { ...process.env, PGPASSWORD: password } : process.env
    })

    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })

    // Owner-only from the moment it exists, rather than chmod-ed afterwards —
    // a dump is readable for as long as it is being written.
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 })
    const gz = createGzip()

    const exitPromise = new Promise<number>((resolve, reject) => {
      child.on('error', (e) => reject(e))
      child.on('exit', (code) => resolve(code ?? -1))
    })

    try {
      await Promise.all([
        pipeline(child.stdout, gz, out),
        exitPromise.then((code) => {
          if (code !== 0) throw new Error(`pg_dump exited ${code}: ${stderr.trim().slice(0, 500)}`)
        })
      ])
    } catch (e) {
      try { fs.unlinkSync(tmpPath) } catch {}
      const msg = e instanceof Error ? e.message : 'PG_DUMP_FAILED'
      console.error('[backup] failed:', msg)
      return { ok: false, error: msg }
    }

    // Atomic-ish rename so partial files never look like real backups.
    fs.renameSync(tmpPath, fullPath)
    try {
      fs.chmodSync(fullPath, 0o600)
    } catch {
      // See getBackupDir: not every filesystem carries modes.
    }

    const sizeBytes = fs.statSync(fullPath).size
    const durationMs = Date.now() - started
    console.log(`[backup] wrote ${filename} (${(sizeBytes / 1024).toFixed(1)} KB) in ${durationMs}ms`)

    // Best-effort prune; don't let pruning failures fail the backup.
    pruneOldBackups(dir).catch((e) => console.error('[backup] prune error', e))

    return { ok: true, filename, fullPath, sizeBytes, durationMs }
  } finally {
    backupInProgress = false
  }
}

// Schedule: kick a backup if last one is older than 24h, then re-check every 6h.
let scheduleTimer: NodeJS.Timeout | null = null

export function startBackupSchedule(): void {
  if (scheduleTimer) return
  const tick = async (): Promise<void> => {
    try {
      const status = await getBackupStatus()
      const last = status.lastBackupAt ? new Date(status.lastBackupAt).getTime() : 0
      const ageHrs = (Date.now() - last) / (1000 * 60 * 60)
      if (ageHrs >= 24) {
        console.log(`[backup] auto-running (last backup ${last ? `${ageHrs.toFixed(1)}h ago` : 'never'})`)
        const r = await runBackup()
        if (!r.ok) console.error('[backup] auto-run failed:', r.error)
      }
    } catch (e) {
      console.error('[backup] schedule tick error', e)
    }
  }
  // Run once shortly after startup so we don't slow boot, then every 6h.
  setTimeout(() => { void tick() }, 60_000)
  scheduleTimer = setInterval(() => { void tick() }, 6 * 60 * 60 * 1000)
}
