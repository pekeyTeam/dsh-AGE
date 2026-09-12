/**
 * The main-thread block.
 *
 * This one primitive produces all three symptoms, which is the entire design
 * argument of the plugin: a real anti-cheat stall is not three separate bugs
 * that happen to coincide, it is one blocked thread, and everything the user
 * notices — the pointer, the streaming text, the buttons — is downstream of it.
 * Reproducing the cause is cheaper *and* more convincing than reproducing each
 * effect independently.
 *
 * ## What the user sees
 *
 * The operating system draws the cursor on the compositor, not in the page, so
 * during a block the pointer keeps gliding while nothing underneath it moves.
 * Chromium queues the input delivered meanwhile and hands it over in one burst
 * when the thread comes back. That is precisely the ACE tell: *the mouse still
 * moves, the game does not, then everything catches up at once.*
 *
 * ## What it is not
 *
 * - **Not chunked.** Yielding partway through would let the queued input flush
 *   *between* the chunks, which destroys the burst release — the one thing being
 *   bought. The hang detectors chunking would appease are handled from the other
 *   side instead: `scheduler.ts` caps a single block and enforces a refractory
 *   gap, and `budget.ts` caps the total.
 * - **Not `Atomics.wait`.** It throws on a browser's main thread, and its
 *   `SharedArrayBuffer` requirement needs COOP/COEP headers the host does not
 *   send. Recorded here so nobody re-litigates it.
 * - **Not interruptible.** A `dispose()` that arrives mid-block runs at the next
 *   macrotask, up to one block later. Every caller therefore arms its own
 *   self-healing timer rather than trusting teardown to be timely.
 */

/** Something that can occupy the main thread for a while. */
export interface Waiter {
  /**
   * Block the calling thread.
   * @param ms - milliseconds to burn. Callers must have bounded this already.
   */
  block(ms: number): void
}

/** Monotonic clock, falling back to wall time where `performance` is absent. */
function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

/**
 * A real spin, not a sleep.
 *
 * The busy loop is the point: a `setTimeout` would hand the thread back to the
 * browser between callbacks and the page would keep painting. Burning the
 * thread is what freezes the frame.
 */
export const spinWait: Waiter = {
  block(ms: number): void {
    if (!(ms > 0)) return
    const deadline = nowMs() + ms
    // eslint-disable-next-line no-empty -- the empty body is the mechanism.
    while (nowMs() < deadline) {
      /* deliberately empty: this is the freeze */
    }
  },
}

/** Performance-mark names, so a profiler trace is readable without a key. */
const HITCH_START = 'dsh-age:hitch-start'
const HITCH_END = 'dsh-age:hitch-end'
const HITCH_MEASURE = 'dsh-age:hitch'

/**
 * Block the thread, and leave a measurement behind.
 *
 * The timing is how the settings page reports *measured* blocked time next to
 * the ledger's planned time. Without it the plugin would be asking users to take
 * its honesty on faith, and the whole safety argument is that they should not
 * have to.
 *
 * Note what the return value is for. It is the number the caller should
 * accumulate, and it is returned rather than read back out of the Performance
 * API on purpose: Chromium caps its user-timing buffer at 250 entries and
 * silently drops `mark`/`measure` calls once it is full, so a total derived from
 * `getEntriesByName` stops growing after a few minutes and quietly under-reports
 * — the one number in this plugin that must not lie about how much it has cost.
 * The marks below are still emitted, because they make a DevTools trace
 * readable; they are just no longer the source of the total.
 *
 * @param waiter - the blocking strategy; injected so tests use a no-op.
 * @param ms - milliseconds to block.
 * @returns the milliseconds actually burned, which exceeds `ms` on a loaded machine.
 */
export function performHitch(waiter: Waiter, ms: number): number {
  const traceable = typeof performance !== 'undefined' && typeof performance.measure === 'function'
  if (traceable) performance.mark(HITCH_START)
  const startedAt = nowMs()
  waiter.block(ms)
  const elapsed = nowMs() - startedAt
  if (traceable) {
    performance.mark(HITCH_END)
    try {
      performance.measure(HITCH_MEASURE, HITCH_START, HITCH_END)
    } catch {
      // Swallowed: a measurement is diagnostic, never load-bearing. A browser
      // with a full mark buffer must not be able to break a hitch.
    }
  }
  return elapsed
}
