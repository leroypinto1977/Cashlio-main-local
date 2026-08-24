import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  Wallet,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Lock,
  AlertTriangle,
  CheckCircle2,
  Banknote,
  Smartphone,
  CreditCard,
  FileText,
  History
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type TenderMovement = {
  method: string
  collected: number
  refunded: number
  net: number
  count: number
}

type ClosedDay = {
  businessDate: string
  openingFloat: number
  expectedCash: number
  countedCash: number
  difference: number
  upiTotal: number
  cardTotal: number
  chequeTotal: number
  billCount: number
  salesTotal: number
  notes: string | null
  closedBy: string
  closedAt: string
}

type DayBook = {
  businessDate: string
  sales: { billCount: number; total: number; voided: number }
  returns: { count: number; total: number }
  tenders: TenderMovement[]
  cash: { openingFloat: number; collected: number; refunded: number; expected: number }
  previousClose: { businessDate: string; countedCash: number; difference: number } | null
  closed: ClosedDay | null
  blocking: string[]
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const rupees = (n: number): string =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** `2026-08-24` → `Mon, 24 Aug 2026`. Parsed as a plain calendar date. */
const longDate = (key: string): string => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

const shiftDay = (key: string, days: number): string => {
  const [y, m, d] = key.split('-').map(Number)
  const next = new Date(Date.UTC(y, m - 1, d + days))
  return next.toISOString().slice(0, 10)
}

const todayKey = (): string =>
  new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)

const TENDER_ICON: Record<string, React.ReactNode> = {
  CASH: <Banknote className="w-4 h-4" />,
  UPI: <Smartphone className="w-4 h-4" />,
  CARD: <CreditCard className="w-4 h-4" />,
  CHEQUE: <FileText className="w-4 h-4" />
}

const TENDER_LABEL: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  CHEQUE: 'Cheque'
}

