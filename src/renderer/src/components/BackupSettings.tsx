import { useState, useEffect, useCallback } from 'react'
import { Database, FolderOpen, Play, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { Button } from './ui/button'

type BackupStatus = {
  dir: string
  count: number
  lastBackupAt: string | null
  totalSizeBytes: number
  pgDumpAvailable: boolean
}

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
        <div className="rounded-lg bg-zinc-50 border p-3">
          <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">pg_dump</p>
          <p className={`text-base font-bold mt-1 ${status?.pgDumpAvailable ? 'text-emerald-700' : 'text-red-600'}`}>
            {status?.pgDumpAvailable ? 'Available' : 'Missing'}
          </p>
        </div>
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
              <div key={f.fullPath} className="flex items-center justify-between px-3 py-2">
                <span className="font-mono text-zinc-700">{f.filename}</span>
                <span className="text-zinc-400">
                  {new Date(f.createdAt).toLocaleString('en-IN')} · {fmtBytes(f.sizeBytes)}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )
}
