/**
 * The plugin's knobs, and the defaults they take on a first run.
 *
 * Two decisions worth stating, because both are visible to users:
 *
 * **The default intensity is `heavy`.** That is the specification this plugin
 * exists to reproduce — a hitch every 5–15 seconds, each 1–3 seconds long — not
 * a compromise reached by a cautious author. The milder presets exist because a
 * plugin nobody can dial down is a plugin people uninstall instead of
 * complaining about, but none of them is the default.
 *
 * **`correlate` is on by default.** The original brief described three
 * independently random symptoms, and independent is exactly what a real engine
 * stall is *not*: everything it causes happens in the same instant, because
 * there is one blocked thread. Turning this off restores the literal brief for
 * anyone who prefers it; the shared duty-cycle ledger still applies either way,
 * so "off" cannot compound into a permanently dead page.
 */

import { useSyncExternalStore } from 'react'
import { createStore, readStored, writeStored, type Store } from './persist.ts'
import { DEFAULT_PRESET_ID, PRESET_ORDER, presetOf, type AgePreset, type PresetId, type Symptom } from './presets.ts'

/** Where the HUD sits. Top-right by default — that corner belongs to a security badge. */
export type HudCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left'

/**
 * Which mechanism reproduces the pointer symptom.
 *
 * - `cursor` — the pointer itself stops and then drags. The platform cursor is
 *   hidden for the block's duration and a drawn one takes its place, so what the
 *   user sees is a cursor that genuinely freezes under their hand. The default,
 *   because it is the only one that reproduces the symptom rather than a
 *   side-effect of it.
 * - `hitch` — the page blocks and the pointer keeps gliding over it, untouched.
 *   The honest, minimal option: nothing is drawn or hidden, so there is no way
 *   for it to misbehave.
 * - `input-lag` — the UI is made to react to where the pointer *was*, by holding
 *   and replaying real events. Experimental: it depends on host internals and
 *   can land a click on a control the user never aimed at, so a press it cannot
 *   prove safe is dropped rather than re-aimed.
 */
export type MouseMode = 'cursor' | 'hitch' | 'input-lag'

/**
 * Bumped whenever a stored value would mean something different than it did.
 *
 * Stored settings are merged over the defaults, which is what keeps them
 * loadable when a field is added — but it also means a value a user never chose
 * can outlive the reason it had that value. `mouseMode: 'hitch'` is the case
 * that forced this field into existence: it was the only working option when it
 * was written, and after the pointer gained a real mechanism it silently pinned
 * everyone who had ever loaded the plugin to the option that does nothing to the
 * pointer.
 */
export const SCHEMA_VERSION = 2

/** Everything a user can change. */
export interface AgeSettings {
  /** Shape of the stored object; see {@link SCHEMA_VERSION}. */
  readonly schema: number
  /** Master switch. This *is* the kill switch — there is no second mechanism. */
  readonly enabled: boolean
  /** Intensity preset. */
  readonly presetId: PresetId
  /** Whether the three symptoms fire in the same instant, as one scan does. */
  readonly correlate: boolean
  /** Per-symptom switches. */
  readonly mouse: boolean
  /**
   * The whole text symptom, as one switch.
   *
   * The three presentations underneath — the row freezing and dumping its
   * backlog, frames dropping so the response lumps in, the container pulling
   * sideways — are three ways of showing one thing, and a user cannot tell them
   * apart well enough to want them switched separately. Exposing all three was
   * three decisions where the honest answer is one.
   */
  readonly text: boolean
  readonly interaction: boolean
  /** Pointer mechanism; `input-lag` is the experimental deferred-replay mode. */
  readonly mouseMode: MouseMode
  /** Whether the corner badge is drawn at all. */
  readonly hud: boolean
  readonly hudCorner: HudCorner
  readonly hudCollapsed: boolean
  /** Percentage of scans that announce themselves with a toast. */
  readonly toastChance: number
  /** Reproduces a session exactly when fed back in. */
  readonly seed: string
}

/** Storage key suffix for the settings object. */
const SETTINGS_KEY = 'settings'

/**
 * A fresh seed.
 *
 * Only ever used on a first run: the value is written back immediately, so the
 * session stays reproducible even before the user touches anything.
 *
 * @returns a seed string.
 */
function freshSeed(): string {
  return `age-${Date.now().toString(36)}`
}

/** Build the defaults, given a seed to use. */
function defaultsWith(seed: string): AgeSettings {
  return {
    schema: SCHEMA_VERSION,
    enabled: true,
    presetId: DEFAULT_PRESET_ID,
    correlate: true,
    mouse: true,
    text: true,
    interaction: true,
    mouseMode: 'cursor',
    hud: true,
    hudCorner: 'top-right',
    hudCollapsed: false,
    toastChance: 35,
    seed,
  }
}

/** The three per-presentation switches that `text` replaced. */
interface LegacyTextToggles {
  readonly streamStall?: boolean
  readonly streamChunk?: boolean
  readonly streamStretch?: boolean
}

/**
 * Bring a stored object forward to the current schema.
 *
 * Two migrations so far, and both exist because a stored value can outlive the
 * reason it had that value:
 *
 * - **v0 → v1.** `mouseMode: 'hitch'` was written when that was the only option,
 *   long before the pointer had a mechanism of its own. Left in place it would
 *   pin exactly the users who had the plugin installed longest to the setting
 *   that does nothing to the pointer — a bug that presents as a missing feature.
 * - **v1 → v2.** Three switches for what turned out to be one symptom. Collapsed
 *   with "any one on wins" rather than "all must be on": a user who had switched
 *   two off and left one on was asking for text effects, and the strict reading
 *   would silently turn them all off instead.
 *
 * @param stored - whatever was in storage.
 * @param base - the defaults, already carrying the resolved seed.
 * @returns settings that match the current schema.
 */
