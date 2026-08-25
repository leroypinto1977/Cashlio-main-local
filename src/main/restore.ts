// Reading a backup back.
//
// A backup nobody has ever restored is a file, not a backup. Everything here
// exists to close that gap: a manifest written beside every dump saying what
// went into it, a verification that reads the dump back and checks it still
// says the same thing, and a restore — first into a scratch database where it
// is safe to find out it does not work, and only then over the real one.

import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { createGunzip } from 'node:zlib'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { prisma } from './prisma'
import { pgToolUrl, pgToolUrlFor, pgEnv } from './pgUrl'

export { pgToolUrl, pgToolUrlFor } from './pgUrl'


/** Written beside each dump. Without it a dump can only be checked for being
 *  well-formed, not for being complete. */
export type BackupManifest = {
  filename: string
  createdAt: string
  sizeBytes: number
  sha256: string
  /** Exact row counts at the moment the dump was taken. */
  counts: Record<string, number>
  /** The last migration applied, so a dump is never restored into a schema
   *  that has moved on without anybody noticing. */
  migration: string | null
}

export const MANIFEST_SUFFIX = '.json'

export function manifestPathFor(dumpPath: string): string {
  return dumpPath + MANIFEST_SUFFIX
}

// ─── What is in the database right now ───────────────────────────────────────

/**
 * Exact row counts for every table in the public schema.
 *
 * Exact, not `n_live_tup` from pg_stat: the estimate is what autovacuum last
 * saw, and a backup verified against an estimate proves nothing.
 */
