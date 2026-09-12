/**
 * The host hooks this plugin reads, and nothing else.
 *
 * Every selector here is a *contract the host publishes on purpose*, not a
 * class name that happens to be there today. That distinction is the whole
 * reason this file exists as a single list: CSS-module class names in the dsh
 * client are per-build hashes and cannot be imported or matched from outside,
 * so a plugin that reached for one would break on the next release with no
 * warning. The `data-*` attributes below are emitted deliberately by
 * `ui-conversation` and `ui-layout`, and the ARIA roles are the platform's own.
 *
 * When a host upgrade moves something, this file is the only place that needs
 * to change — and `tests/dom.spec.ts` will say which hook went missing.
 */

/** A transcript row: one step of an assistant turn, one tool call, one message. */
export const FLOW_ROW_SELECTOR = '[data-chat-flow-key]'

/** The transcript row kind that carries a streaming assistant response. */
export const ASSISTANT_ROW_SELECTOR = '[data-chat-flow-kind="assistant-step"]'

/** Present, and `"true"`, on the markdown root while tokens are still arriving. */
export const STREAMING_SELECTOR = '[data-streaming="true"]'

/** The scrolling transcript column. Replaced wholesale when the user switches conversations. */
export const FLOW_COLUMN_SELECTOR = '[data-chat-flow]'

/**
 * A dialog the user is waiting on.
 *
 * `aria-modal="true"` narrows this to the real ones: the host renders menus and
 * hover cards as `role="dialog"` too, and stalling those as hard as a modal
 * would make the UI feel broken rather than scanned.
 */
export const MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]'

/** A lighter affordance, stalled for half as long as a modal. */
export const MENU_SELECTOR = '[role="menu"]'

/** The overlay layer the HUD is mounted into. */
export const OVERLAY_LAYER_SELECTOR = '[data-shell-overlay]'

/** Marks the plugin's own settings page, which is the hitch-free zone. */
export const SECTION_MARKER = 'data-dsh-age-section'

/**
 * The newest assistant row that is still receiving tokens.
 *
 * Scanned backwards because the streaming row is almost always the last one;
 * forward scanning would walk the whole transcript every time a scan opens.
 *
 * Returns `undefined` rather than the newest assistant row when none is
 * streaming. A row whose `data-streaming` has already cleared is a *finished*
 * message, and freezing it would be a visible lie rather than a timing one.
 *
 * @param root - subtree to search; defaults to the document.
 * @returns the streaming row, if there is one.
 */
export function streamingRow(root: ParentNode = document): HTMLElement | undefined {
  const rows = [...root.querySelectorAll<HTMLElement>(ASSISTANT_ROW_SELECTOR)]
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && row.isConnected && row.querySelector(STREAMING_SELECTOR) !== null) return row
  }
  return undefined
}

/**
 * The container inside a streaming row whose height the stall freezes.
 *
 * The row itself is the freeze target — it is the element the host pins its
 * own layout around — but the streaming markdown root is the element the
 * stretch targets, because transforming the whole row would move the turn's
 * action strip with it.
 *
 * @param row - a row from {@link streamingRow}.
 * @returns the markdown root, or the row itself if the hook is absent.
 */
export function streamingBody(row: HTMLElement): HTMLElement {
  return row.querySelector<HTMLElement>('[data-streaming]') ?? row
}

/**
 * The current set of transcript row keys.
 *
 * Used to notice a conversation switch without any hook for "the user clicked a
 * different session" — see `interaction.ts`. The sidebar exposes no `data-*`
 * attributes at all, so identity of the rendered transcript is the only
 * internals-free signal available.
 *
 * @param root - subtree to search; defaults to the document.
 * @returns the row keys, in document order.
 */
export function flowKeys(root: ParentNode = document): string[] {
  return [...root.querySelectorAll<HTMLElement>(FLOW_ROW_SELECTOR)]
    .map((row) => row.dataset['chatFlowKey'])
    .filter((key): key is string => typeof key === 'string')
}

/**
 * Whether an element is still in the document.
 *
 * Every deferred mutation re-checks this before touching a node: the transcript
 * re-renders constantly, and a stale reference is the difference between a
 * stutter and a `TypeError` in the user's console.
 *
 * @param element - possibly-detached node.
 * @returns true when the node is still connected.
 */
export function isLive(element: Element | undefined | null): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected
}

/**
 * Whether the plugin's own settings page is on screen.
 *
 * The single query that enforces the most important escape hatch: with the
 * control panel open, nothing may block, or the user cannot reach the switch
 * that turns the plugin off. One `querySelector` per hitch attempt — a handful
 * of times a minute — so no observer is warranted.
 *
 * @returns true while the AGE settings page is mounted.
 */
export function settingsPageOpen(): boolean {
  return document.querySelector(`[${SECTION_MARKER}]`) !== null
}
