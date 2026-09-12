/**
 * The experimental precise-lag mode: freeze the *input*, not the frame.
 *
 * ## Why it is off by default
 *
 * A busy-wait freezes the page but not the pointer, because the operating system
 * draws the cursor on the compositor. In a game the engine owns the cursor, so it
 * genuinely lags. This module closes that gap the only way a web page can: it
 * swallows the real events and re-dispatches them later, so the UI reacts to where
 * the pointer was several hundred milliseconds ago.
 *
 * That is also why it is not the default. It is the one component here that can
 * make the UI do something the user did not ask for, and it depends on four host
 * implementation details a dsh release is free to change: React's root-delegated
 * event handling, the absence of any `isTrusted` guard, synthetic events not
 * throwing in `setPointerCapture`, and the layout under the pointer holding
 * still. `hitch` mode has none of those dependencies and cannot misroute a click,
 * so that is what ships enabled.
 *
 * ## The one rule that matters
 *
 * **A press that cannot be proven safe is dropped, never re-aimed.**
 *
 * If the target unmounted, if the layout shifted and the pointer is now over a
 * different control, if the gesture turned into a drag — the press is discarded.
 * Dropping costs the user one re-click. Replaying onto whatever now sits at those
 * coordinates costs them a click on a button they never aimed at, which in a
 * settings dialog can mean deleting something. The asymmetry is total, so the
 * gate that decides it is deliberately paranoid.
 *
 * Verified before choosing this design: no package under `@deepseek-ai` reads
 * `event.isTrusted`, so a synthetic event is not silently ignored.
 */

import type { Timers } from './timers.ts'

/** A pointer press held back for replay. */
export interface PendingPress {
  readonly clientX: number
  readonly clientY: number
  readonly target: HTMLElement
  readonly button: number
  readonly buttons: number
  readonly pointerId: number
  readonly pointerType: string
  readonly ctrlKey: boolean
  readonly shiftKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly at: number
  /** CSS pixels the pointer travelled after the press; a drag is not a click. */
  moved: number
}

/** Presses older than this are no longer what the user meant. */
export const MAX_DEFER_MS = 1_500

/** Movement above this many pixels means the gesture was a drag. */
export const DRAG_THRESHOLD_PX = 6

/** A live precise-lag controller. */
export interface InputLag {
  /**
   * Begin swallowing input.
   * @param windowMs - how long to hold it before replaying.
   */
  arm(windowMs: number): void
  /** End the window now, replaying whatever passed the gates. Idempotent. */
  disarm(): void
  /** Detach every listener and drop anything held. */
  dispose(): void
  /** Presses currently held back, for the HUD's status line. */
  readonly heldCount: number
}

/** Pointer button events swallowed while armed. */
const BUTTON_EVENTS = ['pointerdown', 'pointerup', 'click', 'mousedown', 'mouseup'] as const

/**
 * Create the controller.
 *
 * Listeners are attached immediately and stay attached for the plugin's whole
 * life; they only *act* while armed. Attaching lazily at arm time would miss the
 * press that lands in the same tick as the scan starting — which, given the whole
 * mode exists to punish exactly that press, would be self-defeating.
 *
 * @param timers - timer seam.
 * @param now - clock, injected so tests need not wait in real time.
 * @returns the controller.
 */
