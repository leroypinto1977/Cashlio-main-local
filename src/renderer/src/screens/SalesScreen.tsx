import { useState, useEffect, useCallback } from 'react'
import { Search, BarChart3, Receipt, ChevronLeft, ChevronRight, XCircle, RefreshCw, Tag, TrendingUp, TrendingDown, Printer, Undo2, ExternalLink } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'
import { printReceipt, type ReceiptShop } from '../lib/receipt'
import { RETURN_REASONS, shouldRestock, returnReasonLabel, type ReturnReasonCode } from '@shared/procurement'

// ─── Types ────────────────────────────────────────────────────────────────────

type BillStatus = 'PAID' | 'PARTIAL' | 'CREDIT' | 'VOID' | 'RETURN'

type BillSummary = {
  id: string
  billNumber: string
  status: BillStatus
  paidAt: string
  paymentMethod: string
  totalAmount: number
  paidAmount: number
  balanceDue: number
  discountAmount: number
  customer: { name: string } | null
  cashier: { username: string }
  originDevice: { friendlyName: string }
  _count: { items: number }
}

type BillDetail = {
  id: string
  billNumber: string
  status: BillStatus
  paidAt: string
  paymentMethod: string
  subtotal: number
  gstAmount: number
  paidAmount: number
  balanceDue: number
  dueDate: string | null
  discountAmount: number
  totalAmount: number
  amountReceived: number | null
  changeGiven: number | null
  notes: string | null
  returnReason?: string | null
  customer: { name: string; phone: string } | null
  cashier: { username: string }
  originDevice: { friendlyName: string }
  originalBill?: { id: string; billNumber: string; status: BillStatus } | null
  returns?: {
    id: string; billNumber: string; status: BillStatus; totalAmount: number
    paidAt: string; returnReason: string | null; returnReasonCode?: string | null
  }[]
  items: {
    id: string
    itemCode: string
    productName: string
    unitOfMeasure: string
    quantity: number
    unitRate: number
    gstPercentage: number
    lineDiscountPct: number
    lineDiscountAmt: number
    lineGstAmount: number
    lineTotal: number
    purchaseRate: number | null
    alreadyReturnedQty?: number
  }[]
}

const STATUS_BADGE: Record<BillStatus, string> = {
  PAID:    'bg-emerald-50 text-emerald-700 border border-emerald-200',
  PARTIAL: 'bg-sky-50 text-sky-700 border border-sky-200',
  CREDIT:  'bg-orange-50 text-orange-700 border border-orange-200',
  VOID:    'bg-red-50 text-red-600 border border-red-200',
  RETURN:  'bg-amber-50 text-amber-700 border border-amber-200'
}

const STATUS_LABEL: Record<BillStatus | 'ALL', string> = {
  ALL: 'All',
  PAID: 'Paid',
  PARTIAL: 'Part paid',
  CREDIT: 'Credit',
  RETURN: 'Return',
  VOID: 'Void'
}

// A bill can be returned against while it still exists as a sale — that
// now includes part-paid and credit bills, where the refund comes off
// what is still owed.
const RETURNABLE = ['PAID', 'PARTIAL', 'CREDIT']

type Props = { token: string | null }

const PAGE_SIZE = 20

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const PM_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card' }

