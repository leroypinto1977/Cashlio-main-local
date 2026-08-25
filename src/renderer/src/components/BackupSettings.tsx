import { useState, useEffect, useCallback } from 'react'
import {
  Database,
  FolderOpen,
  Play,
  AlertTriangle,
  CheckCircle2,
  ShieldCheck,
  RotateCcw,
  Undo2
} from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal } from './Modal'

type RestoreCheckRecord = {
  filename: string
  checkedAt: string
  ok: boolean
  totalRows: number
  durationMs: number
  problems: string[]
}

type BackupStatus = {
  dir: string
  count: number
  lastBackupAt: string | null
  totalSizeBytes: number
  pgDumpAvailable: boolean
  lastRestoreCheck: RestoreCheckRecord | null
  restoreCheckDue: boolean
}

type RestoreCheck = {
  ok: boolean
  filename: string
  problems: string[]
  totalRows: number
  durationMs: number
  restored: Record<string, number>
}

type LiveRestoreResult =
  | { ok: true; safetyBackup: string; restored: Record<string, number> }
  | { ok: false; error: string; message: string; problems?: string[] }

type BackupFile = {
  filename: string
  fullPath: string
  sizeBytes: number
  createdAt: string
}

type RunResult =
  | { ok: true; filename: string; sizeBytes: number; durationMs: number }
  | { ok: false; error: string }

const ipc = () => {
  // The preload exposes @electron-toolkit/preload's electronAPI which wraps
  // ipcRenderer. Calls go through window.electron.ipcRenderer.invoke.
  return (window as unknown as {
    electron: { ipcRenderer: { invoke: (ch: string, ...a: unknown[]) => Promise<unknown> } }
  }).electron.ipcRenderer
}

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

