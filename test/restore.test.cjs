/**
 * Reading a backup back.
 *
 * These run a real pg_dump, a real psql and a real Postgres, because that is
 * the only way to answer the question the phase is about. A backup path
 * checked against a mock is in exactly the state this exists to fix.
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/cashlio_restore?schema=public'

const path = require('path')
const fs = require('fs')
const os = require('os')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { PrismaClient } = require('@prisma/client')

// The backup runner asks Electron where the user's home directory is. Nothing
// else about it needs Electron, so it is stood in for and the real runner is
// exercised — including the part that hands a URL to pg_dump, which is where
// this all went wrong.
const Module = require('module')
const backupHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cashlio-home-'))
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return 'electron-stub'
  return origResolve.call(this, request, ...rest)
}
require.cache['electron-stub'] = {
  id: 'electron-stub', filename: 'electron-stub', loaded: true,
  exports: { app: { getPath: () => backupHome } }
}

const R = require(path.join(__dirname, '..', '.test-build', 'restore.cjs'))
const B = require(path.join(__dirname, '..', '.test-build', 'backup.cjs'))
const prisma = new PrismaClient()

let pass = 0, fail = 0
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail).slice(0, 300)) }
}
const eq = (name, a, b) => t(`${name} (${JSON.stringify(a)} === ${JSON.stringify(b)})`, a === b, { a, b })

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashlio-restore-'))
const dumpPath = path.join(tmp, 'cashlio-20260825-1200.sql.gz')

/** The real thing: pg_dump, gzipped, exactly as the backup runner writes it —
 *  including running the URL through the same cleanup, because a URL Prisma
 *  accepts is not one pg_dump accepts. */
function takeDump(target = dumpPath) {
  const sql = execFileSync('pg_dump', [
    '--no-owner', '--no-acl', '--clean', '--if-exists', R.pgToolUrl(process.env.DATABASE_URL).url
  ], { maxBuffer: 256 * 1024 * 1024 })
  fs.writeFileSync(target, zlib.gzipSync(sql), { mode: 0o600 })
  return target
}

