import React, { useState, useEffect, useCallback } from 'react'
import {
  Package, Plus, Search, Edit2, Trash2, ArrowLeft,
  ChevronRight, Tag, Layers, AlertCircle, Box, RefreshCw
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type Category = { id: string; name: string }
type Supplier = { id: string; name: string }
type Warehouse = { id: string; name: string }

type Batch = {
  id: string
  batchCode: string
  uniqueStockCode: string
  purchaseRate: number
  currentQty: number
  receivedQty: number
  receivedDate: string
  warehouseId: string | null
  warehouse: { name: string } | null
  supplierId: string | null
  supplier: { name: string } | null
  isActive: boolean
  createdAt: string
}

type Product = {
  id: string
  itemCode: string
  brand: string | null
  name: string
  specification: string | null
  categoryId: string
  category: { id: string; name: string }
  productType: string | null
  unitOfMeasure: string
  sellingRate: number
  gstPercentage: number
  warrantyPeriodDays: number
  minStockLevel: number
  isActive: boolean
  totalStock: number
  batchCount: number
  latestBatch: Batch | null
  batches: Batch[]
}

type ProductForm = {
  itemCode: string
  brand: string
  name: string
  specification: string
  categoryId: string
  productType: string
  unitOfMeasure: string
  sellingRate: string
  gstPercentage: string
  warrantyPeriodDays: string
  minStockLevel: string
}

type BatchForm = {
  batchCode: string
  purchaseRate: string
  receivedQty: string
  supplierId: string
  warehouseId: string
  receivedDate: string
  notes: string
}

const emptyProductForm = (): ProductForm => ({
  itemCode: '', brand: '', name: '', specification: '',
  categoryId: '', productType: '', unitOfMeasure: 'pcs',
  sellingRate: '0', gstPercentage: '0', warrantyPeriodDays: '0', minStockLevel: '0'
})

const emptyBatchForm = (): BatchForm => ({
  batchCode: '', purchaseRate: '', receivedQty: '',
  supplierId: '', warehouseId: '',
  receivedDate: new Date().toISOString().slice(0, 10), notes: ''
})

// ─── Stock Badge ──────────────────────────────────────────────────────────────

function StockBadge({ qty, min }: { qty: number; min: number }) {
  if (qty === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200">
        <AlertCircle className="w-3 h-3" /> Out of Stock
      </span>
    )
  }
  if (qty <= min) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
        <AlertCircle className="w-3 h-3" /> Low ({qty})
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Box className="w-3 h-3" /> {qty}
    </span>
  )
}

// ─── ProductsScreen ───────────────────────────────────────────────────────────

