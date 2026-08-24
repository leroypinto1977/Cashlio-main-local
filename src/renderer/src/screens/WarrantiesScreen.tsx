import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  ShieldCheck,
  RefreshCw,
  Search,
  CalendarClock,
  Wrench,
  CheckCircle2,
  AlertTriangle,
  Phone,
  Receipt,
  Hash,
  Clock
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import {
  WARRANTY_RESOLUTIONS,
  WARRANTY_STATUS_LABEL,
  EXPIRING_SOON_DAYS,
  type WarrantyStatus,
  type WarrantyResolution
} from '@shared/warranty'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type Warranty = {
  id: string
  serialNumber: string | null
  purchaseDate: string
  expiryDate: string
  /** Worked out by the server: EXPIRED is a date test, never a stored value. */
  status: WarrantyStatus
  storedStatus: string
  daysUntilExpiry: number
  claimDate: string | null
  claimDescription: string | null
  resolvedAt: string | null
  resolution: WarrantyResolution | null
  resolutionNotes: string | null
  product: { itemCode: string; name: string; unitOfMeasure: string; warrantyPeriodDays: number }
  bill: { billNumber: string; paidAt: string; status: string }
  billItem?: { quantity: number; unitRate: number; lineTotal: number }
  customer: { id: string; name: string; phone: string } | null
  claimedBy: { username: string } | null
  resolvedBy: { username: string } | null
}

type Summary = { active: number; expiringSoon: number; claimsOpen: number; expired: number }

type Filter = 'ALL' | 'ACTIVE' | 'CLAIMED' | 'RESOLVED' | 'EXPIRED'

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'ACTIVE', label: 'In cover' },
  { key: 'CLAIMED', label: 'Claims open' },
  { key: 'RESOLVED', label: 'Resolved' },
  { key: 'EXPIRED', label: 'Expired' }
]

// ─── Formatting ───────────────────────────────────────────────────────────────

const shortDate = (d: string): string =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const fmt = (n: number): string =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/**
 * How long is left, in the terms somebody at a counter thinks in. A customer
 * asking "am I still covered?" wants "3 weeks", not a date to subtract from.
 */
function coverLeft(days: number): string {
  if (days < 0) return `expired ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago`
  if (days === 0) return 'expires today'
  if (days === 1) return '1 day left'
  if (days < 45) return `${days} days left`
  const months = Math.round(days / 30)
  if (months < 24) return `${months} month${months === 1 ? '' : 's'} left`
  const years = Math.floor(days / 365)
  return `${years} year${years === 1 ? '' : 's'} left`
}

