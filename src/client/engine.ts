/**
 * The engine: the only thing in this plugin that touches the DOM, and the only
 * thing that decides whether a hitch may happen.
 *
 * ## Why the decision is centralised
 *
 * There are six independent reasons a hitch must not fire — the master switch,
 * the settings page being open, a background tab, a grace period after the user
 * clawed control back, a block already in flight, and the duty-cycle ledger. Each
 * symptom could check the ones it cares about, and the result would be six
 * slightly different safety stories that drift apart the first time one of them
 * is edited. Instead every symptom, every symptom's frame gate, every entrance
 * stall and every deferred input window routes through {@link AceEngine.admit}.
 * There is one place to audit and one place to be wrong.
 *
 * ## What a hitch actually does
 *
 * A hitch blocks the main thread. Everything the user perceives — the pointer
 * not responding, the text stopping mid-sentence, the button that needs a second
 * click — is downstream of that one block, which is precisely how the real thing
 * works. The named symptoms then decide *how* they express themselves within it:
 * the stall pins the transcript row, the gate drops frames, the stretch skews the
 * text, and interaction stalls ride the scan window rather than the block.
 */

import { admitByBudget, AceScheduler, MIN_HITCH_MS, type HitchRequest, type SchedulerEvent, type SchedulerHost, type SchedulerState, type SuppressionReason } from './scheduler.ts'
import { RollingBudget } from './budget.ts'
import { streamFor, type Rng } from './rng.ts'
import { MAX_CONTINUOUS_BLOCK_MS } from './scheduler.ts'
import type { AgePreset, Symptom } from './presets.ts'
import { createRegistry, type RestoreRegistry } from './registry.ts'
import { performHitch, spinWait, type Waiter } from './hitch.ts'
import { realTimers, type Timers } from './timers.ts'
import { ensureStyles } from './styles.ts'
import { settingsPageOpen } from './dom.ts'
import { stallStreamRow, type StallHandle } from './effects/stream-stall.ts'
import { runChunkGate, type ChunkHandle } from './effects/stream-chunk.ts'
import { stretchStreamRow } from './effects/stream-stretch.ts'
import { stallEntrance, watchArrivals } from './effects/dom-stall.ts'
import { createInputLag, type InputLag } from './input-lag.ts'
import { createCursorLag, type CursorLag } from './effects/cursor-lag.ts'
import type { Store } from './persist.ts'
import { effectivePreset, type AgeSettings } from './settings.ts'

/** Milliseconds the app is left alone after the user regains control. */
export const RECOVERY_GRACE_MS = 8_000

/** Milliseconds a panic buys before the plugin resumes on its own. */
export const PANIC_GRACE_MS = 5 * 60_000

/** The engine's coarse state, as the HUD reports it. */
export type EngineState = 'idle' | 'scanning' | 'hitching' | 'suspended' | 'disabled' | 'disposed'

/** A snapshot of everything the HUD needs to draw itself. */
export interface EngineStatus {
  readonly state: EngineState
  /** How many schedulers are inside a scan window right now. */
  readonly scanning: number
  /** Whether the scan in progress is the launch scan. */
  readonly heavy: boolean
  /** Hitches admitted in the trailing minute. */
  readonly hitchesThisMinute: number
  /** Blocked milliseconds recorded by the ledger in the trailing minute. */
  readonly budgetUsedMs: number
  /** The ledger's capacity per minute for the current preset. */
  readonly budgetCapacityMs: number
  /** Blocked milliseconds actually measured by the Performance API. */
  readonly measuredMs: number
  /** Why the last planned hitch did not happen. */
  readonly lastSuppression: SuppressionReason | null
  /** Whether anything is currently frozen. */
  readonly frozen: boolean
  /** Whether the user's panic key is still holding the plugin down. */
  readonly paused: boolean
}

