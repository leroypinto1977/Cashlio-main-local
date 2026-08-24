/**
 * Shared field validation — imported by the Express server (src/main) and by
 * the renderer forms, so the client and the API agree on what "valid" means
 * and return the same error codes.
 *
 * This module must stay dependency-free and free of Node/DOM globals: it is
 * bundled into the main process, the renderer, and (as a copy) the terminal
 * app in billing-client.
 */

export type FieldResult<T = string> =
  | { ok: true; value: T }
  | { ok: false; error: string; message: string }

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value })
const bad = (error: string, message: string): FieldResult<never> => ({ ok: false, error, message })

// ─── Phone ────────────────────────────────────────────────────────────────────

/** Strips formatting and a leading +91 / 0 so we always store bare digits. */
export function normalizePhone(raw: string): string {
  let d = (raw || '').replace(/\D/g, '')
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d
}

/** Indian mobile: exactly 10 digits beginning 6-9. Used for customers. */
export function validateMobile(raw: string, { required = true } = {}): FieldResult {
  const d = normalizePhone(raw)
  if (!d) {
    return required ? bad('PHONE_REQUIRED', 'Phone number is required.') : ok('')
  }
  if (d.length !== 10) {
    return bad('PHONE_INVALID', `Enter a 10-digit mobile number (you entered ${d.length} digits).`)
  }
  if (!/^[6-9]/.test(d)) {
    return bad('PHONE_INVALID', 'Indian mobile numbers start with 6, 7, 8 or 9.')
  }
  return ok(d)
}

/**
 * Suppliers may legitimately give a landline, so accept an STD code + number
 * totalling 10-11 digits as well as a mobile.
 */
export function validateContactNumber(raw: string, { required = true } = {}): FieldResult {
  const d = normalizePhone(raw)
  if (!d) {
    return required ? bad('PHONE_REQUIRED', 'Contact number is required.') : ok('')
  }
  if (d.length === 10 && /^[6-9]/.test(d)) return ok(d)
  if (d.length >= 10 && d.length <= 11) return ok(d) // landline with STD code
  return bad('PHONE_INVALID', 'Enter a 10-digit mobile or a landline with STD code.')
}

/** 9876543210 -> "98765 43210" (display only; never stored in this form). */
export function formatPhone(digits: string): string {
  const d = (digits || '').replace(/\D/g, '')
  if (d.length === 10) return `${d.slice(0, 5)} ${d.slice(5)}`
  return d
}

// ─── Email ────────────────────────────────────────────────────────────────────

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

export function validateEmail(raw: string, { required = false } = {}): FieldResult {
  const v = (raw || '').trim().toLowerCase()
  if (!v) {
    return required ? bad('EMAIL_REQUIRED', 'Email is required.') : ok('')
  }
  if (v.length > 254 || !EMAIL_RE.test(v)) {
    return bad('EMAIL_INVALID', 'Enter a valid email address, e.g. name@company.com.')
  }
  return ok(v)
}

// ─── GSTIN ────────────────────────────────────────────────────────────────────

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
const GSTIN_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Valid GST state codes: 01-38 for states/UTs, 97 for "Other Territory". */
export function isValidStateCode(code: string): boolean {
  if (!/^[0-9]{2}$/.test(code)) return false
  const n = parseInt(code, 10)
  return (n >= 1 && n <= 38) || n === 97
}

/**
 * Official GSTIN check-digit: positions 1-14 are weighted 1,2,1,2..., each
 * product is folded (quotient + remainder over 36) and the 15th character is
 * whatever makes the total a multiple of 36.
 */
export function gstinCheckDigit(first14: string): string {
  let sum = 0
  let factor = 1
  for (let i = 0; i < 14; i++) {
    const codePoint = GSTIN_ALPHABET.indexOf(first14[i])
    if (codePoint < 0) return ''
    const product = codePoint * factor
    factor = factor === 1 ? 2 : 1
    sum += Math.floor(product / 36) + (product % 36)
  }
  return GSTIN_ALPHABET[(36 - (sum % 36)) % 36]
}

