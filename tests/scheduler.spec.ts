import { describe, expect, it } from 'vitest'
import { AceScheduler, MAX_CONTINUOUS_BLOCK_MS, admitByBudget } from '../src/client/scheduler.ts'
import { RollingBudget } from '../src/client/budget.ts'
import { PRESETS, PRESET_ORDER, presetOf, type PresetId } from '../src/client/presets.ts'
import { streamFor } from '../src/client/rng.ts'
import { VirtualHost, type TimedEvent } from './support/virtual-host.ts'
import { dutyCycle, SimulationHost, simulate, worstWindow } from './support/duty-simulation.ts'

/** Build a scheduler wired to a manual clock. */
function harness(presetId = 'heavy', seed = 'test-seed', kinds?: readonly string[]) {
  const host = new VirtualHost()
  const preset = presetOf(presetId)
  const scheduler = new AceScheduler(
    preset,
    streamFor(seed, 'scan'),
    host,
    kinds as never,
  )
  return { host, preset, scheduler }
}

/**
 * Advance until the machine is between scans.
 *
 * A scan is legitimately open at an arbitrary instant, so "every scanStart has
 * a scanEnd" is only assertable at rest. Stepping in small increments and
 * stopping the moment the state is `idle` lands exactly on that boundary —
 * the next scan is a whole quiet gap away.
 */
function settle(host: VirtualHost, scheduler: AceScheduler, budgetMs = 300_000): void {
  const step = 100
  for (let elapsed = 0; elapsed < budgetMs && scheduler.state !== 'idle'; elapsed += step) {
    host.advance(step)
  }
}

/** The virtual instants at which hitches started, paired with their duration. */
function hitchSpans(events: readonly TimedEvent[]): { start: number; end: number }[] {
  return events
    .filter((entry) => entry.event.type === 'hitch')
    .map((entry) => ({
      start: entry.at,
      end: entry.at + (entry.event as { durationMs: number }).durationMs,
    }))
}

describe('AceScheduler lifecycle', () => {
  it('walks idle → scanning → hitching → refractory and back to idle', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    expect(scheduler.state).toBe('idle')

    host.advance(60_000)
    const states = host.ofType('state').map((event) => event.state)
    expect(states).toContain('scanning')
    expect(states).toContain('hitching')
    expect(states).toContain('refractory')

    settle(host, scheduler)
    expect(scheduler.state).toBe('idle')
    // Back at rest, every scan that opened also closed.
    expect(host.ofType('scanStart').length).toBe(host.ofType('scanEnd').length)
  })

  it('emits scanStart before its hitches and scanEnd after them', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    host.advance(120_000)
    settle(host, scheduler)

    const order = host.events
      .map((entry) => entry.event.type)
      .filter((type) => type === 'scanStart' || type === 'hitch' || type === 'scanEnd')
    expect(order.length).toBeGreaterThan(3)
    expect(order[0]).toBe('scanStart')
    expect(order.at(-1)).toBe('scanEnd')

    // Each scan's hitches sit inside its own open/close pair.
    let open = 0
    for (const type of order) {
      if (type === 'scanStart') open += 1
      if (type === 'scanEnd') open -= 1
      expect(open).toBeGreaterThanOrEqual(0)
    }
    expect(open).toBe(0)
  })

  it('reports the scan a hitch belongs to', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    host.advance(60_000)

    const scanIds = new Set(host.ofType('scanStart').map((event) => event.scanId))
    for (const hitch of host.ofType('hitch')) expect(scanIds.has(hitch.scanId)).toBe(true)
  })

  it('produces no hitches before the grace period elapses', () => {
    const { host, scheduler } = harness('light')
    scheduler.start(10_000)
    host.advance(10_000)
    expect(host.ofType('hitch')).toHaveLength(0)
  })

  it('stops producing anything once suspended', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    host.advance(30_000)
    const before = host.ofType('hitch').length
    expect(before).toBeGreaterThan(0)

    scheduler.suspend('hidden')
    host.advance(300_000)
    expect(host.ofType('hitch').length).toBe(before)
    expect(scheduler.state).toBe('suspended')
  })

  it('resumes with a fresh grace period after a suspension', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    host.advance(30_000)
    scheduler.suspend('hidden')
    const before = host.ofType('hitch').length

    scheduler.resume(20_000)
    host.advance(19_000)
    expect(host.ofType('hitch').length).toBe(before)
    host.advance(60_000)
    expect(host.ofType('hitch').length).toBeGreaterThan(before)
  })

  it('cancels every timer on dispose and refuses to run again', () => {
    const { host, scheduler } = harness()
    scheduler.start()
    host.advance(30_000)
    scheduler.dispose()
    expect(host.pendingTimers).toBe(0)
    expect(scheduler.state).toBe('disposed')

    const before = host.events.length
    scheduler.start()
    host.advance(300_000)
    expect(host.events.length).toBe(before)
  })
})

