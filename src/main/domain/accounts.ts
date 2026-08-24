/**
 * What makes an account usable: a name somebody can type at a till, and a
 * password long enough to be worth having. Both the setup flow and user
 * management ask the same questions, so they ask them here.
 */
import type { FieldResult } from '../../shared/validation'

/**
 * Until this existed the only account in a shop was the super admin created
 * at setup, which had to be typed into every till — so every SUPER_ADMIN gate
 * in this file was decorative, and the cashier *was* the admin.
 */
export const ROLES = ['SUPER_ADMIN', 'CASHIER'] as const
export type Role = (typeof ROLES)[number]
export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)

/** Usernames are typed at a till, so keep them simple and unambiguous. */
export function validateUsername(raw: string): FieldResult {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return { ok: false, error: 'USERNAME_REQUIRED', message: 'Username is required.' }
  if (v.length < 3 || v.length > 32) {
    return { ok: false, error: 'USERNAME_INVALID', message: 'Username must be 3–32 characters.' }
  }
  if (!/^[a-z0-9._-]+$/.test(v)) {
    return {
      ok: false, error: 'USERNAME_INVALID',
      message: 'Username may use letters, digits, and . _ - only.'
    }
  }
  return { ok: true, value: v }
}

export function validatePassword(raw: string): FieldResult {
  const v = String(raw ?? '')
  if (v.length < 8) {
    return { ok: false, error: 'PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters.' }
  }
  if (v.length > 200) {
    return { ok: false, error: 'PASSWORD_TOO_LONG', message: 'Password is too long.' }
  }
  return { ok: true, value: v }
}