export async function liveRowCounts(): Promise<Record<string, number>> {
  const tables = await prisma.$queryRawUnsafe<Array<{ tablename: string }>>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename NOT LIKE '\\_prisma%'
      ORDER BY tablename`
  )
  if (tables.length === 0) return {}
  const union = tables
    .map((t) => `SELECT '${t.tablename}' AS t, count(*)::bigint AS n FROM "${t.tablename}"`)
    .join(' UNION ALL ')
  const rows = await prisma.$queryRawUnsafe<Array<{ t: string; n: bigint }>>(union)
  const out: Record<string, number> = {}
  for (const r of rows) out[r.t] = Number(r.n)
  return out
}

async function lastMigration(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM "_prisma_migrations"
        WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
    )
    return rows[0]?.migration_name ?? null
  } catch {
    return null
  }
}

export function sha256Of(filePath: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

/** Writes the manifest for a dump that has just been taken. */
export async function writeManifest(dumpPath: string): Promise<BackupManifest> {
  const manifest: BackupManifest = {
    filename: path.basename(dumpPath),
    createdAt: new Date().toISOString(),
    sizeBytes: fs.statSync(dumpPath).size,
    sha256: sha256Of(dumpPath),
    counts: await liveRowCounts(),
    migration: await lastMigration()
  }
  fs.writeFileSync(manifestPathFor(dumpPath), JSON.stringify(manifest, null, 2), { mode: 0o600 })
  return manifest
}

export function readManifest(dumpPath: string): BackupManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPathFor(dumpPath), 'utf8')) as BackupManifest
  } catch {
    return null
  }
}

// ─── Reading a dump back ─────────────────────────────────────────────────────

/** pg_dump writes this as its last line. Anything short of it was cut off. */
const COMPLETION_MARKER = 'PostgreSQL database dump complete'

export type DumpScan = {
  /** Rows inside each COPY block — what the dump would actually restore. */
  counts: Record<string, number>
  /** False when the dump stops before pg_dump's own end marker. */
  complete: boolean
  bytesRead: number
}

/**
 * Streams a gzipped dump and counts what is in it, without restoring anything.
 *
 * Cheap enough to run after every backup, and it catches the failure that
 * matters most: a dump that gzips cleanly, opens cleanly, and is missing half
 * the shop because pg_dump died partway and the pipe closed tidily.
 */
export async function scanDump(dumpPath: string): Promise<DumpScan> {
  const counts: Record<string, number> = {}
  let complete = false
  let bytesRead = 0

  let copyTable: string | null = null
  let carry = ''

  const consume = (chunk: Buffer): void => {
    bytesRead += chunk.length
    const text = carry + chunk.toString('utf8')
    const lines = text.split('\n')
    // The last piece may be half a line; hold it for the next chunk.
    carry = lines.pop() ?? ''
    for (const line of lines) {
      if (copyTable !== null) {
        if (line === '\\.') {
          copyTable = null
        } else {
          counts[copyTable] = (counts[copyTable] ?? 0) + 1
        }
        continue
      }
      if (line.startsWith('COPY ')) {
        // COPY public."Bill" (...) FROM stdin;
        const m = line.match(/^COPY\s+(?:[\w"]+\.)?"?([A-Za-z0-9_]+)"?\s*\(/)
        if (m) {
          copyTable = m[1]
          if (counts[copyTable] === undefined) counts[copyTable] = 0
        }
        continue
      }
      if (line.includes(COMPLETION_MARKER)) complete = true
    }
  }

  // The gunzip has to be a middle stage with a real sink on the end. Reading
  // it with a 'data' listener instead lets the pipeline resolve when the file
  // ends, before the decompressor has flushed — so a truncated dump reports
  // success and then crashes the process with an unhandled error event a tick
  // later. Which is a memorable way to find out the backup was short.
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      consume(chunk)
      cb()
    }
  })
  await pipeline(fs.createReadStream(dumpPath), createGunzip(), sink)
  if (carry.includes(COMPLETION_MARKER)) complete = true

  return { counts, complete, bytesRead }
}

export type VerifyResult = {
  ok: boolean
  filename: string
  /** Everything that is wrong, so one pass says all of it. */
  problems: string[]
  checkedAt: string
  counts: Record<string, number>
  /** Tables where the dump and the manifest disagree. */
  mismatches: Array<{ table: string; expected: number; found: number }>
  totalRows: number
  hasManifest: boolean
}

/**
 * Reads a dump back and checks it still says what it said when it was written.
 *
 * Four things can be wrong, and they fail differently: the file has rotted on
 * disk, it was truncated, pg_dump gave up partway, or it is simply older than
 * the schema it would be restored into. All four are reported together —
 * finding out about the second one on the next attempt is not much better than
 * not checking.
 */
export async function verifyBackup(dumpPath: string): Promise<VerifyResult> {
  const filename = path.basename(dumpPath)
  const problems: string[] = []
  const manifest = readManifest(dumpPath)

  if (!fs.existsSync(dumpPath)) {
    return {
      ok: false,
      filename,
      problems: ['The file is gone.'],
      checkedAt: new Date().toISOString(),
      counts: {},
      mismatches: [],
      totalRows: 0,
      hasManifest: false
    }
  }

  if (manifest) {
    const actual = sha256Of(dumpPath)
    if (actual !== manifest.sha256) {
      problems.push(
        'The file has changed since it was written. Something has damaged it — a failed copy, a sync tool, a bad disk.'
      )
    }
  }

  let scan: DumpScan
  try {
    scan = await scanDump(dumpPath)
  } catch (e) {
    problems.push(
      `The file could not be read to the end: ${e instanceof Error ? e.message : 'unknown error'}. It is truncated or corrupt.`
    )
    return {
      ok: false,
      filename,
      problems,
      checkedAt: new Date().toISOString(),
      counts: {},
      mismatches: [],
      totalRows: 0,
      hasManifest: !!manifest
    }
  }

  if (!scan.complete) {
    problems.push(
      'The dump stops before its own end marker, so pg_dump did not finish. Whatever is in it is only part of the shop.'
    )
  }

  const mismatches: Array<{ table: string; expected: number; found: number }> = []
  if (manifest) {
    for (const [table, expected] of Object.entries(manifest.counts)) {
      const found = scan.counts[table] ?? 0
      if (found !== expected) mismatches.push({ table, expected, found })
    }
    if (mismatches.length > 0) {
      const worst = mismatches
        .slice()
        .sort((a, b) => Math.abs(b.expected - b.found) - Math.abs(a.expected - a.found))[0]
      problems.push(
        `${mismatches.length} table${mismatches.length === 1 ? '' : 's'} hold fewer rows than when the backup was taken — ${worst.table} has ${worst.found} where it should have ${worst.expected}.`
      )
    }
  } else {
    problems.push(
      'No manifest was written beside this backup, so it can only be checked for being readable, not for being complete. Backups taken from now on carry one.'
    )
  }

  const totalRows = Object.values(scan.counts).reduce((a, b) => a + b, 0)
  return {
    ok: problems.length === 0,
    filename,
    problems,
    checkedAt: new Date().toISOString(),
    counts: scan.counts,
    mismatches,
    totalRows,
    hasManifest: !!manifest
  }
}

// ─── Actually restoring it ───────────────────────────────────────────────────

function psqlPath(): string {
  return process.env.BACKUP_PSQL_PATH || 'psql'
}

export async function checkPsql(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(psqlPath(), ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('exit', (code) => resolve(code === 0))
  })
}

/** Runs one statement against a database, for CREATE/DROP DATABASE. */
function psqlCommand(dbUrl: string, sql: string): Promise<{ ok: boolean; stderr: string }> {
  const { url, password } = pgToolUrl(dbUrl)
  return new Promise((resolve) => {
    const child = spawn(psqlPath(), ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-c', sql, url], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: pgEnv(password)
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => resolve({ ok: false, stderr: e.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, stderr: stderr.trim() }))
  })
}

/** Streams a gzipped dump into psql. */
function psqlRestore(dbUrl: string, dumpPath: string): Promise<{ ok: boolean; stderr: string }> {
  const { url, password } = pgToolUrl(dbUrl)
  return new Promise((resolve) => {
    // ON_ERROR_STOP so a restore that hits a broken statement fails loudly
    // rather than leaving a half-populated database that looks restored.
    const child = spawn(psqlPath(), ['--quiet', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', url], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: pgEnv(password)
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += String(d) })
    child.on('error', (e) => resolve({ ok: false, stderr: e.message }))
    child.on('exit', (code) => resolve({ ok: code === 0, stderr: stderr.trim().slice(0, 2000) }))
    pipeline(fs.createReadStream(dumpPath), createGunzip(), child.stdin).catch(() => {
      // The exit handler reports it; a broken pipe here is the same failure
      // seen from the other end.
    })
  })
}

/** Counts rows in an arbitrary database, for checking what came back. */
async function countsIn(dbUrl: string): Promise<Record<string, number> | null> {
  const { url, password } = pgToolUrl(dbUrl)
  const sql = `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT LIKE '\\_prisma%'`
  const list = await new Promise<string[] | null>((resolve) => {
    const child = spawn(psqlPath(), ['--quiet', '--no-psqlrc', '-t', '-A', '-c', sql, url], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: pgEnv(password)
    })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve(null))
    child.on('exit', (code) =>
      resolve(code === 0 ? out.split('\n').map((s) => s.trim()).filter(Boolean) : null)
    )
  })
  if (!list || list.length === 0) return list ? {} : null

  const union = list.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM "${t}"`).join(' UNION ALL ')
  return new Promise((resolve) => {
    const child = spawn(psqlPath(), ['--quiet', '--no-psqlrc', '-t', '-A', '-F', '|', '-c', union, url], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: pgEnv(password)
    })
    let out = ''
    child.stdout.on('data', (d) => { out += String(d) })
    child.on('error', () => resolve(null))
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null)
      const counts: Record<string, number> = {}
      for (const line of out.split('\n')) {
        const [t, n] = line.trim().split('|')
        if (t && n !== undefined) counts[t] = Number(n)
      }
      resolve(counts)
    })
  })
}

