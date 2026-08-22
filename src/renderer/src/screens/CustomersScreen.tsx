import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import {
  Users, Plus, Search, ChevronLeft, Edit2, RefreshCw,
  Phone, Mail, MapPin, Building2, Receipt, ChevronRight,
  ToggleLeft, ToggleRight, UserX, Wallet, HandCoins, AlertTriangle,
  CalendarClock, Check, Undo2, StickyNote
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'
import { BillDetailViewer } from '../components/BillDetailViewer'
import type { ReceiptShop } from '../lib/receipt'
import {
  validateName, validateMobile, validateEmail, validateGstin,
  formatPhone, normalizePhone, type FieldResult
} from '@shared/validation'
import { PAYMENT_METHODS, AGE_BUCKETS, type PaymentMethod, type AgeBucket } from '@shared/credit'
import { round2 } from '@shared/money'

// ─── Types ────────────────────────────────────────────────────────────────────

type Customer = {
  id: string
  name: string
  phone: string
  email: string | null
  address: string | null
  gstin: string | null
  isActive: boolean
  createdAt: string
  /** Most this customer may owe at once. 0 means no credit at all. */
  creditLimit?: number | string
  /** Days from bill date before a balance is considered due. */
  creditDays?: number | string
  /** Summed from unsettled bills by the server — never stored. */
  outstanding?: number
  _count?: { bills: number }
}

type CustomerDetail = Customer & {
  bills: {
    id: string
    billNumber: string
    totalAmount: number
    paymentMethod: string
    status: string
    paidAt: string
    _count: { items: number }
  }[]
}

type CustomerForm = {
  name: string
  phone: string
  email: string
  address: string
  gstin: string
  creditLimit: string
  creditDays: string
}

/** One bill that still owes money, as returned by /customers/:id/outstanding. */
type OutstandingBill = {
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

type OutstandingInfo = {
  outstanding: number
  availableCredit: number
  overLimit: boolean
  customer: { creditLimit: number; creditDays: number }
  bills: OutstandingBill[]
}

type PaymentRow = {
  id: string
  amount: number
  method: string
  reference: string | null
  receivedAt: string
  /** False for tender taken at the till, true for money collected afterwards. */
  isSettlement: boolean
  note: string | null
  bill?: { billNumber: string } | null
  collectedBy?: { username: string } | null
}

type FollowUp = {
  id: string
  note: string
  dueAt: string | null
  resolvedAt: string | null
  createdAt: string
  createdBy?: { username: string } | null
}

type Props = { token: string | null }

const PAGE_SIZE = 50
/**
 * There is no server-side "owes money" filter, so the debtor toggle pulls one
 * wide page and narrows it here. A single branch's customer book fits well
 * inside this, and the toggle hides pagination while it is on.
 */
const DEBTOR_SCAN_LIMIT = 500
const SEARCH_DEBOUNCE_MS = 300

const emptyForm = (): CustomerForm => ({
  name: '', phone: '', email: '', address: '', gstin: '', creditLimit: '', creditDays: ''
})

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/** Decimals arrive as numbers from list endpoints and as strings from Prisma. */
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const shortDate = (d: string | Date) =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

const PM_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', CHEQUE: 'Cheque' }

const BUCKET_LABEL: Record<AgeBucket, string> = {
  current: 'Not yet due',
  '0-30': '1–30 days',
  '31-60': '31–60 days',
  '60+': 'Over 60 days'
}

const BUCKET_CLASS: Record<AgeBucket, string> = {
  current: 'bg-zinc-100 text-zinc-600 border-zinc-200',
  '0-30': 'bg-amber-50 text-amber-700 border-amber-200',
  '31-60': 'bg-orange-50 text-orange-700 border-orange-200',
  '60+': 'bg-red-50 text-red-700 border-red-200'
}

// ─── Role ─────────────────────────────────────────────────────────────────────

/**
 * Credit terms are the shop owner's call, so only a SUPER_ADMIN is shown the
 * inputs. The role travels in the session JWT's payload, so we read it from
 * there rather than asking the server — this only decides what to render; the
 * API refuses the fields on its own (403 CREDIT_TERMS_FORBIDDEN) regardless.
 */
function roleFromToken(raw: string | null): string | null {
  if (!raw) return null
  try {
    const payload = raw.split('.')[1]
    if (!payload) return null
    // Base64url → base64 before decoding.
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return (JSON.parse(json) as { role?: string }).role ?? null
  } catch {
    return null // malformed token — treat as "not a super admin"
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** Fields we validate, in the order they appear in the form. */
type ValidatedField = 'name' | 'phone' | 'email' | 'gstin' | 'creditLimit' | 'creditDays'

const FIELD_ORDER: ValidatedField[] = ['name', 'phone', 'email', 'gstin', 'creditLimit', 'creditDays']

/** Only rendered — and only sent — for a SUPER_ADMIN. */
const CREDIT_FIELDS: ValidatedField[] = ['creditLimit', 'creditDays']

/** Blank means "no credit", which is the safe default for a new customer. */
function validateCreditLimit(raw: string): FieldResult {
  const t = (raw ?? '').trim()
  if (!t) return { ok: true, value: '0' }
  const n = Number(t)
  if (!Number.isFinite(n)) {
    return { ok: false, error: 'CREDIT_LIMIT_INVALID', message: 'Enter an amount, e.g. 5000.' }
  }
  if (n < 0) {
    return { ok: false, error: 'CREDIT_LIMIT_NEGATIVE', message: 'A credit limit cannot be negative.' }
  }
  return { ok: true, value: String(round2(n)) }
}

function validateCreditDays(raw: string): FieldResult {
  const t = (raw ?? '').trim()
  if (!t) return { ok: true, value: '0' }
  const n = Number(t)
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, error: 'CREDIT_DAYS_INVALID', message: 'Whole days only — 0 means due at once.' }
  }
  return { ok: true, value: String(n) }
}

const VALIDATORS: Record<ValidatedField, (v: string) => FieldResult> = {
  name: (v) => validateName(v, 'Customer name'),
  phone: (v) => validateMobile(v),
  email: (v) => validateEmail(v),
  gstin: (v) => validateGstin(v),
  creditLimit: validateCreditLimit,
  creditDays: validateCreditDays
}

type FieldErrors = Partial<Record<ValidatedField, string>>

/** Maps a server error code onto the field it belongs to, when that's obvious. */
function fieldForCode(code: string | undefined): ValidatedField | null {
  if (!code) return null
  if (code.startsWith('PHONE_')) return 'phone'   // incl. PHONE_ALREADY_EXISTS
  if (code.startsWith('GSTIN_')) return 'gstin'
  if (code.startsWith('EMAIL_')) return 'email'
  if (code.startsWith('NAME_')) return 'name'
  // CREDIT_TERMS_FORBIDDEN is about who you are, not about a field — it stays
  // at form level so it cannot be mistaken for bad input.
  return null
}

/** Fallbacks for server codes that predate the shared `message` field. */
const CODE_FALLBACK: Record<string, string> = {
  PHONE_ALREADY_EXISTS: 'A customer with this phone number already exists.',
  CREDIT_TERMS_FORBIDDEN: 'Only a super admin can change credit terms.'
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomersScreen({ token }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [owesOnly, setOwesOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Detail view
  const [detailCustomer, setDetailCustomer] = useState<CustomerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  // Credit / collections for the open customer
  const [credit, setCredit] = useState<OutstandingInfo | null>(null)
  const [creditLoading, setCreditLoading] = useState(false)
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [followUps, setFollowUps] = useState<FollowUp[]>([])
  const [showPayment, setShowPayment] = useState(false)

  // Follow-up composer
  const [fuNote, setFuNote] = useState('')
  const [fuDue, setFuDue] = useState('')
  const [fuError, setFuError] = useState('')
  const [fuSaving, setFuSaving] = useState(false)

  // Bill drill-down (refund + replace flows)
  const [openBillId, setOpenBillId] = useState<string | null>(null)
  // Shop info for receipt printing — fetched lazily on first bill drilldown.
  const [shopInfo, setShopInfo] = useState<ReceiptShop>({ name: 'My Shop' })
  useEffect(() => {
    if (!token) return
    apiFetch<{ setupDone: boolean; shopName?: string; branchName?: string }>(
      '/api/v1/system/status', token
    ).then((d) => {
      if (d.shopName) setShopInfo({ name: d.shopName, branch: d.branchName ?? null })
    }).catch(() => { /* keep default */ })
  }, [token])

  // Add / Edit modal
  const [showModal, setShowModal] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<CustomerForm>(emptyForm())
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const fieldRefs = useRef<Partial<Record<ValidatedField, HTMLInputElement | null>>>({})

  const canSetCreditTerms = useMemo(
    () => roleFromToken(token ?? localStorage.getItem('managerToken')) === 'SUPER_ADMIN',
    [token]
  )

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  // Debounce search → reset page to 1 when search changes
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [search])

  // ─── Fetch list ─────────────────────────────────────────────────────────────

  const fetchCustomers = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({
        limit: String(owesOnly ? DEBTOR_SCAN_LIMIT : PAGE_SIZE),
        offset: String(owesOnly ? 0 : (page - 1) * PAGE_SIZE)
      })
      const q = debouncedSearch.trim()
      // Phones are displayed grouped ("98765 43210"), so a pasted number has to
      // be reduced back to bare digits before it will match server-side.
      if (q) params.set('search', /^[+\d\s-]+$/.test(q) ? normalizePhone(q) : q)
      const data = await apiFetch<{ customers: Customer[]; total: number }>(
        `/api/v1/customers?${params}`,
        token
      )
      setCustomers(owesOnly ? data.customers.filter((c) => num(c.outstanding) > 0) : data.customers)
      setTotal(data.total)
    } catch {
      setError('Failed to load customers.')
    } finally {
      setLoading(false)
    }
  }, [token, page, debouncedSearch, owesOnly])

  useEffect(() => { fetchCustomers() }, [fetchCustomers])

  // ─── Credit, payments, follow-ups ───────────────────────────────────────────

  const loadCredit = useCallback(async (id: string) => {
    setCreditLoading(true)
    try {
      setCredit(await apiFetch<OutstandingInfo>(`/api/v1/customers/${id}/outstanding`, token))
    } catch {
      setCredit(null)
    } finally {
      setCreditLoading(false)
    }
  }, [token])

  const loadPayments = useCallback(async (id: string) => {
    try {
      const data = await apiFetch<{ payments: PaymentRow[] }>(
        `/api/v1/payments?customerId=${encodeURIComponent(id)}&limit=25`, token
      )
      setPayments(data.payments ?? [])
    } catch {
      setPayments([])
    }
  }, [token])

  const loadFollowUps = useCallback(async (id: string) => {
    try {
      const data = await apiFetch<{ followUps: FollowUp[] }>(
        `/api/v1/followups?customerId=${encodeURIComponent(id)}`, token
      )
      setFollowUps(data.followUps ?? [])
    } catch {
      setFollowUps([])
    }
  }, [token])

  const loadCreditPanels = useCallback((id: string) => {
    loadCredit(id)
    loadPayments(id)
    loadFollowUps(id)
  }, [loadCredit, loadPayments, loadFollowUps])

  // ─── Detail view ────────────────────────────────────────────────────────────

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    setDetailCustomer(null)
    setCredit(null)
    setPayments([])
    setFollowUps([])
    try {
      const data = await apiFetch<{ customer: CustomerDetail }>(`/api/v1/customers/${id}`, token)
      setDetailCustomer(data.customer)
      loadCreditPanels(id)
    } catch {
      // ignore
    } finally {
      setDetailLoading(false)
    }
  }

  const closeDetail = () => {
    setDetailCustomer(null)
    setCredit(null)
    setPayments([])
    setFollowUps([])
    setFuNote('')
    setFuDue('')
    setFuError('')
  }

  // Refetch the currently-open customer (e.g. after a refund, exchange or
  // collection so the bill list and the balances reflect it).
  const refreshDetail = async (): Promise<void> => {
    if (!detailCustomer) return
    const id = detailCustomer.id
    try {
      const data = await apiFetch<{ customer: CustomerDetail }>(`/api/v1/customers/${id}`, token)
      setDetailCustomer(data.customer)
    } catch { /* ignore */ }
    loadCreditPanels(id)
  }

  // ─── Follow-ups ─────────────────────────────────────────────────────────────

  const addFollowUp = async () => {
    if (!detailCustomer) return
    const note = fuNote.trim()
    if (!note) {
      setFuError('Write what needs following up.')
      return
    }
    setFuSaving(true)
    setFuError('')
    try {
      await apiFetch(`/api/v1/customers/${detailCustomer.id}/followups`, token, {
        method: 'POST',
        body: JSON.stringify({ note, dueAt: fuDue ? new Date(fuDue).toISOString() : null })
      })
      setFuNote('')
      setFuDue('')
      loadFollowUps(detailCustomer.id)
    } catch (err: unknown) {
      const e = err as { data?: { message?: string } }
      setFuError(e.data?.message || 'Failed to add the follow-up.')
    } finally {
      setFuSaving(false)
    }
  }

  const setFollowUpResolved = async (f: FollowUp, resolved: boolean) => {
    if (!detailCustomer) return
    try {
      await apiFetch(`/api/v1/followups/${f.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ resolved })
      })
      loadFollowUps(detailCustomer.id)
    } catch { /* ignore */ }
  }

  // ─── Add / Edit ─────────────────────────────────────────────────────────────

  const openAdd = () => {
    setEditingId(null)
    setForm(emptyForm())
    setFormError('')
    setFieldErrors({})
    setShowModal(true)
  }

  const openEdit = (c: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setEditingId(c.id)
    setForm({
      name: c.name,
      phone: c.phone,
      email: c.email ?? '',
      address: c.address ?? '',
      gstin: c.gstin ?? '',
      creditLimit: String(num(c.creditLimit)),
      creditDays: String(num(c.creditDays))
    })
    setFormError('')
    setFieldErrors({})
    setShowModal(true)
  }

  // ─── Field-level validation ─────────────────────────────────────────────────

  /** Typing never blocks, but a field already showing an error re-checks live. */
  const setField = (key: keyof CustomerForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (!(FIELD_ORDER as string[]).includes(key)) return
    const field = key as ValidatedField
    setFieldErrors((prev) => {
      if (!prev[field]) return prev
      const r = VALIDATORS[field](value)
      if (!r.ok) return { ...prev, [field]: r.message }
      const next = { ...prev }
      delete next[field]
      return next
    })
  }

  const blurField = (field: ValidatedField) => {
    const r = VALIDATORS[field](form[field])
    setFieldErrors((prev) => {
      const next = { ...prev }
      if (r.ok) delete next[field]
      else next[field] = r.message
      return next
    })
  }

  const focusField = (field: ValidatedField) => {
    const el = fieldRefs.current[field]
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.focus()
  }

  const handleSave = async () => {
    // Re-validate everything on submit and jump to the first offending field.
    // A cashier never sees the credit inputs, so they are not checked or sent.
    const order = canSetCreditTerms
      ? FIELD_ORDER
      : FIELD_ORDER.filter((f) => !CREDIT_FIELDS.includes(f))
    const errors: FieldErrors = {}
    const values = {} as Record<ValidatedField, string>
    for (const field of order) {
      const r = VALIDATORS[field](form[field])
      if (r.ok) values[field] = r.value
      else errors[field] = r.message
    }
    setFieldErrors(errors)
    const firstBad = order.find((f) => errors[f])
    if (firstBad) {
      setFormError('')
      focusField(firstBad)
      return
    }

    setSaving(true)
    setFormError('')
    try {
      // Send the normalized values, not the raw input.
      const body: Record<string, unknown> = {
        name: values.name,
        phone: values.phone,
        email: values.email || null,
        address: form.address.trim() || null,
        gstin: values.gstin || null
      }
      if (canSetCreditTerms) {
        body.creditLimit = Number(values.creditLimit)
        body.creditDays = Number(values.creditDays)
      }
      if (editingId) {
        await apiFetch(`/api/v1/customers/${editingId}`, token, {
          method: 'PUT',
          body: JSON.stringify(body)
        })
        // refresh detail if open
        if (detailCustomer?.id === editingId) {
          openDetail(editingId)
        }
      } else {
        await apiFetch('/api/v1/customers', token, {
          method: 'POST',
          body: JSON.stringify(body)
        })
      }
      setShowModal(false)
      fetchCustomers()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      const code = e.data?.error
      const message = e.data?.message || (code ? CODE_FALLBACK[code] : '')
      const field = fieldForCode(code)
      if (field && message) {
        setFieldErrors((prev) => ({ ...prev, [field]: message }))
        setFormError('')
        focusField(field)
      } else {
        setFormError(message || 'Failed to save customer.')
      }
    } finally {
      setSaving(false)
    }
  }

  // ─── Toggle active ───────────────────────────────────────────────────────────

  const toggleActive = async (c: Customer, e?: React.MouseEvent) => {
    e?.stopPropagation()
    try {
      await apiFetch(`/api/v1/customers/${c.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !c.isActive })
      })
      fetchCustomers()
      if (detailCustomer?.id === c.id) {
        setDetailCustomer((prev) => prev ? { ...prev, isActive: !c.isActive } : prev)
      }
    } catch { /* ignore */ }
  }

  // ─── Detail view ────────────────────────────────────────────────────────────

  if (detailLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 gap-2">
        <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
        Loading customer…
      </div>
    )
  }

  if (detailCustomer) {
    const c = detailCustomer
    const creditLimit = credit ? credit.customer.creditLimit : num(c.creditLimit)
    const creditDays = credit ? credit.customer.creditDays : num(c.creditDays)
    const owed = credit?.outstanding ?? 0
    const openBills = credit?.bills ?? []
    // Ageing summary — only the buckets that actually carry money.
    const bucketTotals = AGE_BUCKETS
      .map((b) => ({
        bucket: b,
        amount: round2(openBills.filter((x) => x.ageBucket === b).reduce((s, x) => s + x.balanceDue, 0))
      }))
      .filter((x) => x.amount > 0)

    return (
      <div className="space-y-6">
        {/* Back + header */}
        <div className="flex items-center gap-4 border-b pb-4">
          <button
            type="button"
            onClick={closeDetail}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-zinc-900 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" /> Back to Customers
          </button>
        </div>

        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-zinc-900 flex items-center justify-center text-white text-2xl font-bold uppercase shrink-0">
              {c.name.charAt(0)}
            </div>
            <div>
              <h2 className="text-2xl font-bold text-zinc-900">{c.name}</h2>
              <p className="text-sm text-zinc-500 font-mono mt-0.5">{formatPhone(c.phone)}</p>
              {!c.isActive && (
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-600 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full mt-1">
                  <UserX className="w-3 h-3" /> Inactive
                </span>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={() => setShowPayment(true)}
              disabled={openBills.length === 0}
              title={openBills.length === 0 ? 'Nothing outstanding to collect' : 'Collect money against open bills'}
              className="gap-2 h-9 text-sm"
            >
              <HandCoins className="w-4 h-4" /> Record payment
            </Button>
            <Button variant="outline" onClick={() => openEdit(c)} className="gap-2 h-9 text-sm">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button
              variant="outline"
              onClick={() => toggleActive(c)}
              className={`gap-2 h-9 text-sm ${c.isActive ? 'text-red-600 border-red-200 hover:bg-red-50' : 'text-emerald-600 border-emerald-200 hover:bg-emerald-50'}`}
            >
              {c.isActive ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
              {c.isActive ? 'Deactivate' : 'Activate'}
            </Button>
          </div>
        </div>

        {/* Info grid */}
        <div className="grid grid-cols-2 gap-4">
          {[
            { icon: <Phone className="w-4 h-4" />, label: 'Phone', value: formatPhone(c.phone) },
            { icon: <Mail className="w-4 h-4" />, label: 'Email', value: c.email || '—' },
            { icon: <MapPin className="w-4 h-4" />, label: 'Address', value: c.address || '—' },
            { icon: <Building2 className="w-4 h-4" />, label: 'GSTIN', value: c.gstin || '—' },
          ].map(({ icon, label, value }) => (
            <div key={label} className="bg-zinc-50 rounded-xl border p-4 flex items-start gap-3">
              <span className="text-zinc-400 mt-0.5 shrink-0">{icon}</span>
              <div>
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-0.5">{label}</p>
                <p className="text-sm text-zinc-800 font-medium">{value}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ─── Outstanding ───────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Wallet className="w-4 h-4 text-zinc-500" />
            <h3 className="font-bold text-zinc-900">Outstanding</h3>
            {credit?.overLimit && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                <AlertTriangle className="w-3 h-3" /> Over credit limit
              </span>
            )}
            {creditLoading && (
              <span className="w-3.5 h-3.5 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className={`rounded-xl border p-4 ${credit?.overLimit ? 'bg-red-50 border-red-200' : 'bg-zinc-50'}`}>
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Outstanding</p>
              <p className={`text-xl font-bold ${owed > 0 ? 'text-red-600' : 'text-zinc-900'}`}>₹{fmt(owed)}</p>
            </div>
            <div className="rounded-xl border p-4 bg-zinc-50">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Credit limit</p>
              <p className="text-xl font-bold text-zinc-900">₹{fmt(creditLimit)}</p>
              <p className="text-xs text-zinc-500 mt-0.5">
                {creditLimit <= 0
                  ? 'No credit allowed'
                  : creditDays > 0 ? `Due in ${creditDays} day${creditDays === 1 ? '' : 's'}` : 'Due immediately'}
              </p>
            </div>
            <div className="rounded-xl border p-4 bg-zinc-50">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-1">Available credit</p>
              <p className="text-xl font-bold text-emerald-700">₹{fmt(credit?.availableCredit ?? 0)}</p>
            </div>
          </div>

          {bucketTotals.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {bucketTotals.map(({ bucket, amount }) => (
                <span
                  key={bucket}
                  className={`text-xs font-semibold px-2.5 py-1 rounded-full border ${BUCKET_CLASS[bucket]}`}
                >
                  {BUCKET_LABEL[bucket]}: ₹{fmt(amount)}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3">
            {openBills.length === 0 ? (
              <div className="rounded-xl border-2 border-dashed p-6 text-center text-zinc-400 text-sm">
                {creditLoading ? 'Checking balances…' : 'Nothing outstanding — this account is settled.'}
              </div>
            ) : (
              <div className="rounded-xl border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Bill #</th>
                      <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Date</th>
                      <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Due</th>
                      <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Age</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Total</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Paid</th>
                      <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {openBills.map((b) => (
                      <tr
                        key={b.id}
                        onClick={() => setOpenBillId(b.id)}
                        className="hover:bg-zinc-50 cursor-pointer transition-colors"
                        title="View items, refund or replace"
                      >
                        <td className="px-4 py-3 font-mono font-semibold text-zinc-900 text-sm">{b.billNumber}</td>
                        <td className="px-4 py-3 text-zinc-600 text-xs">{shortDate(b.paidAt)}</td>
                        <td className="px-4 py-3 text-zinc-600 text-xs">
                          {b.dueDate ? shortDate(b.dueDate) : <span className="text-zinc-300">—</span>}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${BUCKET_CLASS[b.ageBucket]}`}>
                            {b.ageBucket === 'current'
                              ? BUCKET_LABEL.current
                              : `${b.daysOverdue} day${b.daysOverdue === 1 ? '' : 's'} overdue`}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right text-zinc-600">₹{fmt(b.totalAmount)}</td>
                        <td className="px-4 py-3 text-right text-zinc-600">₹{fmt(b.paidAmount)}</td>
                        <td className="px-4 py-3 text-right font-bold text-red-600">₹{fmt(b.balanceDue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ─── Payment history ───────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <HandCoins className="w-4 h-4 text-zinc-500" />
            <h3 className="font-bold text-zinc-900">Payment History</h3>
            <span className="text-xs text-zinc-400">(last 25)</span>
          </div>
          {payments.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed p-6 text-center text-zinc-400 text-sm">
              No payments recorded for this customer yet.
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Date</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Amount</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Method</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Reference</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Bill</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Taken</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">By</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {payments.map((p) => (
                    <tr key={p.id} className="hover:bg-zinc-50 transition-colors">
                      <td className="px-4 py-3 text-zinc-600 text-xs">
                        {new Date(p.receivedAt).toLocaleString('en-IN', {
                          day: '2-digit', month: 'short', year: 'numeric',
                          hour: '2-digit', minute: '2-digit'
                        })}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-emerald-700">₹{fmt(num(p.amount))}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700">
                          {PM_LABEL[p.method] ?? p.method}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-500 font-mono text-xs">
                        {p.reference || <span className="text-zinc-300">—</span>}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-zinc-700">
                        {p.bill?.billNumber ?? <span className="text-zinc-300">—</span>}
                      </td>
                      <td className="px-4 py-3">
                        {/* Tender handed over at the counter vs money chased later. */}
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${
                          p.isSettlement
                            ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                            : 'bg-zinc-100 text-zinc-600 border-zinc-200'
                        }`}>
                          {p.isSettlement ? 'Collected later' : 'At the till'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-zinc-600 text-xs">
                        {p.collectedBy?.username ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ─── Follow-ups ────────────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <StickyNote className="w-4 h-4 text-zinc-500" />
            <h3 className="font-bold text-zinc-900">Follow-ups</h3>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <div className="flex gap-2 p-3 border-b bg-zinc-50">
              <Input
                value={fuNote}
                onChange={(e) => { setFuNote(e.target.value); setFuError('') }}
                onKeyDown={(e) => { if (e.key === 'Enter') addFollowUp() }}
                placeholder="e.g. Called about overdue balance, will pay Friday"
                className="h-9 text-sm flex-1"
              />
              <Input
                type="date"
                value={fuDue}
                onChange={(e) => setFuDue(e.target.value)}
                className="h-9 text-sm w-40"
                title="Optional due date"
              />
              <Button onClick={addFollowUp} disabled={fuSaving} className="h-9 text-sm gap-1.5 shrink-0">
                <Plus className="w-3.5 h-3.5" /> Add
              </Button>
            </div>
            {fuError && <p className="px-3 py-2 text-xs text-red-600 border-b">{fuError}</p>}
            {followUps.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-zinc-400">No follow-ups yet.</p>
            ) : (
              <ul className="divide-y">
                {followUps.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 px-4 py-3">
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm ${f.resolvedAt ? 'text-zinc-400 line-through' : 'text-zinc-800'}`}>
                        {f.note}
                      </p>
                      <p className="text-xs text-zinc-400 mt-0.5 flex items-center gap-2 flex-wrap">
                        {f.dueAt && (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="w-3 h-3" /> Due {shortDate(f.dueAt)}
                          </span>
                        )}
                        <span>Added {shortDate(f.createdAt)}</span>
                        {f.createdBy?.username && <span>by {f.createdBy.username}</span>}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFollowUpResolved(f, !f.resolvedAt)}
                      className={`shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-md border transition-colors ${
                        f.resolvedAt
                          ? 'text-zinc-500 border-zinc-200 hover:bg-zinc-50'
                          : 'text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                      }`}
                    >
                      {f.resolvedAt
                        ? <><Undo2 className="w-3 h-3" /> Reopen</>
                        : <><Check className="w-3 h-3" /> Resolve</>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Bill history */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <Receipt className="w-4 h-4 text-zinc-500" />
            <h3 className="font-bold text-zinc-900">Recent Bills</h3>
            <span className="text-xs text-zinc-400">(last 10)</span>
          </div>
          {c.bills.length === 0 ? (
            <div className="rounded-xl border-2 border-dashed p-8 text-center text-zinc-400 text-sm">
              No bills yet for this customer.
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Bill #</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Date</th>
                    <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Payment</th>
                    <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Total</th>
                    <th className="text-center px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {c.bills.map((b) => (
                    <tr
                      key={b.id}
                      onClick={() => setOpenBillId(b.id)}
                      className="hover:bg-zinc-50 cursor-pointer transition-colors"
                      title="View items, refund or replace"
                    >
                      <td className="px-4 py-3 font-mono font-semibold text-zinc-900 text-sm">{b.billNumber}</td>
                      <td className="px-4 py-3 text-zinc-600 text-xs">{shortDate(b.paidAt)}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-700">
                          {PM_LABEL[b.paymentMethod] ?? b.paymentMethod}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-zinc-900">₹{fmt(b.totalAmount)}</td>
                      <td className="px-4 py-3 text-center">
                        <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                          b.status === 'PAID'
                            ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : b.status === 'RETURN'
                              ? 'bg-amber-50 text-amber-700 border border-amber-200'
                              : b.status === 'PARTIAL' || b.status === 'CREDIT'
                                ? 'bg-orange-50 text-orange-700 border border-orange-200'
                                : 'bg-red-50 text-red-600 border border-red-200'
                        }`}>
                          {b.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Edit modal rendered in detail view too */}
        <CustomerFormModal
          open={showModal}
          editingId={editingId}
          form={form}
          formError={formError}
          fieldErrors={fieldErrors}
          fieldRefs={fieldRefs}
          saving={saving}
          canSetCreditTerms={canSetCreditTerms}
          onClose={() => setShowModal(false)}
          onSave={handleSave}
          onFieldChange={setField}
          onBlurField={blurField}
        />

        {/* Collect money against the open bills */}
        <RecordPaymentModal
          open={showPayment}
          customerId={c.id}
          customerName={c.name}
          bills={openBills}
          outstanding={owed}
          token={token}
          onClose={() => setShowPayment(false)}
          onDone={() => { refreshDetail(); fetchCustomers() }}
        />

        {/* Bill drill-down: items + per-line refund / replace */}
        <BillDetailViewer
          open={openBillId !== null}
          billId={openBillId}
          token={token}
          shopInfo={shopInfo}
          onClose={() => setOpenBillId(null)}
          onMutated={refreshDetail}
        />
      </div>
    )
  }

  // ─── List view ──────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users className="w-6 h-6" /> Customers
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {owesOnly
              ? `${customers.length} customer${customers.length !== 1 ? 's' : ''} owe money`
              : `${total} customer${total !== 1 ? 's' : ''} total`}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchCustomers} className="gap-2 h-9 text-sm">
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </Button>
          <Button onClick={openAdd} className="gap-2 h-9 text-sm">
            <Plus className="w-4 h-4" /> Add Customer
          </Button>
        </div>
      </div>

      {/* Search + debtor filter */}
      <div className="flex items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="pl-9 h-9 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => { setOwesOnly((v) => !v); setPage(1) }}
          className={`inline-flex items-center gap-2 h-9 px-3 rounded-md border text-sm font-medium transition-colors ${
            owesOnly
              ? 'bg-red-50 border-red-200 text-red-700'
              : 'bg-background border-input text-zinc-600 hover:bg-zinc-50'
          }`}
          title="Show only customers with a balance still owing"
        >
          <Wallet className="w-4 h-4" /> Owes money
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>
      )}

      {/* Table */}
      <div className="rounded-xl border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 border-b">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Name</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Phone</th>
              <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Outstanding</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Email</th>
              <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">GSTIN</th>
              <th className="text-center px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase tracking-wide">Bills</th>
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
            {!loading && customers.length === 0 && (
              <tr>
                <td colSpan={8}>
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
                    <Users className="w-10 h-10 text-zinc-300" />
                    <p className="text-sm font-medium">
                      {owesOnly
                        ? 'Nobody owes money right now'
                        : search ? 'No customers match your search' : 'No customers yet'}
                    </p>
                    {!search && !owesOnly && (
                      <Button onClick={openAdd} variant="outline" className="gap-2 text-sm mt-1">
                        <Plus className="w-4 h-4" /> Add First Customer
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {!loading && customers.map((c) => {
              const owed = num(c.outstanding)
              const limit = num(c.creditLimit)
              // Matches the server's own test: anything above the limit — which
              // includes any balance at all when no credit was granted.
              const over = owed > limit
              return (
                <tr
                  key={c.id}
                  onClick={() => openDetail(c.id)}
                  className={`cursor-pointer hover:bg-zinc-50 transition-colors ${!c.isActive ? 'opacity-50' : ''}`}
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-zinc-900 flex items-center justify-center text-white text-xs font-bold uppercase shrink-0">
                        {c.name.charAt(0)}
                      </div>
                      <span className="font-semibold text-zinc-900">{c.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-zinc-600 text-xs">{formatPhone(c.phone)}</td>
                  <td className="px-4 py-3 text-right">
                    {owed <= 0 ? (
                      <span className="text-zinc-300">—</span>
                    ) : (
                      <span
                        className={`inline-flex items-center gap-1 text-xs font-bold px-2 py-0.5 rounded-full border ${
                          over
                            ? 'bg-red-50 text-red-700 border-red-200'
                            : 'bg-amber-50 text-amber-700 border-amber-200'
                        }`}
                        title={over
                          ? `Over the ₹${fmt(limit)} credit limit`
                          : `₹${fmt(Math.max(0, limit - owed))} of credit left`}
                      >
                        {over && <AlertTriangle className="w-3 h-3" />}
                        ₹{fmt(owed)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">{c.email || <span className="text-zinc-300">—</span>}</td>
                  <td className="px-4 py-3 text-zinc-500 font-mono text-xs">{c.gstin || <span className="text-zinc-300">—</span>}</td>
                  <td className="px-4 py-3 text-center">
                    <span className="text-xs font-semibold text-zinc-700 bg-zinc-100 rounded-full px-2 py-0.5">
                      {c._count?.bills ?? 0}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <span className={`text-xs font-semibold px-2.5 py-0.5 rounded-full ${
                      c.isActive
                        ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                        : 'bg-zinc-100 text-zinc-500 border border-zinc-200'
                    }`}>
                      {c.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={(e) => openEdit(c, e)}
                        className="w-7 h-7 rounded-md flex items-center justify-center text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
                        title="Edit"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => toggleActive(c, e)}
                        className={`w-7 h-7 rounded-md flex items-center justify-center transition-colors ${
                          c.isActive
                            ? 'text-zinc-400 hover:bg-red-50 hover:text-red-500'
                            : 'text-zinc-400 hover:bg-emerald-50 hover:text-emerald-600'
                        }`}
                        title={c.isActive ? 'Deactivate' : 'Activate'}
                      >
                        {c.isActive ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination — the debtor scan is a single wide page, so it has none. */}
      {totalPages > 1 && !search && !owesOnly && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500">Page {page} of {totalPages}</p>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="h-8 w-8 p-0">
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="h-8 w-8 p-0">
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      <CustomerFormModal
        open={showModal}
        editingId={editingId}
        form={form}
        formError={formError}
        fieldErrors={fieldErrors}
        fieldRefs={fieldRefs}
        saving={saving}
        canSetCreditTerms={canSetCreditTerms}
        onClose={() => setShowModal(false)}
        onSave={handleSave}
        onFieldChange={setField}
        onBlurField={blurField}
      />
    </div>
  )
}

// ─── CustomerFormModal ────────────────────────────────────────────────────────

function CustomerFormModal({
  open, editingId, form, formError, fieldErrors, fieldRefs, saving, canSetCreditTerms,
  onClose, onSave, onFieldChange, onBlurField
}: {
  open: boolean
  editingId: string | null
  form: CustomerForm
  formError: string
  fieldErrors: FieldErrors
  fieldRefs: React.MutableRefObject<Partial<Record<ValidatedField, HTMLInputElement | null>>>
  saving: boolean
  canSetCreditTerms: boolean
  onClose: () => void
  onSave: () => void
  onFieldChange: (field: keyof CustomerForm, value: string) => void
  onBlurField: (field: ValidatedField) => void
}) {
  const set = (field: keyof CustomerForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    onFieldChange(field, e.target.value)

  const hasErrors = Object.keys(fieldErrors).length > 0
  const errorClass = (field: ValidatedField) =>
    fieldErrors[field] ? ' border-red-300 focus-visible:ring-red-400' : ''
  const FieldError = ({ field }: { field: ValidatedField }) =>
    fieldErrors[field] ? <p className="mt-1 text-xs text-red-600">{fieldErrors[field]}</p> : null

  return (
    <Modal open={open} onClose={onClose} title={editingId ? 'Edit Customer' : 'Add Customer'} size="sm">
      <div className="space-y-4">
        {formError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{formError}</div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-semibold mb-1">Name *</label>
            <Input
              ref={(el) => { fieldRefs.current.name = el }}
              value={form.name}
              onChange={set('name')}
              onBlur={() => onBlurField('name')}
              placeholder="Customer name"
              className={`h-9${errorClass('name')}`}
              autoFocus
            />
            <FieldError field="name" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold mb-1">Phone *</label>
            <Input
              ref={(el) => { fieldRefs.current.phone = el }}
              value={form.phone}
              onChange={set('phone')}
              onBlur={() => onBlurField('phone')}
              placeholder="98765 43210"
              className={`h-9 font-mono${errorClass('phone')}`}
            />
            <FieldError field="phone" />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">Email</label>
            <Input
              ref={(el) => { fieldRefs.current.email = el }}
              value={form.email}
              onChange={set('email')}
              onBlur={() => onBlurField('email')}
              placeholder="email@example.com"
              className={`h-9${errorClass('email')}`}
              type="email"
            />
            <FieldError field="email" />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">GSTIN</label>
            <Input
              ref={(el) => { fieldRefs.current.gstin = el }}
              value={form.gstin}
              onChange={(e) => onFieldChange('gstin', e.target.value.toUpperCase())}
              onBlur={() => onBlurField('gstin')}
              placeholder="27ABCDE1234F1Z0"
              className={`h-9 font-mono uppercase${errorClass('gstin')}`}
            />
            <FieldError field="gstin" />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-semibold mb-1">Address</label>
            <Input value={form.address} onChange={set('address')} placeholder="Street, City" className="h-9" />
          </div>

          {/* Credit terms — super-admin only; a cashier never sees these and the
              server refuses them anyway with 403 CREDIT_TERMS_FORBIDDEN. */}
          {canSetCreditTerms && (
            <>
              <div className="col-span-2 pt-1 border-t">
                <p className="text-xs font-bold text-zinc-700 uppercase tracking-wide mt-3">Credit terms</p>
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Credit limit (₹)</label>
                <Input
                  ref={(el) => { fieldRefs.current.creditLimit = el }}
                  value={form.creditLimit}
                  onChange={set('creditLimit')}
                  onBlur={() => onBlurField('creditLimit')}
                  placeholder="0"
                  inputMode="decimal"
                  className={`h-9 font-mono${errorClass('creditLimit')}`}
                />
                <FieldError field="creditLimit" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1">Credit days</label>
                <Input
                  ref={(el) => { fieldRefs.current.creditDays = el }}
                  value={form.creditDays}
                  onChange={set('creditDays')}
                  onBlur={() => onBlurField('creditDays')}
                  placeholder="0"
                  inputMode="numeric"
                  className={`h-9 font-mono${errorClass('creditDays')}`}
                />
                <FieldError field="creditDays" />
              </div>
              <p className="col-span-2 text-xs text-zinc-500">
                The most this customer may owe at once. A limit of <strong>0</strong> means they
                cannot buy on credit at all. Credit days set how long a balance has before it
                counts as overdue — 0 means it is due straight away.
              </p>
            </>
          )}
        </div>
        <div className="flex gap-3 justify-end pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={onSave} disabled={saving || hasErrors}>
            {saving ? (
              <span className="flex items-center gap-2">
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Saving…
              </span>
            ) : editingId ? 'Save Changes' : 'Add Customer'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ─── RecordPaymentModal ───────────────────────────────────────────────────────

/**
 * Collects money against a customer's open bills.
 *
 * The default is what a shop actually does — hand over cash, clear the oldest
 * bill first — which the server does for us when no allocations are sent.
 * Picking bills by hand is for the customer who says "this is for invoice 42",
 * and then the allocations have to add up exactly, so we check that here
 * before the money leaves the till rather than bouncing off a 409.
 */
function RecordPaymentModal({
  open, customerId, customerName, bills, outstanding, token, onClose, onDone
}: {
  open: boolean
  customerId: string
  customerName: string
  bills: OutstandingBill[]
  outstanding: number
  token: string | null
  onClose: () => void
  onDone: () => void
}) {
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('CASH')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [pickBills, setPickBills] = useState(false)
  const [alloc, setAlloc] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  // Fresh state every time the modal opens — a stale amount is dangerous here.
  useEffect(() => {
    if (!open) return
    setAmount('')
    setMethod('CASH')
    setReference('')
    setNote('')
    setPickBills(false)
    setAlloc({})
    setError('')
    setSaving(false)
  }, [open])

  const amountNum = round2(Number(amount) || 0)
  const allocated = round2(
    bills.reduce((s, b) => s + (Number(alloc[b.id]) || 0), 0)
  )
  const overAllocated = bills.filter((b) => (Number(alloc[b.id]) || 0) > b.balanceDue)

  /** Spreads the entered amount over the oldest bills first, same as the server. */
  const autoFill = () => {
    let left = amountNum
    const next: Record<string, string> = {}
    for (const b of bills) {
      if (left <= 0) break
      const take = round2(Math.min(b.balanceDue, left))
      if (take <= 0) continue
      next[b.id] = String(take)
      left = round2(left - take)
    }
    setAlloc(next)
  }

  let clientError = ''
  if (amountNum <= 0) clientError = 'Enter an amount greater than zero.'
  else if (!pickBills && amountNum > round2(outstanding)) {
    clientError = `That is more than the ₹${fmt(outstanding)} this customer owes.`
  } else if (pickBills && overAllocated.length > 0) {
    clientError = `Bill ${overAllocated[0].billNumber} only owes ₹${fmt(overAllocated[0].balanceDue)}.`
  } else if (pickBills && allocated !== amountNum) {
    clientError = `Allocated ₹${fmt(allocated)} of ₹${fmt(amountNum)} — they have to match.`
  }

  const submit = async () => {
    if (clientError) {
      setError(clientError)
      return
    }
    setSaving(true)
    setError('')
    try {
      const body: Record<string, unknown> = {
        customerId,
        amount: amountNum,
        method,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined
      }
      if (pickBills) {
        body.allocations = bills
          .filter((b) => (Number(alloc[b.id]) || 0) > 0)
          .map((b) => ({ billId: b.id, amount: round2(Number(alloc[b.id])) }))
      }
      await apiFetch('/api/v1/payments', token, { method: 'POST', body: JSON.stringify(body) })
      onDone()
      onClose()
    } catch (err: unknown) {
      const e = err as { data?: { message?: string; error?: string } }
      setError(e.data?.message || 'Failed to record the payment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={`Record Payment — ${customerName}`} size="md">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">{error}</div>
        )}

        <div className="flex items-center justify-between rounded-lg border bg-zinc-50 px-4 py-3">
          <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Outstanding</span>
          <span className="text-lg font-bold text-red-600">₹{fmt(outstanding)}</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold mb-1">Amount collected *</label>
            <div className="flex gap-2">
              <Input
                value={amount}
                onChange={(e) => { setAmount(e.target.value); setError('') }}
                placeholder="0.00"
                inputMode="decimal"
                className="h-9 font-mono"
                autoFocus
              />
              <Button
                type="button"
                variant="outline"
                className="h-9 text-xs shrink-0"
                onClick={() => { setAmount(String(round2(outstanding))); setError('') }}
                title="Settle the whole balance"
              >
                All
              </Button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">Method *</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value as PaymentMethod)}
              className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>{PM_LABEL[m] ?? m}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">Reference</label>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="UPI ref / cheque no."
              className="h-9 font-mono"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold mb-1">Note</label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional"
              className="h-9"
            />
          </div>
        </div>

        {/* Allocation */}
        <div className="rounded-lg border overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 border-b">
            <label className="flex items-center gap-2 text-xs font-semibold text-zinc-700">
              <input
                type="checkbox"
                checked={pickBills}
                onChange={(e) => { setPickBills(e.target.checked); setAlloc({}); setError('') }}
              />
              Choose which bills this pays off
            </label>
            {pickBills ? (
              <div className="flex items-center gap-2">
                <span className={`text-xs font-mono ${allocated === amountNum ? 'text-emerald-700' : 'text-zinc-500'}`}>
                  ₹{fmt(allocated)} / ₹{fmt(amountNum)}
                </span>
                <Button type="button" variant="outline" className="h-7 text-xs" onClick={autoFill}>
                  Fill oldest first
                </Button>
              </div>
            ) : (
              <span className="text-xs text-zinc-500">Settling oldest bill first</span>
            )}
          </div>

          <table className="w-full text-sm">
            <thead className="bg-white border-b">
              <tr>
                <th className="text-left px-3 py-2 font-semibold text-zinc-600 text-xs uppercase">Bill #</th>
                <th className="text-left px-3 py-2 font-semibold text-zinc-600 text-xs uppercase">Date</th>
                <th className="text-left px-3 py-2 font-semibold text-zinc-600 text-xs uppercase">Age</th>
                <th className="text-right px-3 py-2 font-semibold text-zinc-600 text-xs uppercase">Balance</th>
                {pickBills && (
                  <th className="text-right px-3 py-2 font-semibold text-zinc-600 text-xs uppercase w-32">Allocate</th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y">
              {bills.length === 0 && (
                <tr>
                  <td colSpan={pickBills ? 5 : 4} className="px-3 py-6 text-center text-zinc-400 text-sm">
                    Nothing outstanding.
                  </td>
                </tr>
              )}
              {bills.map((b) => {
                const over = (Number(alloc[b.id]) || 0) > b.balanceDue
                return (
                  <tr key={b.id}>
                    <td className="px-3 py-2 font-mono font-semibold text-zinc-900 text-xs">{b.billNumber}</td>
                    <td className="px-3 py-2 text-zinc-600 text-xs">{shortDate(b.paidAt)}</td>
                    <td className="px-3 py-2">
                      <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${BUCKET_CLASS[b.ageBucket]}`}>
                        {b.ageBucket === 'current' ? BUCKET_LABEL.current : `${b.daysOverdue}d overdue`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-semibold text-zinc-900 text-xs">₹{fmt(b.balanceDue)}</td>
                    {pickBills && (
                      <td className="px-3 py-2">
                        <Input
                          value={alloc[b.id] ?? ''}
                          onChange={(e) => {
                            const v = e.target.value
                            setAlloc((prev) => ({ ...prev, [b.id]: v }))
                            setError('')
                          }}
                          placeholder="0.00"
                          inputMode="decimal"
                          className={`h-8 text-xs font-mono text-right${over ? ' border-red-300 focus-visible:ring-red-400' : ''}`}
                        />
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {clientError && !error && (
          <p className="text-xs text-zinc-500">{clientError}</p>
        )}

        <div className="flex gap-3 justify-end pt-1">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !!clientError}>
            {saving ? (
              <span className="flex items-center gap-2">
                <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Recording…
              </span>
            ) : 'Record Payment'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
