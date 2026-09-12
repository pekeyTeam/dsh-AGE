/**
 * Symptom 2 of the text trio: **卡断** — the response arrives in lumps instead
 * of flowing.
 *
 * Mechanism: a frame-drop gate. Blocking the main thread inside each animation
 * frame makes React's streaming rerenders coalesce, so instead of a smooth
 * character-by-character crawl the text appears in visible jumps. The browser
 * still paints between frames — it has to, or nothing would ever appear — which
 * is the one place where blocking per frame is correct and blocking once is not.
 *
 * This shares the plugin's single blocking primitive with every other symptom,
 * which is the point: a stall that only the text feels would be a different
 * phenomenon from a stall the whole page feels, and the whole design argument is
 * that there is only one phenomenon.
 *
 * Two guards keep it honest:
 * - It refuses to start while a hitch is in flight, because a frame-gate block
 *   nested inside a spin block would stack the two durations and blow past the
 *   continuous-block cap that `scheduler.ts` promises.
 * - It stops itself the moment nothing is streaming. A frame gate with no text
 *   to lump is just a CPU fire.
 */

import { streamingRow } from '../dom.ts'
import type { RestoreRegistry } from '../registry.ts'
import type { Timers } from '../timers.ts'
import type { Waiter } from '../hitch.ts'

/** Safety margin on the self-healing stop, in milliseconds. */
const BACKSTOP_SLACK_MS = 500

/** A live frame gate. */
export interface ChunkHandle {
  /** End the gate now. Idempotent. */
  stop(): void
  /** Whether frames are still being dropped. */
  readonly active: boolean
}

/**
 * Drop frames for a bounded number of cycles.
 *
 * @param registry - undo log, for the dimming affordance.
 * @param timers - timer seam.
 * @param waiter - the blocking primitive.
 * @param frames - how many frames to block. The caller draws this per hitch.
 * @param blockMs - milliseconds to burn inside each dropped frame.
 * @returns the live gate, or `undefined` when nothing is streaming.
 */
export function runChunkGate(
  registry: RestoreRegistry,
  timers: Timers,
  waiter: Waiter,
  frames: number,
  blockMs: number,
): ChunkHandle | undefined {
  const row = streamingRow()
  if (row === undefined || frames <= 0 || blockMs <= 0) return undefined

  // A visual tell that the app is struggling rather than that rendering broke.
  // Set on the row, not the body: the body's own transform is the stretch
  // symptom's territory and the two must stay independently reversible.
  const dim = registry.dataset(row, { dshAgeChunking: 'true' })

  let remaining = frames
  let active = true
  let cancelFrame: (() => void) | undefined

  const tick = (): void => {
    if (!active) return
    // Stop the moment the stream ends. Whatever the plan said, there is no
    // longer anything to make lumpy.
    if (streamingRow() === undefined) {
      stop()
      return
    }
    waiter.block(blockMs)
    remaining -= 1
    if (remaining <= 0) {
      stop()
      return
    }
    cancelFrame = timers.frame(tick)
  }

  cancelFrame = timers.frame(tick)
  // Armed but never stored: teardown must not be able to disarm the backstop.
  timers.after(frames * 120 + BACKSTOP_SLACK_MS, stop)

  function stop(): void {
    if (!active) return
    active = false
    cancelFrame?.()
    cancelFrame = undefined
    dim.release()
  }

  return {
    stop,
    get active() {
      return active
    },
  }
}
