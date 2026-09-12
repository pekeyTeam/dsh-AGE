/**
 * The scan scheduler — the single source of every symptom.
 *
 * The whole realism argument of this plugin rests here. Real kernel-level
 * anti-cheat does not stutter on a metronome, and it does not stutter on three
 * independent metronomes either: it performs *scans*, a scan blocks the main
 * thread several times in a row over a short window, and every symptom the user
 * notices — the pointer, the text, the buttons — is one consequence of that one
 * blocked thread. A version where the mouse happens to lag while the text
 * happens to flow smoothly reads as fake within about a minute.
 *
 * So this object plans a scan, fires hitches inside it, and says nothing about
 * what a hitch *does*. The engine subscribes; the symptoms render it. When
 * correlation is switched off the engine simply runs several schedulers, one
 * per symptom, and the original "three independent random streams" behaviour
 * comes back — with the shared budget still enforced, so it cannot compound.
 *
 * Timing is injected rather than reaching for `setTimeout` directly, so the
 * whole state machine is exercisable under fake timers.
 */

import type { RollingBudget } from './budget.ts'
import type { Rng } from './rng.ts'
import type { AgePreset, Symptom } from './presets.ts'

/** Where the machine is right now. */
export type SchedulerState = 'idle' | 'scanning' | 'hitching' | 'refractory' | 'suspended' | 'disposed'

/** Why a hitch that was planned did not happen. */
export type SuppressionReason =
  | 'budget'
  | 'hitching'
  | 'settings-open'
  | 'hidden'
  | 'grace'
  | 'paused'
  | 'disabled'
  | 'no-target'
  | 'disposed'

/** What admission decided, and why. */
export interface AdmitOutcome {
  /** Milliseconds granted; 0 refuses the hitch. */
  readonly grantedMs: number
  /** Why it was refused. Absent on a grant, and defaulted to `budget` when read. */
  readonly reason?: SuppressionReason
}

/** A hitch the engine should render. */
export interface HitchEvent {
  readonly hitchId: number
  readonly scanId: number
  /** Milliseconds the caller should block, already clamped by admission. */
  readonly durationMs: number
  /** Which symptoms this hitch should express. */
  readonly kinds: readonly Symptom[]
  /** True for the launch scan, which the HUD announces differently. */
  readonly heavy: boolean
}

/** Everything the scheduler reports. */
export type SchedulerEvent =
  | { readonly type: 'scanStart'; readonly scanId: number; readonly plannedHitches: number; readonly heavy: boolean }
  | ({ readonly type: 'hitch' } & HitchEvent)
  | { readonly type: 'scanEnd'; readonly scanId: number }
  | { readonly type: 'suppressed'; readonly reason: SuppressionReason }
  | { readonly type: 'state'; readonly state: SchedulerState }

/** Admission decision for one planned hitch. */
export interface HitchRequest {
  readonly durationMs: number
  readonly kinds: readonly Symptom[]
  readonly heavy: boolean
}

/** Everything the scheduler needs from its owner. */
export interface SchedulerHost {
  /** Monotonic milliseconds. */
  now(): number
  /**
   * Schedule a callback.
   *
   * Must not invoke `fn` synchronously — the scheduler registers the returned
   * canceller only after this call returns.
   *
   * @param fn - callback.
   * @param ms - delay.
   * @returns a canceller, safe to call after the callback has already run.
   */
  schedule(fn: () => void, ms: number): () => void
  /**
   * Ask whether a hitch may proceed, and for how long.
   *
   * Every escape hatch and the duty-cycle ledger live behind this one call,
   * which is what makes them auditable in a single place instead of six.
   */
  admit(request: HitchRequest): AdmitOutcome
  /** Report an event. Must not throw. */
  emit(event: SchedulerEvent): void
}

/** One planned hitch inside a scan. */
interface Burst {
  /** Milliseconds from the scan's start. */
  readonly offsetMs: number
  readonly durationMs: number
  readonly kinds: readonly Symptom[]
}

/** A hitch is never allowed to block longer than this, whatever any preset says. */
export const MAX_CONTINUOUS_BLOCK_MS = 3_000

/** Below this there is no point blocking at all; the ledger is treated as empty. */
export const MIN_HITCH_MS = 200

/**
 * A scan's duration is drawn once, up front, so the window is a single plan
 * rather than a chain of dependent draws. That makes a scan reproducible from
 * the seed and makes the "hitches never overlap" invariant provable by
 * construction instead of by watching.
 */
export class AceScheduler {
  #preset: AgePreset
  readonly #rng: Rng
  readonly #host: SchedulerHost
  /** Symptoms this instance may produce; a subset of the preset's when uncorrelated. */
  readonly #kinds: readonly Symptom[]
  #state: SchedulerState = 'idle'
  #scanCounter = 0
  #hitchCounter = 0
  readonly #cancels = new Set<() => void>()
  /** Not before this instant, whatever the schedule says. */
  #notBeforeMs = 0