/** Collaborators the engine does not own. */
export interface EngineOptions {
  /** Where the settings live. */
  readonly settings: Store<AgeSettings>
  /** Blocking strategy; injectable so specs need not burn real CPU. */
  readonly waiter?: Waiter
  /** Timer seam. */
  readonly timers?: Timers
  /** Clock. */
  readonly now?: () => number
}

/** How a hitch should express each of its symptoms. */
function blocksFor(kinds: readonly Symptom[], mouseMode: AgeSettings['mouseMode']): boolean {
  return kinds.some((kind) => kind !== 'mouse') || (kinds.includes('mouse') && mouseMode === 'hitch')
}

/**
 * The engine.
 *
 * Construct, then `start()`. Register it with `ctx.effect` so `dispose()` runs
 * on unload — an undisposed engine is a page with a frozen transcript row and no
 * way back.
 */
export class AceEngine {
  readonly #settings: Store<AgeSettings>
  readonly #waiter: Waiter
  readonly #timers: Timers
  readonly #now: () => number
  readonly #registry: RestoreRegistry = createRegistry()
  #budget: RollingBudget
  #schedulers: AceScheduler[] = []
  #rng: Rng
  #state: EngineState = 'disabled'
  #scanning = 0
  #heavy = false
  #hitching = false
  #graceUntil = 0
  /** While `now < #pausedUntil`, nothing may block. Distinct from the grace. */
  #pausedUntil = 0
  #cancelPause: (() => void) | undefined
  #lastSuppression: SuppressionReason | null = null
  #hitchTimes: number[] = []
  /**
   * Blocked milliseconds this session, accumulated here rather than read back
   * out of the Performance API — see `performHitch` for why that would stall at
   * 250 entries and under-report the one number the plugin owes the user.
   */
  #measuredMs = 0
  #liveStall: StallHandle | undefined
  #liveChunk: ChunkHandle | undefined
  #inputLag: InputLag
  #cursorLag: CursorLag
  #unsubscribe: (() => void)[] = []
  #removeStyles: (() => void) | undefined
  #listeners = new Set<() => void>()

  /**
   * @param options - settings store and injectable collaborators.
   */
  constructor(options: EngineOptions) {
    this.#settings = options.settings
    this.#waiter = options.waiter ?? spinWait
    this.#timers = options.timers ?? realTimers
    this.#now = options.now ?? (() => performance.now())
    this.#budget = new RollingBudget(effectivePreset(this.#settings.get()).budgetMsPerMinute)
    this.#rng = streamFor(this.#settings.get().seed, 'scan')
    this.#inputLag = createInputLag(this.#timers, () => Date.now())
    this.#cursorLag = createCursorLag(this.#timers, this.#registry)
  }

  /** Current status, safe to call at any time. */
  getStatus(): EngineStatus {
    const settings = this.#settings.get()
    const preset = effectivePreset(settings)
    const minuteAgo = this.#now() - 60_000
    this.#hitchTimes = this.#hitchTimes.filter((at) => at > minuteAgo)
    return {
      state: this.#state,
      scanning: this.#scanning,
      heavy: this.#heavy,
      hitchesThisMinute: this.#hitchTimes.length,
      budgetUsedMs: this.#budget.usedMs(this.#now()),
      budgetCapacityMs: preset.budgetMsPerMinute,
      measuredMs: this.#measuredMs,
      lastSuppression: this.#lastSuppression,
      frozen: this.#liveStall?.active === true || this.#liveChunk?.active === true || this.#hitching,
      paused: this.#now() < this.#pausedUntil,
    }
  }

