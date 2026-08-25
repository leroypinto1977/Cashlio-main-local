import React, { useState, useEffect, useCallback } from 'react'
import { Printer as PrinterIcon, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react'
import { Button } from './ui/button'
import {
  PAPER_WIDTHS,
  listPrinters,
  printReceipt,
  readPrinterSettings,
  writePrinterSettings,
  type PaperWidth,
  type Printer
} from '../lib/receipt'

/**
 * Where this counter's receipts go.
 *
 * The setting is per-machine, not per-shop: the printer is plugged into this
 * counter. Choosing one turns printing silent — the receipt goes straight to
 * the roll instead of stopping at the OS dialog, which is a click and a wait
 * on every single sale.
 *
 * Nothing here can be trusted until it has printed once, so the test print is
 * part of the setting rather than an afterthought. A thermal receipt that
 * comes out with the edges shaved off or a hand's width of blank paper after
 * it is a paper-size problem, and the only way to see that is to look at it.
 */
export function ReceiptPrinterSettings(): React.JSX.Element {
  const [printers, setPrinters] = useState<Printer[]>([])
  const [deviceName, setDeviceName] = useState('')
  const [paperWidthMm, setPaperWidthMm] = useState<PaperWidth>(80)
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setPrinters(await listPrinters())
    setLoading(false)
  }, [])

  useEffect(() => {
    const saved = readPrinterSettings()
    setDeviceName(saved.deviceName)
    setPaperWidthMm(saved.paperWidthMm)
    void refresh()
  }, [refresh])

  const save = (next: { deviceName?: string; paperWidthMm?: PaperWidth }): void => {
    const merged = {
      deviceName: next.deviceName ?? deviceName,
      paperWidthMm: next.paperWidthMm ?? paperWidthMm
    }
    setDeviceName(merged.deviceName)
    setPaperWidthMm(merged.paperWidthMm)
    writePrinterSettings(merged)
    setResult(null)
  }

  const testPrint = async (): Promise<void> => {
    setTesting(true)
    setResult(null)
    // A real receipt rather than a test page, because the thing being checked
    // is whether a real receipt fits — the widest line here is the one that
    // would be clipped in the shop.
    const res = await printReceipt(
      { name: 'Test Print', address: 'Checking the roll width and the cut', phone: '—' },
      {
        billNumber: 'TEST-0000',
        paymentMethod: 'CASH',
        totalAmount: 118,
        subtotal: 118,
        gstAmount: 18,
        taxableValue: 100,
        cgstAmount: 9,
        sgstAmount: 9,
        amountReceived: 120,
        changeGiven: 2,
        items: [
          {
            itemCode: 'TEST-ITEM-0001',
            productName: 'A product with a deliberately long name',
            quantity: 1,
            unitRate: 118,
            lineTotal: 118,
            gstPercentage: 18,
            taxableValue: 100,
            cgstAmount: 9,
            sgstAmount: 9
          }
        ]
      },
      { copyLabel: 'TEST', paperWidthMm }
    )
    setTesting(false)
    setResult(
      res.ok
        ? { ok: true, message: 'Sent. Check the paper: no clipped edges, and the cut just past the last line.' }
        : { ok: false, message: res.error || 'The printer refused the job.' }
    )
  }

  const noPrinters = !loading && printers.length === 0

  return (
    <div className="p-5 rounded-xl border bg-card space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide flex items-center gap-1.5">
            <PrinterIcon className="w-3.5 h-3.5" /> Counter printer
          </p>
          <p className="text-sm text-muted-foreground mt-1">
            Set this and receipts go straight to the roll. Leave it unset and every
            sale stops at the print dialog.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5" htmlFor="printer-device">
          Printer
        </label>
        <select
          id="printer-device"
          value={deviceName}
          onChange={(e) => save({ deviceName: e.target.value })}
          className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">Ask me every time (print dialog)</option>
          {printers.map((p) => (
            <option key={p.name} value={p.name}>
              {p.displayName}
              {p.isDefault ? ' — system default' : ''}
            </option>
          ))}
        </select>
        {noPrinters && (
          <p className="text-xs text-amber-700 mt-1.5 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            This machine can see no printers. Connect the counter printer and install its
            driver, then refresh.
          </p>
        )}
        {/* A printer that was chosen and later unplugged still needs saying. */}
        {!loading && deviceName !== '' && !printers.some((p) => p.name === deviceName) && (
          <p className="text-xs text-amber-700 mt-1.5 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              <span className="font-mono">{deviceName}</span> is set here but this machine
              cannot see it now. Receipts will fail until it is back, or another is chosen.
            </span>
          </p>
        )}
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">Paper</label>
        <div className="flex gap-2">
          {PAPER_WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => save({ paperWidthMm: w })}
              className={`flex-1 h-11 rounded-md border text-sm font-medium transition-colors ${
                paperWidthMm === w
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-background hover:bg-zinc-50'
              }`}
            >
              {w}mm roll
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground mt-1.5">
          The width printed on the box the rolls came in. The page is cut to the length of
          each receipt, so short bills do not feed a strip of blank paper.
        </p>
      </div>

      <div className="pt-1">
        <Button variant="outline" className="w-full" onClick={() => void testPrint()} disabled={testing}>
          {testing ? 'Printing…' : 'Print a test receipt'}
        </Button>
        {result && (
          <p
            className={`text-xs mt-2 flex items-start gap-1.5 ${result.ok ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {result.ok ? (
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            )}
            {result.message}
          </p>
        )}
      </div>
    </div>
  )
}
