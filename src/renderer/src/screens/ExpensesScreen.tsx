import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  Wallet,
  Plus,
  RefreshCw,
  Trash2,
  Pencil,
  CalendarClock,
  Banknote,
  AlertTriangle
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type Category = { id: string; name: string; kind: string; isActive: boolean; expenseCount: number }

type Expense = {
  id: string
  category: { id: string; name: string; kind: string }
  amount: number
  gstAmount: number
  netCost: number
  paidOn: string
  method: string
  paidFromTill: boolean
  payee: string | null
  reference: string | null
  notes: string | null
  isRecurring: boolean
  recordedBy: string
}

type Totals = {
  paid: number
  gst: number
  net: number
  fixed: number
  variable: number
  count: number
}

type CategoryTotal = {
  categoryId: string
  name: string
  kind: string
  amount: number
  netCost: number
  count: number
}

type Due = {
  categoryId: string
  name: string
  lastAmount: number
  lastGstAmount: number
  lastPaidOn: string
  lastMethod: string
  payee: string | null
}

const METHODS = ['CASH', 'UPI', 'CARD', 'CHEQUE', 'BANK'] as const

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  UPI: 'UPI',
  CARD: 'Card',
  CHEQUE: 'Cheque',
  BANK: 'Bank transfer'
}

