/**
 * The pointer symptom, for real: a cursor that stops when the thread stops.
 *
 * ## Why this has to exist
 *
 * Every other symptom can be simulated from inside the page. This one cannot.
 * The operating system draws the pointer on the compositor, outside the
 * document, so a busy-wait freezes the page while the cursor keeps gliding over
 * it — which is why the pointer was the one thing the plugin could not
 * reproduce, and why "the mouse lags" was, until this module, a label on a
 * page-wide block rather than an effect of its own.
 *
 * The only way a page can make the pointer itself stutter is to stop showing the
 * pointer: hide the real cursor and draw our own at the last position we saw.
 * During a block nothing runs, so the drawn cursor is frozen where it was while
 * the hidden real one keeps moving under the user's hand. When the thread comes
 * back, the drawn cursor is simply *there*, under the hand, and then the real
 * one takes over.
 *
 * That is the ACE tell, reproduced rather than described: *the mouse moves, the
 * pointer does not, and then it is somewhere else.* The jump must be instant —
 * a cursor that slides into place is an animation, and an animation is the one
 * thing a stalled pointer never looks like.
 *
 * ## The one failure that would be unacceptable
 *
 * This is the only place in the plugin that can leave the user without a visible
 * pointer, and no joke is worth that. So:
 *
 * - The real cursor is hidden only while a drawn one is on screen. If there is
 *   no known position to draw at, nothing is hidden.
 * - The hide lives on `documentElement`, so `RestoreRegistry`'s teardown clears
 *   it along with everything else.
 * - A backstop timer restores the cursor independently of the normal path, and
 *   is armed before the block starts rather than after it.
 * - The engine wraps the whole thing in `try`/`finally` regardless.
 *
 * Four independent ways back, none of which depends on the others working.
 */

import { createRegistry, type RestoreRegistry } from '../registry.ts'
import type { Timers } from '../timers.ts'

/** Attribute marking that the real cursor is hidden. */
export const CURSOR_HIDDEN_ATTRIBUTE = 'data-dsh-age-cursor-hidden'

/** Attribute on the drawn cursor element. */
export const CURSOR_MARKER = 'data-dsh-age-cursor'

/** How long the jumped cursor is held before the platform one takes over. */
const HANDOVER_MS = 60

/** Extra time the backstop waits beyond the expected hold. */
const BACKSTOP_SLACK_MS = 600

/**
 * Hard ceiling on a freeze that never gets settled.
 *
 * `settle` is always called in the same task as `freeze`, so this only fires if
 * something threw in between. Comfortably longer than the longest block any
 * preset can ask for, because firing early would snatch the pointer back
 * mid-hitch — but bounded, because a freeze with no settle and no ceiling is a
 * user with no visible pointer.
 */
const FREEZE_BACKSTOP_MS = 15_000

/**
 * The classic arrow, drawn from the origin at the hotspot, at the platform
 * cursor's own size: about 11.5 by 19 CSS pixels at 100% scaling.
 *
 * Measured against a real Windows pointer rather than eyeballed — an earlier
 * version of this path spanned 13.2 pixels and drew a stroke on top of that,
 * which read as a cursor one size too large next to the real one it replaces.
 * White fill with a dark outline so it stays legible over both light and dark
 * host themes, which is the same trick the platform cursors use.
 */
export const ARROW_PATH = 'M0 0 L0 16.5 L4.2 12.8 L7 19 L9.5 17.9 L6.7 11.9 L11.5 11.5 Z'

/** Where the pointer last was, and whether we have ever seen it. */
interface PointerFix {
  readonly x: number
  readonly y: number
}

/** The lagging cursor. */
export interface CursorLag {
  /** Hide the real cursor and draw ours at the last known position. */
  freeze(): void
  /**
   * Hold the freeze for whatever is left of `holdMs`, then put the drawn cursor
   * wherever the pointer actually is and hand back to the real one.
   *
   * The hold is measured from the freeze, not from this call, because the two
   * are separated by the block — and the block already spent exactly `holdMs` of
   * wall time. Scheduling a fresh delay here would freeze the cursor for twice
   * as long as intended.
   *
   * There is deliberately no transition on the reposition: the cursor is
   * somewhere else the instant the thread comes back, with nothing in between.
   *
   * @param holdMs - how long the pointer should stay stuck, in total.
   */
  settle(holdMs: number): void
  /**
   * Put the real cursor back and drop the drawing, keeping the move listener.
   *
   * What a panic or a suspension needs: the pointer must be visible again
   * immediately, but the plugin is coming back, so it still has to know where
   * the pointer is.
   */
  restore(): void
  /** Drop the listener as well. Terminal. */
  dispose(): void
  /** Whether a drawn cursor is currently on screen. */
  readonly active: boolean
}

