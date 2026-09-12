/**
 * The AGE palette, sampled from the source artwork.
 *
 * The mark's *geometry* is not here. It lives in `mark-asset.ts` as an inlined
 * PNG keyed off the source JPEG, because redrawing it as SVG paths — which this
 * file used to do — produces something that merely resembles the logo. The
 * letterforms in the real mark are specific (the chevron A with its hollow
 * counter, the hooked G, the notched E), and an approximation reads as a
 * mistake at every size the badge renders at.
 *
 * Keeping the artwork also keeps the license story simple: it is the project's
 * own asset, inlined, with no third-party font or icon set involved.
 */

export { MARK_ASPECT, MARK_DATA_URI, MARK_HEIGHT, MARK_WIDTH } from './mark-asset.ts'

/** The brand blue, sampled from the source artwork's flat field. */
export const AGE_BLUE = '#1a6ed0'

/** A darker blue, for the plate's lower edge where a flat fill needs depth. */
export const AGE_BLUE_DEEP = '#0e4fb0'

/** The wordmark's white, sampled from the source artwork. */
export const AGE_WHITE = '#fdfffe'

/** The glow drawn behind the badge while a scan is running. */
export const AGE_GLOW = 'rgba(26, 110, 208, 0.55)'

/**
 * Alert colours for the badge plate.
 *
 * The mark itself stays white in every state — that is how the source artwork is
 * built, and recolouring the letters would make the badge stop reading as the
 * brand. Only the field behind them changes.
 */
export const AGE_SCAN_AMBER = '#c98a00'

/** The plate colour while the main thread is blocked. */
export const AGE_HITCH_RED = '#c5342a'
