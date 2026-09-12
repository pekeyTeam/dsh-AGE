/**
 * Where the AGE settings live, and how the two halves of the plugin agree on
 * them.
 *
 * The dsh host offers a settings-namespace mechanism, and this plugin does not
 * use it — deliberately. A namespace registers on the *host*, which would make
 * these values shared across every browser and every surface pointed at the
 * same dsh instance. Nobody wants their laptop's "地狱" preset following them
 * onto a shared machine, and the whole feature is a local joke about a local
 * machine. `localStorage` is the honest home for it.
 *
 * The same-document store exists because the settings page is a React tree and
 * the engine is not. A `useState` would leave the engine reading a stale value
 * until the page happened to re-render; a subscribe/getSnapshot store is the
 * smallest thing both can use, and React 18's `useSyncExternalStore` binds it
 * without any glue.
 */

/** Compute a stored value, falling back when storage is unavailable. */
type Reader<T> = () => T

/** Where the engine's settings are kept. */
export const STORAGE_PREFIX = 'dsh-age:'

/**
 * Storage is not always writable — private-mode Safari, sandboxed frames, a
 * jsdom run — and a jank plugin must never be the reason a session fails to
 * render. Every access is guarded, and a failed write just means the preference
 * does not outlive the tab.
 *
 * @param key - suffix of the storage key.
 * @returns the parsed value, or `undefined` when absent or unreadable.
 */
export function readStored<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`)
    return raw === null ? undefined : (JSON.parse(raw) as T)
  } catch {
    return undefined
  }
}

/**
 * Best-effort write.
 *
 * @param key - suffix of the storage key.
 * @param value - value to serialise.
 * @returns true when the write landed.
 */
export function writeStored(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

/** Remove one stored key. */
export function removeStored(key: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${key}`)
  } catch {
    // Swallowed: storage that cannot be written cannot be holding anything to
    // clear either.
  }
}

/** A readable, subscribable, writable slice of persisted state. */
export interface Store<T> {
  /** Current value. Stable identity until the next write. */
  get(): T
  /**
   * Merge a patch and notify subscribers.
   * @param patch - fields to change.
   */
  set(patch: Partial<T>): void
  /** Replace the whole value with the defaults and notify. */
  reset(): void
  /**
   * Observe changes.
   * @param listener - called after every write.
   * @returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Build a store over one stored key.
 *
 * The live value is held in memory and storage is the backing copy, not the
 * source of truth: reading through `localStorage` on every access would make
 * each `get()` a parse, and would silently revert a setting the instant storage
 * refused a write.
 *
 * @param key - suffix of the storage key.
 * @param defaults - the complete default value.
 * @param merge - how to combine a stored partial with the defaults; the default
 * shallow-merges, which is what keeps an older stored object loadable after a
 * field is added.
 * @returns the store.
 */
export function createStore<T extends object>(
  key: string,
  defaults: T,
  merge: (stored: Partial<T>, defaults: T) => T = (stored, base) => ({ ...base, ...stored }),
): Store<T> {
  let value: T = merge(readStored<Partial<T>>(key) ?? {}, defaults)
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    get: () => value,
    set: (patch) => {
      value = { ...value, ...patch }
      writeStored(key, value)
      notify()
    },
    reset: () => {
      value = { ...defaults }
      removeStored(key)
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
