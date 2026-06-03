/**
 * Tiny localStorage helper with seeding. Used by the repos for domains that
 * have no backend yet (scenes/data-hub/skills/settings). Swapping a repo to a
 * real HTTP call later is a one-file change; pages don't know the difference.
 */
export function loadSeeded<T>(key: string, seed: T): T {
  if (typeof window === 'undefined') return seed
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) {
      window.localStorage.setItem(key, JSON.stringify(seed))
      return seed
    }
    return JSON.parse(raw) as T
  } catch {
    return seed
  }
}

export function save<T>(key: string, val: T): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(val))
  } catch {
    /* ignore quota / serialization errors */
  }
}

export function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