;(async () => {
  // ── The URL the tools are actually given ─────────────────────────────────
  // Prisma's own connection string is not one libpq will accept, and libpq
  // refuses the whole URL rather than ignoring what it does not know. Every
  // scheduled backup this project has ever run failed on exactly this.
  console.log('\n— the connection string the tools are given —')
  {
    const base = 'postgresql://u:p@localhost:5432/shopms_local'
    const p1 = R.pgToolUrl(base + '?schema=public')
    t('the schema parameter is taken off', !p1.url.includes('schema='), p1.url)
    eq('...but remembered', p1.schema, 'public')
    eq('and the password comes out of the URL', p1.password, 'p')
    t('...so it never reaches the argument vector', !p1.url.includes(':p@'), p1.url)

    const p2 = R.pgToolUrl(base + '?schema=public&connection_limit=5&pool_timeout=10&sslmode=require')
    t('every Prisma-only parameter goes', !/schema=|connection_limit=|pool_timeout=/.test(p2.url), p2.url)
    t('and libpq\'s own are left alone', p2.url.includes('sslmode=require'), p2.url)

    // Nothing to strip and no password to lift: handed over exactly as given.
    eq('a URL with nothing to strip is unchanged',
      R.pgToolUrl('postgresql://u@localhost:5432/shopms_local').url,
      'postgresql://u@localhost:5432/shopms_local')
    eq('and one with a password keeps everything but that', R.pgToolUrl(base).url,
      'postgresql://u@localhost:5432/shopms_local')
    eq('and something unparseable is handed over untouched',
      R.pgToolUrl('not a url at all').url, 'not a url at all')
    eq('pointing at another database keeps the rest',
      R.pgToolUrlFor(base + '?schema=public', 'postgres').url,
      'postgresql://u@localhost:5432/postgres')
  }

  // ── A shop with something worth losing ────────────────────────────────────
  await prisma.shopConfig.create({ data: {
    shopName: 'Restore Test Traders', branchName: 'Main', licenseKey: 'RT-1', licenseJwt: 'x',
    gstin: '33AABCS1429B1Z1', stateCode: '33' }})
  const user = await prisma.user.create({ data: {
    username: 'restoreadmin', passwordHash: 'x', role: 'SUPER_ADMIN' }})
  const device = await prisma.authorizedClient.create({ data: {
    friendlyName: 'Till', macAddress: 'RT:00:00:00:00:01', terminalCode: 'R1' }})
  const cat = await prisma.category.create({ data: { name: 'Restore Goods' } })
  const product = await prisma.product.create({ data: {
    itemCode: 'RT-ITEM-001', name: 'Restorable Widget', categoryId: cat.id,
    sellingRate: 100, gstPercentage: 18 }})
  await prisma.productBatch.create({ data: {
    productId: product.id, batchCode: 'B1', uniqueStockCode: 'RT-ITEM-001/B1',
    purchaseRate: 60, receivedQty: 500, currentQty: 500 }})

  // Enough bills that a partial restore would be obvious.
  const BILLS = 40
  for (let i = 0; i < BILLS; i++) {
    await prisma.bill.create({ data: {
      billNumber: `INV-RT-${String(i).padStart(4, '0')}`,
      status: 'PAID', originDeviceId: device.id, cashierId: user.id,
      subtotal: 100, gstAmount: 15.25, totalAmount: 100, taxableValue: 84.75,
      cgstAmount: 7.63, sgstAmount: 7.62, paymentMethod: 'CASH', paidAmount: 100,
      items: { create: [{
        productId: product.id, itemCode: 'RT-ITEM-001', productName: 'Restorable Widget',
        unitOfMeasure: 'pcs', quantity: 1, unitRate: 100, gstPercentage: 18,
        lineGstAmount: 15.25, lineTotal: 100, taxableValue: 84.75,
        cgstAmount: 7.63, sgstAmount: 7.62 }] }
    }})
  }

  console.log('\n— what is in the database —')
  const live = await R.liveRowCounts()
  eq('every bill is counted', live.Bill, BILLS)
  eq('and every line on them', live.BillItem, BILLS)
  eq('the product is there', live.Product, 1)
  t('the counts are exact, not estimates', Number.isInteger(live.Bill), live.Bill)
  t('prisma\'s own bookkeeping is left out', live._prisma_migrations === undefined, Object.keys(live).length)

  // ── A backup, and a manifest that says what went into it ─────────────────
  console.log('\n— taking one, and writing down what is in it —')
  takeDump()
  const manifest = await R.writeManifest(dumpPath)
  eq('the manifest names the file', manifest.filename, 'cashlio-20260825-1200.sql.gz')
  eq('and counts the bills', manifest.counts.Bill, BILLS)
  t('and fingerprints the file', /^[0-9a-f]{64}$/.test(manifest.sha256), manifest.sha256)
  t('and records the schema it came from', typeof manifest.migration === 'string', manifest.migration)
  t('the manifest sits beside the dump', fs.existsSync(dumpPath + '.json'))
  eq('a dump is owner-readable only', fs.statSync(dumpPath).mode & 0o777, 0o600)

  // ── The runner a shop actually uses ──────────────────────────────────────
  // Everything above dumps by calling pg_dump directly. This runs the real
  // backup path end to end, against the DATABASE_URL shape Prisma produces —
  // which is the shape that made every scheduled backup fail.
  console.log('\n— the backup a shop actually runs —')
  {
    t('the URL under test is the Prisma one, query parameter and all',
      process.env.DATABASE_URL.includes('?schema=public'), process.env.DATABASE_URL)

    const result = await B.runBackup()
    t('the backup succeeds', result.ok, result)
    t('and wrote a file', result.ok && fs.existsSync(result.fullPath), result.fullPath)
    t('that is not empty', result.ok && result.sizeBytes > 1000, result.sizeBytes)
    t('and it verified itself on the way out', result.ok && result.verification?.ok === true,
      result.verification?.problems)
    eq('with every bill in it', result.ok ? result.verification.counts.Bill : -1, BILLS)

    const status = await B.getBackupStatus()
    eq('the status counts it', status.count, 1)
    t('and knows nothing has been read back yet', status.lastRestoreCheck === null, status.lastRestoreCheck)
    t('...so a check is due', status.restoreCheckDue === true, status)

    // The scheduled weekly rehearsal, run by hand.
    const rehearsal = await R.testRestore(result.fullPath)
    t('the backup a shop just took restores', rehearsal.ok, rehearsal.problems)
    R.writeLastRestoreCheck(status.dir, rehearsal)
    const after = await B.getBackupStatus()
    t('and the status remembers that it did', after.lastRestoreCheck?.ok === true, after.lastRestoreCheck)
    t('...so nothing is due', after.restoreCheckDue === false, after.restoreCheckDue)
  }

  // ── Reading it back without restoring ────────────────────────────────────
  console.log('\n— reading it back —')
  const scan = await R.scanDump(dumpPath)
  eq('the dump holds every bill', scan.counts.Bill, BILLS)
  eq('and every line', scan.counts.BillItem, BILLS)
  t('and reaches pg_dump\'s own end marker', scan.complete)

  const good = await R.verifyBackup(dumpPath)
  t('a real backup verifies', good.ok, good.problems)
  eq('with nothing to report', good.problems.length, 0)
  eq('and the rows it would restore', good.counts.Bill, BILLS)

  // ── The four ways a backup is worthless ──────────────────────────────────
  console.log('\n— and the ways it is not a backup —')
  {
    // 1. Truncated: the tail is missing, and gunzip cannot finish.
    const cut = path.join(tmp, 'truncated.sql.gz')
    const whole = fs.readFileSync(dumpPath)
    fs.writeFileSync(cut, whole.subarray(0, Math.floor(whole.length * 0.6)))
    fs.copyFileSync(dumpPath + '.json', cut + '.json')
    const v = await R.verifyBackup(cut)
    t('a truncated dump is refused', !v.ok, v.problems)
    t('...saying it could not be read to the end',
      v.problems.some((p) => /read to the end|truncated/i.test(p)), v.problems)
  }
  {
    // 2. Rotted on disk: still opens, no longer what was written.
    const rotted = path.join(tmp, 'rotted.sql.gz')
    const sql = zlib.gunzipSync(fs.readFileSync(dumpPath)).toString('utf8')
    fs.writeFileSync(rotted, zlib.gzipSync(sql.replace('Restorable Widget', 'Corrupted Widget')))
    fs.copyFileSync(dumpPath + '.json', rotted + '.json')
    const v = await R.verifyBackup(rotted)
    t('a file that changed after it was written is refused', !v.ok, v.problems)
    t('...saying something damaged it',
      v.problems.some((p) => /changed since it was written/i.test(p)), v.problems)
  }
  {
    // 3. pg_dump gave up partway: gzips cleanly, opens cleanly, half a shop.
    //    This is the one that looks exactly like a good backup.
    const short = path.join(tmp, 'short.sql.gz')
    const sql = zlib.gunzipSync(fs.readFileSync(dumpPath)).toString('utf8')
    const lines = sql.split('\n')
    const copyAt = lines.findIndex((l) => l.startsWith('COPY public."Bill" '))
    const endAt = lines.indexOf('\\.', copyAt)
    // Drop half the bills out of the middle of the COPY block.
    lines.splice(copyAt + 1, Math.floor(BILLS / 2))
    fs.writeFileSync(short, zlib.gzipSync(lines.join('\n')))
    const m = JSON.parse(fs.readFileSync(dumpPath + '.json', 'utf8'))
    m.sha256 = R.sha256Of(short)   // as if it had been written this way
    fs.writeFileSync(short + '.json', JSON.stringify(m))
    t('the doctored dump still opens cleanly', endAt > copyAt)
    const v = await R.verifyBackup(short)
    t('a dump missing half the shop is refused', !v.ok, v.problems)
    t('...naming the table and both counts',
      v.problems.some((p) => /Bill has \d+ where it should have 40/.test(p)), v.problems)
    eq('and the mismatch is reported table by table',
      v.mismatches.find((x) => x.table === 'Bill')?.found, BILLS - Math.floor(BILLS / 2))
  }
  {
    // 4. No manifest: readable, but nothing to check completeness against.
    const bare = path.join(tmp, 'bare.sql.gz')
    fs.copyFileSync(dumpPath, bare)
    const v = await R.verifyBackup(bare)
    t('a dump with no manifest is not called good', !v.ok, v.problems)
    t('...saying it can only be checked for being readable',
      v.problems.some((p) => /not for being complete/i.test(p)), v.problems)
    eq('though it is still read', v.counts.Bill, BILLS)
  }
  {
    const gone = await R.verifyBackup(path.join(tmp, 'never-existed.sql.gz'))
    t('a missing file is refused rather than throwing', !gone.ok && gone.problems.length === 1, gone)
  }

  // ── The part nobody has ever done ────────────────────────────────────────
  console.log('\n— restoring it, for real, into somewhere safe —')
  const check = await R.testRestore(dumpPath)
  t('the backup restores', check.ok, check.problems)
  eq('every bill comes back', check.restored.Bill, BILLS)
  eq('every line on them too', check.restored.BillItem, BILLS)
  eq('the product comes back', check.restored.Product, 1)
  eq('with nothing missing anywhere', check.mismatches.length, 0)
  t('and it took a measurable amount of time', check.durationMs > 0, check.durationMs)
  t('the whole shop came back', check.totalRows >= BILLS * 2, check.totalRows)

  // The scratch database must not outlive the check: it is a second copy of
  // every customer and every price in the shop.
  const leftovers = execFileSync('psql', [
    '-U', process.env.E2E_PG_USER || 'postgres', '-t', '-A',
    '-c', "SELECT datname FROM pg_database WHERE datname LIKE 'cashlio_restore_check_%'"
  ]).toString().trim()
  eq('and leaves no copy of the shop behind', leftovers, '')

  {
    const bad = path.join(tmp, 'not-a-dump.sql.gz')
    fs.writeFileSync(bad, zlib.gzipSync('SELECT this is not valid sql at all;\n'))
    const v = await R.testRestore(bad)
    t('a file that is not a dump does not restore', !v.ok, v.problems)
    t('...and says what Postgres made of it',
      v.problems.some((p) => /refused the dump/i.test(p)), v.problems)
  }

  // ── Refusing to destroy a database for a bad backup ──────────────────────
  console.log('\n— the order that matters —')
  {
    const empty = path.join(tmp, 'empty.sql.gz')
    fs.writeFileSync(empty, zlib.gzipSync('-- nothing here\n'))
    let safetyTaken = false
    const res = await R.restoreOverLive({
      dumpPath: empty, confirmation: 'Main', branchName: 'Main',
      takeSafetyBackup: async () => { safetyTaken = true; return { ok: true, fullPath: '/tmp/x.sql.gz' } }
    })
    t('a backup that fails its checks is not restored', !res.ok, res)
    eq('...for that reason', res.error, 'BACKUP_NOT_VERIFIED')
    t('and the live database is never dumped over for it', safetyTaken === false)
    // The live database is untouched, which is the property that matters.
    eq('every bill is still there', await prisma.bill.count(), BILLS)
  }
  {
    const res = await R.restoreOverLive({
      dumpPath, confirmation: 'main road', branchName: 'Main',
      takeSafetyBackup: async () => { throw new Error('should never be reached') }
    })
    t('a restore without the right confirmation is refused', !res.ok, res)
    eq('...for that reason', res.error, 'CONFIRMATION_MISMATCH')
    t('and the message says what to type', /type the branch name/i.test(res.message), res.message)
  }
  {
    const res = await R.restoreOverLive({
      dumpPath, confirmation: 'Main', branchName: 'Main',
      takeSafetyBackup: async () => ({ ok: false, error: 'disk full' })
    })
    t('a restore that cannot be walked back is refused', !res.ok, res)
    eq('...for that reason', res.error, 'SAFETY_BACKUP_FAILED')
    t('and says why that matters', /cannot be walked back/i.test(res.message), res.message)
    eq('the database is still whole', await prisma.bill.count(), BILLS)
  }

  // ── The real thing, end to end ───────────────────────────────────────────
  console.log('\n— losing the shop, and getting it back —')
  {
    // Trade on after the backup, then lose everything.
    await prisma.bill.create({ data: {
      billNumber: 'INV-RT-AFTER', status: 'PAID', originDeviceId: device.id, cashierId: user.id,
      subtotal: 100, gstAmount: 15.25, totalAmount: 100, taxableValue: 84.75,
      cgstAmount: 7.63, sgstAmount: 7.62, paymentMethod: 'CASH', paidAmount: 100 }})
    eq('a sale is made after the backup', await prisma.bill.count(), BILLS + 1)

    const safetyPath = path.join(tmp, 'safety.sql.gz')
    const res = await R.restoreOverLive({
      dumpPath, confirmation: 'Main', branchName: 'Main',
      takeSafetyBackup: async () => {
        takeDump(safetyPath)
        // The manifest has to be written while the database still holds what
        // the safety copy contains — afterwards it would describe whatever the
        // restore brought back instead.
        await R.writeManifest(safetyPath)
        return { ok: true, fullPath: safetyPath }
      }
    })
    t('the restore runs', res.ok, res)
    eq('and the shop is back as it was at the backup', res.restored.Bill, BILLS)
    t('the safety copy is named so it can be used', res.safetyBackup === 'safety.sql.gz', res.safetyBackup)

    // Prisma was disconnected for the restore; it reconnects on demand.
    eq('the live database really holds the restored rows', await prisma.bill.count(), BILLS)
    const after = await prisma.bill.findFirst({ where: { billNumber: 'INV-RT-AFTER' } })
    eq('and the sale made after the backup is gone, as it must be', after, null)

    // The safety copy is the walk-back, so it has to work too.
    const back = await R.testRestore(safetyPath)
    t('and the safety copy restores in its turn', back.ok, back.problems)
    eq('with the sale that was rolled back still in it', back.restored.Bill, BILLS + 1)
  }

  // ── Knowing when it was last checked ─────────────────────────────────────
  console.log('\n— and remembering that it was checked —')
  {
    eq('nothing checked yet reads as due', R.restoreCheckIsDue(null), true)
    R.writeLastRestoreCheck(tmp, check)
    const rec = R.readLastRestoreCheck(tmp)
    t('the result is recorded', rec !== null && rec.ok === true, rec)
    eq('with what came back', rec.totalRows, check.totalRows)
    eq('a fresh pass is not due again', R.restoreCheckIsDue(rec), false)

    const old = new Date(Date.now() - 8 * 864e5).toISOString()
    eq('a week later it is', R.restoreCheckIsDue({ ...rec, checkedAt: old }), true)
    // A failure is retried on the next tick, not left for a week.
    eq('and a failed check is due immediately', R.restoreCheckIsDue({ ...rec, ok: false }), true)
    t('the record lives beside the backups, not in the database',
      fs.existsSync(path.join(tmp, '.last-restore-check.json')))
  }

  console.log(`\n${pass} passed, ${fail} failed`)
  await prisma.$disconnect()
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
  try { fs.rmSync(backupHome, { recursive: true, force: true }) } catch {}
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error('RESTORE TESTS CRASHED:', e); process.exit(1) })
