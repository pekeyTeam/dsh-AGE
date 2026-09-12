/**
 * @vitest-environment jsdom
 *
 * The lagging pointer.
 *
 * Two things are being tested here, and the second matters more than the first.
 *
 * The first is the effect: the platform cursor is hidden, a drawn one takes its
 * place at the last known position, it stays put for the hold, then it drags to
 * where the pointer actually is and the real cursor comes back.
 *
 * The second is that **there is no path through this module that leaves the user
 * without a visible pointer.** That is the only unrecoverable state in the whole
 * plugin, so it is asserted from every direction: no known position, a hidden
 * document, a settle that never arrives, a dispose mid-hold, a restore after
 * dispose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ARROW_PATH, CURSOR_HIDDEN_ATTRIBUTE, CURSOR_MARKER, createCursorLag,
} from '../src/client/effects/cursor-lag.ts'
import { createRegistry } from '../src/client/registry.ts'
import { FakeTimers } from './support/fake-timers.ts'
import { installPointerEventShim } from './support/pointer-event.ts'

/** Build a controller on fake timers. */
function harness() {
  const timers = new FakeTimers()
  const registry = createRegistry()
  const lag = createCursorLag(timers, registry)
  return { timers, registry, lag }
}

/** Tell the controller where the pointer is. */
function moveTo(x: number, y: number): void {
  window.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
}

/** The drawn cursor, if one is on screen. */
function drawn(): HTMLElement | null {
  return document.querySelector(`[${CURSOR_MARKER}]`)
}

/** Whether the platform cursor is currently hidden. */
function hidden(): boolean {
  return document.documentElement.hasAttribute(CURSOR_HIDDEN_ATTRIBUTE)
}