describe('AceScheduler safety invariants', () => {
  it('never lets two hitches overlap', () => {
    for (const presetId of ['light', 'medium', 'heavy', 'hell'] as const) {
      const { host, scheduler, preset } = harness(presetId, `seed-${presetId}`)
      scheduler.start()
      host.advance(600_000)

      const spans = hitchSpans(host.events)
      expect(spans.length).toBeGreaterThan(0)
      for (let index = 1; index < spans.length; index += 1) {
        const previous = spans[index - 1]!
        const current = spans[index]!
        expect(current.start).toBeGreaterThanOrEqual(previous.end + preset.refractoryMs)
      }
    }
  })

  it('never exceeds the hard continuous block cap, whatever the preset asks', () => {
    const { host, scheduler } = harness('hell')
    scheduler.start()
    host.advance(600_000)
    for (const hitch of host.ofType('hitch')) {
      expect(hitch.durationMs).toBeLessThanOrEqual(MAX_CONTINUOUS_BLOCK_MS)
    }
  })

  it('never asks admission for a block longer than the cap', () => {
    const { host, scheduler } = harness('hell')
    scheduler.start()
    host.advance(600_000)
    for (const request of host.requests) {
      expect(request.durationMs).toBeLessThanOrEqual(MAX_CONTINUOUS_BLOCK_MS)
    }
  })

  it('reports a suppression instead of a hitch when admission grants nothing', () => {
    const { host, scheduler } = harness()
    host.grant = 0
    scheduler.start()
    host.advance(120_000)
    expect(host.ofType('hitch')).toHaveLength(0)
    expect(host.ofType('suppressed').length).toBeGreaterThan(0)
  })

  it('uses the duration admission granted, not the one it planned', () => {
    const { host, scheduler } = harness()
    host.grant = 250
    scheduler.start()
    host.advance(120_000)
    const hitches = host.ofType('hitch')
    expect(hitches.length).toBeGreaterThan(0)
    for (const hitch of hitches) expect(hitch.durationMs).toBe(250)
  })

  it('honours the specification cadence: a hitch never closer than 5s to the last', () => {
    // The brief asked for a hitch every 5–15 seconds. Start-to-start is what a
    // user actually measures, and it is `hitchMs + refractoryMs` — so the floor
    // is a property of the pair, not of the refractory alone.
    const { host, scheduler, preset } = harness('heavy')
    expect(preset.refractoryMs + preset.hitchMs[0]).toBeGreaterThanOrEqual(5_000)
    scheduler.start()
    host.advance(600_000)
    const spans = hitchSpans(host.events)
    expect(spans.length).toBeGreaterThan(1)
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!.start - spans[index - 1]!.start).toBeGreaterThanOrEqual(5_000)
    }
  })
})

