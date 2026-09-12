/**
 * The AGE wordmark, rendered from the project's own artwork.
 *
 * The asset is a white letterform on transparency, applied as a CSS `mask`
 * rather than drawn as an `<img>`. That single choice is what makes the mark
 * usable in both places it appears: white on the blue badge, and blue in the
 * settings header — one asset, any colour, and it follows the host's light or
 * dark theme without a second file.
 *
 * `mask` rather than `background-image` because the shapes must be able to take
 * an arbitrary `background-color`; a mask is exactly "use this alpha as the
 * shape". Both the standard and `-webkit-` properties are set: Chromium has
 * supported the unprefixed form for years, but the prefix costs nothing here and
 * the badge is the first thing a user sees.
 */

import type { CSSProperties } from 'react'
import { AGE_BLUE, AGE_WHITE, MARK_ASPECT, MARK_DATA_URI } from './mark.ts'

/** How much of the plate's width is padding around the letterforms. */
const PLATE_PADDING_RATIO = 0.22

/** Corner rounding of the plate, as a fraction of its height. */
const PLATE_RADIUS_RATIO = 0.28

/** Props for {@link AgeMark}. */
export interface AgeMarkProps {
  /** Width of the letterforms themselves, in CSS pixels. */
  readonly width: number
  /** Colour the letterforms are painted. */
  readonly color?: string
  /**
   * Plate colour behind the mark.
   *
   * `null` draws the mark alone, for a surface that supplies its own field.
   * The distinction has to be `null` rather than `undefined`, because a default
   * parameter fires on `undefined`.
   */
  readonly plate?: string | null
  /** Accessible label. Omit to mark the mark decorative. */
  readonly title?: string | undefined
}

/**
 * The AGE wordmark.
 *
 * @param props - see {@link AgeMarkProps}.
 * @returns the mark, optionally on its plate.
 */
export function AgeMark({ width, color = AGE_WHITE, plate = AGE_BLUE, title }: AgeMarkProps) {
  const height = width / MARK_ASPECT
  const mask: CSSProperties = {
    display: 'block',
    width,
    height,
    backgroundColor: color,
    maskImage: `url("${MARK_DATA_URI}")`,
    WebkitMaskImage: `url("${MARK_DATA_URI}")`,
    maskSize: 'contain',
    WebkitMaskSize: 'contain',
    maskRepeat: 'no-repeat',
    WebkitMaskRepeat: 'no-repeat',
    maskPosition: 'center',
    WebkitMaskPosition: 'center',
  }

  if (plate === null) {
    return <span role={title === undefined ? 'presentation' : 'img'} aria-label={title} style={mask} />
  }

  const padding = height * PLATE_PADDING_RATIO
  return (
    <span
      role={title === undefined ? 'presentation' : 'img'}
      aria-label={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding,
        borderRadius: (height + padding * 2) * PLATE_RADIUS_RATIO,
        backgroundColor: plate,
        flex: 'none',
      }}
    >
      <span style={mask} />
    </span>
  )
}
