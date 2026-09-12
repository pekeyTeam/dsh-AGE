/**
 * The intensity table.
 *
 * A preset is a complete description of how the fake scan behaves — every band
 * the scheduler draws from and every threshold the symptoms obey. Keeping them
 * in one table rather than scattered as constants is what makes "地狱 is
 * 重度 with the numbers turned up" auditable: there is exactly one place where
 * a value can be wrong.
 *
 * `heavy` is the default because it is the specification this plugin was built
 * to: a hitch every 5–15 seconds, each lasting 1–3 seconds. The milder presets
 * exist because a plugin that cannot be dialled down is a plugin users uninstall
 * rather than complain about.
 */

/** The symptoms a scan can produce. */
export type Symptom = 'mouse' | 'stream-stall' | 'stream-chunk' | 'stream-stretch' | 'interaction'

/** Preset identifiers, stable enough to persist in `localStorage`. */
export type PresetId = 'light' | 'medium' | 'heavy' | 'hell'

/** A complete scan-behaviour specification. All bands are `[min, max]`, inclusive, in ms. */
export interface AgePreset {
  readonly id: PresetId
  /** Quiet time between one scan ending and the next beginning. */
  readonly scanGapMs: readonly [number, number]
  /**
   * Longest a single scan's burst train may run.
   *
   * A cap, not a duration: the scan closes when its last hitch's refractory
   * elapses. A window that outlives its own hitches is dead time the user never
   * feels, and padding the schedule with it is what made every preset deliver
   * far less than it declared.
   */
  readonly scanWindowMs: readonly [number, number]
  /**
   * Hitches attempted per scan. Zero is a legal draw — a scan that finds nothing.
   *
   * An attempt, not a guarantee: over the course of a train the *budget* is what
   * binds, and refusals are the ledger doing its job. Setting this high enough
   * that the plan overshoots is how a preset's declared duty cycle becomes the
   * one it actually delivers.
   */
  readonly burstsPerScan: readonly [number, number]
  /** Duration of one main-thread block. */
  readonly hitchMs: readonly [number, number]
  /**
   * Quiet time between the end of one hitch and the start of the next.
   *
   * This, not the budget, is what sets the *character*: the ratio of
   * `hitchMs` to this is the fraction of a burst train spent blocked, so a long
   * refractory puts a hard ceiling on a preset's reachable duty cycle no matter
   * how the other bands are tuned. Kept well above `MAX_CONTINUOUS_BLOCK_MS`'s
   * neighbourhood so the renderer always gets real unblocked windows.
   */
  readonly refractoryMs: number
  /**
   * Blocked milliseconds allowed per rolling minute, across every symptom.
   *
   * The promise. At the top of the range this is the *binding* constraint — the
   * trainer plans past it and the ledger trims to it — so the delivered figure
   * tracks this number rather than falling wherever the bands happened to land.
   */
  readonly budgetMsPerMinute: number
  /** Which symptoms this preset produces at all. */
  readonly kinds: readonly Symptom[]
  /** Duration the streaming row stays height-frozen. */
  readonly streamFreezeMs: readonly [number, number]
  /** Milliseconds blocked inside each dropped animation frame. */
  readonly chunkFrameBlockMs: number
  /** How many frames the chunk gate drops per firing. */
  readonly chunkFrames: readonly [number, number]
  /** How far the streaming container stretches. */
  readonly stretchScale: number
  /**
   * How the stretch is expressed. `transform` reads as a physical pull but only
   * animates on the compositor — and it is refused outright while an anchored
   * popover is open inside the streaming row, because an inline transform
   * creates a containing block and would misposition it.
   * `letter-spacing` reflows instead, which is cheaper to reason about and the
   * right default at the intensities where nobody is looking closely.
   */
  readonly stretchMode: 'letter-spacing' | 'transform'
  /** Deferred-input window for the experimental precise-lag mode. */
  readonly inputLagMs: readonly [number, number]
  /** Delay injected before a detected interaction resolves. */
  readonly interactionStallMs: readonly [number, number]
  /** Whether a heavy scan runs once at startup, the way an engine scan does on launch. */
  readonly startupHeavyScan: boolean
  /**
   * Whether CSS animations and transitions are paused during a hitch.
   *
   * Without this, a spinner keeps spinning on the compositor next to a frozen
   * page — the single loudest tell that the freeze is synthetic, because a real
   * engine stall takes its own animations down with it.
   */
  readonly pauseAnimationsDuringHitch: boolean
}