describe('AceScheduler planning', () => {
  it('can open a scan that produces nothing', () => {
    // A scanner that always finds something is as obviously synthetic as a
    // metronome, so zero bursts has to be a reachable draw.
    const host = new VirtualHost()
    const preset = { ...presetOf('heavy'), burstsPerScan: [0, 0] as const }
    const scheduler = new AceScheduler(preset, streamFor('empty', 'scan'), host)
    scheduler.start()
    host.advance(300_000)
    settle(host, scheduler)
    expect(host.ofType('hitch')).toHaveLength(0)
    // The scans still happen and still open and close — they just find nothing.
    expect(host.ofType('scanStart').length).toBeGreaterThan(0)
    expect(host.ofType('scanStart').length).toBe(host.ofType('scanEnd').length)
  })

  it('does not fire every symptom on every hitch', () => {
    const { host, scheduler } = harness('heavy')
    scheduler.start()
    host.advance(900_000)
    const mixes = new Set(host.ofType('hitch').map((event) => [...event.kinds].sort().join('+')))
    // All five symptoms are enabled; a hitch that always carried all five would
    // read as a checklist, so the mix must actually vary.
    expect(mixes.size).toBeGreaterThan(1)
  })

  it('restricts an uncorrelated instance to its own symptom', () => {
    const { host, scheduler } = harness('heavy', 'seed', ['mouse'])
    scheduler.start()
    host.advance(600_000)
    const hitches = host.ofType('hitch')
    expect(hitches.length).toBeGreaterThan(0)
    for (const hitch of hitches) expect([...hitch.kinds]).toEqual(['mouse'])
  })

  it('marks only the first scan of a startup preset as heavy', () => {
    const { host, scheduler } = harness('heavy')
    scheduler.start()
    host.advance(600_000)
    const scans = host.ofType('scanStart')
    expect(scans[0]?.heavy).toBe(true)
    for (const scan of scans.slice(1)) expect(scan.heavy).toBe(false)
  })

  it('never marks a scan heavy when the preset forbids it', () => {
    const { host, scheduler } = harness('light')
    scheduler.start()
    host.advance(600_000)
    for (const scan of host.ofType('scanStart')) expect(scan.heavy).toBe(false)
  })

  it('re-plans on a preset change rather than finishing the old plan', () => {
    const { host, scheduler } = harness('hell')
    scheduler.start()
    host.advance(5_000)
    const before = host.ofType('scanStart').length
    scheduler.setPreset(presetOf('light'))
    host.advance(600_000)
    expect(host.ofType('scanStart').length).toBeGreaterThan(before)
    settle(host, scheduler)
    expect(host.ofType('scanEnd').length).toBe(host.ofType('scanStart').length)
  })
})

describe('AceScheduler determinism', () => {
  it('replays byte-identical event logs from the same seed', () => {
    const run = (): TimedEvent[] => {
      const { host, scheduler } = harness('heavy', 'golden-seed')
      scheduler.start()
      host.advance(600_000)
      return host.events
    }
    const first = run()
    const second = run()
    expect(first.length).toBeGreaterThan(10)
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
  })

  it('diverges when the seed changes', () => {
    const run = (seed: string): string => {
      const { host, scheduler } = harness('heavy', seed)
      scheduler.start()
      host.advance(600_000)
      return JSON.stringify(host.events)
    }
    expect(run('seed-a')).not.toBe(run('seed-b'))
  })
})

describe('admitByBudget', () => {
  it('refuses while a block is already in flight', () => {
    const budget = new RollingBudget(60_000)
    expect(admitByBudget(budget, 0, { durationMs: 500, kinds: [], heavy: false }, true)).toBe(0)
    expect(budget.usedMs(0)).toBe(0)
  })

  it('clamps to the hard cap even with unlimited budget', () => {
    const budget = new RollingBudget(60_000_000)
    expect(admitByBudget(budget, 0, { durationMs: 99_999, kinds: [], heavy: false }, false))
      .toBe(MAX_CONTINUOUS_BLOCK_MS)
  })

  it('refuses rather than granting a useless sliver', () => {
    const budget = new RollingBudget(1_000)
    budget.record(0, 850)
    expect(admitByBudget(budget, 0, { durationMs: 2_000, kinds: [], heavy: false }, false)).toBe(0)
    // The refusal must not have consumed the 150ms it could not have used well.
    expect(budget.remaining(0)).toBe(150)
  })

  it('grants everything when the ledger is full', () => {
    const budget = new RollingBudget(15_000)
    expect(admitByBudget(budget, 0, { durationMs: 1_200, kinds: [], heavy: false }, false)).toBe(1_200)
    expect(budget.usedMs(0)).toBe(1_200)
  })
})

