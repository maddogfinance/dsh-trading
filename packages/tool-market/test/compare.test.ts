/**
 * Tests for cross-instrument comparison: the pure math in compare.ts (exact
 * values on constructed series) and the compare_symbols tool wiring (input
 * validation, per-symbol fetch, model-facing render).
 */

import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import {
  alignCandles, beta, compareSymbols, maxDrawdownPct, MIN_ALIGNED_BARS, pctReturns, pearson,
} from '../src/compare.js'
import { apply } from '../src/index.js'

/** Daily candles from 2024-01-01 with the given closes. */
function candlesFor(closes: number[], startDay = 1): Candle[] {
  return closes.map((close, i) => ({
    time: new Date(Date.UTC(2024, 0, startDay + i)).toISOString(),
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 1_000,
  }))
}

describe('pctReturns', () => {
  it('computes simple per-bar returns', () => {
    const [up, down] = pctReturns([100, 110, 99])
    expect(up).toBeCloseTo(0.1, 12)
    expect(down).toBeCloseTo(-0.1, 12)
  })

  it('treats a zero previous close as a zero return rather than dividing by it', () => {
    expect(pctReturns([0, 10])).toEqual([0])
  })
})

describe('pearson', () => {
  it('is 1 for identical return streams and -1 for inverted ones', () => {
    const a = [0.01, -0.02, 0.03, 0.01]
    expect(pearson(a, a)).toBeCloseTo(1, 12)
    expect(pearson(a, a.map(v => -v))).toBeCloseTo(-1, 12)
  })

  it('is null for a flat series (undefined, not zero)', () => {
    expect(pearson([0, 0, 0], [0.01, -0.01, 0.02])).toBeNull()
  })

  it('refuses mismatched lengths', () => {
    expect(() => pearson([1, 2], [1, 2, 3])).toThrow(/equal lengths/)
  })
})

describe('beta', () => {
  it('is 2 when the target doubles every benchmark move', () => {
    const bench = [0.01, -0.02, 0.03]
    expect(beta(bench.map(v => v * 2), bench)).toBeCloseTo(2, 12)
  })

  it('is null against a flat benchmark', () => {
    expect(beta([0.01, -0.01], [0, 0])).toBeNull()
  })
})

describe('maxDrawdownPct', () => {
  it('finds the deepest peak-to-trough decline', () => {
    // Peak 120 → trough 60 is -50%, deeper than the later 90 → 81 dip.
    expect(maxDrawdownPct([100, 120, 60, 90, 81])).toBeCloseTo(-50, 12)
  })

  it('is 0 for a monotonic rise', () => {
    expect(maxDrawdownPct([1, 2, 3])).toBe(0)
  })
})

describe('alignCandles', () => {
  it('intersects on instants, counts dropped bars, aligns Z and +00:00 spellings', () => {
    const a = candlesFor([100, 101, 102])
    const b = candlesFor([200, 202, 204, 206]) // one trailing bar A lacks
    b[1] = { ...b[1]!, time: '2024-01-02T00:00:00+00:00' } // same instant, other spelling
    const { times, series } = alignCandles([
      { symbol: 'A', candles: a },
      { symbol: 'B', candles: b },
    ])
    expect(times).toEqual(a.map(c => c.time)) // spelled as the first symbol serves them
    expect(series[0]).toEqual({ symbol: 'A', closes: [100, 101, 102], dropped: 0 })
    expect(series[1]).toEqual({ symbol: 'B', closes: [200, 202, 204], dropped: 1 })
  })
})

