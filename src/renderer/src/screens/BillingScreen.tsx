import React, { useState, useEffect, useRef, useCallback } from 'react'
import {
  Search, Plus, Minus, Trash2, User, X, CheckCircle2, AlertTriangle,
  ShoppingCart, ChevronDown, CreditCard, Banknote, Smartphone, Printer,
  FileText, ShieldCheck, SplitSquareHorizontal
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'
import { printReceipt, type ReceiptBill, type ReceiptShop } from '../lib/receipt'
import { computeInvoiceTotals, round2 } from '@shared/money'
import { stateCodeOf } from '@shared/validation'
import { isLengthMode, parseQty, qtyStep, roundQty, formatQty } from '@shared/units'
import { settle, checkCredit, PAYMENT_METHODS, type PaymentMethod, type Tender } from '@shared/credit'

// ─── Types ────────────────────────────────────────────────────────────────────

type Product = {
  id: string
  itemCode: string
  name: string
  brand: string | null
  unitOfMeasure: string
  /** 'UNIT' | 'LENGTH'. Older cached rows may omit it, so treat it as optional. */
  sellMode?: string
  sellingRate: number
  gstPercentage: number
  totalStock: number
}

type CartItem = {
  productId: string
  itemCode: string
  productName: string
  unitOfMeasure: string
  sellMode?: string
  unitRate: number
  gstPercentage: number
  quantity: number
  maxQty: number
  lineDiscountPct: number
  lineDiscountAmt: number
  lineTotal: number
  lineGstAmount: number
}

type Customer = {
  id: string
  name: string
  phone: string
  email: string | null
  /** Present on the autocomplete payload; absent on a freshly created customer. */
  creditLimit?: number
  outstanding?: number
  creditDays?: number
  /** Decides the tax heads: a customer registered in another state is billed
   *  IGST rather than CGST + SGST. */
  gstin?: string | null
}

/** The customer's ledger as the counter needs it while taking payment. */
type CreditInfo = {
  outstanding: number
  creditLimit: number
  creditDays: number
}

/** One payment line in the tender list. The amount is kept as a string so the
 *  field can be cleared mid-typing without collapsing to 0. */
type TenderLine = {
  key: string
  method: PaymentMethod
  amount: string
  reference: string
}

type SavedBill = {
  billNumber: string
  paidAt?: string
  totalAmount: number
  subtotal?: number
  gstAmount?: number
  discountAmount?: number
  taxableValue?: number
  cgstAmount?: number
  sgstAmount?: number
  igstAmount?: number
  amountReceived?: number | null
  changeGiven: number | null
  paymentMethod: string
  /** Settlement, as decided by the server. */
  paidAmount?: number
  balanceDue?: number
  dueDate?: string | null
  status?: string
  /** Filled in locally from what was actually tendered — the create response
   *  does not echo the payment rows back. */
  tenders?: Tender[]
  customerOutstanding?: number | null
  items: {
    productName: string; itemCode?: string; quantity: number; unitRate?: number; lineTotal: number
    gstPercentage?: number; taxableValue?: number; cgstAmount?: number; sgstAmount?: number
    igstAmount?: number; billDiscountAmt?: number
  }[]
  customer?: { name: string } | null
}

const AUTO_PRINT_KEY = 'cashlio_auto_print'
const isAutoPrintEnabled = () => localStorage.getItem(AUTO_PRINT_KEY) !== 'false'

const METHOD_META: Record<PaymentMethod, { label: string; icon: React.ReactNode }> = {
  CASH: { label: 'Cash', icon: <Banknote className="w-4 h-4" /> },
  UPI: { label: 'UPI', icon: <Smartphone className="w-4 h-4" /> },
  CARD: { label: 'Card', icon: <CreditCard className="w-4 h-4" /> },
  CHEQUE: { label: 'Cheque', icon: <FileText className="w-4 h-4" /> }
}

/** Methods where a transaction id / cheque number is worth capturing. */
const NEEDS_REFERENCE: PaymentMethod[] = ['UPI', 'CHEQUE']

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the signed-in user's role out of the manager session JWT.
 *
 * The app carries no role context in React state yet, and the only place the
 * role is available to the renderer is the token itself. This decodes the
 * payload without verifying the signature, which is fine because it decides
 * nothing more than whether to *offer* the credit-override button — the server
 * re-checks the role before honouring `allowCreditOverride`.
 */
function currentUserRole(): string | null {
  try {
    const payload = localStorage.getItem('managerToken')?.split('.')[1]
    if (!payload) return null
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return (JSON.parse(json) as { role?: string }).role ?? null
  } catch {
    return null
  }
}

let tenderKeySeq = 0
const newTenderLine = (method: PaymentMethod, amount = ''): TenderLine => ({
  key: `tender-${++tenderKeySeq}`,
  method,
  amount,
  reference: ''
})

function calcLine(item: Omit<CartItem, 'lineTotal' | 'lineGstAmount'>): Pick<CartItem, 'lineTotal' | 'lineGstAmount'> {
  const base = item.quantity * item.unitRate
  const pctDisc = base * (item.lineDiscountPct / 100)
  const lineTotal = Math.max(0, base - pctDisc - item.lineDiscountAmt)
  const lineGstAmount = item.gstPercentage > 0
    ? lineTotal * item.gstPercentage / (100 + item.gstPercentage)
    : 0
  return { lineTotal, lineGstAmount }
}

function fmt(n: number) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ─── BillingScreen ────────────────────────────────────────────────────────────

export function BillingScreen({
  token,
  deviceId
}: {
  token: string | null
  deviceId: string
}) {
  // Cart
  const [cartItems, setCartItems] = useState<CartItem[]>([])

  // Search
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Product[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const searchRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Pending quantity prompt
  const [pendingProduct, setPendingProduct] = useState<Product | null>(null)
  const [pendingQty, setPendingQty] = useState('1')
  const pendingQtyRef = useRef<HTMLInputElement>(null)

  // Customer
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [creditInfo, setCreditInfo] = useState<CreditInfo | null>(null)
  const [showCustomerModal, setShowCustomerModal] = useState(false)
  const [customerSearch, setCustomerSearch] = useState('')
  const [customerResults, setCustomerResults] = useState<Customer[]>([])
  const [customerSearchLoading, setCustomerSearchLoading] = useState(false)
  const [showAddCustomer, setShowAddCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerPhone, setNewCustomerPhone] = useState('')
  const [newCustomerError, setNewCustomerError] = useState('')

  // Discounts
  const [billDiscountFlat, setBillDiscountFlat] = useState('')
  const [billDiscountPct, setBillDiscountPct] = useState('')

  // Payment — one or more tenders. The common case is a single cash line that
  // tracks the grand total, so nothing has to be typed to take full payment.
  const [tenders, setTenders] = useState<TenderLine[]>(() => [newTenderLine('CASH')])
  const [tenderTouched, setTenderTouched] = useState(false)

  // Submit
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [creditError, setCreditError] = useState<{ message: string; needsOverride: boolean } | null>(null)
  const [successBill, setSuccessBill] = useState<SavedBill | null>(null)
  const isSuperAdmin = currentUserRole() === 'SUPER_ADMIN'

  // Bill number preview
  const [billNumber, setBillNumber] = useState<string>('')

  // Receipt printing
  const [shopInfo, setShopInfo] = useState<ReceiptShop>({ name: 'My Shop' })
  // The shop's GST state, which decides whether a sale is CGST + SGST or IGST.
  const [shopStateCode, setShopStateCode] = useState<string | null>(null)
  const [autoPrint, setAutoPrint] = useState<boolean>(() => isAutoPrintEnabled())
  useEffect(() => { localStorage.setItem(AUTO_PRINT_KEY, autoPrint ? 'true' : 'false') }, [autoPrint])
  const [printingState, setPrintingState] = useState<'idle' | 'printing' | 'error'>('idle')
  const [printError, setPrintError] = useState<string>('')
  const autoPrintFiredFor = useRef<string | null>(null)

  // Fetch next bill number + shop info on mount
  useEffect(() => {
    apiFetch<{ billNumber: string }>('/api/v1/system/next-bill-number', token)
      .then((d) => setBillNumber(d.billNumber))
      .catch(() => {})
    apiFetch<{
      shopName?: string; branchName?: string
      address?: string | null; phone?: string | null; gstin?: string | null
      stateCode?: string | null
    }>('/api/v1/system/status', token)
      .then((d) => {
        setShopInfo({
          name: d.shopName || 'My Shop',
          branch: d.branchName || null,
          address: d.address ?? null,
          phone: d.phone ?? null,
          gstin: d.gstin ?? null
        })
        setShopStateCode(d.stateCode ?? stateCodeOf(d.gstin))
      })
      .catch(() => {})
  }, [token])

  const buildReceiptPayload = (b: SavedBill): ReceiptBill => ({
    billNumber: b.billNumber,
    paidAt: b.paidAt,
    paymentMethod: b.paymentMethod,
    subtotal: b.subtotal,
    gstAmount: b.gstAmount,
    discountAmount: b.discountAmount,
    totalAmount: b.totalAmount,
    taxableValue: b.taxableValue,
    cgstAmount: b.cgstAmount,
    sgstAmount: b.sgstAmount,
    igstAmount: b.igstAmount,
    amountReceived: b.amountReceived ?? null,
    changeGiven: b.changeGiven,
    paidAmount: b.paidAmount,
    balanceDue: b.balanceDue,
    dueDate: b.dueDate ?? null,
    status: b.status,
    tenders: b.tenders,
    customerOutstanding: b.customerOutstanding ?? null,
    customerName: b.customer?.name ?? null,
    items: b.items.map((it) => ({
      itemCode: it.itemCode || '',
      productName: it.productName,
      quantity: it.quantity,
      unitRate: it.unitRate ?? (it.quantity > 0 ? it.lineTotal / it.quantity : 0),
      lineTotal: it.lineTotal,
      gstPercentage: it.gstPercentage,
      taxableValue: it.taxableValue,
      cgstAmount: it.cgstAmount,
      sgstAmount: it.sgstAmount,
      igstAmount: it.igstAmount,
      billDiscountAmt: it.billDiscountAmt
    }))
  })

  const handlePrint = async (b: SavedBill, copy?: string) => {
    setPrintingState('printing')
    setPrintError('')
    const r = await printReceipt(shopInfo, buildReceiptPayload(b), copy ? { copyLabel: copy } : {})
    if (r.ok) setPrintingState('idle')
    else { setPrintingState('error'); setPrintError(r.error || 'Print failed') }
  }

  // Auto-print on success
  useEffect(() => {
    if (!successBill) { autoPrintFiredFor.current = null; return }
    if (!autoPrint) return
    if (autoPrintFiredFor.current === successBill.billNumber) return
    autoPrintFiredFor.current = successBill.billNumber
    handlePrint(successBill)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successBill, autoPrint])

  // ─── Product search (debounced) ──────────────────────────────────────────

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!search.trim()) {
      setSearchResults([])
      setShowDropdown(false)
      return
    }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const data = await apiFetch<{ products: Product[] }>(
          `/api/v1/products?search=${encodeURIComponent(search)}&isActive=true`,
          token
        )
        setSearchResults(data.products)
        setShowDropdown(true)
      } catch {
        setSearchResults([])
      } finally {
        setSearchLoading(false)
      }
    }, 250)
  }, [search, token])

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // ─── Cart ops ────────────────────────────────────────────────────────────

  // Focus qty input when a product is selected from the dropdown
  useEffect(() => {
    if (pendingProduct && pendingQtyRef.current) {
      pendingQtyRef.current.focus()
      pendingQtyRef.current.select()
    }
  }, [pendingProduct])

  const selectProduct = (p: Product) => {
    setSearch('')
    setShowDropdown(false)
    setPendingProduct(p)
    setPendingQty('1')
  }

  // Barcode-scanner support — exact itemCode match on Enter adds qty 1.
  // A cut-length product has no meaningful default quantity, so scanning one
  // opens the length prompt instead of silently adding one metre.
  const addProductDirect = (p: Product) => {
    if (p.totalStock <= 0) return
    if (isLengthMode(p.sellMode)) { selectProduct(p); return }
    setCartItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === p.id)
      if (idx >= 0) {
        return prev.map((it, i) => {
          if (i !== idx) return it
          const q = Math.min(it.quantity + 1, p.totalStock)
          const next = { ...it, quantity: q }
          return { ...next, ...calcLine(next) }
        })
      }
      const base: Omit<CartItem, 'lineTotal' | 'lineGstAmount'> = {
        productId: p.id, itemCode: p.itemCode,
        productName: p.name, unitOfMeasure: p.unitOfMeasure, sellMode: p.sellMode,
        unitRate: p.sellingRate, gstPercentage: p.gstPercentage,
        quantity: 1, maxQty: p.totalStock,
        lineDiscountPct: 0, lineDiscountAmt: 0
      }
      return [...prev, { ...base, ...calcLine(base) }]
    })
    setSearch('')
    setSearchResults([])
    setShowDropdown(false)
    setPendingProduct(null)
  }

  const handleSearchEnter = async () => {
    if (!search.trim() || pendingProduct) return
    const q = search.trim()
    const ql = q.toLowerCase()
    const exactCached = searchResults.find((p) => p.itemCode.toLowerCase() === ql)
    if (exactCached) { addProductDirect(exactCached); return }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setSearchLoading(true)
    try {
      const data = await apiFetch<{ products: Product[] }>(
        `/api/v1/products?search=${encodeURIComponent(q)}&isActive=true`, token
      )
      setSearchResults(data.products)
      const exact = data.products.find((p) => p.itemCode.toLowerCase() === ql)
      if (exact) { addProductDirect(exact); return }
      setShowDropdown(true)
    } catch { /* keep current dropdown */ }
    finally { setSearchLoading(false) }
  }

  const confirmAddToCart = () => {
    if (!pendingProduct) return
    const parsed = parseQty(pendingQty, pendingProduct.sellMode)
    const step = qtyStep(pendingProduct.sellMode)
    const qty = Math.max(step, Math.min(parsed || step, pendingProduct.totalStock))
    setCartItems((prev) => {
      const idx = prev.findIndex((it) => it.productId === pendingProduct.id)
      if (idx >= 0) {
        return prev.map((it, i) => {
          if (i !== idx) return it
          const next = { ...it, quantity: qty }
          return { ...next, ...calcLine(next) }
        })
      }
      const base: Omit<CartItem, 'lineTotal' | 'lineGstAmount'> = {
        productId: pendingProduct.id, itemCode: pendingProduct.itemCode,
        productName: pendingProduct.name, unitOfMeasure: pendingProduct.unitOfMeasure,
        unitRate: pendingProduct.sellingRate, gstPercentage: pendingProduct.gstPercentage,
        quantity: qty, maxQty: pendingProduct.totalStock,
        lineDiscountPct: 0, lineDiscountAmt: 0
      }
      return [...prev, { ...base, ...calcLine(base) }]
    })
    setPendingProduct(null)
    setPendingQty('1')
  }

  /** Sets an absolute quantity — cut-length lines are typed, not stepped. */
  const setQty = (idx: number, raw: string) => {
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const parsed = parseQty(raw, it.sellMode)
      if (parsed <= 0) return it
      const next = { ...it, quantity: roundQty(Math.min(parsed, it.maxQty)) }
      return { ...next, ...calcLine(next) }
    }))
  }

  const updateQty = (idx: number, delta: number) => {
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const q = roundQty(Math.max(qtyStep(it.sellMode), Math.min(it.quantity + delta, it.maxQty)))
      const next = { ...it, quantity: q }
      return { ...next, ...calcLine(next) }
    }))
  }

  const updateDiscount = (idx: number, field: 'lineDiscountPct' | 'lineDiscountAmt', raw: string) => {
    const val = parseFloat(raw) || 0
    setCartItems((prev) => prev.map((it, i) => {
      if (i !== idx) return it
      const next: CartItem = field === 'lineDiscountPct'
        ? { ...it, lineDiscountPct: val, lineDiscountAmt: 0 }
        : { ...it, lineDiscountAmt: val, lineDiscountPct: 0 }
      return { ...next, ...calcLine(next) }
    }))
  }

  const removeItem = (idx: number) => {
    setCartItems((prev) => prev.filter((_, i) => i !== idx))
  }

  // ─── Totals ──────────────────────────────────────────────────────────────

  const rawSubtotal = cartItems.reduce((s, it) => s + it.lineTotal, 0)
  const billDiscFlat = parseFloat(billDiscountFlat) || 0
  const billDiscPct = parseFloat(billDiscountPct) || 0
  // Same calculator the server uses, so the counter preview and the stored
  // invoice agree to the paisa — including how the bill discount is shared
  // across lines before tax is extracted.
  // A customer registered in another state pays IGST rather than CGST + SGST.
  // This was hardcoded intra-state, so the receipt handed over the counter
  // named different tax heads from the invoice the server stored for the same
  // sale. The server has always got this right; the screen now agrees with it.
  const customerStateCode = stateCodeOf(customer?.gstin)
  const interState =
    shopStateCode != null && customerStateCode != null && customerStateCode !== shopStateCode
  const totals = computeInvoiceTotals(
    cartItems.map((it) => ({ lineTotal: it.lineTotal, gstPercentage: it.gstPercentage })),
    rawSubtotal * billDiscPct / 100 + billDiscFlat,
    interState
  )
  const subtotal = totals.subtotal
  const billDiscAmt = totals.billDiscount
  const grandTotal = totals.totalAmount
  const totalGst = totals.gstAmount
  const taxableValue = totals.taxableValue
  const cgstAmount = totals.cgstAmount
  const sgstAmount = totals.sgstAmount

  // ─── Settlement ──────────────────────────────────────────────────────────

  const tenderList: Tender[] = tenders.map((t) => ({
    method: t.method,
    amount: parseFloat(t.amount) || 0,
    reference: t.reference.trim() || null
  }))
  // Same arithmetic the server applies, so the counter and the stored bill
  // agree on what was collected and what is still owed.
  const settlement = settle(grandTotal, tenderList)
  const balanceDue = settlement.balanceDue

  // A lone untouched cash line follows the bill total, so the cashier only
  // types an amount when the payment is not a straightforward full tender.
  useEffect(() => {
    if (tenderTouched) return
    setTenders((prev) => {
      const want = grandTotal > 0 ? String(round2(grandTotal)) : ''
      if (prev.length !== 1 || prev[0].method !== 'CASH' || prev[0].amount === want) return prev
      return [{ ...prev[0], amount: want }]
    })
  }, [grandTotal, tenderTouched])

  useEffect(() => {
    if (!customer) { setCreditInfo(null); return }
    let cancelled = false
    apiFetch<{ outstanding: number; customer: { creditLimit: number; creditDays: number } }>(
      `/api/v1/customers/${customer.id}/outstanding`, token
    )
      .then((d) => {
        if (cancelled) return
        setCreditInfo({
          outstanding: d.outstanding,
          creditLimit: d.customer.creditLimit,
          creditDays: d.customer.creditDays
        })
      })
      .catch(() => {
        if (cancelled) return
        // Fall back to whatever the autocomplete payload carried.
        setCreditInfo({
          outstanding: customer.outstanding ?? 0,
          creditLimit: customer.creditLimit ?? 0,
          creditDays: customer.creditDays ?? 0
        })
      })
    return () => { cancelled = true }
  }, [customer, token])

  const updateTender = (idx: number, patch: Partial<Omit<TenderLine, 'key'>>) => {
    setTenderTouched(true)
    setCreditError(null)
    setTenders((prev) => prev.map((t, i) => (i === idx ? { ...t, ...patch } : t)))
  }

  /** What is still unpaid once every *other* line is counted. */
  const remainingExcluding = (idx: number) =>
    round2(Math.max(0, grandTotal - tenderList.reduce((s, t, i) => (i === idx ? s : s + t.amount), 0)))

  const addTender = () => {
    setTenderTouched(true)
    setCreditError(null)
    setTenders((prev) => {
      const rest = round2(Math.max(0, grandTotal - tenderList.reduce((s, t) => s + t.amount, 0)))
      const method: PaymentMethod = prev.some((t) => t.method === 'CASH') ? 'UPI' : 'CASH'
      return [...prev, newTenderLine(method, rest > 0 ? String(rest) : '')]
    })
  }

  const removeTender = (idx: number) => {
    setTenderTouched(true)
    setCreditError(null)
    setTenders((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)))
  }

  const resetTenders = () => {
    setTenders([newTenderLine('CASH')])
    setTenderTouched(false)
  }

  // ─── Credit gate ─────────────────────────────────────────────────────────

  // Mirrors the server's decision so a refusal is visible before the cashier
  // commits, rather than arriving as a 409 afterwards.
  const creditCheck = checkCredit({
    hasCustomer: !!customer,
    creditLimit: creditInfo?.creditLimit ?? 0,
    currentOutstanding: creditInfo?.outstanding ?? 0,
    newBalance: balanceDue
  })
  const availableCredit = Math.max(0, (creditInfo?.creditLimit ?? 0) - (creditInfo?.outstanding ?? 0))
  // Only "no customer" is a hard stop on this side — an over-limit balance is
  // still worth attempting, because a super-admin can authorise the refusal.
  const canPay = grandTotal > 0 && !(balanceDue > 0 && creditCheck.reason === 'NO_CUSTOMER')

  // ─── Customer search ─────────────────────────────────────────────────────

  const searchCustomers = useCallback(async (q: string) => {
    if (!q.trim()) { setCustomerResults([]); return }
    setCustomerSearchLoading(true)
    try {
      const d = await apiFetch<{ customers: Customer[] }>(
        `/api/v1/customers?search=${encodeURIComponent(q)}&autocomplete=1`, token
      )
      setCustomerResults(d.customers)
    } catch { setCustomerResults([]) }
    finally { setCustomerSearchLoading(false) }
  }, [token])

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 250)
    return () => clearTimeout(t)
  }, [customerSearch, searchCustomers])

  const handleAddCustomer = async () => {
    if (!newCustomerName.trim() || !newCustomerPhone.trim()) {
      setNewCustomerError('Name and phone are required.')
      return
    }
    try {
      const d = await apiFetch<{ customer: Customer }>('/api/v1/customers', token, {
        method: 'POST',
        body: JSON.stringify({ name: newCustomerName.trim(), phone: newCustomerPhone.trim() })
      })
      setCustomer(d.customer)
      setShowCustomerModal(false)
      resetCustomerModal()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string } }
      setNewCustomerError(e.data?.error === 'PHONE_ALREADY_EXISTS' ? 'Phone already exists.' : 'Failed to add customer.')
    }
  }

  const resetCustomerModal = () => {
    setCustomerSearch(''); setCustomerResults([])
    setShowAddCustomer(false); setNewCustomerName(''); setNewCustomerPhone(''); setNewCustomerError('')
  }

  // ─── Submit Bill ─────────────────────────────────────────────────────────

  // One key per attempt at *this* cart, so the same sale submitted twice is
  // recognised as one. The till has always sent one; the manager's own
  // counter did not, which left it a double-click or a timed-out retry away
  // from billing a customer twice for the same goods. It survives a failed
  // attempt on purpose — the credit-override retry and a retry after a lost
  // response are the same sale — and is replaced once a bill comes back.
  const idempotencyKey = useRef(crypto.randomUUID())

  const handlePay = async (allowCreditOverride = false) => {
    if (!canPay || cartItems.length === 0) return
    setSubmitting(true)
    setSubmitError('')
    setCreditError(null)
    try {
      const body = {
        customerId: customer?.id ?? null,
        originDeviceId: deviceId,
        items: cartItems.map((it) => ({
          productId: it.productId,
          quantity: it.quantity,
          unitRate: it.unitRate,
          gstPercentage: it.gstPercentage,
          lineDiscountPct: it.lineDiscountPct,
          lineDiscountAmt: it.lineDiscountAmt
        })),
        discountAmount: billDiscAmt,
        payments: tenderList.filter((t) => t.amount > 0),
        clientLocalId: idempotencyKey.current,
        ...(allowCreditOverride ? { allowCreditOverride: true } : {})
      }
      const d = await apiFetch<{ bill: SavedBill }>('/api/v1/bills', token, {
        method: 'POST',
        body: JSON.stringify(body)
      })
      // This sale is now on the books; the next one is a different sale.
      idempotencyKey.current = crypto.randomUUID()
      // The create response does not echo the payment rows, so the tenders are
      // attached here for the receipt.
      setSuccessBill({
        ...d.bill,
        tenders: tenderList.filter((t) => t.amount > 0),
        customerOutstanding:
          creditInfo != null ? round2(creditInfo.outstanding + (d.bill.balanceDue ?? 0)) : null
      })
    } catch (err: unknown) {
      const e = err as {
        data?: {
          error?: string; message?: string; productName?: string
          available?: number; needsOverride?: boolean
        }
      }
      if (e.data?.error === 'INSUFFICIENT_STOCK') {
        setSubmitError(`Insufficient stock for "${e.data.productName}" (available: ${e.data.available}).`)
      } else if (e.data?.error === 'CREDIT_NOT_ALLOWED') {
        setCreditError({
          message: e.data.message ?? 'Credit is not available for this bill.',
          needsOverride: Boolean(e.data.needsOverride)
        })
      } else {
        setSubmitError('Failed to process bill. Please try again.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ─── New Bill ─────────────────────────────────────────────────────────────

  const startNewBill = () => {
    setCartItems([])
    setCustomer(null)
    setBillDiscountFlat('')
    setBillDiscountPct('')
    resetTenders()
    setCreditInfo(null)
    setSubmitError('')
    setCreditError(null)
    setSuccessBill(null)
    apiFetch<{ billNumber: string }>('/api/v1/system/next-bill-number', token)
      .then((d) => setBillNumber(d.billNumber))
      .catch(() => {})
  }

  // ─── Success Overlay ─────────────────────────────────────────────────────

  if (successBill) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-6 text-center">
        <div className="w-20 h-20 rounded-full bg-emerald-100 flex items-center justify-center">
          <CheckCircle2 className="w-11 h-11 text-emerald-600" strokeWidth={1.5} />
        </div>
        <div>
          <h2 className="text-2xl font-bold text-zinc-900">
            {(successBill.balanceDue ?? 0) > 0 ? 'Bill Saved' : 'Payment Collected'}
          </h2>
          <p className="text-muted-foreground mt-1 font-mono text-sm">{successBill.billNumber}</p>
        </div>
        <div className="bg-zinc-50 border rounded-xl p-6 w-full max-w-sm text-left space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Total Charged</span>
            <span className="font-bold text-lg">₹{fmt(successBill.totalAmount)}</span>
          </div>
          {(successBill.balanceDue ?? 0) > 0 && (
            <>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Paid now</span>
                <span className="font-medium">₹{fmt(successBill.paidAmount ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm font-bold text-orange-600 pt-1 border-t">
                <span>Balance due</span>
                <span>₹{fmt(successBill.balanceDue ?? 0)}</span>
              </div>
              {successBill.dueDate && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Payable by</span>
                  <span>{new Date(successBill.dueDate).toLocaleDateString('en-IN')}</span>
                </div>
              )}
            </>
          )}
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Payment</span>
            <span className="font-medium">{successBill.paymentMethod}</span>
          </div>
          {successBill.changeGiven != null && successBill.changeGiven > 0 && (
            <div className="flex justify-between text-sm border-t pt-2 mt-2">
              <span className="text-muted-foreground">Change</span>
              <span className="font-bold text-emerald-700">₹{fmt(successBill.changeGiven)}</span>
            </div>
          )}
          <div className="border-t pt-3 mt-2 space-y-1">
            {successBill.items?.map((it, i) => (
              <div key={i} className="flex justify-between text-xs text-muted-foreground">
                <span>{it.productName} × {it.quantity}</span>
                <span>₹{fmt(it.lineTotal)}</span>
              </div>
            ))}
          </div>
        </div>
        {printError && <p className="text-xs text-red-600">Print: {printError}</p>}
        <div className="flex gap-3 flex-wrap justify-center">
          <Button
            variant="outline"
            onClick={() => handlePrint(successBill, autoPrintFiredFor.current === successBill.billNumber ? 'REPRINT' : undefined)}
            disabled={printingState === 'printing'}
            className="gap-2 h-11 px-5"
          >
            <Printer className="w-4 h-4" />
            {printingState === 'printing' ? 'Printing…' : (autoPrintFiredFor.current === successBill.billNumber ? 'Reprint' : 'Print Receipt')}
          </Button>
          <Button onClick={startNewBill} className="gap-2 h-11 px-8">
            <Plus className="w-4 h-4" /> New Bill
          </Button>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground select-none cursor-pointer">
          <input
            type="checkbox"
            checked={autoPrint}
            onChange={(e) => setAutoPrint(e.target.checked)}
            className="w-3.5 h-3.5 accent-zinc-800"
          />
          Auto-print receipt after each bill
        </label>
      </div>
    )
  }

  // ─── Main Billing UI ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ShoppingCart className="w-6 h-6" /> New Bill
          </h1>
          {billNumber && (
            <p className="text-xs text-muted-foreground font-mono mt-0.5">{billNumber}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {customer ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-zinc-50 text-sm">
              <User className="w-3.5 h-3.5 text-zinc-500" />
              <span className="font-medium text-zinc-800">{customer.name}</span>
              <span className="text-muted-foreground text-xs">{customer.phone}</span>
              {creditInfo != null && creditInfo.outstanding > 0 && (
                <span className="text-xs font-semibold text-orange-600 border-l pl-2">
                  owes ₹{fmt(creditInfo.outstanding)}
                </span>
              )}
              <button type="button" onClick={() => setCustomer(null)} className="text-zinc-400 hover:text-zinc-700 ml-1">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setShowCustomerModal(true)} className="gap-2 text-sm h-9">
              <User className="w-3.5 h-3.5" /> Attach Customer
            </Button>
          )}
        </div>
      </div>

      {/* Two-panel layout */}
      <div className="flex gap-5 flex-1 min-h-0">

        {/* LEFT PANEL */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Search bar */}
          <div className="mb-4" ref={searchRef}>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground z-10" />
              <Input
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPendingProduct(null) }}
                onFocus={() => search && setShowDropdown(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setShowDropdown(false)
                  else if (e.key === 'Enter') { e.preventDefault(); void handleSearchEnter() }
                }}
                placeholder="Scan barcode or search by name / item code..."
                className="pl-9 h-11 text-base"
                autoFocus={!pendingProduct}
              />
              {searchLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
              )}

              {/* Dropdown */}
              {showDropdown && searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-xl shadow-xl overflow-hidden max-h-72 overflow-y-auto">
                  {searchResults.map((p) => {
                    const outOfStock = p.totalStock <= 0
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={outOfStock}
                        onClick={() => selectProduct(p)}
                        className={`w-full flex items-center justify-between px-4 py-3 text-left transition-colors border-b last:border-b-0 ${outOfStock ? 'cursor-not-allowed bg-zinc-50/70' : 'hover:bg-zinc-50 cursor-pointer'}`}
                      >
                        <div className="min-w-0">
                          <p className={`font-medium text-sm truncate ${outOfStock ? 'text-zinc-500' : 'text-zinc-900'}`}>
                            {p.name}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            {p.itemCode}{p.brand ? ` · ${p.brand}` : ''}
                          </p>
                        </div>
                        <div className="ml-4 text-right shrink-0">
                          <p className={`font-semibold text-sm ${outOfStock ? 'text-zinc-500' : 'text-zinc-900'}`}>
                            ₹{fmt(p.sellingRate)}
                          </p>
                          {outOfStock ? (
                            <span className="inline-block mt-0.5 px-1.5 py-0.5 rounded bg-zinc-200 text-zinc-600 text-[10px] font-semibold uppercase tracking-wide">
                              No stock
                            </span>
                          ) : (
                            <p className="text-xs mt-0.5 text-emerald-600">
                              {formatQty(p.totalStock)} {p.unitOfMeasure}
                            </p>
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
              {showDropdown && search && !searchLoading && searchResults.length === 0 && (
                <div className="absolute top-full left-0 right-0 z-50 mt-1 bg-white border rounded-xl shadow-xl px-4 py-6 text-center text-sm text-muted-foreground">
                  No products found for "{search}"
                </div>
              )}
            </div>

            {/* Quantity prompt — shown after selecting a product */}
            {pendingProduct && (
              <div className="mt-2 flex items-center gap-3 px-4 py-3 rounded-xl border-2 border-zinc-900 bg-zinc-50">
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-zinc-900 text-sm truncate">{pendingProduct.name}</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    ₹{fmt(pendingProduct.sellingRate)} per {pendingProduct.unitOfMeasure} · {formatQty(pendingProduct.totalStock)} {pendingProduct.unitOfMeasure} in stock
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <label className="text-xs font-semibold text-zinc-600 whitespace-nowrap">
                    {isLengthMode(pendingProduct.sellMode) ? 'Length:' : 'Qty:'}
                  </label>
                  <input
                    ref={pendingQtyRef}
                    type="number"
                    min={qtyStep(pendingProduct.sellMode)}
                    step={qtyStep(pendingProduct.sellMode)}
                    max={pendingProduct.totalStock}
                    value={pendingQty}
                    onChange={(e) => setPendingQty(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmAddToCart()
                      if (e.key === 'Escape') setPendingProduct(null)
                    }}
                    className="w-24 h-9 px-3 text-sm font-semibold text-center rounded-lg border-2 border-zinc-300 focus:border-zinc-900 focus:outline-none bg-white tabular-nums"
                  />
                  <span className="text-xs font-medium text-zinc-500 -ml-1">{pendingProduct.unitOfMeasure}</span>
                  <Button
                    onClick={confirmAddToCart}
                    className="h-9 px-4 text-sm font-semibold bg-zinc-900 hover:bg-zinc-800 text-white"
                  >
                    Add ↵
                  </Button>
                  <button
                    type="button"
                    onClick={() => setPendingProduct(null)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Cart items */}
          {cartItems.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center rounded-xl border-2 border-dashed text-center p-10">
              <ShoppingCart className="w-10 h-10 text-zinc-300 mb-3" strokeWidth={1.5} />
              <p className="text-sm font-medium text-zinc-500">Search a product above to start billing</p>
              <p className="text-xs text-muted-foreground mt-1">Items will appear here once added</p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-zinc-600 w-6">#</th>
                    <th className="text-left px-4 py-3 font-semibold text-zinc-600">Product</th>
                    <th className="text-center px-3 py-3 font-semibold text-zinc-600 w-28">Qty</th>
                    <th className="text-right px-3 py-3 font-semibold text-zinc-600 w-24">Rate</th>
                    <th className="text-center px-3 py-3 font-semibold text-zinc-600 w-40">Discount</th>
                    <th className="text-right px-3 py-3 font-semibold text-zinc-600 w-24">Total</th>
                    <th className="w-10 px-2 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {cartItems.map((it, idx) => (
                    <tr key={it.productId + idx} className="hover:bg-zinc-50/60 group">
                      <td className="px-4 py-3 text-muted-foreground text-xs">{idx + 1}</td>
                      <td className="px-4 py-3">
                        <p className="font-medium text-zinc-900">{it.productName}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{it.itemCode}</p>
                      </td>
                      <td className="px-3 py-3">
                        {/* Stepping a cut length by 0.001 would be useless, so
                            those lines are typed directly instead. */}
                        {isLengthMode(it.sellMode) ? (
                          <div className="flex items-center justify-center gap-1">
                            <input
                              type="number"
                              min={qtyStep(it.sellMode)}
                              step={qtyStep(it.sellMode)}
                              max={it.maxQty}
                              defaultValue={formatQty(it.quantity)}
                              key={`${it.productId}-${it.quantity}`}
                              onBlur={(e) => setQty(idx, e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                              className="w-20 h-7 px-2 text-sm font-semibold text-center rounded-md border tabular-nums focus:border-zinc-900 focus:outline-none"
                            />
                            <span className="text-xs text-muted-foreground">{it.unitOfMeasure}</span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => updateQty(idx, -1)}
                              disabled={it.quantity <= 1}
                              className="w-7 h-7 rounded-md border flex items-center justify-center hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                            >
                              <Minus className="w-3 h-3" />
                            </button>
                            <span className="w-8 text-center font-semibold tabular-nums">{formatQty(it.quantity)}</span>
                            <button
                              type="button"
                              onClick={() => updateQty(idx, 1)}
                              disabled={it.quantity >= it.maxQty}
                              className="w-7 h-7 rounded-md border flex items-center justify-center hover:bg-zinc-100 disabled:opacity-30 transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                        {it.quantity >= it.maxQty && (
                          <p className="text-center text-xs text-amber-600 mt-0.5">max</p>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right font-medium text-zinc-800">
                        ₹{fmt(it.unitRate)}
                        <p className="text-xs text-muted-foreground">{it.unitOfMeasure}</p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-1">
                          <div className="relative flex-1">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={it.lineDiscountPct || ''}
                              onChange={(e) => updateDiscount(idx, 'lineDiscountPct', e.target.value)}
                              placeholder="0"
                              className="w-full pl-5 pr-1 h-7 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring text-right"
                            />
                          </div>
                          <span className="text-zinc-300 text-xs">/</span>
                          <div className="relative flex-1">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                            <input
                              type="number"
                              min="0"
                              value={it.lineDiscountAmt || ''}
                              onChange={(e) => updateDiscount(idx, 'lineDiscountAmt', e.target.value)}
                              placeholder="0"
                              className="w-full pl-5 pr-1 h-7 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring text-right"
                            />
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-bold text-zinc-900">
                        ₹{fmt(it.lineTotal)}
                        {it.gstPercentage > 0 && (
                          <p className="text-xs text-muted-foreground font-normal">
                            incl. {it.gstPercentage}% GST
                          </p>
                        )}
                      </td>
                      <td className="px-2 py-3">
                        <button
                          type="button"
                          onClick={() => removeItem(idx)}
                          className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-300 hover:bg-red-50 hover:text-red-500 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* RIGHT PANEL */}
        <div className="w-[360px] shrink-0 flex flex-col gap-4">

          {/* Order Summary */}
          <div className="rounded-xl border bg-card p-5">
            <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-4">
              Order Summary
            </p>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-muted-foreground">
                <span>{cartItems.length} item{cartItems.length !== 1 ? 's' : ''}</span>
                <span>₹{fmt(subtotal)}</span>
              </div>
              {billDiscAmt > 0 && (
                <div className="flex justify-between text-emerald-600">
                  <span>Discount</span>
                  <span>−₹{fmt(billDiscAmt)}</span>
                </div>
              )}
              {/* Rates are GST-inclusive, so tax is extracted from the total
                  rather than added to it. Showing the taxable value makes the
                  split legible instead of subtotal simply repeating the total. */}
              <div className="flex justify-between text-muted-foreground">
                <span>Taxable value</span>
                <span>₹{fmt(taxableValue)}</span>
              </div>
              {totalGst > 0 && (
                <>
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>CGST</span>
                    <span>₹{fmt(cgstAmount)}</span>
                  </div>
                  <div className="flex justify-between text-muted-foreground text-xs">
                    <span>SGST</span>
                    <span>₹{fmt(sgstAmount)}</span>
                  </div>
                </>
              )}
            </div>

            {/* Bill discount */}
            <div className="mt-4 pt-4 border-t">
              <p className="text-xs font-semibold text-zinc-600 mb-2">Bill Discount</p>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">₹</span>
                  <Input
                    type="number"
                    min="0"
                    value={billDiscountFlat}
                    onChange={(e) => { setBillDiscountFlat(e.target.value); setBillDiscountPct('') }}
                    placeholder="Flat"
                    className="pl-7 h-9 text-sm"
                  />
                </div>
                <div className="relative flex-1">
                  <Input
                    type="number"
                    min="0"
                    max="100"
                    value={billDiscountPct}
                    onChange={(e) => { setBillDiscountPct(e.target.value); setBillDiscountFlat('') }}
                    placeholder="0 %"
                    className="pr-7 h-9 text-sm"
                  />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                </div>
              </div>
              {billDiscAmt > 0 && billDiscPct > 0 && (
                <p className="text-xs text-emerald-600 mt-1.5">{billDiscPct}% → −₹{fmt(billDiscAmt)}</p>
              )}
            </div>

            {/* Grand total */}
            <div className="mt-4 pt-4 border-t flex items-center justify-between">
              <span className="font-bold text-zinc-900">Total</span>
              <span className="text-2xl font-bold text-zinc-900">₹{fmt(grandTotal)}</span>
            </div>
          </div>

          {/* Payment */}
          <div className="rounded-xl border bg-card p-5 flex flex-col gap-4">
            <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Payment</p>

            {/* Tender lines. A single cash line covers the common case and
                tracks the bill total; splitting is one click away. */}
            <div className="space-y-2">
              {tenders.map((t, idx) => (
                <div key={t.key} className="space-y-1.5">
                  <div className="flex gap-2">
                    <select
                      value={t.method}
                      onChange={(e) => updateTender(idx, { method: e.target.value as PaymentMethod })}
                      className="h-11 rounded-lg border border-zinc-200 bg-white px-2 text-sm font-semibold text-zinc-700 focus:outline-none focus:border-zinc-900"
                    >
                      {PAYMENT_METHODS.map((m) => (
                        <option key={m} value={m}>{METHOD_META[m].label}</option>
                      ))}
                    </select>
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-medium">₹</span>
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={t.amount}
                        onChange={(e) => updateTender(idx, { amount: e.target.value })}
                        placeholder={fmt(remainingExcluding(idx))}
                        className="pl-8 h-11 text-base font-medium"
                      />
                    </div>
                    {tenders.length > 1 && (
                      <button
                        type="button"
                        onClick={() => removeTender(idx)}
                        className="w-9 h-11 flex items-center justify-center rounded-lg text-zinc-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                        title="Remove this payment"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  {NEEDS_REFERENCE.includes(t.method) && (
                    <Input
                      value={t.reference}
                      onChange={(e) => updateTender(idx, { reference: e.target.value })}
                      placeholder={t.method === 'CHEQUE' ? 'Cheque number' : 'UPI reference'}
                      className="h-9 text-sm font-mono"
                    />
                  )}
                </div>
              ))}

              <button
                type="button"
                onClick={addTender}
                className="w-full flex items-center justify-center gap-2 py-2 rounded-lg border border-dashed text-xs font-semibold text-muted-foreground hover:bg-zinc-50 hover:text-zinc-700 transition-colors"
              >
                <SplitSquareHorizontal className="w-3.5 h-3.5" /> Split payment
              </button>
            </div>

            {/* Quick tender amounts for the first cash line */}
            {grandTotal > 0 && tenders.length === 1 && tenders[0].method === 'CASH' && (
              <div className="flex gap-1.5 flex-wrap">
                {[grandTotal, Math.ceil(grandTotal / 10) * 10, Math.ceil(grandTotal / 50) * 50, Math.ceil(grandTotal / 100) * 100]
                  .filter((v, i, a) => a.indexOf(v) === i)
                  .slice(0, 4)
                  .map((amt) => (
                    <button
                      key={amt}
                      type="button"
                      onClick={() => updateTender(0, { amount: String(amt) })}
                      className="px-2.5 py-1 rounded-md border text-xs font-medium hover:bg-zinc-100 transition-colors"
                    >
                      ₹{fmt(amt)}
                    </button>
                  ))}
              </div>
            )}

            {/* Where the money landed */}
            {settlement.tendered > 0 && settlement.changeGiven > 0 && (
              <div className="flex items-center justify-between p-3 rounded-lg text-sm font-semibold bg-emerald-50 text-emerald-800">
                {/* "Change to return" read as if the customer were returning
                    something. This is money going back across the counter. */}
                <span>Change to give back</span>
                <span className="text-base">₹{fmt(settlement.changeGiven)}</span>
              </div>
            )}
            {balanceDue > 0 && (
              <div className="flex items-center justify-between p-3 rounded-lg text-sm font-semibold bg-orange-50 text-orange-800">
                <span>Balance due</span>
                <span className="text-base">₹{fmt(balanceDue)}</span>
              </div>
            )}

            {/* Credit position for the selected customer */}
            {balanceDue > 0 && (
              creditCheck.reason === 'NO_CUSTOMER' ? (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 text-amber-800 text-xs">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>Select a customer before leaving a balance — a walk-in bill has to be paid in full.</span>
                </div>
              ) : creditInfo ? (
                <div className={`p-3 rounded-lg text-xs ${creditCheck.allowed ? 'bg-zinc-50 text-zinc-600' : 'bg-amber-50 text-amber-800'}`}>
                  <div className="flex justify-between">
                    <span>Already owes</span>
                    <span className="font-semibold">₹{fmt(creditInfo.outstanding)}</span>
                  </div>
                  <div className="flex justify-between mt-0.5">
                    <span>Credit available</span>
                    <span className="font-semibold">₹{fmt(availableCredit)}</span>
                  </div>
                  {!creditCheck.allowed && (
                    <p className="mt-1.5 font-semibold flex items-start gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      {creditCheck.reason === 'NO_CREDIT_ALLOWED'
                        ? 'This customer has no credit limit set.'
                        : `Over their limit by ₹${fmt(creditCheck.overBy)}.`}
                    </p>
                  )}
                </div>
              ) : null
            )}

            {creditError && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-800 space-y-2">
                <p className="flex items-start gap-1.5 font-medium">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                  {creditError.message}
                </p>
                {creditError.needsOverride && (
                  isSuperAdmin ? (
                    <Button
                      onClick={() => handlePay(true)}
                      disabled={submitting}
                      variant="outline"
                      className="h-8 w-full text-xs gap-1.5"
                    >
                      <ShieldCheck className="w-3.5 h-3.5" /> Authorise anyway
                    </Button>
                  ) : (
                    <p className="text-[11px] text-amber-700">Ask a manager to authorise this.</p>
                  )
                )}
              </div>
            )}

            {submitError && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">{submitError}</div>
            )}

            {/* Action buttons */}
            <div className="flex flex-col gap-2 mt-1">
              <Button
                onClick={() => handlePay()}
                disabled={!canPay || submitting || cartItems.length === 0}
                className="h-12 text-base font-bold gap-2 w-full"
              >
                {submitting ? (
                  <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Processing...</>
                ) : (
                  <>
                    <CheckCircle2 className="w-5 h-5" />
                    {balanceDue > 0
                      ? `Collect ₹${fmt(settlement.paidAmount)} · ₹${fmt(balanceDue)} on credit`
                      : `Collect ₹${fmt(grandTotal)}`}
                  </>
                )}
              </Button>
              <button
                type="button"
                onClick={() => {
                  if (cartItems.length === 0 || confirm('Clear the current bill?')) {
                    setCartItems([])
                    setBillDiscountFlat('')
                    setBillDiscountPct('')
                    resetTenders()
                    setSubmitError('')
                    setCreditError(null)
                  }
                }}
                className="text-xs text-muted-foreground hover:text-red-600 transition-colors text-center py-1"
              >
                Clear Bill
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Customer Modal */}
      <Modal
        open={showCustomerModal}
        onClose={() => { setShowCustomerModal(false); resetCustomerModal() }}
        title="Attach Customer"
        size="sm"
      >
        <div className="space-y-4">
          {!showAddCustomer ? (
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Search by name or phone..."
                  className="pl-9 h-10"
                  autoFocus
                />
              </div>

              {customerSearchLoading && (
                <div className="flex justify-center py-4">
                  <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin" />
                </div>
              )}

              {!customerSearchLoading && customerSearch && customerResults.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-3">No customers found.</p>
              )}

              {customerResults.length > 0 && (
                <div className="rounded-lg border overflow-hidden divide-y max-h-48 overflow-y-auto">
                  {customerResults.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setCustomer(c); setShowCustomerModal(false); resetCustomerModal() }}
                      className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-50 transition-colors"
                    >
                      <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0 font-bold text-zinc-600 text-sm uppercase">
                        {c.name.charAt(0)}
                      </div>
                      <div>
                        <p className="font-medium text-sm text-zinc-900">{c.name}</p>
                        <p className="text-xs text-muted-foreground">{c.phone}</p>
                      </div>
                      <ChevronDown className="w-4 h-4 text-zinc-300 ml-auto -rotate-90" />
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowAddCustomer(true)}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg border border-dashed text-sm text-muted-foreground hover:bg-zinc-50 hover:text-zinc-700 transition-colors"
              >
                <Plus className="w-4 h-4" /> Add New Customer
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => { setShowAddCustomer(false); setNewCustomerError('') }}
                className="text-xs text-muted-foreground hover:text-zinc-700 flex items-center gap-1"
              >
                ← Back to search
              </button>
              {newCustomerError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{newCustomerError}</div>
              )}
              <div>
                <label className="block text-sm font-semibold mb-1.5 ml-1">Name *</label>
                <Input value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} placeholder="Customer name" className="h-10" autoFocus />
              </div>
              <div>
                <label className="block text-sm font-semibold mb-1.5 ml-1">Phone *</label>
                <Input value={newCustomerPhone} onChange={(e) => setNewCustomerPhone(e.target.value)} placeholder="Phone number" className="h-10" />
              </div>
              <div className="flex gap-2 pt-1">
                <Button variant="outline" onClick={() => setShowAddCustomer(false)} className="flex-1">Cancel</Button>
                <Button onClick={handleAddCustomer} className="flex-1">Add & Attach</Button>
              </div>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}
