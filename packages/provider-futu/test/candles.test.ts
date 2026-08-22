/**
 * Candle normalisation. The timezone cases are the point: Futu prints HK and
 * A-share bars in Beijing time and US bars in New York time, so a naive parse
 * of `time` shifts every bar by hours — and a chart that is wrong by hours
 * still looks perfectly plausible.
 */
import { describe, expect, it } from 'vitest'
import { mergeBars, mergeKLinePush, toCandle, toCandles, wallClockToEpochMs } from '../src/candles.js'
import type { FutuKLine } from '../src/candles.js'

const OHLC = { openPrice: 10, highPrice: 12, lowPrice: 9, closePrice: 11 }

describe('wallClockToEpochMs', () => {
  it('reads a Hong Kong wall clock as UTC+8', () => {
    const ms = wallClockToEpochMs('2026-03-02 09:30:00', 'Asia/Hong_Kong')
    expect(new Date(ms).toISOString()).toBe('2026-03-02T01:30:00.000Z')
  })

  it('reads a Shanghai wall clock as UTC+8', () => {
    const ms = wallClockToEpochMs('2026-03-02 09:30:00', 'Asia/Shanghai')
    expect(new Date(ms).toISOString()).toBe('2026-03-02T01:30:00.000Z')
  })

  it('reads a New York winter wall clock as UTC-5 (EST)', () => {
    const ms = wallClockToEpochMs('2026-01-15 09:30:00', 'America/New_York')
    expect(new Date(ms).toISOString()).toBe('2026-01-15T14:30:00.000Z')
  })

  it('reads a New York summer wall clock as UTC-4 (EDT)', () => {
    const ms = wallClockToEpochMs('2026-07-15 09:30:00', 'America/New_York')
    expect(new Date(ms).toISOString()).toBe('2026-07-15T13:30:00.000Z')
  })

  it('handles the session that straddles a DST transition', () => {
    // US DST began 2026-03-08; the 09:30 open that day is already EDT.
    const ms = wallClockToEpochMs('2026-03-09 09:30:00', 'America/New_York')
    expect(new Date(ms).toISOString()).toBe('2026-03-09T13:30:00.000Z')
  })

  it('throws on an unparsable wall clock', () => {
    expect(() => wallClockToEpochMs('not a time', 'America/New_York')).toThrow(/unparsable/)
  })
})

describe('toCandle', () => {
  it('prefers the wire timestamp over the wall clock', () => {
    // A deliberately inconsistent pair: if `time` were used, the result would
    // differ by hours. The epoch field must win.
    const kl: FutuKLine = { ...OHLC, timestamp: 1_772_415_000, time: '1999-01-01 00:00:00', volume: 500 }
    const candle = toCandle(kl, 'America/New_York')
    expect(candle?.time).toBe(new Date(1_772_415_000 * 1000).toISOString())
  })

  it('falls back to the wall clock when no timestamp is present', () => {
    const kl: FutuKLine = { ...OHLC, time: '2026-07-15 09:30:00', volume: 1 }
    expect(toCandle(kl, 'America/New_York')?.time).toBe('2026-07-15T13:30:00.000Z')
  })

  it('drops blank (non-trading) bars', () => {
    expect(toCandle({ ...OHLC, timestamp: 1_772_415_000, isBlank: true }, 'Asia/Hong_Kong')).toBeNull()
  })

  it('drops the placeholder bar Futu emits for a session that has not started', () => {
    // Observed live during the HK lunch break: isBlank is FALSE, yet the bar
    // carries no trade at all and repeats the previous close four times.
    const placeholder: FutuKLine = {
      timestamp: 1_787_289_300, isBlank: false, volume: 0, turnover: 0,
      openPrice: 447.6, highPrice: 447.6, lowPrice: 447.6, closePrice: 447.6,
    }
    expect(toCandle(placeholder, 'Asia/Hong_Kong')).toBeNull()
  })

  it('keeps an index bar, which has no volume but real movement', () => {
    const index: FutuKLine = {
      timestamp: 1_787_289_300, volume: 0, turnover: 0,
      openPrice: 25000, highPrice: 25100, lowPrice: 24900, closePrice: 25050,
    }
    expect(toCandle(index, 'Asia/Hong_Kong')).not.toBeNull()
  })

  it('keeps a thin bar that traded once and printed flat', () => {
    const thin: FutuKLine = {
      timestamp: 1_787_289_300, volume: 100, turnover: 44760,
      openPrice: 447.6, highPrice: 447.6, lowPrice: 447.6, closePrice: 447.6,
    }
    expect(toCandle(thin, 'Asia/Hong_Kong')).not.toBeNull()
  })

  it('coerces int64 volume arriving as a string or Long', () => {
    const asString = toCandle({ ...OHLC, timestamp: 1_772_415_000, volume: '123456789' }, 'Asia/Hong_Kong')
    expect(asString?.volume).toBe(123456789)
    const asLong = toCandle({ ...OHLC, timestamp: 1_772_415_000, volume: { toString: () => '42' } }, 'Asia/Hong_Kong')
    expect(asLong?.volume).toBe(42)
  })

  it('treats a missing volume as zero rather than NaN', () => {
    expect(toCandle({ ...OHLC, timestamp: 1_772_415_000 }, 'Asia/Hong_Kong')?.volume).toBe(0)
  })

  it('throws when an OHLC field is missing', () => {
    const kl = { openPrice: 1, highPrice: 2, lowPrice: 3, timestamp: 1_772_415_000 } as FutuKLine
    expect(() => toCandle(kl, 'Asia/Hong_Kong')).toThrow(/non-numeric OHLC/)
  })

  it('throws when the bar carries no time at all', () => {
    expect(() => toCandle({ ...OHLC }, 'Asia/Hong_Kong')).toThrow(/neither timestamp nor time/)
  })

  it('carries OHLC through unchanged', () => {
    const candle = toCandle({ ...OHLC, timestamp: 1_772_415_000, volume: 7 }, 'Asia/Hong_Kong')
    expect(candle).toMatchObject({ open: 10, high: 12, low: 9, close: 11, volume: 7 })
  })
})

