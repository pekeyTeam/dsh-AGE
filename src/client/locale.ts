/**
 * The two languages this plugin ships copy for.
 *
 * Both are inlined rather than routed through a message catalogue: the plugin
 * has around forty strings, and a lookup layer for forty strings costs more than
 * it saves. The host's own locale service decides which set is used, so the
 * plugin still follows a language change without a reload.
 */

/** A language the plugin has copy for. */
export type AgeLocale = 'zh' | 'en'

/**
 * Map the host's locale tag onto one of ours.
 *
 * @param active - the host's active locale, e.g. `zh-CN`.
 * @returns `zh` for anything Chinese, `en` otherwise.
 */
export function ageLocale(active: string): AgeLocale {
  return active.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/**
 * Pick the string for the active language.
 *
 * @param locale - active language.
 * @param copy - the two variants.
 * @returns the matching string.
 */
export function pick(locale: AgeLocale, copy: { zh: string; en: string }): string {
  return copy[locale]
}