export type RestoreCheck = {
  ok: boolean
  filename: string
  checkedAt: string
  durationMs: number
  problems: string[]
  /** What actually came back, table by table. */
  restored: Record<string, number>
  mismatches: Array<{ table: string; expected: number; found: number }>
  totalRows: number
}

/**
 * Restores a backup into a scratch database and checks what came back.
 *
 * This is the whole point of the phase. Verifying a dump proves it is
 * well-formed and complete; only restoring it proves Postgres will accept it,
 * and that is a different question — an encoding it cannot read, a role that
 * does not exist here, an extension that is not installed. Doing it against a
 * throwaway database means finding that out on a Tuesday afternoon rather than
 * on the worst day the shop has ever had.
 *
 * The scratch database is dropped whether or not the restore worked.
 */
export async function testRestore(dumpPath: string): Promise<RestoreCheck> {
  const started = Date.now()
  const filename = path.basename(dumpPath)
  const problems: string[] = []
  const done = (over: Partial<RestoreCheck> = {}): RestoreCheck => ({
    ok: problems.length === 0,
    filename,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    problems,
    restored: {},
    mismatches: [],
    totalRows: 0,
    ...over
  })

  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    problems.push('DATABASE_URL is not set, so there is nowhere to test a restore.')
    return done()
  }
  if (!(await checkPsql())) {
    problems.push(
      'psql was not found. A backup cannot be read back without it — install the PostgreSQL client tools, or set BACKUP_PSQL_PATH.'
    )
    return done()
  }
  if (!fs.existsSync(dumpPath)) {
    problems.push('The file is gone.')
    return done()
  }

  // A name nobody would pick by hand, so a stray one is obviously ours.
  const scratchName = `cashlio_restore_check_${Date.now()}`
  // CREATE DATABASE cannot run inside the database being created, so it is
  // issued against `postgres`, which every server has.
  const adminUrl = pgToolUrlFor(dbUrl, 'postgres').url
  const scratchUrl = pgToolUrlFor(dbUrl, scratchName).url

  const created = await psqlCommand(adminUrl, `CREATE DATABASE "${scratchName}"`)
  if (!created.ok) {
    problems.push(`A scratch database could not be created: ${created.stderr || 'unknown error'}`)
    return done()
  }

  try {
    const restored = await psqlRestore(scratchUrl, dumpPath)
    if (!restored.ok) {
      problems.push(`Postgres refused the dump: ${restored.stderr || 'unknown error'}`)
      return done()
    }

    const counts = await countsIn(scratchUrl)
    if (!counts) {
      problems.push('The restored database could not be read back.')
      return done()
    }

    const manifest = readManifest(dumpPath)
    const mismatches: Array<{ table: string; expected: number; found: number }> = []
    if (manifest) {
      for (const [table, expected] of Object.entries(manifest.counts)) {
        const found = counts[table] ?? 0
        if (found !== expected) mismatches.push({ table, expected, found })
      }
      if (mismatches.length > 0) {
        const worst = mismatches
          .slice()
          .sort((a, b) => Math.abs(b.expected - b.found) - Math.abs(a.expected - a.found))[0]
        problems.push(
          `The restore came back short: ${worst.table} has ${worst.found} rows where the backup was taken with ${worst.expected}.`
        )
      }
    }

    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0)
    if (totalRows === 0) {
      problems.push('The restore produced an empty database. Nothing would come back from this backup.')
    }
    return done({ restored: counts, mismatches, totalRows })
  } finally {
    // Dropped whichever way it went. A scratch copy of the whole shop is the
    // same data as the real one and has no business outliving the check.
    const dropped = await psqlCommand(adminUrl, `DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`)
    if (!dropped.ok) {
      console.error('[restore] could not drop scratch database', scratchName, dropped.stderr)
    }
  }
}

