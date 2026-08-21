/**
 * Drawing the agent's marks onto the series the USER is watching.
 *
 * Two classes of failure make this worth pinning hard. The predicate decides
 * whether a drawing is even about this chart — get it loose and a level
 * computed on one instrument is painted over another's candles. The range gate
 * decides what survives — get it loose and the canvas and the annotation table
 * below it disagree, which is the exact failure this feature exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import { mergeMarks, readMarks } from '../src/client/market-client.js'
import type { ChartMarks } from '../src/client/market-client.js'
import type { ChartPayload } from '../src/client/payload.js'

const bar = (time: string, low: number, high: number) =>
  ({ time, open: low, high, low, close: high, volume: 1 })

/** Panel series: prices 100..200, one day apart. */
const CANDLES = [
  bar('2026-08-18T00:00:00.000Z', 100, 150),
  bar('2026-08-19T00:00:00.000Z', 120, 180),
  bar('2026-08-20T00:00:00.000Z', 130, 200),
]

function chart(over: Partial<ChartPayload> = {}): ChartPayload {
  return {
    kind: 'chart',
    version: 1,
    provider: 'futu',
    symbol: 'US.MU',
    timeframes: [{ timeframe: '1d', candles: CANDLES, indicators: null, annotations: [] }],
    scenarios: [],
    ...over,
  }
}

const level = (price: number, role = 'other') =>
  ({ type: 'level' as const, price, label: `L${price}`, role, sources: ['s'] })

function marksOf(over: Partial<ChartMarks> = {}): ChartMarks {
  return {
    key: 'k',
    provider: 'futu',
    symbol: 'US.MU',
    timeframe: '1d',
    annotations: [level(150)],
    scenarios: [],
    at: '09:41',
    ...over,
  }
}

describe('readMarks', () => {
  it('ignores a payload that carries no drawings', () => {
    // market_snapshot and get_ohlcv produce exactly this shape; they must never
    // blank marks the agent drew earlier.
    expect(readMarks(chart())).toBeNull()
    expect(readMarks(null)).toBeNull()
  })

  it('keeps the provider\'s own casing beside the match key', () => {
    // The normalised form is a comparison key. Instrument codes are
    // case-sensitive at the provider, so handing the upper-cased string back
    // to a lookup would fetch the wrong thing — or nothing.
    const m = readMarks(chart({
      symbol: 'CC.btcUsdt',
      timeframes: [{ timeframe: '1d', candles: CANDLES, indicators: null, annotations: [level(150)] }],
    }))
    expect(m?.symbol).toBe('CC.BTCUSDT')
    expect(m?.rawSymbol).toBe('CC.btcUsdt')
  })

  it('lifts annotations and normalises the symbol', () => {
    const m = readMarks(chart({
      symbol: ' us.mu ',
      timeframes: [{ timeframe: '1d', candles: CANDLES, indicators: null, annotations: [level(150)] }],
    }))
    expect(m?.symbol).toBe('US.MU')
    expect(m?.annotations).toHaveLength(1)
  })

  it('keys on content, so an identical republish is the same marks', () => {
    // `latest` republishes whenever an old card scrolls back into view; an
    // identical republish must not disturb the chart or re-arm a dismissal.
    const p = chart({ timeframes: [{ timeframe: '1d', candles: CANDLES, indicators: null, annotations: [level(150)] }] })
    expect(readMarks(p)?.key).toBe(readMarks(p)?.key)
    const q = chart({ timeframes: [{ timeframe: '1d', candles: CANDLES, indicators: null, annotations: [level(151)] }] })
    expect(readMarks(p)?.key).not.toBe(readMarks(q)?.key)
  })

  it('picks the timeframe that actually carries the drawings', () => {
    const p = chart({
      timeframes: [
        { timeframe: '1d', candles: CANDLES, indicators: null, annotations: [] },
        { timeframe: '4h', candles: CANDLES, indicators: null, annotations: [level(150)] },
      ],
    })
    expect(readMarks(p)?.timeframe).toBe('4h')
  })

  it('adopts a scenario-only payload', () => {
    const p = chart({
      scenarios: [{ direction: 'bull', stance: 'base', thesis: 't', trigger: 'x', invalidation: 'y' }],
    })
    expect(readMarks(p)?.scenarios).toHaveLength(1)
  })
})

describe('mergeMarks — the predicate', () => {
  it('refuses a different provider, returning the payload by reference', () => {
    // The panel always reads the default provider while annotate_chart takes an
    // explicit one; without this a level from one instrument lands on another.
    const p = chart()
    const r = mergeMarks(p, marksOf({ provider: 'csv' }))
    expect(r.applied).toBe(false)
    expect(r.payload).toBe(p)
  })

  it('matches symbols case-insensitively and ignoring surrounding space', () => {
    const r = mergeMarks(chart({ symbol: ' us.MU ' }), marksOf())
    expect(r.applied).toBe(true)
    expect(r.kept).toBe(1)
  })

  it('refuses a different symbol', () => {
    expect(mergeMarks(chart(), marksOf({ symbol: 'US.NVDA' })).applied).toBe(false)
  })

  it('refuses a different timeframe outright — even price-only marks', () => {
    // A level is timeframe-agnostic in the abstract, but the price axis is
    // scaled to the visible candles: lifted onto another window it can sit
    // off-pane while its table row still prints a price and a distance.
    const r = mergeMarks(chart(), marksOf({ timeframe: '15m' }))
    expect(r.applied).toBe(false)
    expect(r.kept).toBe(0)
  })
})

