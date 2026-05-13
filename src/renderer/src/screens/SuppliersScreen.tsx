import React, { useState, useEffect, useCallback } from 'react'
import { Truck, Plus, Search, Edit2, Trash2, Phone, Mail, Building2, RefreshCw } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'

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
  const [formLoading, setFormLoading] = useState(false)

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

  const filtered = suppliers.filter(
    (s) =>
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.phone.includes(search) ||
      (s.contactPerson || '').toLowerCase().includes(search.toLowerCase())
  )

  const openAdd = () => {
    setEditingId(null)
    setFormData(emptyForm())
    setFormError('')
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
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!formData.name || !formData.phone) {
      setFormError('Name and phone are required.')
      return
    }
    setFormLoading(true)
    setFormError('')
    try {
      if (!editingId) {
        await apiFetch('/api/v1/suppliers', token, { method: 'POST', body: JSON.stringify(formData) })
      } else {
        await apiFetch(`/api/v1/suppliers/${editingId}`, token, { method: 'PUT', body: JSON.stringify(formData) })
      }
      setShowForm(false)
      await loadSuppliers()
    } catch {
      setFormError('Failed to save supplier.')
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
                          <Phone className="w-3 h-3" /> {s.phone}
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
          onChange={setFormData}
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
  form, onChange, error, loading, onSave, onCancel
}: {
  form: SupplierForm
  onChange: (f: SupplierForm) => void
  error: string
  loading: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof SupplierForm>(key: K, value: SupplierForm[K]) =>
    onChange({ ...form, [key]: value })

  return (
    <div className="space-y-5">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Company / Supplier Name *</label>
        <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Samsung India Pvt Ltd" className="h-11" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Contact Person</label>
          <Input value={form.contactPerson} onChange={(e) => set('contactPerson', e.target.value)} placeholder="e.g. Rajesh Kumar" className="h-11" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Phone *</label>
          <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+91 98765 43210" className="h-11" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Email</label>
          <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="supplier@company.com" className="h-11" />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">GSTIN</label>
          <Input value={form.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="e.g. 27AAAAA0000A1Z5" className="h-11" />
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Address</label>
        <textarea
          value={form.address}
          onChange={(e) => set('address', e.target.value)}
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
          onChange={(e) => set('isActive', e.target.checked)}
          className="w-4 h-4 rounded"
        />
        <label htmlFor="supplier-active" className="text-sm font-medium cursor-pointer">
          Active supplier
          <span className="block text-xs text-muted-foreground font-normal">Inactive suppliers won't appear in purchase order suggestions.</span>
        </label>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave} disabled={loading}>
          {loading ? 'Saving...' : 'Save Supplier'}
        </Button>
      </div>
    </div>
  )
}
