import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  ClipboardList, RefreshCw, Search, Plus, X, PackageCheck, TriangleAlert,
  Send, Ban, CalendarClock, Boxes
} from 'lucide-react'
import {
  PO_STATUS_LABEL, PO_STATUSES, isEditable, canReceive, canCancel,
  type PurchaseOrderStatus
} from '@shared/procurement'
import { parseQty, qtyStep, formatQty, formatQtyWithUnit, computePurchaseCost } from '@shared/units'
import { round2 } from '@shared/money'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type OrderItem = {
  id: string
  productId: string
  orderedQty: number
  receivedQty: number
  pendingQty: number
  expectedRate: number
  gstPercentage: number
  lineTotal: number
  product: { itemCode: string; name: string; unitOfMeasure: string; sellMode?: string }
}

type Order = {
  id: string
  orderNumber: string
  status: PurchaseOrderStatus
  expectedAt: string | null
  placedAt: string | null
  notes: string | null
  supplier: { name: string; phone?: string | null }
  createdBy?: { username: string }
  items: OrderItem[]
  itemCount: number
  orderTotal: number
}

type Suggestion = {
  productId: string
  itemCode: string
  name: string
  unitOfMeasure: string
  sellMode: string
  totalStock: number
  minStockLevel: number
  suggestedQty: number
  lastRate: number
  gstPercentage: number
}

type SuggestionGroup = { supplierId: string | null; supplierName: string; items: Suggestion[] }
type Supplier = { id: string; name: string; isActive: boolean }
type Warehouse = { id: string; name: string }
type ProductHit = {
  id: string; itemCode: string; name: string; unitOfMeasure: string
  sellMode?: string; gstPercentage: number
}

/** A line being composed in the order form. Amounts stay as strings while typing. */
type DraftLine = {
  key: string
  productId: string
  itemCode: string
  name: string
  unitOfMeasure: string
  sellMode: string
  quantity: string
  expectedRate: string
  gstPercentage: string
}

type Props = { token: string | null }

const fmt = (n: number): string =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    Number.isFinite(n) ? n : 0
  )

const shortDate = (d: string | null): string =>
  d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—'

const STATUS_CLASS: Record<PurchaseOrderStatus, string> = {
  DRAFT: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  PLACED: 'bg-sky-50 text-sky-700 border-sky-200',
  PARTIAL: 'bg-amber-50 text-amber-700 border-amber-200',
  RECEIVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  CANCELLED: 'bg-zinc-50 text-zinc-400 border-zinc-200'
}

let lineSeq = 0
const newDraftLine = (p: Partial<DraftLine> = {}): DraftLine => ({
  key: `line-${++lineSeq}`,
  productId: '', itemCode: '', name: '', unitOfMeasure: 'pcs', sellMode: 'UNIT',
  quantity: '', expectedRate: '', gstPercentage: '0',
  ...p
})

// ─── Screen ───────────────────────────────────────────────────────────────────

