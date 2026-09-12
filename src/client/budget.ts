/**
 * The duty-cycle ledger.
 *
 * This is the object that makes the plugin's central promise keepable: however
 * aggressive the preset, the page is never blocked for more than a bounded
 * fraction of wall-clock time. Every hitch, from every symptom, spends from
 * this one ledger — including when correlation is off and three independent
 * schedules are running, because three unshared ledgers would multiply the
 * freeze time by three and hand the user a permanently dead page.
 *
 * Pure: no DOM, no timers, no globals. It is the most directly testable thing
 * in the repository and it is where the safety argument actually lives.
 */

/** One admitted block of main-thread time. */
interface Spend {
  /** When the block started, in the scheduler's clock. */
  readonly at: number
  /** Milliseconds blocked. */
  readonly ms: number
}

/**
 * A sliding-window allowance of main-thread block time.
 *
 * ## What the guarantee is, exactly
 *
 * The invariant enforced is over the **trailing** window: at any instant, the
 * total blocked time in `[now - windowMs, now]` never exceeds `capacityMs`.
 * That is the guarantee that matters — it is what stops a burst of scans from
 * compounding, and it is what a user feels — but it is deliberately weaker than
 * "no window of length `windowMs` anywhere on the timeline exceeds capacity".
 * The stronger claim is not achievable by any online algorithm that must admit
 * or refuse a request without knowing the future, and pretending otherwise in
 * a docstring would be worse than the honest version.
 *
 * The residual gap is closed from the other side: `hitch.ts` caps every single
 * block at a constant, and the scheduler enforces a refractory gap between
 * them, so the worst case is bounded by construction rather than by the ledger.
 */
export class RollingBudget {
  readonly #capacityMs: number
  readonly #windowMs: number
  #spends: Spend[] = []

  /**
   * @param capacityMs - blocked milliseconds allowed per window.
   * @param windowMs - length of the sliding window, in milliseconds.
   */
  constructor(capacityMs: number, windowMs = 60_000) {
    this.#capacityMs = capacityMs
    this.#windowMs = windowMs
  }

  /** Milliseconds already spent inside the current trailing window. */
  usedMs(now: number): number {
    this.#prune(now)
    let total = 0
    for (const spend of this.#spends) total += spend.ms
    return total
  }

  /**
   * Milliseconds still available at `now`.
   * @param now - scheduler clock reading.
   * @returns the remaining allowance, never negative.
   */
  remaining(now: number): number {
    return Math.max(0, this.#capacityMs - this.usedMs(now))
  }

  /**
   * Record a block that has already been admitted.
   *
   * Callers must have gone through {@link spend}; this exists for replaying a
   * known-good history in tests.
   *
   * @param now - scheduler clock reading.
   * @param ms - milliseconds blocked.
   */
  record(now: number, ms: number): void {
    this.#prune(now)
    this.#spends.push({ at: now, ms })
  }

  /**
   * Ask for `requested` milliseconds and take whatever is granted.
   *
   * A partial grant is not a failure: a 400 ms hitch where only 250 ms was
   * affordable is still a hitch, and refusing outright whenever the request
   * does not fit would let a full ledger silently disable the plugin.
   *
   * @param now - scheduler clock reading.
   * @param requested - milliseconds the caller wants.
   * @returns the granted milliseconds, which may be 0.
   */
  spend(now: number, requested: number): number {
    const granted = Math.min(requested, this.remaining(now))
    if (granted > 0) this.#spends.push({ at: now, ms: granted })
    return granted
  }

  /** Forget every recorded block, so a fresh budget starts at `now`. */
  reset(): void {
    this.#spends = []
  }

  /** Drop spends that have aged out of the trailing window. */
  #prune(now: number): void {
    const cutoff = now - this.#windowMs
    if (this.#spends.length === 0 || (this.#spends[0]?.at ?? now) > cutoff) return
    this.#spends = this.#spends.filter((spend) => spend.at > cutoff)
  }
}
