import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  Wallet,
  RefreshCw,
  Search,
  Users,
  AlertTriangle,
  CheckCircle2,
  X,
  Phone,
  CalendarClock,
  ArrowUpDown,
  BellRing,
  Receipt,
  Plus,
} from 'lucide-react'
import { AGE_BUCKETS, daysBetween, PAYMENT_METHODS } from '@shared/credit'
import type { AgeBucket, PaymentMethod } from '@shared/credit'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'http://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type Buckets = Record<AgeBucket, number>

type DebtorRow = {
  customerId: string
  name: string
  phone: string | null
  creditLimit: number
  outstanding: number
  billCount: number
  oldestDays: number
  buckets: Buckets
}

type ReceivablesResponse = {
  totalOutstanding: number
  buckets: Buckets
  customers: DebtorRow[]
}

type OpenBill = {
  id: string
  billNumber: string
  status: string
  paidAt: string
  dueDate: string | null
  totalAmount: number
  paidAmount: number
  balanceDue: number
  ageBucket: AgeBucket
  daysOverdue: number
}

type CustomerOutstanding = {
  outstanding: number
  availableCredit: number
  overLimit: boolean
  customer: { creditLimit: number; creditDays: number }
  bills: OpenBill[]
}

type FollowUp = {
  id: string
  note: string
  dueAt: string | null
  resolvedAt: string | null
  customer: { id: string; name: string; phone: string | null }
  createdBy: { username: string }
}

/** Just enough of a customer to open the drawer — a debtor row or a follow-up. */
type DrawerTarget = { id: string; name: string; phone: string | null }

type SortKey = 'outstanding' | 'oldest' | 'name'

// ─── Presentation helpers ─────────────────────────────────────────────────────

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const fmtInt = (n: number) => new Intl.NumberFormat('en-IN').format(n)

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

/**
 * Ageing colours carry meaning, so they are declared once rather than sprinkled
 * through the markup: green is money that is not late at all, and the ramp to
 * red is how hard the manager should be chasing it.
 */
const BUCKET_STYLE: Record<
  AgeBucket,
  { label: string; short: string; bar: string; dot: string; chip: string }
> = {
  current: {
    label: 'Not yet due',
    short: 'Current',
    bar: 'bg-emerald-500 dark:bg-emerald-400',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:border-emerald-800',
  },
  '0-30': {
    label: '1–30 days overdue',
    short: '0–30d',
    bar: 'bg-amber-400 dark:bg-amber-400',
    dot: 'bg-amber-400',
    chip: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800',
  },
  '31-60': {
    label: '31–60 days overdue',
    short: '31–60d',
    bar: 'bg-orange-500',
    dot: 'bg-orange-500',
    chip: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950 dark:text-orange-300 dark:border-orange-800',
  },
  '60+': {
    label: 'Over 60 days overdue',
    short: '60d+',
    bar: 'bg-red-600 dark:bg-red-500',
    dot: 'bg-red-600 dark:bg-red-500',
    chip: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950 dark:text-red-300 dark:border-red-800',
  },
}

const EMPTY_BUCKETS: Buckets = { current: 0, '0-30': 0, '31-60': 0, '60+': 0 }

/** Server errors carry a human `message`; fall back only when they don't. */
function errMessage(e: unknown, fallback: string): string {
  if (axios.isAxiosError(e)) {
    const data = e.response?.data as { message?: string; error?: string } | undefined
    if (data?.message) return data.message
    if (data?.error) return data.error
  }
  return fallback
}

const bucketTotal = (b: Buckets) => AGE_BUCKETS.reduce((s, k) => s + (b[k] || 0), 0)

// ─── Screen ───────────────────────────────────────────────────────────────────

