/**
 * Symptom 1 of the text trio: **停滞后恢复** — the response stops, then dumps
 * everything it produced while you were waiting.
 *
 * Mechanism: pin the streaming row's height and clip it, let the model keep
 * writing below the clip line, then reveal the accumulated tail in one go. Text
 * is never lost, only time-shifted, which is exactly what separates a stall from
 * a bug — a user watching it cannot tell that the words already existed.
 *
 * This is the technique `dsh-ads` validated in its reward gate, with one
 * deliberate divergence: it also hides every later transcript row while frozen,
 * and this does not. That plugin needed the space for a card; hiding tool rows
 * here would stack a *structural* lie on top of a *timing* one, and the row
 * count jumping around afterwards would read as the app breaking rather than
 * struggling.
 *
 * ## Three release paths, because a stuck freeze is the one unforgivable bug
 *
 * 1. The scheduled release.
 * 2. An early release when the row detaches or finishes streaming — there is
 *    nothing left to stall, and a frozen finished message is a lie.
 * 3. A self-healing timer that nothing is allowed to cancel, armed at the same
 *    instant as the freeze. Even if path 1's body throws and path 2's observer
 *    never fires, the row un-freezes. Its handle is deliberately kept out of the
 *    disposer's reach: teardown must not be able to disarm it.
 */

import { STREAMING_SELECTOR, streamingRow } from '../dom.ts'
import type { RestoreRegistry } from '../registry.ts'
import type { Timers } from '../timers.ts'

/** How long after the scheduled release the backstop fires. */
const BACKSTOP_SLACK_MS = 250

/** A row shorter than this has nothing worth freezing. */
const MIN_FREEZABLE_HEIGHT_PX = 24

/** A live stall, so the engine can end it early on a panic. */
export interface StallHandle {
  /** Release the freeze now and restore the row exactly. Idempotent. */
  release(): void
  /** Whether the freeze is still in effect. */
  readonly active: boolean
}

/**
 * Freeze the streaming row for a while.
 *
 * @param registry - undo log; the freeze registers its restoration here so an
 * unload mid-stall still restores the row.
 * @param timers - timer seam.
 * @param durationMs - how long to hold the freeze.
 * @returns the live stall, or `undefined` when nothing is streaming to stall.
 */
export function stallStreamRow(
  registry: RestoreRegistry,
  timers: Timers,
  durationMs: number,
): StallHandle | undefined {
  const row = streamingRow()
  if (row === undefined) return undefined
  // Already detached: there is nothing to stall, and no observer would ever tell
  // us so.
  if (!row.isConnected) return undefined
  const parent = row.parentElement

  // `scrollHeight` covers a row whose visible box is already clipped by the
  // host; `getBoundingClientRect().height` covers the ordinary case. Taking the
  // larger of the two means a freeze never accidentally *shrinks* a row.
  const height = Math.max(1, row.getBoundingClientRect().height, row.scrollHeight)
  if (height < MIN_FREEZABLE_HEIGHT_PX) return undefined

  const handle = registry.styles(row, {
    'max-height': `${height}px`,
    overflow: 'hidden',
  })
  const locked = registry.dataset(row, { dshAgeLocked: 'true' })

  let active = true
  const cancelTimer = timers.after(durationMs, release)
  // Armed but never stored: teardown must not be able to disarm the backstop,
  // which is the whole point of having one.
  timers.after(durationMs + BACKSTOP_SLACK_MS, release)

  // Two observers, because the two things worth reacting to happen in different
  // places. `data-streaming` clears on the *body* inside the row, so that one
  // needs `subtree`. Detachment is a change to the row's *parent*, and an
  // observer on the row itself would never see it — the row is not mutated by
  // being removed, which is exactly the mistake this pair exists to avoid.
  const onStreamEnded = new MutationObserver(() => {
    // A finished turn must not be held: the row would be delaying a message
    // that is already complete, which reads as a lie rather than a stutter.
    if (row.querySelector(STREAMING_SELECTOR) === null) release()
  })
  const onDetached = new MutationObserver(() => {
    if (!row.isConnected) release()
  })
  onStreamEnded.observe(row, { attributes: true, attributeFilter: ['data-streaming'], subtree: true })
  if (parent !== null) onDetached.observe(parent, { childList: true })
  const stopObserving = (): void => {
    onStreamEnded.disconnect()
    onDetached.disconnect()
  }

  function release(): void {
    if (!active) return
    active = false
    cancelTimer()
    stopObserving()
    locked.release()
    handle.release()
    // Nothing else was touched: no later row was ever hidden, so unlike the
    // reference implementation there is no second thing to put back.
  }

  return {
    release,
    get active() {
      return active
    },
  }
}