/** How a difference reads to somebody standing at the till. */
function differenceWording(difference: number): { tone: string; label: string } {
  if (difference === 0) return { tone: 'text-emerald-700', label: 'Balanced' }
  if (difference < 0)
    return { tone: 'text-red-700', label: `Short by ${rupees(Math.abs(difference))}` }
  return { tone: 'text-amber-700', label: `Over by ${rupees(difference)}` }
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function DayBookScreen({ token }: { token: string | null }): React.JSX.Element {
  const [date, setDate] = useState<string>(todayKey())
  const [book, setBook] = useState<DayBook | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [role, setRole] = useState<string | null>(null)

  const [openingFloat, setOpeningFloat] = useState<string>('')
  const [countModal, setCountModal] = useState(false)
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<ClosedDay[]>([])
  const [historySummary, setHistorySummary] = useState<{
    days: number
    shortDays: number
    overDays: number
    netDifference: number
  } | null>(null)

  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [token])

  // Only a manager may sign the drawer off. The endpoint re-checks; this
  // decides whether to offer a button that would be refused anyway.
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

  /** Reads the day, optionally against a float the user is trying out. */
  const fetchBook = useCallback(
    async (float?: string): Promise<DayBook | null> => {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ date })
        if (float !== undefined && float.trim() !== '' && Number.isFinite(Number(float))) {
          params.set('openingFloat', float.trim())
        }
        const res = await axios.get(`${LOCAL_API}/api/v1/reports/day-book?${params}`, { headers })
        setBook(res.data.book)
        return res.data.book as DayBook
      } catch (err) {
        setError(
          axios.isAxiosError(err) && err.response?.data?.message
            ? String(err.response.data.message)
            : 'Could not load the day book.'
        )
        setBook(null)
        return null
      } finally {
        setLoading(false)
      }
    },
    [date, headers]
  )

  /** Re-reads the day. The float is applied on screen, so it is not sent. */
  const reload = useCallback(() => fetchBook(), [fetchBook])

  // A new day brings its own float — the one it was closed on, or the one
  // carried over from the day before — so the field is seeded from the server
  // rather than keeping the previous day's number.
  useEffect(() => {
    let cancelled = false
    void fetchBook().then((next) => {
      if (!cancelled && next) setOpeningFloat(String(next.cash.openingFloat))
    })
    return () => {
      cancelled = true
    }
  }, [fetchBook])

  const openHistory = async (): Promise<void> => {
    setHistoryOpen(true)
    try {
      const res = await axios.get(`${LOCAL_API}/api/v1/day-close/history?limit=60`, { headers })
      setHistory(res.data.closes ?? [])
      setHistorySummary(res.data.summary ?? null)
    } catch {
      setHistory([])
      setHistorySummary(null)
    }
  }

  const submitCount = async (): Promise<void> => {
    if (!book) return
    setSaving(true)
    setCloseError(null)
    try {
      await axios.post(
        `${LOCAL_API}/api/v1/day-close`,
        {
          businessDate: book.businessDate,
          openingFloat: Number(openingFloat || 0),
          countedCash: Number(counted),
          notes: notes.trim() || undefined
        },
        { headers }
      )
      setCountModal(false)
      setCounted('')
      setNotes('')
      await reload()
    } catch (err) {
      setCloseError(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : 'Could not close the day.'
      )
    } finally {
      setSaving(false)
    }
  }

  const isToday = date === todayKey()
  const closed = book?.closed ?? null

  // What the books say, against the float that is in the box right now. Worked
  // out here rather than fetched, so the figure on screen can never disagree
  // with the one about to be submitted — the server recomputes it anyway.
  const expectedCash = useMemo(() => {
    if (!book) return 0
    const float = Number(openingFloat)
    const base = Number.isFinite(float) ? float : 0
    return Math.round((base + book.cash.collected - book.cash.refunded) * 100) / 100
  }, [book, openingFloat])

  const liveDifference =
    counted.trim() === '' || !book
      ? null
      : Math.round((Number(counted) - expectedCash) * 100) / 100

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="w-6 h-6" /> Day book
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            What the shop took, and what should be in the drawer because of it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={openHistory}>
            <History className="w-4 h-4 mr-1.5" /> Past counts
          </Button>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {/* ── Day picker ─────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => setDate(shiftDay(date, -1))}>
          <ChevronLeft className="w-4 h-4" />
        </Button>
        <Input
          type="date"
          value={date}
          max={todayKey()}
          onChange={(e) => setDate(e.target.value)}
          className="w-44"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDate(shiftDay(date, 1))}
          disabled={isToday}
        >
          <ChevronRight className="w-4 h-4" />
        </Button>
        <span className="text-sm font-medium ml-2">{longDate(date)}</span>
        {isToday && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
            Today
          </span>
        )}
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">
          {error}
        </div>
      )}

      {book && (
        <>
          {/* ── Already counted ──────────────────────────────────────── */}
          {closed && (
            <div className="p-4 rounded-lg border border-zinc-200 bg-zinc-50">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <Lock className="w-4 h-4" /> Counted and closed
              </div>
              <p className="text-sm text-muted-foreground mt-1">
                {closed.closedBy} counted this day on{' '}
                {new Date(closed.closedAt).toLocaleString('en-IN')}. The figures below are the
                ones that were on screen at the time — later returns against this day&rsquo;s bills
                do not move them.
              </p>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                <Figure label="Expected" value={rupees(closed.expectedCash)} />
                <Figure label="Counted" value={rupees(closed.countedCash)} />
                <Figure
                  label="Difference"
                  value={differenceWording(closed.difference).label}
                  tone={differenceWording(closed.difference).tone}
                />
                <Figure label="Sales" value={`${closed.billCount} bills`} />
              </div>
              {closed.notes && (
                <p className="text-sm mt-3 p-3 rounded border bg-white">
                  <span className="font-medium">Note: </span>
                  {closed.notes}
                </p>
              )}
            </div>
          )}

          {/* ── Still trading ────────────────────────────────────────── */}
          {book.blocking.map((b) => (
            <div
              key={b}
              className="p-3 rounded-lg border border-amber-200 bg-amber-50 text-sm text-amber-900 flex gap-2"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{b}</span>
            </div>
          ))}

          {/* ── The day's trade ──────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card label="Bills" value={String(book.sales.billCount)} sub="excluding voids" />
            <Card label="Sales" value={rupees(book.sales.total)} sub="goods invoiced" />
            <Card
              label="Returns"
              value={rupees(book.returns.total)}
              sub={`${book.returns.count} credit note${book.returns.count === 1 ? '' : 's'}`}
            />
            <Card label="Voided" value={String(book.sales.voided)} sub="cancelled bills" />
          </div>

          {/* ── Money in and out, by tender ──────────────────────────── */}
          <div className="rounded-lg border overflow-hidden">
            <div className="px-4 py-3 border-b bg-zinc-50">
              <h3 className="font-semibold text-sm">Money that moved</h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                Counted from the payments themselves, so a customer settling an old credit bill
                today shows up today — and a sale put on credit today does not.
              </p>
            </div>
            <table className="w-full text-sm">
              <thead className="bg-zinc-50/50 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Tender</th>
                  <th className="text-right px-4 py-2 font-medium">Taken</th>
                  <th className="text-right px-4 py-2 font-medium">Given back</th>
                  <th className="text-right px-4 py-2 font-medium">Net</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {book.tenders.map((tm) => (
                  <tr key={tm.method} className={tm.method === 'CASH' ? 'bg-emerald-50/40' : ''}>
                    <td className="px-4 py-2.5">
                      <span className="flex items-center gap-2">
                        {TENDER_ICON[tm.method] ?? <Wallet className="w-4 h-4" />}
                        {TENDER_LABEL[tm.method] ?? tm.method}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{rupees(tm.collected)}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-muted-foreground">
                      {tm.refunded > 0 ? `− ${rupees(tm.refunded)}` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {rupees(tm.net)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── The drawer ───────────────────────────────────────────── */}
          <div className="rounded-lg border">
            <div className="px-4 py-3 border-b bg-zinc-50">
              <h3 className="font-semibold text-sm">The drawer</h3>
            </div>
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <label className="text-sm font-medium" htmlFor="opening-float">
                    Opening float
                  </label>
                  <p className="text-xs text-muted-foreground">
                    {book.previousClose
                      ? `Carried from ${longDate(book.previousClose.businessDate)}, when ${rupees(book.previousClose.countedCash)} was counted. Change it if the takings were banked.`
                      : 'What was in the drawer before trading started.'}
                  </p>
                </div>
                <Input
                  id="opening-float"
                  type="number"
                  step="0.01"
                  min="0"
                  className="w-40 text-right tabular-nums"
                  value={openingFloat}
                  disabled={!!closed}
                  onChange={(e) => setOpeningFloat(e.target.value)}
                />
              </div>

              <Row label="Cash taken" value={rupees(book.cash.collected)} />
              <Row
                label="Cash given back"
                value={book.cash.refunded > 0 ? `− ${rupees(book.cash.refunded)}` : '—'}
                muted
              />
              <div className="flex items-center justify-between pt-3 border-t">
                <span className="font-semibold">Should be in the drawer</span>
                <span className="text-2xl font-bold tabular-nums">{rupees(expectedCash)}</span>
              </div>

              {!closed && role === 'SUPER_ADMIN' && (
                <Button className="w-full mt-2" onClick={() => setCountModal(true)}>
                  Count the drawer and close {isToday ? 'today' : longDate(date)}
                </Button>
              )}
              {!closed && role !== 'SUPER_ADMIN' && (
                <p className="text-xs text-muted-foreground pt-2">
                  A manager signs the drawer off.
                </p>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Counting ─────────────────────────────────────────────────── */}
      <Modal
        open={countModal}
        onClose={() => setCountModal(false)}
        title={`Count the drawer — ${longDate(date)}`}
      >
        <div className="space-y-4">
          <div className="flex justify-between text-sm p-3 rounded bg-zinc-50 border">
            <span>Books say</span>
            <span className="font-semibold tabular-nums">
              {book ? rupees(expectedCash) : '—'}
            </span>
          </div>

          <div>
            <label className="text-sm font-medium" htmlFor="counted-cash">
              What did you count?
            </label>
            <Input
              id="counted-cash"
              type="number"
              step="0.01"
              min="0"
              autoFocus
              className="mt-1 text-right tabular-nums text-lg"
              value={counted}
              onChange={(e) => setCounted(e.target.value)}
              placeholder="0.00"
            />
          </div>

          {liveDifference !== null && (
            <div
              className={`p-3 rounded border text-sm font-medium flex items-center gap-2 ${
                liveDifference === 0
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : 'border-amber-200 bg-amber-50 text-amber-900'
              }`}
            >
              {liveDifference === 0 ? (
                <CheckCircle2 className="w-4 h-4" />
              ) : (
                <AlertTriangle className="w-4 h-4" />
              )}
              {differenceWording(liveDifference).label}
            </div>
          )}

          <div>
            <label className="text-sm font-medium" htmlFor="close-notes">
              What happened?{' '}
              {liveDifference !== null && liveDifference !== 0 && (
                <span className="text-red-600">Required</span>
              )}
            </label>
            <p className="text-xs text-muted-foreground mb-1">
              A difference nobody explains is the one worth chasing. Money paid out of the till,
              a miscount, a bill rung up wrong — say what you think it was.
            </p>
            <textarea
              id="close-notes"
              rows={3}
              className="w-full rounded-md border px-3 py-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          {closeError && (
            <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-800">
              {closeError}
            </div>
          )}

          <p className="text-xs text-muted-foreground">
            Closing freezes these figures against {longDate(date)}. It cannot be undone.
          </p>

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setCountModal(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={saving || counted.trim() === ''}
              onClick={() => void submitCount()}
            >
              {saving ? 'Closing…' : 'Close the day'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── History ──────────────────────────────────────────────────── */}
      <Modal open={historyOpen} onClose={() => setHistoryOpen(false)} title="Past drawer counts">
        {historySummary && (
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Figure label="Days counted" value={String(historySummary.days)} />
            <Figure
              label="Short"
              value={String(historySummary.shortDays)}
              tone={historySummary.shortDays > 0 ? 'text-red-700' : undefined}
            />
            <Figure
              label="Running difference"
              value={rupees(historySummary.netDifference)}
              tone={differenceWording(historySummary.netDifference).tone}
            />
          </div>
        )}
        <div className="max-h-96 overflow-y-auto -mx-1">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground sticky top-0 bg-white">
              <tr>
                <th className="text-left px-2 py-2 font-medium">Day</th>
                <th className="text-right px-2 py-2 font-medium">Expected</th>
                <th className="text-right px-2 py-2 font-medium">Counted</th>
                <th className="text-right px-2 py-2 font-medium">Difference</th>
                <th className="text-left px-2 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {history.map((c) => (
                <tr
                  key={c.businessDate}
                  className="cursor-pointer hover:bg-zinc-50"
                  onClick={() => {
                    setDate(c.businessDate)
                    setHistoryOpen(false)
                  }}
                >
                  <td className="px-2 py-2">{longDate(c.businessDate)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{rupees(c.expectedCash)}</td>
                  <td className="px-2 py-2 text-right tabular-nums">{rupees(c.countedCash)}</td>
                  <td
                    className={`px-2 py-2 text-right tabular-nums font-medium ${differenceWording(c.difference).tone}`}
                  >
                    {c.difference === 0 ? 'Balanced' : rupees(c.difference)}
                  </td>
                  <td className="px-2 py-2 text-muted-foreground">{c.closedBy}</td>
                </tr>
              ))}
              {history.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-8 text-center text-muted-foreground">
                    No day has been counted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  )
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

function Card({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div className="p-4 rounded-lg border">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xl font-bold mt-1 tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function Figure({
  label,
  value,
  tone
}: {
  label: string
  value: string
  tone?: string
}): React.JSX.Element {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-semibold mt-0.5 tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  )
}

function Row({
  label,
  value,
  muted
}: {
  label: string
  value: string
  muted?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? 'text-muted-foreground' : ''}>{label}</span>
      <span className={`tabular-nums ${muted ? 'text-muted-foreground' : ''}`}>{value}</span>
    </div>
  )
}