const rupees = (n: number): string =>
  `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const todayKey = (): string =>
  new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10)

const monthStartKey = (): string => `${todayKey().slice(0, 7)}-01`

const prettyDate = (key: string): string => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

type Form = {
  id: string | null
  categoryId: string
  amount: string
  gstAmount: string
  paidOn: string
  method: string
  paidFromTill: boolean
  payee: string
  reference: string
  notes: string
  isRecurring: boolean
}

const emptyForm = (): Form => ({
  id: null,
  categoryId: '',
  amount: '',
  gstAmount: '',
  paidOn: todayKey(),
  method: 'CASH',
  paidFromTill: false,
  payee: '',
  reference: '',
  notes: '',
  isRecurring: false
})

// ─── Screen ───────────────────────────────────────────────────────────────────

export function ExpensesScreen({ token }: { token: string | null }): React.JSX.Element {
  const [from, setFrom] = useState(monthStartKey())
  const [to, setTo] = useState(todayKey())
  const [categories, setCategories] = useState<Category[]>([])
  const [expenses, setExpenses] = useState<Expense[]>([])
  const [totals, setTotals] = useState<Totals | null>(null)
  const [byCategory, setByCategory] = useState<CategoryTotal[]>([])
  const [due, setDue] = useState<Due[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState<Form>(emptyForm())
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [token])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const range = `from=${from}&to=${to}`
      const [cats, list, summary, recurring] = await Promise.all([
        axios.get(`${LOCAL_API}/api/v1/expense-categories`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/expenses?${range}&limit=200`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/expenses/summary?${range}`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/expenses/recurring-due`, { headers })
      ])
      setCategories(cats.data.categories ?? [])
      setExpenses(list.data.expenses ?? [])
      setTotals(summary.data.totals ?? null)
      setByCategory(summary.data.byCategory ?? [])
      setDue(recurring.data.due ?? [])
    } catch (err) {
      setError(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : 'Could not load expenses.'
      )
    } finally {
      setLoading(false)
    }
  }, [from, to, headers])

  useEffect(() => {
    void load()
  }, [load])

  const openNew = (prefill?: Partial<Form>): void => {
    setForm({ ...emptyForm(), categoryId: categories[0]?.id ?? '', ...prefill })
    setFormError('')
    setShowForm(true)
  }

  const openEdit = (e: Expense): void => {
    setForm({
      id: e.id,
      categoryId: e.category.id,
      amount: String(e.amount),
      gstAmount: e.gstAmount ? String(e.gstAmount) : '',
      paidOn: e.paidOn,
      method: e.method,
      paidFromTill: e.paidFromTill,
      payee: e.payee ?? '',
      reference: e.reference ?? '',
      notes: e.notes ?? '',
      isRecurring: e.isRecurring
    })
    setFormError('')
    setShowForm(true)
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setFormError('')
    const body = {
      categoryId: form.categoryId,
      amount: Number(form.amount),
      gstAmount: form.gstAmount.trim() === '' ? 0 : Number(form.gstAmount),
      paidOn: form.paidOn,
      method: form.method,
      paidFromTill: form.paidFromTill,
      payee: form.payee.trim() || null,
      reference: form.reference.trim() || null,
      notes: form.notes.trim() || null,
      isRecurring: form.isRecurring
    }
    try {
      if (form.id) {
        await axios.put(`${LOCAL_API}/api/v1/expenses/${form.id}`, body, { headers })
      } else {
        await axios.post(`${LOCAL_API}/api/v1/expenses`, body, { headers })
      }
      setShowForm(false)
      await load()
    } catch (err) {
      setFormError(
        axios.isAxiosError(err) && err.response?.data?.message
          ? String(err.response.data.message)
          : 'Could not save this expense.'
      )
    } finally {
      setSaving(false)
    }
  }

  const remove = async (e: Expense): Promise<void> => {
    if (!confirm(`Delete the ${rupees(e.amount)} ${e.category.name.toLowerCase()} entry?`)) return
    await axios.delete(`${LOCAL_API}/api/v1/expenses/${e.id}`, { headers })
    await load()
  }

  // Cash is the only tender that can leave the drawer, so the option only
  // appears when it applies.
  const tillApplies = form.method === 'CASH'

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <Wallet className="w-6 h-6" /> Expenses
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Everything the shop spends that is not stock. Without these, the profit figure
            on Analytics is only what the goods earned.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button size="sm" onClick={() => openNew()}>
            <Plus className="w-4 h-4 mr-1.5" /> Record an expense
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="w-44" />
        <span className="text-muted-foreground">to</span>
        <Input type="date" value={to} min={from} max={todayKey()} onChange={(e) => setTo(e.target.value)} className="w-44" />
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setFrom(monthStartKey())
            setTo(todayKey())
          }}
        >
          This month
        </Button>
      </div>

      {error && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50 text-sm text-red-800">{error}</div>
      )}

      {/* Monthly costs nobody has entered yet. Pointed at, never created. */}
      {due.length > 0 && (
        <div className="p-4 rounded-lg border border-amber-200 bg-amber-50">
          <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
            <CalendarClock className="w-4 h-4" /> Not recorded this month
          </p>
          <p className="text-xs text-amber-800 mt-1">
            These come round every month and have no entry yet. Nothing is added for you —
            a rent figure that repeated itself after the rent went up would be worse than a
            missing one.
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {due.map((d) => (
              <button
                key={d.categoryId}
                type="button"
                onClick={() =>
                  openNew({
                    categoryId: d.categoryId,
                    amount: String(d.lastAmount),
                    gstAmount: d.lastGstAmount ? String(d.lastGstAmount) : '',
                    method: d.lastMethod,
                    payee: d.payee ?? '',
                    isRecurring: true
                  })
                }
                className="px-3 py-1.5 rounded-md border border-amber-300 bg-white text-xs hover:bg-amber-100 transition-colors"
              >
                <span className="font-medium">{d.name}</span>
                <span className="text-muted-foreground ml-1.5">
                  was {rupees(d.lastAmount)} on {prettyDate(d.lastPaidOn)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Totals */}
      {totals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <Card label="Spent" value={rupees(totals.paid)} sub={`${totals.count} entries`} />
          <Card
            label="Actual cost"
            value={rupees(totals.net)}
            sub={totals.gst > 0 ? `${rupees(totals.gst)} of GST reclaimable` : 'no GST paid'}
          />
          <Card label="Fixed" value={rupees(totals.fixed)} sub="there regardless of trade" />
          <Card label="Variable" value={rupees(totals.variable)} sub="moves with trade" />
        </div>
      )}

      {/* By category */}
      {byCategory.length > 0 && (
        <div className="rounded-lg border overflow-hidden">
          <div className="px-4 py-3 border-b bg-zinc-50">
            <h3 className="font-semibold text-sm">Where it went</h3>
          </div>
          <div className="p-4 space-y-2">
            {byCategory.map((c) => {
              const share = totals && totals.net > 0 ? (c.netCost / totals.net) * 100 : 0
              return (
                <div key={c.categoryId} className="flex items-center gap-3 text-sm">
                  <span className="w-48 shrink-0 truncate">{c.name}</span>
                  <div className="flex-1 h-2.5 rounded-full bg-zinc-100 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${c.kind === 'FIXED' ? 'bg-zinc-700' : 'bg-zinc-400'}`}
                      style={{ width: `${Math.max(2, share)}%` }}
                    />
                  </div>
                  <span className="w-16 text-right text-xs text-muted-foreground shrink-0">
                    {share.toFixed(0)}%
                  </span>
                  <span className="w-28 text-right tabular-nums font-medium shrink-0">
                    {rupees(c.netCost)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* The entries */}
      <div className="rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-xs uppercase text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Date</th>
              <th className="text-left px-4 py-2.5 font-medium">Category</th>
              <th className="text-left px-4 py-2.5 font-medium">Paid to</th>
              <th className="text-left px-4 py-2.5 font-medium">How</th>
              <th className="text-right px-4 py-2.5 font-medium">Amount</th>
              <th className="text-right px-4 py-2.5 font-medium">Cost</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {expenses.map((e) => (
              <tr key={e.id} className="hover:bg-zinc-50/60 group">
                <td className="px-4 py-2.5 whitespace-nowrap">{prettyDate(e.paidOn)}</td>
                <td className="px-4 py-2.5">
                  <span>{e.category.name}</span>
                  {e.isRecurring && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600">
                      monthly
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {e.payee || '—'}
                  {e.reference && <span className="font-mono text-xs ml-1.5">{e.reference}</span>}
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-muted-foreground">{METHOD_LABEL[e.method] ?? e.method}</span>
                  {e.paidFromTill && (
                    <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-800 border border-amber-200 inline-flex items-center gap-1">
                      <Banknote className="w-3 h-3" /> from till
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{rupees(e.amount)}</td>
                <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                  {rupees(e.netCost)}
                  {e.gstAmount > 0 && (
                    <span className="block text-[11px] text-muted-foreground font-normal">
                      {rupees(e.gstAmount)} GST back
                    </span>
                  )}
                </td>
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      type="button"
                      aria-label="Edit"
                      onClick={() => openEdit(e)}
                      className="p-1.5 rounded hover:bg-zinc-200"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="Delete"
                      onClick={() => void remove(e)}
                      className="p-1.5 rounded hover:bg-red-100 hover:text-red-700"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
            {expenses.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  Nothing recorded between {prettyDate(from)} and {prettyDate(to)}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── The form ─────────────────────────────────────────────────── */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={form.id ? 'Edit expense' : 'Record an expense'}
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-category">
              What was it for
            </label>
            <select
              id="exp-category"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Choose…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-amount">
                Amount paid
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                <Input
                  id="exp-amount"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.amount}
                  onChange={(e) => setForm({ ...form, amount: e.target.value })}
                  className="h-11 pl-7 text-right tabular-nums"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-gst">
                GST inside that
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
                <Input
                  id="exp-gst"
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.gstAmount}
                  onChange={(e) => setForm({ ...form, gstAmount: e.target.value })}
                  className="h-11 pl-7 text-right tabular-nums"
                  placeholder="0.00"
                />
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            The tax already inside the amount, not on top of it. A registered shop reclaims
            it, so it is not counted as a cost.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-date">
                Date
              </label>
              <Input
                id="exp-date"
                type="date"
                value={form.paidOn}
                onChange={(e) => setForm({ ...form, paidOn: e.target.value })}
                className="h-11"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-method">
                Paid by
              </label>
              <select
                id="exp-method"
                value={form.method}
                onChange={(e) =>
                  setForm({
                    ...form,
                    method: e.target.value,
                    // Only cash leaves the drawer; switching away clears it so
                    // the day book can never be pulled down by a card payment.
                    paidFromTill: e.target.value === 'CASH' ? form.paidFromTill : false
                  })
                }
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {tillApplies && (
            <label className="flex items-start gap-2.5 p-3 rounded-md border cursor-pointer hover:bg-zinc-50">
              <input
                type="checkbox"
                checked={form.paidFromTill}
                onChange={(e) => setForm({ ...form, paidFromTill: e.target.checked })}
                className="mt-0.5"
              />
              <span className="text-sm">
                Taken out of the till
                <span className="block text-xs text-muted-foreground mt-0.5">
                  The day book subtracts it, so the drawer still balances at close. Leave it
                  off if the money came from a bank or a pocket.
                </span>
              </span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-payee">
                Paid to
              </label>
              <Input
                id="exp-payee"
                value={form.payee}
                onChange={(e) => setForm({ ...form, payee: e.target.value })}
                className="h-11"
                placeholder="Optional"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-ref">
                Reference
              </label>
              <Input
                id="exp-ref"
                value={form.reference}
                onChange={(e) => setForm({ ...form, reference: e.target.value })}
                className="h-11 font-mono"
                placeholder="Bill or cheque number"
              />
            </div>
          </div>

          <label className="flex items-start gap-2.5 p-3 rounded-md border cursor-pointer hover:bg-zinc-50">
            <input
              type="checkbox"
              checked={form.isRecurring}
              onChange={(e) => setForm({ ...form, isRecurring: e.target.checked })}
              className="mt-0.5"
            />
            <span className="text-sm">
              This comes round every month
              <span className="block text-xs text-muted-foreground mt-0.5">
                Months it has not been entered in get pointed out. Nothing is created for
                you.
              </span>
            </span>
          </label>

          <div>
            <label className="block text-sm font-semibold mb-1.5" htmlFor="exp-notes">
              Notes
            </label>
            <textarea
              id="exp-notes"
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="w-full rounded-md border px-3 py-2 text-sm"
            />
          </div>

          {formError && (
            <div className="p-3 rounded border border-red-200 bg-red-50 text-sm text-red-800 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              {formError}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={saving || !form.categoryId || form.amount.trim() === ''}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : form.id ? 'Save changes' : 'Record it'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

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