export function createInputLag(timers: Timers, now: () => number = () => Date.now()): InputLag {
  /**
   * Events this controller produced. Per-instance rather than module-level: a
   * shared set would let one instance's replay slip through another's capture
   * listener, and there is no reason to couple them.
   */
  const replaying = new WeakSet<Event>()
  let armed = false
  let presses: PendingPress[] = []
  let cancelFlush: (() => void) | undefined

  /** Swallow an event without letting the host observe it. */
  const swallow = (event: Event): void => {
    event.stopPropagation()
    event.stopImmediatePropagation()
    event.preventDefault()
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (!armed || replaying.has(event)) return
    const { target } = event
    if (!(target instanceof HTMLElement)) return
    presses.push({
      clientX: event.clientX,
      clientY: event.clientY,
      target,
      button: event.button,
      buttons: event.buttons,
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      metaKey: event.metaKey,
      at: now(),
      moved: 0,
    })
    swallow(event)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (!armed || replaying.has(event)) return
    // Moves are *coalesced, never replayed*. Replaying a move fans out
    // `pointerenter`/`pointerleave` across dozens of nodes, flickers hover
    // states and breaks drag — all for an effect the frozen frame already sells.
    const press = presses.findLast((candidate) => candidate.pointerId === event.pointerId)
    if (press === undefined) return
    press.moved = Math.max(press.moved, Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY))
  }

  /** Whether a held press may be replayed onto the element it originally hit. */
  const isSafeToReplay = (press: PendingPress): boolean => {
    if (now() - press.at > MAX_DEFER_MS) return false
    if (!press.target.isConnected) return false
    if (press.moved > DRAG_THRESHOLD_PX) return false
    // The decisive gate: the pointer must still be over the control it was over
    // when the user pressed. A layout shift in between means the click would land
    // somewhere the user never aimed at.
    const under = document.elementFromPoint(press.clientX, press.clientY)
    if (under === null) return false
    return under === press.target || press.target.contains(under) || under.contains(press.target)
  }

  /** Re-dispatch one held press at its original coordinates. */
  const replay = (press: PendingPress): void => {
    const base = {
      bubbles: true,
      composed: true,
      cancelable: true,
      clientX: press.clientX,
      clientY: press.clientY,
      button: press.button,
      ctrlKey: press.ctrlKey,
      shiftKey: press.shiftKey,
      altKey: press.altKey,
      metaKey: press.metaKey,
    }
    const events: Event[] = [
      new PointerEvent('pointerdown', {
        ...base,
        buttons: press.buttons,
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        isPrimary: true,
      }),
      new PointerEvent('pointerup', {
        ...base,
        buttons: 0,
        pointerId: press.pointerId,
        pointerType: press.pointerType,
        isPrimary: true,
      }),
      new MouseEvent('click', { ...base, detail: 1 }),
    ]
    for (const event of events) {
      replaying.add(event)
      press.target.dispatchEvent(event)
    }
  }

  const flush = (): void => {
    cancelFlush = undefined
    const held = presses
    presses = []
    for (const press of held) {
      if (isSafeToReplay(press)) replay(press)
      // Otherwise the press is dropped on purpose. See the module docstring.
    }
  }

  const onButton = (event: Event): void => {
    if (!armed || replaying.has(event)) return
    // Every button event in the window is swallowed, not just the press: letting
    // a `pointerup` or `click` through would resolve the interaction twice, once
    // now and once at replay.
    swallow(event)
  }

  // Registration order is load-bearing. `onButton` calls
  // `stopImmediatePropagation`, so it must be registered *after* the specific
  // handlers — otherwise it swallows `pointerdown` before `onPointerDown` ever
  // runs, and every press is dropped instead of held. Both are capture-phase on
  // the same target, so registration order is invocation order.
  window.addEventListener('pointerdown', onPointerDown, { capture: true })
  window.addEventListener('pointermove', onPointerMove, { capture: true, passive: true })
  for (const type of BUTTON_EVENTS) {
    window.addEventListener(type, onButton, { capture: true })
  }

  return {
    arm: (ms) => {
      if (armed) return
      armed = true
      cancelFlush = timers.after(ms, flush)
    },
    disarm: () => {
      if (!armed) return
      armed = false
      cancelFlush?.()
      flush()
    },
    dispose: () => {
      armed = false
      cancelFlush?.()
      presses = []
      for (const type of BUTTON_EVENTS) {
        window.removeEventListener(type, onButton, { capture: true })
      }
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
    },
    get heldCount() {
      return presses.length
    },
  }
}
