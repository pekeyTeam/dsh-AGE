/**
 * The undo log for every DOM mutation the plugin makes.
 *
 * A jank plugin that leaves `max-height` pinned on a transcript row, or a
 * `<style>` tag behind after unload, has stopped being a joke and become a bug
 * report. The only way to make the teardown guarantee real rather than
 * aspirational is to route *every* mutation through one place that knows how to
 * reverse it — so there is no such thing as a change the plugin makes that it
 * cannot take back.
 *
 * The registry is also what makes the freeze tests meaningful: "the style
 * attribute is byte-identical to before" is an assertion you can only write if
 * restoration is a first-class operation rather than a best-effort teardown.
 */

/** A recorded mutation that knows how to reverse itself. */
export interface RestoreHandle {
  /** Reverse this one mutation and drop it from the registry. Idempotent. */
  release(): void
}

/** The undo log. */
export interface RestoreRegistry {
  /**
   * Record a reversal.
   * @param restore - called at most once, on release or on `restoreAll`.
   * @returns a handle to reverse just this mutation early.
   */
  push(restore: () => void): RestoreHandle
  /**
   * Set inline style properties, remembering exactly what was there.
   * @param element - the node to mutate.
   * @param properties - CSS property name to value, in kebab-case.
   * @returns a handle restoring the previous values.
   */
  styles(element: HTMLElement, properties: Readonly<Record<string, string>>): RestoreHandle
  /**
   * Set data attributes, remembering exactly what was there.
   * @param element - the node to mutate.
   * @param entries - dataset key (camelCase) to value.
   * @returns a handle restoring the previous values.
   */
  dataset(element: HTMLElement, entries: Readonly<Record<string, string>>): RestoreHandle
  /** Reverse everything, newest first. */
  restoreAll(): void
  /** How many mutations are currently held. */
  readonly size: number
}

/**
 * Create an undo log.
 *
 * Restores run newest-first: two mutations can touch the same property (a
 * stall and a stretch on the same row), and unwinding in the order they were
 * applied is what leaves the earliest snapshot — the true original — in place.
 *
 * @returns the registry.
 */
export function createRegistry(): RestoreRegistry {
  const entries: { restore: () => void; live: boolean }[] = []

  const push = (restore: () => void): RestoreHandle => {
    const entry = { restore, live: true }
    entries.push(entry)
    return {
      release: () => {
        if (!entry.live) return
        entry.live = false
        const index = entries.indexOf(entry)
        if (index >= 0) entries.splice(index, 1)
        entry.restore()
      },
    }
  }

  return {
    push,
    styles: (element, properties) => {
      const previous = new Map<string, string>()
      for (const [property, value] of Object.entries(properties)) {
        previous.set(property, element.style.getPropertyValue(property))
        element.style.setProperty(property, value)
      }
      return push(() => {
        for (const [property, value] of previous) {
          if (value === '') element.style.removeProperty(property)
          else element.style.setProperty(property, value)
        }
      })
    },
    dataset: (element, entriesToSet) => {
      const previous = new Map<string, string | undefined>()
      for (const [key, value] of Object.entries(entriesToSet)) {
        previous.set(key, element.dataset[key])
        element.dataset[key] = value
      }
      return push(() => {
        for (const [key, value] of previous) {
          if (value === undefined) delete element.dataset[key]
          else element.dataset[key] = value
        }
      })
    },
    restoreAll: () => {
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index]
        if (entry === undefined || !entry.live) continue
        entry.live = false
        entry.restore()
      }
      entries.length = 0
    },
    get size() {
      return entries.length
    },
  }
}
