import React, { useState, useEffect, useCallback } from 'react'
import axios from 'axios'
import {
  TrendingUp,
  TrendingDown,
  ShoppingCart,
  Receipt,
  Tag,
  BarChart3,
  RefreshCw,
  Package,
  CreditCard,
  Banknote,
  Smartphone,
} from 'lucide-react'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'http://127.0.0.1:52001'

type Period = 'today' | 'week' | 'month' | 'year' | 'all'

type TopProduct = {
  productId: string
  productName: string
  itemCode: string
  totalQty: number
  totalRevenue: number
}

type AnalyticsSummary = {
  period: Period
  totalBills: number
  totalRevenue: number
  avgBillValue: number
  totalDiscounts: number
  totalLineDiscounts: number
  totalBillDiscounts: number
  discountPct: number
  estimatedCOGS: number
  estimatedGrossProfit: number
  estimatedMarginPct: number
  hasCOGSData: boolean
  paymentBreakdown: { CASH: number; UPI: number; CARD: number }
  paymentCounts: { CASH: number; UPI: number; CARD: number }
  topProducts: TopProduct[]
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

const fmtInt = (n: number) => new Intl.NumberFormat('en-IN').format(n)

const PERIOD_LABELS: Record<Period, string> = {
  today: 'Today',
  week: 'This Week',
  month: 'This Month',
  year: 'This Year',
  all: 'All Time',
}

export function AnalyticsScreen({ token }: { token: string | null }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>('today')
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchSummary = useCallback(
    async (p: Period) => {
      if (!token) return
      setLoading(true)
      setError('')
      try {
        const res = await axios.get(`${LOCAL_API}/api/v1/analytics/summary?period=${p}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        setSummary(res.data.summary)
      } catch {
        setError('Failed to load analytics data.')
      } finally {
        setLoading(false)
      }
    },
    [token],
  )

  useEffect(() => {
    fetchSummary(period)
  }, [period, fetchSummary])

  const handlePeriodChange = (p: Period) => {
    setPeriod(p)
  }

  // Payment bar widths
  const totalPaymentAmt = summary
    ? summary.paymentBreakdown.CASH + summary.paymentBreakdown.UPI + summary.paymentBreakdown.CARD
    : 0
  const cashPct = totalPaymentAmt > 0 ? (summary!.paymentBreakdown.CASH / totalPaymentAmt) * 100 : 0
  const upiPct = totalPaymentAmt > 0 ? (summary!.paymentBreakdown.UPI / totalPaymentAmt) * 100 : 0
  const cardPct = totalPaymentAmt > 0 ? (summary!.paymentBreakdown.CARD / totalPaymentAmt) * 100 : 0

  const topRevProduct = summary?.topProducts[0]
  const topRevAmt = topRevProduct?.totalRevenue ?? 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="border-b pb-4 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Sales performance, revenue, discounts &amp; margins.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fetchSummary(period)}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-medium text-zinc-600 hover:bg-zinc-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Period selector */}
      <div className="flex gap-1 p-1 bg-zinc-100 rounded-lg w-fit">
        {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => handlePeriodChange(p)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${
              period === p
                ? 'bg-white shadow-sm text-zinc-900'
                : 'text-zinc-500 hover:text-zinc-700'
            }`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
          {error}
        </div>
      )}

      {loading && !summary && (
        <div className="flex items-center gap-2 text-zinc-400 text-sm py-8">
          <div className="w-4 h-4 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
          Loading analytics…
        </div>
      )}

      {summary && (
        <>
          {/* Primary metric cards */}
          <div className="grid grid-cols-4 gap-4">
            {/* Revenue */}
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Total Revenue
                </p>
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center">
                  <TrendingUp className="w-4 h-4 text-emerald-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">₹{fmt(summary.totalRevenue)}</p>
              <p className="text-xs text-zinc-400 mt-1">{PERIOD_LABELS[period]}</p>
            </div>

            {/* Bills */}
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Total Bills
                </p>
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                  <Receipt className="w-4 h-4 text-blue-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">{fmtInt(summary.totalBills)}</p>
              <p className="text-xs text-zinc-400 mt-1">
                Avg ₹{fmt(summary.avgBillValue)} / bill
              </p>
            </div>

            {/* Discounts */}
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Total Discounts
                </p>
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                  <Tag className="w-4 h-4 text-amber-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">₹{fmt(summary.totalDiscounts)}</p>
              <p className="text-xs text-zinc-400 mt-1">
                {summary.discountPct.toFixed(1)}% of gross revenue
              </p>
            </div>

            {/* Cart items count */}
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Items Sold
                </p>
                <div className="w-8 h-8 rounded-lg bg-purple-50 flex items-center justify-center">
                  <ShoppingCart className="w-4 h-4 text-purple-600" />
                </div>
              </div>
              <p className="text-2xl font-bold text-zinc-900">
                {fmtInt(summary.topProducts.reduce((s, p) => s + p.totalQty, 0))}
              </p>
              <p className="text-xs text-zinc-400 mt-1">Units across {summary.topProducts.length} products</p>
            </div>
          </div>

          {/* Second row — Margin + Discount breakdown */}
          <div className="grid grid-cols-2 gap-4">
            {/* Margin estimate */}
            <div className={`p-5 rounded-xl border shadow-sm ${summary.hasCOGSData ? 'bg-card' : 'bg-zinc-50'}`}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                    Estimated Gross Profit
                  </p>
                  {!summary.hasCOGSData && (
                    <p className="text-xs text-zinc-400 mt-0.5">
                      No purchase price data available yet
                    </p>
                  )}
                  {summary.hasCOGSData && (
                    <p className="text-xs text-zinc-400 mt-0.5">
                      Based on current purchase prices
                    </p>
                  )}
                </div>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${summary.estimatedMarginPct >= 0 ? 'bg-emerald-50' : 'bg-red-50'}`}>
                  {summary.estimatedMarginPct >= 0 ? (
                    <TrendingUp className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-red-600" />
                  )}
                </div>
              </div>
              {summary.hasCOGSData ? (
                <div className="grid grid-cols-3 gap-3">
                  <div className="p-3 rounded-lg bg-zinc-50 border">
                    <p className="text-xs text-zinc-500 mb-1">Est. COGS</p>
                    <p className="text-base font-bold text-zinc-700">₹{fmt(summary.estimatedCOGS)}</p>
                  </div>
                  <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-100">
                    <p className="text-xs text-zinc-500 mb-1">Est. Profit</p>
                    <p className={`text-base font-bold ${summary.estimatedGrossProfit >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      ₹{fmt(summary.estimatedGrossProfit)}
                    </p>
                  </div>
                  <div className="p-3 rounded-lg bg-zinc-50 border">
                    <p className="text-xs text-zinc-500 mb-1">Margin %</p>
                    <p className={`text-base font-bold ${summary.estimatedMarginPct >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                      {summary.estimatedMarginPct.toFixed(1)}%
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-zinc-400 italic">
                  Add purchase batches with purchase rate to enable margin tracking.
                </p>
              )}
            </div>

            {/* Discount breakdown */}
            <div className="p-5 rounded-xl bg-card border shadow-sm">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-4">
                Discount Breakdown
              </p>
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                    <span className="text-sm text-zinc-700">Line-item discounts</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-zinc-900">
                      ₹{fmt(summary.totalLineDiscounts)}
                    </span>
                    {summary.totalDiscounts > 0 && (
                      <span className="text-xs text-zinc-400 ml-2">
                        ({((summary.totalLineDiscounts / summary.totalDiscounts) * 100).toFixed(0)}%)
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-orange-400" />
                    <span className="text-sm text-zinc-700">Bill-level discounts</span>
                  </div>
                  <div className="text-right">
                    <span className="text-sm font-semibold text-zinc-900">
                      ₹{fmt(summary.totalBillDiscounts)}
                    </span>
                    {summary.totalDiscounts > 0 && (
                      <span className="text-xs text-zinc-400 ml-2">
                        ({((summary.totalBillDiscounts / summary.totalDiscounts) * 100).toFixed(0)}%)
                      </span>
                    )}
                  </div>
                </div>
                <div className="border-t pt-2 flex items-center justify-between">
                  <span className="text-sm font-semibold text-zinc-700">Total discounts given</span>
                  <span className="text-sm font-bold text-zinc-900">₹{fmt(summary.totalDiscounts)}</span>
                </div>
                {summary.totalRevenue > 0 && (
                  <div className="mt-1 h-2 bg-zinc-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-amber-400 rounded-full transition-all"
                      style={{ width: `${Math.min(summary.discountPct, 100)}%` }}
                    />
                  </div>
                )}
                {summary.totalRevenue > 0 && (
                  <p className="text-xs text-zinc-400">
                    Discounts are {summary.discountPct.toFixed(1)}% of gross revenue
                    (₹{fmt(summary.totalRevenue + summary.totalDiscounts)})
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Payment breakdown + Top products */}
          <div className="grid grid-cols-5 gap-4">
            {/* Payment breakdown */}
            <div className="col-span-2 p-5 rounded-xl bg-card border shadow-sm">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide mb-4">
                Payment Methods
              </p>
              {summary.totalBills === 0 ? (
                <p className="text-sm text-zinc-400 italic">No bills yet.</p>
              ) : (
                <div className="space-y-4">
                  {/* Stacked bar */}
                  <div className="h-3 bg-zinc-100 rounded-full overflow-hidden flex">
                    {cashPct > 0 && (
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${cashPct}%` }}
                      />
                    )}
                    {upiPct > 0 && (
                      <div
                        className="h-full bg-blue-500 transition-all"
                        style={{ width: `${upiPct}%` }}
                      />
                    )}
                    {cardPct > 0 && (
                      <div
                        className="h-full bg-purple-500 transition-all"
                        style={{ width: `${cardPct}%` }}
                      />
                    )}
                  </div>

                  <div className="space-y-3">
                    {/* CASH */}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center shrink-0">
                        <Banknote className="w-3.5 h-3.5 text-emerald-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-zinc-700">Cash</span>
                          <span className="text-sm font-semibold text-zinc-900">
                            ₹{fmt(summary.paymentBreakdown.CASH)}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400">
                          {summary.paymentCounts.CASH} bill{summary.paymentCounts.CASH !== 1 ? 's' : ''} · {cashPct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                    {/* UPI */}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
                        <Smartphone className="w-3.5 h-3.5 text-blue-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-zinc-700">UPI</span>
                          <span className="text-sm font-semibold text-zinc-900">
                            ₹{fmt(summary.paymentBreakdown.UPI)}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400">
                          {summary.paymentCounts.UPI} bill{summary.paymentCounts.UPI !== 1 ? 's' : ''} · {upiPct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                    {/* CARD */}
                    <div className="flex items-center gap-3">
                      <div className="w-7 h-7 rounded-lg bg-purple-50 flex items-center justify-center shrink-0">
                        <CreditCard className="w-3.5 h-3.5 text-purple-600" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-zinc-700">Card</span>
                          <span className="text-sm font-semibold text-zinc-900">
                            ₹{fmt(summary.paymentBreakdown.CARD)}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400">
                          {summary.paymentCounts.CARD} bill{summary.paymentCounts.CARD !== 1 ? 's' : ''} · {cardPct.toFixed(1)}%
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Top products */}
            <div className="col-span-3 p-5 rounded-xl bg-card border shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-zinc-400" />
                <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
                  Top Products by Revenue
                </p>
              </div>
              {summary.topProducts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <Package className="w-8 h-8 text-zinc-300 mb-2" />
                  <p className="text-sm text-zinc-400">No sales data yet.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {summary.topProducts.map((prod) => {
                    const pct = topRevAmt > 0 ? (prod.totalRevenue / topRevAmt) * 100 : 0
                    return (
                      <div key={prod.productId}>
                        <div className="flex items-center justify-between mb-0.5">
                          <div className="flex-1 min-w-0 mr-4">
                            <span className="text-sm font-medium text-zinc-800 truncate block">
                              {prod.productName}
                            </span>
                            <span className="text-xs text-zinc-400">{prod.itemCode} · {fmtInt(prod.totalQty)} units</span>
                          </div>
                          <span className="text-sm font-semibold text-zinc-900 shrink-0">
                            ₹{fmt(prod.totalRevenue)}
                          </span>
                        </div>
                        <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-zinc-800 rounded-full transition-all"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