export function ReceivablesScreen({ token }: { token: string | null }): React.JSX.Element {
  const [data, setData] = useState<ReceivablesResponse | null>(null)
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('outstanding')
  const [sortDesc, setSortDesc] = useState(true)

  const [drawerFor, setDrawerFor] = useState<DrawerTarget | null>(null)

  const authHeader = useMemo(
    () => ({ headers: { Authorization: `Bearer ${token}` } }),
    [token],
  )

  const fetchAll = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const [recv, fups] = await Promise.all([
        axios.get<ReceivablesResponse>(`${LOCAL_API}/api/v1/receivables`, authHeader),
        axios.get<{ followUps: FollowUp[] }>(`${LOCAL_API}/api/v1/followups?open=1`, authHeader),
      ])
      setData(recv.data)
      setFollowUps(fups.data.followUps ?? [])
      setLastUpdated(new Date())
    } catch (e) {
      setError(
        errMessage(e, 'Could not reach the local server. Check that it is running, then refresh.'),
      )
    } finally {
      setLoading(false)
    }
  }, [token, authHeader])

  useEffect(() => {
    fetchAll()
  }, [fetchAll])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDesc((d) => !d)
    } else {
      setSortKey(key)
      setSortDesc(key !== 'name')
    }
  }

  const buckets = data?.buckets ?? EMPTY_BUCKETS
  const totalOutstanding = data?.totalOutstanding ?? 0
  const overdueAmount = Math.max(0, totalOutstanding - (buckets.current || 0))
  const barTotal = bucketTotal(buckets)

  const rows = useMemo(() => {
    const list = data?.customers ?? []
    const q = search.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (c) =>
            c.name.toLowerCase().includes(q) || (c.phone ?? '').toLowerCase().includes(q),
        )
      : list.slice()
    const dir = sortDesc ? -1 : 1
    return filtered.sort((a, b) => {
      if (sortKey === 'name') return dir * a.name.localeCompare(b.name)
      if (sortKey === 'oldest') return dir * (a.oldestDays - b.oldestDays)
      return dir * (a.outstanding - b.outstanding)
    })
  }, [data, search, sortKey, sortDesc])

  const now = new Date()
  const overdueFollowUps = followUps.filter((f) => f.dueAt && new Date(f.dueAt) < now).length

  const nothingOutstanding = !!data && data.customers.length === 0 && totalOutstanding <= 0

  const resolveFollowUp = async (id: string) => {
    if (!token) return
    try {
      await axios.put(`${LOCAL_API}/api/v1/followups/${id}`, { resolved: true }, authHeader)
      setFollowUps((f) => f.filter((x) => x.id !== id))
    } catch (e) {
      setError(errMessage(e, 'Could not mark that follow-up done.'))
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Wallet className="w-7 h-7" /> Receivables
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Who owes the shop money, how old it is, and who needs chasing.
          </p>
          {/* A snapshot, not a live feed — say when it was taken so a stale
              figure is never mistaken for a payment that failed to register. */}
          <p className="text-xs text-zinc-400 mt-1">
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour12: true })}`
              : 'Not loaded yet'}
          </p>
        </div>
        <button
          type="button"
          onClick={fetchAll}
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

      {loading && !data && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-8">
          <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
          Loading receivables…
        </div>
      )}

      {data && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-3 gap-4">
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Total Outstanding
                </p>
                <div className="w-8 h-8 rounded-lg bg-zinc-100 flex items-center justify-center">
                  <Wallet className="w-4 h-4 text-zinc-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">₹{fmt(totalOutstanding)}</p>
              <p className="text-xs text-zinc-400 mt-1">Across all unsettled bills</p>
            </div>

            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Customers Owing
                </p>
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Users className="w-4 h-4 text-blue-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">{fmtInt(data.customers.length)}</p>
              <p className="text-xs text-zinc-400 mt-1">
                {fmtInt(data.customers.reduce((s, c) => s + c.billCount, 0))} open bill
                {data.customers.reduce((s, c) => s + c.billCount, 0) !== 1 ? 's' : ''}
              </p>
            </div>

            <div
              className={`p-5 rounded-xl border shadow-sm ${overdueAmount > 0 ? 'bg-red-50/50 border-red-200' : 'bg-card'}`}
            >
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Actually Overdue
                </p>
                <div
                  className={`w-8 h-8 rounded-lg flex items-center justify-center ${overdueAmount > 0 ? 'bg-red-100' : 'bg-emerald-50'}`}
                >
                  {overdueAmount > 0 ? (
                    <AlertTriangle className="w-4 h-4 text-red-600" />
                  ) : (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                  )}
                </div>
              </div>
              <p
                className={`text-2xl font-bold ${overdueAmount > 0 ? 'text-red-700' : 'text-zinc-900'}`}
              >
                ₹{fmt(overdueAmount)}
              </p>
              <p className="text-xs text-zinc-400 mt-1">
                {overdueAmount > 0
                  ? 'Past its due date — everything outside "not yet due"'
                  : 'Nothing is past its due date'}
              </p>
            </div>
          </div>

          {/* Ageing bar */}
          <div className="p-5 rounded-xl bg-card border shadow-sm">
            <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-4">
              Ageing
            </p>
            <div className="h-4 rounded-full overflow-hidden flex bg-zinc-100 dark:bg-zinc-800">
              {barTotal > 0 ? (
                AGE_BUCKETS.map((k) => {
                  const amt = buckets[k] || 0
                  if (amt <= 0) return null
                  const pct = (amt / barTotal) * 100
                  return (
                    <div
                      key={k}
                      className={`h-full transition-all ${BUCKET_STYLE[k].bar}`}
                      style={{ width: `${pct}%` }}
                      title={`${BUCKET_STYLE[k].label}: ₹${fmt(amt)} (${pct.toFixed(1)}%)`}
                    />
                  )
                })
              ) : (
                <div className="h-full w-full bg-zinc-100 dark:bg-zinc-800" />
              )}
            </div>

            <div className="grid grid-cols-4 gap-4 mt-4">
              {AGE_BUCKETS.map((k) => {
                const amt = buckets[k] || 0
                const pct = barTotal > 0 ? (amt / barTotal) * 100 : 0
                return (
                  <div key={k} className="flex items-start gap-2">
                    <div className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${BUCKET_STYLE[k].dot}`} />
                    <div className="min-w-0">
                      <p className="text-xs text-zinc-500">{BUCKET_STYLE[k].label}</p>
                      <p className="text-base font-bold text-zinc-900">₹{fmt(amt)}</p>
                      <p className="text-xs text-zinc-400">{pct.toFixed(1)}% of the book</p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Nothing outstanding at all — say so plainly rather than showing an
              empty grid that reads like a loading failure. */}
          {nothingOutstanding ? (
            <div className="rounded-xl border bg-card shadow-sm flex flex-col items-center justify-center py-16 text-center gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
                <CheckCircle2 className="w-6 h-6 text-emerald-600" />
              </div>
              <p className="text-base font-semibold text-zinc-800">
                Nothing outstanding — every bill is settled
              </p>
              <p className="text-sm text-zinc-400 max-w-sm">
                Credit sales that are still owed will appear here, oldest and largest first.
              </p>
            </div>
          ) : (
            <>
              {/* Debtors table */}
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                    <input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search name or phone…"
                      className="w-full h-9 pl-9 pr-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  </div>
                  <span className="text-sm text-zinc-500">
                    {rows.length} customer{rows.length !== 1 ? 's' : ''}
                  </span>
                </div>

                <div className="rounded-xl border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-2.5">
                          <SortHeader
                            label="Customer"
                            active={sortKey === 'name'}
                            desc={sortDesc}
                            onClick={() => toggleSort('name')}
                          />
                        </th>
                        <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">
                          Phone
                        </th>
                        <th className="text-right px-4 py-2.5">
                          <SortHeader
                            label="Outstanding"
                            align="right"
                            active={sortKey === 'outstanding'}
                            desc={sortDesc}
                            onClick={() => toggleSort('outstanding')}
                          />
                        </th>
                        <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">
                          Credit limit
                        </th>
                        <th className="text-center px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">
                          Bills
                        </th>
                        <th className="text-right px-4 py-2.5">
                          <SortHeader
                            label="Oldest overdue"
                            align="right"
                            active={sortKey === 'oldest'}
                            desc={sortDesc}
                            onClick={() => toggleSort('oldest')}
                          />
                        </th>
                        <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide w-40">
                          Ageing
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={7}>
                            <div className="flex flex-col items-center justify-center py-14 text-zinc-400 gap-2">
                              <Search className="w-8 h-8 text-zinc-300" />
                              <p className="text-sm font-medium">
                                No customer matches “{search.trim()}”
                              </p>
                              <p className="text-xs">Try a different name or phone number.</p>
                            </div>
                          </td>
                        </tr>
                      )}
                      {rows.map((c) => {
                        const overLimit = c.creditLimit > 0 && c.outstanding > c.creditLimit
                        return (
                          <tr
                            key={c.customerId}
                            onClick={() =>
                              setDrawerFor({ id: c.customerId, name: c.name, phone: c.phone })
                            }
                            className="hover:bg-zinc-50 cursor-pointer transition-colors"
                          >
                            <td className="px-4 py-3 font-medium text-zinc-900">{c.name}</td>
                            <td className="px-4 py-3 text-zinc-500 text-xs font-mono">
                              {c.phone || <span className="italic text-zinc-400">No phone</span>}
                            </td>
                            <td className="px-4 py-3 text-right font-semibold text-zinc-900">
                              ₹{fmt(c.outstanding)}
                            </td>
                            <td className="px-4 py-3 text-right">
                              {c.creditLimit > 0 ? (
                                <>
                                  <span className={overLimit ? 'text-red-700 font-semibold' : 'text-zinc-600'}>
                                    ₹{fmt(c.creditLimit)}
                                  </span>
                                  {overLimit && (
                                    <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                                      <AlertTriangle className="w-2.5 h-2.5" /> OVER
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="text-zinc-400 italic text-xs">No limit set</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-center text-zinc-600">{c.billCount}</td>
                            <td className="px-4 py-3 text-right">
                              {c.oldestDays > 0 ? (
                                <span
                                  className={
                                    c.oldestDays > 60
                                      ? 'text-red-700 font-semibold'
                                      : c.oldestDays > 30
                                        ? 'text-orange-600 font-medium'
                                        : 'text-amber-600'
                                  }
                                >
                                  {c.oldestDays} day{c.oldestDays !== 1 ? 's' : ''}
                                </span>
                              ) : (
                                <span className="text-zinc-400 text-xs">Not due yet</span>
                              )}
                            </td>
                            <td className="px-4 py-3">
                              <MiniAgeing buckets={c.buckets} />
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* Needs chasing */}
          <div className="p-5 rounded-xl bg-card border shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <BellRing className="w-4 h-4 text-zinc-400" />
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Needs Chasing
                </p>
              </div>
              {overdueFollowUps > 0 && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
                  {overdueFollowUps} past due
                </span>
              )}
            </div>

            {followUps.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center gap-2">
                <CheckCircle2 className="w-8 h-8 text-zinc-300" />
                <p className="text-sm text-zinc-400">
                  No open follow-ups. Add one from a customer to plan a call.
                </p>
              </div>
            ) : (
              <div className="divide-y">
                {followUps.map((f) => {
                  const due = f.dueAt ? new Date(f.dueAt) : null
                  const isLate = !!due && due < now
                  const lateBy = due ? daysBetween(due, now) : 0
                  return (
                    <div
                      key={f.id}
                      className={`flex items-start gap-3 py-3 first:pt-0 last:pb-0 ${isLate ? '-mx-2 px-2 rounded-lg bg-red-50/60' : ''}`}
                    >
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isLate ? 'bg-red-100' : 'bg-zinc-100'}`}
                      >
                        <CalendarClock
                          className={`w-3.5 h-3.5 ${isLate ? 'text-red-600' : 'text-zinc-500'}`}
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            type="button"
                            onClick={() =>
                              setDrawerFor({
                                id: f.customer.id,
                                name: f.customer.name,
                                phone: f.customer.phone,
                              })
                            }
                            className="text-sm font-semibold text-zinc-900 hover:underline underline-offset-2"
                          >
                            {f.customer.name}
                          </button>
                          {f.customer.phone && (
                            <span className="text-xs text-zinc-400 font-mono flex items-center gap-1">
                              <Phone className="w-3 h-3" /> {f.customer.phone}
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-zinc-700 mt-0.5 break-words">{f.note}</p>
                        <p className="text-xs mt-0.5">
                          {due ? (
                            <span className={isLate ? 'text-red-600 font-medium' : 'text-zinc-400'}>
                              Due {fmtDate(f.dueAt)}
                              {isLate ? ` · ${lateBy} day${lateBy !== 1 ? 's' : ''} late` : ''}
                            </span>
                          ) : (
                            <span className="text-zinc-400">No due date</span>
                          )}
                          <span className="text-zinc-300"> · </span>
                          <span className="text-zinc-400">by {f.createdBy.username}</span>
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => resolveFollowUp(f.id)}
                        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border text-xs font-medium text-zinc-600 hover:bg-zinc-50 transition-colors"
                      >
                        <CheckCircle2 className="w-3.5 h-3.5" /> Mark done
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {drawerFor && (
        <CustomerDrawer
          target={drawerFor}
          token={token}
          onClose={() => setDrawerFor(null)}
          onChanged={fetchAll}
        />
      )}
    </div>
  )
}

// ─── Sortable column header ───────────────────────────────────────────────────

function SortHeader({
  label,
  active,
  desc,
  onClick,
  align = 'left',
}: {
  label: string
  active: boolean
  desc: boolean
  onClick: () => void
  align?: 'left' | 'right'
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 font-semibold text-xs uppercase tracking-wide transition-colors ${
        active ? 'text-zinc-900' : 'text-zinc-600 hover:text-zinc-900'
      } ${align === 'right' ? 'flex-row-reverse' : ''}`}
      title={active ? (desc ? 'Sorted high to low' : 'Sorted low to high') : `Sort by ${label}`}
    >
      <ArrowUpDown className={`w-3 h-3 ${active ? 'opacity-100' : 'opacity-40'}`} />
      {label}
    </button>
  )
}

// ─── Per-customer ageing strip ────────────────────────────────────────────────

function MiniAgeing({ buckets }: { buckets: Buckets }): React.JSX.Element {
  const total = bucketTotal(buckets)
  if (total <= 0) return <div className="h-2 rounded-full bg-zinc-100" />
  return (
    <div className="space-y-1">
      <div className="h-2 rounded-full overflow-hidden flex bg-zinc-100 dark:bg-zinc-800">
        {AGE_BUCKETS.map((k) => {
          const amt = buckets[k] || 0
          if (amt <= 0) return null
          return (
            <div
              key={k}
              className={`h-full ${BUCKET_STYLE[k].bar}`}
              style={{ width: `${(amt / total) * 100}%` }}
              title={`${BUCKET_STYLE[k].label}: ₹${fmt(amt)}`}
            />
          )
        })}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-0.5">
        {AGE_BUCKETS.filter((k) => (buckets[k] || 0) > 0).map((k) => (
          <span key={k} className="text-[10px] text-zinc-500 whitespace-nowrap">
            <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${BUCKET_STYLE[k].dot}`} />
            {BUCKET_STYLE[k].short} ₹{fmt(buckets[k] || 0)}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Customer drawer ──────────────────────────────────────────────────────────

function CustomerDrawer({
  target,
  token,
  onClose,
  onChanged,
}: {
  target: DrawerTarget
  token: string | null
  onClose: () => void
  onChanged: () => void
}): React.JSX.Element {
  const [detail, setDetail] = useState<CustomerOutstanding | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')

  // Record payment
  const [payOpen, setPayOpen] = useState(false)
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState<PaymentMethod>('CASH')
  const [payReference, setPayReference] = useState('')
  const [payNote, setPayNote] = useState('')
  const [paySubmitting, setPaySubmitting] = useState(false)
  const [payError, setPayError] = useState('')

  // Follow-up
  const [fuOpen, setFuOpen] = useState(false)
  const [fuNote, setFuNote] = useState('')
  const [fuDue, setFuDue] = useState('')
  const [fuSubmitting, setFuSubmitting] = useState(false)
  const [fuError, setFuError] = useState('')
  const [fuDone, setFuDone] = useState('')

  const authHeader = useMemo(
    () => ({ headers: { Authorization: `Bearer ${token}` } }),
    [token],
  )

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setLoadError('')
    try {
      const res = await axios.get<CustomerOutstanding>(
        `${LOCAL_API}/api/v1/customers/${target.id}/outstanding`,
        authHeader,
      )
      setDetail(res.data)
      setPayAmount(res.data.outstanding > 0 ? String(res.data.outstanding) : '')
    } catch (e) {
      setLoadError(errMessage(e, 'Could not load this customer’s outstanding bills.'))
    } finally {
      setLoading(false)
    }
  }, [token, target.id, authHeader])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submitPayment = async () => {
    if (!token) return
    const amount = Number(payAmount)
    if (!Number.isFinite(amount) || amount <= 0) {
      setPayError('Enter an amount greater than zero.')
      return
    }
    setPaySubmitting(true)
    setPayError('')
    try {
      await axios.post(
        `${LOCAL_API}/api/v1/payments`,
        {
          customerId: target.id,
          amount,
          method: payMethod,
          reference: payReference.trim() || undefined,
          note: payNote.trim() || undefined,
        },
        authHeader,
      )
      setPayOpen(false)
      setPayReference('')
      setPayNote('')
      await load()
      onChanged()
    } catch (e) {
      setPayError(errMessage(e, 'Could not record that payment. Please try again.'))
    } finally {
      setPaySubmitting(false)
    }
  }

  const submitFollowUp = async () => {
    if (!token) return
    if (!fuNote.trim()) {
      setFuError('Write a short note so whoever picks this up knows what to say.')
      return
    }
    setFuSubmitting(true)
    setFuError('')
    setFuDone('')
    try {
      await axios.post(
        `${LOCAL_API}/api/v1/customers/${target.id}/followups`,
        {
          note: fuNote.trim(),
          dueAt: fuDue ? new Date(fuDue).toISOString() : undefined,
        },
        authHeader,
      )
      setFuOpen(false)
      setFuNote('')
      setFuDue('')
      setFuDone('Follow-up added.')
      onChanged()
    } catch (e) {
      setFuError(errMessage(e, 'Could not add that follow-up. Please try again.'))
    } finally {
      setFuSubmitting(false)
    }
  }

  const inputCls =
    'w-full h-9 px-3 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative bg-white w-full max-w-xl h-full shadow-2xl flex flex-col">
        {/* Drawer header */}
        <div className="px-6 py-4 border-b shrink-0 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-zinc-900 truncate">{target.name}</h2>
            <p className="text-xs text-zinc-400 font-mono">
              {target.phone || 'No phone on file'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md hover:bg-zinc-100 transition-colors text-zinc-500 shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {loading && (
            <div className="flex items-center justify-center py-10 gap-2 text-zinc-400 text-sm">
              <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
              Loading outstanding bills…
            </div>
          )}

          {loadError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
              {loadError}
            </div>
          )}

          {detail && (
            <>
              {/* Position summary */}
              <div className="grid grid-cols-3 gap-3">
                <div className="p-3 rounded-lg border bg-zinc-50">
                  <p className="text-xs text-zinc-500 mb-1">Outstanding</p>
                  <p className="text-base font-bold text-zinc-900">₹{fmt(detail.outstanding)}</p>
                </div>
                <div className="p-3 rounded-lg border bg-zinc-50">
                  <p className="text-xs text-zinc-500 mb-1">Credit limit</p>
                  <p className="text-base font-bold text-zinc-700">
                    {detail.customer.creditLimit > 0 ? `₹${fmt(detail.customer.creditLimit)}` : '—'}
                  </p>
                  <p className="text-[11px] text-zinc-400 mt-0.5">
                    {detail.customer.creditDays > 0
                      ? `${detail.customer.creditDays} day terms`
                      : 'No credit period'}
                  </p>
                </div>
                <div
                  className={`p-3 rounded-lg border ${detail.overLimit ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-100'}`}
                >
                  <p className="text-xs text-zinc-500 mb-1">
                    {detail.overLimit ? 'Over limit by' : 'Available credit'}
                  </p>
                  <p
                    className={`text-base font-bold ${detail.overLimit ? 'text-red-700' : 'text-emerald-700'}`}
                  >
                    ₹{fmt(Math.abs(detail.availableCredit))}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPayOpen((o) => !o)
                    setFuOpen(false)
                    setPayError('')
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-2 h-9 rounded-md bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors"
                >
                  <Wallet className="w-4 h-4" /> Record payment
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setFuOpen((o) => !o)
                    setPayOpen(false)
                    setFuError('')
                    setFuDone('')
                  }}
                  className="flex-1 inline-flex items-center justify-center gap-2 h-9 rounded-md border text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add follow-up
                </button>
              </div>

              {/* Record payment form — allocation is oldest-first on the server,
                  so the cashier only has to say how much came in. */}
              {payOpen && (
                <div className="p-4 rounded-lg border bg-zinc-50 space-y-3">
                  <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide">
                    Record payment
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-xs text-zinc-500 mb-1 block">Amount (₹)</label>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        className={inputCls}
                        placeholder="0.00"
                      />
                    </div>
                    <div>
                      <label className="text-xs text-zinc-500 mb-1 block">Method</label>
                      <select
                        value={payMethod}
                        onChange={(e) => setPayMethod(e.target.value as PaymentMethod)}
                        className={inputCls}
                      >
                        {PAYMENT_METHODS.map((m) => (
                          <option key={m} value={m}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">
                      Reference <span className="text-zinc-400">(optional)</span>
                    </label>
                    <input
                      value={payReference}
                      onChange={(e) => setPayReference(e.target.value)}
                      className={inputCls}
                      placeholder="UPI txn id, cheque no…"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">
                      Note <span className="text-zinc-400">(optional)</span>
                    </label>
                    <input
                      value={payNote}
                      onChange={(e) => setPayNote(e.target.value)}
                      className={inputCls}
                      placeholder="Anything worth remembering"
                    />
                  </div>
                  <p className="text-xs text-zinc-400">
                    Applied to the oldest unpaid bills first.
                  </p>
                  {payError && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
                      {payError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={submitPayment}
                      disabled={paySubmitting}
                      className="h-9 px-4 rounded-md bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    >
                      {paySubmitting ? 'Saving…' : 'Save payment'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayOpen(false)}
                      className="h-9 px-4 rounded-md border text-sm font-medium text-zinc-600 hover:bg-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Follow-up form */}
              {fuOpen && (
                <div className="p-4 rounded-lg border bg-zinc-50 space-y-3">
                  <p className="text-xs font-semibold text-zinc-600 uppercase tracking-wide">
                    Add follow-up
                  </p>
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">Note</label>
                    <textarea
                      value={fuNote}
                      onChange={(e) => setFuNote(e.target.value)}
                      rows={3}
                      className="w-full px-3 py-2 rounded-md border border-input bg-background text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      placeholder="Called, promised to pay by Friday…"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-zinc-500 mb-1 block">
                      Chase on <span className="text-zinc-400">(optional)</span>
                    </label>
                    <input
                      type="date"
                      value={fuDue}
                      onChange={(e) => setFuDue(e.target.value)}
                      className={inputCls}
                    />
                  </div>
                  {fuError && (
                    <div className="p-2.5 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
                      {fuError}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={submitFollowUp}
                      disabled={fuSubmitting}
                      className="h-9 px-4 rounded-md bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors disabled:opacity-50"
                    >
                      {fuSubmitting ? 'Saving…' : 'Save follow-up'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFuOpen(false)}
                      className="h-9 px-4 rounded-md border text-sm font-medium text-zinc-600 hover:bg-white transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {fuDone && !fuOpen && (
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-md text-emerald-700 text-xs">
                  {fuDone}
                </div>
              )}

              {/* Open bills */}
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-2">
                  Open bills
                </p>
                {detail.bills.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 text-center gap-2 rounded-lg border bg-zinc-50">
                    <CheckCircle2 className="w-7 h-7 text-emerald-500" />
                    <p className="text-sm font-medium text-zinc-700">
                      Nothing outstanding — every bill is settled
                    </p>
                  </div>
                ) : (
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50 border-b">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-zinc-600 text-[11px] uppercase tracking-wide">
                            Bill
                          </th>
                          <th className="text-left px-3 py-2 font-semibold text-zinc-600 text-[11px] uppercase tracking-wide">
                            Due
                          </th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-600 text-[11px] uppercase tracking-wide">
                            Balance
                          </th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-600 text-[11px] uppercase tracking-wide">
                            Age
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {detail.bills.map((b) => (
                          <tr key={b.id}>
                            <td className="px-3 py-2">
                              <p className="font-mono font-semibold text-zinc-900 text-xs">
                                {b.billNumber}
                              </p>
                              <p className="text-[11px] text-zinc-400">
                                {fmtDate(b.paidAt)} · ₹{fmt(b.totalAmount)} total, ₹
                                {fmt(b.paidAmount)} paid
                              </p>
                            </td>
                            <td className="px-3 py-2 text-xs text-zinc-600">{fmtDate(b.dueDate)}</td>
                            <td className="px-3 py-2 text-right font-semibold text-zinc-900">
                              ₹{fmt(b.balanceDue)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span
                                className={`inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full border ${BUCKET_STYLE[b.ageBucket]?.chip ?? BUCKET_STYLE.current.chip}`}
                              >
                                {b.daysOverdue > 0
                                  ? `${b.daysOverdue}d overdue`
                                  : BUCKET_STYLE[b.ageBucket]?.short ?? 'Current'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <p className="text-[11px] text-zinc-400 flex items-center gap-1">
                <Receipt className="w-3 h-3" /> {detail.bills.length} open bill
                {detail.bills.length !== 1 ? 's' : ''} for this customer.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