describe('compareSymbols', () => {
  const closesA = Array.from({ length: 30 }, (_, i) => 100 + i)

  it('reports identical statistics for a scaled copy of the benchmark', () => {
    const c = compareSymbols([
      { symbol: 'A', candles: candlesFor(closesA) },
      { symbol: 'B', candles: candlesFor(closesA.map(v => v * 2)) },
    ])
    expect(c.bars).toBe(30)
    expect(c.rows[0]!.lastClose).toBe(129) // reporting-rounded, like every published value
    const [a, b] = c.rows
    expect(a!.totalReturnPct).toBe(29) // 100 → 129
    expect(b!.totalReturnPct).toBe(29) // scaling cancels
    expect(a!.maxDrawdownPct).toBe(0)
    expect(a!.betaVsBenchmark).toBe(1) // benchmark row, by definition
    expect(b!.betaVsBenchmark).toBe(1) // identical returns
    expect(c.correlation).toEqual([[1, 1], [1, 1]])
  })

  it("marks a flat symbol's correlation null (undefined, not zero); its beta is a defined 0", () => {
    const c = compareSymbols([
      { symbol: 'A', candles: candlesFor(closesA) },
      { symbol: 'FLAT', candles: candlesFor(closesA.map(() => 100)) },
    ])
    expect(c.rows[1]!.betaVsBenchmark).toBe(0) // a constant asset has beta 0 — defined, unlike its correlation
    expect(c.correlation[0]![1]).toBeNull()
    expect(c.correlation[1]![1]).toBe(1) // diagonal stays 1 by convention
  })

  it('marks every beta null when the BENCHMARK is flat', () => {
    const c = compareSymbols([
      { symbol: 'FLAT', candles: candlesFor(closesA.map(() => 100)) },
      { symbol: 'A', candles: candlesFor(closesA) },
    ])
    expect(c.rows[0]!.betaVsBenchmark).toBe(1) // benchmark row, by definition
    expect(c.rows[1]!.betaVsBenchmark).toBeNull()
  })

  it(`refuses fewer than ${MIN_ALIGNED_BARS} shared bars, naming per-symbol coverage`, () => {
    expect(() => compareSymbols([
      { symbol: 'A', candles: candlesFor(closesA) },
      { symbol: 'LATE', candles: candlesFor([1, 2, 3], 28) }, // overlaps A on 3 days only
    ])).toThrow(/only 3 bars are shared by all symbols .*A: 30 bars, LATE: 3 bars/)
  })
})

/** Capture registered tools through a fake ctx with per-symbol fixtures. */
function captureCompare(data: Record<string, Candle[]>) {
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown>; output: { render: (args: unknown, value: never) => { type: string; text?: string }[] } }>()
  const provider = {
    id: 'test',
    description: 'fixture',
    listSymbols: async () => Object.keys(data).map(symbol => ({ symbol })),
    getOhlcv: async ({ symbol }: { symbol: string }) => data[symbol] ?? [],
  }
  const ctx = {
    tools: { register: (def: never) => { tools.set((def as { name: string }).name, def) } },
    marketData: { provider: () => provider },
  }
  apply(ctx as never, { chartDir: './charts' })
  return tools.get('compare_symbols')!
}

describe('compare_symbols tool wiring', () => {
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i)
  const data = {
    A: candlesFor(closes),
    B: candlesFor(closes.map(v => v * 2)),
  }

  it('renders the comparison block with its caveats', async () => {
    const tool = captureCompare(data)
    const value = await tool.execute({ symbols: ['A', 'B'] }, {}) as never
    const text = tool.output.render({}, value)[0]!.text!
    expect(text).toContain("Comparison from 'test'")
    expect(text).toContain('30 aligned bars')
    expect(text).toContain('beta vs A')
    expect(text).toContain('NOT annualized')
  })

  it('refuses fewer than two distinct symbols and more than eight', async () => {
    const tool = captureCompare(data)
    await expect(tool.execute({ symbols: ['A', 'A'] }, {})).rejects.toThrow(/2\.\.8 distinct symbols \(got 1\)/)
    const many = Array.from({ length: 9 }, (_, i) => `S${i}`)
    await expect(tool.execute({ symbols: many }, {})).rejects.toThrow(/2\.\.8 distinct symbols \(got 9\)/)
  })

  it('refuses bars outside 2..1000 and names a symbol with no data', async () => {
    const tool = captureCompare(data)
    await expect(tool.execute({ symbols: ['A', 'B'], bars: 5000 }, {})).rejects.toThrow(/bars must be within 2\.\.1000/)
    await expect(tool.execute({ symbols: ['A', 'MISSING'] }, {})).rejects.toThrow(/no candles for MISSING @ 1d/)
  })
})
