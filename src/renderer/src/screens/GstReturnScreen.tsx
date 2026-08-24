import React, { useState, useEffect, useCallback, useMemo } from 'react'
import axios from 'axios'
import {
  FileText,
  RefreshCw,
  Download,
  AlertTriangle,
  Info,
  CheckCircle2,
  ChevronRight
} from 'lucide-react'
import { Button } from '../components/ui/button'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

// ─── Types ────────────────────────────────────────────────────────────────────

type RateBucket = {
  rate: number
  taxableValue: number
  igst: number
  cgst: number
  sgst: number
}

type Invoice = {
  invoiceNumber: string
  invoiceDate: string
  invoiceValue: number
  placeOfSupply: string | null
  items: RateBucket[]
}

type CreditNote = Invoice & { againstInvoice: string | null }

type Gstr1 = {
  gstin: string | null
  fp: string
  periodLabel: string
  b2b: { ctin: string; customerName: string; invoices: Invoice[] }[]
  b2cl: { pos: string; invoices: Invoice[] }[]
  b2cs: {
    supplyType: 'INTER' | 'INTRA'
    pos: string | null
    rate: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
  }[]
  cdnr: { ctin: string; customerName: string; notes: CreditNote[] }[]
  cdnur: CreditNote[]
  hsn: {
    hsnCode: string
    description: string
    uqc: string
    quantity: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
  }[]
  documents: { from: string; to: string; total: number; cancelled: number }[]
  totals: {
    invoiceCount: number
    creditNoteCount: number
    taxableValue: number
    igst: number
    cgst: number
    sgst: number
    totalTax: number
  }
  readiness: { blocking: string[]; warnings: string[] }
}

// ─── Formatting ───────────────────────────────────────────────────────────────

const fmt = (n: number): string =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

/** GST state codes a shop is likely to see. Anything else shows its number. */
const STATES: Record<string, string> = {
  '27': 'Maharashtra', '29': 'Karnataka', '32': 'Kerala', '33': 'Tamil Nadu',
  '36': 'Telangana', '37': 'Andhra Pradesh', '24': 'Gujarat', '06': 'Haryana',
  '07': 'Delhi', '09': 'Uttar Pradesh', '19': 'West Bengal', '23': 'Madhya Pradesh',
  '08': 'Rajasthan', '03': 'Punjab', '10': 'Bihar', '21': 'Odisha'
}
const stateName = (code: string | null): string =>
  code ? `${STATES[code] ?? 'State'} (${code})` : '—'

