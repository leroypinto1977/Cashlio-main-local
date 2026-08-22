import React, { useState, useEffect, useCallback, useRef } from 'react'
import { Truck, Plus, Search, Edit2, Trash2, Phone, Mail, Building2, RefreshCw } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'
import {
  validateName, validateContactNumber, validateEmail, validateGstin,
  formatPhone, normalizePhone, type FieldResult
} from '@shared/validation'

// ─── Types ────────────────────────────────────────────────────────────────────

type Supplier = {
  id: string
  name: string
  contactPerson: string | null
  phone: string
  email: string | null
  address: string | null
  gstin: string | null
  isActive: boolean
}

type SupplierForm = {
  name: string
  contactPerson: string
  phone: string
  email: string
  address: string
  gstin: string
  isActive: boolean
}

const emptyForm = (): SupplierForm => ({
  name: '', contactPerson: '', phone: '', email: '',
  address: '', gstin: '', isActive: true
})

// ─── Validation ───────────────────────────────────────────────────────────────

/** Text fields the user can edit (everything except the isActive checkbox). */
type SupplierTextField = 'name' | 'contactPerson' | 'phone' | 'email' | 'address' | 'gstin'

/** Fields we validate, in the order they appear in the form. */
type ValidatedField = 'name' | 'contactPerson' | 'phone' | 'email' | 'gstin'

const FIELD_ORDER: ValidatedField[] = ['name', 'contactPerson', 'phone', 'email', 'gstin']

const VALIDATORS: Record<ValidatedField, (v: string) => FieldResult> = {
  name: (v) => validateName(v, 'Supplier name'),
  contactPerson: (v) => validateName(v, 'Contact person', { required: false }),
  phone: (v) => validateContactNumber(v),
  email: (v) => validateEmail(v),
  gstin: (v) => validateGstin(v)
}

type FieldErrors = Partial<Record<ValidatedField, string>>

/** Maps a server error code onto the field it belongs to, when that's obvious. */
function fieldForCode(code: string | undefined): ValidatedField | null {
  if (!code) return null
  if (code.startsWith('PHONE_')) return 'phone'
  if (code.startsWith('GSTIN_')) return 'gstin'
  if (code.startsWith('EMAIL_')) return 'email'
  if (code.startsWith('NAME_')) return 'name'
  return null
}

// ─── SuppliersScreen ──────────────────────────────────────────────────────────

