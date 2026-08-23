// Reusable bill detail viewer with per-line Refund + Replace actions.
// Used from CustomersScreen so a manager can drill into any of a customer's
// recent bills and process refunds / exchanges without leaving the screen.
//
// The viewer ONLY renders item-level actions for PAID bills. RETURN and VOID
// bills are read-only.

import { useState, useEffect, useCallback, useRef } from 'react'
import { Receipt, X, Undo2, ArrowLeftRight, Search, Printer } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Modal } from './Modal'
import { apiFetch } from '../lib/api'
import { printReceipt, type ReceiptShop } from '../lib/receipt'
import { RETURN_REASONS, shouldRestock, type ReturnReasonCode } from '@shared/procurement'

type BillStatus = 'PAID' | 'VOID' | 'RETURN'

const STATUS_BADGE: Record<BillStatus, string> = {
  PAID:   'bg-emerald-50 text-emerald-700 border border-emerald-200',
  VOID:   'bg-red-50 text-red-600 border border-red-200',
  RETURN: 'bg-amber-50 text-amber-700 border border-amber-200'
}

const PM_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card' }

const fmt = (n: number): string =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

type BillItem = {
  id: string
  itemCode: string
  productName: string
  unitOfMeasure: string
  quantity: number
  unitRate: number
  gstPercentage: number
  lineTotal: number
  alreadyReturnedQty?: number
}

type BillDetail = {
  id: string
  billNumber: string
  status: BillStatus
  paidAt: string
  paymentMethod: string
  subtotal: number
  gstAmount: number
  discountAmount: number
  totalAmount: number
  amountReceived: number | null
  changeGiven: number | null
  notes: string | null
  customer: { name: string; phone: string } | null
  cashier: { username: string }
  originDevice: { friendlyName: string }
  originalBill?: { id: string; billNumber: string; status: BillStatus } | null
  returns?: { id: string; billNumber: string; totalAmount: number; paidAt: string; returnReason: string | null }[]
  items: BillItem[]
}

type ProductHit = {
  id: string
  itemCode: string
  name: string
  unitOfMeasure: string
  sellingRate: number
  gstPercentage: number
  totalStock: number
}

// A bill can be returned against while it still exists as a sale — that
// now includes part-paid and credit bills, where the refund comes off
// what is still owed.
const RETURNABLE = ['PAID', 'PARTIAL', 'CREDIT']

type Props = {
  open: boolean
  billId: string | null
  token: string | null
  shopInfo: ReceiptShop
  onClose: () => void
  /** Called after a refund or exchange completes so callers can refresh lists. */
  onMutated?: () => void
}

