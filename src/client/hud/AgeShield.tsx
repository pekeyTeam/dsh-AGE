/**
 * The badge: the mark on its plate, with the breathing light.
 *
 * Split from `AgeMark.tsx` because the two change for different reasons. The
 * mark is brand artwork that should only ever be re-exported from the source
 * image; the badge is chrome that responds to what the scanner is doing —
 * field colour, glow, breath rate, size. Keeping them apart means retuning the
 * badge can never accidentally distort the letterforms, which is the mistake
 * this pair was split up to fix.
 */

import { AgeMark } from './AgeMark.tsx'
import { AGE_BLUE, AGE_GLOW, AGE_HITCH_RED, AGE_SCAN_AMBER } from './mark.ts'

/** What the scanner is doing, as far as the badge is concerned. */
export type BadgePhase = 'protected' | 'scanning' | 'blocking'

/** Plate colour per phase. */
const PLATE_COLOR: Readonly<Record<BadgePhase, string>> = {
  protected: AGE_BLUE,
  scanning: AGE_SCAN_AMBER,
  blocking: AGE_HITCH_RED,
}

/** Milliseconds per breath cycle: faster means busier. */
const BREATH_MS: Readonly<Record<BadgePhase, number>> = {
  protected: 3_200,
  scanning: 900,
  blocking: 350,
}

/** Width of the wordmark inside the badge, in CSS pixels. */
export const BADGE_MARK_WIDTH = 46

/** Props for {@link AgeBadge}. */
export interface AgeBadgeProps {
  readonly phase: BadgePhase
  /** Accessible label. */
  readonly title: string
}

/**
 * The corner badge.
 *
 * The letterforms stay white in every phase — that is how the source artwork is
 * built, and recolouring them would make the badge stop reading as the brand.
 * Only the field behind them changes, which is also how a real security
 * component signals state.
 *
 * @param props - see {@link AgeBadgeProps}.
 * @returns the badge.
 */
export function AgeBadge({ phase, title }: AgeBadgeProps) {
  const color = PLATE_COLOR[phase]
  return (
    <span
      data-dsh-age-breath=""
      style={{
        display: 'inline-flex',
        borderRadius: 10,
        // The glow carries the state across the whole badge rather than only
        // under the plate, so it reads from the corner of the eye.
        boxShadow: `0 0 10px ${AGE_GLOW}`,
        ['--dsh-age-breath-ms' as string]: `${BREATH_MS[phase]}ms`,
        ...(phase === 'protected' ? {} : { filter: `drop-shadow(0 0 6px ${color})` }),
      }}
    >
      <AgeMark width={BADGE_MARK_WIDTH} plate={color} title={title} />
    </span>
  )
}