export type LiveRestoreResult =
  | { ok: true; safetyBackup: string; restored: Record<string, number>; durationMs: number }
  | { ok: false; error: string; message: string; problems?: string[] }

export type LiveRestoreArgs = {
  dumpPath: string
  /** Must equal the branch name. Typing it is the confirmation. */
  confirmation: string
  branchName: string
  /** Takes a dump of the current database before replacing it. */
  takeSafetyBackup: () => Promise<{ ok: boolean; fullPath?: string; error?: string }>
}

/**
 * Replaces the live database with a backup.
 *
 * The order matters more than anything else here. The backup is verified and
 * then restored into a scratch database *before* the real one is touched, so a
 * bad backup can never be the reason a working shop loses its data — which is
 * the way this goes wrong in practice: somebody restores in a panic, and finds
 * out the file was empty after the original is gone.
 *
 * Then a safety dump of what is about to be replaced, because a restore of the
 * wrong file is a mistake somebody should be able to walk back.
 *
 * The caller is expected to stop the server and restart the app afterwards.
 * Prisma's pool is holding connections to tables this is about to drop.
 */
export async function restoreOverLive(args: LiveRestoreArgs): Promise<LiveRestoreResult> {
  const started = Date.now()

  if (args.confirmation.trim() !== args.branchName.trim()) {
    return {
      ok: false,
      error: 'CONFIRMATION_MISMATCH',
      message: `This replaces everything in the database with the contents of that file. Type the branch name — ${args.branchName} — to confirm.`
    }
  }
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) return { ok: false, error: 'NO_DATABASE_URL', message: 'DATABASE_URL is not set.' }
  if (!fs.existsSync(args.dumpPath)) {
    return { ok: false, error: 'NOT_FOUND', message: 'That backup file is gone.' }
  }

  // Prove the backup works before anything is destroyed for it.
  const verified = await verifyBackup(args.dumpPath)
  if (!verified.ok) {
    return {
      ok: false,
      error: 'BACKUP_NOT_VERIFIED',
      message: 'That backup did not pass its own checks, so nothing has been touched.',
      problems: verified.problems
    }
  }
  const rehearsed = await testRestore(args.dumpPath)
  if (!rehearsed.ok) {
    return {
      ok: false,
      error: 'REHEARSAL_FAILED',
      message:
        'That backup could not be restored into a scratch database, so it has not been restored over the real one either.',
      problems: rehearsed.problems
    }
  }

  // What is about to be replaced, kept.
  const safety = await args.takeSafetyBackup()
  if (!safety.ok || !safety.fullPath) {
    return {
      ok: false,
      error: 'SAFETY_BACKUP_FAILED',
      message: `The current database could not be backed up first (${safety.error ?? 'unknown error'}), so nothing has been replaced. A restore that cannot be walked back is not one worth starting.`
    }
  }

  // Let go of the pool: the dump's DROP statements cannot run against tables
  // this process is still holding open.
  await prisma.$disconnect()

  const done = await psqlRestore(dbUrl, args.dumpPath)
  if (!done.ok) {
    return {
      ok: false,
      error: 'RESTORE_FAILED',
      message: `The restore failed partway: ${done.stderr || 'unknown error'}. The database may be in a half-replaced state — restore ${path.basename(safety.fullPath)} to get back to where you were.`
    }
  }

  const counts = (await countsIn(dbUrl)) ?? {}
  return {
    ok: true,
    safetyBackup: path.basename(safety.fullPath),
    restored: counts,
    durationMs: Date.now() - started
  }
}