export function validateGstin(raw: string, { required = false } = {}): FieldResult {
  const v = (raw || '').trim().toUpperCase().replace(/\s/g, '')
  if (!v) {
    return required ? bad('GSTIN_REQUIRED', 'GSTIN is required.') : ok('')
  }
  if (v.length !== 15) {
    return bad('GSTIN_INVALID', `A GSTIN is 15 characters (you entered ${v.length}).`)
  }
  if (!GSTIN_RE.test(v)) {
    return bad('GSTIN_INVALID', 'GSTIN format looks wrong. Expected e.g. 27AAAAA0000A1Z5.')
  }
  if (!isValidStateCode(v.slice(0, 2))) {
    return bad('GSTIN_STATE_INVALID', `"${v.slice(0, 2)}" is not a valid GST state code.`)
  }
  const expected = gstinCheckDigit(v.slice(0, 14))
  if (expected && v[14] !== expected) {
    return bad('GSTIN_CHECKSUM', `GSTIN checksum doesn't match — the last character should be "${expected}".`)
  }
  return ok(v)
}

/** The 2-digit state code embedded in a GSTIN, or null. */
export function stateCodeOf(gstin: string | null | undefined): string | null {
  const v = (gstin || '').trim().toUpperCase()
  return v.length === 15 && isValidStateCode(v.slice(0, 2)) ? v.slice(0, 2) : null
}

// ─── Name ─────────────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 .&'()\-/]*$/

export function validateName(raw: string, label = 'Name', { required = true, max = 80 } = {}): FieldResult {
  const v = (raw || '').trim().replace(/\s+/g, ' ')
  if (!v) {
    return required ? bad('NAME_REQUIRED', `${label} is required.`) : ok('')
  }
  if (v.length < 2) return bad('NAME_TOO_SHORT', `${label} must be at least 2 characters.`)
  if (v.length > max) return bad('NAME_TOO_LONG', `${label} must be ${max} characters or fewer.`)
  if (!NAME_RE.test(v)) {
    return bad('NAME_INVALID', `${label} may only contain letters, numbers, spaces and . & ' - / ( )`)
  }
  return ok(v)
}

// ─── PIN code ─────────────────────────────────────────────────────────────────

export function validatePincode(raw: string, { required = false } = {}): FieldResult {
  const d = (raw || '').replace(/\D/g, '')
  if (!d) return required ? bad('PINCODE_REQUIRED', 'PIN code is required.') : ok('')
  if (!/^[1-9][0-9]{5}$/.test(d)) {
    return bad('PINCODE_INVALID', 'Enter a 6-digit PIN code.')
  }
  return ok(d)
}

/**
 * A MAC address in one canonical spelling.
 *
 * A till reports whatever its operating system hands it, and that is not
 * consistent about case — the same adapter reads `de:ad:be:ef:99:01` on one
 * machine and `DE:AD:BE:EF:99:01` on another, or with dashes instead of
 * colons. Stored raw, the same physical till pairs twice: two terminal codes,
 * two rows in the device list, and two of the licence's seats gone.
 */
