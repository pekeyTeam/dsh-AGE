/**
 * A scheduler driven against a simulated clock and a real ledger.
 *
 * Lives under `tests/` because it is the one home both consumers can reach:
 * `scripts/measure-duty.ts` uses it to tune the preset table, and
 * `scheduler.spec.ts` uses it to assert that each preset delivers the duty cycle
 * it declares. Shipping it in `src/` would put a simulator in the browser bundle
 * for no reason.
 *
 * The clock here advances *because of* hitches, unlike `VirtualHost`'s — a block
 * really does consume wall time, and the scheduler's refractory timers fire
 * relative to real elapsed time. That is what makes the delivered figure
 * meaningful, and it is also what exposes ordering bugs that a purely virtual
 * clock hides.
 */

import { RollingBudget } from '../../src/client/budget.ts'
import { admitByBudget, type HitchRequest, type SchedulerHost } from '../../src/client/scheduler.ts'

/** One recorded block of main-thread time. */
export interface Span {
  readonly start: number
  readonly end: number
}

/** What a simulation observed. */
export interface DutyReport {
  /** Every hitch that was admitted, in order. */
  readonly spans: readonly Span[]
  /** Total time simulated. */
  readonly totalMs: number
  /** Hitches the ledger refused. */
  readonly refused: number
  /** Scan windows opened. */
  readonly scans: number
  /** Hitches the scheduler planned, summed across scans. */
  readonly plannedHitches: number
}

/** Blocked milliseconds divided by total milliseconds. */
export function dutyCycle(report: DutyReport): number {
  const blocked = report.spans.reduce((total, span) => total + (span.end - span.start), 0)
  return blocked / report.totalMs
}

/**
 * The largest total blocked time in any window of the given length.
 *
 * The safety property, measured rather than assumed: this is the number the
 * duty-cycle ledger promises to bound.
 *
 * @param report - a completed simulation.
 * @param windowMs - window length.
 * @returns blocked milliseconds in the worst such window.
 */
export function worstWindow(report: DutyReport, windowMs: number): number {
  const anchors = new Set<number>()
  for (const span of report.spans) {
    anchors.add(span.start)
    anchors.add(span.end)
  }
  let worst = 0
  for (const anchor of anchors) {
    let total = 0
    for (const span of report.spans) {
      const overlap = Math.min(span.end, anchor) - Math.max(span.start, anchor - windowMs)
      if (overlap > 0) total += overlap
    }
    worst = Math.max(worst, total)
  }
  return worst
}

/** The spacing between consecutive hitches, start to start. */
export function cadences(report: DutyReport): number[] {
  return report.spans.slice(1).map((span, index) => span.start - report.spans[index]!.start)
}

/**
 * Run a scheduler until `untilMs` of simulated time has passed.
 *
 * @param scheduler - a scheduler already built on `host`.
 * @param host - the clock and ledger to drive it with.
 * @param untilMs - how long to simulate, after the startup grace.
 * @returns what happened.
 */
export function simulate(
  scheduler: { start(graceMs?: number): void },
  host: SimulationHost,
  untilMs: number,
): DutyReport {
  scheduler.start(1_000)
  host.run(1_000 + untilMs)
  return {
    spans: host.spans,
    totalMs: untilMs,
    refused: host.refused,
    scans: host.scans,
    plannedHitches: host.plannedHitches,
  }
}

/** The simulated clock and admission host. */
export class SimulationHost implements SchedulerHost {
  time = 0
  readonly spans: Span[] = []
  refused = 0
  scans = 0
  plannedHitches = 0
  readonly budget: RollingBudget
  #nextId = 1
  readonly #timers = new Map<number, { at: number; fn: () => void }>()
  #hitching = false

  /**
   * @param capacityMs - the preset's per-minute allowance.
   */
  constructor(capacityMs: number) {
    this.budget = new RollingBudget(capacityMs)
  }

  now(): number {
    return this.time
  }

  schedule(fn: () => void, ms: number): () => void {
    const id = (this.#nextId += 1)
    this.#timers.set(id, { at: this.time + Math.max(0, ms), fn })
    return () => this.#timers.delete(id)
  }

  admit(request: HitchRequest): { grantedMs: number; reason?: 'budget' } {
    const granted = admitByBudget(this.budget, this.time, request, this.#hitching)
    if (granted === 0) {
      this.refused += 1
      return { grantedMs: 0, reason: 'budget' }
    }
    return { grantedMs: granted }
  }

  emit(event: { type: string; durationMs?: number; plannedHitches?: number }): void {
    if (event.type === 'scanStart') {
      this.scans += 1
      this.plannedHitches += event.plannedHitches ?? 0
      return
    }
    if (event.type !== 'hitch') return
    const duration = event.durationMs ?? 0
    this.#hitching = true
    const start = this.time
    this.spans.push({ start, end: start + duration })
    // The block really occupies the thread, so the clock moves with it.
    this.time += duration
    this.#hitching = false
  }

  /**
   * Advance to `until`, firing whatever comes due.
   * @param until - target time.
   */
  run(until: number): void {
    for (let guard = 0; guard < 5_000_000 && this.time < until; guard += 1) {
      let next: [number, { at: number; fn: () => void }] | undefined
      for (const entry of this.#timers) {
        if (next === undefined || entry[1].at < next[1].at) next = entry
      }
      if (next === undefined || next[1].at > until) break
      this.#timers.delete(next[0])
      this.time = Math.max(this.time, next[1].at)
      next[1].fn()
    }
    this.time = until
  }
}