export function SuppliersScreen({ token }: { token: string | null }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [formData, setFormData] = useState<SupplierForm>(emptyForm())
  const [formError, setFormError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [formLoading, setFormLoading] = useState(false)
  const fieldRefs = useRef<Partial<Record<ValidatedField, HTMLInputElement | null>>>({})

  const loadSuppliers = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<{ suppliers: Supplier[] }>('/api/v1/suppliers', token)
      setSuppliers(data.suppliers)
    } catch {
      setError('Failed to load suppliers.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { loadSuppliers() }, [loadSuppliers])

  const searchDigits = normalizePhone(search)
  const filtered = suppliers.filter(
    (s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.phone.includes(search) ||
      (!!searchDigits && s.phone.includes(searchDigits)) ||
      (s.contactPerson || '').toLowerCase().includes(search.toLowerCase())
  )

  const openAdd = () => {
    setEditingId(null)
    setFormData(emptyForm())
    setFormError('')
    setFieldErrors({})
    setShowForm(true)
  }

  const openEdit = (s: Supplier) => {
    setEditingId(s.id)
    setFormData({
      name: s.name,
      contactPerson: s.contactPerson || '',
      phone: s.phone,
      email: s.email || '',
      address: s.address || '',
      gstin: s.gstin || '',
      isActive: s.isActive
    })
    setFormError('')
    setFieldErrors({})
    setShowForm(true)
  }

  // ─── Field-level validation ─────────────────────────────────────────────────

  /** Typing never blocks, but a field already showing an error re-checks live. */
  const setField = (key: SupplierTextField, value: string) => {
    setFormData((f) => ({ ...f, [key]: value }))
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
    const r = VALIDATORS[field](formData[field])
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
      const r = VALIDATORS[field](formData[field])
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

    setFormLoading(true)
    setFormError('')
    // Send the normalized values, not the raw input.
    const body = {
      name: values.name,
      contactPerson: values.contactPerson || null,
      phone: values.phone,
      email: values.email || null,
      address: formData.address.trim() || null,
      gstin: values.gstin || null,
      isActive: formData.isActive
    }
    try {
      if (!editingId) {
        await apiFetch('/api/v1/suppliers', token, { method: 'POST', body: JSON.stringify(body) })
      } else {
        await apiFetch(`/api/v1/suppliers/${editingId}`, token, { method: 'PUT', body: JSON.stringify(body) })
      }
      setShowForm(false)
      await loadSuppliers()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      const message = e.data?.message
      const field = fieldForCode(e.data?.error)
      if (field && message) {
        setFieldErrors((prev) => ({ ...prev, [field]: message }))
        setFormError('')
        focusField(field)
      } else {
        setFormError(message || 'Failed to save supplier.')
      }
    } finally {
      setFormLoading(false)
    }
  }

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Delete this supplier?')) return
    try {
      await apiFetch(`/api/v1/suppliers/${id}`, token, { method: 'DELETE' })
      await loadSuppliers()
    } catch {
      alert('Failed to delete supplier.')
    }
  }

  const toggleActive = async (id: string, current: boolean, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await apiFetch(`/api/v1/suppliers/${id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !current })
      })
      await loadSuppliers()
    } catch {
      alert('Failed to update supplier.')
    }
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Truck className="w-6 h-6" /> Suppliers
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your product suppliers and their contact details.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={loadSuppliers} className="p-2 rounded-md hover:bg-zinc-100 transition-colors text-zinc-500">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Button onClick={openAdd} className="gap-2">
            <Plus className="w-4 h-4" /> Add Supplier
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-xs mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search by name, contact or phone..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9 h-10"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>
      )}

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
          <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin mr-3" /> Loading...
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600">Supplier</th>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600">Contact</th>
                <th className="text-left px-4 py-3 font-semibold text-zinc-600">GSTIN</th>
                <th className="text-center px-4 py-3 font-semibold text-zinc-600">Status</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground text-sm">
                    No suppliers found.
                  </td>
                </tr>
              ) : (
                filtered.map((s) => (
                  <tr key={s.id} className="hover:bg-zinc-50/70 transition-colors">
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-zinc-100 flex items-center justify-center shrink-0">
                          <Building2 className="w-4 h-4 text-zinc-500" />
                        </div>
                        <div>
                          <p className="font-medium text-zinc-900">{s.name}</p>
                          {s.address && (
                            <p className="text-xs text-muted-foreground mt-0.5 max-w-[200px] truncate">{s.address}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      {s.contactPerson && <p className="font-medium text-zinc-800">{s.contactPerson}</p>}
                      <div className="flex flex-col gap-0.5 mt-1">
                        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Phone className="w-3 h-3" /> {formatPhone(s.phone)}
                        </span>
                        {s.email && (
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <Mail className="w-3 h-3" /> {s.email}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <span className="font-mono text-xs text-muted-foreground">{s.gstin || '—'}</span>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <button
                        type="button"
                        onClick={(e) => toggleActive(s.id, s.isActive, e)}
                        className={`text-xs font-medium px-2.5 py-0.5 rounded-full border cursor-pointer transition-colors ${s.isActive ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100' : 'bg-zinc-100 text-zinc-500 border-zinc-200 hover:bg-zinc-200'}`}
                      >
                        {s.isActive ? 'Active' : 'Inactive'}
                      </button>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          type="button"
                          onClick={() => openEdit(s)}
                          className="p-1.5 rounded-md hover:bg-zinc-200 transition-colors text-zinc-400"
                          title="Edit"
                        >
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => handleDelete(s.id, e)}
                          className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 transition-colors text-zinc-400"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground mt-3">
        {filtered.length} supplier{filtered.length !== 1 ? 's' : ''}
        {search ? ` (filtered from ${suppliers.length})` : ''}
        {' · '}
        {suppliers.filter((s) => s.isActive).length} active
      </p>

      {/* Add/Edit Modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title={editingId ? 'Edit Supplier' : 'Add Supplier'}
        size="md"
      >
        <SupplierFormFields
          form={formData}
          onFieldChange={setField}
          onToggleActive={(v) => setFormData((f) => ({ ...f, isActive: v }))}
          onBlurField={blurField}
          fieldErrors={fieldErrors}
          fieldRefs={fieldRefs}
          error={formError}
          loading={formLoading}
          onSave={handleSave}
          onCancel={() => setShowForm(false)}
        />
      </Modal>
    </div>
  )
}

// ─── SupplierFormFields ────────────────────────────────────────────────────────

function SupplierFormFields({
  form, onFieldChange, onToggleActive, onBlurField, fieldErrors, fieldRefs,
  error, loading, onSave, onCancel
}: {
  form: SupplierForm
  onFieldChange: (key: SupplierTextField, value: string) => void
  onToggleActive: (value: boolean) => void
  onBlurField: (field: ValidatedField) => void
  fieldErrors: FieldErrors
  fieldRefs: React.MutableRefObject<Partial<Record<ValidatedField, HTMLInputElement | null>>>
  error: string
  loading: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const hasErrors = Object.keys(fieldErrors).length > 0
  const errorClass = (field: ValidatedField) =>
    fieldErrors[field] ? ' border-red-300 focus-visible:ring-red-400' : ''
  const FieldError = ({ field }: { field: ValidatedField }) =>
    fieldErrors[field] ? <p className="mt-1.5 ml-1 text-xs text-red-600">{fieldErrors[field]}</p> : null

  return (
    <div className="space-y-5">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Company / Supplier Name *</label>
        <Input
          ref={(el) => { fieldRefs.current.name = el }}
          value={form.name}
          onChange={(e) => onFieldChange('name', e.target.value)}
          onBlur={() => onBlurField('name')}
          placeholder="e.g. Samsung India Pvt Ltd"
          className={`h-11${errorClass('name')}`}
        />
        <FieldError field="name" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Contact Person</label>
          <Input
            ref={(el) => { fieldRefs.current.contactPerson = el }}
            value={form.contactPerson}
            onChange={(e) => onFieldChange('contactPerson', e.target.value)}
            onBlur={() => onBlurField('contactPerson')}
            placeholder="e.g. Rajesh Kumar"
            className={`h-11${errorClass('contactPerson')}`}
          />
          <FieldError field="contactPerson" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Phone *</label>
          <Input
            ref={(el) => { fieldRefs.current.phone = el }}
            value={form.phone}
            onChange={(e) => onFieldChange('phone', e.target.value)}
            onBlur={() => onBlurField('phone')}
            placeholder="98765 43210"
            className={`h-11 font-mono${errorClass('phone')}`}
          />
          <FieldError field="phone" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Email</label>
          <Input
            ref={(el) => { fieldRefs.current.email = el }}
            type="email"
            value={form.email}
            onChange={(e) => onFieldChange('email', e.target.value)}
            onBlur={() => onBlurField('email')}
            placeholder="supplier@company.com"
            className={`h-11${errorClass('email')}`}
          />
          <FieldError field="email" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">GSTIN</label>
          <Input
            ref={(el) => { fieldRefs.current.gstin = el }}
            value={form.gstin}
            onChange={(e) => onFieldChange('gstin', e.target.value.toUpperCase())}
            onBlur={() => onBlurField('gstin')}
            placeholder="e.g. 27ABCDE1234F1Z0"
            className={`h-11 font-mono uppercase${errorClass('gstin')}`}
          />
          <FieldError field="gstin" />
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Address</label>
        <textarea
          value={form.address}
          onChange={(e) => onFieldChange('address', e.target.value)}
          placeholder="Full address of the supplier..."
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 border">
        <input
          type="checkbox"
          id="supplier-active"
          checked={form.isActive}
          onChange={(e) => onToggleActive(e.target.checked)}
          className="w-4 h-4 rounded"
        />
        <label htmlFor="supplier-active" className="text-sm font-medium cursor-pointer">
          Active supplier
          <span className="block text-xs text-muted-foreground font-normal">Inactive suppliers won't appear in purchase order suggestions.</span>
        </label>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave} disabled={loading || hasErrors}>
          {loading ? 'Saving...' : 'Save Supplier'}
        </Button>
      </div>
    </div>
  )
}
