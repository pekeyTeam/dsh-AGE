/**
 * @vitest-environment jsdom
 *
 * The brand mark.
 *
 * The asset is generated from `assets/age.jpg` by `scripts/build-mark.py`, so
 * these specs are the guard between that script and the badge: if the keying
 * ever produces a blank or mis-sized image, or the component stops applying it,
 * the failure should be a red test rather than a badge that quietly renders
 * nothing.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { AgeMark } from '../src/client/hud/AgeMark.tsx'
import { AgeBadge } from '../src/client/hud/AgeShield.tsx'
import {
  AGE_BLUE, AGE_HITCH_RED, AGE_SCAN_AMBER, MARK_ASPECT, MARK_DATA_URI, MARK_HEIGHT, MARK_WIDTH,
} from '../src/client/hud/mark.ts'

/** Decode the data URI back to bytes. */
function assetBytes(): Buffer {
  const comma = MARK_DATA_URI.indexOf(',')
  expect(MARK_DATA_URI.startsWith('data:image/png;base64,')).toBe(true)
  return Buffer.from(MARK_DATA_URI.slice(comma + 1), 'base64')
}

/** Read width and height out of a PNG's IHDR chunk. */
function pngSize(bytes: Buffer): { width: number; height: number; signature: boolean } {
  const signature = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  // IHDR is the first chunk: 8 bytes of signature, 4 of length, 4 of type,
  // then width and height as big-endian 32-bit integers.
  return { signature, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

describe('the inlined mark', () => {
  it('is a PNG data URI', () => {
    expect(pngSize(assetBytes()).signature).toBe(true)
  })

  it('matches the dimensions the module declares', () => {
    const { width, height } = pngSize(assetBytes())
    expect(width).toBe(MARK_WIDTH)
    expect(height).toBe(MARK_HEIGHT)
  })

  it('has an aspect ratio consistent with its dimensions', () => {
    expect(MARK_ASPECT).toBeCloseTo(MARK_WIDTH / MARK_HEIGHT, 10)
  })

  it('actually contains artwork', () => {
    // A keying step that thresholded everything away would still produce a valid
    // PNG of the right size — it would just be empty, and it would compress to a
    // few hundred bytes. The letterforms are large and anti-aliased, so a real
    // mark is orders of magnitude larger than that.
    expect(assetBytes().byteLength).toBeGreaterThan(5_000)
  })

  it('is small enough to sit in a client bundle without a thought', () => {
    // The whole bundle is ~120 kB; the mark must not become the reason it grows.
    expect(assetBytes().byteLength).toBeLessThan(64_000)
  })

  it('carries no XML, so it can be embedded in a CSS url() unescaped', () => {
    // `mask-image: url("...")` would break on an unescaped quote or parenthesis.
    expect(MARK_DATA_URI).not.toContain('"')
    expect(MARK_DATA_URI).not.toContain('(')
  })
})

describe('the palette', () => {
  it('matches the colours sampled from the source artwork', () => {
    expect(AGE_BLUE).toBe('#1a6ed0')
  })

  it('gives every badge phase its own field colour', () => {
    const fields = [AGE_BLUE, AGE_SCAN_AMBER, AGE_HITCH_RED]
    expect(new Set(fields).size).toBe(fields.length)
  })
})

describe('AgeMark', () => {
  it('renders the mark as a mask, so it can be painted any colour', () => {
    const markup = renderToStaticMarkup(AgeMark({ width: 46 }))
    expect(markup).toContain('mask-image')
    expect(markup).toContain(MARK_DATA_URI.slice(0, 40))
    expect(markup).toContain('mask-size:contain')
  })

  it('sets the webkit alias too, for the same shape', () => {
    expect(renderToStaticMarkup(AgeMark({ width: 46 }))).toContain('-webkit-mask-image')
  })

  it('derives the height from the artwork rather than guessing it', () => {
    const markup = renderToStaticMarkup(AgeMark({ width: 46 }))
    expect(markup).toContain(`height:${46 / MARK_ASPECT}px`)
  })

  it('draws the brand plate by default, and the bare mark when asked', () => {
    expect(renderToStaticMarkup(AgeMark({ width: 46 }))).toContain('background-color:#1a6ed0')
    const bare = renderToStaticMarkup(AgeMark({ width: 46, plate: null }))
    // `null`, not `undefined`: a default parameter fires on `undefined`, so the
    // omitted case and the bare case have to be spelled differently.
    expect(bare).not.toContain('background-color:#1a6ed0')
  })

  it('paints the letterforms in the requested colour', () => {
    expect(renderToStaticMarkup(AgeMark({ width: 46, color: '#ff0000' }))).toContain('background-color:#ff0000')
  })

  it('is decorative when unlabelled, so it is not announced twice', () => {
    const markup = renderToStaticMarkup(AgeMark({ width: 46 }))
    expect(markup).toContain('role="presentation"')
    expect(markup).not.toContain('aria-label')
  })

  it('carries the label it is given', () => {
    const markup = renderToStaticMarkup(AgeMark({ width: 46, title: 'AGE 安全组件' }))
    expect(markup).toContain('role="img"')
    expect(markup).toContain('AGE 安全组件')
  })
})

describe('AgeBadge', () => {
  it('changes the field colour with the phase, and never the letterforms', () => {
    for (const [phase, field] of [
      ['protected', AGE_BLUE],
      ['scanning', AGE_SCAN_AMBER],
      ['blocking', AGE_HITCH_RED],
    ] as const) {
      const markup = renderToStaticMarkup(AgeBadge({ phase, title: 'AGE' }))
      expect(markup).toContain(`background-color:${field}`)
      // The wordmark stays white in every state: recolouring the letters would
      // stop the badge reading as the brand.
      expect(markup).toContain('background-color:#fdfffe')
    }
  })

  it('breathes faster the busier it is', () => {
    const beat = (phase: 'protected' | 'blocking'): string => {
      const markup = renderToStaticMarkup(AgeBadge({ phase, title: 'AGE' }))
      return /--dsh-age-breath-ms:(\d+)ms/.exec(markup)?.[1] ?? ''
    }
    expect(Number(beat('blocking'))).toBeLessThan(Number(beat('protected')))
  })
})