export function OrdersScreen({ token }: Props): React.JSX.Element {
  const [orders, setOrders] = useState<Order[]>([])
  const [groups, setGroups] = useState<SuggestionGroup[]>([])
  const [lowStockCount, setLowStockCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  const [statusFilter, setStatusFilter] = useState<'ALL' | PurchaseOrderStatus>('ALL')
  const [search, setSearch] = useState('')

  const [detail, setDetail] = useState<Order | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [formSeed, setFormSeed] = useState<{ supplierId: string; lines: DraftLine[] } | null>(null)
  const [showReceive, setShowReceive] = useState(false)

  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const [ordersRes, sugRes] = await Promise.all([
        axios.get(`${LOCAL_API}/api/v1/purchase-orders`, { headers }),
        axios.get(`${LOCAL_API}/api/v1/purchase-orders/suggestions`, { headers })
      ])
      setOrders(ordersRes.data.orders ?? [])
      setGroups(sugRes.data.groups ?? [])
      setLowStockCount(sugRes.data.lowStockCount ?? 0)
      setLastUpdated(new Date())
    } catch {
      setError('Could not reach the local server. Check that it is running, then refresh.')
    } finally {
      setLoading(false)
    }
  }, [token, headers])

  useEffect(() => { load() }, [load])

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const res = await axios.get(`${LOCAL_API}/api/v1/purchase-orders/${id}`, { headers })
      setDetail(res.data.order)
    } catch { /* the list still shows the last known state */ }
  }, [headers])

  // ─── Derived ───────────────────────────────────────────────────────────────

  const openOrders = orders.filter((o) => o.status === 'PLACED' || o.status === 'PARTIAL')
  const valueOnOrder = round2(
    openOrders.reduce(
      (s, o) => s + o.items.reduce((t, i) => t + i.pendingQty * i.expectedRate, 0),
      0
    )
  )

  const visible = orders.filter((o) => {
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false
    if (!search.trim()) return true
    const q = search.trim().toLowerCase()
    return o.orderNumber.toLowerCase().includes(q) || o.supplier.name.toLowerCase().includes(q)
  })

  const receivedOf = (o: Order): { received: number; ordered: number } => ({
    received: o.items.reduce((s, i) => s + i.receivedQty, 0),
    ordered: o.items.reduce((s, i) => s + i.orderedQty, 0)
  })

  // ─── Actions ───────────────────────────────────────────────────────────────

  const startOrderFromGroup = (g: SuggestionGroup): void => {
    setFormSeed({
      supplierId: g.supplierId ?? '',
      lines: g.items.map((i) =>
        newDraftLine({
          productId: i.productId, itemCode: i.itemCode, name: i.name,
          unitOfMeasure: i.unitOfMeasure, sellMode: i.sellMode,
          quantity: String(i.suggestedQty),
          expectedRate: i.lastRate > 0 ? String(i.lastRate) : '',
          gstPercentage: String(i.gstPercentage)
        })
      )
    })
    setShowForm(true)
  }

  const act = async (id: string, path: string, body?: unknown): Promise<void> => {
    try {
      const res = await axios.post(`${LOCAL_API}/api/v1/purchase-orders/${id}/${path}`, body ?? {}, { headers })
      setDetail(res.data.order)
      await load()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } }
      setError(err.response?.data?.message ?? 'That action could not be completed.')
    }
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div className="border-b pb-4 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="w-7 h-7" /> Orders
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Restocking — what to reorder, what has been ordered, and what has arrived.
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            {lastUpdated
              ? `Updated ${lastUpdated.toLocaleTimeString('en-IN', { hour12: true })}`
              : 'Not loaded yet'}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <Button onClick={() => { setFormSeed(null); setShowForm(true) }} className="gap-2">
            <Plus className="w-4 h-4" /> New order
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">{error}</div>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Kpi label="Open orders" value={String(openOrders.length)} hint="Placed or part received" />
        <Kpi label="Value on order" value={`₹${fmt(valueOnOrder)}`} hint="Goods not yet arrived" />
        <Kpi
          label="Needs reordering"
          value={String(lowStockCount)}
          hint="Products at or below minimum"
          tone={lowStockCount > 0 ? 'warn' : 'ok'}
        />
      </div>

      {/* Reorder suggestions — the reason to open this screen */}
      <section className="rounded-xl border bg-card overflow-hidden">
        <div className="px-5 py-3 border-b bg-zinc-50 flex items-center gap-2">
          <TriangleAlert className="w-4 h-4 text-amber-600" />
          <h2 className="text-sm font-bold text-zinc-700">Needs reordering</h2>
        </div>
        {groups.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-zinc-400">
            Nothing needs reordering — every product is above its minimum.
          </div>
        ) : (
          <div className="divide-y">
            {groups.map((g) => (
              <div key={g.supplierId ?? 'none'} className="px-5 py-4">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div>
                    <p className="font-semibold text-zinc-900 text-sm">{g.supplierName}</p>
                    <p className="text-xs text-muted-foreground">
                      {g.items.length} product{g.items.length !== 1 ? 's' : ''} low
                    </p>
                  </div>
                  {g.supplierId ? (
                    <Button variant="outline" className="h-8 text-xs gap-1.5" onClick={() => startOrderFromGroup(g)}>
                      <Plus className="w-3.5 h-3.5" /> Create order
                    </Button>
                  ) : (
                    <span className="text-xs text-zinc-400 italic">Set a default supplier to order</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {g.items.map((i) => (
                    <span
                      key={i.productId}
                      className="text-xs px-2 py-1 rounded-md bg-amber-50 border border-amber-200 text-amber-800"
                      title={`Minimum ${formatQtyWithUnit(i.minStockLevel, i.unitOfMeasure)}`}
                    >
                      {i.name} · {formatQtyWithUnit(i.totalStock, i.unitOfMeasure)} left
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative max-w-sm flex-1 min-w-[220px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by order number or supplier…"
            className="pl-9 h-9 text-sm"
          />
        </div>
        <div className="flex rounded-lg border overflow-hidden text-sm">
          {(['ALL', ...PO_STATUSES] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s as 'ALL' | PurchaseOrderStatus)}
              className={`px-3 py-1.5 transition-colors ${
                statusFilter === s ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              {s === 'ALL' ? 'All' : PO_STATUS_LABEL[s as PurchaseOrderStatus]}
            </button>
          ))}
        </div>
      </div>

      {/* Orders */}
      <div className="rounded-xl border overflow-hidden bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 border-b">
              <tr>
                <Th>Order</Th><Th>Supplier</Th><Th>Status</Th>
                <Th className="text-right">Items</Th>
                <Th className="text-right">Value</Th>
                <Th>Progress</Th><Th>Expected</Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center text-zinc-400 text-sm">
                    {orders.length === 0
                      ? 'No orders yet. Create one from the reorder list above.'
                      : 'No orders match this filter.'}
                  </td>
                </tr>
              )}
              {visible.map((o) => {
                const { received, ordered } = receivedOf(o)
                return (
                  <tr
                    key={o.id}
                    onClick={() => refreshDetail(o.id)}
                    className={`cursor-pointer hover:bg-zinc-50 transition-colors ${o.status === 'CANCELLED' ? 'opacity-50' : ''}`}
                  >
                    <td className="px-4 py-3 font-mono font-semibold text-zinc-900 text-xs">{o.orderNumber}</td>
                    <td className="px-4 py-3 text-zinc-700">{o.supplier.name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-block text-xs font-semibold px-2.5 py-0.5 rounded-full border ${STATUS_CLASS[o.status]}`}>
                        {PO_STATUS_LABEL[o.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-zinc-600">{o.itemCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-semibold">₹{fmt(o.orderTotal)}</td>
                    <td className="px-4 py-3 text-xs text-zinc-600 tabular-nums">
                      {ordered > 0 ? `${formatQty(received)} of ${formatQty(ordered)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-zinc-500">{shortDate(o.expectedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail */}
      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.orderNumber ?? ''} size="lg">
        {detail && (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-semibold text-zinc-900">{detail.supplier.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Placed {shortDate(detail.placedAt)} · Expected {shortDate(detail.expectedAt)}
                  {detail.createdBy ? ` · by ${detail.createdBy.username}` : ''}
                </p>
              </div>
              <span className={`text-xs font-bold px-3 py-1 rounded-full border ${STATUS_CLASS[detail.status]}`}>
                {PO_STATUS_LABEL[detail.status]}
              </span>
            </div>

            {detail.notes && <p className="text-sm text-zinc-600 bg-zinc-50 border rounded-lg p-3">{detail.notes}</p>}

            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <Th>Product</Th>
                    <Th className="text-right">Ordered</Th>
                    <Th className="text-right">Received</Th>
                    <Th className="text-right">Pending</Th>
                    <Th className="text-right">Rate</Th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {detail.items.map((i) => (
                    <tr key={i.id}>
                      <td className="px-4 py-2.5">
                        <p className="font-medium text-zinc-900">{i.product.name}</p>
                        <p className="text-xs font-mono text-muted-foreground">{i.product.itemCode}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">
                        {formatQtyWithUnit(i.orderedQty, i.product.unitOfMeasure)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-emerald-700">
                        {formatQty(i.receivedQty)}
                      </td>
                      <td className={`px-4 py-2.5 text-right tabular-nums ${i.pendingQty > 0 ? 'text-amber-700 font-semibold' : 'text-zinc-400'}`}>
                        {formatQty(i.pendingQty)}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-zinc-600">₹{fmt(i.expectedRate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center justify-between pt-1">
              <span className="text-sm font-bold text-zinc-900">Order value ₹{fmt(detail.orderTotal)}</span>
              <div className="flex gap-2">
                {isEditable(detail.status) && (
                  <Button onClick={() => act(detail.id, 'place')} className="gap-2 h-9 text-sm">
                    <Send className="w-3.5 h-3.5" /> Place order
                  </Button>
                )}
                {canReceive(detail.status) && (
                  <Button onClick={() => setShowReceive(true)} className="gap-2 h-9 text-sm">
                    <PackageCheck className="w-4 h-4" /> Receive goods
                  </Button>
                )}
                {canCancel(detail.status) && (
                  <Button
                    variant="outline"
                    onClick={() => act(detail.id, 'cancel')}
                    className="gap-2 h-9 text-sm text-red-600 hover:bg-red-50"
                  >
                    <Ban className="w-3.5 h-3.5" /> Cancel
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {detail && (
        <ReceiveGoodsModal
          open={showReceive}
          order={detail}
          token={token}
          onClose={() => setShowReceive(false)}
          onDone={async () => { setShowReceive(false); await refreshDetail(detail.id); await load() }}
        />
      )}

      <OrderFormModal
        open={showForm}
        seed={formSeed}
        token={token}
        onClose={() => setShowForm(false)}
        onDone={async () => { setShowForm(false); await load() }}
      />
    </div>
  )
}

// ─── Bits ─────────────────────────────────────────────────────────────────────

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return (
    <th className={`text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide ${className}`}>
      {children}
    </th>
  )
}

function Kpi({
  label, value, hint, tone = 'plain'
}: {
  label: string; value: string; hint?: string; tone?: 'plain' | 'warn' | 'ok'
}): React.JSX.Element {
  const toneClass =
    tone === 'warn' ? 'text-amber-700' : tone === 'ok' ? 'text-emerald-700' : 'text-zinc-900'
  return (
    <div className="p-5 rounded-xl border bg-card">
      <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 tabular-nums ${toneClass}`}>{value}</p>
      {hint && <p className="text-xs text-zinc-400 mt-1">{hint}</p>}
    </div>
  )
}

// ─── New order ────────────────────────────────────────────────────────────────

function OrderFormModal({
  open, seed, token, onClose, onDone
}: {
  open: boolean
  seed: { supplierId: string; lines: DraftLine[] } | null
  token: string | null
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [expectedAt, setExpectedAt] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [search, setSearch] = useState('')
  const [hits, setHits] = useState<ProductHit[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    setSaving(false)
    setSearch('')
    setHits([])
    setSupplierId(seed?.supplierId ?? '')
    setLines(seed?.lines ?? [])
    setExpectedAt('')
    setNotes('')
    axios
      .get(`${LOCAL_API}/api/v1/suppliers`, { headers })
      .then((r) => setSuppliers((r.data.suppliers ?? []).filter((s: Supplier) => s.isActive)))
      .catch(() => setSuppliers([]))
  }, [open, seed, headers])

  useEffect(() => {
    if (!open || !search.trim()) { setHits([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await axios.get(
          `${LOCAL_API}/api/v1/products?search=${encodeURIComponent(search)}&isActive=true`,
          { headers }
        )
        setHits(r.data.products ?? [])
      } catch { setHits([]) }
    }, 250)
    return () => clearTimeout(t)
  }, [search, open, headers])

  const addProduct = (p: ProductHit): void => {
    setLines((prev) =>
      prev.some((l) => l.productId === p.id)
        ? prev
        : [
            ...prev,
            newDraftLine({
              productId: p.id, itemCode: p.itemCode, name: p.name,
              unitOfMeasure: p.unitOfMeasure, sellMode: p.sellMode ?? 'UNIT',
              gstPercentage: String(p.gstPercentage ?? 0)
            })
          ]
    )
    setSearch('')
    setHits([])
  }

  const setLine = (key: string, patch: Partial<DraftLine>): void =>
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  const total = round2(
    lines.reduce(
      (s, l) => s + (parseQty(Number(l.quantity) || 0, l.sellMode) * (parseFloat(l.expectedRate) || 0)),
      0
    )
  )
  const usable = lines.filter((l) => parseQty(Number(l.quantity) || 0, l.sellMode) > 0)
  const canSave = !!supplierId && usable.length > 0

  const save = async (place: boolean): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError('')
    try {
      await axios.post(
        `${LOCAL_API}/api/v1/purchase-orders`,
        {
          supplierId,
          expectedAt: expectedAt || undefined,
          notes: notes.trim() || undefined,
          place,
          items: usable.map((l) => ({
            productId: l.productId,
            quantity: parseQty(Number(l.quantity) || 0, l.sellMode),
            expectedRate: parseFloat(l.expectedRate) || 0,
            gstPercentage: parseFloat(l.gstPercentage) || 0
          }))
        },
        { headers }
      )
      await onDone()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } }
      setError(err.response?.data?.message ?? 'Could not save the order.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="New purchase order" size="lg">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold mb-1.5">Supplier *</label>
            <select
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Choose a supplier…</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5">Expected delivery</label>
            <Input type="date" value={expectedAt} onChange={(e) => setExpectedAt(e.target.value)} className="h-9" />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5">Notes</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="h-9" />
          </div>
        </div>

        {/* Add products */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search products to add…"
            className="pl-9 h-9 text-sm"
          />
          {hits.length > 0 && (
            <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-lg shadow-xl max-h-56 overflow-y-auto">
              {hits.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => addProduct(p)}
                  className="w-full text-left px-3 py-2 hover:bg-zinc-50 border-b last:border-b-0"
                >
                  <p className="text-sm font-medium text-zinc-900">{p.name}</p>
                  <p className="text-xs font-mono text-muted-foreground">{p.itemCode}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Lines */}
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 border-b">
              <tr>
                <Th>Product</Th>
                <Th className="text-right w-32">Quantity</Th>
                <Th className="text-right w-28">Rate</Th>
                <Th className="text-right w-20">GST %</Th>
                <Th className="text-right w-28">Line</Th>
                <Th className="w-10"> </Th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-zinc-400 text-sm">
                    Search above to add what you want to order.
                  </td>
                </tr>
              )}
              {lines.map((l) => {
                const qty = parseQty(Number(l.quantity) || 0, l.sellMode)
                const line = round2(qty * (parseFloat(l.expectedRate) || 0))
                return (
                  <tr key={l.key}>
                    <td className="px-4 py-2">
                      <p className="font-medium text-zinc-900">{l.name}</p>
                      <p className="text-xs font-mono text-muted-foreground">{l.itemCode}</p>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={qtyStep(l.sellMode)}
                          step={qtyStep(l.sellMode)}
                          value={l.quantity}
                          onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                          className="h-8 text-sm text-right tabular-nums"
                        />
                        <span className="text-xs text-muted-foreground shrink-0">{l.unitOfMeasure}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.expectedRate}
                        onChange={(e) => setLine(l.key, { expectedRate: e.target.value })}
                        className="h-8 text-sm text-right tabular-nums"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <Input
                        type="number"
                        min="0"
                        step="0.5"
                        value={l.gstPercentage}
                        onChange={(e) => setLine(l.key, { gstPercentage: e.target.value })}
                        className="h-8 text-sm text-right tabular-nums"
                      />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">₹{fmt(line)}</td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-1">
          <span className="text-sm font-bold text-zinc-900">Order value ₹{fmt(total)}</span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="outline" onClick={() => save(false)} disabled={saving || !canSave}>
              Save draft
            </Button>
            <Button onClick={() => save(true)} disabled={saving || !canSave} className="gap-2">
              <Send className="w-3.5 h-3.5" /> {saving ? 'Saving…' : 'Save & place'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ─── Goods in ─────────────────────────────────────────────────────────────────

type ReceiveLine = { quantity: string; rate: string; gstPct: string; inclGst: boolean }

/**
 * Receiving turns each delivered line into a stock batch, which is why this
 * asks the same ex/incl-GST question the batch form does. A short delivery is
 * normal and leaves the order open.
 */
function ReceiveGoodsModal({
  open, order, token, onClose, onDone
}: {
  open: boolean
  order: Order
  token: string | null
  onClose: () => void
  onDone: () => void | Promise<void>
}): React.JSX.Element {
  const headers = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token])
  const [rows, setRows] = useState<Record<string, ReceiveLine>>({})
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [warehouseId, setWarehouseId] = useState('')
  const [receivedDate, setReceivedDate] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const pending = order.items.filter((i) => i.pendingQty > 0)

  useEffect(() => {
    if (!open) return
    setError('')
    setSaving(false)
    setNotes('')
    setReceivedDate('')
    setRows(
      Object.fromEntries(
        pending.map((i) => [
          i.id,
          { quantity: String(i.pendingQty), rate: String(i.expectedRate), gstPct: String(i.gstPercentage), inclGst: false }
        ])
      )
    )
    axios
      .get(`${LOCAL_API}/api/v1/warehouses`, { headers })
      .then((r) => setWarehouses(r.data.warehouses ?? []))
      .catch(() => setWarehouses([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order.id, headers])

  const setRow = (id: string, patch: Partial<ReceiveLine>): void =>
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))

  const arriving = pending.filter((i) => (parseFloat(rows[i.id]?.quantity ?? '') || 0) > 0)

  const submit = async (): Promise<void> => {
    if (arriving.length === 0) return
    setSaving(true)
    setError('')
    try {
      await axios.post(
        `${LOCAL_API}/api/v1/purchase-orders/${order.id}/receive`,
        {
          receivedDate: receivedDate || undefined,
          warehouseId: warehouseId || undefined,
          notes: notes.trim() || undefined,
          items: arriving.map((i) => {
            const r = rows[i.id]
            return {
              itemId: i.id,
              quantity: parseQty(Number(r.quantity) || 0, i.product.sellMode),
              purchaseRate: parseFloat(r.rate) || 0,
              purchaseGstPct: parseFloat(r.gstPct) || 0,
              rateIncludesGst: r.inclGst
            }
          })
        },
        { headers }
      )
      await onDone()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { message?: string } } }
      setError(err.response?.data?.message ?? 'Could not record the delivery.')
    } finally {
      setSaving(false)
    }
  }

  const stillShort = pending.some(
    (i) => (parseFloat(rows[i.id]?.quantity ?? '') || 0) < i.pendingQty
  )

  return (
    <Modal open={open} onClose={onClose} title={`Receive goods — ${order.orderNumber}`} size="lg">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-semibold mb-1.5">Received on</label>
            <Input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className="h-9" />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5">Warehouse</label>
            <select
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Not specified</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1.5">Note</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="h-9" />
          </div>
        </div>

        <div className="space-y-3">
          {pending.length === 0 && (
            <p className="text-sm text-zinc-400 text-center py-6">Everything on this order has already arrived.</p>
          )}
          {pending.map((i) => {
            const r = rows[i.id] ?? { quantity: '', rate: '', gstPct: '0', inclGst: false }
            const cost = computePurchaseCost(parseFloat(r.rate) || 0, parseFloat(r.gstPct) || 0, r.inclGst)
            const qty = parseQty(Number(r.quantity) || 0, i.product.sellMode)
            return (
              <div key={i.id} className="rounded-lg border p-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium text-zinc-900 text-sm truncate">{i.product.name}</p>
                    <p className="text-xs font-mono text-muted-foreground">
                      {i.product.itemCode} · {formatQtyWithUnit(i.pendingQty, i.product.unitOfMeasure)} outstanding
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Input
                      type="number"
                      min="0"
                      step={qtyStep(i.product.sellMode)}
                      value={r.quantity}
                      onChange={(e) => setRow(i.id, { quantity: e.target.value })}
                      className="h-9 w-28 text-sm text-right tabular-nums"
                    />
                    <span className="text-xs text-muted-foreground">{i.product.unitOfMeasure}</span>
                  </div>
                </div>

                <div className="flex items-end gap-2 flex-wrap">
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-500 mb-1">Rate</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={r.rate}
                      onChange={(e) => setRow(i.id, { rate: e.target.value })}
                      className="h-8 w-28 text-sm text-right tabular-nums"
                    />
                  </div>
                  <div className="flex rounded-md border overflow-hidden text-xs h-8">
                    {([false, true] as const).map((incl) => (
                      <button
                        key={String(incl)}
                        type="button"
                        onClick={() => setRow(i.id, { inclGst: incl })}
                        className={`px-2.5 transition-colors ${
                          r.inclGst === incl ? 'bg-zinc-900 text-white' : 'bg-white text-zinc-600 hover:bg-zinc-50'
                        }`}
                      >
                        {incl ? 'Incl. GST' : 'Excl. GST'}
                      </button>
                    ))}
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-zinc-500 mb-1">GST %</label>
                    <Input
                      type="number"
                      min="0"
                      step="0.5"
                      value={r.gstPct}
                      onChange={(e) => setRow(i.id, { gstPct: e.target.value })}
                      className="h-8 w-20 text-sm text-right tabular-nums"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground pb-1.5">
                    Base ₹{fmt(cost.rateExGst)} · GST ₹{fmt(cost.gstAmount)} · Landed ₹{fmt(cost.rateInclGst)}
                    {qty > 0 && <> · line ₹{fmt(round2(qty * cost.rateInclGst))}</>}
                  </p>
                </div>
              </div>
            )
          })}
        </div>

        {stillShort && arriving.length > 0 && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 flex items-center gap-2">
            <Boxes className="w-3.5 h-3.5 shrink-0" />
            This is a short delivery — the order stays open for the rest.
          </p>
        )}

        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground flex items-center gap-1.5">
            <CalendarClock className="w-3.5 h-3.5" />
            Each line becomes a stock batch.
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={submit} disabled={saving || arriving.length === 0} className="gap-2">
              <PackageCheck className="w-4 h-4" /> {saving ? 'Recording…' : 'Record delivery'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

export default OrdersScreen
