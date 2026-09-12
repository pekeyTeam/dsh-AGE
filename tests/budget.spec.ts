import { describe, expect, it } from 'vitest'
import { RollingBudget } from '../src/client/budget.ts'

/** Largest total blocked time in any trailing window, by brute force. */
function worstTrailingWindow(history: readonly { at: number; ms: number }[], windowMs: number): number {
  let worst = 0
  for (const anchor of history) {
    let total = 0
    for (const spend of history) {
      if (spend.at > anchor.at - windowMs && spend.at <= anchor.at) total += spend.ms
    }
    worst = Math.max(worst, total)
  }
  return worst
}

describe('RollingBudget', () => {
  it('starts empty', () => {
    const budget = new RollingBudget(10_000)
    expect(budget.usedMs(0)).toBe(0)
    expect(budget.remaining(0)).toBe(10_000)
  })

  it('grants a request that fits', () => {
    const budget = new RollingBudget(10_000)
    expect(budget.spend(0, 800)).toBe(800)
    expect(budget.usedMs(0)).toBe(800)
  })

  it('truncates a request larger than the allowance', () => {
    const budget = new RollingBudget(1_000)
    expect(budget.spend(0, 5_000)).toBe(1_000)
    expect(budget.remaining(0)).toBe(0)
  })

  it('refuses once the allowance is gone', () => {
    const budget = new RollingBudget(1_000)
    budget.spend(0, 1_000)
    expect(budget.spend(10, 500)).toBe(0)
    expect(budget.usedMs(10)).toBe(1_000)
  })

  it('slides: an old spend stops counting', () => {
    const budget = new RollingBudget(1_000, 60_000)
    budget.spend(0, 1_000)
    expect(budget.remaining(59_000)).toBe(0)
    expect(budget.remaining(60_001)).toBe(1_000)
  })

  it('holds the trailing-window invariant against a hostile sequence', () => {
    // Deliberately abusive: a caller hammering for more than it can have, at
    // irregular intervals, across several window lengths.
    const budget = new RollingBudget(15_000, 60_000)
    const history: { at: number; ms: number }[] = []
    let now = 0
    for (let index = 0; index < 400; index += 1) {
      now += (index * 37) % 900
      const granted = budget.spend(now, 500 + ((index * 911) % 3_000))
      if (granted > 0) history.push({ at: now, ms: granted })
    }
    expect(worstTrailingWindow(history, 60_000)).toBeLessThanOrEqual(15_000)
  })

  it('holds the invariant at every window length at or under the configured one', () => {
    const capacity = 8_000
    const budget = new RollingBudget(capacity, 30_000)
    const history: { at: number; ms: number }[] = []
    let now = 0
    for (let index = 0; index < 200; index += 1) {
      now += (index % 13) * 120
      const granted = budget.spend(now, 400 + ((index * 617) % 2_000))
      if (granted > 0) history.push({ at: now, ms: granted })
    }
    // A shorter window can only ever contain less than the full one, so the
    // configured length is the binding case — but assert the whole family so a
    // future change to pruning cannot quietly break it.
    for (const windowMs of [5_000, 15_000, 30_000]) {
      expect(worstTrailingWindow(history, windowMs)).toBeLessThanOrEqual(capacity)
    }
  })

  it('never reports a negative remainder', () => {
    const budget = new RollingBudget(500)
    budget.spend(0, 500)
    for (const at of [0, 100, 1_000, 1_000_000]) expect(budget.remaining(at)).toBeGreaterThanOrEqual(0)
  })

  it('forgets everything on reset', () => {
    const budget = new RollingBudget(1_000)
    budget.spend(0, 1_000)
    budget.reset()
    expect(budget.usedMs(0)).toBe(0)
    expect(budget.spend(0, 1_000)).toBe(1_000)
  })

  it('records a spent block exactly once', () => {
    const budget = new RollingBudget(10_000)
    budget.spend(0, 300)
    budget.spend(0, 300)
    expect(budget.usedMs(0)).toBe(600)
  })

  it('does not record a refused block', () => {
    const budget = new RollingBudget(100)
    expect(budget.spend(0, 50)).toBe(50)
    expect(budget.spend(0, 400)).toBe(50)
    expect(budget.spend(0, 400)).toBe(0)
    expect(budget.usedMs(0)).toBe(100)
  })
})
