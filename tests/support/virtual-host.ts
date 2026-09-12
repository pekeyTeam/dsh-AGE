/**
 * A hand-rolled clock for the scheduler specs.
 *
 * `vi.useFakeTimers()` would work, but the scheduler's whole behaviour is
 * "which timers exist and in what order do they fire", and a real timer queue
 * is easier to assert on than a mocked one: `advance` below fires due callbacks
 * in chronological order, including ones scheduled by callbacks that just ran,
 * which is exactly how the browser behaves and exactly what makes the
 * self-correcting schedule testable.
 *
 * Virtual time never advances *because of* a hitch. A block is something the
 * engine does to the real thread; in here it is only a number.
 */

import type { AdmitOutcome, HitchRequest, SchedulerEvent, SchedulerHost } from '../../src/client/scheduler.ts'

/** A recorded event with the virtual instant it was emitted at. */
export interface TimedEvent {
  readonly at: number
  readonly event: SchedulerEvent
}

/** Manual-clock {@link SchedulerHost} for tests. */
export class VirtualHost implements SchedulerHost {
  #time = 0
  #nextHandle = 1
  readonly #timers = new Map<number, { at: number; fn: () => void }>()

  /** Every event emitted, in order, with its virtual timestamp. */
  readonly events: TimedEvent[] = []
  /** Milliseconds to grant per hitch, or `'full'` to grant the request unchanged. */
  grant: number | 'full' = 'full'
  /** Requests the scheduler asked for, for budget assertions. */
  readonly requests: HitchRequest[] = []

  now(): number {
    return this.#time
  }

  schedule(fn: () => void, ms: number): () => void {
    const handle = (this.#nextHandle += 1)
    this.#timers.set(handle, { at: this.#time + Math.max(0, ms), fn })
    return () => {
      this.#timers.delete(handle)
    }
  }

  admit(request: HitchRequest): AdmitOutcome {
    this.requests.push(request)
    const grantedMs = this.grant === 'full' ? request.durationMs : this.grant
    return grantedMs < 200 ? { grantedMs: 0, reason: 'budget' } : { grantedMs }
  }

  emit(event: SchedulerEvent): void {
    this.events.push({ at: this.#time, event })
  }

  /** Timers still pending; a clean dispose leaves this at zero. */
  get pendingTimers(): number {
    return this.#timers.size
  }

  /** Events of one type, in order. */
  ofType<T extends SchedulerEvent['type']>(type: T): (SchedulerEvent & { type: T })[] {
    return this.events
      .map((entry) => entry.event)
      .filter((event): event is SchedulerEvent & { type: T } => event.type === type)
  }

  /**
   * Advance virtual time, firing every callback that comes due — including
   * callbacks scheduled by callbacks that fire during this advance.
   *
   * @param ms - milliseconds to move forward.
   */
  advance(ms: number): void {
    const target = this.#time + ms
    for (let guard = 0; guard < 100_000; guard += 1) {
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (due === undefined) break
      const [handle, timer] = due
      this.#timers.delete(handle)
      this.#time = timer.at
      timer.fn()
    }
    this.#time = target
  }
}