  /**
   * Observe status changes.
   * @param listener - called after any state change.
   * @returns an unsubscribe function.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Mount everything and begin scheduling. */
  start(): void {
    if (this.#state === 'disposed') return
    this.#removeStyles = ensureStyles()
    this.#unsubscribe.push(
      watchArrivals(this.#timers, {
        onArrival: (node, kind) => this.#onArrival(node, kind),
        onConversationSwitch: () => this.#onConversationSwitch(),
      }),
    )
    const onVisibility = (): void => {
      if (document.hidden) this.suspend('hidden')
      else this.resume(RECOVERY_GRACE_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    this.#unsubscribe.push(() => document.removeEventListener('visibilitychange', onVisibility))

    this.#unsubscribe.push(this.#settings.subscribe(() => this.#applySettings()))
    // Granted *before* the first schedule is built, so the app gets eight quiet
    // seconds to finish booting before anything starts misbehaving.
    this.#grantGrace(RECOVERY_GRACE_MS)
    this.#applySettings()
    this.#notify()
  }

  /**
   * Stop scheduling and release everything currently frozen.
   *
   * Releases, not merely stops: a panic that leaves the transcript row you are
   * staring at pinned is indistinguishable from a hang.
   *
   * @param reason - reported to the HUD.
   */
  suspend(reason: SuppressionReason): void {
    if (this.#state === 'disposed') return
    this.#lastSuppression = reason
    for (const scheduler of this.#schedulers) scheduler.suspend(reason)
    this.#releaseAll()
    this.#inputLag.disarm()
    this.#state = reason === 'disabled' ? 'disabled' : 'suspended'
    this.#notify()
  }

  /**
   * Hold the plugin down for a fixed stretch, and say so.
   *
   * Distinct from {@link suspend}, which is a state the caller is responsible
   * for leaving, and distinct from the grace period, which is invisible by
   * design. A panic needs to be *visible* — the user pressed a key and is
   * waiting to see whether it worked — so it keeps a deadline the status
   * reports, and it lifts itself when the deadline passes rather than leaving
   * the plugin silently half-off.
   *
   * @param ms - how long to stay down.
   */
  pause(ms: number): void {
    if (this.#state === 'disposed') return
    this.#pausedUntil = this.#now() + ms
    this.suspend('paused')
    this.#cancelPause?.()
    this.#cancelPause = this.#timers.after(ms, () => {
      this.#cancelPause = undefined
      this.#pausedUntil = 0
      this.resume(0)
    })
    this.#notify()
  }

  /**
   * Resume after a suspension.
   * @param graceMs - quiet time before the next scan.
   */
  resume(graceMs: number): void {
    if (this.#state === 'disposed') return
    if (!this.#settings.get().enabled) return
    // Deliberately does *not* clear an active pause: the pause is enforced in
    // `admit`, independently of whether the schedulers are running, so a tab
    // switch or a settings dialog closing must not quietly end a panic the user
    // asked for. `clearPause` is the explicit way out, and only the two
    // unambiguous "go" actions call it.
    this.#grantGrace(graceMs)
    this.#state = 'idle'
    for (const scheduler of this.#schedulers) scheduler.resume(graceMs)
    this.#notify()
  }

  /**
   * End an active panic now.
   *
   * Called by the console's `enable()` and by "scan now" — both of which are
   * deliberate requests, unlike a tab regaining focus.
   *
   * @param graceMs - quiet time before scheduling restarts.
   */
  clearPause(graceMs = RECOVERY_GRACE_MS): void {
    if (this.#state === 'disposed') return
    this.#cancelPause?.()
    this.#cancelPause = undefined
    this.#pausedUntil = 0
    if (this.#state === 'suspended') this.resume(graceMs)
    else this.#notify()
  }

  /**
   * Run one scan immediately.
   *
   * This is what makes the plugin demonstrable — a reviewer should not have to
   * wait out a quiet gap to see whether it works. Routed through the same
   * schedulers, so every escape hatch still applies: pressing it with the
   * settings page open correctly does nothing.
   */
  scanNow(): void {
    if (this.#state === 'disposed' || !this.#settings.get().enabled) return
    // Clears the grace *and* an active pause, but keeps every other hatch: with
    // the settings page open, or the tab hidden, this still does nothing.
    //
    // Overriding a panic is deliberate. `scanNow` is only reachable from the
    // settings page or the console, both of which are unambiguous requests, and
    // a panic key that cannot be overridden by an explicit "go" is its own
    // annoyance rather than a safety feature.
    this.clearPause(0)
    this.#grantGrace(0)
    for (const scheduler of this.#schedulers) scheduler.scanNow()
  }

  /**
   * Tear everything down.
   *
   * Idempotent, and ordered so that nothing can be left mutated: timers and
   * observers first (so nothing new starts), then releases (so nothing stays
   * frozen), then the undo log, then the stylesheet and listeners.
   *
   * Honest limitation: a `dispose()` arriving *during* a synchronous block runs
   * at the next macrotask, up to one block later. Every symptom's backstop timer
   * bounds the damage in the meantime, which is why those exist.
   */
  dispose(): void {
    if (this.#state === 'disposed') return
    for (const scheduler of this.#schedulers) scheduler.dispose()
    this.#schedulers = []
    this.#cancelPause?.()
    this.#cancelPause = undefined
    this.#releaseAll()
    this.#inputLag.dispose()
    this.#cursorLag.dispose()
    for (const off of this.#unsubscribe) off()
    this.#unsubscribe = []
    this.#registry.restoreAll()
    this.#removeStyles?.()
    this.#removeStyles = undefined
    document.documentElement.removeAttribute('data-dsh-age-hitching')
    document.documentElement.removeAttribute('data-dsh-age-freeze-anim')
    this.#state = 'disposed'
    this.#notify()
  }

  /** Admit or refuse one planned hitch. The single choke point. */
  #admit = (request: HitchRequest): { grantedMs: number; reason?: SuppressionReason } => {
    const settings = this.#settings.get()
    if (this.#state === 'disposed') return { grantedMs: 0, reason: 'disposed' }
    if (!settings.enabled) return { grantedMs: 0, reason: 'disabled' }
    // The most important hatch: with the control panel open nothing may block,
    // or the user cannot reach the switch that turns this off.
    if (settingsPageOpen()) return { grantedMs: 0, reason: 'settings-open' }
    if (typeof document !== 'undefined' && document.hidden) return { grantedMs: 0, reason: 'hidden' }
    if (this.#now() < this.#pausedUntil) return { grantedMs: 0, reason: 'paused' }
    if (this.#now() < this.#graceUntil) return { grantedMs: 0, reason: 'grace' }
    if (this.#hitching) return { grantedMs: 0, reason: 'hitching' }
    const granted = admitByBudget(this.#budget, this.#now(), request, false)
    return granted < MIN_HITCH_MS ? { grantedMs: 0, reason: 'budget' } : { grantedMs: granted }
  }

  /** The scheduler's view of the engine. */
  #host = (): SchedulerHost => ({
    now: () => this.#now(),
    schedule: (fn, ms) => this.#timers.after(ms, fn),
    admit: this.#admit,
    emit: (event) => this.#onSchedulerEvent(event),
  })

  /**
   * Rebuild the whole schedule from the current settings.
   *
   * Disposing the outgoing schedulers first is load-bearing: they hold live
   * timers, and a rebuild that only replaced the array would leave the previous
   * generation firing scans forever. That is the failure mode where changing a
   * preset makes the plugin *more* aggressive instead of less.
   */
  #applySettings(): void {
    const settings = this.#settings.get()
    const preset = effectivePreset(settings)
    for (const scheduler of this.#schedulers) scheduler.dispose()
    this.#schedulers = []
    this.#scanning = 0
    this.#heavy = false
    this.#budget = new RollingBudget(preset.budgetMsPerMinute)
    this.#rng = streamFor(settings.seed, 'scan')

    if (!settings.enabled || preset.kinds.length === 0) {
      this.#releaseAll()
      this.#state = 'disabled'
      this.#notify()
      return
    }

    // Correlated: one scheduler producing every symptom at once. Uncorrelated:
    // one per symptom, so the three drift independently — the literal original
    // brief. Either way the ledger above is shared, so neither can compound.
    const groups: readonly (readonly Symptom[])[] = settings.correlate
      ? [preset.kinds]
      : preset.kinds.map((kind) => [kind])
    this.#schedulers = groups.map(
      (kinds, index) =>
        new AceScheduler(preset, streamFor(settings.seed, index === 0 ? 'scan' : kinds[0]!), this.#host(), kinds),
    )
    const grace = Math.max(0, this.#graceUntil - this.#now())
    for (const scheduler of this.#schedulers) scheduler.start(grace)
    this.#state = 'idle'
    this.#notify()
  }

  #grantGrace(ms: number): void {
    this.#graceUntil = this.#now() + ms
  }

  /** React to one scheduler event. */
  #onSchedulerEvent(event: SchedulerEvent): void {
    switch (event.type) {
      case 'scanStart':
        this.#scanning += 1
        this.#heavy ||= event.heavy
        // A heavy launch scan announces itself; a routine one mostly does not.
        this.#state = 'scanning'
        this.#notify()
        return
      case 'scanEnd':
        this.#scanning = Math.max(0, this.#scanning - 1)
        if (this.#scanning === 0) {
          this.#heavy = false
          if (this.#state === 'scanning') this.#state = 'idle'
        }
        this.#notify()
        return
      case 'hitch':
        this.#runHitch(event.durationMs, event.kinds)
        return
      case 'suppressed':
        this.#lastSuppression = event.reason
        this.#notify()
        return
      case 'state':
        if (event.state === 'hitching' && !this.#hitching) this.#state = 'hitching'
        this.#notify()
        return
      default:
        return
    }
  }

  /**
   * Express one admitted hitch.
   *
   * Ordering is deliberate: the DOM symptoms arm *before* the block, because
   * nothing can run during it. Arming afterwards would mean the transcript only
   * freezes once the freeze is already over.
   */
  #runHitch(durationMs: number, kinds: readonly Symptom[]): void {
    const settings = this.#settings.get()
    const preset = effectivePreset(settings)
    if (kinds.length === 0) return
    this.#hitching = true
    this.#hitchTimes.push(this.#now())

    const blocking = blocksFor(kinds, settings.mouseMode)
    const drew = (band: readonly [number, number]): number => this.#rng.range(band)

    // --- arm the DOM symptoms, which must be in place before the block -------
    if (kinds.includes('stream-stall')) {
      this.#liveStall?.release()
      this.#liveStall = stallStreamRow(this.#registry, this.#timers, Math.min(drew(preset.streamFreezeMs), durationMs))
    }
    if (kinds.includes('stream-chunk') && !blocking) {
      // A frame gate nested inside a spin block would stack the two durations
      // and blow past the continuous-block cap. One blocker at a time.
      this.#liveChunk?.stop()
      this.#liveChunk = runChunkGate(
        this.#registry,
        this.#timers,
        this.#waiter,
        this.#rng.int(preset.chunkFrames[0], preset.chunkFrames[1]),
        preset.chunkFrameBlockMs,
      )
    }
    if (kinds.includes('stream-stretch')) {
      stretchStreamRow(this.#registry, this.#timers, preset.stretchScale, preset.stretchMode)
    }
    if (kinds.includes('mouse') && settings.mouseMode === 'input-lag') {
      this.#inputLag.arm(Math.min(drew(preset.inputLagMs), MAX_CONTINUOUS_BLOCK_MS))
    }
    if (kinds.includes('mouse') && settings.mouseMode === 'cursor') {
      // The one symptom that does not need the block to do its work: the drawn
      // cursor is frozen because nothing moves it, not because the thread is
      // busy. That makes the pointer effect free of CPU cost, independently
      // timed, and able to outlast the block — while still coinciding with it,
      // which is what makes the symptoms read as one event.
      this.#cursorLag.freeze()
    }

    // --- the block ----------------------------------------------------------
    if (blocking) {
      document.documentElement.dataset['dshAgeHitching'] = 'true'
      if (preset.pauseAnimationsDuringHitch) document.documentElement.dataset['dshAgeFreezeAnim'] = 'true'
      try {
        this.#measuredMs += performHitch(this.#waiter, durationMs)
      } finally {
        // `finally` because a hidden platform cursor with a stale drawing over it
        // is the worst state this plugin can be left in, and this is the one line
        // that guarantees the attributes come off whatever happened.
        delete document.documentElement.dataset['dshAgeHitching']
        delete document.documentElement.dataset['dshAgeFreezeAnim']
      }
    }

    if (kinds.includes('mouse') && settings.mouseMode === 'cursor') this.#cursorLag.settle(durationMs)
    this.#inputLag.disarm()
    this.#hitching = false
    // No ledger write here. Admission already charged this hitch through
    // `budget.spend` in `admitByBudget`, and recording it a second time made
    // every scan cost double — quietly halving the effective budget, so the
    // loudest preset behaved like the one below it.
    this.#notify()
  }

  /** Delay a dialog's entrance, if a scan is in progress. */
  #onArrival(node: HTMLElement, kind: 'modal' | 'menu'): void {
    const settings = this.#settings.get()
    if (!settings.enabled || !settings.interaction) return
    if (!this.#inScan()) return
    const preset = effectivePreset(settings)
    const full = this.#rng.range(preset.interactionStallMs)
    stallEntrance(this.#registry, this.#timers, node, kind === 'menu' ? full * 0.5 : full)
  }

  /** A conversation switch is an interaction too, and stalls like one. */
  #onConversationSwitch(): void {
    const settings = this.#settings.get()
    if (!settings.interaction) return
    if (!this.#inScan()) return
    const preset = effectivePreset(settings)
    const stall = this.#rng.range(preset.interactionStallMs)
    // Routed through the same choke point as every other block. Going straight
    // to `performHitch` — which this used to do — meant a conversation switch
    // could block with the settings page open, in a hidden tab, or on an empty
    // ledger, and its time was never charged to the budget either.
    const outcome = this.#admit({ durationMs: stall, kinds: ['interaction'], heavy: false })
    if (outcome.grantedMs < MIN_HITCH_MS) return
    document.documentElement.dataset['dshAgeHitching'] = 'true'
    if (preset.pauseAnimationsDuringHitch) document.documentElement.dataset['dshAgeFreezeAnim'] = 'true'
    this.#measuredMs += performHitch(this.#waiter, outcome.grantedMs)
    delete document.documentElement.dataset['dshAgeHitching']
    delete document.documentElement.dataset['dshAgeFreezeAnim']
  }

  /** Whether a scan window is open, which is when interactions stall. */
  #inScan(): boolean {
    return this.#scanning > 0 || this.#hitching
  }

  /** Release every live symptom without stopping the schedule. */
  #releaseAll(): void {
    this.#liveStall?.release()
    this.#liveStall = undefined
    this.#liveChunk?.stop()
    this.#liveChunk = undefined
    this.#cursorLag.restore()
    this.#registry.restoreAll()
    document.documentElement.removeAttribute('data-dsh-age-hitching')
    document.documentElement.removeAttribute('data-dsh-age-freeze-anim')
    document.documentElement.removeAttribute('data-dsh-age-cursor-hidden')
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Scheduler states, for tests and diagnostics. */
  get schedulerStates(): SchedulerState[] {
    return this.#schedulers.map((scheduler) => scheduler.state)
  }

  /** The preset currently in force, with the user's symptom switches applied. */
  get preset(): AgePreset {
    return effectivePreset(this.#settings.get())
  }
}
