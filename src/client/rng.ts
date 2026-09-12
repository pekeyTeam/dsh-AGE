/**
 * Seeded randomness for the scan schedule.
 *
 * (Stream names reuse the preset's symptom vocabulary — see `RngStream`.)
 *
 * `Math.random` is not usable here for one reason that has nothing to do with
 * quality: a jank plugin whose schedule cannot be reproduced cannot be
 * debugged. When a user reports "it froze for four seconds and I lost a click",
 * the only way to answer is to replay the exact session that produced it, and
 * that requires the seed to be a value we can read out of the settings page and
 * feed back in.
 *
 * Every symptom is driven by a *named stream* derived from that one seed, so
 * turning correlation off (see `presets.ts`) gives each symptom an independent
 * schedule without giving up reproducibility.
 */

import type { Symptom } from './presets.ts'

/** A source of bounded random numbers. */
export interface Rng {
  /** Next value in `[0, 1)`. */
  next(): number
  /** Uniform value across an inclusive `[min, max]` band. */
  range(band: readonly [number, number]): number
  /** Uniform integer in `[min, max]`, both inclusive. */
  int(min: number, max: number): number
  /** Uniform element, or undefined for an empty list. */
  pick<T>(items: readonly T[]): T | undefined
}

/**
 * mulberry32 — 32 bits of state, no allocation, and a short enough body to
 * audit. Chosen over a hash-based generator because the stream must survive
 * being seeded from an arbitrary string and then advanced hundreds of times
 * without drifting.
 *
 * @param seed - 32-bit seed; only the low 32 bits are used.
 * @returns the generator.
 */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    next,
    range: ([min, max]) => min + next() * (max - min),
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T,>(items: readonly T[]): T | undefined =>
      items.length === 0 ? undefined : items[Math.floor(next() * items.length)],
  }
}

/**
 * FNV-1a over UTF-16 code units.
 *
 * Not a security hash and not trying to be — it turns the user-visible seed
 * string into the 32 bits mulberry32 wants, and it is stable across engines,
 * which a `hashCode`-style loop is not guaranteed to be.
 *
 * @param text - seed material.
 * @returns a 32-bit hash.
 */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * The independent schedules a plugin instance can own.
 *
 * Stream names are the scheduler's own vocabulary — `scan` for a correlated
 * instance, and one stream per symptom for an uncorrelated one — so an
 * uncorrelated engine can derive its stream straight from the symptom it is
 * scheduling instead of keeping a second lookup table in sync.
 */
export type RngStream = 'scan' | Symptom

/**
 * Derive one named stream from the session seed.
 *
 * Streams are decorrelated by mixing the two hashes rather than by offsetting
 * one, because mulberry32's first outputs from adjacent seeds are close enough
 * to correlate visibly in a schedule measured in seconds.
 *
 * @param seed - session seed string.
 * @param stream - which symptom's schedule this is.
 * @returns an independent generator.
 */
export function streamFor(seed: string, stream: RngStream): Rng {
  return mulberry32((seedFrom(seed) ^ seedFrom(`dsh-age:${stream}`)) >>> 0)
}