// ─── Keeping the result where it survives ────────────────────────────────────

/**
 * The last restore check, recorded beside the backups rather than in the
 * database.
 *
 * Deliberately: the database is the thing being tested. A restore check whose
 * only record is inside it tells you nothing on the day the database is what
 * went wrong, and gets replaced by whatever the restore brings back.
 */
export type RestoreCheckRecord = {
  filename: string
  checkedAt: string
  ok: boolean
  totalRows: number
  durationMs: number
  problems: string[]
}

const CHECK_FILE = '.last-restore-check.json'

export function readLastRestoreCheck(dir: string): RestoreCheckRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CHECK_FILE), 'utf8')) as RestoreCheckRecord
  } catch {
    return null
  }
}

export function writeLastRestoreCheck(dir: string, check: RestoreCheck): void {
  const record: RestoreCheckRecord = {
    filename: check.filename,
    checkedAt: check.checkedAt,
    ok: check.ok,
    totalRows: check.totalRows,
    durationMs: check.durationMs,
    problems: check.problems
  }
  try {
    fs.writeFileSync(path.join(dir, CHECK_FILE), JSON.stringify(record, null, 2), { mode: 0o600 })
  } catch (e) {
    console.error('[restore] could not record the check result', e)
  }
}

/** How stale a restore check may get before it stops meaning anything. */
export const RESTORE_CHECK_INTERVAL_DAYS = 7

export function restoreCheckIsDue(record: RestoreCheckRecord | null, now = new Date()): boolean {
  if (!record) return true
  const ageDays = (now.getTime() - new Date(record.checkedAt).getTime()) / (24 * 60 * 60 * 1000)
  // A failed check is retried on the next tick rather than left for a week —
  // it may well have been a transient problem, and if it was not, saying so
  // again is the point.
  return !record.ok || ageDays >= RESTORE_CHECK_INTERVAL_DAYS
}
