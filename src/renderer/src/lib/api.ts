export const API_BASE = 'http://localhost:52001'

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
