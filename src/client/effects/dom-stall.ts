/**
 * Symptom 3 of the brief: **everything interactive stalls** — the settings
 * dialog, a conversation switch, a new conversation.
 *
 * ## Observe outcomes, never predict triggers
 *
 * The tempting implementation is a capture-phase click listener matching the
 * settings button, the sidebar rows, the new-conversation button. It is also the
 * fragile one: the sidebar exposes **no** `data-*` hooks at all (verified against
 * the shipped client — there is not one `data-testid` in the whole package), so
 * every one of those matches would be against visible copy or a hashed class
 * name, and would break silently the first time the host rewords a button or a
 * user switches language.
 *
 * So this watches what *arrived* instead. A dialog appearing is unambiguous, and
 * it is the thing the user perceives. The cost is that the stall begins when the
 * dialog mounts rather than before it — which, given the effect is a delayed
 * entrance, is indistinguishable from the real thing.
 *
 * Trigger prediction is still available behind a setting, for anyone who wants
 * the stall to land on the click itself; it is off by default because a
 * copy-matching rule is a maintenance liability dressed as a feature.
 */

import { FLOW_COLUMN_SELECTOR, MENU_SELECTOR, MODAL_SELECTOR, flowKeys } from '../dom.ts'
import type { RestoreRegistry } from '../registry.ts'
import type { Timers } from '../timers.ts'

/** Debounce for the transcript-identity comparison. */
const SWITCH_DEBOUNCE_MS = 120

/**
 * Below this share of rows surviving a swap, the transcript is treated as a
 * different conversation rather than the same one growing.
 */
const SWITCH_OVERLAP_THRESHOLD = 0.5

/** Slack after the entrance animation before the attribute is cleaned up. */
const ENTRANCE_CLEANUP_SLACK_MS = 900

/** The two arrival kinds. A menu is a lighter affordance than a modal. */
export type ArrivalKind = 'modal' | 'menu'

/** What a stalled arrival looks like to the engine. */
export interface ArrivalHandlers {
  /**
   * A dialog or menu mounted.
   * @param node - the mounted element.
   * @param kind - which affordance arrived; the engine scales the delay by it.
   */
  onArrival(node: HTMLElement, kind: ArrivalKind): void
  /** The transcript was replaced wholesale, which reads as a conversation switch. */
  onConversationSwitch(): void
}

/**
 * Delay a dialog's entrance.
 *
 * The release is deliberately **CSS-only**: the attribute selects a keyframe
 * animation with `animation-fill-mode: both`, which holds the dialog invisible
 * through the delay and then plays the entrance with no script involvement. If
 * the plugin's cleanup timer never fires, the dialog still appears.
 *
 * That is strictly safer than the obvious JS-driven version, which has a failure
 * mode where a disposed plugin leaves the user staring at an invisible modal.
 * This function only sets a CSS variable and an attribute; the animation is the
 * guarantee.
 *
 * `pointer-events` is deliberately left alone. An invisible-but-clickable dialog
 * for half a second harms nothing; an invisible-and-unclickable one is a trap,
 * and the mask behind it closes the dialog — so a user clicking where the button
 * is about to be would dismiss the very thing they were reaching for.
 *
 * @param registry - undo log.
 * @param timers - timer seam.
 * @param dialog - the dialog element.
 * @param delayMs - entrance delay.
 */
export function stallEntrance(
  registry: RestoreRegistry,
  timers: Timers,
  dialog: HTMLElement,
  delayMs: number,
): void {
  if (delayMs <= 0) return
  // The mask fades with the dialog so the two read as one surface arriving.
  const mask = dialog.parentElement?.querySelector<HTMLElement>('[aria-hidden="true"]')
  const targets = mask === undefined || mask === null ? [dialog] : [dialog, mask]

  for (const target of targets) {
    const marks = registry.dataset(target, { dshAgeStalled: 'true' })
    const variable = registry.styles(target, { '--dsh-age-stall-ms': `${delayMs}ms` })
    // Cleanup only removes our own attributes; the animation has already
    // finished by then, so this is tidiness rather than the release mechanism.
    timers.after(delayMs + ENTRANCE_CLEANUP_SLACK_MS, () => {
      marks.release()
      variable.release()
    })
  }
}

/**
 * Watch the document for arrivals worth stalling.
 *
 * A `MutationObserver` callback runs as a microtask *before* the next paint, so
 * the attribute set here is applied before the node is ever painted in its final
 * state. There is no flash of the un-stalled UI — which is the difference
 * between reading as "the app was slow" and reading as "the app animated in".
 *
 * @param timers - timer seam.
 * @param handlers - what to do with what arrives.
 * @returns a disposer.
 */
export function watchArrivals(timers: Timers, handlers: ArrivalHandlers): () => void {
  const seen = new WeakSet<Element>()
  let previousKeys: string[] = flowKeys()
  let cancelSwitch: (() => void) | undefined

  const compareTranscript = (): void => {
    cancelSwitch?.()
    cancelSwitch = timers.after(SWITCH_DEBOUNCE_MS, () => {
      cancelSwitch = undefined
      const current = flowKeys()
      // Only a swap counts. Rows appended by a streaming turn are the common
      // case by far, and treating those as a switch would stall every reply.
      const previous = new Set(previousKeys)
      const survived = current.filter((key) => previous.has(key)).length
      const basis = Math.max(previousKeys.length, current.length, 1)
      const switched = previousKeys.length > 0 && survived / basis < SWITCH_OVERLAP_THRESHOLD
      previousKeys = current
      if (switched) handlers.onConversationSwitch()
    })
  }

  const observer = new MutationObserver((records) => {
    let transcriptTouched = false
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (node === document.body) continue

        if (!seen.has(node)) {
          const dialog = node.matches(MODAL_SELECTOR) ? node : node.querySelector(MODAL_SELECTOR)
          if (dialog instanceof HTMLElement) {
            seen.add(node)
            handlers.onArrival(dialog, 'modal')
          } else if (node.matches(MENU_SELECTOR)) {
            // Menus get half the stall. A dropdown that takes as long as a modal
            // makes the whole UI feel broken rather than scanned.
            seen.add(node)
            handlers.onArrival(node, 'menu')
          }
        }
        if (node.matches(FLOW_COLUMN_SELECTOR) || node.querySelector(FLOW_COLUMN_SELECTOR) !== null) {
          transcriptTouched = true
        }
      }
      // A removal inside the transcript column is what a conversation switch
      // actually looks like: the old rows leave before the new ones arrive.
      if (record.removedNodes.length > 0 && record.target instanceof HTMLElement) {
        if (record.target.closest(FLOW_COLUMN_SELECTOR) !== null) transcriptTouched = true
      }
    }
    if (transcriptTouched) compareTranscript()
  })

  observer.observe(document.body, { childList: true, subtree: true })

  return () => {
    cancelSwitch?.()
    observer.disconnect()
  }
}