function Section({
  title,
  count,
  hint,
  children
}: {
  title: string
  count: number
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-zinc-50 transition-colors"
      >
        <ChevronRight
          className={`w-4 h-4 text-zinc-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-zinc-900">{title}</p>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span className="text-sm font-semibold tabular-nums text-zinc-700 shrink-0">{count}</span>
      </button>
      {open && <div className="border-t">{children}</div>}
    </section>
  )
}

function RateRows({ items }: { items: RateBucket[] }): React.JSX.Element {
  return (
    <>
      {items.map((it) => (
        <span key={it.rate} className="text-xs text-muted-foreground mr-3">
          {it.rate}% on ₹{fmt(it.taxableValue)}
        </span>
      ))}
    </>
  )
}

// ─── Screen ───────────────────────────────────────────────────────────────────

/**
 * The GST return for a month, before it is filed.
 *
 * Deliberately a review screen and not a one-click export. Everything on it
 * was computed from bills that already exist, so there is nothing to enter —
 * what there is to do is *look*, particularly at what the return says is
 * missing. Filing a return nobody read is how a wrong one gets filed.
 */
export function GstReturnScreen({ token }: { token: string | null }): React.JSX.Element {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [report, setReport] = useState<Gstr1 | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const headers = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {}
    if (token) h.Authorization = `Bearer ${token}`
    return h
  }, [token])

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError('')
    setSaved('')
    try {
      const res = await axios.get(
        `${LOCAL_API}/api/v1/reports/gstr1?month=${month}&year=${year}`,
        { headers }
      )
      setReport(res.data.report)
    } catch {
      setError('Could not reach the local server. Check that it is running, then refresh.')
    } finally {
      setLoading(false)
    }
  }, [token, headers, month, year])

  useEffect(() => {
    void load()
  }, [load])

  async function saveFiling(): Promise<void> {
    if (!report) return
    setSaved('')
    try {
      const res = await axios.get(
        `${LOCAL_API}/api/v1/reports/gstr1?month=${month}&year=${year}&format=portal`,
        { headers }
      )
      const out = (await window.electron.ipcRenderer.invoke('gst:save-return', {
        filename: `GSTR1-${report.fp}.json`,
        contents: JSON.stringify(res.data.filing, null, 2)
      })) as { ok: boolean; path?: string; canceled?: boolean; error?: string }
      if (out.ok && out.path) setSaved(`Saved to ${out.path}`)
      else if (!out.canceled) setError(out.error ?? 'Could not save the file.')
    } catch {
      setError('Could not prepare the filing.')
    }
  }

  const blocking = report?.readiness.blocking ?? []
  const warnings = report?.readiness.warnings ?? []
  const years = [now.getFullYear(), now.getFullYear() - 1, now.getFullYear() - 2]

  return (
    <div className="space-y-6">
      <div className="border-b pb-4 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <FileText className="w-7 h-7" /> GST return
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            GSTR-1 for one month, built from the bills already recorded. Check it, then save
            the file for the portal.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm"
          >
            {MONTHS.map((m, i) => (
              <option key={m} value={i + 1}>{m}</option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="h-10 rounded-lg border border-input bg-background px-3 text-sm tabular-nums"
          >
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Building…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
          {error}
        </div>
      )}

      {report && (
        <>
          {/* What would make the filing wrong, before anything else. */}
          {blocking.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50/60 p-5">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600" />
                <h2 className="text-sm font-bold text-red-900">
                  Fix before filing
                </h2>
              </div>
              <ul className="space-y-1.5 pl-6 list-disc marker:text-red-400">
                {blocking.map((b) => (
                  <li key={b} className="text-sm text-red-900">{b}</li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="rounded-xl border bg-card p-5">
              <div className="flex items-center gap-2 mb-2">
                <Info className="w-4 h-4 text-zinc-400" />
                <h2 className="text-sm font-bold text-zinc-700">Worth knowing</h2>
              </div>
              <ul className="space-y-1.5 pl-6 list-disc marker:text-zinc-300">
                {warnings.map((w) => (
                  <li key={w} className="text-sm text-muted-foreground">{w}</li>
                ))}
              </ul>
            </div>
          )}
          {blocking.length === 0 && warnings.length === 0 && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-4 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <p className="text-sm text-emerald-900">
                Nothing in this period would make the return incorrect.
              </p>
            </div>
          )}

          {/* The figures that get filed. */}
          <div className="rounded-xl border bg-card p-5">
            <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
              <h2 className="text-sm font-bold text-zinc-700">
                {report.periodLabel} · GSTIN {report.gstin ?? 'not set'}
              </h2>
              <p className="text-xs text-muted-foreground font-mono">
                Period {report.fp}
              </p>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                ['Taxable value', report.totals.taxableValue],
                ['IGST', report.totals.igst],
                ['CGST', report.totals.cgst],
                ['SGST', report.totals.sgst]
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                    {label}
                  </p>
                  <p className="text-xl font-bold mt-1 tabular-nums">₹{fmt(Number(value))}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t flex items-baseline justify-between">
              <p className="text-sm text-muted-foreground">
                {report.totals.invoiceCount} invoice
                {report.totals.invoiceCount === 1 ? '' : 's'}
                {report.totals.creditNoteCount > 0 &&
                  `, less ${report.totals.creditNoteCount} credit note${report.totals.creditNoteCount === 1 ? '' : 's'}`}
              </p>
              <p className="text-sm font-bold">Total tax ₹{fmt(report.totals.totalTax)}</p>
            </div>
          </div>

          {/* The sections, each openable rather than all shouting at once. */}
          <div className="space-y-3">
            <Section
              title="B2B — registered buyers"
              hint="Named invoice by invoice, so the buyer can claim the credit"
              count={report.b2b.reduce((s, g) => s + g.invoices.length, 0)}
            >
              <div className="divide-y">
                {report.b2b.map((g) => (
                  <div key={g.ctin} className="px-5 py-3">
                    <p className="text-sm font-semibold text-zinc-900">{g.customerName}</p>
                    <p className="text-xs font-mono text-muted-foreground mb-2">{g.ctin}</p>
                    {g.invoices.map((inv) => (
                      <div key={inv.invoiceNumber} className="flex items-baseline justify-between py-1">
                        <span className="text-sm font-mono">{inv.invoiceNumber}</span>
                        <span className="text-xs text-muted-foreground flex-1 px-3">
                          <RateRows items={inv.items} />
                        </span>
                        <span className="text-sm tabular-nums">₹{fmt(inv.invoiceValue)}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {report.b2b.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    No sales to registered buyers this period.
                  </p>
                )}
              </div>
            </Section>

            <Section
              title="B2C — everybody else"
              hint="Summed by state and tax rate, not listed invoice by invoice"
              count={report.b2cs.length}
            >
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 border-b">
                  <tr>
                    <th className="text-left px-5 py-2 text-xs font-semibold text-zinc-600 uppercase">Supply</th>
                    <th className="text-left px-3 py-2 text-xs font-semibold text-zinc-600 uppercase">Place</th>
                    <th className="text-right px-3 py-2 text-xs font-semibold text-zinc-600 uppercase">Rate</th>
                    <th className="text-right px-5 py-2 text-xs font-semibold text-zinc-600 uppercase">Taxable</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {report.b2cs.map((row) => (
                    <tr key={`${row.supplyType}-${row.pos}-${row.rate}`}>
                      <td className="px-5 py-2">{row.supplyType === 'INTRA' ? 'In state' : 'Inter-state'}</td>
                      <td className="px-3 py-2 text-muted-foreground">{stateName(row.pos)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{row.rate}%</td>
                      <td className="px-5 py-2 text-right tabular-nums">₹{fmt(row.taxableValue)}</td>
                    </tr>
                  ))}
                  {report.b2cs.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-5 py-4 text-sm text-muted-foreground">
                        No counter sales this period.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Section>

            {report.b2cl.length > 0 && (
              <Section
                title="B2C large — inter-state, over ₹2.5 lakh"
                hint="Named individually even though the buyer is unregistered"
                count={report.b2cl.reduce((s, g) => s + g.invoices.length, 0)}
              >
                <div className="divide-y">
                  {report.b2cl.map((g) => (
                    <div key={g.pos} className="px-5 py-3">
                      <p className="text-xs text-muted-foreground mb-1">{stateName(g.pos)}</p>
                      {g.invoices.map((inv) => (
                        <div key={inv.invoiceNumber} className="flex items-baseline justify-between py-1">
                          <span className="text-sm font-mono">{inv.invoiceNumber}</span>
                          <span className="text-sm tabular-nums">₹{fmt(inv.invoiceValue)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section
              title="Credit notes"
              hint="Sales that were given back — these reduce the month"
              count={
                report.cdnr.reduce((s, g) => s + g.notes.length, 0) + report.cdnur.length
              }
            >
              <div className="divide-y">
                {[
                  ...report.cdnr.flatMap((g) =>
                    g.notes.map((n) => ({ ...n, who: g.customerName }))
                  ),
                  ...report.cdnur.map((n) => ({ ...n, who: 'Walk-in' }))
                ].map((n) => (
                  <div key={n.invoiceNumber} className="px-5 py-2.5 flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-mono">{n.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {n.who}
                        {n.againstInvoice && ` · against ${n.againstInvoice}`}
                      </p>
                    </div>
                    <span className="text-sm tabular-nums shrink-0">−₹{fmt(n.invoiceValue)}</span>
                  </div>
                ))}
                {report.cdnr.length === 0 && report.cdnur.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted-foreground">
                    Nothing was returned this period.
                  </p>
                )}
              </div>
            </Section>

            <Section
              title="HSN summary"
              hint="Every line of the month, grouped by classification code"
              count={report.hsn.length}
            >
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 border-b">
                    <tr>
                      <th className="text-left px-5 py-2 text-xs font-semibold text-zinc-600 uppercase">HSN</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-zinc-600 uppercase">Description</th>
                      <th className="text-left px-3 py-2 text-xs font-semibold text-zinc-600 uppercase">Unit</th>
                      <th className="text-right px-3 py-2 text-xs font-semibold text-zinc-600 uppercase">Qty</th>
                      <th className="text-right px-5 py-2 text-xs font-semibold text-zinc-600 uppercase">Taxable</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {report.hsn.map((h) => (
                      <tr key={`${h.hsnCode}-${h.uqc}`}>
                        <td className="px-5 py-2 font-mono">{h.hsnCode}</td>
                        <td className="px-3 py-2 text-muted-foreground">{h.description}</td>
                        <td className="px-3 py-2 font-mono text-xs">{h.uqc}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{h.quantity}</td>
                        <td className="px-5 py-2 text-right tabular-nums">₹{fmt(h.taxableValue)}</td>
                      </tr>
                    ))}
                    {report.hsn.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-5 py-4 text-sm text-muted-foreground">
                          Nothing to summarise.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section
              title="Document series"
              hint="Which numbers were issued, and how many were cancelled"
              count={report.documents.length}
            >
              <div className="divide-y">
                {report.documents.map((d) => (
                  <div key={d.from} className="px-5 py-2.5 flex items-baseline justify-between">
                    <span className="text-sm font-mono">{d.from} → {d.to}</span>
                    <span className="text-xs text-muted-foreground">
                      {d.total} issued{d.cancelled > 0 && `, ${d.cancelled} cancelled`}
                    </span>
                  </div>
                ))}
                {report.documents.length === 0 && (
                  <p className="px-5 py-4 text-sm text-muted-foreground">No documents issued.</p>
                )}
              </div>
            </Section>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap pt-2">
            <p className="text-xs text-muted-foreground max-w-xl">
              Covers sales, credit notes, the HSN summary and the document series. It does not
              cover exports, SEZ supplies, advances received, reverse charge, or amendments to a
              previous period — a shop doing any of those needs more than this file.
            </p>
            <Button onClick={saveFiling} className="gap-2 shrink-0">
              <Download className="w-4 h-4" /> Save filing for the portal
            </Button>
          </div>
          {saved && (
            <p className="text-sm text-emerald-700 flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4" /> {saved}
            </p>
          )}
        </>
      )}
    </div>
  )
}