const fmtAge = (iso: string | null): string => {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min} min ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`
  const d = Math.floor(hr / 24)
  return `${d} day${d === 1 ? '' : 's'} ago`
}

const ERR_LABEL: Record<string, string> = {
  PG_DUMP_NOT_FOUND: 'pg_dump command not found on PATH. Install PostgreSQL client tools or set BACKUP_PG_DUMP_PATH.',
  DATABASE_URL_MISSING: 'DATABASE_URL not configured in .env.',
  BACKUP_ALREADY_RUNNING: 'A backup is already in progress.'
}

export function BackupSettings(): React.JSX.Element {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [files, setFiles] = useState<BackupFile[]>([])
  const [running, setRunning] = useState(false)
  const [lastResult, setLastResult] = useState<RunResult | null>(null)

  const [rehearsing, setRehearsing] = useState(false)
  const [rehearsal, setRehearsal] = useState<RestoreCheck | null>(null)

  const [restoreTarget, setRestoreTarget] = useState<BackupFile | null>(null)
  const [confirmation, setConfirmation] = useState('')
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<LiveRestoreResult | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        ipc().invoke('backup:status') as Promise<BackupStatus>,
        ipc().invoke('backup:list') as Promise<BackupFile[]>
      ])
      setStatus(s)
      setFiles(f)
    } catch (e) {
      console.error('Failed to load backup status', e)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const runNow = async (): Promise<void> => {
    setRunning(true)
    setLastResult(null)
    try {
      const r = (await ipc().invoke('backup:run')) as RunResult
      setLastResult(r)
      await refresh()
    } finally {
      setRunning(false)
    }
  }

  /** Restore the newest backup into a scratch database and see what comes back. */
  const rehearse = async (file?: BackupFile): Promise<void> => {
    const target = file ?? files[0]
    if (!target) return
    setRehearsing(true)
    setRehearsal(null)
    try {
      const r = (await ipc().invoke('backup:test-restore', target.fullPath)) as RestoreCheck
      setRehearsal(r)
      await refresh()
    } finally {
      setRehearsing(false)
    }
  }

  const doRestore = async (): Promise<void> => {
    if (!restoreTarget) return
    setRestoring(true)
    setRestoreResult(null)
    try {
      const r = (await ipc().invoke('backup:restore', {
        fullPath: restoreTarget.fullPath,
        confirmation
      })) as LiveRestoreResult
      setRestoreResult(r)
      if (!r.ok) await refresh()
    } finally {
      setRestoring(false)
    }
  }

  const openFolder = async (): Promise<void> => {
    try { await ipc().invoke('backup:open-folder') } catch (e) { console.error(e) }
  }

  const lastAge = status?.lastBackupAt ? fmtAge(status.lastBackupAt) : 'Never'
  const isStale = !status?.lastBackupAt
    || (Date.now() - new Date(status.lastBackupAt).getTime()) > 36 * 60 * 60 * 1000  // > 36h

  return (
    <div className="rounded-xl border bg-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-1.5">
            <Database className="w-3.5 h-3.5" /> Local backup
          </p>
          <p className="text-sm text-zinc-700 mt-1">
            Daily automatic backups of your local database. Stored on this machine; <span className="font-semibold">copy them off-site regularly.</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={openFolder} className="h-8 text-xs gap-1.5">
            <FolderOpen className="w-3.5 h-3.5" /> Open folder
          </Button>
          <Button
            size="sm"
            onClick={runNow}
            disabled={running || !status?.pgDumpAvailable}
            className="h-8 text-xs gap-1.5"
          >
            {running ? (
              <>
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Backing up…
              </>
            ) : (
              <><Play className="w-3.5 h-3.5" /> Backup now</>
            )}
          </Button>
        </div>
      </div>

      {!status?.pgDumpAvailable && (
        <div className="p-3 rounded-md border border-amber-200 bg-amber-50 text-xs text-amber-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>
            <span className="font-semibold">pg_dump not detected.</span> Backups are disabled.
            Install PostgreSQL client tools, or set <code className="font-mono bg-amber-100 px-1 rounded">BACKUP_PG_DUMP_PATH</code> in <code className="font-mono bg-amber-100 px-1 rounded">.env</code> to its absolute path.
          </span>
        </div>
      )}

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg bg-zinc-50 border p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Last backup</p>
          <p className={`text-base font-bold mt-1 ${isStale && status?.pgDumpAvailable ? 'text-amber-700' : 'text-zinc-900'}`}>{lastAge}</p>
          {status?.lastBackupAt && (
            <p className="text-[10px] text-zinc-400 mt-0.5">{new Date(status.lastBackupAt).toLocaleString('en-IN')}</p>
          )}
        </div>
        <div className="rounded-lg bg-zinc-50 border p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">Backups kept</p>
          <p className="text-base font-bold text-zinc-900 mt-1">{status?.count ?? 0}</p>
          <p className="text-[10px] text-zinc-400 mt-0.5">{fmtBytes(status?.totalSizeBytes ?? 0)} total · 30-day retention</p>
        </div>
        {/* The one that matters. A backup nobody has read back is a file. */}
        <div
          className={`rounded-lg border p-3 ${
            status?.lastRestoreCheck?.ok
              ? 'bg-emerald-50 border-emerald-200'
              : status?.lastRestoreCheck
                ? 'bg-red-50 border-red-200'
                : 'bg-amber-50 border-amber-200'
          }`}
        >
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">
            Last read back
          </p>
          <p
            className={`text-base font-bold mt-1 ${
              status?.lastRestoreCheck?.ok
                ? 'text-emerald-700'
                : status?.lastRestoreCheck
                  ? 'text-red-700'
                  : 'text-amber-700'
            }`}
          >
            {status?.lastRestoreCheck ? fmtAge(status.lastRestoreCheck.checkedAt) : 'Never'}
          </p>
          <p className="text-[10px] text-zinc-500 mt-0.5">
            {status?.lastRestoreCheck?.ok
              ? `${status.lastRestoreCheck.totalRows.toLocaleString('en-IN')} rows came back`
              : status?.lastRestoreCheck
                ? 'The last attempt failed'
                : 'Nothing has ever been restored'}
          </p>
        </div>
      </div>

      {/* Reading one back, which is the only thing that makes it a backup. */}
      <div className="rounded-lg border p-3 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4" /> Prove it works
            </p>
            <p className="text-xs text-zinc-600 mt-0.5">
              Restores the newest backup into a throwaway database and counts what comes
              back. The real one is not touched. This runs on its own once a week; the
              button is for when you want to know now.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void rehearse()}
            disabled={rehearsing || files.length === 0}
            className="h-8 text-xs gap-1.5 shrink-0"
          >
            {rehearsing ? (
              <>
                <div className="w-3 h-3 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
                Restoring…
              </>
            ) : (
              <><RotateCcw className="w-3.5 h-3.5" /> Try a restore</>
            )}
          </Button>
        </div>

        {status?.restoreCheckDue && !rehearsal && (
          <p className="text-xs text-amber-800 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            {status.lastRestoreCheck
              ? 'It has been a while since a backup was read back.'
              : 'No backup here has ever been restored, so nothing yet says these files would work.'}
          </p>
        )}

        {rehearsal && (
          <div
            className={`p-3 rounded-md border text-xs flex items-start gap-2 ${
              rehearsal.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-red-200 bg-red-50 text-red-700'
            }`}
          >
            {rehearsal.ok ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            {rehearsal.ok ? (
              <span>
                <span className="font-mono font-semibold">{rehearsal.filename}</span> restored{' '}
                {rehearsal.totalRows.toLocaleString('en-IN')} rows in{' '}
                {(rehearsal.durationMs / 1000).toFixed(1)}s
                {rehearsal.restored.Bill !== undefined && (
                  <> — including {rehearsal.restored.Bill.toLocaleString('en-IN')} bills</>
                )}
                . The throwaway copy has been deleted.
              </span>
            ) : (
              <span>
                <span className="font-mono font-semibold">{rehearsal.filename}</span> did not
                restore.
                <ul className="list-disc ml-4 mt-1 space-y-0.5">
                  {rehearsal.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </span>
            )}
          </div>
        )}
      </div>

      {status?.dir && (
        <p className="text-xs text-zinc-500">
          <span className="text-zinc-400 uppercase tracking-wider font-semibold mr-1.5">Path</span>
          <span className="font-mono text-zinc-700 break-all">{status.dir}</span>
        </p>
      )}

      {lastResult && (
        lastResult.ok ? (
          <div className="p-3 rounded-md border border-emerald-200 bg-emerald-50 text-xs text-emerald-800 flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Wrote <span className="font-mono font-semibold">{lastResult.filename}</span>
              {' · '}{fmtBytes(lastResult.sizeBytes)}{' · '}{(lastResult.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
        ) : (
          <div className="p-3 rounded-md border border-red-200 bg-red-50 text-xs text-red-700 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{ERR_LABEL[lastResult.error] || lastResult.error}</span>
          </div>
        )
      )}

      {files.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-600 hover:text-zinc-900 select-none">
            Show {files.length} backup file{files.length === 1 ? '' : 's'}
          </summary>
          <div className="mt-2 rounded-lg border divide-y max-h-56 overflow-y-auto">
            {files.map((f) => (
              <div key={f.fullPath} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="font-mono text-zinc-700 truncate">{f.filename}</span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="text-zinc-400">
                    {new Date(f.createdAt).toLocaleString('en-IN')} · {fmtBytes(f.sizeBytes)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setRestoreTarget(f)
                      setConfirmation('')
                      setRestoreResult(null)
                    }}
                    className="px-2 py-1 rounded border text-[11px] hover:bg-zinc-100"
                  >
                    Restore
                  </button>
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      <Modal
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        title="Restore this backup over the live database"
      >
        <div className="space-y-4 text-sm">
          <p className="font-mono text-xs bg-zinc-50 border rounded px-3 py-2">
            {restoreTarget?.filename}
          </p>

          <div className="p-3 rounded-md border border-red-200 bg-red-50 text-red-800 text-xs space-y-1.5">
            <p className="font-semibold flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4" /> Everything since this backup will be gone
            </p>
            <p>
              Every sale, payment and change made after it was taken. There is no partial
              restore — the database is replaced.
            </p>
          </div>

          <div className="text-xs text-zinc-600 space-y-1">
            <p className="font-semibold text-zinc-800">Before anything is replaced:</p>
            <ol className="list-decimal ml-4 space-y-0.5">
              <li>The backup is checked against what was in it when it was written.</li>
              <li>
                It is restored into a throwaway database first. If that fails, nothing else
                happens.
              </li>
              <li>
                The current database is backed up, so a restore of the wrong file can be
                walked back.
              </li>
            </ol>
          </div>

          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="restore-confirm">
              Type the branch name to confirm
            </label>
            <Input
              id="restore-confirm"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              className="h-11"
              placeholder="Branch name"
              autoComplete="off"
            />
          </div>

          {restoreResult && !restoreResult.ok && (
            <div className="p-3 rounded-md border border-red-200 bg-red-50 text-xs text-red-700">
              <p className="font-semibold">{restoreResult.message}</p>
              {restoreResult.problems && restoreResult.problems.length > 0 && (
                <ul className="list-disc ml-4 mt-1 space-y-0.5">
                  {restoreResult.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {restoreResult?.ok && (
            <div className="p-3 rounded-md border border-emerald-200 bg-emerald-50 text-xs text-emerald-800 flex items-start gap-2">
              <Undo2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                Restored. What was there before is kept as{' '}
                <span className="font-mono font-semibold">{restoreResult.safetyBackup}</span>.
                The app is restarting.
              </span>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setRestoreTarget(null)}>
              Cancel
            </Button>
            <Button
              className="flex-1 bg-red-600 hover:bg-red-700"
              disabled={restoring || !confirmation.trim() || restoreResult?.ok === true}
              onClick={() => void doRestore()}
            >
              {restoring ? 'Restoring…' : 'Replace the database'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
