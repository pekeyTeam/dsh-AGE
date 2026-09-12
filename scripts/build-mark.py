#!/usr/bin/env python3
"""Regenerate `src/client/hud/mark-asset.ts` from `assets/age.jpg`.

The source artwork is a JPEG on a flat blue field. Shipping it as-is would put a
blue rectangle on whatever surface the host happens to use, and a JPEG's
compression artefacts would survive as a grey wash around the letters. So the
blue is keyed out into an alpha channel and the result is inlined as a data URI
that the components render as a CSS mask — which is what lets the same asset be
white on the badge and blue in the settings header.

Run from the repository root:

    python scripts/build-mark.py

Requires Pillow.
"""

from __future__ import annotations

import base64
import io
import textwrap
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "assets" / "age.jpg"
TARGET = ROOT / "src" / "client" / "hud" / "mark-asset.ts"

#: Rendered width of the inlined mark. The largest consumer draws it around
#: 200 CSS px, so 512 keeps it sharp on a 2x display with room to spare.
RENDER_WIDTH = 512

#: The source carries a 1px light frame around the canvas — an export artefact,
#: not part of the mark. Measuring the content box with it in place returns the
#: whole image, so it is cropped away first.
FRAME_INSET = 3

#: Padding kept around the letterforms after cropping.
CROP_PADDING = 4

#: The two tones in the source, as relative luminance.
BLUE_LUMA = 0.299 * 26 + 0.587 * 110 + 0.114 * 208   # #1a6ed0
WHITE_LUMA = 0.299 * 253 + 0.587 * 255 + 0.114 * 254  # #fdfffe

#: Alpha ramp, as a fraction of the blue-to-white span. Wide enough to keep the
#: anti-aliased edges, narrow enough to turn every JPEG artefact into background.
RAMP_LOW = 0.25
RAMP_HIGH = 0.75


def build() -> tuple[bytes, int, int]:
    """Key the blue field out of the source artwork.

    Returns:
        The encoded PNG, plus its width and height.
    """
    source = Image.open(SOURCE).convert("RGB")
    image = source.crop(
        (FRAME_INSET, FRAME_INSET, source.width - FRAME_INSET, source.height - FRAME_INSET)
    )
    width, height = image.size
    pixels = image.load()
    span = WHITE_LUMA - BLUE_LUMA

    alpha = Image.new("L", (width, height))
    alpha_pixels = alpha.load()
    for y in range(height):
        for x in range(width):
            red, green, blue = pixels[x, y]
            level = (0.299 * red + 0.587 * green + 0.114 * blue - BLUE_LUMA) / span
            if level < RAMP_LOW:
                level = 0.0
            elif level > RAMP_HIGH:
                level = 1.0
            else:
                level = (level - RAMP_LOW) / (RAMP_HIGH - RAMP_LOW)
            alpha_pixels[x, y] = round(level * 255)

    # Crop from the alpha band, not from the composited image: a transparent
    # pixel still carries RGB, and `getbbox` on RGBA would count that as content.
    box = alpha.getbbox()
    if box is None:
        raise SystemExit("assets/age.jpg contains no mark to extract")
    box = (
        max(0, box[0] - CROP_PADDING),
        max(0, box[1] - CROP_PADDING),
        min(width, box[2] + CROP_PADDING),
        min(height, box[3] + CROP_PADDING),
    )
    cropped = alpha.crop(box)
    size = (RENDER_WIDTH, max(1, round(cropped.height * RENDER_WIDTH / cropped.width)))
    scaled = cropped.resize(size, Image.LANCZOS)

    # Premultiplied by hand: opaque pixels are pure white and transparent ones are
    # black, so a renderer that ignores alpha has nothing to halo with.
    mark = Image.new("RGBA", size, (0, 0, 0, 0))
    mark_pixels = mark.load()
    scaled_pixels = scaled.load()
    for y in range(size[1]):
        for x in range(size[0]):
            value = scaled_pixels[x, y]
            mark_pixels[x, y] = (255, 255, 255, value) if value else (0, 0, 0, 0)

    buffer = io.BytesIO()
    mark.save(buffer, "PNG", optimize=True)
    return buffer.getvalue(), size[0], size[1]


def main() -> None:
    """Write the generated module."""
    png, width, height = build()
    encoded = base64.b64encode(png).decode()
    assert encoded.isascii() and '"' not in encoded and '(' not in encoded

    # The `data:` prefix is part of the value, not decoration: the components
    # paste this straight into `mask-image: url(...)`, where a bare base64 blob
    # is a path, not an image — and the mask silently renders as a solid block.
    chunks = textwrap.wrap(encoded, 110)
    literal = [f"  '{chunks[0]}' +", *(f"  '{chunk}' +" for chunk in chunks[1:-1]), f"  '{chunks[-1]}'"]
    literal.insert(0, "  'data:image/png;base64,' +")
    joined = "\n".join(literal)

    TARGET.write_text(
        f'''/**
 * The AGE wordmark, inlined.
 *
 * This is the project's own artwork, keyed off its flat blue field so the white
 * letterforms survive as an alpha channel. That buys three things a shipped JPEG
 * could not:
 *
 * - It can be painted in any colour, because the component renders it as a CSS
 *   `mask` rather than as an image. The badge tints with the scan state, and the
 *   mark stays legible on a light or dark host theme.
 * - No white fringe, because fully transparent pixels carry black RGB rather
 *   than white — a renderer that ignores alpha would otherwise halo the letters.
 * - Nothing is fetched at runtime. The data URI is the asset: no route to serve,
 *   no request to fail, nothing to inline at build time.
 *
 * GENERATED by `scripts/build-mark.py` from `assets/age.jpg`. Edit the script,
 * not this file.
 */

/** Intrinsic width of the inlined mark, in pixels. */
export const MARK_WIDTH = {width}

/** Intrinsic height of the inlined mark, in pixels. */
export const MARK_HEIGHT = {height}

/** Width divided by height, so callers can size from one dimension. */
export const MARK_ASPECT = MARK_WIDTH / MARK_HEIGHT

/** The mark as a data URI, for use as a CSS mask. */
export const MARK_DATA_URI =
{joined}
''',
        encoding="utf-8",
        newline="\n",
    )
    print(f"wrote {TARGET.relative_to(ROOT)} | {width}x{height} | {len(png)} bytes")


if __name__ == "__main__":
    main()
