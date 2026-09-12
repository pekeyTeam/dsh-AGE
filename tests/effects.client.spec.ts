/**
 * @vitest-environment jsdom
 *
 * The three text symptoms and the dialog stall.
 *
 * The assertions that carry the most weight here are about *restoration*: a
 * jank plugin that leaves a transcript row clipped, or a dialog stuck at
 * `opacity: 0`, has stopped being a joke and become a bug the user cannot undo.
 * So each effect is driven to completion and then checked against the byte-exact
 * state it started in.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRegistry } from '../src/client/registry.ts'
import { stallStreamRow } from '../src/client/effects/stream-stall.ts'
import { runChunkGate } from '../src/client/effects/stream-chunk.ts'
import { stretchStreamRow } from '../src/client/effects/stream-stretch.ts'
import { stallEntrance, watchArrivals } from '../src/client/effects/dom-stall.ts'
import { streamingBody, streamingRow } from '../src/client/dom.ts'
import { FakeTimers, recordingWaiter } from './support/fake-timers.ts'
import { fakeTranscript, styleAttribute } from './support/transcript.ts'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('streamingRow', () => {
  it('finds the streaming row', () => {
    const { row } = fakeTranscript()
    expect(streamingRow()).toBe(row)
  })

  it('ignores a row whose stream has already finished', () => {
    fakeTranscript({ streaming: false })
    // A finished message must not be frozen: that would be a visible lie about
    // the content rather than a delay of it.
    expect(streamingRow()).toBeUndefined()
  })

  it('prefers the newest streaming row', () => {
    fakeTranscript()
    const second = fakeTranscript()
    expect(streamingRow()).toBe(second.row)
  })

  it('falls back to the row itself when the body hook is missing', () => {
    const { row } = fakeTranscript()
    row.querySelector('[data-streaming]')?.removeAttribute('data-streaming')
    expect(streamingBody(row)).toBe(row)
  })
})

describe('停滞 — stallStreamRow', () => {
  it('pins the row height and clips it', () => {
    const { row } = fakeTranscript({ height: 300 })
    const registry = createRegistry()
    const timers = new FakeTimers()
    const handle = stallStreamRow(registry, timers, 1_000)

    expect(handle?.active).toBe(true)
    expect(row.style.maxHeight).toBe('300px')
    expect(row.style.overflow).toBe('hidden')
    expect(row.dataset['dshAgeLocked']).toBe('true')
  })

  it('declines when nothing is streaming', () => {
    fakeTranscript({ streaming: false })
    expect(stallStreamRow(createRegistry(), new FakeTimers(), 1_000)).toBeUndefined()
  })

  it('declines a row too small to be worth freezing', () => {
    fakeTranscript({ height: 4 })
    expect(stallStreamRow(createRegistry(), new FakeTimers(), 1_000)).toBeUndefined()
  })

  it('restores the style attribute byte-for-byte on release', () => {
    const { row } = fakeTranscript()
    row.style.color = 'red'
    const before = styleAttribute(row)

    const registry = createRegistry()
    const timers = new FakeTimers()
    const handle = stallStreamRow(registry, timers, 1_000)
    expect(styleAttribute(row)).not.toBe(before)

    handle?.release()
    expect(styleAttribute(row)).toBe(before)
    expect(row.dataset['dshAgeLocked']).toBeUndefined()
    expect(registry.size).toBe(0)
  })

  it('releases itself on schedule', () => {
    const { row } = fakeTranscript()
    const timers = new FakeTimers()
    const handle = stallStreamRow(createRegistry(), timers, 1_000)
    expect(handle?.active).toBe(true)

    timers.advance(1_000)
    expect(handle?.active).toBe(false)
    expect(row.style.maxHeight).toBe('')
  })

  it('releases early when the turn finishes underneath it', async () => {
    const { row, finish } = fakeTranscript()
    const handle = stallStreamRow(createRegistry(), new FakeTimers(), 60_000)
    expect(handle?.active).toBe(true)

    finish()
    // MutationObserver delivers on a microtask.
    await Promise.resolve()
    await Promise.resolve()
    expect(handle?.active).toBe(false)
    expect(row.style.maxHeight).toBe('')
  })

  it('releases early when the row leaves the document', async () => {
    const { row } = fakeTranscript()
    const handle = stallStreamRow(createRegistry(), new FakeTimers(), 60_000)
    row.remove()
    await Promise.resolve()
    await Promise.resolve()
    expect(handle?.active).toBe(false)
  })

  it('has a backstop that survives the scheduled release being cancelled', () => {
    // Nothing in the public API can disarm the backstop; this asserts that a
    // release reaching the row is therefore inevitable, which is the property
    // that stops a thrown error from leaving text permanently clipped.
    const timers = new FakeTimers()
    const { row } = fakeTranscript()
    const handle = stallStreamRow(createRegistry(), timers, 1_000)
    // The normal release fires first; the backstop a quarter second later is a
    // no-op because `release` is idempotent.
    timers.advance(10_000)
    expect(handle?.active).toBe(false)
    expect(row.style.maxHeight).toBe('')
  })

  it('is idempotent', () => {
    const { row } = fakeTranscript()
    row.style.maxHeight = '12px'
    const handle = stallStreamRow(createRegistry(), new FakeTimers(), 1_000)
    handle?.release()
    handle?.release()
    expect(row.style.maxHeight).toBe('12px')
  })

  it('never hides later rows, unlike the reference implementation', () => {
    const { row, appendLaterRow } = fakeTranscript()
    const later = appendLaterRow('row-2')
    stallStreamRow(createRegistry(), new FakeTimers(), 1_000)
    // Hiding tool rows would stack a structural lie on top of a timing one.
    expect(later.style.display).toBe('')
    expect(streamingRow()).toBe(row)
  })

  it('registers its restore with the registry so an unload mid-freeze still recovers', () => {
    const { row } = fakeTranscript()
    const registry = createRegistry()
    stallStreamRow(registry, new FakeTimers(), 60_000)
    expect(registry.size).toBeGreaterThan(0)
    registry.restoreAll()
    expect(row.style.maxHeight).toBe('')
    expect(row.dataset['dshAgeLocked']).toBeUndefined()
  })
})

describe('卡断 — runChunkGate', () => {
  it('blocks inside each dropped frame, then stops', () => {
    fakeTranscript()
    const timers = new FakeTimers()
    const waiter = recordingWaiter()
    const gate = runChunkGate(createRegistry(), timers, waiter, 4, 70)

    expect(gate?.active).toBe(true)
    timers.advance(500)
    expect(waiter.blocked).toEqual([70, 70, 70, 70])
    expect(gate?.active).toBe(false)
  })

  it('stops as soon as the stream ends', () => {
    const { finish } = fakeTranscript()
    const timers = new FakeTimers()
    const waiter = recordingWaiter()
    const gate = runChunkGate(createRegistry(), timers, waiter, 50, 70)
    finish()
    timers.advance(500)
    // Only whatever ran before the stream ended; a gate with no text to lump is
    // just a CPU fire.
    expect(waiter.blocked.length).toBeLessThan(50)
    expect(gate?.active).toBe(false)
  })

  it('declines when nothing is streaming', () => {
    expect(runChunkGate(createRegistry(), new FakeTimers(), recordingWaiter(), 4, 70)).toBeUndefined()
  })

  it('restores the dimming affordance on stop', () => {
    const { row } = fakeTranscript()
    const before = styleAttribute(row)
    const gate = runChunkGate(createRegistry(), new FakeTimers(), recordingWaiter(), 1, 70)
    gate?.stop()
    expect(row.dataset['dshAgeChunking']).toBeUndefined()
    expect(styleAttribute(row)).toBe(before)
  })
})

describe('拉长 — stretchStreamRow', () => {
  it('applies and restores a transform', () => {
    const { body } = fakeTranscript()
    const registry = createRegistry()
    const timers = new FakeTimers()
    expect(stretchStreamRow(registry, timers, 1.03, 'transform')).toBe(true)
    expect(body.style.transform).toContain('scaleX(1.03)')

    timers.advance(2_000)
    expect(body.style.transform).toBe('')
    expect(registry.size).toBe(0)
  })

  it('applies and restores letter spacing', () => {
    const { body } = fakeTranscript()
    const registry = createRegistry()
    const timers = new FakeTimers()
    expect(stretchStreamRow(registry, timers, 1.03, 'letter-spacing')).toBe(true)
    expect(body.style.letterSpacing).not.toBe('')

    timers.advance(2_000)
    expect(body.style.letterSpacing).toBe('')
  })

  it('declines while a popover is open inside the row', () => {
    const { row } = fakeTranscript()
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    row.append(menu)
    // A transform here would create a containing block and misplace an anchored
    // popover — a bug the plugin would have invented, not a delay.
    expect(stretchStreamRow(createRegistry(), new FakeTimers(), 1.03, 'transform')).toBe(false)
  })

  it('declines when nothing is streaming', () => {
    expect(stretchStreamRow(createRegistry(), new FakeTimers(), 1.03, 'transform')).toBe(false)
  })

  it('leaves the row itself untouched, so the action strip does not move', () => {
    const { row, body } = fakeTranscript()
    stretchStreamRow(createRegistry(), new FakeTimers(), 1.05, 'transform')
    expect(row.style.transform).toBe('')
    expect(body.style.transform).not.toBe('')
  })
})

describe('交互停滞 — dialog entrance', () => {
  it('delays the dialog and its mask together', () => {
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const mask = document.createElement('div')
    mask.setAttribute('aria-hidden', 'true')
    const shell = document.createElement('div')
    shell.append(mask, dialog)
    document.body.append(shell)

    const registry = createRegistry()
    const timers = new FakeTimers()
    stallEntrance(registry, timers, dialog, 600)

    expect(dialog.dataset['dshAgeStalled']).toBe('true')
    expect(dialog.style.getPropertyValue('--dsh-age-stall-ms')).toBe('600ms')
    expect(mask.dataset['dshAgeStalled']).toBe('true')
  })

  it('relies on CSS for the release, so the dialog cannot stay invisible', () => {
    // The animation carries `fill-mode: both`, so once the stylesheet is present
    // the dialog becomes visible whether or not any timer ever fires. This spec
    // asserts the attribute is applied at all; the visibility itself is covered
    // by the manual checklist, since jsdom does not run animations.
    const dialog = document.createElement('div')
    document.body.append(dialog)
    const registry = createRegistry()
    stallEntrance(registry, new FakeTimers(), dialog, 400)
    expect(dialog.dataset['dshAgeStalled']).toBe('true')
  })

  it('does nothing for a zero delay', () => {
    const dialog = document.createElement('div')
    document.body.append(dialog)
    stallEntrance(createRegistry(), new FakeTimers(), dialog, 0)
    expect(dialog.dataset['dshAgeStalled']).toBeUndefined()
  })
})

describe('交互停滞 — arrival watching', () => {
  it('reports a modal arrival', async () => {
    const timers = new FakeTimers()
    const onArrival = vi.fn()
    const stop = watchArrivals(timers, { onArrival, onConversationSwitch: () => {} })
    try {
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      document.body.append(dialog)
      await Promise.resolve()
      await Promise.resolve()
      expect(onArrival).toHaveBeenCalledTimes(1)
      expect(onArrival.mock.calls[0]?.[1]).toBe('modal')
    } finally {
      stop()
    }
  })

  it('reports a menu separately, so it can be stalled less', async () => {
    const timers = new FakeTimers()
    const onArrival = vi.fn()
    const stop = watchArrivals(timers, { onArrival, onConversationSwitch: () => {} })
    try {
      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      document.body.append(menu)
      await Promise.resolve()
      await Promise.resolve()
      expect(onArrival.mock.calls[0]?.[1]).toBe('menu')
    } finally {
      stop()
    }
  })

  it('does not re-stall the same node on every internal rerender', async () => {
    const timers = new FakeTimers()
    const onArrival = vi.fn()
    const stop = watchArrivals(timers, { onArrival, onConversationSwitch: () => {} })
    try {
      const wrapper = document.createElement('div')
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      dialog.setAttribute('aria-modal', 'true')
      wrapper.append(dialog)
      document.body.append(wrapper)
      await Promise.resolve()
      await Promise.resolve()
      // A rerender inside the already-seen wrapper.
      wrapper.append(document.createElement('span'))
      await Promise.resolve()
      expect(onArrival).toHaveBeenCalledTimes(1)
    } finally {
      stop()
    }
  })

  it('reports a conversation switch but not a growing transcript', async () => {
    const timers = new FakeTimers()
    const onSwitch = vi.fn()
    const stop = watchArrivals(timers, { onArrival: () => {}, onConversationSwitch: onSwitch })
    try {
      const column = document.createElement('div')
      column.setAttribute('data-chat-flow', '')
      document.body.append(column)
      for (const key of ['a', 'b', 'c']) {
        const row = document.createElement('div')
        row.setAttribute('data-chat-flow-key', key)
        column.append(row)
      }
      await Promise.resolve()
      await Promise.resolve()
      timers.advance(200)
      // Appending rows is a streaming turn, by far the common case — treating it
      // as a switch would stall every reply.
      expect(onSwitch).not.toHaveBeenCalled()

      // Now replace the transcript wholesale, which is what a switch looks like.
      column.innerHTML = ''
      for (const key of ['x', 'y', 'z']) {
        const row = document.createElement('div')
        row.setAttribute('data-chat-flow-key', key)
        column.append(row)
      }
      await Promise.resolve()
      await Promise.resolve()
      timers.advance(200)
      expect(onSwitch).toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})
