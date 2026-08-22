import React, { useState, useEffect, useCallback, useRef } from 'react'
import {
  Users, Plus, Search, ChevronLeft, Edit2, RefreshCw,
  Phone, Mail, MapPin, Building2, Receipt, ChevronRight,
  ToggleLeft, ToggleRight, UserX,
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
}

type Props = { token: string | null }

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

const emptyForm = (): CustomerForm => ({ name: '', phone: '', email: '', address: '', gstin: '' })

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const PM_LABEL: Record<string, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card' }

// ─── Validation ───────────────────────────────────────────────────────────────

/** Fields we validate, in the order they appear in the form. */
type ValidatedField = 'name' | 'phone' | 'email' | 'gstin'

const FIELD_ORDER: ValidatedField[] = ['name', 'phone', 'email', 'gstin']

const VALIDATORS: Record<ValidatedField, (v: string) => FieldResult> = {
  name: (v) => validateName(v, 'Customer name'),
  phone: (v) => validateMobile(v),
  email: (v) => validateEmail(v),
  gstin: (v) => validateGstin(v)
}

type FieldErrors = Partial<Record<ValidatedField, string>>

/** Maps a server error code onto the field it belongs to, when that's obvious. */
function fieldForCode(code: string | undefined): ValidatedField | null {
  if (!code) return null
  if (code.startsWith('PHONE_')) return 'phone'   // incl. PHONE_ALREADY_EXISTS
  if (code.startsWith('GSTIN_')) return 'gstin'
  if (code.startsWith('EMAIL_')) return 'email'
  if (code.startsWith('NAME_')) return 'name'
  return null
}

/** Fallbacks for server codes that predate the shared `message` field. */
const CODE_FALLBACK: Record<string, string> = {
  PHONE_ALREADY_EXISTS: 'A customer with this phone number already exists.'
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CustomersScreen({ token }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Detail view
  const [detailCustomer, setDetailCustomer] = useState<CustomerDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

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
        limit: String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE)
      })
      const q = debouncedSearch.trim()
      // Phones are displayed grouped ("98765 43210"), so a pasted number has to
      // be reduced back to bare digits before it will match server-side.
      if (q) params.set('search', /^[+\d\s-]+$/.test(q) ? normalizePhone(q) : q)
      const data = await apiFetch<{ customers: Customer[]; total: number }>(
        `/api/v1/customers?${params}`,
        token
      )
      setCustomers(data.customers)
      setTotal(data.total)
    } catch {
      setError('Failed to load customers.')
    } finally {
      setLoading(false)
    }
  }, [token, page, debouncedSearch])

  useEffect(() => { fetchCustomers() }, [fetchCustomers])

  // ─── Detail view ────────────────────────────────────────────────────────────

  const openDetail = async (id: string) => {
    setDetailLoading(true)
    setDetailCustomer(null)
    try {
      const data = await apiFetch<{ customer: CustomerDetail }>(`/api/v1/customers/${id}`, token)
      setDetailCustomer(data.customer)
    } catch {
      // ignore
    } finally {
      setDetailLoading(false)
    }
  }

  // Refetch the currently-open customer (e.g. after a refund or exchange so the
  // bill list reflects the new RETURN bill).
  const refreshDetail = async (): Promise<void> => {
    if (!detailCustomer) return
    try {
      const data = await apiFetch<{ customer: CustomerDetail }>(`/api/v1/customers/${detailCustomer.id}`, token)
      setDetailCustomer(data.customer)
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
      gstin: c.gstin ?? ''
    })
    setFormError('')
    setFieldErrors({})
    setShowModal(true)
  }

  // ─── Field-level validation ─────────────────────────────────────────────────

  /** Typing never blocks, but a field already showing an error re-checks live. */
  const setField = (key: keyof CustomerForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    if (key === 'address') return
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
    const errors: FieldErrors = {}
    const values = {} as Record<ValidatedField, string>
    for (const field of FIELD_ORDER) {
      const r = VALIDATORS[field](form[field])
      if (r.ok) values[field] = r.value
      else errors[field] = r.message
    }
    setFieldErrors(errors)
    const firstBad = FIELD_ORDER.find((f) => errors[f])
    if (firstBad) {
      setFormError('')
      focusField(firstBad)
      return
    }

    setSaving(true)
    setFormError('')
    try {
      // Send the normalized values, not the raw input.
      const body = {
        name: values.name,
        phone: values.phone,
        email: values.email || null,
        address: form.address.trim() || null,
        gstin: values.gstin || null
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
    return (
      <div className="space-y-6">
        {/* Back + header */}
        <div className="flex items-center gap-4 border-b pb-4">
          <button
            type="button"
            onClick={() => setDetailCustomer(null)}
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
                      <td className="px-4 py-3 text-zinc-600 text-xs">
                        {new Date(b.paidAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </td>
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
          onClose={() => setShowModal(false)}
          onSave={handleSave}
          onFieldChange={setField}
          onBlurField={blurField}
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
            {total} customer{total !== 1 ? 's' : ''} total
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

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or phone…"
          className="pl-9 h-9 text-sm"
        />
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
                <td colSpan={7} className="text-center py-16 text-zinc-400">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
                    Loading…
                  </div>
                </td>
              </tr>
            )}
            {!loading && customers.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="flex flex-col items-center justify-center py-16 text-zinc-400 gap-3">
                    <Users className="w-10 h-10 text-zinc-300" />
                    <p className="text-sm font-medium">{search ? 'No customers match your search' : 'No customers yet'}</p>
                    {!search && (
                      <Button onClick={openAdd} variant="outline" className="gap-2 text-sm mt-1">
                        <Plus className="w-4 h-4" /> Add First Customer
                      </Button>
                    )}
                  </div>
                </td>
              </tr>
            )}
            {!loading && customers.map((c) => (
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
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && !search && (
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
  open, editingId, form, formError, fieldErrors, fieldRefs, saving,
  onClose, onSave, onFieldChange, onBlurField
}: {
  open: boolean
  editingId: string | null
  form: CustomerForm
  formError: string
  fieldErrors: FieldErrors
  fieldRefs: React.MutableRefObject<Partial<Record<ValidatedField, HTMLInputElement | null>>>
  saving: boolean
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