describe('delivered duty cycle', () => {
  /**
   * Ten virtual minutes each. Long enough for the scan cadence to average out,
   * short enough that four presets stay well inside a second of test time.
   */
  const MINUTES = 10

  /** Run one preset against a simulated clock and a real ledger. */
  function deliver(id: PresetId) {
    const preset = PRESETS[id]
    const host = new SimulationHost(preset.budgetMsPerMinute)
    const scheduler = new AceScheduler(preset, streamFor(`duty-${id}`, 'scan'), host)
    return { preset, report: simulate(scheduler, host, MINUTES * 60_000) }
  }

  it.each(PRESET_ORDER)('%s delivers most of the budget it declares', (id) => {
    const { preset, report } = deliver(id)
    const declared = preset.budgetMsPerMinute / 60_000
    const delivered = dutyCycle(report)
    // This is the regression guard for a real bug: the scheduler used to lay its
    // hitches out across the front of a scan window and then wait out the rest of
    // it, and a `#fireBurst` guard silently discarded every second hitch in the
    // denser presets. Together they made the delivered figure run from 2x to 11x
    // under the declared one, which no unit test noticed because every individual
    // band was being respected — the *product* of the bands was not.
    // The margin is real but not vast: measured ratios run 0.85–0.97 across the
    // four presets, and 0.75 is the threshold that both clears the quietest of
    // them and fails the ordering bug, which left hell at 0.74.
    expect(delivered).toBeGreaterThan(declared * 0.75)
  })

  it.each(PRESET_ORDER)('%s never exceeds its budget in any rolling minute', (id) => {
    const { preset, report } = deliver(id)
    // The safety property, measured rather than assumed. The ledger is the
    // promise; this is the arithmetic that backs it.
    expect(worstWindow(report, 60_000)).toBeLessThanOrEqual(preset.budgetMsPerMinute)
  })

  it.each(PRESET_ORDER)('%s produces hitches at all', (id) => {
    const { report } = deliver(id)
    expect(report.spans.length).toBeGreaterThan(0)
  })

  it('ranks the presets by what they deliver, not just by what they claim', () => {
    const delivered = PRESET_ORDER.map((id) => dutyCycle(deliver(id).report))
    expect(delivered).toEqual([...delivered].sort((left, right) => left - right))
  })
})

describe('preset table', () => {
  it('specifies the documented default: a hitch every 5–15s lasting 1–3s', () => {
    const heavy = PRESETS.heavy
    expect(heavy.scanGapMs).toEqual([5_000, 15_000])
    expect(heavy.hitchMs).toEqual([1_000, 3_000])
  })

  it('keeps every preset under the hard cap', () => {
    for (const preset of Object.values(PRESETS)) {
      expect(preset.hitchMs[1]).toBeLessThanOrEqual(MAX_CONTINUOUS_BLOCK_MS)
    }
  })

  it('leaves real unblocked thread between hitches in every preset', () => {
    // The refractory is what bounds the *character* of a burst train: a preset
    // whose refractory approached its own block duration would hold the renderer
    // under water continuously, which no preset should do however loud it is.
    // The figure is a floor, not the old 3s — that value was a conservative read
    // of a hang-detection threshold, and it capped every preset's reachable duty
    // cycle so hard that the declared budgets were unreachable.
    for (const preset of Object.values(PRESETS)) {
      expect(preset.refractoryMs).toBeGreaterThanOrEqual(500)
      expect(preset.refractoryMs).toBeGreaterThanOrEqual(MAX_CONTINUOUS_BLOCK_MS / 4)
    }
  })

  it('declares budgets that leave the page usable', () => {
    for (const preset of Object.values(PRESETS)) {
      // Even the loudest preset must spend most of every minute unblocked.
      expect(preset.budgetMsPerMinute).toBeLessThanOrEqual(40_000)
    }
  })

  it('orders the budget by intensity', () => {
    const budgets = [PRESETS.light, PRESETS.medium, PRESETS.heavy, PRESETS.hell].map(
      (preset) => preset.budgetMsPerMinute,
    )
    expect(budgets).toEqual([...budgets].sort((left, right) => left - right))
  })

  it('falls back to the default for an unknown id', () => {
    expect(presetOf('nonsense').id).toBe('heavy')
    expect(presetOf('light').id).toBe('light')
  })
})