beforeEach(() => {
  installPointerEventShim()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute(CURSOR_HIDDEN_ATTRIBUTE)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('freezing the pointer', () => {
  it('hides the real cursor and draws one where the pointer was', () => {
    const { lag } = harness()
    moveTo(120, 340)
    lag.freeze()

    expect(hidden()).toBe(true)
    const cursor = drawn()
    expect(cursor).not.toBeNull()
    expect(cursor?.style.transform).toContain('translate3d(120px, 340px, 0)')
  })

  it('refuses to hide the cursor when it has nothing to draw', () => {
    // The pointer has never been seen — a fresh page with no mouse movement. A
    // hidden cursor with nothing in its place is worse than no effect at all.
    const { lag } = harness()
    lag.freeze()
    expect(drawn()).toBeNull()
    expect(hidden()).toBe(false)
  })

  it('refuses to hide the cursor in a hidden document', () => {
    const { lag } = harness()
    moveTo(10, 10)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      lag.freeze()
      expect(hidden()).toBe(false)
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    }
  })

  it('draws at most one cursor', () => {
    const { lag } = harness()
    moveTo(10, 10)
    lag.freeze()
    moveTo(60, 60)
    lag.freeze()
    expect(document.querySelectorAll(`[${CURSOR_MARKER}]`)).toHaveLength(1)
  })

  it('draws something that cannot intercept the click underneath it', () => {
    const { lag } = harness()
    moveTo(30, 30)
    lag.freeze()
    // It sits under the user's hand for the whole block; a click that landed on
    // it would be swallowed.
    expect(drawn()?.style.pointerEvents).toBe('none')
  })
})

describe('settling', () => {
  it('holds, then puts the cursor wherever the pointer actually is', () => {
    const { timers, lag } = harness()
    moveTo(100, 100)
    lag.freeze()
    // The pointer moves while the cursor is frozen — which is the whole point,
    // and which the user cannot see because their real cursor is hidden.
    moveTo(400, 260)
    lag.settle(1_000)

    timers.advance(1_000)
    timers.advance(16)
    expect(drawn()?.style.transform).toContain('translate3d(400px, 260px, 0)')
  })

  it('never animates the reposition', () => {
    // A cursor that glides into place reads as an animation, and an animation is
    // the one thing a stalled pointer never looks like. The jump is the effect.
    const { timers, lag } = harness()
    moveTo(100, 100)
    lag.freeze()
    moveTo(400, 260)
    lag.settle(1_000)
    timers.advance(1_000)
    timers.advance(16)
    expect(drawn()?.style.transition).toBe('')
  })

  it('measures the hold from the freeze, not from the call', () => {
    // The block sits between the two and has already spent the hold in wall
    // time. Scheduling a fresh delay would freeze the pointer for twice as long
    // as intended — the bug this ordering exists to prevent.
    const { timers, lag } = harness()
    moveTo(0, 0)
    const clock = vi.spyOn(performance, 'now')
    clock.mockReturnValue(0)
    lag.freeze()
    clock.mockReturnValue(1_000) // the block ran for exactly the hold
    lag.settle(1_000)

    timers.advance(16)
    expect(drawn()?.style.transform).toContain('translate3d(0px, 0px, 0)')
  })

  it('hands the real cursor back once the drag is over', () => {
    const { timers, lag } = harness()
    moveTo(50, 50)
    lag.freeze()
    lag.settle(500)
    timers.advance(5_000)

    expect(drawn()).toBeNull()
    expect(hidden()).toBe(false)
  })

  it('does nothing when no cursor is drawn', () => {
    const { timers, lag } = harness()
    lag.settle(500)
    timers.advance(5_000)
    expect(drawn()).toBeNull()
    expect(hidden()).toBe(false)
  })

  it('draws an arrow the size of the platform cursor', () => {
    // Measured against a real Windows pointer: about 11.5 by 19 CSS pixels.
    // An earlier path spanned 13.2 wide and drew a stroke on top of that, which
    // read as a cursor one size too large beside the real one it replaces.
    const points = ARROW_PATH.split(/[A-Za-z]/)
      .map((segment) => segment.trim())
      .filter((segment) => segment !== '')
      .flatMap((segment) => segment.split(/[\s,]+/).map(Number.parseFloat))
    const xs = points.filter((_, index) => index % 2 === 0)
    const ys = points.filter((_, index) => index % 2 === 1)
    expect(Math.max(...xs)).toBeCloseTo(11.5, 1)
    expect(Math.max(...ys)).toBeCloseTo(19, 1)
  })

  it('keeps the outline thin enough not to inflate it', () => {
    const { lag } = harness()
    moveTo(10, 10)
    lag.freeze()
    expect(drawn()?.innerHTML).toContain('stroke-width="1"')
  })
})

describe('there is always a way back', () => {
  it('restores the cursor on a backstop even if settle is never called', () => {
    const { timers, lag } = harness()
    moveTo(80, 80)
    lag.freeze()
    // No settle: whatever happened, the plugin must not leave the pointer gone.
    timers.advance(60_000)
    expect(hidden()).toBe(false)
    expect(drawn()).toBeNull()
  })

  it('restores on an explicit restore without dropping the listener', () => {
    const { lag } = harness()
    moveTo(80, 80)
    lag.freeze()
    lag.restore()
    expect(hidden()).toBe(false)
    expect(drawn()).toBeNull()

    // Still tracking, so the next freeze has somewhere to draw.
    lag.freeze()
    expect(drawn()).not.toBeNull()
  })

  it('restores through the shared registry, so a mid-freeze unload recovers', () => {
    const { registry, lag } = harness()
    moveTo(80, 80)
    lag.freeze()
    expect(registry.size).toBeGreaterThan(0)
    registry.restoreAll()
    expect(hidden()).toBe(false)
    expect(drawn()).toBeNull()
  })

  it('restores on dispose and stops listening', () => {
    const { lag } = harness()
    moveTo(80, 80)
    lag.freeze()
    lag.dispose()
    expect(hidden()).toBe(false)
    expect(drawn()).toBeNull()

    // A disposed controller must not draw again — the listener is gone.
    lag.freeze()
    expect(drawn()).toBeNull()
  })

  it('is safe to dispose twice, and to restore after dispose', () => {
    const { lag } = harness()
    moveTo(80, 80)
    lag.freeze()
    lag.dispose()
    expect(() => {
      lag.dispose()
      lag.restore()
    }).not.toThrow()
    expect(hidden()).toBe(false)
  })

  it('reports whether it is currently drawing', () => {
    const { timers, lag } = harness()
    moveTo(80, 80)
    expect(lag.active).toBe(false)
    lag.freeze()
    expect(lag.active).toBe(true)
    timers.advance(60_000)
    expect(lag.active).toBe(false)
  })
})
