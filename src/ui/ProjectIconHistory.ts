import type { App } from 'obsidian'

const STORAGE_KEY = 'projectmaster-project-icon-history'
const HISTORY_LIMIT = 64
type Usage = { id: string; count: number }

export function projectIconHistory(app: App) {
  const read = (): Usage[] => {
    const stored: unknown = app.loadLocalStorage(STORAGE_KEY)
    if (!Array.isArray(stored)) return []
    return stored.filter((entry): entry is Usage =>
      !!entry && typeof entry.id === 'string' && Number.isSafeInteger(entry.count) && entry.count > 0
    ).slice(0, HISTORY_LIMIT)
  }
  return {
    read,
    remember(id: string): void {
      const history = read()
      const count = history.find((entry) => entry.id === id)?.count ?? 0
      const next = [{ id, count: count + 1 }, ...history.filter((entry) => entry.id !== id)]
      app.saveLocalStorage(STORAGE_KEY, next.slice(0, HISTORY_LIMIT))
    }
  }
}