/**
 * Create the controller.
 *
 * The move listener is attached immediately and stays attached for the plugin's
 * whole life: `freeze()` needs a position to draw at, and a listener attached at
 * freeze time would have nothing to draw.
 *
 * @param timers - timer seam.
 * @param registry - undo log shared with the rest of the plugin.
 * @returns the controller.
 */
export function createCursorLag(
  timers: Timers,
  registry: RestoreRegistry = createRegistry(),
): CursorLag {
  let fix: PointerFix | undefined
  let element: HTMLDivElement | undefined
  let undo: { release(): void } | undefined
  let cancelBackstop: (() => void) | undefined
  let frozenAt = 0
  /**
   * Terminal. Checked by `freeze` because disposal only drops the listener — the
   * last known position stays in memory, so without this a disposed controller
   * would still happily hide the cursor and draw over it, with nothing left
   * listening and no owner expecting it to.
   */
  let disposed = false

  const onMove = (event: PointerEvent): void => {
    fix = { x: event.clientX, y: event.clientY }
  }
  window.addEventListener('pointermove', onMove, { capture: true, passive: true })

  /** Bring the real cursor back and remove the drawing. Idempotent. */
  const restore = (): void => {
    cancelBackstop?.()
    cancelBackstop = undefined
    element?.remove()
    element = undefined
    undo?.release()
    undo = undefined
  }

  return {
    freeze: () => {
      if (disposed) return
      // Nothing to draw with, so nothing may be hidden. A hidden cursor with no
      // replacement on screen is the one outcome this module must never produce.
      if (fix === undefined || element !== undefined) return
      if (document.hidden || !document.body) return

      const cursor = document.createElement('div')
      cursor.setAttribute(CURSOR_MARKER, '')
      cursor.setAttribute('aria-hidden', 'true')
      Object.assign(cursor.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '0',
        height: '0',
        // Above everything, including the HUD and any host overlay.
        zIndex: '2147483647',
        // The drawn cursor must never intercept anything: it sits under the
        // user's hand for the entire block, and a click that landed on it would
        // be swallowed.
        pointerEvents: 'none',
        // Compositor-only movement, so the drag animates even while the main
        // thread is busy recovering.
        willChange: 'transform',
      } satisfies Partial<CSSStyleDeclaration>)
      cursor.innerHTML =
        `<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">` +
        `<path d="${ARROW_PATH}" fill="#ffffff" stroke="#1b1c1f" stroke-width="1" stroke-linejoin="round"/>` +
        `</svg>`
      cursor.style.transform = `translate3d(${fix.x}px, ${fix.y}px, 0)`
      document.body.append(cursor)
      element = cursor
      frozenAt = performance.now()

      // Recorded before the block, so the backstop is already armed if anything
      // between here and `settle` goes wrong.
      undo = { release: () => document.documentElement.removeAttribute(CURSOR_HIDDEN_ATTRIBUTE) }
      document.documentElement.setAttribute(CURSOR_HIDDEN_ATTRIBUTE, 'true')
      registry.push(() => restore())

      cancelBackstop = timers.after(FREEZE_BACKSTOP_MS, restore)
    },

    settle: (holdMs) => {
      const cursor = element
      const target = fix
      if (cursor === undefined) return

      // Whatever the block did not already spend. Measured from the freeze
      // rather than from here, so a hitch that was accompanied by a real block
      // does not freeze the pointer for twice the intended time.
      const remaining = Math.max(0, holdMs - (performance.now() - frozenAt))

      cancelBackstop?.()
      cancelBackstop = timers.after(remaining + HANDOVER_MS + BACKSTOP_SLACK_MS, restore)

      timers.after(remaining, () => {
        // The queued pointer events are delivered only once this task yields, so
        // a frame is the earliest moment the pointer's real position is known.
        timers.frame(() => {
          if (element !== cursor) return
          const destination = fix ?? target
          if (destination !== undefined) {
            // Snapped, not animated. An earlier version tweened the cursor
            // across to the new position, and a cursor gliding smoothly into
            // place reads as an *animation* — which is the opposite of what a
            // stalled pointer looks like. Freezing and then being somewhere else
            // is the whole tell, and it needs no transition at all.
            cursor.style.transform = `translate3d(${destination.x}px, ${destination.y}px, 0)`
          }
          cancelBackstop?.()
          cancelBackstop = timers.after(HANDOVER_MS + BACKSTOP_SLACK_MS, restore)
        })
      })
    },

    restore,

    dispose: () => {
      disposed = true
      window.removeEventListener('pointermove', onMove, { capture: true })
      fix = undefined
      restore()
    },

    get active() {
      return element !== undefined
    },
  }
}