function migrate(stored: Partial<AgeSettings> & LegacyTextToggles, base: AgeSettings): AgeSettings {
  const from = typeof stored.schema === 'number' ? stored.schema : 0
  if (from >= SCHEMA_VERSION) return { ...base, ...stored }

  const { streamStall, streamChunk, streamStretch, ...rest } = stored
  // "Absent" and "present but false" are different answers here, and `??` cannot
  // tell them apart — it only falls through on null and undefined, so `false ??
  // false` is `false` rather than the default. Presence is therefore checked
  // explicitly, and only then is the value read.
  const hadToggles = streamStall !== undefined || streamChunk !== undefined || streamStretch !== undefined
  const text = hadToggles
    ? streamStall === true || streamChunk === true || streamStretch === true
    : base.text

  return {
    ...base,
    ...rest,
    schema: SCHEMA_VERSION,
    text,
    // Pre-v1 storage predates the pointer having a mechanism, so its `mouseMode`
    // was never a choice anyone made; from v1 on it is.
    mouseMode: from >= 1 ? (rest.mouseMode ?? base.mouseMode) : base.mouseMode,
  }
}

/**
 * Create the settings store.
 *
 * A first run persists its generated seed straight away rather than leaving it
 * as a default, because a default that is never written would be regenerated on
 * every reload — and a schedule you cannot reproduce across a refresh is not
 * reproducible at all. The same write is what stamps the schema version onto a
 * first-run object, so a later upgrade can tell an untouched default from a
 * deliberate choice.
 *
 * @returns the store.
 */
export function createAgeSettingsStore(): Store<AgeSettings> {
  const stored = readStored<Partial<AgeSettings>>(SETTINGS_KEY)
  const storedSeed = stored?.seed
  const seed = typeof storedSeed === 'string' && storedSeed !== '' ? storedSeed : freshSeed()
  const store = createStore<AgeSettings>(SETTINGS_KEY, defaultsWith(seed), migrate)
  if (stored?.schema !== SCHEMA_VERSION) writeStored(SETTINGS_KEY, store.get())
  return store
}

/**
 * The settings, as a React value that re-renders on every change.
 *
 * @param store - the engine's store.
 * @returns the current settings.
 */
export function useAgeSettings(store: Store<AgeSettings>): AgeSettings {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * Which symptoms are active, as a set the engine can intersect with a preset.
 *
 * @param settings - current settings.
 * @returns the enabled symptoms, in a stable order.
 */
export function enabledSymptoms(settings: AgeSettings): Symptom[] {
  const symptoms: Symptom[] = []
  if (settings.mouse) symptoms.push('mouse')
  // One switch, three presentations. They stay separate symptoms internally
  // because each is a different mechanism the scheduler can pick between — the
  // consolidation is in what the *user* is asked to decide, not in the code.
  if (settings.text) symptoms.push('stream-stall', 'stream-chunk', 'stream-stretch')
  if (settings.interaction) symptoms.push('interaction')
  return symptoms
}

/**
 * The preset to run, with the user's symptom switches applied.
 *
 * The preset decides *how hard*; the switches decide *whether at all*. Keeping
 * those separate is what lets a user silence the text symptoms without also
 * softening the pointer, which a preset-only model cannot express.
 *
 * @param settings - current settings.
 * @returns a preset whose `kinds` is the intersection.
 */
export function effectivePreset(settings: AgeSettings): AgePreset {
  const preset = presetOf(settings.presetId)
  const enabled = new Set(enabledSymptoms(settings))
  return { ...preset, kinds: preset.kinds.filter((kind) => enabled.has(kind)) }
}

/** Human-readable preset labels, keyed by id, in both shipped languages. */
export const PRESET_LABEL: Readonly<Record<PresetId, { zh: string; en: string }>> = {
  light: { zh: '轻度', en: 'Light' },
  medium: { zh: '中等', en: 'Medium' },
  heavy: { zh: '重度', en: 'Heavy' },
  hell: { zh: '地狱', en: 'Hell' },
}

/** One-line preset descriptions, in both shipped languages. */
export const PRESET_BLURB: Readonly<Record<PresetId, { zh: string; en: string }>> = {
  light: {
    zh: '每 30–60 秒扫一次，单次卡 0.2–0.5 秒。偶尔卡一下，几乎不影响干活。',
    en: 'A scan every 30–60s, 0.2–0.5s each. A occasional stumble you can ignore.',
  },
  medium: {
    zh: '每 15–35 秒扫一次，单次卡 0.4–1 秒。能感觉到，但还忍得住。',
    en: 'A scan every 15–35s, 0.4–1s each. Noticeable, still bearable.',
  },
  heavy: {
    zh: '每 5–15 秒扫一次，单次卡 1–3 秒。环境稍加恶劣。',
    en: 'A scan every 5–15s, 1–3s each. A slightly harsher environment.',
  },
  hell: {
    zh: '每 2–6 秒扫一次，单次 1.5–2.5 秒，最高频率。',
    en: 'A scan every 2–6s, 1.5–2.5s each. Maximum frequency.',
  },
}

export { PRESET_ORDER }