export function SalesScreen({ token }: Props) {
  const [bills, setBills] = useState<BillSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'ALL' | BillStatus>('ALL')
  const [loading, setLoading] = useState(false)

  const [detailBill, setDetailBill] = useState<BillDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [voidConfirm, setVoidConfirm] = useState<BillSummary | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [voidError, setVoidError] = useState('')

  const [shopInfo, setShopInfo] = useState<ReceiptShop>({ name: 'My Shop' })
  const [reprinting, setReprinting] = useState(false)
  const [reprintError, setReprintError] = useState('')

  // Return flow state
  const [returnFor, setReturnFor] = useState<BillDetail | null>(null)
  const [returnQty, setReturnQty] = useState<Record<string, number>>({})
  const [returnReason, setReturnReason] = useState('')
  const [returnReasonCode, setReturnReasonCode] = useState<ReturnReasonCode | ''>('')
  // A reason is required so returns can be reported on later.
  const [returnSubmitting, setReturnSubmitting] = useState(false)
  const [returnError, setReturnError] = useState('')

  useEffect(() => {
    if (!token) return
    apiFetch<{ shopName?: string; branchName?: string }>('/api/v1/system/status', token)
      .then((d) => setShopInfo({ name: d.shopName || 'My Shop', branch: d.branchName || null }))
      .catch(() => {})
  }, [token])

  const reprint = async (b: BillDetail) => {
    setReprinting(true); setReprintError('')
    const r = await printReceipt(shopInfo, {
      billNumber: b.billNumber,
      paidAt: b.paidAt,
      paymentMethod: b.paymentMethod,
      subtotal: b.subtotal,
      gstAmount: b.gstAmount,
      discountAmount: b.discountAmount,
      totalAmount: b.totalAmount,
      amountReceived: b.amountReceived,
      changeGiven: b.changeGiven,
      customerName: b.customer?.name ?? null,
      cashierName: b.cashier.username,
      status: b.status,
      items: b.items.map((it) => ({
        itemCode: it.itemCode,
        productName: it.productName,
        quantity: it.quantity,
        unitRate: it.unitRate,
        lineTotal: it.lineTotal
      }))
    }, { copyLabel: 'REPRINT' })
    setReprinting(false)
    if (!r.ok) setReprintError(r.error || 'Print failed')
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const fetchBills = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
        ...(search ? { search } : {}),
        ...(statusFilter !== 'ALL' ? { status: statusFilter } : {})
      })
      const data = await apiFetch<{ bills: BillSummary[]; total: number }>(
        `/api/v1/bills?${params}`,
        token
      )
      setBills(data.bills)
      setTotal(data.total)
    } catch {
      setBills([])
    } finally {
      setLoading(false)
    }
  }, [token, page, search, statusFilter])

  useEffect(() => {
    fetchBills()
  }, [fetchBills])

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1)
  }, [search, statusFilter])

  const openDetail = async (id: string) => {
    setDetailBill(null)
    setDetailLoading(true)
    try {
      const data = await apiFetch<{ bill: BillDetail }>(`/api/v1/bills/${id}`, token)
      setDetailBill(data.bill)
    } catch {
      // ignore
    } finally {
      setDetailLoading(false)
    }
  }

  const startReturn = (b: BillDetail) => {
    const initial: Record<string, number> = {}
    for (const it of b.items) initial[it.id] = 0
    setReturnQty(initial)
    setReturnReason('')
    setReturnReasonCode('')
    setReturnError('')
    setReturnFor(b)
  }

  const submitReturn = async () => {
    if (!returnFor || !token) return
    const items = Object.entries(returnQty)
      .filter(([, q]) => q > 0)
      .map(([billItemId, quantity]) => ({ billItemId, quantity }))
    if (items.length === 0) {
      setReturnError('Select at least one item to return.')
      return
    }
    setReturnSubmitting(true)
    setReturnError('')
    try {
      const d = await apiFetch<{ bill: BillDetail }>(`/api/v1/bills/${returnFor.id}/return`, token, {
        method: 'POST',
        body: JSON.stringify({
          items,
          reasonCode: returnReasonCode || undefined,
          reason: returnReason.trim() || undefined
        })
      })
      // Print refund receipt with RETURN banner
      void printReceipt(shopInfo, {
        billNumber: d.bill.billNumber,
        paidAt: d.bill.paidAt,
        paymentMethod: d.bill.paymentMethod,
        subtotal: d.bill.subtotal,
        gstAmount: d.bill.gstAmount,
        discountAmount: d.bill.discountAmount,
        totalAmount: d.bill.totalAmount,
        customerName: d.bill.customer?.name ?? null,
        cashierName: d.bill.cashier.username,
        status: 'RETURN',
        items: d.bill.items.map((it) => ({
          itemCode: it.itemCode,
          productName: it.productName,
          quantity: it.quantity,
          unitRate: it.unitRate,
          lineTotal: it.lineTotal
        }))
      })
      setReturnFor(null)
      setDetailBill(null)
      fetchBills()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; remaining?: number; requested?: number } }
      const code = e.data?.error
      if (code === 'RETURN_QTY_EXCEEDS_REMAINING') {
        setReturnError(`Quantity exceeds what's still returnable on this line (remaining ${e.data?.remaining}).`)
      } else if (code === 'ORIGINAL_NOT_PAID') {
        setReturnError('This bill is not eligible for return (already voided or refunded).')
      } else {
        setReturnError('Failed to process return. Please try again.')
      }
    } finally {
      setReturnSubmitting(false)
    }
  }

  const handleVoid = async () => {
    if (!voidConfirm || !token) return
    setVoiding(true)
    setVoidError('')
    try {
      await apiFetch(`/api/v1/bills/${voidConfirm.id}/void`, token, { method: 'POST' })
      setVoidConfirm(null)
      setDetailBill(null)
      fetchBills()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to void bill'
      setVoidError(msg)
    } finally {
      setVoiding(false)
    }
  }

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <BarChart3 className="w-6 h-6" /> Sales History
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            View and manage all bills. SUPER_ADMIN can void bills.
          </p>
        </div>
        <Button variant="outline" onClick={fetchBills} className="gap-2 h-9 text-sm">
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search bill # or customer…"
            className="pl-9 h-9 text-sm"
          />
        </div>
        <div className="flex rounded-lg border overflow-hidden text-sm">
          {(['ALL', 'PAID', 'PARTIAL', 'CREDIT', 'RETURN', 'VOID'] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 transition-colors ${
                statusFilter === s
                  ? 'bg-zinc-900 text-white'
                  : 'bg-white text-zinc-600 hover:bg-zinc-50'
              }`}
            >
              {STATUS_LABEL[s]}
            </button>
          ))}
        </div>
        <span className="text-sm text-zinc-500">{total} bill{total !== 1 ? 's' : ''}</span>
      </div>

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Bill #</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Date</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Customer</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Cashier / Terminal</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Payment</th>
              <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Total</th>
              <th className="text-center px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={8} className="text-center py-16 text-zinc-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
                    Loading…
                  </div>
                </td>
              </tr>
            )}
            {!loading && bills.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
                    <Receipt className="w-10 h-10 text-zinc-300" />
                    <p className="text-sm font-medium">No bills found</p>
                  </div>
                </td>
              </tr>
            )}
            {!loading && bills.map((b) => (
              <tr
                key={b.id}
                className={`hover:bg-zinc-50 cursor-pointer transition-colors ${b.status === 'VOID' ? 'opacity-50' : b.status === 'RETURN' ? 'bg-amber-50/30' : ''}`}
                onClick={() => openDetail(b.id)}
              >
                <td className="px-4 py-3 font-mono font-semibold text-zinc-900 text-sm">{b.billNumber}</td>
                <td className="px-4 py-3 text-zinc-600 text-xs">
                  {new Date(b.paidAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                  <br />
                  <span className="text-zinc-400">{new Date(b.paidAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                </td>
                <td className="px-4 py-3 text-zinc-700">{b.customer?.name ?? <span className="text-zinc-400 italic">Walk-in</span>}</td>
                <td className="px-4 py-3">
                  <p className="text-zinc-700 text-xs font-mono">{b.cashier.username}</p>
                  <p className="text-zinc-400 text-xs">{b.originDevice.friendlyName}</p>
                </td>
                <td className="px-4 py-3">
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700">
                    {PM_LABEL[b.paymentMethod] ?? b.paymentMethod}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <p className="font-semibold text-zinc-900">₹{fmt(b.totalAmount)}</p>
                  {b.balanceDue > 0 && (
                    <p className="text-xs font-semibold text-orange-600 mt-0.5">
                      ₹{fmt(b.balanceDue)} due
                    </p>
                  )}
                  {b.discountAmount > 0 && (
                    <p className="text-xs text-emerald-600 mt-0.5">−₹{fmt(b.discountAmount)} disc</p>
                  )}
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-0.5 rounded-full ${STATUS_BADGE[b.status]}`}>
                    {b.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <span className="text-xs text-zinc-400">{b._count.items} item{b._count.items !== 1 ? 's' : ''}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500">
            Page {page} of {totalPages}
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Bill Detail Modal */}
      <Modal
        open={detailLoading || detailBill !== null}
        onClose={() => { setDetailBill(null); setVoidError('') }}
        title={detailBill ? `Bill ${detailBill.billNumber}` : 'Loading…'}
        size="lg"
      >
        {detailLoading && (
          <div className="flex items-center justify-center py-10 gap-2 text-zinc-400">
            <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
            Loading bill…
          </div>
        )}
        {detailBill && (
          <div className="space-y-5">
            {/* Meta row */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Date & Time</p>
                <p className="font-medium text-zinc-900">
                  {new Date(detailBill.paidAt).toLocaleString('en-IN')}
                </p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Payment Method</p>
                <p className="font-medium">{PM_LABEL[detailBill.paymentMethod] ?? detailBill.paymentMethod}</p>
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Customer</p>
                <p className="font-medium">{detailBill.customer?.name ?? 'Walk-in'}</p>
                {detailBill.customer?.phone && (
                  <p className="text-xs text-zinc-400 font-mono">{detailBill.customer.phone}</p>
                )}
              </div>
              <div>
                <p className="text-xs text-zinc-500 font-medium mb-0.5">Cashier / Terminal</p>
                <p className="font-medium">{detailBill.cashier.username}</p>
                <p className="text-xs text-zinc-400">{detailBill.originDevice.friendlyName}</p>
              </div>
            </div>

            {/* Status badge */}
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-1 text-xs font-bold px-3 py-1 rounded-full ${STATUS_BADGE[detailBill.status]}`}>
                {detailBill.status}
              </span>
              {detailBill.originalBill && (
                <button
                  type="button"
                  onClick={() => openDetail(detailBill.originalBill!.id)}
                  className="inline-flex items-center gap-1 text-xs text-zinc-600 hover:text-zinc-900 underline underline-offset-2"
                  title="View original bill"
                >
                  <ExternalLink className="w-3 h-3" /> Original {detailBill.originalBill.billNumber}
                </button>
              )}
              {RETURNABLE.includes(detailBill.status) && (() => {
                const totalReturned = detailBill.items.reduce((s, it) => s + (it.alreadyReturnedQty ?? 0), 0)
                const totalQty = detailBill.items.reduce((s, it) => s + it.quantity, 0)
                const fullyReturned = totalReturned >= totalQty
                const hasReturns = (detailBill.returns?.length ?? 0) > 0
                return (
                  <>
                    {!fullyReturned && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startReturn(detailBill)}
                        className="h-7 px-3 text-xs text-amber-700 border-amber-200 hover:bg-amber-50"
                      >
                        <Undo2 className="w-3.5 h-3.5 mr-1" /> Return / Refund
                      </Button>
                    )}
                    {!hasReturns && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { setVoidConfirm({ id: detailBill.id, billNumber: detailBill.billNumber } as BillSummary) }}
                        className="h-7 px-3 text-xs text-red-600 border-red-200 hover:bg-red-50"
                      >
                        <XCircle className="w-3.5 h-3.5 mr-1" /> Void Bill
                      </Button>
                    )}
                  </>
                )
              })()}
              <Button
                variant="outline"
                size="sm"
                onClick={() => reprint(detailBill)}
                disabled={reprinting}
                className="h-7 px-3 text-xs"
              >
                <Printer className="w-3.5 h-3.5 mr-1" /> {reprinting ? 'Printing…' : 'Reprint'}
              </Button>
              {reprintError && <span className="text-xs text-red-600 ml-2">{reprintError}</span>}
            </div>

            {/* Items table — with discount type and margin */}
            {(() => {
              const totalLineDiscounts = detailBill.items.reduce((s, it) => s + (it.quantity * it.unitRate - it.lineTotal), 0)
              const estCOGS = detailBill.items.reduce((s, it) => s + (it.purchaseRate != null ? it.quantity * it.purchaseRate : 0), 0)
              const estProfit = detailBill.totalAmount - estCOGS
              const estMarginPct = detailBill.totalAmount > 0 ? (estProfit / detailBill.totalAmount) * 100 : 0
              const hasCOGS = detailBill.items.some((it) => it.purchaseRate != null)
              return (
                <>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-50 border-b">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-zinc-500 text-xs">#</th>
                          <th className="text-left px-3 py-2 font-semibold text-zinc-500 text-xs">Product</th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Qty</th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Rate</th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Discount</th>
                          <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Total</th>
                          {hasCOGS && <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Margin</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {detailBill.items.map((item, i) => {
                          const gross = item.quantity * item.unitRate
                          const lineDiscTotal = gross - item.lineTotal
                          let discLabel = '—'
                          if (item.lineDiscountPct > 0) discLabel = `${item.lineDiscountPct}% (−₹${fmt(lineDiscTotal)})`
                          else if (item.lineDiscountAmt > 0) discLabel = `₹${fmt(item.lineDiscountAmt)} flat`
                          const itemCOGS = item.purchaseRate != null ? item.quantity * item.purchaseRate : null
                          const itemProfit = itemCOGS != null ? item.lineTotal - itemCOGS : null
                          const itemMarginPct = (itemProfit != null && item.lineTotal > 0) ? (itemProfit / item.lineTotal) * 100 : null
                          return (
                            <tr key={item.id} className="hover:bg-zinc-50/50">
                              <td className="px-3 py-2.5 text-zinc-400 text-xs">{i + 1}</td>
                              <td className="px-3 py-2.5">
                                <p className="font-medium text-zinc-900">{item.productName}</p>
                                <p className="text-xs text-zinc-400 font-mono">{item.itemCode} · {item.unitOfMeasure}</p>
                              </td>
                              <td className="px-3 py-2.5 text-right text-zinc-700">{item.quantity}</td>
                              <td className="px-3 py-2.5 text-right text-zinc-700 font-mono text-xs">₹{fmt(item.unitRate)}</td>
                              <td className="px-3 py-2.5 text-right text-xs">
                                {discLabel === '—'
                                  ? <span className="text-zinc-300">—</span>
                                  : <span className="text-emerald-600 font-medium">{discLabel}</span>
                                }
                              </td>
                              <td className="px-3 py-2.5 text-right font-semibold text-zinc-900 font-mono text-xs">₹{fmt(item.lineTotal)}</td>
                              {hasCOGS && (
                                <td className="px-3 py-2.5 text-right text-xs">
                                  {itemMarginPct != null ? (
                                    <span className={itemMarginPct >= 0 ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>
                                      {itemMarginPct.toFixed(1)}%
                                    </span>
                                  ) : <span className="text-zinc-300">—</span>}
                                </td>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Discount breakdown */}
                  {(totalLineDiscounts > 0 || detailBill.discountAmount > 0) && (
                    <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-4 space-y-2">
                      <p className="text-xs font-bold text-emerald-800 uppercase tracking-wider flex items-center gap-1.5">
                        <Tag className="w-3.5 h-3.5" /> Discount Breakdown
                      </p>
                      <div className="space-y-1 text-sm">
                        {totalLineDiscounts > 0 && (
                          <div className="flex justify-between text-emerald-700">
                            <span className="text-xs">
                              Line discounts
                              <span className="text-emerald-500 ml-1.5">
                                ({detailBill.items.filter((it) => it.lineDiscountPct > 0).length > 0 && '% based'}
                                {detailBill.items.filter((it) => it.lineDiscountPct > 0).length > 0 && detailBill.items.filter((it) => it.lineDiscountAmt > 0).length > 0 && ' + '}
                                {detailBill.items.filter((it) => it.lineDiscountAmt > 0).length > 0 && 'flat amount'})
                              </span>
                            </span>
                            <span className="font-semibold">−₹{fmt(totalLineDiscounts)}</span>
                          </div>
                        )}
                        {detailBill.discountAmount > 0 && (
                          <div className="flex justify-between text-emerald-700">
                            <span className="text-xs">Bill-level discount</span>
                            <span className="font-semibold">−₹{fmt(detailBill.discountAmount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between font-bold text-emerald-900 pt-1 border-t border-emerald-200">
                          <span className="text-xs">Total discounts given</span>
                          <span>−₹{fmt(totalLineDiscounts + detailBill.discountAmount)}</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Totals */}
                  <div className="rounded-lg bg-zinc-50 border p-4 space-y-1.5 text-sm">
                    <div className="flex justify-between text-zinc-600">
                      <span>Subtotal</span>
                      <span>₹{fmt(detailBill.subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-zinc-500 text-xs">
                      <span>Incl. GST</span>
                      <span>₹{fmt(detailBill.gstAmount)}</span>
                    </div>
                    {detailBill.discountAmount > 0 && (
                      <div className="flex justify-between text-emerald-600">
                        <span>Bill Discount</span>
                        <span>−₹{fmt(detailBill.discountAmount)}</span>
                      </div>
                    )}
                    <div className="flex justify-between font-bold text-zinc-900 text-base pt-1 border-t">
                      <span>Total</span>
                      <span>₹{fmt(detailBill.totalAmount)}</span>
                    </div>
                    {detailBill.amountReceived != null && (
                      <div className="flex justify-between text-zinc-500 text-xs pt-1">
                        <span>Amount Received</span>
                        <span>₹{fmt(detailBill.amountReceived)}</span>
                      </div>
                    )}
                    {detailBill.balanceDue > 0 && (
                      <>
                        <div className="flex justify-between text-zinc-500 text-xs">
                          <span>Paid so far</span>
                          <span>₹{fmt(detailBill.paidAmount)}</span>
                        </div>
                        <div className="flex justify-between font-bold text-orange-600 text-sm pt-1 border-t">
                          <span>Balance due</span>
                          <span>₹{fmt(detailBill.balanceDue)}</span>
                        </div>
                        {detailBill.dueDate && (
                          <div className="flex justify-between text-zinc-500 text-xs">
                            <span>Payable by</span>
                            <span>{new Date(detailBill.dueDate).toLocaleDateString('en-IN')}</span>
                          </div>
                        )}
                      </>
                    )}
                    {detailBill.changeGiven != null && detailBill.changeGiven > 0 && (
                      <div className="flex justify-between text-zinc-500 text-xs">
                        <span>Change Given</span>
                        <span>₹{fmt(detailBill.changeGiven)}</span>
                      </div>
                    )}
                  </div>

                  {/* Margin estimate */}
                  {hasCOGS && (
                    <div className={`rounded-lg border p-4 space-y-2 ${estProfit >= 0 ? 'bg-zinc-50 border-zinc-200' : 'bg-red-50 border-red-200'}`}>
                      <p className="text-xs font-bold text-zinc-600 uppercase tracking-wider flex items-center gap-1.5">
                        {estProfit >= 0 ? <TrendingUp className="w-3.5 h-3.5 text-emerald-600" /> : <TrendingDown className="w-3.5 h-3.5 text-red-600" />}
                        Margin Estimate <span className="text-zinc-400 font-normal normal-case">(based on current purchase price)</span>
                      </p>
                      <div className="grid grid-cols-3 gap-3 text-center">
                        <div className="p-2.5 rounded-lg bg-white border">
                          <p className="text-xs text-zinc-500 mb-1">Est. Cost</p>
                          <p className="font-bold text-zinc-800 text-sm">₹{fmt(estCOGS)}</p>
                        </div>
                        <div className="p-2.5 rounded-lg bg-white border">
                          <p className="text-xs text-zinc-500 mb-1">Est. Profit</p>
                          <p className={`font-bold text-sm ${estProfit >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            {estProfit >= 0 ? '+' : ''}₹{fmt(estProfit)}
                          </p>
                        </div>
                        <div className="p-2.5 rounded-lg bg-white border">
                          <p className="text-xs text-zinc-500 mb-1">Margin</p>
                          <p className={`font-bold text-sm ${estMarginPct >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                            {estMarginPct.toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  )}

                  {detailBill.returns && detailBill.returns.length > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-2">
                      <p className="text-xs font-bold text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
                        <Undo2 className="w-3.5 h-3.5" /> Refunds against this bill
                      </p>
                      <div className="divide-y divide-amber-200">
                        {detailBill.returns.map((r) => (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => openDetail(r.id)}
                            className="w-full flex items-center justify-between py-2 text-left hover:bg-amber-100/40 px-1 rounded text-sm"
                          >
                            <div>
                              <p className="font-mono font-semibold text-amber-900 text-xs">{r.billNumber}</p>
                              <p className="text-xs text-amber-700">
                                {new Date(r.paidAt).toLocaleString('en-IN')}
                                {r.returnReasonCode ? ` · ${returnReasonLabel(r.returnReasonCode)}` : ''}
                                {r.returnReason ? ` · ${r.returnReason}` : ''}
                              </p>
                            </div>
                            <div className="text-right">
                              <p className="font-bold text-amber-900">−₹{fmt(r.totalAmount)}</p>
                              <p className="text-[10px] text-amber-600 uppercase tracking-wider">refunded</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {detailBill.notes && (
                    <div className="text-sm text-zinc-500">
                      <span className="font-medium text-zinc-700">Notes:</span> {detailBill.notes}
                    </div>
                  )}
                </>
              )
            })()}
          </div>
        )}
      </Modal>

      {/* Return / Refund Modal */}
      <Modal
        open={returnFor !== null}
        onClose={() => { if (!returnSubmitting) { setReturnFor(null); setReturnError('') } }}
        title={returnFor ? `Return items from ${returnFor.billNumber}` : 'Return'}
        size="lg"
      >
        {returnFor && (() => {
          const lines = returnFor.items.map((it) => {
            const remaining = it.quantity - (it.alreadyReturnedQty ?? 0)
            return { it, remaining }
          })
          const refundLines = lines.filter(({ it, remaining }) => remaining > 0 && (returnQty[it.id] ?? 0) > 0)
          const refundSubtotal = refundLines.reduce((s, { it }) => {
            const qty = returnQty[it.id] ?? 0
            const ratio = it.quantity > 0 ? qty / it.quantity : 0
            return s + it.lineTotal * ratio
          }, 0)
          const origSubtotal = returnFor.subtotal || 0
          const refundDiscount = origSubtotal > 0 ? returnFor.discountAmount * (refundSubtotal / origSubtotal) : 0
          const refundTotal = Math.max(0, refundSubtotal - refundDiscount)

          return (
            <div className="space-y-4">
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 border-b">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold text-zinc-500 text-xs">Product</th>
                      <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Sold</th>
                      <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Returnable</th>
                      <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Refund qty</th>
                      <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Refund ₹</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map(({ it, remaining }) => {
                      const qty = returnQty[it.id] ?? 0
                      const ratio = it.quantity > 0 ? qty / it.quantity : 0
                      const lineRefund = it.lineTotal * ratio
                      const disabled = remaining <= 0
                      return (
                        <tr key={it.id} className={disabled ? 'opacity-50' : ''}>
                          <td className="px-3 py-2.5">
                            <p className="font-medium text-zinc-900 text-sm">{it.productName}</p>
                            <p className="text-xs text-zinc-400 font-mono">{it.itemCode}</p>
                          </td>
                          <td className="px-3 py-2.5 text-right text-zinc-700 text-sm">{it.quantity}</td>
                          <td className="px-3 py-2.5 text-right text-zinc-700 text-sm">
                            {remaining}
                            {(it.alreadyReturnedQty ?? 0) > 0 && (
                              <p className="text-[10px] text-amber-600">−{it.alreadyReturnedQty} returned</p>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-right">
                            <input
                              type="number"
                              min={0}
                              max={remaining}
                              disabled={disabled}
                              value={qty || ''}
                              placeholder="0"
                              onChange={(e) => {
                                const raw = parseInt(e.target.value || '0', 10) || 0
                                const clamped = Math.max(0, Math.min(remaining, raw))
                                setReturnQty((prev) => ({ ...prev, [it.id]: clamped }))
                              }}
                              className="w-20 h-8 px-2 text-sm text-right rounded-md border border-input focus:outline-none focus:ring-1 focus:ring-ring tabular-nums"
                            />
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-xs text-zinc-700">
                            {qty > 0 ? `₹${fmt(lineRefund)}` : <span className="text-zinc-300">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="space-y-2">
                <label className="block text-xs font-semibold text-zinc-600">Why is it coming back?</label>
                <div className="flex flex-wrap gap-1.5">
                  {RETURN_REASONS.map((r) => (
                    <button
                      key={r.code}
                      type="button"
                      onClick={() => setReturnReasonCode(r.code)}
                      title={r.hint}
                      className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                        returnReasonCode === r.code
                          ? 'bg-zinc-900 text-white border-zinc-900'
                          : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                      }`}
                    >
                      {r.label}
                    </button>
                  ))}
                </div>
                {/* Broken stock must not be put back on the shelf; the credit
                    note still records it, which is what makes the loss visible. */}
                {returnReasonCode && !shouldRestock(returnReasonCode) && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                    The customer is refunded, but these goods will <strong>not</strong> go back into stock.
                  </p>
                )}
                <Input
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  placeholder="Add a note (optional)"
                  className="h-9 text-sm"
                />
              </div>

              <div className="rounded-lg bg-zinc-50 border p-4 space-y-1 text-sm">
                <div className="flex justify-between text-zinc-600">
                  <span>Refund subtotal</span>
                  <span>₹{fmt(refundSubtotal)}</span>
                </div>
                {refundDiscount > 0 && (
                  <div className="flex justify-between text-emerald-600 text-xs">
                    <span>Pro-rated bill discount</span>
                    <span>−₹{fmt(refundDiscount)}</span>
                  </div>
                )}
                <div className="flex justify-between font-bold text-zinc-900 text-base pt-1 border-t mt-1">
                  <span>Total refund</span>
                  <span>₹{fmt(refundTotal)}</span>
                </div>
                <p className="text-xs text-zinc-500 pt-1">
                  Stock for returned items will be added back to the most-recently-received batch.
                </p>
              </div>

              {returnError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
                  {returnError}
                </div>
              )}

              <div className="flex gap-3 justify-end">
                <Button
                  variant="outline"
                  onClick={() => { setReturnFor(null); setReturnError('') }}
                  disabled={returnSubmitting}
                >
                  Cancel
                </Button>
                <Button
                  onClick={submitReturn}
                  disabled={returnSubmitting || refundTotal <= 0 || !returnReasonCode}
                  title={!returnReasonCode ? 'Pick a reason first' : undefined}
                  className="bg-amber-600 hover:bg-amber-700 text-white"
                >
                  {returnSubmitting ? (
                    <span className="flex items-center gap-2">
                      <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      Processing…
                    </span>
                  ) : (
                    <><Undo2 className="w-4 h-4 mr-1" /> Refund ₹{fmt(refundTotal)}</>
                  )}
                </Button>
              </div>
            </div>
          )
        })()}
      </Modal>

      {/* Void Confirmation Modal */}
      <Modal
        open={voidConfirm !== null}
        onClose={() => { setVoidConfirm(null); setVoidError('') }}
        title="Void Bill"
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-zinc-700">
            Are you sure you want to void <span className="font-bold">{voidConfirm?.billNumber}</span>?
            This will restore stock for all items and cannot be undone.
          </p>
          {voidError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
              {voidError}
            </div>
          )}
          <div className="flex gap-3 justify-end">
            <Button
              variant="outline"
              onClick={() => { setVoidConfirm(null); setVoidError('') }}
              disabled={voiding}
            >
              Cancel
            </Button>
            <Button
              onClick={handleVoid}
              disabled={voiding}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {voiding ? (
                <span className="flex items-center gap-2">
                  <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Voiding…
                </span>
              ) : 'Void Bill'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
