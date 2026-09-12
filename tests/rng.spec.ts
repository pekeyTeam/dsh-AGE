import { describe, expect, it } from 'vitest'
import { mulberry32, seedFrom, streamFor } from '../src/client/rng.ts'

describe('mulberry32', () => {
  it('produces an identical sequence for the same seed', () => {
    const first = mulberry32(12345)
    const second = mulberry32(12345)
    const left = Array.from({ length: 50 }, () => first.next())
    const right = Array.from({ length: 50 }, () => second.next())
    expect(left).toEqual(right)
  })

  it('produces different sequences for different seeds', () => {
    const left = Array.from({ length: 20 }, () => mulberry32(1).next())
    const right = Array.from({ length: 20 }, () => mulberry32(2).next())
    expect(left).not.toEqual(right)
  })

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(7)
    for (let index = 0; index < 10_000; index += 1) {
      const value = rng.next()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('respects inclusive integer bounds', () => {
    const rng = mulberry32(99)
    for (let index = 0; index < 10_000; index += 1) {
      const value = rng.int(3, 7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(3)
      expect(value).toBeLessThanOrEqual(7)
    }
  })

  it('reaches both ends of an integer band', () => {
    const rng = mulberry32(4)
    const seen = new Set<number>()
    for (let index = 0; index < 500; index += 1) seen.add(rng.int(0, 2))
    expect([...seen].sort()).toEqual([0, 1, 2])
  })

  it('respects floating-point band bounds', () => {
    const rng = mulberry32(11)
    for (let index = 0; index < 10_000; index += 1) {
      const value = rng.range([1_000, 3_000])
      expect(value).toBeGreaterThanOrEqual(1_000)
      expect(value).toBeLessThanOrEqual(3_000)
    }
  })

  it('returns undefined from an empty pick', () => {
    expect(mulberry32(1).pick([])).toBeUndefined()
  })

  it('only ever picks from the list it was given', () => {
    const rng = mulberry32(2)
    const items = ['a', 'b', 'c'] as const
    const seen = new Set<string | undefined>()
    for (let index = 0; index < 200; index += 1) seen.add(rng.pick(items))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('seedFrom', () => {
  it('is stable for the same input', () => {
    expect(seedFrom('dsh-age')).toBe(seedFrom('dsh-age'))
  })

  it('separates inputs that differ by one character', () => {
    expect(seedFrom('seed-a')).not.toBe(seedFrom('seed-b'))
  })

  it('returns a 32-bit unsigned integer', () => {
    for (const text of ['', 'a', 'dsh-age', '很长的种子', '0'.repeat(500)]) {
      const hash = seedFrom(text)
      expect(Number.isInteger(hash)).toBe(true)
      expect(hash).toBeGreaterThanOrEqual(0)
      expect(hash).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('streamFor', () => {
  it('gives each named stream an independent sequence', () => {
    const mouse = Array.from({ length: 20 }, (_, index) => streamFor('seed', 'mouse').int(0, 1e6) + index)
    const stall = Array.from({ length: 20 }, (_, index) => streamFor('seed', 'stream-stall').int(0, 1e6) + index)
    expect(mouse).not.toEqual(stall)
  })

  it('is reproducible per stream', () => {
    const first = streamFor('session-1', 'stream-chunk')
    const second = streamFor('session-1', 'stream-chunk')
    expect(Array.from({ length: 30 }, () => first.next())).toEqual(
      Array.from({ length: 30 }, () => second.next()),
    )
  })

  it('decorrelates the first draw of two streams', () => {
    // The scheduler's very first draw is a gap measured in seconds, so two
    // streams that opened with near-identical values would visibly sync.
    const mouse = streamFor('seed', 'mouse').range([5_000, 15_000])
    const stall = streamFor('seed', 'stream-stall').range([5_000, 15_000])
    expect(Math.abs(mouse - stall)).toBeGreaterThan(1)
  })
})
