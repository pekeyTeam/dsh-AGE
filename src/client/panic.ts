/**
 * The ways out.
 *
 * A plugin whose entire purpose is to make the UI stop responding has an
 * obligation no ordinary plugin has: it must be impossible to get stuck. Not
 * "unlikely" — *impossible*, and provable to a user who is currently annoyed and
 * has no reason to trust it.
 *
 * So there are four independent exits, each reachable without the others, each
 * working from a different state:
 *
 * | exit | reachable when |
 * |---|---|
 * | `Ctrl+Alt+Shift+A` | always — mid-freeze, inside a dialog, focus in a text box |
 * | `Escape` ×3 | when the hotkey is taken by the OS, an IME, or another app |
 * | `window.dshAge.disable()` | when the user has a console open |
 * | the settings page | when the user would rather click than type |
 *
 * The settings page is the interesting one, and it is enforced in `engine.ts`
 * rather than here: nothing may hitch while it is open. It is also the *slowest*
 * path — it needs the UI responsive enough to navigate — which is exactly why it
 * is not the only one.
 *
 * The panic key is a two-step on purpose. One press pauses for five minutes and
 * says so; a second press while paused turns the plugin off for good. A single
 * keystroke that silently uninstalls the plugin would be its own kind of trap,
 * and the announcement is what makes the difference legible.
 */

import type { AceEngine } from './engine.ts'
import { PANIC_GRACE_MS, RECOVERY_GRACE_MS } from './engine.ts'
import type { AgeSettings } from './settings.ts'
import type { Store } from './persist.ts'
import type { ToastStore } from './toasts.ts'
import { pick, type AgeLocale } from './locale.ts'

/** The primary panic chord. */
const PANIC_CODE = 'KeyA'

/** Escapes needed to trip the alternate chord. */
const ESCAPE_COUNT = 3

/** Window within which that many escapes count as a panic. */
const ESCAPE_WINDOW_MS = 1_200

/** What the console handle offers. */
export interface AgeConsoleApi {
  readonly version: string
  /** Human-readable current state. */
  status(): Record<string, unknown>
  /** Stop the plugin and keep it stopped across reloads. */
  disable(): void
  /** Undo {@link AgeConsoleApi.disable}. */
  enable(): void
  /** Stop for five minutes without changing the stored preference. */
  panic(): void
  /** Switch preset by id. */
  preset(id: string): void
  /** Show or hide the corner badge. */
  hud(on: boolean): void
  /** Hitches admitted in the trailing minute. */
  hitchesThisMinute(): number
}

declare global {
  interface Window {
    /** Installed by dsh-age. Present even while the plugin is disabled. */
    dshAge?: AgeConsoleApi
  }
}

/** Everything the exits need to reach. */
export interface EscapeWiring {
  readonly engine: AceEngine
  readonly settings: Store<AgeSettings>
  readonly toasts: ToastStore
  readonly locale: () => AgeLocale
}

/** The exits, so the settings page can offer the same behaviour as the keys. */
export interface EscapeHatches {
  /** Pause for five minutes; a second call turns the plugin off. */
  panic(): void
  /** Stop and remember it. */
  disable(): void
  /** Start again. */
  enable(): void
  /** Whether the last panic is still in effect. */
  readonly paused: boolean
  /** Drop the key listener. */
  dispose(): void
}

/** Announcements, in both shipped languages. */
const COPY = {
  panic: {
    zh: 'AGE 安全组件已暂停 5 分钟。再按一次 Ctrl+Alt+Shift+A 可彻底关闭。',
    en: 'AGE paused for 5 minutes. Press Ctrl+Alt+Shift+A again to turn it off.',
  },
  disabled: {
    zh: 'AGE 安全组件已关闭。控制台执行 dshAge.enable() 可重新启用。',
    en: 'AGE disabled. Run dshAge.enable() in the console to restore it.',
  },
  enabled: { zh: 'AGE 安全组件已重新启用。', en: 'AGE re-enabled.' },
  unloaded: { zh: 'AGE 已卸载，设置不再生效。', en: 'AGE is unloaded; its settings no longer apply.' },
} as const

