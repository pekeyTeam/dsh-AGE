/**
 * @vitest-environment jsdom
 *
 * The experimental precise-lag mode.
 *
 * The specs that matter here are the *drop* paths. Replaying a press is the
 * feature; refusing to replay one is the safety property, and it is the only
 * place in this repository where getting it wrong could make the UI do something
 * the user did not ask for. So there is a test per gate, and each one asserts the
 * handler was never called — not merely that nothing was replayed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createInputLag, DRAG_THRESHOLD_PX, MAX_DEFER_MS } from '../src/client/input-lag.ts'
import { FakeTimers } from './support/fake-timers.ts'
import { installPointerEventShim } from './support/pointer-event.ts'

beforeEach(() => {
  installPointerEventShim()
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** A button that counts its clicks, wired the way React's root delegation would. */
function button(): { element: HTMLButtonElement; clicks: () => number } {
  const element = document.createElement('button')
  let clicked = 0
  element.addEventListener('click', () => {
    clicked += 1
  })
  element.getBoundingClientRect = () => ({
    x: 10, y: 10, top: 10, left: 10, bottom: 40, right: 110, width: 100, height: 30, toJSON: () => ({}),
  })
  document.body.append(element)
  return { element, clicks: () => clicked }
}

/** Make `elementFromPoint` resolve to whatever the layout currently holds. */
function stubHitTest(element: Element | null): void {
  document.elementFromPoint = () => element as Element
}

const PRESS = { bubbles: true, cancelable: true, clientX: 40, clientY: 25, button: 0, buttons: 1, pointerId: 1 }

describe('interception', () => {
  it('swallows a press while armed and replays it once the window closes', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const timers = new FakeTimers()
    const lag = createInputLag(timers, () => 0)
    try {
      lag.arm(300)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      element.dispatchEvent(new PointerEvent('pointerup', { ...PRESS, buttons: 0 }))
      element.dispatchEvent(new MouseEvent('click', PRESS))

      expect(clicks()).toBe(0)
      expect(lag.heldCount).toBe(1)

      timers.advance(300)
      expect(clicks()).toBe(1)
    } finally {
      lag.dispose()
    }
  })

  it('lets everything through while disarmed', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      element.dispatchEvent(new MouseEvent('click', PRESS))
      expect(clicks()).toBe(1)
      expect(lag.heldCount).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('replays at most once per press, with no feedback loop', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const timers = new FakeTimers()
    const lag = createInputLag(timers, () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      timers.advance(10_000)
      // The replayed events pass through the capture listener, which must not
      // re-defer them.
      expect(clicks()).toBe(1)
      expect(lag.heldCount).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('brings the held press forward on an early disarm', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const timers = new FakeTimers()
    const lag = createInputLag(timers, () => 0)
    try {
      lag.arm(10_000)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      lag.disarm()
      expect(clicks()).toBe(1)
    } finally {
      lag.dispose()
    }
  })
})

describe('the drop gates', () => {
  it('drops a press whose target has left the document', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      element.remove()
      lag.disarm()
      expect(clicks()).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('drops a press when the layout moved something else under the pointer', () => {
    const { element, clicks } = button()
    const other = document.createElement('button')
    document.body.append(other)
    stubHitTest(other)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      lag.disarm()
      // Re-aiming at whatever now sits at those coordinates is the exact bug
      // this gate exists to prevent: the user aimed at one control and the
      // plugin would fire another.
      expect(clicks()).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('accepts a press whose target still contains the hit-tested node', () => {
    const { element, clicks } = button()
    const inner = document.createElement('span')
    element.append(inner)
    stubHitTest(inner)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      lag.disarm()
      expect(clicks()).toBe(1)
    } finally {
      lag.dispose()
    }
  })

  it('drops a press that turned into a drag', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      element.dispatchEvent(
        new PointerEvent('pointermove', { ...PRESS, clientX: 40 + DRAG_THRESHOLD_PX + 20, buttons: 1 }),
      )
      lag.disarm()
      // Dragging outranks clicking: the gesture was not a click, and replaying
      // it as one would fire on a control the user was dragging past.
      expect(clicks()).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('drops a press that has gone stale', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    let clock = 0
    const lag = createInputLag(new FakeTimers(), () => clock)
    try {
      lag.arm(10_000)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      clock = MAX_DEFER_MS + 1
      lag.disarm()
      // A click made two seconds ago is no longer what the user meant.
      expect(clicks()).toBe(0)
    } finally {
      lag.dispose()
    }
  })

  it('drops everything when the hit test finds nothing', () => {
    const { element, clicks } = button()
    stubHitTest(null)
    const lag = createInputLag(new FakeTimers(), () => 0)
    try {
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      lag.disarm()
      expect(clicks()).toBe(0)
    } finally {
      lag.dispose()
    }
  })
})

describe('teardown', () => {
  it('detaches every listener and holds nothing', () => {
    const { element } = button()
    stubHitTest(element)
    const lag = createInputLag(new FakeTimers(), () => 0)
    lag.arm(10_000)
    element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
    lag.dispose()
    expect(lag.heldCount).toBe(0)

    // After disposal a press must behave normally again.
    let clicks = 0
    element.addEventListener('click', () => {
      clicks += 1
    })
    element.dispatchEvent(new MouseEvent('click', PRESS))
    expect(clicks).toBe(1)
  })

  it('never blocks a press when armed twice', () => {
    const { element, clicks } = button()
    stubHitTest(element)
    const timers = new FakeTimers()
    const lag = createInputLag(timers, () => 0)
    try {
      lag.arm(100)
      lag.arm(100)
      element.dispatchEvent(new PointerEvent('pointerdown', PRESS))
      timers.advance(500)
      expect(clicks()).toBe(1)
    } finally {
      lag.dispose()
    }
  })
})
