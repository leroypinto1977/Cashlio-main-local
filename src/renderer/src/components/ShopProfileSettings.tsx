import React, { useCallback, useEffect, useState } from 'react'
import { Building2, Check, Loader2 } from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'
import {
  validateName,
  validateContactNumber,
  validateGstin,
  stateCodeOf
} from '@shared/validation'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

type Profile = {
  shopName: string
  branchName: string
  address: string | null
  phone: string | null
  gstin: string | null
  stateCode: string | null
}

type Form = { shopName: string; branchName: string; address: string; phone: string; gstin: string }
type Errors = Partial<Record<keyof Form, string>>

const empty: Form = { shopName: '', branchName: '', address: '', phone: '', gstin: '' }

/**
 * The shop's own details. These print on every invoice, and the GSTIN decides
 * whether a sale is taxed as CGST+SGST or IGST — so this screen is not
 * cosmetic, and it is validated as strictly as the customer records are.
 */
export function ShopProfileSettings({ token }: { token: string | null }): React.JSX.Element {
  const [form, setForm] = useState<Form>(empty)
  const [errors, setErrors] = useState<Errors>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [formError, setFormError] = useState('')

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/system/shop-profile`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) {
        const p: Profile = data.profile
        setForm({
          shopName: p.shopName ?? '',
          branchName: p.branchName ?? '',
          address: p.address ?? '',
          phone: p.phone ?? '',
          gstin: p.gstin ?? ''
        })
      }
    } catch {
      setFormError('Could not load the shop profile.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = k === 'gstin' ? e.target.value.toUpperCase() : e.target.value
    setForm((f) => ({ ...f, [k]: value }))
    setErrors((prev) => ({ ...prev, [k]: undefined }))
    setSaved(false)
  }

  const validateAll = (): Errors => {
    const next: Errors = {}
    const shop = validateName(form.shopName, 'Shop name')
    if (!shop.ok) next.shopName = shop.message
    const branch = validateName(form.branchName, 'Branch name')
    if (!branch.ok) next.branchName = branch.message
    const phone = validateContactNumber(form.phone, { required: false })
    if (!phone.ok) next.phone = phone.message
    const gstin = validateGstin(form.gstin)
    if (!gstin.ok) next.gstin = gstin.message
    return next
  }

  const handleBlur = (k: keyof Form) => () => {
    const all = validateAll()
    setErrors((prev) => ({ ...prev, [k]: all[k] }))
  }

  const handleSave = async (): Promise<void> => {
    const next = validateAll()
    setErrors(next)
    if (Object.values(next).some(Boolean)) return

    setSaving(true)
    setFormError('')
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/system/shop-profile`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form)
      })
      const data = await res.json()
      if (!data.success) {
        setFormError(data.message || 'Could not save the shop profile.')
        return
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2500)
    } catch {
      setFormError('Could not reach the local server.')
    } finally {
      setSaving(false)
    }
  }

  const derivedState = stateCodeOf(form.gstin)

  const field = (
    key: keyof Form,
    label: string,
    placeholder: string,
    extra?: { mono?: boolean; hint?: string }
  ): React.JSX.Element => (
    <div>
      <label className="block text-xs font-semibold text-zinc-600 mb-1.5">{label}</label>
      <Input
        value={form[key]}
        onChange={set(key)}
        onBlur={handleBlur(key)}
        placeholder={placeholder}
        className={`h-10 ${extra?.mono ? 'font-mono' : ''}`}
      />
      {errors[key] ? (
        <p className="text-xs text-red-600 mt-1">{errors[key]}</p>
      ) : extra?.hint ? (
        <p className="text-xs text-zinc-400 mt-1">{extra.hint}</p>
      ) : null}
    </div>
  )

  return (
    <div className="p-5 rounded-xl border bg-card">
      <div className="flex items-center gap-2 mb-1">
        <Building2 className="w-4 h-4 text-zinc-500" />
        <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Shop Details</p>
      </div>
      <p className="text-xs text-zinc-400 mb-4">
        Printed at the top of every bill. The GSTIN also sets your state, which decides whether a
        sale is charged as CGST + SGST or IGST.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4">
            {field('shopName', 'Shop name', 'Sharma Electricals')}
            {field('branchName', 'Branch name', 'Main Branch')}
            <div className="col-span-2">
              {field('address', 'Address', '12 MG Road, Pune 411001')}
            </div>
            {field('phone', 'Phone', '98765 43210')}
            {field('gstin', 'GSTIN', '27ABCDE1234F1Z0', {
              mono: true,
              hint: derivedState
                ? `State code ${derivedState} — sales to other states will be charged IGST.`
                : 'Optional. Without it, bills print as a receipt rather than a tax invoice.'
            })}
          </div>

          {formError && (
            <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">
              {formError}
            </div>
          )}

          <div className="mt-5 flex items-center gap-3">
            <Button onClick={handleSave} disabled={saving} className="gap-2">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
            {saved && (
              <span className="flex items-center gap-1.5 text-sm text-emerald-600 font-medium">
                <Check className="w-4 h-4" /> Saved
              </span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