/**
 * Install the keyboard exits and build the programmatic ones.
 *
 * @param wiring - engine, settings, and where to announce.
 * @returns the exits.
 */
export function installEscapeHatches(wiring: EscapeWiring): EscapeHatches {
  const { engine, settings, toasts } = wiring
  const say = (message: { zh: string; en: string }): void => toasts.push(pick(wiring.locale(), message))
  let paused = false

  const disable = (): void => {
    paused = false
    settings.set({ enabled: false })
    engine.suspend('disabled')
    say(COPY.disabled)
  }

  const enable = (): void => {
    paused = false
    settings.set({ enabled: true })
    // `clearPause` rather than `resume`: turning the plugin back on is one of
    // the two actions unambiguous enough to end a panic the user asked for.
    engine.clearPause(RECOVERY_GRACE_MS)
    engine.resume(RECOVERY_GRACE_MS)
    say(COPY.enabled)
  }

  const panic = (): void => {
    if (paused) {
      disable()
      return
    }
    paused = true
    // A pause, not a suspension: it carries its own deadline and lifts itself,
    // so a user who panics in frustration and walks away comes back to the
    // plugin running again rather than to something silently half-off.
    engine.pause(PANIC_GRACE_MS)
    say(COPY.panic)
  }

  let escapes: number[] = []
  const onKeyDown = (event: KeyboardEvent): void => {
    // Never `preventDefault`: the plugin observes keys, it does not take them.
    // Stealing a chord would make this plugin the reason a host shortcut broke —
    // a worse bug than anything it is imitating.
    if (event.code === PANIC_CODE && event.ctrlKey && event.altKey && event.shiftKey) {
      panic()
      return
    }
    if (event.key !== 'Escape') return
    // The alternate chord, for when the primary is taken. Triple-Escape because
    // the host already uses a single Escape to close a dialog, so one press has
    // to stay harmless.
    const now = Date.now()
    escapes = [...escapes.filter((at) => now - at < ESCAPE_WINDOW_MS), now]
    if (escapes.length < ESCAPE_COUNT) return
    escapes = []
    panic()
  }

  window.addEventListener('keydown', onKeyDown, { capture: true })

  return {
    panic,
    disable,
    enable,
    get paused() {
      return paused
    },
    dispose: () => window.removeEventListener('keydown', onKeyDown, { capture: true }),
  }
}

/**
 * Install `window.dshAge`.
 *
 * The handle is installed **unconditionally**, including on a load where the
 * plugin is already disabled — otherwise `dshAge.enable()` would be unreachable
 * from exactly the state it exists to fix, which is the same trap as a settings
 * page that cannot be opened.
 *
 * @param wiring - engine, settings, and where to announce.
 * @param version - the package version to report.
 * @returns a disposer that swaps the handle for an inert one.
 */
export function installConsoleApi(wiring: EscapeWiring, version: string): () => void {
  const { engine, settings, toasts } = wiring
  const say = (message: { zh: string; en: string }): void => toasts.push(pick(wiring.locale(), message))
  const escapes = installEscapeHatches(wiring)

  window.dshAge = {
    version,
    status: () => ({
      enabled: settings.get().enabled,
      preset: settings.get().presetId,
      correlate: settings.get().correlate,
      // `paused` comes from the engine's own status, which is authoritative and
      // also survives a panic that lifted itself.
      ...engine.getStatus(),
    }),
    disable: escapes.disable,
    enable: escapes.enable,
    panic: escapes.panic,
    preset: (id) => settings.set({ presetId: id as AgeSettings['presetId'] }),
    hud: (on) => settings.set({ hud: on }),
    hitchesThisMinute: () => engine.getStatus().hitchesThisMinute,
  }

  return () => {
    escapes.dispose()
    // Swapped rather than deleted: a user who bookmarked the call should get an
    // explanation, not `undefined is not a function`.
    const gone = (): void => say(COPY.unloaded)
    window.dshAge = {
      version,
      status: () => ({ unloaded: true }),
      disable: gone,
      enable: gone,
      panic: gone,
      preset: gone,
      hud: gone,
      hitchesThisMinute: () => 0,
    }
  }
}
