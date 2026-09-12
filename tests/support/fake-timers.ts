/**
 * Manual timers for the DOM specs.
 *
 * The effects arm two timers each — the scheduled release and the backstop that
 * survives teardown — and the interesting assertions are about *which* of them
 * fired and in what order. A real `setTimeout` would make those specs slow and
 * non-deterministic; `vi.useFakeTimers()` would work but hides the queue behind
 * mocks that cannot easily be inspected. This is the queue, visible.
 */

import type { Timers } from '../../src/client/timers.ts'

/** One scheduled callback. */
interface Pending {
  readonly id: number
  readonly at: number
  readonly fn: () => void
}

/** A manual clock. */
export class FakeTimers implements Timers {
  #time = 0
  #nextId = 1
  #pending: Pending[] = []

  /** The current virtual time in milliseconds. */
  get now(): number {
    return this.#time
  }

  /** How many callbacks are still queued. */
  get pending(): number {
    return this.#pending.length
  }

  after(ms: number, fn: () => void): () => void {
    const id = (this.#nextId += 1)
    this.#pending.push({ id, at: this.#time + Math.max(0, ms), fn })
    return () => {
      this.#pending = this.#pending.filter((entry) => entry.id !== id)
    }
  }

  /** Frames are modelled as a 16ms tick, which is close enough for ordering. */
  frame(fn: () => void): () => void {
    return this.after(16, fn)
  }

  /**
   * Move time forward, firing everything that comes due — including callbacks
   * scheduled by callbacks that fire during this advance.
   *
   * @param ms - milliseconds to advance.
   */
  advance(ms: number): void {
    const target = this.#time + ms
    for (let guard = 0; guard < 10_000; guard += 1) {
      const due = this.#pending
        .filter((entry) => entry.at <= target)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (due === undefined) break
      this.#pending = this.#pending.filter((entry) => entry.id !== due.id)
      this.#time = due.at
      due.fn()
    }
    this.#time = target
  }

  /** Drop every queued callback without running it. */
  clear(): void {
    this.#pending = []
  }
}

/** A waiter that records instead of burning the thread. */
export function recordingWaiter(): { block: (ms: number) => void; blocked: number[] } {
  const blocked: number[] = []
  return {
    blocked,
    block: (ms) => {
      blocked.push(ms)
    },
  }
}
