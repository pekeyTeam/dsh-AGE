/**
 * A `PointerEvent` for jsdom.
 *
 * jsdom ships no such constructor, and two specs need to dispatch real pointer
 * events rather than plain `MouseEvent`s — the input-lag gates read `pointerId`
 * and the cursor tracker reads the client coordinates. This shim carries the
 * fields those paths actually touch; it is not a fidelity claim about the real
 * constructor, and anything depending on the parts it omits would be better
 * tested in a browser than here.
 */

/** The fields this shim carries through from its init dictionary. */
interface PointerInit extends MouseEventInit {
  readonly pointerId?: number
  readonly pointerType?: string
  readonly isPrimary?: boolean
}

/**
 * Install the shim if the environment lacks one.
 *
 * Idempotent, so every spec can call it unconditionally.
 */
export function installPointerEventShim(): void {
  if (typeof window.PointerEvent !== 'undefined') return
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number
    readonly pointerType: string
    readonly isPrimary: boolean

    constructor(type: string, init: PointerInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
      this.pointerType = init.pointerType ?? 'mouse'
      this.isPrimary = init.isPrimary ?? true
    }
  }
  ;(window as unknown as { PointerEvent: unknown }).PointerEvent = PointerEventShim
}