export function ProductsScreen({ token }: { token: string | null }) {
  const [tab, setTab] = useState<'products' | 'categories'>('products')
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Product list state
  const [search, setSearch] = useState('')
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState('')
  const [detailProduct, setDetailProduct] = useState<Product | null>(null)

  // Product form modal
  const [showProductForm, setShowProductForm] = useState(false)
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [productForm, setProductForm] = useState<ProductForm>(emptyProductForm())
  const [productFormError, setProductFormError] = useState('')
  const [productFormLoading, setProductFormLoading] = useState(false)

  // Category form modal
  const [showCatForm, setShowCatForm] = useState(false)
  const [editingCatId, setEditingCatId] = useState<string | null>(null)
  const [catName, setCatName] = useState('')
  const [catFormLoading, setCatFormLoading] = useState(false)

  // Batch/restock modal
  const [showBatchForm, setShowBatchForm] = useState(false)
  const [batchTargetProduct, setBatchTargetProduct] = useState<Product | null>(null)
  const [batchForm, setBatchForm] = useState<BatchForm>(emptyBatchForm())
  const [batchFormError, setBatchFormError] = useState('')
  const [batchFormLoading, setBatchFormLoading] = useState(false)

  // Edit batch modal
  const [showEditBatchForm, setShowEditBatchForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [editBatchForm, setEditBatchForm] = useState({
    purchaseRate: '', warehouseId: '', supplierId: '',
    receivedDate: '', receivedQty: '', notes: '', isActive: true
  })
  const [editBatchFormError, setEditBatchFormError] = useState('')
  const [editBatchFormLoading, setEditBatchFormLoading] = useState(false)

  // ─── Data Loading ──────────────────────────────────────────────────────────

  const loadProducts = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<{ products: Product[] }>('/api/v1/products', token)
      setProducts(data.products)
    } catch {
      setError('Failed to load products.')
    } finally {
      setLoading(false)
    }
  }, [token])

  const loadMeta = useCallback(async () => {
    try {
      const [catsData, suppData, whData] = await Promise.all([
        apiFetch<{ categories: Category[] }>('/api/v1/categories', token),
        apiFetch<{ suppliers: Supplier[] }>('/api/v1/suppliers', token),
        apiFetch<{ warehouses: Warehouse[] }>('/api/v1/warehouses', token)
      ])
      setCategories(catsData.categories)
      setSuppliers(suppData.suppliers)
      setWarehouses(whData.warehouses)
    } catch { /* non-fatal */ }
  }, [token])

  useEffect(() => {
    loadProducts()
    loadMeta()
  }, [loadProducts, loadMeta])

  // ─── Product CRUD ──────────────────────────────────────────────────────────

  const openAddProduct = () => {
    setEditingProductId(null)
    setProductForm(emptyProductForm())
    setProductFormError('')
    setShowProductForm(true)
  }

  const openEditProduct = (p: Product, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingProductId(p.id)
    setProductForm({
      itemCode: p.itemCode, brand: p.brand || '', name: p.name,
      specification: p.specification || '', categoryId: p.categoryId,
      productType: p.productType || '', unitOfMeasure: p.unitOfMeasure,
      sellingRate: String(p.sellingRate),
      gstPercentage: String(p.gstPercentage),
      warrantyPeriodDays: String(p.warrantyPeriodDays),
      minStockLevel: String(p.minStockLevel)
    })
    setProductFormError('')
    setShowProductForm(true)
  }

  const handleSaveProduct = async () => {
    if (!productForm.itemCode || !productForm.name || !productForm.categoryId) {
      setProductFormError('Item code, name and category are required.')
      return
    }
    setProductFormLoading(true)
    setProductFormError('')
    try {
      const body = {
        ...productForm,
        sellingRate: parseFloat(productForm.sellingRate) || 0,
        gstPercentage: parseFloat(productForm.gstPercentage) || 0,
        warrantyPeriodDays: parseInt(productForm.warrantyPeriodDays) || 0,
        minStockLevel: parseInt(productForm.minStockLevel) || 0
      }
      if (!editingProductId) {
        await apiFetch('/api/v1/products', token, { method: 'POST', body: JSON.stringify(body) })
      } else {
        await apiFetch(`/api/v1/products/${editingProductId}`, token, { method: 'PUT', body: JSON.stringify(body) })
      }
      setShowProductForm(false)
      await loadProducts()
      if (detailProduct && editingProductId === detailProduct.id) {
        const fresh = await apiFetch<{ product: Product }>(`/api/v1/products/${editingProductId}`, token)
        setDetailProduct(fresh.product)
      }
    } catch (err: unknown) {
      const e = err as { data?: { error?: string } }
      setProductFormError(e.data?.error === 'ITEM_CODE_EXISTS' ? 'Item code already exists.' : 'Failed to save product.')
    } finally {
      setProductFormLoading(false)
    }
  }

  const handleDeleteProduct = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!confirm('Deactivate this product?')) return
    try {
      await apiFetch(`/api/v1/products/${id}`, token, { method: 'DELETE' })
      setDetailProduct(null)
      await loadProducts()
    } catch {
      alert('Failed to deactivate product.')
    }
  }

  // ─── Category CRUD ─────────────────────────────────────────────────────────

  const openAddCat = () => { setEditingCatId(null); setCatName(''); setShowCatForm(true) }
  const openEditCat = (c: Category) => { setEditingCatId(c.id); setCatName(c.name); setShowCatForm(true) }

  const handleSaveCat = async () => {
    if (!catName.trim()) return
    setCatFormLoading(true)
    try {
      if (!editingCatId) {
        await apiFetch('/api/v1/categories', token, { method: 'POST', body: JSON.stringify({ name: catName.trim() }) })
      } else {
        await apiFetch(`/api/v1/categories/${editingCatId}`, token, { method: 'PUT', body: JSON.stringify({ name: catName.trim() }) })
      }
      setShowCatForm(false)
      await loadMeta()
    } catch {
      alert('Failed to save category.')
    } finally {
      setCatFormLoading(false)
    }
  }

  const handleDeleteCat = async (id: string) => {
    if (!confirm('Delete this category? This will fail if products exist in it.')) return
    try {
      await apiFetch(`/api/v1/categories/${id}`, token, { method: 'DELETE' })
      await loadMeta()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string } }
      alert(e.data?.error === 'CATEGORY_HAS_PRODUCTS' ? 'Cannot delete: products exist in this category.' : 'Failed to delete category.')
    }
  }

  // ─── Batch / Restock ───────────────────────────────────────────────────────

  const openAddBatch = async (p: Product) => {
    setBatchTargetProduct(p)
    setBatchFormError('')
    const form = emptyBatchForm()
    try {
      const data = await apiFetch<{ batchCode: string }>('/api/v1/system/next-batch-code', token)
      form.batchCode = data.batchCode
    } catch { /* use empty */ }
    setBatchForm(form)
    setShowBatchForm(true)
  }

  const handleSaveBatch = async () => {
    if (!batchTargetProduct) return
    if (!batchForm.purchaseRate || !batchForm.receivedQty) {
      setBatchFormError('Purchase rate and received qty are required.')
      return
    }
    setBatchFormLoading(true)
    setBatchFormError('')
    try {
      await apiFetch(`/api/v1/products/${batchTargetProduct.id}/batches`, token, {
        method: 'POST',
        body: JSON.stringify({
          batchCode: batchForm.batchCode || undefined,
          purchaseRate: parseFloat(batchForm.purchaseRate),
          receivedQty: parseInt(batchForm.receivedQty),
          supplierId: batchForm.supplierId || null,
          warehouseId: batchForm.warehouseId || null,
          receivedDate: batchForm.receivedDate,
          notes: batchForm.notes || null
        })
      })
      setShowBatchForm(false)
      await loadProducts()
      if (detailProduct?.id === batchTargetProduct.id) {
        const fresh = await apiFetch<{ product: Product }>(`/api/v1/products/${batchTargetProduct.id}`, token)
        setDetailProduct(fresh.product)
      }
    } catch (err: unknown) {
      const e = err as { data?: { error?: string } }
      setBatchFormError(e.data?.error === 'BATCH_CODE_EXISTS_FOR_PRODUCT' ? 'Batch code already exists for this product.' : 'Failed to add batch.')
    } finally {
      setBatchFormLoading(false)
    }
  }

  // ─── Edit Batch ────────────────────────────────────────────────────────────

  const openEditBatch = (b: Batch) => {
    setEditingBatch(b)
    setEditBatchForm({
      purchaseRate: String(b.purchaseRate),
      warehouseId: b.warehouseId || '',
      supplierId: b.supplierId || '',
      receivedDate: b.receivedDate ? new Date(b.receivedDate).toISOString().slice(0, 10) : '',
      receivedQty: String(b.receivedQty),
      notes: '',
      isActive: b.isActive
    })
    setEditBatchFormError('')
    setShowEditBatchForm(true)
  }

  const handleSaveEditBatch = async () => {
    if (!editingBatch) return
    if (!editBatchForm.purchaseRate) {
      setEditBatchFormError('Purchase rate is required.')
      return
    }
    setEditBatchFormLoading(true)
    setEditBatchFormError('')
    try {
      await apiFetch(`/api/v1/batches/${editingBatch.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({
          purchaseRate: parseFloat(editBatchForm.purchaseRate),
          warehouseId: editBatchForm.warehouseId || null,
          supplierId: editBatchForm.supplierId || null,
          receivedDate: editBatchForm.receivedDate || null,
          receivedQty: editBatchForm.receivedQty ? parseInt(editBatchForm.receivedQty) : undefined,
          notes: editBatchForm.notes || null,
          isActive: editBatchForm.isActive
        })
      })
      setShowEditBatchForm(false)
      await loadProducts()
      if (detailProduct) {
        const fresh = await apiFetch<{ product: Product }>(`/api/v1/products/${detailProduct.id}`, token)
        setDetailProduct(fresh.product)
      }
    } catch {
      setEditBatchFormError('Failed to update batch.')
    } finally {
      setEditBatchFormLoading(false)
    }
  }

  // ─── Filtered List ─────────────────────────────────────────────────────────

  const filtered = products.filter((p) => {
    const matchesSearch = !search ||
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.itemCode.toLowerCase().includes(search.toLowerCase()) ||
      (p.brand || '').toLowerCase().includes(search.toLowerCase())
    const matchesCat = !selectedCategoryFilter || p.categoryId === selectedCategoryFilter
    return matchesSearch && matchesCat
  })

  // ─── Detail View ───────────────────────────────────────────────────────────

  if (detailProduct) {
    const p = detailProduct
    const margin = p.latestBatch && p.latestBatch.purchaseRate > 0
      ? (((p.sellingRate - p.latestBatch.purchaseRate) / p.latestBatch.purchaseRate) * 100).toFixed(1)
      : null

    return (
      <div>
        <div className="flex items-center gap-3 mb-6">
          <button
            type="button"
            onClick={() => setDetailProduct(null)}
            className="p-1.5 rounded-md hover:bg-zinc-100 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold">{p.name}</h1>
            <p className="text-sm text-muted-foreground font-mono">{p.itemCode}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={(e) => openEditProduct(p, e)} className="gap-2">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
            <Button onClick={() => openAddBatch(p)} className="gap-2">
              <Plus className="w-4 h-4" /> Add Batch / Restock
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Total Stock</p>
            <p className="text-2xl font-bold">{p.totalStock} <span className="text-sm font-normal text-muted-foreground">{p.unitOfMeasure}</span></p>
          </div>
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Selling Rate</p>
            <p className="text-2xl font-bold">₹{p.sellingRate.toFixed(2)}</p>
            {margin && <p className={`text-xs font-medium mt-0.5 ${parseFloat(margin) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{margin}% margin</p>}
          </div>
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Purchase Rate</p>
            <p className="text-2xl font-bold">₹{p.latestBatch ? p.latestBatch.purchaseRate.toFixed(2) : '—'}</p>
          </div>
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">GST</p>
            <p className="text-2xl font-bold">{p.gstPercentage}%</p>
          </div>
        </div>

        {/* Product Info */}
        <div className="grid grid-cols-3 gap-4 mb-6 text-sm">
          {p.brand && <div><span className="text-muted-foreground">Brand:</span> <span className="font-medium">{p.brand}</span></div>}
          {p.specification && <div><span className="text-muted-foreground">Spec:</span> <span className="font-medium">{p.specification}</span></div>}
          {p.productType && <div><span className="text-muted-foreground">Type:</span> <span className="font-medium">{p.productType}</span></div>}
          <div><span className="text-muted-foreground">Category:</span> <span className="font-medium">{p.category.name}</span></div>
          <div><span className="text-muted-foreground">Warranty:</span> <span className="font-medium">{p.warrantyPeriodDays}d</span></div>
          <div><span className="text-muted-foreground">Min Stock:</span> <span className="font-medium">{p.minStockLevel}</span></div>
        </div>

        {/* Batches */}
        <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
          <Layers className="w-4 h-4" /> Stock Batches ({p.batches.length})
        </h2>

        {p.batches.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed p-10 text-center text-muted-foreground text-sm">
            No batches yet. Click "Add Batch / Restock" to receive stock.
          </div>
        ) : (
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600">Batch</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600">Supplier / Warehouse</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600">Purchase</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600">Qty</th>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600">Date</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {p.batches.map((b, i) => (
                  <tr key={b.id} className={i === 0 ? 'bg-blue-50/40' : 'hover:bg-zinc-50'}>
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs font-semibold text-zinc-800">{b.batchCode}</p>
                      <p className="font-mono text-xs text-muted-foreground">{b.uniqueStockCode}</p>
                      {i === 0 && <span className="text-xs text-blue-600 font-medium">Latest</span>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {b.supplier?.name && <p>{b.supplier.name}</p>}
                      {b.warehouse?.name && <p>{b.warehouse.name}</p>}
                      {!b.supplier?.name && !b.warehouse?.name && '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">₹{b.purchaseRate.toFixed(2)}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-semibold ${b.currentQty === 0 ? 'text-red-600' : 'text-zinc-900'}`}>{b.currentQty}</span>
                      <span className="text-xs text-muted-foreground"> / {b.receivedQty}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {new Date(b.receivedDate).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => openEditBatch(b)}
                        className="p-1.5 rounded-md hover:bg-zinc-200 transition-colors text-zinc-400"
                        title="Edit batch"
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Add Batch Modal */}
        <Modal open={showBatchForm} onClose={() => setShowBatchForm(false)} title={`Add Batch — ${batchTargetProduct?.name}`} size="md">
          <BatchFormFields
            form={batchForm}
            onChange={setBatchForm}
            suppliers={suppliers}
            warehouses={warehouses}
            error={batchFormError}
            loading={batchFormLoading}
            onSave={handleSaveBatch}
            onCancel={() => setShowBatchForm(false)}
          />
        </Modal>

        {/* Edit Batch Modal */}
        <Modal open={showEditBatchForm} onClose={() => setShowEditBatchForm(false)} title={`Edit Batch — ${editingBatch?.batchCode}`} size="md">
          <EditBatchFormFields
            form={editBatchForm}
            onChange={setEditBatchForm}
            warehouses={warehouses}
            suppliers={suppliers}
            error={editBatchFormError}
            loading={editBatchFormLoading}
            onSave={handleSaveEditBatch}
            onCancel={() => setShowEditBatchForm(false)}
          />
        </Modal>

        {/* Edit Product Modal */}
        <Modal open={showProductForm} onClose={() => setShowProductForm(false)} title="Edit Product" size="lg">
          <ProductFormFields
            form={productForm}
            onChange={setProductForm}
            categories={categories}
            error={productFormError}
            loading={productFormLoading}
            isEdit={true}
            onSave={handleSaveProduct}
            onCancel={() => setShowProductForm(false)}
          />
        </Modal>
      </div>
    )
  }

  // ─── Main List View ────────────────────────────────────────────────────────

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="w-6 h-6" /> Products
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Manage your product catalogue and inventory batches.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={loadProducts} className="p-2 rounded-md hover:bg-zinc-100 transition-colors text-zinc-500">
            <RefreshCw className="w-4 h-4" />
          </button>
          <Button onClick={openAddProduct} className="gap-2">
            <Plus className="w-4 h-4" /> Add Product
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b">
        {(['products', 'categories'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize ${tab === t ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-muted-foreground hover:text-zinc-700'}`}
          >
            {t === 'categories' ? <span className="flex items-center gap-1.5"><Tag className="w-3.5 h-3.5" /> Categories</span> : 'Products'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>
      )}

      {/* ── Products Tab ────────────────────────────────────────────────── */}
      {tab === 'products' && (
        <>
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, code or brand..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9 h-10"
              />
            </div>
            <select
              value={selectedCategoryFilter}
              onChange={(e) => setSelectedCategoryFilter(e.target.value)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">All Categories</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-20 text-muted-foreground text-sm">
              <div className="w-5 h-5 border-2 border-zinc-300 border-t-zinc-700 rounded-full animate-spin mr-3" /> Loading...
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold text-zinc-600">Product</th>
                    <th className="text-left px-4 py-3 font-semibold text-zinc-600">Category</th>
                    <th className="text-right px-4 py-3 font-semibold text-zinc-600">Selling Rate</th>
                    <th className="text-center px-4 py-3 font-semibold text-zinc-600">Stock</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {filtered.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground text-sm">
                        No products found.
                      </td>
                    </tr>
                  ) : (
                    filtered.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setDetailProduct(p)}
                        className="hover:bg-zinc-50/70 transition-colors cursor-pointer"
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-zinc-900">{p.name}</p>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            {p.itemCode}{p.brand ? ` · ${p.brand}` : ''}
                          </p>
                          {p.specification && <p className="text-xs text-muted-foreground mt-0.5 max-w-[260px] truncate">{p.specification}</p>}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">{p.category.name}</td>
                        <td className="px-4 py-3 text-right font-medium text-zinc-900">
                          ₹{p.sellingRate.toFixed(2)}
                          {p.batchCount > 1 && (
                            <span className="block text-xs text-muted-foreground">{p.batchCount} batches</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <StockBadge qty={p.totalStock} min={p.minStockLevel} />
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <button
                              type="button"
                              onClick={(e) => openEditProduct(p, e)}
                              className="p-1.5 rounded-md hover:bg-zinc-200 transition-colors text-zinc-400"
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={(e) => handleDeleteProduct(p.id, e)}
                              className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 transition-colors text-zinc-400"
                              title="Deactivate"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                            <ChevronRight className="w-4 h-4 text-zinc-300 ml-1" />
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
            {filtered.length} product{filtered.length !== 1 ? 's' : ''}
            {search || selectedCategoryFilter ? ` (filtered from ${products.length})` : ''}
          </p>
        </>
      )}

      {/* ── Categories Tab ─────────────────────────────────────────────── */}
      {tab === 'categories' && (
        <>
          <div className="flex justify-end mb-4">
            <Button onClick={openAddCat} className="gap-2" size="sm">
              <Plus className="w-4 h-4" /> Add Category
            </Button>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600">Category Name</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {categories.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="px-4 py-10 text-center text-muted-foreground text-sm">No categories yet.</td>
                  </tr>
                ) : (
                  categories.map((c) => (
                    <tr key={c.id} className="hover:bg-zinc-50/70">
                      <td className="px-4 py-3 font-medium text-zinc-900">{c.name}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button type="button" onClick={() => openEditCat(c)} className="p-1.5 rounded-md hover:bg-zinc-200 text-zinc-400"><Edit2 className="w-3.5 h-3.5" /></button>
                          <button type="button" onClick={() => handleDeleteCat(c.id)} className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 text-zinc-400"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add/Edit Product Modal */}
      <Modal open={showProductForm} onClose={() => setShowProductForm(false)} title={editingProductId ? 'Edit Product' : 'Add Product'} size="lg">
        <ProductFormFields
          form={productForm}
          onChange={setProductForm}
          categories={categories}
          error={productFormError}
          loading={productFormLoading}
          isEdit={!!editingProductId}
          onSave={handleSaveProduct}
          onCancel={() => setShowProductForm(false)}
        />
      </Modal>

      {/* Add Category Modal */}
      <Modal open={showCatForm} onClose={() => setShowCatForm(false)} title={editingCatId ? 'Edit Category' : 'Add Category'} size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Category Name</label>
            <Input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="e.g. Wires & Cables" className="h-11" autoFocus />
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <Button variant="outline" onClick={() => setShowCatForm(false)}>Cancel</Button>
            <Button onClick={handleSaveCat} disabled={catFormLoading}>
              {catFormLoading ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

// ─── ProductFormFields ────────────────────────────────────────────────────────

function ProductFormFields({
  form, onChange, categories, error, loading, isEdit, onSave, onCancel
}: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  categories: Category[]
  error: string
  loading: boolean
  isEdit: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) =>
    onChange({ ...form, [key]: value })

  return (
    <div className="space-y-5">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      <div>
        <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Basic Info</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Item Code *</label>
            <Input value={form.itemCode} onChange={(e) => set('itemCode', e.target.value)} placeholder="e.g. FIN-WIRE-1.5-RED" className="h-11" disabled={isEdit} />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Brand</label>
            <Input value={form.brand} onChange={(e) => set('brand', e.target.value)} placeholder="e.g. Finolex" className="h-11" />
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-sm font-semibold mb-1.5 ml-1">Product Name *</label>
          <Input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. 1.5 sqmm Red Wire" className="h-11" />
        </div>
        <div className="mt-3">
          <label className="block text-sm font-semibold mb-1.5 ml-1">Specification</label>
          <Input value={form.specification} onChange={(e) => set('specification', e.target.value)} placeholder="e.g. 1.5 sqmm, 90m coil" className="h-11" />
        </div>
        <div className="grid grid-cols-3 gap-3 mt-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Category *</label>
            <select
              value={form.categoryId}
              onChange={(e) => set('categoryId', e.target.value)}
              className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">Select...</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Product Type</label>
            <Input value={form.productType} onChange={(e) => set('productType', e.target.value)} placeholder="e.g. PVC Insulated" className="h-11" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Unit of Measure</label>
            <select
              value={form.unitOfMeasure}
              onChange={(e) => set('unitOfMeasure', e.target.value)}
              className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {['pcs', 'box', 'roll', 'coil', 'mtr', 'kg', 'ltr', 'set', 'pair'].map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Pricing & Tax</p>
        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Selling Rate *</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
              <Input type="number" min="0" step="0.01" value={form.sellingRate} onChange={(e) => set('sellingRate', e.target.value)} className="h-11 pl-7" placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">GST %</label>
            <div className="relative">
              <Input type="number" min="0" max="28" step="0.5" value={form.gstPercentage} onChange={(e) => set('gstPercentage', e.target.value)} className="h-11 pr-8" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Warranty (days)</label>
            <Input type="number" min="0" value={form.warrantyPeriodDays} onChange={(e) => set('warrantyPeriodDays', e.target.value)} className="h-11" />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Min Stock Level</label>
            <Input type="number" min="0" value={form.minStockLevel} onChange={(e) => set('minStockLevel', e.target.value)} className="h-11" />
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave} disabled={loading}>
          {loading ? 'Saving...' : 'Save Product'}
        </Button>
      </div>
    </div>
  )
}

// ─── BatchFormFields ──────────────────────────────────────────────────────────

function BatchFormFields({
  form, onChange, suppliers, warehouses, error, loading, onSave, onCancel
}: {
  form: BatchForm
  onChange: (f: BatchForm) => void
  suppliers: Supplier[]
  warehouses: Warehouse[]
  error: string
  loading: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof BatchForm>(key: K, value: BatchForm[K]) =>
    onChange({ ...form, [key]: value })

  return (
    <div className="space-y-5">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Batch Code</label>
          <Input value={form.batchCode} onChange={(e) => set('batchCode', e.target.value)} placeholder="Auto-generated if empty" className="h-11 font-mono" />
          <p className="text-xs text-muted-foreground mt-1 ml-1">Leave empty to auto-generate</p>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Received Date</label>
          <Input type="date" value={form.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} className="h-11" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Purchase Rate *</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
            <Input type="number" min="0" step="0.01" value={form.purchaseRate} onChange={(e) => set('purchaseRate', e.target.value)} className="h-11 pl-7" placeholder="0.00" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Received Qty *</label>
          <Input type="number" min="1" value={form.receivedQty} onChange={(e) => set('receivedQty', e.target.value)} className="h-11" placeholder="0" />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Supplier</label>
          <select
            value={form.supplierId}
            onChange={(e) => set('supplierId', e.target.value)}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select supplier...</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Warehouse</label>
          <select
            value={form.warehouseId}
            onChange={(e) => set('warehouseId', e.target.value)}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">Select warehouse...</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Optional notes about this batch..."
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave} disabled={loading}>
          {loading ? 'Adding...' : 'Add Batch'}
        </Button>
      </div>
    </div>
  )
}

// ─── EditBatchFormFields ──────────────────────────────────────────────────────

type EditBatchForm = {
  purchaseRate: string
  warehouseId: string; supplierId: string
  receivedDate: string; receivedQty: string
  notes: string; isActive: boolean
}

function EditBatchFormFields({
  form, onChange, warehouses, suppliers, error, loading, onSave, onCancel
}: {
  form: EditBatchForm
  onChange: (f: EditBatchForm) => void
  warehouses: Warehouse[]
  suppliers: Supplier[]
  error: string
  loading: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof EditBatchForm>(key: K, value: EditBatchForm[K]) =>
    onChange({ ...form, [key]: value })

  return (
    <div className="space-y-4">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      {/* Purchase Rate */}
      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Purchase Rate *</label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
          <Input type="number" min="0" step="0.01" value={form.purchaseRate} onChange={(e) => set('purchaseRate', e.target.value)} className="h-11 pl-7" />
        </div>
      </div>

      {/* Qty */}
      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Received Qty</label>
        <Input type="number" min="0" value={form.receivedQty} onChange={(e) => set('receivedQty', e.target.value)} className="h-11" />
        <p className="text-xs text-muted-foreground mt-1 ml-1">Total qty received in this batch</p>
      </div>

      {/* Supplier & Warehouse */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Supplier</label>
          <select
            value={form.supplierId}
            onChange={(e) => set('supplierId', e.target.value)}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">No supplier</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Warehouse</label>
          <select
            value={form.warehouseId}
            onChange={(e) => set('warehouseId', e.target.value)}
            className="w-full h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">No warehouse</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
      </div>

      {/* Received Date */}
      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Received Date</label>
        <Input type="date" value={form.receivedDate} onChange={(e) => set('receivedDate', e.target.value)} className="h-11" />
      </div>

      {/* Notes */}
      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Notes</label>
        <textarea
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          placeholder="Optional notes..."
          rows={2}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {/* Active toggle */}
      <div className="flex items-center gap-3 p-3 rounded-lg bg-zinc-50 border">
        <input
          type="checkbox"
          id="batch-active"
          checked={form.isActive}
          onChange={(e) => set('isActive', e.target.checked)}
          className="w-4 h-4 rounded"
        />
        <label htmlFor="batch-active" className="text-sm font-medium cursor-pointer">
          Active batch
          <span className="block text-xs text-muted-foreground font-normal">Inactive batches won't appear in stock or billing.</span>
        </label>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        <Button onClick={onSave} disabled={loading}>
          {loading ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  )
}
