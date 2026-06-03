/**
 * Unified backend client. Centralises base URL + snake→camel normalisation so
 * the workbench (assets/models/jobs) talks to the real FastAPI backend.
 * The not-yet-built domains (scenes/data-hub/skills/settings) use localStore
 * repos instead, behind the same async repo interface — swap to HTTP here later.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'

export function apiUrl(path: string) {
  if (path.startsWith('http')) return path
  return `${API_BASE}${path}`
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init)
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  const ct = res.headers.get('content-type') || ''
  return (ct.includes('application/json') ? await res.json() : await res.text()) as T
}

export const api = {
  get: <T,>(path: string) => req<T>(path),
  post: <T,>(path: string, body: unknown) =>
    req<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  del: <T,>(path: string) => req<T>(path, { method: 'DELETE' }),
  text: (path: string) => req<string>(path),
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(apiUrl('/health'))
    return res.ok
  } catch {
    return false
  }
}

/* ---- shared inference + types (mirrors backend snake_case) ---- */
export type AssetType = 'raster' | 'vector' | 'table' | 'text' | 'folder' | 'other'

export function inferType(name: string): AssetType {
  const n = name.toLowerCase()
  if (n.endsWith('.tif') || n.endsWith('.tiff')) return 'raster'
  if (n.endsWith('.geojson') || n.endsWith('.json') || n.endsWith('.zip') || n.endsWith('.shp')) return 'vector'
  if (n.endsWith('.csv')) return 'table'
  if (n.endsWith('.md') || n.endsWith('.txt') || n.endsWith('.html')) return 'text'
  return 'other'
}

export function fmtBytes(size?: number) {
  if (!size) return '—'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}
