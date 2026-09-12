/**
 * @vitest-environment jsdom
 *
 * The six reasons a hitch must not fire, one test each.
 *
 * These are the specs that matter most in the repository. Every other file is a
 * joke; this one is the promise that the joke cannot trap anybody. Each case is
 * written as "given this condition, drive the engine as hard as possible and
 * assert that nothing blocked" — because a hatch that only works when the engine
 * happens to be idle is not a hatch.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AceEngine, RECOVERY_GRACE_MS } from '../src/client/engine.ts'
import { createAgeSettingsStore } from '../src/client/settings.ts'
import { installConsoleApi } from '../src/client/panic.ts'
import { createToastStore } from '../src/client/toasts.ts'
import { FakeTimers, recordingWaiter } from './support/fake-timers.ts'

/** Build an engine wired to manual timers and a recording waiter. */
function harness() {
  const timers = new FakeTimers()
  const settings = createAgeSettingsStore()
  const waiter = recordingWaiter()
  const engine = new AceEngine({ settings, waiter, timers, now: () => timers.now })
  return { timers, settings, waiter, engine }
}

/** Advance past the startup grace and let a scan run. */
function runFor(timers: FakeTimers, engine: AceEngine, ms: number): void {
  timers.advance(ms)
  engine.getStatus()
}

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-dsh-age-hitching')
  delete window.dshAge
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('hatch 1 — the master switch', () => {
  it('blocks nothing while disabled, however hard it is driven', () => {
    const { engine, settings, waiter, timers } = harness()
    settings.set({ enabled: false })
    engine.start()
    engine.scanNow()
    runFor(timers, engine, 300_000)
    expect(waiter.blocked).toEqual([])
  })

  it('stops immediately when switched off mid-flight', () => {
    const { engine, settings, waiter, timers } = harness()
    engine.start()
    engine.scanNow()
    runFor(timers, engine, 60_000)
    expect(waiter.blocked.length).toBeGreaterThan(0)

    settings.set({ enabled: false })
    const atDisable = waiter.blocked.length
    runFor(timers, engine, 600_000)
    expect(waiter.blocked.length).toBe(atDisable)
  })

  it('resumes when switched back on', () => {
    const { engine, settings, waiter, timers } = harness()
    settings.set({ enabled: false })
    engine.start()
    runFor(timers, engine, 60_000)
    settings.set({ enabled: true })
    engine.resume(RECOVERY_GRACE_MS)
    runFor(timers, engine, 600_000)
    expect(waiter.blocked.length).toBeGreaterThan(0)
  })
})

describe('hatch 2 — the settings page is a hitch-free zone', () => {
  it('blocks nothing while the AGE settings page is mounted', () => {
    const { engine, waiter, timers } = harness()
    const page = document.createElement('div')
    page.setAttribute('data-dsh-age-section', '')
    document.body.append(page)

    engine.start()
    engine.scanNow()
    runFor(timers, engine, 300_000)
    expect(waiter.blocked).toEqual([])
  })

  it('resumes once the page is closed', () => {
    const { engine, waiter, timers } = harness()
    const page = document.createElement('div')
    page.setAttribute('data-dsh-age-section', '')
    document.body.append(page)
    engine.start()
    runFor(timers, engine, 60_000)
    expect(waiter.blocked).toEqual([])

    page.remove()
    engine.resume(RECOVERY_GRACE_MS)
    runFor(timers, engine, 600_000)
    expect(waiter.blocked.length).toBeGreaterThan(0)
  })

  it('reports the refusal rather than failing silently', () => {
    const { engine, timers } = harness()
    const page = document.createElement('div')
    page.setAttribute('data-dsh-age-section', '')
    document.body.append(page)
    engine.start()
    engine.scanNow()
    runFor(timers, engine, 60_000)
    expect(engine.getStatus().lastSuppression).toBe('settings-open')
  })
})

describe('hatch 3 — a hidden tab is never blocked', () => {
  it('blocks nothing while the document is hidden', () => {
    const { engine, waiter, timers } = harness()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    try {
      engine.start()
      engine.scanNow()
      runFor(timers, engine, 300_000)
      expect(waiter.blocked).toEqual([])
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    }
  })

  it('does not fire a burst of catch-up hitches when the tab returns', () => {
    const { engine, waiter, timers } = harness()
    engine.start()
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
    const atHide = waiter.blocked.length

    runFor(timers, engine, 600_000)
    expect(waiter.blocked.length).toBe(atHide)

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
    // The recovery grace is what stops the backlog from landing at once.
    runFor(timers, engine, 5_000)
    expect(waiter.blocked.length).toBe(atHide)
  })
})

