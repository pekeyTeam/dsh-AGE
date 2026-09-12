/**
 * The plugin's announcement queue.
 *
 * A real security component tells you it is working, and the announcement is
 * most of what sells the bit — a silent scan is just a stutter. Toasts are also
 * how the escape hatches explain themselves: "paused for 5 minutes" is the
 * difference between a panic key that works and a panic key the user is not sure
 * worked.
 *
 * Deliberately capped and self-expiring. An unbounded queue would leave the
 * corner of the screen muttering about scans long after the user turned the
 * plugin off.
 */

/** How long one message stays on screen. */
export const TOAST_TTL_MS = 2_400

/** Never stack more than this many at once. */
const MAX_VISIBLE = 2

/** One queued message. */
export interface Toast {
  readonly id: number
  readonly text: string
}

/** A readable, subscribable announcement queue. */
export interface ToastStore {
  /** Currently visible messages, newest last. */
  get(): readonly Toast[]
  /**
   * Show a message.
   * @param text - what to say.
   */
  push(text: string): void
  /** Drop everything. */
  clear(): void
  /**
   * Observe changes.
   * @param listener - called after every mutation.
   * @returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Create a queue.
 *
 * @param afterMs - expiry timer; injected so specs need not wait.
 * @returns the store.
 */
export function createToastStore(afterMs: (ms: number, fn: () => void) => () => void): ToastStore {
  let toasts: Toast[] = []
  let nextId = 1
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    get: () => toasts,
    push: (text) => {
      const toast: Toast = { id: (nextId += 1), text }
      toasts = [...toasts, toast].slice(-MAX_VISIBLE)
      notify()
      afterMs(TOAST_TTL_MS, () => {
        toasts = toasts.filter((candidate) => candidate.id !== toast.id)
        notify()
      })
    },
    clear: () => {
      if (toasts.length === 0) return
      toasts = []
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