describe('mergeMarks — the range gate', () => {
  it('keeps a level inside the window and drops one outside it', () => {
    const r = mergeMarks(chart(), marksOf({ annotations: [level(150), level(1_000_000)] }))
    expect(r.kept).toBe(1)
    expect(r.dropped).toBe(1)
  })

  it('gives target and invalidation roles the producer\'s wider band', () => {
    // lo=100 hi=200: ordinary band is 70..260, the wide band is 50..400.
    expect(mergeMarks(chart(), marksOf({ annotations: [level(350, 'target')] })).kept).toBe(1)
    expect(mergeMarks(chart(), marksOf({ annotations: [level(350, 'other')] })).kept).toBe(0)
  })

  it('drops a zone when either bound fails, never half-drawn', () => {
    const zone = (low: number, high: number) =>
      ({ type: 'zone' as const, low, high, label: 'z', role: 'other', sources: ['s'] })
    expect(mergeMarks(chart(), marksOf({ annotations: [zone(120, 180)] })).kept).toBe(1)
    expect(mergeMarks(chart(), marksOf({ annotations: [zone(120, 9_999)] })).kept).toBe(0)
  })

  it('drops a path whole when any point falls outside — never truncates it', () => {
    // A truncated path is a different claim than the one the agent made.
    const path = (points: { time: string; price: number }[]) =>
      ({ type: 'path' as const, points, label: 'p', role: 'other', sources: ['s'] })
    const good = path([
      { time: '2026-08-18T00:00:00.000Z', price: 120 },
      { time: '2026-08-20T00:00:00.000Z', price: 180 },
    ])
    expect(mergeMarks(chart(), marksOf({ annotations: [good] })).kept).toBe(1)

    const offWindow = path([
      { time: '2020-01-01T00:00:00.000Z', price: 120 },
      { time: '2026-08-20T00:00:00.000Z', price: 180 },
    ])
    const r = mergeMarks(chart(), marksOf({ annotations: [offWindow] }))
    expect(r.kept).toBe(0)
    expect(r.dropped).toBe(1)
  })

  it('passes an unknown annotation type through unmodified', () => {
    // The annotation array is an open envelope; stripping unknown types would
    // break the third-party renderer seam.
    const exotic = { type: 'fib-fan', anchors: [1, 2, 3], label: 'f' } as never
    const r = mergeMarks(chart(), marksOf({ annotations: [exotic] }))
    expect(r.kept).toBe(1)
    expect(r.payload.timeframes[0]?.annotations?.[0]).toBe(exotic)
  })

  it('keeps a scenario\'s prose and strips only the price it cannot justify', () => {
    const r = mergeMarks(chart(), marksOf({
      annotations: [],
      scenarios: [{
        direction: 'bull', stance: 'base', thesis: 't', trigger: 'x', invalidation: 'y',
        triggerPrice: 1_000_000, invalidationPrice: 120,
      }],
    }))
    const s = r.payload.scenarios?.[0] as Record<string, unknown>
    expect(s['thesis']).toBe('t')
    expect(s['triggerPrice']).toBeUndefined()
    expect(s['invalidationPrice']).toBe(120)
    expect(r.dropped).toBe(1)
  })

  it('counts drawn scenarios as marks, not just annotations', () => {
    // Scenarios draw their own trigger/invalidation lines; reporting only
    // annotations makes a scenario-only analysis claim "0 marks" while its
    // lines sit on the canvas.
    const r = mergeMarks(chart(), marksOf({
      annotations: [],
      scenarios: [{
        direction: 'bull', stance: 'base', thesis: 't', trigger: 'x', invalidation: 'y',
        triggerPrice: 180,
      }],
    }))
    expect(r.kept).toBe(1)
  })

  it('reports applied with nothing kept when the window refuses everything', () => {
    const p = chart()
    const r = mergeMarks(p, marksOf({ annotations: [level(1_000_000)] }))
    expect(r).toMatchObject({ applied: true, kept: 0, dropped: 1 })
    expect(r.payload).toBe(p)
  })
})

describe('mergeMarks — what it must never touch', () => {
  it('leaves the series, symbol, provider and timeframe identical', () => {
    const p = chart()
    const r = mergeMarks(p, marksOf())
    expect(r.payload.symbol).toBe(p.symbol)
    expect(r.payload.provider).toBe(p.provider)
    expect(r.payload.timeframes[0]?.timeframe).toBe('1d')
    expect(r.payload.timeframes[0]?.candles).toBe(CANDLES)
  })

  it('never adds a second timeframe entry', () => {
    // The live poll, the publish effect and the timeframe picker all read
    // timeframes[0]; a second entry would grow a tab that never ticks.
    expect(mergeMarks(chart(), marksOf()).payload.timeframes).toHaveLength(1)
  })

  it('never imports the agent\'s indicators or per-bar series', () => {
    // They are aligned index-for-index with the agent's shorter window and are
    // read positionally — importing them shifts indicator panes by hundreds of
    // bars and prints numbers that look real.
    const r = mergeMarks(chart(), marksOf())
    expect(r.payload.timeframes[0]?.indicators).toBeNull()
    expect(r.payload.timeframes[0]?.series).toBeUndefined()
  })

  it('handles an empty series without inventing a range', () => {
    const empty = chart({ timeframes: [{ timeframe: '1d', candles: [], indicators: null, annotations: [] }] })
    expect(mergeMarks(empty, marksOf())).toMatchObject({ applied: true, kept: 0 })
  })
})
