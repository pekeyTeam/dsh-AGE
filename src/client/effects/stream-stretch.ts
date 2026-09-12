/**
 * Symptom 3 of the text trio: **拉长** — the text visibly pulls sideways for a
 * beat, then snaps back.
 *
 * Mechanism: a brief geometric distortion of the streaming markdown root. Two
 * expressions of it, chosen by preset:
 *
 * - `letter-spacing` reflows the text. Only the streaming row relayouts, and
 *   nothing downstream can be mispositioned by it.
 * - `transform` reads more like a physical pull and animates on the compositor
 *   for free — but an inline `transform` on an ancestor of a `position: fixed`
 *   descendant creates a containing block, which would misplace any anchored
 *   popover opened from inside the message.
 *
 * That last hazard is why the function refuses outright while a menu or dialog
 * is open inside the row. A briefly misplaced tooltip would be a small bug, but
 * it is a *new* bug the plugin invented, and the low presets never needed the
 * transform in the first place.
 */

import { MENU_SELECTOR, MODAL_SELECTOR, streamingBody, streamingRow } from '../dom.ts'
import type { RestoreRegistry } from '../registry.ts'
import type { Timers } from '../timers.ts'

/** How long the distortion is held, in milliseconds. */
const STRETCH_HOLD_MS = 160

/** Safety margin on the backstop release. */
const BACKSTOP_SLACK_MS = 200

/** Which property expresses the stretch. */
export type StretchMode = 'letter-spacing' | 'transform'

/**
 * Distort the streaming body for a moment.
 *
 * @param registry - undo log; every property set here is individually reversible.
 * @param timers - timer seam.
 * @param scale - horizontal scale; 1.03 is the heavy preset's value.
 * @param mode - how to express it.
 * @returns true when the stretch was applied.
 */
export function stretchStreamRow(
  registry: RestoreRegistry,
  timers: Timers,
  scale: number,
  mode: StretchMode,
): boolean {
  const row = streamingRow()
  if (row === undefined) return false

  // An open menu or dialog inside the row means there is an anchored popover
  // that a transform would misposition. Decline rather than risk it — the
  // caller treats a declined symptom the same as one whose row vanished.
  if (row.querySelector(`${MENU_SELECTOR}, ${MODAL_SELECTOR}`) !== null) return false

  const body = streamingBody(row)
  const undo =
    mode === 'transform'
      ? registry.styles(body, {
          transform: `scaleX(${scale}) scaleY(${1 + (scale - 1) * 0.15})`,
          'transform-origin': 'left center',
          transition: `transform ${STRETCH_HOLD_MS}ms ease-out`,
          'will-change': 'transform',
        })
      : registry.styles(body, {
          'letter-spacing': `${((scale - 1) * 12).toFixed(2)}px`,
          transition: `letter-spacing ${STRETCH_HOLD_MS}ms ease-out`,
        })

  // A backstop that teardown cannot disarm, matching the other two symptoms.
  // The pending release below is the normal path; this only exists so that a
  // throw between here and there cannot leave the text permanently skewed.
  timers.after(STRETCH_HOLD_MS + BACKSTOP_SLACK_MS, () => undo.release())
  timers.after(STRETCH_HOLD_MS, () => undo.release())
  return true
}
