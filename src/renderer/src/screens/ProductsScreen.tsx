import React, { useState, useEffect, useCallback } from 'react'
import {
  Package, Plus, Search, Edit2, Trash2, ArrowLeft,
  ChevronRight, Tag, Layers, AlertCircle, Box, RefreshCw,
  Archive, RotateCcw, Wand2, EyeOff, Bookmark
} from 'lucide-react'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Modal } from '../components/Modal'
import { apiFetch } from '../lib/api'
import { validateItemCode, suggestItemCodeFix, validateHsn, ITEM_CODE_HINT, validateName } from '@shared/validation'
import {
  type SellMode, measuresFor, defaultMeasureFor, isLengthMode,
  qtyStep, parseQty, formatQty, formatQtyWithUnit, computePurchaseCost
} from '@shared/units'

// ─── Types ────────────────────────────────────────────────────────────────────

type Category = { id: string; name: string }
type Supplier = { id: string; name: string }
type Warehouse = { id: string; name: string }
type Brand = { id: string; name: string; isActive: boolean; productCount: number }

type Batch = {
  id: string
  batchCode: string
  uniqueStockCode: string
  /** Always ex-GST — this is the cost basis margin is computed against. */
  purchaseRate: number
  purchaseGstPct: number
  purchaseGstAmount: number
  purchaseRateInclGst: number
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
  brandId: string | null
  /** Denormalised copy of the brand's name, kept in sync by the server. */
  brand: string | null
  name: string
  specification: string | null
  categoryId: string
  category: { id: string; name: string }
  productType: string | null
  unitOfMeasure: string
  sellMode: SellMode
  sellingRate: number
  gstPercentage: number
  warrantyPeriodDays: number
  hsnCode?: string | null
  minStockLevel: number
  isActive: boolean
  totalStock: number
  batchCount: number
  latestBatch: Batch | null
  batches: Batch[]
}

type WarrantyUnit = 'days' | 'months' | 'years'

type ProductForm = {
  itemCode: string
  brandId: string
  name: string
  specification: string
  categoryId: string
  productType: string
  unitOfMeasure: string
  sellMode: SellMode
  sellingRate: string
  gstPercentage: string
  hsnCode: string
  warrantyValue: string
  warrantyUnit: WarrantyUnit
  minStockLevel: string
}

type StatusFilter = 'active' | 'inactive' | 'all'

type BatchForm = {
  batchCode: string
  purchaseRate: string
  purchaseGstPct: string
  rateIncludesGst: boolean
  receivedQty: string
  supplierId: string
  warehouseId: string
  receivedDate: string
  notes: string
}

const emptyProductForm = (): ProductForm => ({
  itemCode: '', brandId: '', name: '', specification: '',
  categoryId: '', productType: '', unitOfMeasure: defaultMeasureFor('UNIT'),
  sellMode: 'UNIT', sellingRate: '0', gstPercentage: '0', hsnCode: '',
  warrantyValue: '0', warrantyUnit: 'days', minStockLevel: '0'
})

const emptyBatchForm = (gstPct: number = 0): BatchForm => ({
  batchCode: '', purchaseRate: '', purchaseGstPct: String(gstPct), rateIncludesGst: false,
  receivedQty: '', supplierId: '', warehouseId: '',
  receivedDate: new Date().toISOString().slice(0, 10), notes: ''
})

// ─── Warranty helpers ─────────────────────────────────────────────────────────

const WARRANTY_UNIT_DAYS: Record<WarrantyUnit, number> = { days: 1, months: 30, years: 365 }

/** Picks the largest unit that divides evenly — 730 → 2 years, 90 → 3 months, 45 → 45 days. */
function splitWarranty(days: number): { value: string; unit: WarrantyUnit } {
  const d = Math.max(0, Math.round(days || 0))
  if (d > 0 && d % WARRANTY_UNIT_DAYS.years === 0) return { value: String(d / WARRANTY_UNIT_DAYS.years), unit: 'years' }
  if (d > 0 && d % WARRANTY_UNIT_DAYS.months === 0) return { value: String(d / WARRANTY_UNIT_DAYS.months), unit: 'months' }
  return { value: String(d), unit: 'days' }
}

function warrantyToDays(value: string, unit: WarrantyUnit): number {
  const n = parseInt(value, 10)
  if (!n || n < 0) return 0
  return n * WARRANTY_UNIT_DAYS[unit]
}