describe('toCandles', () => {
  it('returns candles ascending by time regardless of wire order', () => {
    const list: FutuKLine[] = [
      { ...OHLC, timestamp: 1_772_415_600 },
      { ...OHLC, timestamp: 1_772_415_000 },
      { ...OHLC, timestamp: 1_772_416_200 },
    ]
    const times = toCandles(list, 'Asia/Hong_Kong').map(c => c.time)
    expect(times).toEqual([...times].sort())
  })

  it('omits blank bars from the series', () => {
    const list: FutuKLine[] = [
      { ...OHLC, timestamp: 1_772_415_000 },
      { ...OHLC, timestamp: 1_772_415_600, isBlank: true },
      { ...OHLC, timestamp: 1_772_416_200 },
    ]
    expect(toCandles(list, 'Asia/Hong_Kong')).toHaveLength(2)
  })

  it('returns an empty series for an empty list', () => {
    expect(toCandles([], 'Asia/Hong_Kong')).toEqual([])
  })
})

describe('mergeBars', () => {
  const series = [
    { time: '2026-08-19T00:00:00.000Z', open: 1, high: 2, low: 0, close: 1.5, volume: 10 },
    { time: '2026-08-20T00:00:00.000Z', open: 2, high: 3, low: 1, close: 2.5, volume: 20 },
  ]

  it('replaces the forming bar rather than duplicating it', () => {
    const merged = mergeBars(series, [{ ...series[1]!, close: 2.9, volume: 33 }])
    expect(merged).toHaveLength(2)
    expect(merged[1]?.close).toBe(2.9)
  })

  it('appends a newly opened bar', () => {
    const merged = mergeBars(series, [
      { time: '2026-08-21T00:00:00.000Z', open: 3, high: 4, low: 2, close: 3.5, volume: 5 },
    ])
    expect(merged).toHaveLength(3)
  })

  it('returns the same reference when the push carried nothing new', () => {
    expect(mergeBars(series, [series[1]!])).toBe(series)
    expect(mergeBars(series, [])).toBe(series)
  })

  it('keeps the series ascending', () => {
    const merged = mergeBars(series, [
      { time: '2026-08-22T00:00:00.000Z', open: 4, high: 5, low: 3, close: 4.5, volume: 1 },
      { time: '2026-08-21T00:00:00.000Z', open: 3, high: 4, low: 2, close: 3.5, volume: 1 },
    ])
    const times = merged.map(c => Date.parse(c.time))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })
})

describe('mergeKLinePush', () => {
  it('uses the exchange timezone when a pushed US bar has no epoch timestamp', () => {
    const first: FutuKLine = {
      ...OHLC,
      time: '2026-07-15 09:30:00',
      volume: 10,
    }
    const seeded = toCandles([first], 'America/New_York')
    const merged = mergeKLinePush(seeded, [{ ...first, closePrice: 11.5, volume: 20 }], 'America/New_York')

    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ time: '2026-07-15T13:30:00.000Z', close: 11.5, volume: 20 })
  })
})
