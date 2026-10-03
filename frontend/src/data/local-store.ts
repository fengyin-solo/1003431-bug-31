import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都在。
export const STORAGE_KEY = 'forest-fire-patrol:entries'
// 写入后广播：跨标签页（两个值守端）和同页导航都要立刻看到最新结果。
export const STORE_CHANGE_EVENT = 'forest-fire-patrol:entries-changed'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 只接受“至少包含全部种子模块”的完整快照，不做模块级种子合并：
    // 旧端写回缺模块的快照时若合并，等于把别的值守端刚提交的结果回退成种子。
    for (const key of Object.keys(fallback)) {
      if (!Array.isArray(parsed[key])) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
        return fallback
      }
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

/** 丢弃内存缓存，强制从 localStorage 重读——并发提交的乐观锁校验前必须用它，防止拿旧快照裁决。 */
export function refreshRows(): Record<string, EntryRow[]> {
  cache = readStorage()
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function emitChange(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(STORE_CHANGE_EVENT))
  }
}

export function saveRows(key: string, rows: EntryRow[]): void {
  saveAll({ [key]: rows })
}

/**
 * 多模块原子写入：换岗会同时落检查站状态和值勤待办，
 * 必须整快照一次提交，不能一个成功一个失败（失败重试残留的根因之一）。
 */
export function saveAll(patch: Record<string, EntryRow[]>): void {
  // 以持久层最新数据为底，避免另一值守端刚提交的结果被本端旧缓存整表覆盖。
  const base = typeof window !== 'undefined' && window.localStorage ? refreshRows() : allRows()
  const next = { ...base, ...patch }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  emitChange()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