  /**
   * @param preset - intensity specification.
   * @param rng - this instance's own stream.
   * @param host - clock, admission and reporting.
   * @param kinds - symptoms to produce; defaults to everything the preset lists.
   */
  constructor(preset: AgePreset, rng: Rng, host: SchedulerHost, kinds?: readonly Symptom[]) {
    this.#preset = preset
    this.#rng = rng
    this.#host = host
    this.#kinds = kinds ?? preset.kinds
  }

  /** Current state, for tests and the HUD. */
  get state(): SchedulerState {
    return this.#state
  }

  /**
   * Swap the intensity table.
   *
   * Safe mid-scan: the in-flight scan finishes on its old plan and the next one
   * is drawn from the new preset. Re-planning a scan the user is already inside
   * would mean hitches appearing that were never announced to the HUD.
   *
   * @param preset - the replacement.
   */
  setPreset(preset: AgePreset): void {
    this.#preset = preset
    // A milder preset must take effect now, not after the current quiet gap.
    if (this.#state === 'idle') {
      this.#cancelAll()
      this.#scheduleScan()
    }
  }

  /**
   * Begin scheduling.
   *
   * @param graceMs - quiet time before the first scan; the plugin uses this to
   * let the app finish booting before it starts misbehaving.
   */
  start(graceMs = 0): void {
    if (this.#state === 'disposed' || this.#state === 'suspended') return
    this.#notBeforeMs = this.#host.now() + graceMs
    this.#scheduleScan()
  }

  /**
   * Stop everything and cancel the plan, without tearing down.
   *
   * @param reason - reported for the HUD's status line.
   */
  suspend(reason: SuppressionReason): void {
    if (this.#state === 'disposed') return
    this.#cancelAll()
    this.#setState('suspended')
    this.#host.emit({ type: 'suppressed', reason })
  }

  /**
   * Resume after a suspension.
   *
   * @param graceMs - quiet time before scheduling restarts.
   */
  resume(graceMs: number): void {
    if (this.#state === 'disposed') return
    this.#cancelAll()
    this.#setState('idle')
    this.start(graceMs)
  }

  /**
   * Open a scan right now, ignoring the quiet gap.
   *
   * This is what makes the plugin demonstrable: a reviewer should not have to
   * wait out a 5–15 second gap to find out whether anything works. Admission is
   * still consulted for every hitch inside it, so pressing this with the
   * settings page open correctly produces nothing at all.
   */
  scanNow(): void {
    if (this.#state === 'disposed' || this.#state === 'suspended') return
    this.#cancelAll()
    this.#setState('idle')
    this.#openScan()
  }

  /** Terminal. Cancels every timer and refuses to run again. */
  dispose(): void {
    if (this.#state === 'disposed') return
    this.#cancelAll()
    this.#setState('disposed')
  }

  /** Draw one scan's complete plan and open it. */
  #scheduleScan(): void {
    if (this.#state !== 'idle') return
    const gap = this.#rng.range(this.#preset.scanGapMs)
    const wait = Math.max(gap, this.#notBeforeMs - this.#host.now())
    this.#defer(() => this.#openScan(), wait)
  }

  /** Open a scan: draw the window, the bursts, and their symptom mixes. */
  #openScan(): void {
    if (this.#state !== 'idle') return
    const preset = this.#preset
    const scanId = (this.#scanCounter += 1)
    const heavy = preset.startupHeavyScan && scanId === 1
    const windowMs = this.#rng.range(preset.scanWindowMs)
    const planned = this.#rng.int(preset.burstsPerScan[0], preset.burstsPerScan[1])
    const { bursts, endMs } = this.#planBursts(planned, windowMs, heavy)

    this.#setState('scanning')
    this.#host.emit({ type: 'scanStart', scanId, plannedHitches: bursts.length, heavy })

    // A scan that finds nothing is a real outcome, not a degenerate case: a
    // scanner that always produces symptoms is as obviously fake as one on a
    // metronome. The draw happens above, via `burstsPerScan[0] === 0`.
    if (bursts.length === 0) {
      this.#defer(() => this.#closeScan(scanId), windowMs)
      return
    }

    for (const burst of bursts) {
      this.#deferAt(burst.offsetMs, () => this.#fireBurst(scanId, burst, heavy))
    }
    // Closed on the plan's own end rather than on the window's. Waiting out a
    // window whose hitches have all fired is dead time between scans, and it was
    // the single largest reason the delivered duty cycle sat so far under the
    // declared one. `endMs` is already bounded by `windowMs`, so the window is
    // still the cap — it just no longer pads the schedule.
    this.#deferAt(endMs, () => this.#closeScan(scanId))
  }

  /**
   * Lay out a scan's hitches.
   *
   * Offsets are drawn across the first 80% of the window so the last hitch has
   * room to finish inside it, then pushed forward until each sits at least one
   * refractory period after the previous one *ends* — which is the invariant
   * that guarantees two blocks can never overlap, and therefore that the
   * longest continuous block is bounded by a single `hitchMs` draw.
   */
  #planBursts(count: number, windowMs: number, heavy: boolean): { bursts: Burst[]; endMs: number } {
    const preset = this.#preset
    const bursts: Burst[] = []
    // Launched soon after the window opens rather than smeared across it. A scan
    // that spends most of its window idle is a scan the user never feels — which
    // is exactly what these presets used to do, and why the delivered duty cycle
    // ran two to eleven times under the declared one.
    let cursor = this.#rng.range([0, Math.min(windowMs * 0.15, 2_000)])
    let remaining = count

    while (remaining > 0) {
      const durationMs = Math.min(this.#rng.range(preset.hitchMs), MAX_CONTINUOUS_BLOCK_MS)
      // Not every symptom fires on every hitch. A hitch that reliably produced
      // all five would read as a checklist being ticked, which is the same
      // failure mode as the metronome.
      const kinds = this.#kinds.filter(() => this.#rng.next() < 0.85)
      if (cursor + durationMs > windowMs) break
      bursts.push({ offsetMs: cursor, durationMs, kinds })
      cursor += durationMs + preset.refractoryMs
      remaining -= 1
      // The launch scan runs hot: a real engine scan is dense for the first few
      // seconds after the process starts, and front-loading it is also what makes
      // the plugin's existence obvious to a first-time user.
      if (heavy && remaining > 0) {
        const extra = Math.min(this.#rng.range(preset.hitchMs), MAX_CONTINUOUS_BLOCK_MS)
        if (cursor + extra > windowMs) break
        bursts.push({ offsetMs: cursor, durationMs: extra, kinds })
        cursor += extra + preset.refractoryMs
        remaining -= 1
      }
    }
    return { bursts, endMs: cursor }
  }

  /** Attempt one hitch, through the admission choke point. */
  #fireBurst(scanId: number, burst: Burst, heavy: boolean): void {
    if (this.#state !== 'scanning' && this.#state !== 'refractory') return
    if (burst.kinds.length === 0) return
    const outcome = this.#host.admit({ durationMs: burst.durationMs, kinds: burst.kinds, heavy })
    const granted = outcome.grantedMs
    if (granted < MIN_HITCH_MS) {
      this.#host.emit({ type: 'suppressed', reason: outcome.reason ?? 'budget' })
      return
    }
    const hitchId = (this.#hitchCounter += 1)
    this.#setState('hitching')
    // Scheduled **before** the block, not after. The block is synchronous and
    // the clock does not stop for it, so a delay measured once `emit` returns
    // lands one whole block too late — leaving the machine in `hitching` while
    // the next burst arrives, where `#fireBurst`'s guard silently drops it.
    //
    // That cost the dense presets about half their hitches: hell's refractory
    // (1.2s) is shorter than its own block (up to 2.5s), so every second hitch
    // was discarded, while heavy's longer refractory hid the whole problem.
    this.#defer(() => {
      if (this.#state === 'hitching') this.#setState('refractory')
    }, granted)
    this.#host.emit({
      type: 'hitch',
      hitchId,
      scanId,
      durationMs: granted,
      kinds: burst.kinds,
      heavy,
    })
  }

  /** Close the scan and start the quiet gap. */
  #closeScan(scanId: number): void {
    if (this.#state === 'disposed' || this.#state === 'suspended') return
    this.#host.emit({ type: 'scanEnd', scanId })
    this.#setState('idle')
    this.#scheduleScan()
  }

  #setState(state: SchedulerState): void {
    if (this.#state === state) return
    this.#state = state
    this.#host.emit({ type: 'state', state })
  }

  #defer(fn: () => void, ms: number): void {
    this.#deferAt(ms, fn)
  }

  #deferAt(ms: number, fn: () => void): void {
    // The canceller is registered after `schedule` returns, so a host that ran
    // the callback synchronously would trip the temporal dead zone here. The
    // contract on `SchedulerHost.schedule` forbids that for exactly this reason.
    const cancel = this.#host.schedule(() => {
      this.#cancels.delete(cancel)
      fn()
    }, Math.max(0, ms))
    this.#cancels.add(cancel)
  }

  #cancelAll(): void {
    for (const cancel of this.#cancels) cancel()
    this.#cancels.clear()
  }
}

/**
 * Whether a hitch may proceed, given only the ledger and the invariant that two
 * blocks never overlap.
 *
 * Split out from the engine so the arithmetic can be tested without a DOM: the
 * engine's own `admit` composes this with the escape hatches.
 *
 * @param budget - shared duty-cycle ledger.
 * @param now - clock reading.
 * @param request - the planned hitch.
 * @param busy - whether a block is already in flight.
 * @returns granted milliseconds, 0 to refuse.
 */
export function admitByBudget(
  budget: RollingBudget,
  now: number,
  request: HitchRequest,
  busy: boolean,
): number {
  if (busy) return 0
  // Checked before spending, not after: `spend` records what it grants, so
  // asking for a slice and then rejecting it because the slice was too small
  // would burn the ledger on a hitch that never happened.
  if (budget.remaining(now) < MIN_HITCH_MS) return 0
  const granted = budget.spend(now, Math.min(request.durationMs, MAX_CONTINUOUS_BLOCK_MS))
  return granted < MIN_HITCH_MS ? 0 : granted
}
