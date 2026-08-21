/**
 * Live-tail merging. Two failure modes make this worth pinning: append blindly
 * and a live chart grows a duplicate candle on every poll; replace blindly and
 * it never gains a new one. Both look almost right on screen for a while.
 */
import { describe, expect, it } from 'vitest'
import { mergeTail, withCandles } from '../src/client/market-client.js'
import type { ChartPayload } from '../src/client/payload.js'

type Candle = ChartPayload['timeframes'][number]['candles'][number]

const bar = (time: string, close: number, volume = 10): Candle =>
  ({ time, open: close - 1, high: close + 1, low: close - 2, close, volume })

const SERIES: Candle[] = [
  bar('2026-08-18T00:00:00.000Z', 100),
  bar('2026-08-19T00:00:00.000Z', 101),
  bar('2026-08-20T00:00:00.000Z', 102),
]

describe('mergeTail', () => {
  it('replaces the forming bar in place rather than duplicating it', () => {
    const merged = mergeTail(SERIES, [bar('2026-08-20T00:00:00.000Z', 105)])
    expect(merged).toHaveLength(SERIES.length)
    expect(merged[merged.length - 1]?.close).toBe(105)
  })

  it('appends a bar that has just opened', () => {
    const merged = mergeTail(SERIES, [bar('2026-08-21T00:00:00.000Z', 103)])
    expect(merged).toHaveLength(SERIES.length + 1)
    expect(merged[merged.length - 1]?.time).toBe('2026-08-21T00:00:00.000Z')
  })

  it('handles a tail that both closes one bar and opens the next', () => {
    const merged = mergeTail(SERIES, [
      bar('2026-08-20T00:00:00.000Z', 104),
      bar('2026-08-21T00:00:00.000Z', 106),
    ])
    expect(merged).toHaveLength(SERIES.length + 1)
    expect(merged[2]?.close).toBe(104)
    expect(merged[3]?.close).toBe(106)
  })

  it('returns the SAME reference when nothing moved, so the poll can back off', () => {
    // Identity is the signal the panel counts quiet ticks on; a fresh array
    // every poll would keep it in fast mode forever against a closed market.
    expect(mergeTail(SERIES, [bar('2026-08-20T00:00:00.000Z', 102)])).toBe(SERIES)
  })

  it('notices a volume-only change', () => {
    const merged = mergeTail(SERIES, [bar('2026-08-20T00:00:00.000Z', 102, 999)])
    expect(merged).not.toBe(SERIES)
    expect(merged[merged.length - 1]?.volume).toBe(999)
  })

  it('returns the original for an empty tail', () => {
    expect(mergeTail(SERIES, [])).toBe(SERIES)
  })

  it('keeps the series ascending even if the tail arrives out of order', () => {
    const merged = mergeTail(SERIES, [
      bar('2026-08-22T00:00:00.000Z', 108),
      bar('2026-08-21T00:00:00.000Z', 107),
    ])
    const times = merged.map(c => Date.parse(c.time))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('merges into an empty series', () => {
    const merged = mergeTail([], [bar('2026-08-20T00:00:00.000Z', 102)])
    expect(merged).toHaveLength(1)
  })
})

describe('withCandles', () => {
  const payload: ChartPayload = {
    kind: 'chart',
    version: 1,
    provider: 'futu',
    symbol: 'US.MU',
    timeframes: [{ timeframe: '1d', candles: SERIES, indicators: null, annotations: [] }],
    scenarios: [],
  }

  it('returns the same payload when the series did not move', () => {
    expect(withCandles(payload, SERIES)).toBe(payload)
  })

  it('swaps the series while preserving symbol, provider and annotations', () => {
    const next = mergeTail(SERIES, [bar('2026-08-21T00:00:00.000Z', 103)])
    const updated = withCandles(payload, next)
    expect(updated).not.toBe(payload)
    expect(updated.symbol).toBe('US.MU')
    expect(updated.provider).toBe('futu')
    expect(updated.timeframes[0]?.timeframe).toBe('1d')
    expect(updated.timeframes[0]?.candles).toHaveLength(4)
  })
})