export function BillDetailViewer({ open, billId, token, shopInfo, onClose, onMutated }: Props) {
  const [bill, setBill] = useState<BillDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Per-line action state
  const [refundLine, setRefundLine] = useState<BillItem | null>(null)
  const [replaceLine, setReplaceLine] = useState<BillItem | null>(null)

  const fetchBill = useCallback(async () => {
    if (!billId || !token) return
    setLoading(true); setError('')
    try {
      const d = await apiFetch<{ bill: BillDetail }>(`/api/v1/bills/${billId}`, token)
      setBill(d.bill)
    } catch {
      setError('Failed to load bill.')
      setBill(null)
    } finally {
      setLoading(false)
    }
  }, [billId, token])

  useEffect(() => {
    if (open && billId) void fetchBill()
    if (!open) { setBill(null); setError(''); setRefundLine(null); setReplaceLine(null) }
  }, [open, billId, fetchBill])

  const reprint = (b: BillDetail): void => {
    void printReceipt(shopInfo, {
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
        itemCode: it.itemCode, productName: it.productName,
        quantity: it.quantity, unitRate: it.unitRate, lineTotal: it.lineTotal
      }))
    }, { copyLabel: 'REPRINT' })
  }

  return (
    <>
      <Modal
        open={open && refundLine === null && replaceLine === null}
        onClose={onClose}
        title={bill ? `Bill ${bill.billNumber}` : 'Bill detail'}
        size="lg"
      >
        {loading && (
          <div className="flex items-center justify-center py-12 text-zinc-400 gap-2">
            <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" /> Loading…
          </div>
        )}
        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>}
        {bill && (
          <div className="space-y-4">
            {/* Header */}
            <div className="flex items-center justify-between gap-3 pb-3 border-b">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-xs font-bold px-2.5 py-0.5 rounded-full ${STATUS_BADGE[bill.status]}`}>{bill.status}</span>
                <span className="text-xs text-zinc-500">
                  {new Date(bill.paidAt).toLocaleString('en-IN')}
                </span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600">
                  {PM_LABEL[bill.paymentMethod] ?? bill.paymentMethod}
                </span>
                <span className="text-xs text-zinc-500">cashier {bill.cashier.username}</span>
              </div>
              <Button variant="outline" size="sm" onClick={() => reprint(bill)} className="h-7 px-2 text-xs gap-1">
                <Printer className="w-3.5 h-3.5" /> Reprint
              </Button>
            </div>

            {/* Items table */}
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <th className="text-left px-3 py-2 font-semibold text-zinc-500 text-xs">Item</th>
                    <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Qty</th>
                    <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Rate</th>
                    <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Total</th>
                    {RETURNABLE.includes(bill.status) && (
                      <th className="text-right px-3 py-2 font-semibold text-zinc-500 text-xs">Actions</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {bill.items.map((it) => {
                    const remaining = it.quantity - (it.alreadyReturnedQty ?? 0)
                    const fullyReturned = remaining <= 0
                    return (
                      <tr key={it.id} className={fullyReturned ? 'opacity-60' : ''}>
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-zinc-900">{it.productName}</p>
                          <p className="text-xs text-zinc-400 font-mono">{it.itemCode}</p>
                        </td>
                        <td className="px-3 py-2.5 text-right text-zinc-700">
                          {it.quantity}
                          {(it.alreadyReturnedQty ?? 0) > 0 && (
                            <p className="text-[10px] text-amber-600">−{it.alreadyReturnedQty} returned</p>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono text-xs text-zinc-600">₹{fmt(it.unitRate)}</td>
                        <td className="px-3 py-2.5 text-right font-mono font-semibold text-zinc-900">₹{fmt(it.lineTotal)}</td>
                        {RETURNABLE.includes(bill.status) && (
                          <td className="px-3 py-2.5 text-right">
                            {fullyReturned ? (
                              <span className="text-xs text-zinc-400 italic">fully returned</span>
                            ) : (
                              <div className="flex gap-1.5 justify-end">
                                <button
                                  type="button"
                                  onClick={() => setRefundLine(it)}
                                  className="text-xs px-2 py-1 rounded border border-amber-200 text-amber-700 hover:bg-amber-50 inline-flex items-center gap-1"
                                  title="Refund this line"
                                >
                                  <Undo2 className="w-3 h-3" /> Refund
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setReplaceLine(it)}
                                  className="text-xs px-2 py-1 rounded border border-blue-200 text-blue-700 hover:bg-blue-50 inline-flex items-center gap-1"
                                  title="Replace with another product"
                                >
                                  <ArrowLeftRight className="w-3 h-3" /> Replace
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Totals strip */}
            <div className="grid grid-cols-4 gap-3 text-sm">
              <Stat label="Subtotal" value={`₹${fmt(bill.subtotal)}`} />
              <Stat label="GST (incl.)" value={`₹${fmt(bill.gstAmount)}`} />
              {bill.discountAmount > 0
                ? <Stat label="Discount" value={`−₹${fmt(bill.discountAmount)}`} accent="emerald" />
                : <div />
              }
              <Stat label="Total" value={`₹${fmt(bill.totalAmount)}`} accent="bold" />
            </div>

            {/* Refund history */}
            {bill.returns && bill.returns.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1.5">
                <p className="text-xs font-bold text-amber-800 uppercase tracking-wider flex items-center gap-1.5">
                  <Undo2 className="w-3.5 h-3.5" /> Previous refunds on this bill
                </p>
                {bill.returns.map((r) => (
                  <div key={r.id} className="flex items-center justify-between text-xs">
                    <div>
                      <span className="font-mono font-semibold text-amber-900">{r.billNumber}</span>
                      <span className="text-amber-700 ml-2">{new Date(r.paidAt).toLocaleString('en-IN')}</span>
                      {r.returnReason && <span className="text-amber-700 ml-2">· {r.returnReason}</span>}
                    </div>
                    <span className="font-bold text-amber-900">−₹{fmt(r.totalAmount)}</span>
                  </div>
                ))}
              </div>
            )}

            {/* If this bill IS a return, link back */}
            {bill.originalBill && (
              <div className="text-xs text-zinc-500">
                Original bill: <span className="font-mono font-semibold text-zinc-700">{bill.originalBill.billNumber}</span>
              </div>
            )}

            {bill.notes && (
              <div className="text-xs text-zinc-500">
                <span className="font-medium text-zinc-700">Notes:</span> {bill.notes}
              </div>
            )}
          </div>
        )}
      </Modal>

      <RefundLineModal
        line={refundLine}
        billId={bill?.id ?? null}
        token={token}
        shopInfo={shopInfo}
        customerName={bill?.customer?.name ?? null}
        onClose={() => setRefundLine(null)}
        onDone={() => { setRefundLine(null); fetchBill(); onMutated?.() }}
      />
      <ReplaceLineModal
        line={replaceLine}
        billId={bill?.id ?? null}
        token={token}
        shopInfo={shopInfo}
        customer={bill?.customer ?? null}
        onClose={() => setReplaceLine(null)}
        onDone={() => { setReplaceLine(null); fetchBill(); onMutated?.() }}
      />
    </>
  )
}

// ─── Helper: small stat tile ──────────────────────────────────────────────────

function Stat({ label, value, accent }: { label: string; value: string; accent?: 'bold' | 'emerald' }) {
  return (
    <div className="rounded-lg bg-zinc-50 border p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-zinc-500 font-semibold">{label}</p>
      <p className={
        accent === 'bold' ? 'text-base font-bold text-zinc-900 mt-0.5'
        : accent === 'emerald' ? 'text-sm font-semibold text-emerald-700 mt-0.5'
        : 'text-sm text-zinc-800 font-medium mt-0.5'
      }>{value}</p>
    </div>
  )
}

// ─── Per-line Refund modal ─────────────────────────────────────────────────────

type RefundProps = {
  line: BillItem | null
  billId: string | null
  token: string | null
  shopInfo: ReceiptShop
  customerName: string | null
  onClose: () => void
  onDone: () => void
}

function RefundLineModal({ line, billId, token, shopInfo, customerName, onClose, onDone }: RefundProps) {
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode | ''>('')
  const remaining = line ? line.quantity - (line.alreadyReturnedQty ?? 0) : 0
  const [qty, setQty] = useState(1)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (line) { setQty(remaining); setReason(''); setError('') }
  }, [line, remaining])

  const ratio = line && line.quantity > 0 ? qty / line.quantity : 0
  const refundAmount = line ? line.lineTotal * ratio : 0

  const submit = async (): Promise<void> => {
    if (!line || !billId || !token || qty <= 0 || qty > remaining) return
    setSubmitting(true); setError('')
    try {
      const d = await apiFetch<{ bill: BillDetail }>(`/api/v1/bills/${billId}/return`, token, {
        method: 'POST',
        body: JSON.stringify({
          items: [{ billItemId: line.id, quantity: qty }],
          reasonCode: reasonCode || undefined,
          reason: reason.trim() || undefined
        })
      })
      void printReceipt(shopInfo, {
        billNumber: d.bill.billNumber,
        paidAt: d.bill.paidAt,
        paymentMethod: d.bill.paymentMethod,
        subtotal: d.bill.subtotal,
        gstAmount: d.bill.gstAmount,
        discountAmount: d.bill.discountAmount,
        totalAmount: d.bill.totalAmount,
        customerName: customerName,
        cashierName: d.bill.cashier.username,
        status: 'RETURN',
        items: d.bill.items.map((it) => ({
          itemCode: it.itemCode, productName: it.productName,
          quantity: it.quantity, unitRate: it.unitRate, lineTotal: it.lineTotal
        }))
      })
      onDone()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; remaining?: number } }
      const code = e.data?.error
      setError(
        code === 'RETURN_QTY_EXCEEDS_REMAINING' ? `Only ${e.data?.remaining} unit(s) still refundable on this line.`
          : code === 'ORIGINAL_NOT_PAID' ? 'This bill is no longer eligible for refund.'
          : 'Refund failed. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={line !== null} onClose={() => { if (!submitting) onClose() }} title="Refund line item" size="md">
      {line && (
        <div className="space-y-4">
          <div className="rounded-lg border bg-zinc-50 p-3">
            <p className="font-semibold text-zinc-900">{line.productName}</p>
            <p className="text-xs text-zinc-500 font-mono">{line.itemCode}</p>
            <p className="text-xs text-zinc-500 mt-1">
              Sold {line.quantity} @ ₹{fmt(line.unitRate)} · refundable {remaining}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1 text-zinc-600">Refund qty</label>
              <Input
                type="number" min={1} max={remaining} value={qty}
                onChange={(e) => {
                  const n = Math.max(1, Math.min(remaining, parseInt(e.target.value || '1', 10) || 1))
                  setQty(n)
                }}
                className="h-10"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1 text-zinc-600">Refund amount</label>
              <div className="h-10 rounded-md border border-input bg-zinc-50 px-3 flex items-center font-mono font-bold text-zinc-900">
                ₹{fmt(refundAmount)}
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <label className="block text-xs font-semibold text-zinc-600">Why is it coming back?</label>
            <div className="flex flex-wrap gap-1.5">
              {RETURN_REASONS.map((r) => (
                <button
                  key={r.code}
                  type="button"
                  onClick={() => setReasonCode(r.code)}
                  title={r.hint}
                  className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    reasonCode === r.code
                      ? 'bg-zinc-900 text-white border-zinc-900'
                      : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {reasonCode && !shouldRestock(reasonCode) && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
                The customer is refunded, but these goods will <strong>not</strong> go back into stock.
              </p>
            )}
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Add a note (optional)" className="h-10" />
          </div>

          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>}

          <div className="flex justify-end gap-3 pt-1">
            <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
            <Button
              onClick={submit}
              disabled={submitting || qty <= 0 || !reasonCode}
              title={!reasonCode ? 'Pick a reason first' : undefined}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {submitting ? 'Refunding…' : <><Undo2 className="w-4 h-4 mr-1" />Refund ₹{fmt(refundAmount)}</>}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ─── Per-line Replace modal ────────────────────────────────────────────────────

type ReplaceProps = {
  line: BillItem | null
  billId: string | null
  token: string | null
  shopInfo: ReceiptShop
  customer: { name: string; phone: string } | null
  onClose: () => void
  onDone: () => void
}

function ReplaceLineModal({ line, billId, token, shopInfo, customer, onClose, onDone }: ReplaceProps) {
  const remaining = line ? line.quantity - (line.alreadyReturnedQty ?? 0) : 0

  const [returnQty, setReturnQty] = useState(1)
  const [productSearch, setProductSearch] = useState('')
  const [productResults, setProductResults] = useState<ProductHit[]>([])
  const [productSearchLoading, setProductSearchLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [replacement, setReplacement] = useState<ProductHit | null>(null)
  const [replacementQty, setReplacementQty] = useState(1)
  const [replacementRate, setReplacementRate] = useState(0)
  const [reasonCode, setReasonCode] = useState<ReturnReasonCode | ''>('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Reset state when opened on a new line
  useEffect(() => {
    if (!line) return
    setReturnQty(remaining)
    setProductSearch('')
    setProductResults([])
    setReplacement(null)
    setReplacementQty(1)
    setReplacementRate(0)
    setReason('')
    setError('')
  }, [line, remaining])

  // Product autocomplete
  useEffect(() => {
    if (!line) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!productSearch.trim()) { setProductResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setProductSearchLoading(true)
      try {
        const d = await apiFetch<{ products: ProductHit[] }>(
          `/api/v1/products?search=${encodeURIComponent(productSearch)}&isActive=true`, token
        )
        setProductResults(d.products)
      } catch {
        setProductResults([])
      } finally {
        setProductSearchLoading(false)
      }
    }, 250)
  }, [productSearch, line, token])

  // When a replacement product is selected, default rate to its sellingRate.
  useEffect(() => {
    if (replacement) setReplacementRate(replacement.sellingRate)
  }, [replacement])

  if (!line) return null

  const refundRatio = line.quantity > 0 ? returnQty / line.quantity : 0
  const refundAmount = line.lineTotal * refundRatio
  const replacementSubtotal = (replacement?.sellingRate ?? 0) * replacementQty
  // Use the user's potentially-edited rate for the actual sale total
  const replacementTotal = replacementRate * replacementQty
  const netDifference = replacementTotal - refundAmount  // +ve = customer pays more, -ve = customer gets back

  const canSubmit = !!replacement && replacementQty > 0 && returnQty > 0 && returnQty <= remaining
    && (replacement.totalStock >= replacementQty) && !!reasonCode

  const submit = async (): Promise<void> => {
    if (!canSubmit || !billId || !token || !replacement) return
    setSubmitting(true); setError('')
    try {
      const d = await apiFetch<{
        refundBill: BillDetail; replacementBill: BillDetail; netDifference: number
      }>(`/api/v1/bills/${billId}/exchange`, token, {
        method: 'POST',
        body: JSON.stringify({
          returnItems: [{ billItemId: line.id, quantity: returnQty }],
          replacementItems: [{
            productId: replacement.id,
            quantity: replacementQty,
            unitRate: replacementRate
          }],
          reasonCode: reasonCode || undefined,
          reason: reason.trim() || undefined
        })
      })
      // Print both receipts
      const printOne = (b: BillDetail, status: string): void => {
        void printReceipt(shopInfo, {
          billNumber: b.billNumber,
          paidAt: b.paidAt,
          paymentMethod: b.paymentMethod,
          subtotal: b.subtotal,
          gstAmount: b.gstAmount,
          discountAmount: b.discountAmount,
          totalAmount: b.totalAmount,
          amountReceived: b.amountReceived,
          changeGiven: b.changeGiven,
          customerName: customer?.name ?? null,
          cashierName: b.cashier.username,
          status,
          items: b.items.map((it) => ({
            itemCode: it.itemCode, productName: it.productName,
            quantity: it.quantity, unitRate: it.unitRate, lineTotal: it.lineTotal
          }))
        })
      }
      printOne(d.refundBill, 'RETURN')
      printOne(d.replacementBill, 'PAID')
      onDone()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; productName?: string; available?: number; requested?: number } }
      const code = e.data?.error
      setError(
        code === 'INSUFFICIENT_STOCK' ? `Not enough stock of ${e.data?.productName}: only ${e.data?.available} available.`
          : code === 'RETURN_QTY_EXCEEDS_REMAINING' ? 'Refund qty exceeds what is still returnable on this line.'
          : code === 'ORIGINAL_NOT_PAID' ? 'This bill is no longer eligible for exchange.'
          : 'Exchange failed. Please try again.'
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal open={line !== null} onClose={() => { if (!submitting) onClose() }} title="Replace line item" size="lg">
      <div className="space-y-4">
        {/* Original line */}
        <div className="rounded-lg border bg-amber-50/40 border-amber-200 p-3">
          <p className="text-[10px] uppercase tracking-wider text-amber-800 font-bold mb-1">Returning</p>
          <p className="font-semibold text-zinc-900">{line.productName}</p>
          <p className="text-xs text-zinc-500 font-mono">{line.itemCode}</p>
          <div className="flex items-center gap-3 mt-2">
            <label className="text-xs text-zinc-600">Qty to return</label>
            <Input
              type="number" min={1} max={remaining} value={returnQty}
              onChange={(e) => {
                const n = Math.max(1, Math.min(remaining, parseInt(e.target.value || '1', 10) || 1))
                setReturnQty(n)
              }}
              className="h-8 w-20 text-sm"
            />
            <span className="text-xs text-zinc-500">of {remaining} refundable</span>
            <span className="ml-auto font-mono font-bold text-amber-700">−₹{fmt(refundAmount)}</span>
          </div>
        </div>

        {/* Replacement picker */}
        <div className="rounded-lg border bg-blue-50/40 border-blue-200 p-3 space-y-3">
          <p className="text-[10px] uppercase tracking-wider text-blue-800 font-bold">Replacement</p>

          {!replacement ? (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
                <Input
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  placeholder="Search product to swap in…"
                  className="pl-9 h-10"
                  autoFocus
                />
                {productSearchLoading && (
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
                )}
              </div>
              {productResults.length > 0 && (
                <div className="rounded-lg border bg-white overflow-hidden divide-y max-h-56 overflow-y-auto">
                  {productResults.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setReplacement(p)}
                      disabled={p.totalStock <= 0}
                      className={`w-full flex items-center justify-between px-3 py-2 text-left ${p.totalStock <= 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-50'}`}
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-zinc-900 text-sm truncate">{p.name}</p>
                        <p className="text-xs text-zinc-400 font-mono">{p.itemCode}</p>
                      </div>
                      <div className="text-xs text-right ml-3 shrink-0">
                        <p className="font-mono font-semibold text-zinc-700">₹{fmt(p.sellingRate)}</p>
                        <p className={p.totalStock > 0 ? 'text-zinc-400' : 'text-red-500'}>
                          {p.totalStock} {p.unitOfMeasure}
                        </p>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-zinc-900">{replacement.name}</p>
                  <p className="text-xs text-zinc-500 font-mono">{replacement.itemCode} · {replacement.totalStock} in stock</p>
                </div>
                <button type="button" onClick={() => setReplacement(null)} className="text-zinc-400 hover:text-zinc-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold mb-1 text-zinc-600">Qty</label>
                  <Input
                    type="number" min={1} max={replacement.totalStock} value={replacementQty}
                    onChange={(e) => {
                      const n = Math.max(1, Math.min(replacement.totalStock, parseInt(e.target.value || '1', 10) || 1))
                      setReplacementQty(n)
                    }}
                    className="h-10"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold mb-1 text-zinc-600">Unit rate</label>
                  <Input
                    type="number" min={0} step="0.01" value={replacementRate}
                    onChange={(e) => setReplacementRate(Math.max(0, parseFloat(e.target.value || '0') || 0))}
                    className="h-10"
                  />
                  {replacementRate !== replacement.sellingRate && (
                    <p className="text-[10px] text-zinc-400 mt-0.5">Catalog: ₹{fmt(replacementSubtotal / replacementQty)}</p>
                  )}
                </div>
              </div>
              <div className="text-right font-mono font-bold text-blue-700 pt-1">+₹{fmt(replacementTotal)}</div>
            </div>
          )}
        </div>

        {/* Net difference */}
        <div className="rounded-lg bg-zinc-50 border p-3 flex items-center justify-between">
          <span className="text-sm font-semibold text-zinc-700">Net to settle</span>
          <span className={`text-lg font-bold font-mono ${netDifference > 0 ? 'text-blue-700' : netDifference < 0 ? 'text-amber-700' : 'text-zinc-700'}`}>
            {netDifference > 0 ? `Customer pays ₹${fmt(netDifference)}` :
             netDifference < 0 ? `Refund ₹${fmt(Math.abs(netDifference))}` :
             '₹0.00 (even swap)'}
          </span>
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-semibold text-zinc-600">Why is it being exchanged?</label>
          <div className="flex flex-wrap gap-1.5">
            {RETURN_REASONS.map((r) => (
              <button
                key={r.code}
                type="button"
                onClick={() => setReasonCode(r.code)}
                title={r.hint}
                className={`px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                  reasonCode === r.code
                    ? 'bg-zinc-900 text-white border-zinc-900'
                    : 'bg-white text-zinc-600 border-zinc-200 hover:bg-zinc-50'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          {reasonCode && !shouldRestock(reasonCode) && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
              The returned item will <strong>not</strong> go back into stock.
            </p>
          )}
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Add a note (optional)" className="h-10" />
        </div>

        {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>}

        <div className="flex justify-end gap-3 pt-1">
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={submit}
            disabled={!canSubmit || submitting}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            {submitting ? 'Processing…' : <><ArrowLeftRight className="w-4 h-4 mr-1" />Confirm exchange</>}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// Re-export icon used in callers (avoids them adding a separate lucide import)
export { Receipt as ReceiptIcon }