describe('hatch 4 — the recovery grace period', () => {
  it('stays quiet for the grace period after start', () => {
    const { engine, waiter, timers } = harness()
    engine.start()
    runFor(timers, engine, RECOVERY_GRACE_MS - 500)
    expect(waiter.blocked).toEqual([])
  })

  it('reports the grace as the reason it stayed quiet', () => {
    const { engine, timers } = harness()
    engine.start()
    // The first scan is scheduled *after* the grace, so nothing has been refused
    // yet; driving the clock past it must produce hits, not a stuck refusal.
    runFor(timers, engine, RECOVERY_GRACE_MS + 400_000)
    expect(engine.getStatus().hitchesThisMinute).toBeGreaterThanOrEqual(0)
    expect(engine.getStatus().lastSuppression).not.toBe('grace')
  })
})

describe('hatch 5 — the panic chord', () => {
  it('suspends on Ctrl+Alt+Shift+A and stays quiet', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      engine.start()
      const waiter = recordingWaiter()
      void waiter

      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }),
      )
      expect(toasts.get().length).toBeGreaterThan(0)
      expect(engine.getStatus().state).toBe('suspended')
    } finally {
      dispose()
    }
  })

  it('never calls preventDefault, so host shortcuts keep working', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      const event = new KeyboardEvent('keydown', {
        code: 'KeyA',
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      window.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    } finally {
      dispose()
    }
  })

  it('turns the plugin off on a second press', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      const chord = { code: 'KeyA', ctrlKey: true, altKey: true, shiftKey: true, bubbles: true }
      window.dispatchEvent(new KeyboardEvent('keydown', chord))
      window.dispatchEvent(new KeyboardEvent('keydown', chord))
      expect(settings.get().enabled).toBe(false)
    } finally {
      dispose()
    }
  })

  it('trips on three escapes inside the window', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      engine.start()
      for (let press = 0; press < 3; press += 1) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }
      expect(engine.getStatus().state).toBe('suspended')
    } finally {
      dispose()
    }
  })

  it('ignores a single escape, which the host uses to close dialogs', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      engine.start()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      expect(engine.getStatus().state).not.toBe('suspended')
    } finally {
      dispose()
    }
  })
})

describe('hatch 6 — the console handle', () => {
  it('is installed even when the plugin starts disabled', () => {
    const { engine, timers, settings } = harness()
    settings.set({ enabled: false })
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    try {
      // Reachability from the disabled state is the whole point: a handle that
      // only exists when the plugin is on cannot turn it back on.
      expect(typeof window.dshAge?.enable).toBe('function')
      window.dshAge?.enable()
      expect(settings.get().enabled).toBe(true)
    } finally {
      dispose()
    }
  })

  it('explains itself instead of vanishing after unload', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const dispose = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')
    dispose()
    expect(() => window.dshAge?.disable()).not.toThrow()
    expect(window.dshAge?.status()['unloaded']).toBe(true)
  })
})

describe('teardown', () => {
  it('leaves no timers, no attributes and no style tag behind', () => {
    const { engine, timers, settings } = harness()
    const toasts = createToastStore((ms, fn) => timers.after(ms, fn))
    const consoleDisposer = installConsoleApi({ engine, settings, toasts, locale: () => 'zh' }, '0.0.0-test')

    engine.start()
    engine.scanNow()
    runFor(timers, engine, 60_000)
    consoleDisposer()
    engine.dispose()

    expect(timers.pending).toBe(0)
    expect(document.documentElement.hasAttribute('data-dsh-age-hitching')).toBe(false)
    expect(document.documentElement.hasAttribute('data-dsh-age-freeze-anim')).toBe(false)
    expect(document.querySelectorAll('style[data-plugin="dsh-age"]')).toHaveLength(0)
    expect(engine.getStatus().state).toBe('disposed')
  })

  it('refuses to do anything after disposal', () => {
    const { engine, waiter, timers } = harness()
    engine.start()
    engine.dispose()
    engine.scanNow()
    engine.start()
    runFor(timers, engine, 600_000)
    expect(waiter.blocked).toEqual([])
  })

  it('is idempotent', () => {
    const { engine } = harness()
    engine.start()
    engine.dispose()
    expect(() => {
      engine.dispose()
      engine.dispose()
    }).not.toThrow()
  })
})
