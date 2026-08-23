import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Check,
  KeyRound,
  Loader2,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users
} from 'lucide-react'
import { Input } from './ui/input'
import { Button } from './ui/button'
import { Modal } from './Modal'

const LOCAL_API = (import.meta.env.VITE_LOCAL_API_URL as string) || 'http://127.0.0.1:52001'

type Role = 'SUPER_ADMIN' | 'CASHIER'

type User = {
  id: string
  username: string
  role: Role
  createdAt: string
  billCount: number
}

/**
 * Reads the signed-in user's id and role out of the manager session JWT.
 *
 * The renderer carries no session context of its own, so the token payload is
 * the only place this is available. The signature is not verified here, and it
 * does not need to be: this decides nothing more than whether to *render* the
 * panel and which row to mark as "you". Every endpoint behind it is
 * `requireAuth(['SUPER_ADMIN'])` and re-checks on its own.
 */
function sessionFromToken(): { userId: string | null; role: string | null } {
  try {
    const payload = localStorage.getItem('managerToken')?.split('.')[1]
    if (!payload) return { userId: null, role: null }
    // Base64url → base64 before decoding.
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { userId?: string; role?: string }
    return { userId: claims.userId ?? null, role: claims.role ?? null }
  } catch {
    return { userId: null, role: null } // malformed token — treat as "not a super admin"
  }
}

/** Shop-floor wording. Nobody at a till knows what a "SUPER_ADMIN" is. */
const roleLabel = (role: Role): string => (role === 'SUPER_ADMIN' ? 'Manager' : 'Cashier')

const shortDate = (d: string): string =>
  new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })

/** Mirrors the server's own rule, so an obvious typo never costs a round trip. */
function validateUsername(raw: string): string | undefined {
  const v = (raw ?? '').trim()
  if (!v) return 'Username is required.'
  if (v.length < 3 || v.length > 32) return 'Username must be 3–32 characters.'
  if (!/^[a-z0-9._-]+$/.test(v)) return 'Username may use letters, digits, and . _ - only.'
  return undefined
}

function validatePassword(raw: string): string | undefined {
  if ((raw ?? '').length < 8) return 'Password must be at least 8 characters.'
  return undefined
}

function RoleChip({ role }: { role: Role }): React.JSX.Element {
  return role === 'SUPER_ADMIN' ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-semibold">
      <ShieldCheck className="w-3 h-3" /> Manager
    </span>
  ) : (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-zinc-100 border border-zinc-200 text-zinc-600 text-xs font-semibold">
      Cashier
    </span>
  )
}

/**
 * Staff accounts for this branch.
 *
 * Before this panel a shop had exactly one account — the super admin made at
 * setup — and it had to be typed into every till, which quietly handed manager
 * rights to whoever was standing at the counter. This is what makes separate
 * cashier logins usable, so the SUPER_ADMIN gates elsewhere mean something.
 */