export function normalizeMac(raw: string): string {
  const hex = (raw || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
  if (hex.length !== 12) return (raw || '').trim().toUpperCase()
  return (hex.match(/.{2}/g) ?? []).join(':')
}

// ─── HSN ──────────────────────────────────────────────────────────────────────

/**
 * The classification code a GST invoice carries for each line.
 *
 * Four, six or eight digits — the length depends on the seller's turnover, and
 * a shop growing past a threshold reports more of them, so all three are
 * accepted rather than one being imposed. Services use a SAC instead, which is
 * six digits and passes the same test.
 *
 * Optional on a product, because a shop can trade before it needs to file; the
 * GSTR-1 export is where its absence is felt, and that is where it is
 * reported rather than blocking a sale at the counter.
 */
export function validateHsn(raw: string, { required = false } = {}): FieldResult {
  const v = (raw || '').replace(/\s/g, '')
  if (!v) {
    return required
      ? bad('HSN_REQUIRED', 'An HSN code is required to file a GST return for this product.')
      : ok('')
  }
  if (!/^\d+$/.test(v)) {
    return bad('HSN_INVALID', 'An HSN code is digits only — no letters or punctuation.')
  }
  if (![4, 6, 8].includes(v.length)) {
    return bad(
      'HSN_INVALID',
      `An HSN code is 4, 6 or 8 digits (you entered ${v.length}).`
    )
  }
  return ok(v)
}

// ─── Item code ────────────────────────────────────────────────────────────────

/**
 * Item codes are typed at the counter and printed on receipts, so they are
 * uppercase, space-free and unambiguous: alphanumeric groups joined by
 * hyphens, e.g. PVC-FIN-25MM or WIRE-HAV-1.5-RED.
 */
export const ITEM_CODE_RE = /^[A-Z0-9]{2,}(?:-[A-Z0-9.]+)*$/
export const ITEM_CODE_HINT = 'Uppercase letters, digits and hyphens — e.g. PVC-FIN-25MM'

/**
 * Shapes a string into a valid code. This is for *generating* codes — the
 * "Suggest" button, and building one from a brand and a product name. It is
 * deliberately not applied to what somebody types: rewriting an entry under
 * the cursor leaves them unsure what was actually saved, and a code that gets
 * printed on receipts and batch labels should be the one they meant.
 * `validateItemCode` rejects and explains instead.
 */
export function normalizeItemCode(raw: string): string {
  return (raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9.\-\s_]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
}

/**
 * Checks a typed item code and says precisely what is wrong with it.
 *
 * The checks run in the order somebody reads their own typing, and each names
 * the characters at fault — so "PVC PIPE 25" is told about the spaces rather
 * than handed a pattern to decipher. Nothing is corrected here;
 * `suggestItemCodeFix` offers a candidate the caller can present as a choice.
 */
export function validateItemCode(raw: string): FieldResult {
  const v = (raw || '').trim()
  if (!v) return bad('ITEM_CODE_REQUIRED', 'Item code is required.')

  if (/\s/.test(v)) {
    return bad(
      'ITEM_CODE_HAS_SPACE',
      'Item codes cannot contain spaces — join the parts with a hyphen, e.g. PVC-FIN-25MM.'
    )
  }

  const stray = [...new Set(v.replace(/[A-Za-z0-9.\-]/g, '').split(''))]
  if (stray.length > 0) {
    const list = stray.map((c) => `"${c}"`).join(', ')
    return bad(
      'ITEM_CODE_BAD_CHAR',
      `${list} cannot be used in an item code. Use letters, digits, hyphens and full stops only.`
    )
  }

  if (/[a-z]/.test(v)) {
    return bad(
      'ITEM_CODE_NOT_UPPERCASE',
      `Item codes are uppercase — did you mean ${v.toUpperCase()}?`
    )
  }

  if (v.length < 3) return bad('ITEM_CODE_TOO_SHORT', 'Item code must be at least 3 characters.')
  if (v.length > 32) return bad('ITEM_CODE_TOO_LONG', 'Item code must be 32 characters or fewer.')

  if (/^-/.test(v)) return bad('ITEM_CODE_INVALID', 'Item code cannot start with a hyphen.')
  if (/-$/.test(v)) return bad('ITEM_CODE_INVALID', 'Item code cannot end with a hyphen.')
  if (/--/.test(v)) return bad('ITEM_CODE_INVALID', 'Item code cannot contain two hyphens in a row.')
  if (!ITEM_CODE_RE.test(v)) return bad('ITEM_CODE_INVALID', ITEM_CODE_HINT + '.')

  return ok(v)
}

/**
 * A valid code close to what was typed, or null when there isn't one worth
 * offering. Callers show it as something to accept — never apply it silently.
 */
export function suggestItemCodeFix(raw: string): string | null {
  const typed = (raw || '').trim()
  if (!typed) return null
  // A stray character between two words is a separator somebody reached for —
  // "PVC/PIPE" and "PVC#PIPE" mean PVC-PIPE, not PVCPIPE. Turn them into
  // hyphens before shaping, rather than deleting them and running the words
  // together.
  const candidate = normalizeItemCode(typed.replace(/[^A-Za-z0-9.\-]+/g, '-'))
  if (!candidate || candidate === typed) return null
  return validateItemCode(candidate).ok ? candidate : null
}

/** Builds the alphabetic stub used in generated item codes: "Finolex" -> "FIN". */
export function codeStub(source: string, len = 3): string {
  const cleaned = (source || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return cleaned.slice(0, len)
}
