/**
 * Where the branch server is.
 *
 * Read from the environment like every other screen does, rather than
 * hardcoded here — six screens go through this helper, so a hardcoded value
 * meant half the app could be pointed somewhere the other half was not.
 */
export const API_BASE =
  (import.meta.env.VITE_LOCAL_API_URL as string) || 'https://127.0.0.1:52001'

export function authHeaders(token: string | null): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

export async function apiFetch<T = unknown>(
  path: string,
  token: string | null,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(token),
      ...(options?.headers as Record<string, string> | undefined)
    }
  })
  const data = await res.json()
  if (!res.ok) throw Object.assign(new Error(data.error || 'API_ERROR'), { status: res.status, data })
  return data as T
}
