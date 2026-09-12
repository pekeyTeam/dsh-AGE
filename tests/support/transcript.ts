/**
 * A fake transcript, built from the same `data-*` hooks the host emits.
 *
 * jsdom performs no layout, so `getBoundingClientRect()` is all zeros and
 * `scrollHeight` is 0 — which would make every height-based effect decline for
 * the wrong reason. The geometry is therefore supplied explicitly, and the specs
 * that care about it say so. Everything else about the fixture is the real
 * contract: the same attributes `ui-conversation` writes, so a spec that passes
 * here is testing the same lookups production uses.
 */

/** A transcript row plus the streaming body inside it. */
export interface FakeRow {
  readonly column: HTMLElement
  readonly row: HTMLElement
  readonly body: HTMLElement
  /** Append a later, non-streaming row — the case the stall must *not* hide. */
  appendLaterRow(key: string): HTMLElement
  /** Clear `data-streaming`, the way a finished turn does. */
  finish(): void
}

/**
 * Build a transcript with one streaming assistant row.
 *
 * @param options - overrides for the fixture.
 * @returns handles to the pieces the specs assert on.
 */
export function fakeTranscript(options: { height?: number; streaming?: boolean } = {}): FakeRow {
  const column = document.createElement('div')
  column.setAttribute('data-chat-flow', '')

  const row = document.createElement('div')
  row.setAttribute('data-chat-flow-kind', 'assistant-step')
  row.setAttribute('data-chat-flow-key', 'row-1')

  const body = document.createElement('div')
  if (options.streaming !== false) body.setAttribute('data-streaming', 'true')
  body.textContent = 'the model is typing'
  row.append(body)
  column.append(row)
  document.body.append(column)

  // jsdom reports zero for every box; give the row a real one so the height
  // floor in `stallStreamRow` is exercised rather than accidentally tripped.
  Object.defineProperty(row, 'scrollHeight', { configurable: true, value: options.height ?? 320 })
  Object.defineProperty(row, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ height: options.height ?? 320, width: 640, top: 0, left: 0, bottom: 320, right: 640, x: 0, y: 0, toJSON: () => ({}) }),
  })

  return {
    column,
    row,
    body,
    appendLaterRow: (key) => {
      const later = document.createElement('div')
      later.setAttribute('data-chat-flow-key', key)
      later.textContent = 'a later row'
      column.append(later)
      return later
    },
    finish: () => {
      row.removeAttribute('data-streaming')
      body.removeAttribute('data-streaming')
    },
  }
}

/** The row's `style` attribute, for byte-exact restoration assertions. */
export function styleAttribute(element: HTMLElement): string {
  return element.getAttribute('style') ?? ''
}
