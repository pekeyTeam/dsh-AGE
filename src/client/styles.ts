/**
 * The plugin's stylesheet.
 *
 * Injected as one `<style data-plugin="dsh-age">` element rather than written
 * as inline styles wherever it is needed, for the two things inline styles
 * cannot express: keyframes, and descendant rules (the animation freeze has to
 * reach every element on the page, which is exactly what an inline style on one
 * node cannot do).
 *
 * The tag is owned and removed by `ensureStyles`/`removeStyles` rather than left
 * for the host's HMR sweep to find, so an uninstall leaves nothing behind.
 *
 * Everything here is namespaced by `data-dsh-age-*` attributes or the
 * `dsh-age` keyframe prefix. No host class name appears in this file, and none
 * can: they are per-build hashes.
 */

/** Attribute carrying the plugin's stylesheet, matching the host's own convention. */
const STYLE_OWNER = 'dsh-age'

/**
 * Build the stylesheet.
 *
 * @returns CSS text, with the keyframes the HUD and the modal entrance need.
 */
export function ageCss(): string {
  return `
/* ---------------------------------------------------------------- freeze -- */

/*
 * Pausing every animation and transition on the page during a hitch.
 *
 * This exists because CSS animations run on the compositor: without it, a
 * spinner keeps spinning next to a frozen page, which is the loudest possible
 * tell that the freeze is synthetic. A real engine stall takes its own
 * animations down with it.
 *
 * One very broad selector, costing a whole-tree style recalculation twice per
 * hitch. Acceptable at this page size, and gated behind a setting precisely
 * because it is the most expensive rule here.
 */
html[data-dsh-age-hitching][data-dsh-age-freeze-anim] *,
html[data-dsh-age-hitching][data-dsh-age-freeze-anim] *::before,
html[data-dsh-age-hitching][data-dsh-age-freeze-anim] *::after {
  animation-play-state: paused !important;
  transition: none !important;
}

/*
 * The transcript column is a plain scrolling box and Chromium may promote it to
 * its own compositor layer, in which case a wheel scroll keeps gliding while
 * everything else is frozen. 'overscroll-behavior' will not stop that on every
 * engine, but it stops the chained bounce that reads as "still alive", and the
 * manual checklist covers the rest.
 */
html[data-dsh-age-hitching] {
  overscroll-behavior: none;
}

/* ------------------------------------------------------------ text stall -- */

/*
 * The frozen row. 'overflow: hidden' is set inline alongside a pinned
 * max-height; this only carries the visual tell that the app is struggling.
 */
[data-dsh-age-locked] {
  transition: opacity 200ms ease-out;
}

/* The frame-drop gate's affordance: the response dims as it lumps in. */
[data-dsh-age-chunking] {
  opacity: 0.93;
  transition: opacity 120ms linear;
}

/* ----------------------------------------------------------------- modal -- */

/*
 * Delayed entrance for a dialog the scan intercepted.
 *
 * The release lives entirely in CSS, which is the point: 'animation-fill-mode:
 * both' holds the from-state through the delay and then plays the entrance with
 * no script involvement. If the plugin's timer never fires, if it is disposed
 * mid-stall, if a later hook throws — the dialog still becomes fully visible.
 * A JS-driven release would have a failure mode where the user is left staring
 * at an invisible modal; this cannot.
 *
 * The '--dsh-age-stall-ms' delay is the only thing JS sets.
 */
@keyframes dsh-age-entrance {
  from { opacity: 0; transform: scale(0.985); }
  to   { opacity: 1; transform: none; }
}
[data-dsh-age-stalled] {
  animation: dsh-age-entrance 260ms cubic-bezier(0.2, 0.7, 0.3, 1) var(--dsh-age-stall-ms, 400ms) both;
}

/*
 * Deliberately NOT done: 'pointer-events: none' on the stalled node. An
 * invisible-but-clickable dialog for half a second harms nothing; an
 * invisible-and-unclickable one is a trap, and the mask behind it closes the
 * dialog on click — so a user clicking where the button will be would dismiss
 * the very thing they were reaching for.
 */

/* ---------------------------------------------------------------- cursor -- */

/*
 * Hiding the platform cursor while a drawn one is on screen.
 *
 * The only way a page can make the pointer itself stutter: the real cursor is
 * compositor-drawn and immune to a blocked main thread, so it has to be taken
 * out of the picture for the block's duration. '!important' on the descendant
 * selector because the host styles 'cursor: pointer' on its own controls, and an
 * inherited 'none' would lose to those.
 *
 * Applied only while 'cursor-lag.ts' has a replacement actually on screen — the
 * attribute is never set without one, because a hidden cursor with nothing drawn
 * in its place is the one outcome worse than a missing effect.
 */
html[data-dsh-age-cursor-hidden],
html[data-dsh-age-cursor-hidden] * {
  cursor: none !important;
}

/* ------------------------------------------------------------------- hud -- */

@keyframes dsh-age-breath {
  0%, 100% { opacity: 0.55; transform: scale(1); }
  50%      { opacity: 1;    transform: scale(1.08); }
}
@keyframes dsh-age-scanline {
  from { transform: translateY(-10vh); opacity: 0; }
  15%  { opacity: 0.9; }
  85%  { opacity: 0.9; }
  to   { transform: translateY(110vh); opacity: 0; }
}
@keyframes dsh-age-spin {
  to { transform: rotate(360deg); }
}
@keyframes dsh-age-toast-in {
  from { opacity: 0; transform: translateY(-6px); }
  to   { opacity: 1; transform: none; }
}

[data-dsh-age-breath] {
  animation: dsh-age-breath var(--dsh-age-breath-ms, 3200ms) ease-in-out infinite;
}
[data-dsh-age-scanline] {
  animation: dsh-age-scanline 1400ms linear forwards;
}
[data-dsh-age-toast] {
  animation: dsh-age-toast-in 180ms ease-out both;
}
[data-dsh-age-spinner] {
  animation: dsh-age-spin 900ms linear infinite;
}

@media (prefers-reduced-motion: reduce) {
  [data-dsh-age-breath], [data-dsh-age-scanline], [data-dsh-age-spinner] {
    animation-duration: 6s;
  }
  /* The entrance still has to happen — it is the effect, not decoration. */
  [data-dsh-age-stalled] {
    animation-duration: 1ms;
  }
}
`.trim()
}

/**
 * Install the stylesheet, replacing any previous copy.
 *
 * Replacing rather than skipping matters under HMR: a watched rebuild
 * re-executes the bundle and must be able to ship changed CSS without the old
 * tag shadowing it.
 *
 * @returns a disposer removing the tag.
 */
export function ensureStyles(): () => void {
  const existing = [...document.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${STYLE_OWNER}"]`)]
  for (const tag of existing) tag.remove()
  const style = document.createElement('style')
  style.dataset['plugin'] = STYLE_OWNER
  style.textContent = ageCss()
  document.head.append(style)
  return () => style.remove()
}
