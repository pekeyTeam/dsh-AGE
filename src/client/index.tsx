/**
 * dsh-age, browser half: three registrations and one effect.
 *
 * - `shell.overlay` gets the corner badge. A list slot, additive, and
 *   click-through unless an entry opts in — which is exactly what a HUD needs.
 * - `settings.section` gets the control panel, which is also one of the four
 *   exits from the plugin.
 * - `ctx.effect` owns the engine, and everything the plugin does to the page
 *   happens inside its lifetime. It is registered **last**, so it is the last
 *   thing set up and — because cordis disposes a fiber's effects in reverse —
 *   the first thing torn down.
 *
 * The store and the engine are created here rather than inside a component
 * because the engine is not a React thing: it schedules, blocks and restores on
 * its own, and the React tree only renders what it reports.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the locale service's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the `shell.overlay` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the `settings.section` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { AgeSection } from './AgeSection.tsx'
import { AgeHud } from './hud/AgeHud.tsx'
import { AceEngine, RECOVERY_GRACE_MS, type EngineStatus } from './engine.ts'
import { installConsoleApi } from './panic.ts'
import { createAgeSettingsStore, useAgeSettings, type AgeSettings } from './settings.ts'
import { createToastStore, type ToastStore } from './toasts.ts'
import { ageLocale, pick, type AgeLocale } from './locale.ts'
import type { PresetId } from './presets.ts'

export const name = 'dsh-age'

export const inject = ['slots', 'locale']

/** Reported by `window.dshAge.version`. Keep in step with `package.json`. */
const VERSION = '0.1.0'

/** Copy for the scan announcements. */
const SCAN_COPY = {
  routine: { zh: 'AGE 安全组件正在扫描…', en: 'AGE is running a scan…' },
  heavy: {
    zh: 'AGE 安全组件正在初始化并执行运行环境扫描，可能造成短暂卡顿。',
    en: 'AGE is initialising and scanning the runtime environment. Brief stutter is expected.',
  },
} as const

/**
 * Register both surfaces and start the engine.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const settings = createAgeSettingsStore()
  const toasts = createToastStore((ms, fn) => {
    const handle = setTimeout(fn, ms)
    return () => clearTimeout(handle)
  })
  const engine = new AceEngine({ settings })
  const locale = (): AgeLocale => ageLocale(ctx.locale.getSnapshot().active)

  const set = (patch: Partial<AgeSettings>): void => settings.set(patch)

  /**
   * The HUD entry.
   *
   * `shell.overlay` is click-through by default, but its layer carries a `> *`
   * rule that hands pointer events back to every direct child — so the badge
   * itself is responsible for staying out of the way, which `AgeHud` does.
   *
   * @returns the corner badge, or nothing when the user has hidden it.
   */
  function AgeHudEntry(_props: PropsRuntime<'shell.overlay'>) {
    const current = useAgeSettings(settings)
    const [status, setStatus] = useState<EngineStatus>(() => engine.getStatus())
    const [visibleToasts, setVisibleToasts] = useState(() => toasts.get())
    const activeLocale = locale()

    useEffect(() => engine.subscribe(() => setStatus(engine.getStatus())), [])
    useEffect(() => toasts.subscribe(() => setVisibleToasts(toasts.get())), [])

    if (!current.hud) return null
    return (
      <AgeHud
        status={status}
        settings={current}
        toasts={visibleToasts}
        locale={activeLocale}
        onPanic={() => window.dshAge?.panic()}
        onDisable={() => window.dshAge?.disable()}
        onPreset={(id: PresetId) => set({ presetId: id })}
        onToggleCollapsed={() => set({ hudCollapsed: !current.hudCollapsed })}
      />
    )
  }

  /**
   * The settings entry.
   * @returns the AGE control panel.
   */
  function AgeSectionEntry(_props: PropsRuntime<'settings.section'>) {
    const current = useAgeSettings(settings)
    const [status, setStatus] = useState<EngineStatus>(() => engine.getStatus())
    const activeLocale = locale()
    useEffect(() => engine.subscribe(() => setStatus(engine.getStatus())), [])

    // Leaving the page grants a grace period. The user was just in the one place
    // guaranteed to be hitch-free, and the first thing they do on the way out
    // should not be the thing that stalls.
    useEffect(() => () => engine.resume(RECOVERY_GRACE_MS), [])

    return (
      <AgeSection
        settings={current}
        status={status}
        locale={activeLocale}
        onSet={set}
        onScanNow={() => engine.scanNow()}
        onPanic={() => window.dshAge?.panic()}
        onDisable={() => window.dshAge?.disable()}
        onEnable={() => window.dshAge?.enable()}
        onReset={() => settings.reset()}
      />
    )
  }

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register({ name: 'shell.overlay', id: 'dsh-age-hud', order: 60 }, AgeHudEntry),
  )

  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-age',
        order: 95,
        // Labelled as third-party in the nav itself: this page sits among
        // first-party ones, and a settings entry that reads as official is the
        // one place the joke would stop being obvious.
        label: () => pick(locale(), { zh: 'AGE 安全组件（恶搞）', en: 'AGE Anti-Cheat (Parody)' }),
      },
      AgeSectionEntry,
    ),
  )

  ctx.effect(() => {
    const consoleDisposer = installConsoleApi({ engine, settings, toasts, locale }, VERSION)

    // Announce scans from the status stream rather than from inside the engine:
    // the engine's job is to produce stalls, and a toast is presentation.
    // `Math.random` is deliberate here — the announcement roll is cosmetic and
    // sits outside the reproducible schedule on purpose, so changing how chatty
    // the plugin is can never shift when it stutters.
    let previousScans = 0
    const offStatus = engine.subscribe(() => {
      const status = engine.getStatus()
      if (status.scanning > previousScans) {
        if (status.heavy) toasts.push(pick(locale(), SCAN_COPY.heavy))
        else if (Math.random() * 100 < settings.get().toastChance) toasts.push(pick(locale(), SCAN_COPY.routine))
      }
      previousScans = status.scanning
    })

    engine.start()

    return () => {
      offStatus()
      consoleDisposer()
      toasts.clear()
      engine.dispose()
    }
  }, 'dsh-age: engine')
}

/** Re-exported so the settings page and tests share one definition. */
export type { AgeSettings, ToastStore }