/** The intensity table, mildest first. */
export const PRESETS: Readonly<Record<PresetId, AgePreset>> = {
  light: {
    id: 'light',
    scanGapMs: [30_000, 60_000],
    scanWindowMs: [25_000, 50_000],
    burstsPerScan: [14, 28],
    hitchMs: [200, 500],
    refractoryMs: 900,
    budgetMsPerMinute: 6_000,
    kinds: ['mouse', 'stream-chunk'],
    streamFreezeMs: [300, 700],
    chunkFrameBlockMs: 50,
    chunkFrames: [2, 5],
    stretchScale: 1.008,
    stretchMode: 'letter-spacing',
    inputLagMs: [80, 180],
    interactionStallMs: [120, 260],
    startupHeavyScan: false,
    pauseAnimationsDuringHitch: false,
  },
  medium: {
    id: 'medium',
    scanGapMs: [15_000, 35_000],
    scanWindowMs: [35_000, 65_000],
    burstsPerScan: [14, 28],
    hitchMs: [400, 1_000],
    refractoryMs: 1_200,
    budgetMsPerMinute: 10_000,
    kinds: ['mouse', 'stream-stall', 'stream-chunk', 'interaction'],
    streamFreezeMs: [600, 1_500],
    chunkFrameBlockMs: 60,
    chunkFrames: [3, 9],
    stretchScale: 1.015,
    stretchMode: 'letter-spacing',
    inputLagMs: [150, 400],
    interactionStallMs: [250, 500],
    startupHeavyScan: false,
    pauseAnimationsDuringHitch: false,
  },
  heavy: {
    id: 'heavy',
    // The specification, literally: a hitch every 5–15s, each 1–3s long.
    scanGapMs: [5_000, 15_000],
    scanWindowMs: [30_000, 70_000],
    burstsPerScan: [4, 10],
    hitchMs: [1_000, 3_000],
    // Start-to-start this is a mean of 6s — above the "最低五秒" floor the spec
    // asks for, and a hard 4s of unblocked thread after every 2s block.
    refractoryMs: 4_000,
    // 15s per rolling minute, and the binding constraint at this intensity.
    budgetMsPerMinute: 15_000,
    kinds: ['mouse', 'stream-stall', 'stream-chunk', 'stream-stretch', 'interaction'],
    streamFreezeMs: [1_200, 3_000],
    chunkFrameBlockMs: 70,
    chunkFrames: [4, 14],
    stretchScale: 1.03,
    stretchMode: 'transform',
    inputLagMs: [250, 700],
    interactionStallMs: [400, 900],
    startupHeavyScan: true,
    pauseAnimationsDuringHitch: true,
  },
  hell: {
    id: 'hell',
    scanGapMs: [1_000, 4_000],
    scanWindowMs: [40_000, 90_000],
    // Plans well past the ledger on purpose: at this intensity the budget is
    // supposed to be what stops it, so the delivered figure lands on the
    // declared 40% instead of wherever the bands happened to fall.
    burstsPerScan: [10, 24],
    hitchMs: [1_500, 2_500],
    refractoryMs: 1_200,
    budgetMsPerMinute: 24_000,
    kinds: ['mouse', 'stream-stall', 'stream-chunk', 'stream-stretch', 'interaction'],
    streamFreezeMs: [2_000, 4_500],
    chunkFrameBlockMs: 90,
    chunkFrames: [6, 24],
    stretchScale: 1.05,
    stretchMode: 'transform',
    inputLagMs: [500, 1_200],
    interactionStallMs: [700, 1_500],
    startupHeavyScan: true,
    pauseAnimationsDuringHitch: true,
  },
}

/** Presets in ascending intensity, for the settings page. */
export const PRESET_ORDER: readonly PresetId[] = ['light', 'medium', 'heavy', 'hell']

/** The preset the plugin ships with: the specification, not the compromise. */
export const DEFAULT_PRESET_ID: PresetId = 'heavy'

/**
 * Resolve a persisted id back to a preset.
 *
 * Unknown ids fall back to the default rather than throwing: a stored value
 * can survive an upgrade that renames or drops a preset, and a jank plugin that
 * fails to boot because of a stale localStorage string would be a genuine bug
 * in the only code path that is supposed to be safe.
 *
 * @param id - possibly-unknown preset identifier.
 * @returns a preset, always.
 */
export function presetOf(id: string): AgePreset {
  return PRESETS[id as PresetId] ?? PRESETS[DEFAULT_PRESET_ID]
}