function StatusChip({ status }: { status: WarrantyStatus }): React.JSX.Element {
  const tone =
    status === 'ACTIVE'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'CLAIMED'
        ? 'bg-amber-50 text-amber-800 border-amber-200'
        : status === 'RESOLVED'
          ? 'bg-blue-50 text-blue-700 border-blue-200'
          : 'bg-zinc-100 text-zinc-500 border-zinc-200'
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[11px] font-semibold ${tone}`}>
      {WARRANTY_STATUS_LABEL[status]}
    </span>
  )
}

function Kpi({
  label,
  value,
  hint,
  tone = 'plain',
  onClick,
  active
}: {
  label: string
  value: string
  hint?: string
  tone?: 'plain' | 'warn' | 'ok'
  onClick?: () => void
  active?: boolean
}): React.JSX.Element {
  const toneClass =
    tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-900'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`p-5 rounded-xl border bg-card text-left transition-colors ${
        onClick ? 'hover:bg-zinc-50 cursor-pointer' : 'cursor-default'
      } ${active ? 'ring-2 ring-zinc-900 ring-offset-2' : ''}`}
    >
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </button>
  )
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * Warranty cover, and what to do when a customer brings something back.
 *
 * Cover is recorded at the moment of sale rather than reconstructed later —
 * a warranty that has to be remembered into existence is one that gets
 * forgotten — so this screen is a reader of something already true, not a
 * place to create records. The two things it exists to answer are "is this
 * still covered?" at the counter, and "what is outstanding?" for whoever
 * runs the shop.
 */
export function WarrantiesScreen({ token }: { token: string | null }): React.JSX.Element {
  const [warranties, setWarranties] = useState<Warranty[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [expiring, setExpiring] = useState<Warranty[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const [filter, setFilter] = useState<Filter>('ALL')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')

  const [detail, setDetail] = useState<Warranty | null>(null)
  const [role, setRole] = useState<string | null>(null)

  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [token])

  // The role decides whether resolving a claim is offered. The endpoint
  // re-checks it; this only decides whether to render a button that would be
  // refused anyway.
  useEffect(() => {
    try {
      const payload = token?.split('.')[1]
      if (!payload) return
      const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
      setRole(claims.role ?? null)
    } catch {
      setRole(null)
    }
  }, [token])

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(id)
  }, [search])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ limit: '200' })
      if (filter !== 'ALL') params.set('status', filter)
      if (debounced) params.set('search', debounced)

      const [listRes, sumRes, soonRes] = await Promise.all([
        axios.get(`${LOCAL_API}/api/v1/warranties?${params}`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/warranties/summary`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/warranties/expiring-soon`, { headers })
      ])
      setWarranties(listRes.data.warranties ?? [])
      setSummary(sumRes.data ?? null)
      setExpiring(soonRes.data.warranties ?? [])
      setLastUpdated(new Date())
    } catch {
      setError('Could not reach the local server. Check that it is running, then refresh.')
    } finally {
      setLoading(false)
    }
  }, [token, headers, filter, debounced])

  useEffect(() => {
    void load()
  }, [load])

  /** Replaces one row in place after a claim or resolution, without a reload. */
  const replace = (w: Warranty): void => {
    setWarranties((prev) => prev.map((x) => (x.id === w.id ? w : x)))
    setDetail((d) => (d && d.id === w.id ? w : d))
    void load()
  }

  const claimsOpen = summary?.claimsOpen ?? 0

  return (
    <div className="space-y-6">
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-7 h-7" /> Warranties
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            What is still under cover, what has been brought back, and what is about to lapse.
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour12: true })}`
              : 'Not loaded yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
          {error}
        </div>
      )}

      {/* The counts double as filters — the number you are looking at is the
          thing you want to see the list of. */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <Kpi
          label="In cover"
          value={String(summary?.active ?? 0)}
          hint="Sold with a warranty, still valid"
          tone="ok"
          active={filter === 'ACTIVE'}
          onClick={() => setFilter(filter === 'ACTIVE' ? 'ALL' : 'ACTIVE')}
        />
        <Kpi
          label="Claims open"
          value={String(claimsOpen)}
          hint={claimsOpen > 0 ? 'Waiting on a decision' : 'Nothing outstanding'}
          tone={claimsOpen > 0 ? 'warn' : 'plain'}
          active={filter === 'CLAIMED'}
          onClick={() => setFilter(filter === 'CLAIMED' ? 'ALL' : 'CLAIMED')}
        />
        <Kpi
          label="Expiring soon"
          value={String(summary?.expiringSoon ?? 0)}
          hint={`Within ${EXPIRING_SOON_DAYS} days`}
          tone={(summary?.expiringSoon ?? 0) > 0 ? 'warn' : 'plain'}
        />
        <Kpi
          label="Expired"
          value={String(summary?.expired ?? 0)}
          hint="Cover has run out"
          active={filter === 'EXPIRED'}
          onClick={() => setFilter(filter === 'EXPIRED' ? 'ALL' : 'EXPIRED')}
        />
      </div>

      {/* Worth surfacing above the list: a customer whose cover lapses next
          week is the one call worth making this month. */}
      {expiring.length > 0 && (
        <section className="rounded-xl border bg-card overflow-hidden">
          <div className="px-5 py-3 border-b bg-amber-50/60 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-amber-600" />
            <h2 className="text-sm font-bold text-zinc-700">
              Lapsing within {EXPIRING_SOON_DAYS} days
            </h2>
          </div>
          <div className="divide-y">
            {expiring.slice(0, 6).map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => setDetail(w)}
                className="w-full px-5 py-3 flex items-center gap-4 text-left hover:bg-zinc-50 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-zinc-900 truncate">{w.product.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">
                    {w.product.itemCode} · {w.bill.billNumber}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-amber-700">{coverLeft(w.daysUntilExpiry)}</p>
                  <p className="text-xs text-muted-foreground">
                    {w.customer ? w.customer.name : 'Walk-in'}
                  </p>
                </div>
              </button>
            ))}
            {expiring.length > 6 && (
              <p className="px-5 py-2.5 text-xs text-muted-foreground">
                and {expiring.length - 6} more
              </p>
            )}
          </div>
        </section>
      )}

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Serial number, product, customer, phone or bill number…"
            className="pl-9 h-10"
          />
        </div>
        <div className="flex rounded-lg border overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`px-3 py-2 text-sm font-medium transition-colors ${
                filter === f.key
                  ? 'bg-zinc-900 text-white'
                  : 'text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* The list */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 border-b">
              <tr>
                <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Product</th>
                <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Customer</th>
                <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Sold on</th>
                <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Cover</th>
                <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Status</th>
                <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {warranties.map((w) => (
                <tr
                  key={w.id}
                  onClick={() => setDetail(w)}
                  className="hover:bg-zinc-50 cursor-pointer"
                >
                  <td className="px-4 py-3">
                    <p className="font-semibold text-zinc-900">{w.product.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {w.product.itemCode}
                      {w.serialNumber ? ` · ${w.serialNumber}` : ''}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    {w.customer ? (
                      <>
                        <p className="text-zinc-800">{w.customer.name}</p>
                        <p className="text-xs text-muted-foreground">{w.customer.phone}</p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Walk-in</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-600">
                    <p>{shortDate(w.purchaseDate)}</p>
                    <p className="text-xs text-muted-foreground font-mono">{w.bill.billNumber}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-zinc-800">{shortDate(w.expiryDate)}</p>
                    <p
                      className={`text-xs ${
                        w.daysUntilExpiry < 0
                          ? 'text-zinc-400'
                          : w.daysUntilExpiry <= EXPIRING_SOON_DAYS
                            ? 'text-amber-600 font-medium'
                            : 'text-muted-foreground'
                      }`}
                    >
                      {coverLeft(w.daysUntilExpiry)}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    <StatusChip status={w.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-xs text-muted-foreground">View</span>
                  </td>
                </tr>
              ))}
              {warranties.length === 0 && !loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center">
                    <ShieldCheck className="w-8 h-8 text-zinc-300 mx-auto mb-3" />
                    <p className="text-sm font-medium text-zinc-600">
                      {debounced || filter !== 'ALL'
                        ? 'Nothing matches that.'
                        : 'No warranties yet.'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
                      {debounced || filter !== 'ALL'
                        ? 'Try a different search, or clear the filter.'
                        : 'Cover is recorded automatically when a product with a warranty period is sold. Set one on the product to start.'}
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {warranties.length > 0 && (
          <div className="px-4 py-2.5 border-t bg-zinc-50/50 text-xs text-muted-foreground">
            {warranties.length} shown
          </div>
        )}
      </div>

      <WarrantyDetail
        warranty={detail}
        role={role}
        headers={headers}
        onClose={() => setDetail(null)}
        onChanged={replace}
      />
    </div>
  )
}

// ─── Detail, claim and resolution ─────────────────────────────────────────────

function Field({
  icon,
  label,
  children
}: {
  icon: React.ReactNode
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 text-zinc-400">{icon}</div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
        <div className="text-sm text-zinc-800">{children}</div>
      </div>
    </div>
  )
}

function WarrantyDetail({
  warranty,
  role,
  headers,
  onClose,
  onChanged
}: {
  warranty: Warranty | null
  role: string | null
  headers: Record<string, string>
  onClose: () => void
  onChanged: (w: Warranty) => void
}): React.JSX.Element {
  const [description, setDescription] = useState('')
  const [serial, setSerial] = useState('')
  const [resolution, setResolution] = useState<WarrantyResolution | ''>('')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    setDescription('')
    setSerial(warranty?.serialNumber ?? '')
    setResolution('')
    setNotes('')
    setProblem('')
  }, [warranty?.id])

  if (!warranty) return <Modal open={false} onClose={onClose} title="" children={null} />

  const w = warranty
  const canOpenClaim = w.status === 'ACTIVE'
  const canResolve = w.status === 'CLAIMED' && role === 'SUPER_ADMIN'

  async function openClaim(): Promise<void> {
    if (!description.trim()) {
      setProblem('Describe the fault the customer is reporting.')
      return
    }
    setBusy(true)
    setProblem('')
    try {
      const res = await axios.post(
        `${LOCAL_API}/api/v1/warranties/${w.id}/claim`,
        { description: description.trim(), serialNumber: serial.trim() || undefined },
        { headers }
      )
      onChanged(res.data.warranty)
      setDescription('')
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } }).response?.data?.message
      setProblem(msg ?? 'Could not open the claim.')
    } finally {
      setBusy(false)
    }
  }

  async function resolveClaim(): Promise<void> {
    if (!resolution) {
      setProblem('Say what was done.')
      return
    }
    setBusy(true)
    setProblem('')
    try {
      const res = await axios.put(
        `${LOCAL_API}/api/v1/warranties/${w.id}/resolve`,
        { resolution, notes: notes.trim() || undefined },
        { headers }
      )
      onChanged(res.data.warranty)
    } catch (e) {
      const msg = (e as { response?: { data?: { message?: string } } }).response?.data?.message
      setProblem(msg ?? 'Could not close the claim.')
    } finally {
      setBusy(false)
    }
  }

  async function saveSerial(): Promise<void> {
    setBusy(true)
    setProblem('')
    try {
      const res = await axios.put(
        `${LOCAL_API}/api/v1/warranties/${w.id}`,
        { serialNumber: serial.trim() || null },
        { headers }
      )
      onChanged(res.data.warranty)
    } catch {
      setProblem('Could not save the serial number.')
    } finally {
      setBusy(false)
    }
  }

  const resolutionLabel = WARRANTY_RESOLUTIONS.find((r) => r.code === w.resolution)?.label

  return (
    <Modal open onClose={onClose} title={w.product.name} size="lg">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <StatusChip status={w.status} />
          <span className="text-sm text-muted-foreground">{coverLeft(w.daysUntilExpiry)}</span>
        </div>

        <div className="grid grid-cols-2 gap-4 p-4 rounded-lg border bg-zinc-50/60">
          <Field icon={<Hash className="w-3.5 h-3.5" />} label="Item code">
            <span className="font-mono">{w.product.itemCode}</span>
          </Field>
          <Field icon={<Receipt className="w-3.5 h-3.5" />} label="Sold on">
            <span className="font-mono">{w.bill.billNumber}</span>
            <span className="text-muted-foreground"> · {shortDate(w.purchaseDate)}</span>
          </Field>
          <Field icon={<Phone className="w-3.5 h-3.5" />} label="Customer">
            {w.customer ? (
              <>
                {w.customer.name}{' '}
                <span className="text-muted-foreground">{w.customer.phone}</span>
              </>
            ) : (
              <span className="text-muted-foreground">
                Walk-in — no contact recorded on the sale
              </span>
            )}
          </Field>
          <Field icon={<Clock className="w-3.5 h-3.5" />} label="Cover ends">
            {shortDate(w.expiryDate)}
          </Field>
          {w.billItem && (
            <Field icon={<Receipt className="w-3.5 h-3.5" />} label="Sold for">
              ₹{fmt(w.billItem.lineTotal)}
              <span className="text-muted-foreground">
                {' '}
                ({w.billItem.quantity} {w.product.unitOfMeasure})
              </span>
            </Field>
          )}
        </div>

        {/* The serial number is asked for here rather than at the till: this
            is the first moment somebody is actually holding the unit. */}
        <div>
          <label className="block text-sm font-semibold mb-1.5">Serial number</label>
          <div className="flex gap-2">
            <Input
              value={serial}
              onChange={(e) => setSerial(e.target.value)}
              placeholder="On the unit or its box — not needed to make a claim"
              className="h-10 font-mono flex-1"
            />
            <Button
              variant="outline"
              onClick={saveSerial}
              disabled={busy || serial.trim() === (w.serialNumber ?? '')}
              className="h-10"
            >
              Save
            </Button>
          </div>
        </div>

        {/* Claim history, once there is any */}
        {w.claimDate && (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Wrench className="w-4 h-4 text-amber-600" />
              <h3 className="text-sm font-bold text-zinc-800">
                Claim opened {shortDate(w.claimDate)}
                {w.claimedBy ? ` by ${w.claimedBy.username}` : ''}
              </h3>
            </div>
            <p className="text-sm text-zinc-700 whitespace-pre-wrap">{w.claimDescription}</p>

            {w.resolvedAt && (
              <div className="pt-3 border-t space-y-1.5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-blue-600" />
                  <p className="text-sm font-semibold text-zinc-800">
                    {resolutionLabel ?? w.resolution} — {shortDate(w.resolvedAt)}
                    {w.resolvedBy ? ` by ${w.resolvedBy.username}` : ''}
                  </p>
                </div>
                {w.resolutionNotes && (
                  <p className="text-sm text-zinc-600 whitespace-pre-wrap pl-6">
                    {w.resolutionNotes}
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {problem && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {problem}
          </div>
        )}

        {/* Opening a claim — any signed-in user, because a cashier is who the
            customer walks up to. */}
        {canOpenClaim && (
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-bold text-zinc-800">Customer has brought this back</h3>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="What is wrong with it, in the customer's words"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end">
              <Button onClick={openClaim} disabled={busy} className="gap-2">
                <Wrench className="w-4 h-4" />
                {busy ? 'Opening…' : 'Open a claim'}
              </Button>
            </div>
          </div>
        )}

        {/* Closing one — a manager's call, and the endpoint enforces it too. */}
        {canResolve && (
          <div className="rounded-lg border p-4 space-y-3">
            <h3 className="text-sm font-bold text-zinc-800">Close this claim</h3>
            <div className="grid grid-cols-2 gap-2">
              {WARRANTY_RESOLUTIONS.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setResolution(r.code)}
                  className={`text-left p-3 rounded-lg border transition-colors ${
                    resolution === r.code
                      ? 'border-zinc-900 bg-zinc-50 ring-1 ring-zinc-900'
                      : 'hover:bg-zinc-50'
                  }`}
                >
                  <p className="text-sm font-semibold text-zinc-900">{r.label}</p>
                  <p className="text-xs text-muted-foreground">{r.hint}</p>
                </button>
              ))}
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Anything worth recording — optional"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <div className="flex justify-end">
              <Button onClick={resolveClaim} disabled={busy || !resolution} className="gap-2">
                <CheckCircle2 className="w-4 h-4" />
                {busy ? 'Saving…' : 'Close the claim'}
              </Button>
            </div>
          </div>
        )}

        {w.status === 'CLAIMED' && role !== 'SUPER_ADMIN' && (
          <div className="p-3 rounded-lg bg-zinc-50 border text-sm text-zinc-600 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <span>
              This claim is open. A manager decides what happens to it — repair, replacement,
              refund, or rejection.
            </span>
          </div>
        )}

        {w.status === 'EXPIRED' && (
          <div className="p-3 rounded-lg bg-zinc-50 border text-sm text-zinc-600 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-zinc-400 mt-0.5 shrink-0" />
            <span>
              Cover ended on {shortDate(w.expiryDate)}, so no claim can be opened against it.
            </span>
          </div>
        )}
      </div>
    </Modal>
  )
}
