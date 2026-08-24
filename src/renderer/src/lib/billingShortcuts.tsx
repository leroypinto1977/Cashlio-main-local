import React, { useEffect, useCallback } from 'react'

/**
 * The keyboard layer for a till.
 *
 * A queue does not wait for a mouse. Everything on the common path — scan, fix
 * a quantity, take the money, save — has a key, and the keys are on screen: an
 * undiscoverable shortcut is not a shortcut.
 *
 * Function keys and Alt combinations only, deliberately. A cashier types
 * product names and amounts all day, so a bare letter or digit can never be a
 * command. The one exception is Escape, which everybody already expects to
 * back out of whatever is open.
 *
 * Shared between the manager's billing screen and the terminal's, because a
 * cashier who learns the keys on one till should not have to relearn them at
 * the next counter.
 */

export type BillingShortcutHandlers = {
  /** True while a modal owns the keyboard. Only Escape reaches past one. */
  modalOpen: boolean
  /** True while the quantity prompt is up. */
  pendingProduct: boolean
  /** True while the search dropdown is showing. */
  dropdownOpen: boolean
  lineCount: number
  /** -1 means "the last line", which is what a cashier almost always means. */
  selectedLine: number
  setSelectedLine: (idx: number) => void

  focusSearch: () => void
  focusAmount: () => void
  cancelPending: () => void
  closeDropdown: () => void
  openCustomer: () => void
  /** Step the given line's quantity. The caller knows the step for its mode. */
  stepQuantity: (idx: number, direction: 1 | -1) => void
  removeLine: (idx: number) => void
  /** Save the bill. Must be a no-op when the Collect button would be disabled. */
  collect: () => void
  canCollect: boolean
}

/** What a key press means, decided without touching the DOM. */
export type ShortcutAction =
  | { type: 'none' }
  | { type: 'focus-search' }
  | { type: 'focus-amount' }
  | { type: 'open-customer' }
  | { type: 'collect' }
  | { type: 'cancel-pending' }
  | { type: 'close-dropdown' }
  | { type: 'select-line'; index: number }
  | { type: 'step-quantity'; index: number; direction: 1 | -1 }
  | { type: 'remove-line'; index: number }

export type ShortcutState = {
  modalOpen: boolean
  pendingProduct: boolean
  dropdownOpen: boolean
  lineCount: number
  /** -1 means "the last line". */
  selectedLine: number
  canCollect: boolean
}

/**
 * The whole keyboard layer, as a function of a key press and what is on
 * screen. Pure, so the rules can be checked without a browser — and so the
 * rules are one thing to read rather than a switch buried in an effect.
 */
export function resolveShortcut(
  key: string,
  altKey: boolean,
  s: ShortcutState
): ShortcutAction {
  if (key === 'Escape') {
    // A modal owns Escape; it closes itself.
    if (s.modalOpen) return { type: 'none' }
    if (s.pendingProduct) return { type: 'cancel-pending' }
    if (s.dropdownOpen) return { type: 'close-dropdown' }
    return { type: 'focus-search' }
  }
  if (s.modalOpen) return { type: 'none' }

  switch (key) {
    case 'F2':
      return { type: 'focus-search' }
    case 'F4':
      return { type: 'open-customer' }
    case 'F6':
      return { type: 'focus-amount' }
    case 'F9':
      // Guarded the same way the button is, so a key can never submit a bill
      // the button would have refused.
      return s.canCollect ? { type: 'collect' } : { type: 'none' }
  }

  if (!altKey || s.lineCount === 0) return { type: 'none' }
  const current =
    s.selectedLine < 0 ? s.lineCount - 1 : Math.min(s.selectedLine, s.lineCount - 1)

  switch (key) {
    case 'ArrowUp':
      return { type: 'select-line', index: Math.max(0, current - 1) }
    case 'ArrowDown':
      return { type: 'select-line', index: Math.min(s.lineCount - 1, current + 1) }
    case '+':
    case '=':
      return { type: 'step-quantity', index: current, direction: 1 }
    case '-':
      return { type: 'step-quantity', index: current, direction: -1 }
    case 'Delete':
    case 'Backspace':
      return { type: 'remove-line', index: current }
    default:
      return { type: 'none' }
  }
}

export function useBillingShortcuts(h: BillingShortcutHandlers): void {
  // Re-registered every render on purpose: the handler closes over cart
  // contents and totals that change constantly, and a stale closure here would
  // delete the wrong line or submit an out-of-date bill.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const action = resolveShortcut(e.key, e.altKey, h)
      if (action.type === 'none') return
      // Every key the layer claims is one the browser or the page would
      // otherwise act on — F6 moves focus between panes, Backspace navigates
      // back on older builds.
      e.preventDefault()
      switch (action.type) {
        case 'focus-search':
          h.focusSearch()
          return
        case 'focus-amount':
          h.focusAmount()
          return
        case 'open-customer':
          h.openCustomer()
          return
        case 'collect':
          h.collect()
          return
        case 'cancel-pending':
          h.cancelPending()
          h.focusSearch()
          return
        case 'close-dropdown':
          h.closeDropdown()
          return
        case 'select-line':
          h.setSelectedLine(action.index)
          return
        case 'step-quantity':
          h.stepQuantity(action.index, action.direction)
          h.setSelectedLine(action.index)
          return
        case 'remove-line':
          h.removeLine(action.index)
          // The list shrank under the selection; step back so it still points
          // at a line rather than off the end.
          h.setSelectedLine(action.index > 0 ? action.index - 1 : -1)
          return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}

/** Focuses an input and selects what is in it, so typing replaces. */
export function useFocusAndSelect(
  ref: React.RefObject<HTMLInputElement | null>
): () => void {
  return useCallback(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [ref])
}

/**
 * The keys, on screen. Deliberately plain and always visible: it is read a few
 * times in the first week and then never looked at again, which is exactly
 * what it is for.
 */
export function ShortcutBar({ hasLines }: { hasLines: boolean }): React.JSX.Element {
  const keys: [string, string][] = [
    ['F2', 'Search'],
    ['F4', 'Customer'],
    ['F6', 'Amount'],
    ['F9', 'Collect'],
    ...(hasLines
      ? ([
          ['Alt ↑↓', 'Pick line'],
          ['Alt + −', 'Quantity'],
          ['Alt ⌫', 'Remove']
        ] as [string, string][])
      : [])
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1 pt-3 text-[11px] text-muted-foreground">
      {keys.map(([key, label]) => (
        <span key={key} className="flex items-center gap-1.5">
          <kbd className="px-1.5 py-0.5 rounded border bg-zinc-50 font-mono text-[10px] text-zinc-700">
            {key}
          </kbd>
          {label}
        </span>
      ))}
    </div>
  )
}
