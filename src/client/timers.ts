/**
 * A cancellable-timer seam.
 *
 * The freeze and stall effects each arm *two* timers: the one that releases
 * them on schedule, and a self-healing one that releases them regardless. Both
 * need to be cancellable and both need to be observable from a test that never
 * waits in real time. One interface covers it, and it keeps `window.setTimeout`
 * out of every effect module — which matters more than usual here, because a
 * stray uncancellable timer in this plugin is a DOM left frozen.
 */

/** Schedules callbacks. */
export interface Timers {
  /**
   * Run `fn` after `ms`.
   * @param ms - delay.
   * @param fn - callback.
   * @returns a cancel function; calling it after the timer fired is a no-op.
   */
  after(ms: number, fn: () => void): () => void
  /**
   * Run `fn` on the next animation frame.
   * @param fn - callback.
   * @returns a cancel function.
   */
  frame(fn: () => void): () => void
}

/** The real timers. */
export const realTimers: Timers = {
  after: (ms, fn) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  },
  frame: (fn) => {
    const handle = requestAnimationFrame(() => fn())
    return () => cancelAnimationFrame(handle)
  },
}