export function UserSettings({ token }: { token: string | null }): React.JSX.Element | null {
  const session = useMemo(() => sessionFromToken(), [])

  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState('')

  // Add
  const [addOpen, setAddOpen] = useState(false)
  const [addForm, setAddForm] = useState<{ username: string; password: string; role: Role }>({
    username: '',
    password: '',
    role: 'CASHIER'
  })
  const [addErrors, setAddErrors] = useState<{ username?: string; password?: string }>({})
  const [addError, setAddError] = useState('')
  const [addSaving, setAddSaving] = useState(false)

  // Reset password
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [resetPassword, setResetPassword] = useState('')
  const [resetFieldError, setResetFieldError] = useState('')
  const [resetError, setResetError] = useState('')
  const [resetSaving, setResetSaving] = useState(false)

  // Role change (inline select)
  const [roleSavingId, setRoleSavingId] = useState<string | null>(null)
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null)

  // Remove
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [deleteBlockedByBills, setDeleteBlockedByBills] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const [savedNote, setSavedNote] = useState('')

  const isSuperAdmin = session.role === 'SUPER_ADMIN'

  const flash = (message: string): void => {
    setSavedNote(message)
    setTimeout(() => setSavedNote(''), 2500)
  }

  const load = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/users`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (data.success) {
        setUsers(data.users as User[])
        setListError('')
      } else {
        setListError(data.message || 'Could not load the staff list.')
      }
    } catch {
      setListError('Could not reach the local server.')
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    if (isSuperAdmin) load()
  }, [load, isSuperAdmin])

  // ─── Add ────────────────────────────────────────────────────────────────────

  const openAdd = (role: Role): void => {
    setAddForm({ username: '', password: '', role })
    setAddErrors({})
    setAddError('')
    setAddOpen(true)
  }

  const handleAdd = async (): Promise<void> => {
    const next = {
      username: validateUsername(addForm.username),
      password: validatePassword(addForm.password)
    }
    setAddErrors(next)
    if (next.username || next.password) return

    setAddSaving(true)
    setAddError('')
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          username: addForm.username.trim(),
          password: addForm.password,
          role: addForm.role
        })
      })
      const data = await res.json()
      if (!data.success) {
        setAddError(data.message || 'Could not create the account.')
        return
      }
      setAddOpen(false)
      flash(`${data.user.username} added.`)
      await load()
    } catch {
      setAddError('Could not reach the local server.')
    } finally {
      setAddSaving(false)
    }
  }

  // ─── Reset password ─────────────────────────────────────────────────────────

  const openReset = (user: User): void => {
    setResetUser(user)
    setResetPassword('')
    setResetFieldError('')
    setResetError('')
    // Opening the reset modal is the escape hatch from a blocked removal.
    setDeleteUser(null)
    setDeleteError('')
    setDeleteBlockedByBills(false)
  }

  const handleReset = async (): Promise<void> => {
    if (!resetUser) return
    const fieldError = validatePassword(resetPassword)
    setResetFieldError(fieldError ?? '')
    if (fieldError) return

    setResetSaving(true)
    setResetError('')
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/users/${resetUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password: resetPassword })
      })
      const data = await res.json()
      if (!data.success) {
        setResetError(data.message || 'Could not change the password.')
        return
      }
      flash(`${resetUser.username}'s old password no longer works.`)
      setResetUser(null)
    } catch {
      setResetError('Could not reach the local server.')
    } finally {
      setResetSaving(false)
    }
  }

  // ─── Role ───────────────────────────────────────────────────────────────────

  const handleRoleChange = async (user: User, role: Role): Promise<void> => {
    if (role === user.role) return
    setRoleSavingId(user.id)
    setRowError(null)
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role })
      })
      const data = await res.json()
      if (!data.success) {
        // LAST_SUPER_ADMIN in particular explains itself far better than any
        // generic message could, so show the server's wording verbatim.
        setRowError({ id: user.id, message: data.message || 'Could not change the role.' })
        return
      }
      flash(`${user.username} is now a ${roleLabel(role).toLowerCase()}.`)
      await load()
    } catch {
      setRowError({ id: user.id, message: 'Could not reach the local server.' })
    } finally {
      setRoleSavingId(null)
    }
  }

  // ─── Remove ─────────────────────────────────────────────────────────────────

  const openDelete = (user: User): void => {
    setDeleteUser(user)
    setDeleteError('')
    setDeleteBlockedByBills(false)
  }

  const handleDelete = async (): Promise<void> => {
    if (!deleteUser) return
    setDeleting(true)
    setDeleteError('')
    setDeleteBlockedByBills(false)
    try {
      const res = await fetch(`${LOCAL_API}/api/v1/users/${deleteUser.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      const data = await res.json()
      if (!data.success) {
        setDeleteError(data.message || 'Could not remove the account.')
        // A cashier who has rung up sales can never be deleted — the bills name
        // them. Changing the password is the real way to revoke access.
        setDeleteBlockedByBills(data.error === 'USER_HAS_BILLS')
        return
      }
      flash(`${deleteUser.username} removed.`)
      setDeleteUser(null)
      await load()
    } catch {
      setDeleteError('Could not reach the local server.')
    } finally {
      setDeleting(false)
    }
  }

  // Only a super admin gets this panel at all. The server re-checks every call.
  if (!isSuperAdmin) return null

  const hasCashier = users.some((u) => u.role === 'CASHIER')

  return (
    <div className="p-5 rounded-xl border bg-card">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4 text-zinc-500" />
          <p className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
            Staff Accounts
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => openAdd('CASHIER')}>
          <UserPlus className="w-4 h-4" /> Add user
        </Button>
      </div>
      <p className="text-xs text-zinc-400 mb-4">
        Each person who works a till should have their own login. Every bill is stamped with the
        account that rang it up.
      </p>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-500 py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : listError ? (
        <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">
          {listError}
        </div>
      ) : (
        <>
          {!hasCashier && (
            <div className="mb-4 p-3 rounded-md bg-amber-50 border border-amber-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-xs text-amber-800">
                  There is no cashier account yet. Running a till on the manager login gives
                  whoever is standing at the counter manager rights — voids, credit terms,
                  settings and all.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 mt-2 h-8"
                  onClick={() => openAdd('CASHIER')}
                >
                  <UserPlus className="w-3.5 h-3.5" /> Create a cashier account
                </Button>
              </div>
            </div>
          )}

          <div className="border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 border-b">
                <tr>
                  <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">
                    User
                  </th>
                  <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">
                    Role
                  </th>
                  <th className="text-left px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">
                    Added
                  </th>
                  <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">
                    Bills
                  </th>
                  <th className="text-right px-4 py-2.5 font-semibold text-zinc-600 text-xs uppercase">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {users.map((u) => {
                  const isSelf = u.id === session.userId
                  return (
                    <React.Fragment key={u.id}>
                      <tr className="hover:bg-zinc-50">
                        <td className="px-4 py-3">
                          <span className="font-semibold text-zinc-900">{u.username}</span>
                          {isSelf && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-zinc-900 text-white text-[10px] font-semibold uppercase">
                              you
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-2">
                            <RoleChip role={u.role} />
                            <select
                              value={u.role}
                              disabled={roleSavingId === u.id}
                              onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                              className="h-8 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
                            >
                              <option value="SUPER_ADMIN">Manager</option>
                              <option value="CASHIER">Cashier</option>
                            </select>
                            {roleSavingId === u.id && (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-zinc-600 text-xs">{shortDate(u.createdAt)}</td>
                        <td className="px-4 py-3 text-right text-zinc-600">{u.billCount}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="gap-1.5 h-8"
                              onClick={() => openReset(u)}
                            >
                              <KeyRound className="w-3.5 h-3.5" /> Reset password
                            </Button>
                            {/* Never offer removal for the account you are signed in as. */}
                            {!isSelf && (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1.5 h-8 text-red-600 hover:bg-red-50 hover:text-red-700"
                                onClick={() => openDelete(u)}
                              >
                                <Trash2 className="w-3.5 h-3.5" /> Remove
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                      {rowError?.id === u.id && (
                        <tr>
                          <td colSpan={5} className="px-4 pb-3">
                            <p className="text-xs text-red-600">{rowError.message}</p>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

          {savedNote && (
            <div className="mt-4 flex items-center gap-1.5 text-sm text-emerald-600 font-medium">
              <Check className="w-4 h-4" /> {savedNote}
            </div>
          )}
        </>
      )}

      {/* ─── Add user ───────────────────────────────────────────────────────── */}
      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a user" size="sm">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1.5">Username</label>
            <Input
              value={addForm.username}
              // Usernames are typed at a till, so they are always lowercase.
              onChange={(e) => {
                setAddForm((f) => ({ ...f, username: e.target.value.toLowerCase() }))
                setAddErrors((p) => ({ ...p, username: undefined }))
              }}
              onBlur={() =>
                setAddErrors((p) => ({ ...p, username: validateUsername(addForm.username) }))
              }
              placeholder="ravi.counter"
              className="h-10 font-mono"
            />
            {addErrors.username ? (
              <p className="text-xs text-red-600 mt-1">{addErrors.username}</p>
            ) : (
              <p className="text-xs text-zinc-400 mt-1">
                3–32 characters. Lowercase letters, digits, and . _ - only.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1.5">Password</label>
            <Input
              type="password"
              value={addForm.password}
              onChange={(e) => {
                setAddForm((f) => ({ ...f, password: e.target.value }))
                setAddErrors((p) => ({ ...p, password: undefined }))
              }}
              onBlur={() =>
                setAddErrors((p) => ({ ...p, password: validatePassword(addForm.password) }))
              }
              placeholder="At least 8 characters"
              className="h-10"
            />
            {addErrors.password ? (
              <p className="text-xs text-red-600 mt-1">{addErrors.password}</p>
            ) : (
              <p className="text-xs text-zinc-400 mt-1">
                They will type this at the till. Minimum 8 characters.
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1.5">Role</label>
            <select
              value={addForm.role}
              onChange={(e) => setAddForm((f) => ({ ...f, role: e.target.value as Role }))}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="CASHIER">Cashier — billing only</option>
              <option value="SUPER_ADMIN">Manager — full access</option>
            </select>
            <p className="text-xs text-zinc-400 mt-1">
              {addForm.role === 'SUPER_ADMIN'
                ? 'Managers can void bills, set credit terms, and change settings.'
                : 'Cashiers can ring up sales but not void bills or change settings.'}
            </p>
          </div>

          {addError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">
              {addError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={addSaving} className="gap-2">
              {addSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {addSaving ? 'Creating…' : 'Create account'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Reset password ─────────────────────────────────────────────────── */}
      <Modal
        open={resetUser !== null}
        onClose={() => setResetUser(null)}
        title={resetUser ? `Revoke access for ${resetUser.username}` : 'Revoke access'}
        size="sm"
      >
        <div className="space-y-4">
          <p className="text-xs text-zinc-500">
            Setting a new password immediately stops the old one from working. This is how you cut
            off someone who has left — their past bills stay on record under their name.
          </p>
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1.5">New password</label>
            <Input
              type="password"
              value={resetPassword}
              onChange={(e) => {
                setResetPassword(e.target.value)
                setResetFieldError('')
              }}
              onBlur={() => setResetFieldError(validatePassword(resetPassword) ?? '')}
              placeholder="At least 8 characters"
              className="h-10"
            />
            {resetFieldError && <p className="text-xs text-red-600 mt-1">{resetFieldError}</p>}
          </div>

          {resetError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">
              {resetError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setResetUser(null)}>
              Cancel
            </Button>
            <Button onClick={handleReset} disabled={resetSaving} className="gap-2">
              {resetSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {resetSaving ? 'Saving…' : 'Set new password'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ─── Remove ─────────────────────────────────────────────────────────── */}
      <Modal
        open={deleteUser !== null}
        onClose={() => setDeleteUser(null)}
        title={deleteUser ? `Remove ${deleteUser.username}?` : 'Remove user'}
        size="sm"
      >
        <div className="space-y-4">
          <div className="p-3 rounded-md bg-red-50 border border-red-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />
            <p className="text-xs text-red-700">
              This deletes the account for good. {deleteUser?.username} will no longer be able to
              sign in at any till.
            </p>
          </div>

          {deleteError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-600">
              {deleteError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setDeleteUser(null)}>
              Cancel
            </Button>
            {deleteBlockedByBills && deleteUser ? (
              <Button className="gap-2" onClick={() => openReset(deleteUser)}>
                <KeyRound className="w-4 h-4" /> Reset password instead
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={handleDelete}
                disabled={deleting}
                className="gap-2"
              >
                {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {deleting ? 'Removing…' : 'Remove account'}
              </Button>
            )}
          </div>
        </div>
      </Modal>
    </div>
  )
}