/** "730" → "2 years", "0" → "None". */
function formatWarranty(days: number): string {
  if (!days) return 'None'
  const { value, unit } = splitWarranty(days)
  const n = parseInt(value, 10)
  const noun = unit === 'days' ? 'day' : unit === 'months' ? 'month' : 'year'
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

// ─── Segmented toggle ─────────────────────────────────────────────────────────

/** Two-or-more-way pill switch — used for sell mode and the batch GST basis. */
function Segmented<T extends string>({
  value, onChange, options, className = ''
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  className?: string
}) {
  return (
    <div className={`inline-flex items-center rounded-md border border-input bg-background p-0.5 ${className}`}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 h-9 rounded text-sm font-medium transition-colors ${
            value === o.value ? 'bg-zinc-900 text-white' : 'text-zinc-600 hover:bg-zinc-100'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ─── Stock Badge ──────────────────────────────────────────────────────────────

function StockBadge({ qty, min, uom }: { qty: number; min: number; uom: string }) {
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
        <AlertCircle className="w-3 h-3" /> Low ({formatQtyWithUnit(qty, uom)})
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Box className="w-3 h-3" /> {formatQtyWithUnit(qty, uom)}
    </span>
  )
}

// ─── Purchase cost readout ────────────────────────────────────────────────────

/** Live "Base · GST · Landed" breakdown shown under the batch rate inputs. */
function PurchaseCostReadout({
  rate, gstPct, includesGst, qty, uom
}: {
  rate: string
  gstPct: string
  includesGst: boolean
  qty: number
  uom: string
}) {
  const cost = computePurchaseCost(parseFloat(rate) || 0, parseFloat(gstPct) || 0, includesGst)
  const lineEx = cost.rateExGst * qty
  const lineLanded = cost.rateInclGst * qty

  return (
    <div className="rounded-lg bg-zinc-50 border px-3 py-2 text-xs text-zinc-600 space-y-0.5">
      <p>
        Base <span className="font-semibold text-zinc-900">₹{cost.rateExGst.toFixed(2)}</span>
        {' · '}GST <span className="font-semibold text-zinc-900">₹{cost.gstAmount.toFixed(2)}</span>
        {' · '}Landed <span className="font-semibold text-zinc-900">₹{cost.rateInclGst.toFixed(2)}</span>
        {' '}per {uom}
      </p>
      <p>
        {qty > 0
          ? <>Line total for {formatQtyWithUnit(qty, uom)}: <span className="font-semibold text-zinc-900">₹{lineLanded.toFixed(2)}</span> landed (₹{lineEx.toFixed(2)} ex-GST)</>
          : 'Enter a received quantity to see the line total.'}
      </p>
    </div>
  )
}

// ─── Inactive Badge ───────────────────────────────────────────────────────────

function InactiveBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-600 border border-zinc-200">
      <EyeOff className="w-3 h-3" /> Inactive
    </span>
  )
}

// ─── ProductsScreen ───────────────────────────────────────────────────────────

export function ProductsScreen({ token }: { token: string | null }) {
  const [tab, setTab] = useState<'products' | 'categories' | 'brands'>('products')
  const [products, setProducts] = useState<Product[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [brands, setBrands] = useState<Brand[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Product list state
  const [search, setSearch] = useState('')
  const [selectedCategoryFilter, setSelectedCategoryFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active')
  const [detailProduct, setDetailProduct] = useState<Product | null>(null)

  // Product form modal
  const [showProductForm, setShowProductForm] = useState(false)
  const [editingProductId, setEditingProductId] = useState<string | null>(null)
  const [itemCodeLocked, setItemCodeLocked] = useState(false)
  const [productForm, setProductForm] = useState<ProductForm>(emptyProductForm())
  const [productFormError, setProductFormError] = useState('')
  const [productFormLoading, setProductFormLoading] = useState(false)
  const [suggestingCode, setSuggestingCode] = useState(false)

  // Deactivate / delete confirmation modal
  const [confirmTarget, setConfirmTarget] = useState<Product | null>(null)
  const [confirmMode, setConfirmMode] = useState<'deactivate' | 'hard'>('deactivate')
  const [confirmError, setConfirmError] = useState('')
  const [confirmLoading, setConfirmLoading] = useState(false)
  const [confirmOfferDeactivate, setConfirmOfferDeactivate] = useState(false)

  // Category form modal
  const [showCatForm, setShowCatForm] = useState(false)
  const [editingCatId, setEditingCatId] = useState<string | null>(null)
  const [catName, setCatName] = useState('')
  const [catFormLoading, setCatFormLoading] = useState(false)

  // Brand form modal
  const [showBrandForm, setShowBrandForm] = useState(false)
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null)
  const [brandName, setBrandName] = useState('')
  const [brandFormError, setBrandFormError] = useState('')
  const [brandFormLoading, setBrandFormLoading] = useState(false)

  // Brand delete confirmation modal
  const [brandConfirmTarget, setBrandConfirmTarget] = useState<Brand | null>(null)
  const [brandConfirmError, setBrandConfirmError] = useState('')
  const [brandConfirmLoading, setBrandConfirmLoading] = useState(false)
  const [brandOfferDeactivate, setBrandOfferDeactivate] = useState(false)

  // Batch/restock modal
  const [showBatchForm, setShowBatchForm] = useState(false)
  const [batchTargetProduct, setBatchTargetProduct] = useState<Product | null>(null)
  const [batchForm, setBatchForm] = useState<BatchForm>(emptyBatchForm())
  const [batchFormError, setBatchFormError] = useState('')
  const [batchFormLoading, setBatchFormLoading] = useState(false)

  // Edit batch modal
  const [showEditBatchForm, setShowEditBatchForm] = useState(false)
  const [editingBatch, setEditingBatch] = useState<Batch | null>(null)
  const [editBatchForm, setEditBatchForm] = useState<EditBatchForm>({
    purchaseRate: '', purchaseGstPct: '', rateIncludesGst: false,
    warehouseId: '', supplierId: '',
    receivedDate: '', receivedQty: '', notes: '', isActive: true
  })
  const [editBatchFormError, setEditBatchFormError] = useState('')
  const [editBatchFormLoading, setEditBatchFormLoading] = useState(false)

  // ─── Data Loading ──────────────────────────────────────────────────────────

  const loadProducts = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const qs = statusFilter === 'all' ? '' : `?isActive=${statusFilter === 'active'}`
      const data = await apiFetch<{ products: Product[] }>(`/api/v1/products${qs}`, token)
      setProducts(data.products)
    } catch {
      setError('Failed to load products.')
    } finally {
      setLoading(false)
    }
  }, [token, statusFilter])

  /** Brands are reloaded on their own after inline creation from the product form. */
  const loadBrands = useCallback(async () => {
    try {
      const data = await apiFetch<{ brands: Brand[] }>('/api/v1/brands?includeInactive=1', token)
      setBrands(data.brands)
    } catch { /* non-fatal */ }
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
    await loadBrands()
  }, [token, loadBrands])

  useEffect(() => {
    loadProducts()
    loadMeta()
  }, [loadProducts, loadMeta])

  // ─── Product CRUD ──────────────────────────────────────────────────────────

  /** A product that already has stock history can never change its item code. */
  const isProductUsed = (p: Product) => p.batchCount > 0 || p.totalStock > 0

  const openAddProduct = () => {
    setEditingProductId(null)
    setItemCodeLocked(false)
    setProductForm(emptyProductForm())
    setProductFormError('')
    setShowProductForm(true)
  }

  const openEditProduct = (p: Product, e: React.MouseEvent) => {
    e.stopPropagation()
    setEditingProductId(p.id)
    setItemCodeLocked(isProductUsed(p))
    const warranty = splitWarranty(p.warrantyPeriodDays)
    const mode: SellMode = p.sellMode === 'LENGTH' ? 'LENGTH' : 'UNIT'
    setProductForm({
      itemCode: p.itemCode, brandId: p.brandId || '', name: p.name,
      hsnCode: p.hsnCode || '',
      specification: p.specification || '', categoryId: p.categoryId,
      productType: p.productType || '',
      unitOfMeasure: measuresFor(mode).includes(p.unitOfMeasure)
        ? p.unitOfMeasure
        : defaultMeasureFor(mode),
      sellMode: mode,
      sellingRate: String(p.sellingRate),
      gstPercentage: String(p.gstPercentage),
      warrantyValue: warranty.value,
      warrantyUnit: warranty.unit,
      minStockLevel: formatQty(p.minStockLevel)
    })
    setProductFormError('')
    setShowProductForm(true)
  }

  const handleSuggestItemCode = async () => {
    setSuggestingCode(true)
    setProductFormError('')
    try {
      const qs = new URLSearchParams()
      if (productForm.categoryId) qs.set('categoryId', productForm.categoryId)
      if (productForm.brandId) qs.set('brandId', productForm.brandId)
      const data = await apiFetch<{ itemCode: string }>(
        `/api/v1/system/suggest-item-code?${qs.toString()}`, token
      )
      // The server generates these, so they arrive already in shape.
      setProductForm((f) => ({ ...f, itemCode: data.itemCode }))
    } catch (err: unknown) {
      const e = err as { data?: { message?: string } }
      setProductFormError(e.data?.message || 'Could not suggest an item code.')
    } finally {
      setSuggestingCode(false)
    }
  }

  const handleSaveProduct = async () => {
    const codeCheck = validateItemCode(productForm.itemCode)
    if (!codeCheck.ok) {
      setProductFormError(codeCheck.message)
      return
    }
    const nameCheck = validateName(productForm.name, 'Product name')
    if (!nameCheck.ok) {
      setProductFormError(nameCheck.message)
      return
    }
    if (!productForm.categoryId) {
      setProductFormError('Category is required.')
      return
    }
    setProductFormLoading(true)
    setProductFormError('')
    try {
      const body = {
        itemCode: codeCheck.value,
        // null clears the brand server-side; an id is resolved to the master row.
        brandId: productForm.brandId || null,
        name: nameCheck.value,
        specification: productForm.specification,
        categoryId: productForm.categoryId,
        productType: productForm.productType,
        unitOfMeasure: productForm.unitOfMeasure,
        sellMode: productForm.sellMode,
        sellingRate: parseFloat(productForm.sellingRate) || 0,
        gstPercentage: parseFloat(productForm.gstPercentage) || 0,
        hsnCode: productForm.hsnCode.trim(),
        warrantyPeriodDays: warrantyToDays(productForm.warrantyValue, productForm.warrantyUnit),
        minStockLevel: parseQty(productForm.minStockLevel, productForm.sellMode)
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
      const e = err as { data?: { error?: string; message?: string } }
      if (e.data?.error === 'ITEM_CODE_LOCKED') {
        // The server is the authority — lock the field and restore the saved code.
        setItemCodeLocked(true)
        setProductFormError(e.data.message || 'Item code can no longer be changed for this product.')
      } else if (e.data?.error === 'ITEM_CODE_EXISTS') {
        setProductFormError(e.data.message || 'Item code already exists.')
      } else if (e.data?.error === 'BRAND_NOT_FOUND') {
        // The brand list is stale — refresh it so the picker matches the server.
        await loadBrands()
        setProductFormError(e.data.message || 'That brand no longer exists. Pick another one.')
      } else {
        setProductFormError(e.data?.message || 'Failed to save product.')
      }
    } finally {
      setProductFormLoading(false)
    }
  }

  // ─── Deactivate / Reactivate / Hard delete ─────────────────────────────────

  const askDeactivate = (p: Product, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setConfirmTarget(p)
    setConfirmMode('deactivate')
    setConfirmError('')
    setConfirmOfferDeactivate(false)
  }

  const askHardDelete = (p: Product, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setConfirmTarget(p)
    setConfirmMode('hard')
    setConfirmError('')
    setConfirmOfferDeactivate(false)
  }

  const closeConfirm = () => {
    setConfirmTarget(null)
    setConfirmError('')
    setConfirmOfferDeactivate(false)
  }

  const runDeactivate = async (p: Product) => {
    setConfirmLoading(true)
    setConfirmError('')
    try {
      await apiFetch(`/api/v1/products/${p.id}`, token, { method: 'DELETE' })
      closeConfirm()
      if (detailProduct?.id === p.id) setDetailProduct(null)
      await loadProducts()
    } catch (err: unknown) {
      const e = err as { data?: { message?: string } }
      setConfirmError(e.data?.message || 'Failed to deactivate product.')
    } finally {
      setConfirmLoading(false)
    }
  }

  const runHardDelete = async (p: Product) => {
    setConfirmLoading(true)
    setConfirmError('')
    try {
      await apiFetch(`/api/v1/products/${p.id}?hard=1`, token, { method: 'DELETE' })
      closeConfirm()
      if (detailProduct?.id === p.id) setDetailProduct(null)
      await loadProducts()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      if (e.data?.error === 'PRODUCT_IN_USE') {
        setConfirmError(e.data.message || 'This product has stock or sales history and cannot be deleted.')
        setConfirmOfferDeactivate(true)
      } else {
        setConfirmError(e.data?.message || 'Failed to delete product.')
      }
    } finally {
      setConfirmLoading(false)
    }
  }

  const handleReactivate = async (p: Product, e?: React.MouseEvent) => {
    e?.stopPropagation()
    setError('')
    try {
      await apiFetch(`/api/v1/products/${p.id}`, token, {
        method: 'PUT',
        body: JSON.stringify({ isActive: true })
      })
      await loadProducts()
      if (detailProduct?.id === p.id) {
        const fresh = await apiFetch<{ product: Product }>(`/api/v1/products/${p.id}`, token)
        setDetailProduct(fresh.product)
      }
    } catch (err: unknown) {
      const e2 = err as { data?: { message?: string } }
      setError(e2.data?.message || 'Failed to reactivate product.')
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

  // ─── Brand CRUD ────────────────────────────────────────────────────────────

  const openAddBrand = () => {
    setEditingBrandId(null); setBrandName(''); setBrandFormError(''); setShowBrandForm(true)
  }
  const openEditBrand = (b: Brand) => {
    setEditingBrandId(b.id); setBrandName(b.name); setBrandFormError(''); setShowBrandForm(true)
  }

  const handleSaveBrand = async () => {
    const check = validateName(brandName, 'Brand name')
    if (!check.ok) {
      setBrandFormError(check.message)
      return
    }
    setBrandFormLoading(true)
    setBrandFormError('')
    try {
      if (!editingBrandId) {
        await apiFetch('/api/v1/brands', token, {
          method: 'POST', body: JSON.stringify({ name: check.value })
        })
      } else {
        await apiFetch(`/api/v1/brands/${editingBrandId}`, token, {
          method: 'PUT', body: JSON.stringify({ name: check.value })
        })
      }
      setShowBrandForm(false)
      await loadBrands()
      // A rename rewrites the denormalised name on every product.
      if (editingBrandId) await loadProducts()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      setBrandFormError(
        e.data?.error === 'BRAND_NAME_EXISTS'
          ? e.data.message || 'A brand with this name already exists.'
          : e.data?.message || 'Failed to save brand.'
      )
    } finally {
      setBrandFormLoading(false)
    }
  }

  /** Inline "+ Add brand" from the product form — returns the new brand to select. */
  const createBrandInline = async (
    name: string
  ): Promise<{ ok: true; brand: Brand } | { ok: false; message: string }> => {
    const check = validateName(name, 'Brand name')
    if (!check.ok) return { ok: false, message: check.message }
    try {
      const data = await apiFetch<{ brand: { id: string; name: string; isActive: boolean } }>(
        '/api/v1/brands', token,
        { method: 'POST', body: JSON.stringify({ name: check.value }) }
      )
      await loadBrands()
      return { ok: true, brand: { ...data.brand, productCount: 0 } }
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      if (e.data?.error === 'BRAND_NAME_EXISTS') {
        // It already exists — reload and hand back the matching row so the
        // picker still ends up on the brand the user asked for.
        try {
          const data = await apiFetch<{ brands: Brand[] }>('/api/v1/brands?includeInactive=1', token)
          setBrands(data.brands)
          const match = data.brands.find(
            (b) => b.name.toLowerCase() === check.value.toLowerCase()
          )
          if (match) return { ok: true, brand: match }
        } catch { /* fall through to the message below */ }
      }
      return { ok: false, message: e.data?.message || 'Failed to add brand.' }
    }
  }

  const askDeleteBrand = (b: Brand) => {
    setBrandConfirmTarget(b)
    setBrandConfirmError('')
    setBrandOfferDeactivate(false)
  }

  const closeBrandConfirm = () => {
    setBrandConfirmTarget(null)
    setBrandConfirmError('')
    setBrandOfferDeactivate(false)
  }

  const runDeleteBrand = async (b: Brand) => {
    setBrandConfirmLoading(true)
    setBrandConfirmError('')
    try {
      await apiFetch(`/api/v1/brands/${b.id}`, token, { method: 'DELETE' })
      closeBrandConfirm()
      await loadBrands()
    } catch (err: unknown) {
      const e = err as { data?: { error?: string; message?: string } }
      if (e.data?.error === 'BRAND_IN_USE') {
        setBrandConfirmError(e.data.message || 'Products still use this brand.')
        setBrandOfferDeactivate(true)
      } else {
        setBrandConfirmError(e.data?.message || 'Failed to delete brand.')
      }
    } finally {
      setBrandConfirmLoading(false)
    }
  }

  const setBrandActive = async (b: Brand, isActive: boolean) => {
    setBrandConfirmLoading(true)
    setBrandConfirmError('')
    try {
      await apiFetch(`/api/v1/brands/${b.id}`, token, {
        method: 'PUT', body: JSON.stringify({ isActive })
      })
      closeBrandConfirm()
      await loadBrands()
    } catch (err: unknown) {
      const e = err as { data?: { message?: string } }
      setBrandConfirmError(e.data?.message || 'Failed to update brand.')
    } finally {
      setBrandConfirmLoading(false)
    }
  }

  // ─── Batch / Restock ───────────────────────────────────────────────────────

  const openAddBatch = async (p: Product) => {
    setBatchTargetProduct(p)
    setBatchFormError('')
    const form = emptyBatchForm(p.gstPercentage)
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
    const qty = parseQty(batchForm.receivedQty, batchTargetProduct.sellMode)
    if (qty <= 0) {
      setBatchFormError('Received qty must be greater than zero.')
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
          purchaseGstPct: parseFloat(batchForm.purchaseGstPct) || 0,
          rateIncludesGst: batchForm.rateIncludesGst,
          receivedQty: qty,
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
      // The stored rate is ex-GST, so the form opens on the "Excl. GST" basis.
      purchaseRate: String(b.purchaseRate),
      purchaseGstPct: String(b.purchaseGstPct || detailProduct?.gstPercentage || 0),
      rateIncludesGst: false,
      warehouseId: b.warehouseId || '',
      supplierId: b.supplierId || '',
      receivedDate: b.receivedDate ? new Date(b.receivedDate).toISOString().slice(0, 10) : '',
      receivedQty: formatQty(b.receivedQty),
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
          purchaseGstPct: parseFloat(editBatchForm.purchaseGstPct) || 0,
          rateIncludesGst: editBatchForm.rateIncludesGst,
          warehouseId: editBatchForm.warehouseId || null,
          supplierId: editBatchForm.supplierId || null,
          receivedDate: editBatchForm.receivedDate || null,
          receivedQty: editBatchForm.receivedQty
            ? parseQty(editBatchForm.receivedQty, detailProduct?.sellMode)
            : undefined,
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

  // ─── Confirm Modal (shared by list + detail views) ─────────────────────────

  const confirmModal = (
    <Modal
      open={confirmTarget !== null}
      onClose={closeConfirm}
      title={confirmMode === 'hard' ? 'Delete Product Permanently' : 'Deactivate Product'}
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          {confirmMode === 'hard' ? (
            <>
              Permanently delete <span className="font-bold">{confirmTarget?.name}</span>? This cannot be undone.
            </>
          ) : (
            <>
              Deactivate <span className="font-bold">{confirmTarget?.name}</span>? It will stay on past bills
              and can be reactivated later.
            </>
          )}
        </p>
        {confirmError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
            {confirmError}
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={closeConfirm} disabled={confirmLoading}>Cancel</Button>
          {confirmOfferDeactivate ? (
            <Button
              onClick={() => confirmTarget && runDeactivate(confirmTarget)}
              disabled={confirmLoading}
              className="gap-2"
            >
              <Archive className="w-3.5 h-3.5" />
              {confirmLoading ? 'Working…' : 'Deactivate instead'}
            </Button>
          ) : (
            <Button
              onClick={() => confirmTarget && (confirmMode === 'hard' ? runHardDelete(confirmTarget) : runDeactivate(confirmTarget))}
              disabled={confirmLoading}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {confirmLoading
                ? 'Working…'
                : confirmMode === 'hard' ? 'Delete Permanently' : 'Deactivate'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )

  // ─── Brand Confirm Modal ───────────────────────────────────────────────────

  const brandConfirmModal = (
    <Modal
      open={brandConfirmTarget !== null}
      onClose={closeBrandConfirm}
      title="Delete Brand"
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-sm text-zinc-700">
          Permanently delete <span className="font-bold">{brandConfirmTarget?.name}</span>?
          This cannot be undone.
        </p>
        {brandConfirmError && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-xs">
            {brandConfirmError}
          </div>
        )}
        <div className="flex gap-3 justify-end">
          <Button variant="outline" onClick={closeBrandConfirm} disabled={brandConfirmLoading}>Cancel</Button>
          {brandOfferDeactivate ? (
            <Button
              onClick={() => brandConfirmTarget && setBrandActive(brandConfirmTarget, false)}
              disabled={brandConfirmLoading}
              className="gap-2"
            >
              <Archive className="w-3.5 h-3.5" />
              {brandConfirmLoading ? 'Working…' : 'Deactivate instead'}
            </Button>
          ) : (
            <Button
              onClick={() => brandConfirmTarget && runDeleteBrand(brandConfirmTarget)}
              disabled={brandConfirmLoading}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {brandConfirmLoading ? 'Working…' : 'Delete Permanently'}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )

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
            <h1 className="text-xl font-bold flex items-center gap-2">
              {p.name}
              {!p.isActive && <InactiveBadge />}
            </h1>
            <p className="text-sm text-muted-foreground font-mono">{p.itemCode}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={(e) => openEditProduct(p, e)} className="gap-2">
              <Edit2 className="w-3.5 h-3.5" /> Edit
            </Button>
            {p.isActive ? (
              <Button variant="outline" onClick={(e) => askDeactivate(p, e)} className="gap-2">
                <Archive className="w-3.5 h-3.5" /> Deactivate
              </Button>
            ) : (
              <Button variant="outline" onClick={(e) => handleReactivate(p, e)} className="gap-2">
                <RotateCcw className="w-3.5 h-3.5" /> Reactivate
              </Button>
            )}
            {!isProductUsed(p) && (
              <Button
                variant="outline"
                onClick={(e) => askHardDelete(p, e)}
                className="gap-2 text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Delete permanently
              </Button>
            )}
            <Button onClick={() => openAddBatch(p)} className="gap-2">
              <Plus className="w-4 h-4" /> Add Batch / Restock
            </Button>
          </div>
        </div>

        {/* KPI Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Total Stock</p>
            <p className="text-2xl font-bold">{formatQty(p.totalStock)} <span className="text-sm font-normal text-muted-foreground">{p.unitOfMeasure}</span></p>
          </div>
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Selling Rate</p>
            <p className="text-2xl font-bold">₹{p.sellingRate.toFixed(2)}</p>
            {margin && <p className={`text-xs font-medium mt-0.5 ${parseFloat(margin) < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{margin}% margin on ex-GST cost</p>}
          </div>
          <div className="p-4 rounded-xl border bg-card">
            <p className="text-xs text-muted-foreground font-medium mb-1">Cost (ex-GST)</p>
            <p className="text-2xl font-bold">₹{p.latestBatch ? p.latestBatch.purchaseRate.toFixed(2) : '—'}</p>
            {p.latestBatch && (
              <p className="text-xs text-muted-foreground mt-0.5">
                Landed ₹{p.latestBatch.purchaseRateInclGst.toFixed(2)} incl. {p.latestBatch.purchaseGstPct}% GST
              </p>
            )}
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
          <div>
            <span className="text-muted-foreground">Sold as:</span>{' '}
            <span className="font-medium">
              {isLengthMode(p.sellMode) ? `Cut to length (${p.unitOfMeasure})` : `Whole units (${p.unitOfMeasure})`}
            </span>
          </div>
          <div><span className="text-muted-foreground">Warranty:</span> <span className="font-medium">{formatWarranty(p.warrantyPeriodDays)}</span></div>
          <div><span className="text-muted-foreground">Min Stock:</span> <span className="font-medium">{formatQtyWithUnit(p.minStockLevel, p.unitOfMeasure)}</span></div>
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
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600">Cost (ex-GST)</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600">Landed</th>
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
                      <span className="font-medium">₹{b.purchaseRateInclGst.toFixed(2)}</span>
                      <span className="block text-xs text-muted-foreground">
                        incl. {b.purchaseGstPct}% GST (₹{b.purchaseGstAmount.toFixed(2)})
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-semibold ${b.currentQty === 0 ? 'text-red-600' : 'text-zinc-900'}`}>
                        {formatQtyWithUnit(b.currentQty, p.unitOfMeasure)}
                      </span>
                      <span className="block text-xs text-muted-foreground">of {formatQtyWithUnit(b.receivedQty, p.unitOfMeasure)}</span>
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
            sellMode={batchTargetProduct?.sellMode ?? 'UNIT'}
            unitOfMeasure={batchTargetProduct?.unitOfMeasure ?? 'pcs'}
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
            sellMode={p.sellMode}
            unitOfMeasure={p.unitOfMeasure}
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
            brands={brands}
            onCreateBrand={createBrandInline}
            error={productFormError}
            loading={productFormLoading}
            isEdit={true}
            itemCodeLocked={itemCodeLocked}
            suggesting={suggestingCode}
            onSuggestItemCode={handleSuggestItemCode}
            onSave={handleSaveProduct}
            onCancel={() => setShowProductForm(false)}
          />
        </Modal>

        {confirmModal}
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
        {(['products', 'categories', 'brands'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize ${tab === t ? 'border-zinc-900 text-zinc-900' : 'border-transparent text-muted-foreground hover:text-zinc-700'}`}
          >
            {t === 'categories'
              ? <span className="flex items-center gap-1.5"><Tag className="w-3.5 h-3.5" /> Categories</span>
              : t === 'brands'
                ? <span className="flex items-center gap-1.5"><Bookmark className="w-3.5 h-3.5" /> Brands</span>
                : 'Products'}
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
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All Statuses</option>
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
                        {statusFilter === 'active'
                          ? 'No active products found. Switch the status filter to see inactive ones.'
                          : 'No products found.'}
                      </td>
                    </tr>
                  ) : (
                    filtered.map((p) => (
                      <tr
                        key={p.id}
                        onClick={() => setDetailProduct(p)}
                        className={`hover:bg-zinc-50/70 transition-colors cursor-pointer ${p.isActive ? '' : 'bg-zinc-50/60'}`}
                      >
                        <td className="px-4 py-3">
                          <p className="font-medium text-zinc-900 flex items-center gap-2">
                            {p.name}
                            {!p.isActive && <InactiveBadge />}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono mt-0.5">
                            {p.itemCode}{p.brand ? ` · ${p.brand}` : ''}
                          </p>
                          {p.specification && <p className="text-xs text-muted-foreground mt-0.5 max-w-[260px] truncate">{p.specification}</p>}
                        </td>
                        <td className="px-4 py-3 text-zinc-600">{p.category.name}</td>
                        <td className="px-4 py-3 text-right font-medium text-zinc-900">
                          ₹{p.sellingRate.toFixed(2)}
                          <span className="text-xs font-normal text-muted-foreground"> / {p.unitOfMeasure}</span>
                          {p.batchCount > 1 && (
                            <span className="block text-xs text-muted-foreground">{p.batchCount} batches</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <StockBadge qty={p.totalStock} min={p.minStockLevel} uom={p.unitOfMeasure} />
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
                            {p.isActive ? (
                              <button
                                type="button"
                                onClick={(e) => askDeactivate(p, e)}
                                className="p-1.5 rounded-md hover:bg-amber-50 hover:text-amber-600 transition-colors text-zinc-400"
                                title="Deactivate"
                              >
                                <Archive className="w-3.5 h-3.5" />
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => handleReactivate(p, e)}
                                className="p-1.5 rounded-md hover:bg-emerald-50 hover:text-emerald-600 transition-colors text-zinc-400"
                                title="Reactivate"
                              >
                                <RotateCcw className="w-3.5 h-3.5" />
                              </button>
                            )}
                            {!isProductUsed(p) && (
                              <button
                                type="button"
                                onClick={(e) => askHardDelete(p, e)}
                                className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 transition-colors text-zinc-400"
                                title="Delete permanently"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            )}
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
            {filtered.length} {statusFilter === 'all' ? '' : `${statusFilter} `}product{filtered.length !== 1 ? 's' : ''}
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

      {/* ── Brands Tab ─────────────────────────────────────────────────── */}
      {tab === 'brands' && (
        <>
          <div className="flex justify-end mb-4">
            <Button onClick={openAddBrand} className="gap-2" size="sm">
              <Plus className="w-4 h-4" /> Add Brand
            </Button>
          </div>
          <div className="rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-zinc-600">Brand Name</th>
                  <th className="text-right px-4 py-3 font-semibold text-zinc-600">Products</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {brands.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-10 text-center text-muted-foreground text-sm">No brands yet.</td>
                  </tr>
                ) : (
                  brands.map((b) => (
                    <tr key={b.id} className={`hover:bg-zinc-50/70 ${b.isActive ? '' : 'bg-zinc-50/60'}`}>
                      <td className="px-4 py-3 font-medium text-zinc-900">
                        <span className="flex items-center gap-2">
                          {b.name}
                          {!b.isActive && <InactiveBadge />}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-zinc-600">{b.productCount}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button type="button" onClick={() => openEditBrand(b)} className="p-1.5 rounded-md hover:bg-zinc-200 text-zinc-400" title="Rename"><Edit2 className="w-3.5 h-3.5" /></button>
                          {b.isActive ? (
                            <button
                              type="button"
                              onClick={() => setBrandActive(b, false)}
                              className="p-1.5 rounded-md hover:bg-amber-50 hover:text-amber-600 text-zinc-400"
                              title="Deactivate"
                            >
                              <Archive className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setBrandActive(b, true)}
                              className="p-1.5 rounded-md hover:bg-emerald-50 hover:text-emerald-600 text-zinc-400"
                              title="Reactivate"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button type="button" onClick={() => askDeleteBrand(b)} className="p-1.5 rounded-md hover:bg-red-50 hover:text-red-600 text-zinc-400" title="Delete"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Renaming a brand updates it on every product that uses it.
          </p>
        </>
      )}

      {/* Add/Edit Product Modal */}
      <Modal open={showProductForm} onClose={() => setShowProductForm(false)} title={editingProductId ? 'Edit Product' : 'Add Product'} size="lg">
        <ProductFormFields
          form={productForm}
          onChange={setProductForm}
          categories={categories}
          brands={brands}
          onCreateBrand={createBrandInline}
          error={productFormError}
          loading={productFormLoading}
          isEdit={!!editingProductId}
          itemCodeLocked={itemCodeLocked}
          suggesting={suggestingCode}
          onSuggestItemCode={handleSuggestItemCode}
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

      {/* Add/Edit Brand Modal */}
      <Modal open={showBrandForm} onClose={() => setShowBrandForm(false)} title={editingBrandId ? 'Rename Brand' : 'Add Brand'} size="sm">
        <div className="space-y-4">
          {brandFormError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{brandFormError}</div>
          )}
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Brand Name</label>
            <Input value={brandName} onChange={(e) => setBrandName(e.target.value)} placeholder="e.g. Finolex" className="h-11" autoFocus />
            {editingBrandId && (
              <p className="text-xs text-muted-foreground mt-1 ml-1">
                Renaming updates the brand on every product that uses it.
              </p>
            )}
          </div>
          <div className="flex justify-end gap-3 pt-2 border-t">
            <Button variant="outline" onClick={() => setShowBrandForm(false)}>Cancel</Button>
            <Button onClick={handleSaveBrand} disabled={brandFormLoading}>
              {brandFormLoading ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </Modal>

      {confirmModal}
      {brandConfirmModal}
    </div>
  )
}

// ─── ProductFormFields ────────────────────────────────────────────────────────

function ProductFormFields({
  form, onChange, categories, brands, onCreateBrand, error, loading, isEdit, itemCodeLocked,
  suggesting, onSuggestItemCode, onSave, onCancel
}: {
  form: ProductForm
  onChange: (f: ProductForm) => void
  categories: Category[]
  brands: Brand[]
  onCreateBrand: (name: string) => Promise<{ ok: true; brand: Brand } | { ok: false; message: string }>
  error: string
  loading: boolean
  isEdit: boolean
  itemCodeLocked: boolean
  suggesting: boolean
  onSuggestItemCode: () => void
  onSave: () => void
  onCancel: () => void
}) {
  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) =>
    onChange({ ...form, [key]: value })

  const [addingBrand, setAddingBrand] = useState(false)
  const [newBrandName, setNewBrandName] = useState('')
  const [newBrandError, setNewBrandError] = useState('')
  const [newBrandLoading, setNewBrandLoading] = useState(false)

  // The code is checked as it is typed, but never rewritten: it goes on
  // receipts and batch labels, so it should be the code the person meant.
  // Nothing is said until they have typed enough for a verdict to be fair,
  // and where there is an obvious valid form of what they typed it is offered
  // as something to accept rather than applied behind them.
  const codeTouched = form.itemCode.trim().length >= 2
  const codeCheck = validateItemCode(form.itemCode)
  const codeProblem = !itemCodeLocked && codeTouched && !codeCheck.ok ? codeCheck.message : ''
  const codeFix = codeProblem ? suggestItemCodeFix(form.itemCode) : null

  // Blank is allowed — a shop can trade before it files — so only say
  // something once there is something wrong with what was typed.
  const hsnCheck = validateHsn(form.hsnCode)
  const hsnProblem = form.hsnCode.trim() && !hsnCheck.ok ? hsnCheck.message : ''

  const submitNewBrand = async () => {
    setNewBrandLoading(true)
    setNewBrandError('')
    const res = await onCreateBrand(newBrandName)
    setNewBrandLoading(false)
    if (!res.ok) {
      setNewBrandError(res.message)
      return
    }
    onChange({ ...form, brandId: res.brand.id })
    setAddingBrand(false)
    setNewBrandName('')
  }

  /**
   * Switching mode swaps the unit list, so a unit that no longer makes sense
   * (m on a whole-unit product) falls back to that mode's default.
   */
  const setSellMode = (mode: SellMode) => {
    const allowed = measuresFor(mode)
    onChange({
      ...form,
      sellMode: mode,
      unitOfMeasure: allowed.includes(form.unitOfMeasure)
        ? form.unitOfMeasure
        : defaultMeasureFor(mode)
    })
  }

  // An inactive brand still on this product stays selectable so an edit
  // doesn't silently drop it.
  const brandOptions = brands.filter((b) => b.isActive || b.id === form.brandId)

  return (
    <div className="space-y-5">
      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-600 text-sm">{error}</div>}

      <div>
        <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-3">Basic Info</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Item Code *</label>
            <div className="flex gap-2">
              <Input
                value={form.itemCode}
                onChange={(e) => set('itemCode', e.target.value)}
                placeholder="e.g. FIN-WIRE-1.5-RED"
                className={`h-11 flex-1 font-mono ${codeProblem ? 'border-red-400 focus-visible:ring-red-300' : ''}`}
                disabled={itemCodeLocked}
                aria-invalid={codeProblem ? true : undefined}
                aria-describedby="item-code-hint"
              />
              {!isEdit && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onSuggestItemCode}
                  disabled={suggesting}
                  className="h-11 shrink-0 gap-1.5"
                >
                  <Wand2 className="w-3.5 h-3.5" /> {suggesting ? '...' : 'Suggest'}
                </Button>
              )}
            </div>
            {codeProblem ? (
              <div className="mt-1 ml-1 space-y-1" id="item-code-hint">
                <p className="text-xs text-red-600">{codeProblem}</p>
                {codeFix && (
                  <button
                    type="button"
                    onClick={() => set('itemCode', codeFix)}
                    className="text-xs font-medium text-zinc-700 underline underline-offset-2 hover:text-zinc-900 font-mono"
                  >
                    Use {codeFix}
                  </button>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground mt-1 ml-1" id="item-code-hint">
                {itemCodeLocked ? 'Locked — this product already has stock or sales history' : ITEM_CODE_HINT}
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Brand</label>
            {addingBrand ? (
              <div className="flex gap-2">
                <Input
                  value={newBrandName}
                  onChange={(e) => setNewBrandName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitNewBrand() } }}
                  placeholder="New brand name"
                  className="h-11 flex-1"
                  autoFocus
                />
                <Button type="button" onClick={submitNewBrand} disabled={newBrandLoading} className="h-11 shrink-0">
                  {newBrandLoading ? '...' : 'Add'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setAddingBrand(false); setNewBrandName(''); setNewBrandError('') }}
                  className="h-11 shrink-0"
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <select
                  value={form.brandId}
                  onChange={(e) => set('brandId', e.target.value)}
                  className="flex-1 h-11 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="">— No brand —</option>
                  {brandOptions.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}{b.isActive ? '' : ' (inactive)'}</option>
                  ))}
                </select>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => { setAddingBrand(true); setNewBrandError('') }}
                  className="h-11 shrink-0 gap-1.5"
                >
                  <Plus className="w-3.5 h-3.5" /> Add brand
                </Button>
              </div>
            )}
            {newBrandError && <p className="text-xs text-red-600 mt-1 ml-1">{newBrandError}</p>}
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
              {measuresFor(form.sellMode).map((u) => (
                <option key={u} value={u}>{u}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3">
          <label className="block text-sm font-semibold mb-1.5 ml-1">Sold as</label>
          <Segmented<SellMode>
            value={form.sellMode}
            onChange={setSellMode}
            options={[
              { value: 'UNIT', label: 'Whole units' },
              { value: 'LENGTH', label: 'Cut to length' }
            ]}
          />
          <p className="text-xs text-muted-foreground mt-1 ml-1">
            {isLengthMode(form.sellMode)
              ? `Stock is tracked as one total length in ${form.unitOfMeasure} and can be billed in fractions — e.g. 2.75 ${form.unitOfMeasure} off a coil.`
              : `Stock is counted in whole ${form.unitOfMeasure} — quantities can't be fractional.`}
          </p>
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
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">HSN code</label>
          <Input
            value={form.hsnCode}
            onChange={(e) => set('hsnCode', e.target.value)}
            placeholder="e.g. 8544"
            className={`h-11 font-mono ${hsnProblem ? 'border-red-400 focus-visible:ring-red-300' : ''}`}
            aria-invalid={hsnProblem ? true : undefined}
          />
          {hsnProblem ? (
            <p className="text-xs text-red-600 mt-1 ml-1">{hsnProblem}</p>
          ) : (
            <p className="text-xs text-muted-foreground mt-1 ml-1">
              4, 6 or 8 digits. Needed to file a GST return — a product without one is
              reported as missing when the return is prepared.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Warranty</label>
            <div className="flex gap-2">
              <Input
                type="number"
                min="0"
                value={form.warrantyValue}
                onChange={(e) => set('warrantyValue', e.target.value)}
                className="h-11 flex-1"
              />
              <select
                value={form.warrantyUnit}
                onChange={(e) => set('warrantyUnit', e.target.value as WarrantyUnit)}
                className="h-11 w-28 shrink-0 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="days">Days</option>
                <option value="months">Months</option>
                <option value="years">Years</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-1">
              {formatWarranty(warrantyToDays(form.warrantyValue, form.warrantyUnit))}
              {form.warrantyUnit !== 'days' && warrantyToDays(form.warrantyValue, form.warrantyUnit) > 0
                ? ` · stored as ${warrantyToDays(form.warrantyValue, form.warrantyUnit)} days`
                : ''}
            </p>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Min Stock Level</label>
            <div className="relative">
              <Input
                type="number"
                min="0"
                step={qtyStep(form.sellMode)}
                value={form.minStockLevel}
                onChange={(e) => set('minStockLevel', e.target.value)}
                className="h-11 pr-14"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{form.unitOfMeasure}</span>
            </div>
            <p className="text-xs text-muted-foreground mt-1 ml-1">
              Low-stock warning below {formatQtyWithUnit(parseQty(form.minStockLevel, form.sellMode), form.unitOfMeasure)}
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-3 pt-2 border-t">
        <Button variant="outline" onClick={onCancel}>Cancel</Button>
        {/* A code that would be rejected shouldn't cost a round trip to find out. */}
        <Button onClick={onSave} disabled={loading || Boolean(codeProblem)}>
          {loading ? 'Saving...' : 'Save Product'}
        </Button>
      </div>
    </div>
  )
}

// ─── BatchFormFields ──────────────────────────────────────────────────────────

function BatchFormFields({
  form, onChange, sellMode, unitOfMeasure, suppliers, warehouses, error, loading, onSave, onCancel
}: {
  form: BatchForm
  onChange: (f: BatchForm) => void
  sellMode: SellMode
  unitOfMeasure: string
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

      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Purchase Rate *</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
              <Input type="number" min="0" step="0.01" value={form.purchaseRate} onChange={(e) => set('purchaseRate', e.target.value)} className="h-11 pl-7" placeholder="0.00" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">Rate basis</label>
            <Segmented<'ex' | 'incl'>
              value={form.rateIncludesGst ? 'incl' : 'ex'}
              onChange={(v) => set('rateIncludesGst', v === 'incl')}
              options={[{ value: 'ex', label: 'Excl. GST' }, { value: 'incl', label: 'Incl. GST' }]}
              className="h-11"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold mb-1.5 ml-1">GST %</label>
            <div className="relative">
              <Input type="number" min="0" max="28" step="0.5" value={form.purchaseGstPct} onChange={(e) => set('purchaseGstPct', e.target.value)} className="h-11 pr-8" />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Received Qty *</label>
          <div className="relative">
            <Input
              type="number"
              min="0"
              step={qtyStep(sellMode)}
              value={form.receivedQty}
              onChange={(e) => set('receivedQty', e.target.value)}
              className="h-11 pr-14"
              placeholder="0"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{unitOfMeasure}</span>
          </div>
        </div>

        <PurchaseCostReadout
          rate={form.purchaseRate}
          gstPct={form.purchaseGstPct}
          includesGst={form.rateIncludesGst}
          qty={parseQty(form.receivedQty, sellMode)}
          uom={unitOfMeasure}
        />
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
  purchaseGstPct: string
  rateIncludesGst: boolean
  warehouseId: string; supplierId: string
  receivedDate: string; receivedQty: string
  notes: string; isActive: boolean
}

function EditBatchFormFields({
  form, onChange, sellMode, unitOfMeasure, warehouses, suppliers, error, loading, onSave, onCancel
}: {
  form: EditBatchForm
  onChange: (f: EditBatchForm) => void
  sellMode: SellMode
  unitOfMeasure: string
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
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Purchase Rate *</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">₹</span>
            <Input type="number" min="0" step="0.01" value={form.purchaseRate} onChange={(e) => set('purchaseRate', e.target.value)} className="h-11 pl-7" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">Rate basis</label>
          <Segmented<'ex' | 'incl'>
            value={form.rateIncludesGst ? 'incl' : 'ex'}
            onChange={(v) => set('rateIncludesGst', v === 'incl')}
            options={[{ value: 'ex', label: 'Excl. GST' }, { value: 'incl', label: 'Incl. GST' }]}
            className="h-11"
          />
        </div>
        <div>
          <label className="block text-sm font-semibold mb-1.5 ml-1">GST %</label>
          <div className="relative">
            <Input type="number" min="0" max="28" step="0.5" value={form.purchaseGstPct} onChange={(e) => set('purchaseGstPct', e.target.value)} className="h-11 pr-8" />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </div>
      </div>

      {/* Qty */}
      <div>
        <label className="block text-sm font-semibold mb-1.5 ml-1">Received Qty</label>
        <div className="relative">
          <Input
            type="number"
            min="0"
            step={qtyStep(sellMode)}
            value={form.receivedQty}
            onChange={(e) => set('receivedQty', e.target.value)}
            className="h-11 pr-14"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">{unitOfMeasure}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1 ml-1">
          Total qty received in this batch — changing it shifts the remaining stock by the same amount.
        </p>
      </div>

      <PurchaseCostReadout
        rate={form.purchaseRate}
        gstPct={form.purchaseGstPct}
        includesGst={form.rateIncludesGst}
        qty={parseQty(form.receivedQty, sellMode)}
        uom={unitOfMeasure}
      />

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
