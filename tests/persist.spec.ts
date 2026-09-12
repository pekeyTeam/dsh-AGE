/**
 * @vitest-environment jsdom
 *
 * Storage is the layer a jank plugin must never fail on.
 *
 * Private-mode Safari, sandboxed frames and jsdom all throw on `localStorage`
 * access, and a plugin whose entire job is to be annoying cannot also be the
 * reason a session fails to render. Every spec here is about the degraded path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore, readStored, removeStored, writeStored } from '../src/client/persist.ts'
import { createAgeSettingsStore, effectivePreset, SCHEMA_VERSION } from '../src/client/settings.ts'

interface Probe {
  alpha: number
  beta: string
  gamma?: boolean
}

const DEFAULTS: Probe = { alpha: 1, beta: 'two' }

beforeEach(() => {
  localStorage.clear()
})

describe('stored values', () => {
  it('round-trips a value', () => {
    writeStored('probe', { alpha: 9 })
    expect(readStored('probe')).toEqual({ alpha: 9 })
  })

  it('reads undefined for a key that was never written', () => {
    expect(readStored('missing')).toBeUndefined()
  })

  it('reads undefined rather than throwing on corrupt JSON', () => {
    localStorage.setItem('dsh-age:probe', '{ not json')
    expect(readStored('probe')).toBeUndefined()
  })

  it('survives storage that throws on read', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    try {
      expect(readStored('probe')).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  it('survives storage that throws on write, and says so', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      expect(writeStored('probe', { alpha: 1 })).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('survives storage that throws on remove', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    try {
      expect(() => removeStored('probe')).not.toThrow()
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createStore', () => {
  it('starts at the defaults', () => {
    const store = createStore<Probe>('probe', DEFAULTS)
    expect(store.get()).toEqual(DEFAULTS)
  })

  it('merges a stored partial over the defaults', () => {
    // This is what keeps a stored object loadable after a field is added, which
    // is the only upgrade path a plugin like this gets.
    writeStored('probe', { alpha: 5 })
    const store = createStore<Probe>('probe', DEFAULTS)
    expect(store.get()).toEqual({ alpha: 5, beta: 'two' })
  })

  it('notifies subscribers on every write', () => {
    const store = createStore<Probe>('probe', DEFAULTS)
    let calls = 0
    const off = store.subscribe(() => {
      calls += 1
    })
    store.set({ alpha: 2 })
    store.set({ beta: 'three' })
    expect(calls).toBe(2)
    off()
    store.set({ alpha: 3 })
    expect(calls).toBe(2)
  })

  it('keeps the value in memory when storage refuses the write', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    try {
      const store = createStore<Probe>('probe', DEFAULTS)
      store.set({ alpha: 42 })
      // Losing durability is acceptable; losing the change the user just made
      // would be the bug this memory layer exists to prevent.
      expect(store.get().alpha).toBe(42)
    } finally {
      spy.mockRestore()
    }
  })

  it('returns to the defaults on reset', () => {
    const store = createStore<Probe>('probe', DEFAULTS)
    store.set({ alpha: 7 })
    store.reset()
    expect(store.get()).toEqual(DEFAULTS)
    expect(readStored('probe')).toBeUndefined()
  })
})

describe('the settings store', () => {
  it('ships the documented default intensity', () => {
    const store = createAgeSettingsStore()
    expect(store.get().presetId).toBe('heavy')
    expect(store.get().correlate).toBe(true)
    expect(store.get().enabled).toBe(true)
  })

  it('persists the seed on a first run so a session stays reproducible', () => {
    const store = createAgeSettingsStore()
    const seed = store.get().seed
    expect(seed).not.toBe('')
    expect(readStored<{ seed: string }>('settings')?.seed).toBe(seed)
  })

  it('reuses a stored seed', () => {
    writeStored('settings', { seed: 'fixed-seed' })
    expect(createAgeSettingsStore().get().seed).toBe('fixed-seed')
  })

  it('drops symptoms the preset does not list', () => {
    const store = createAgeSettingsStore()
    // `light` produces only the pointer and the frame gate.
    store.set({ presetId: 'light' })
    const kinds = effectivePreset(store.get()).kinds
    expect(kinds).toContain('mouse')
    expect(kinds).not.toContain('stream-stall')
  })

  it('drops symptoms the user switched off, without changing the intensity', () => {
    const store = createAgeSettingsStore()
    store.set({ text: false })
    const preset = effectivePreset(store.get())
    // One switch, three mechanisms: turning off the text symptom has to remove
    // all three presentations, not just the one the label happens to name.
    expect(preset.kinds).not.toContain('stream-stall')
    expect(preset.kinds).not.toContain('stream-chunk')
    expect(preset.kinds).not.toContain('stream-stretch')
    // The bands are untouched: a symptom switch must not quietly soften the
    // rest of the preset.
    expect(preset.hitchMs).toEqual([1_000, 3_000])
  })

  it('keeps the three text presentations behind one switch', () => {
    const store = createAgeSettingsStore()
    const kinds = effectivePreset(store.get()).kinds
    expect(kinds).toContain('stream-stall')
    expect(kinds).toContain('stream-chunk')
    expect(kinds).toContain('stream-stretch')
  })

  it('falls back to the default preset for an unknown id', () => {
    writeStored('settings', { presetId: 'nonsense' })
    expect(effectivePreset(createAgeSettingsStore().get()).id).toBe('heavy')
  })

  it('defaults the pointer to the mode that actually moves the pointer', () => {
    expect(createAgeSettingsStore().get().mouseMode).toBe('cursor')
  })
})

describe('schema migration', () => {
  it('rescues a pre-schema store from the old pointer default', () => {
    // Written by a build where `hitch` was the only option. Left alone, it would
    // pin exactly the longest-standing users to the one setting that does nothing
    // to the pointer — a bug that presents as a missing feature.
    writeStored('settings', { seed: 'old-seed', mouseMode: 'hitch', presetId: 'hell' })
    const settings = createAgeSettingsStore().get()
    expect(settings.mouseMode).toBe('cursor')
    // Everything the user could actually have been choosing is kept.
    expect(settings.presetId).toBe('hell')
    expect(settings.seed).toBe('old-seed')
    expect(settings.schema).toBe(SCHEMA_VERSION)
  })

  it('leaves a choice made after the upgrade alone', () => {
    writeStored('settings', { schema: SCHEMA_VERSION, seed: 'new-seed', mouseMode: 'hitch' })
    expect(createAgeSettingsStore().get().mouseMode).toBe('hitch')
  })

  it('stamps the schema onto a first run, so a later upgrade can tell', () => {
    const store = createAgeSettingsStore()
    expect(store.get().schema).toBe(SCHEMA_VERSION)
    expect(readStored<{ schema: number }>('settings')?.schema).toBe(SCHEMA_VERSION)
  })

  it('keeps every other stored field across a migration', () => {
    writeStored('settings', { seed: 's', correlate: false, toastChance: 80, hudCorner: 'bottom-left' })
    const settings = createAgeSettingsStore().get()
    expect(settings.correlate).toBe(false)
    expect(settings.toastChance).toBe(80)
    expect(settings.hudCorner).toBe('bottom-left')
  })

  it('collapses the three text switches into one', () => {
    // v1 storage: three toggles for what turned out to be one symptom.
    writeStored('settings', {
      schema: 1,
      seed: 'v1',
      streamStall: true,
      streamChunk: false,
      streamStretch: false,
    })
    const settings = createAgeSettingsStore().get()
    expect(settings.text).toBe(true)
    // The retired keys are gone, not merely ignored — leaving them would mean a
    // later rename quietly resurrects them.
    expect(readStored<Record<string, unknown>>('settings')?.['streamStall']).toBeUndefined()
  })

  it('honours any one of the three old switches still being on', () => {
    // The charitable reading: someone who had switched two off and left one on
    // was asking for text effects. Collapsing with `&&` would turn them all off.
    for (const kept of ['streamStall', 'streamChunk', 'streamStretch'] as const) {
      localStorage.clear()
      writeStored('settings', { schema: 1, seed: 'v1', streamStall: false, streamChunk: false, streamStretch: false, [kept]: true })
      expect(createAgeSettingsStore().get().text).toBe(true)
    }
  })

  it('turns text off when all three old switches were off', () => {
    writeStored('settings', { schema: 1, seed: 'v1', streamStall: false, streamChunk: false, streamStretch: false })
    expect(createAgeSettingsStore().get().text).toBe(false)
  })

  it('carries a v1 pointer choice through the v2 migration', () => {
    // v1 is where `mouseMode` became a real choice, so unlike v0 it must survive.
    writeStored('settings', { schema: 1, seed: 'v1', mouseMode: 'input-lag', streamStall: true })
    const settings = createAgeSettingsStore().get()
    expect(settings.mouseMode).toBe('input-lag')
    expect(settings.schema).toBe(SCHEMA_VERSION)
  })
})
