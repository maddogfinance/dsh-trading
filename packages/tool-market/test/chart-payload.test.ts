import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { CHART_META_BARS, chartCandles, chartSeries } from '../src/chart-payload.js'
import { apply } from '../src/index.js'
import type { ChartPayload } from '../src/chart-payload.js'

function makeCandles(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + Math.sin(i / 7) * 10 + i * 0.05
    return {
      time: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString(),
      open: round(base),
      high: round(base + 2),
      low: round(base - 2),
      close: round(base + Math.cos(i / 5)),
      volume: 1_000 + (i % 50) * 10,
    }
  })
}

function round(x: number): number {
  return Math.round(x * 100) / 100
}

describe('chartCandles', () => {
  it('keeps the tail and caps at CHART_META_BARS', () => {
    const candles = makeCandles(500)
    const tail = chartCandles(candles)
    expect(tail).not.toBeNull()
    expect(tail!.length).toBe(CHART_META_BARS)
    expect(tail![tail!.length - 1]!.time).toBe(candles[candles.length - 1]!.time)
  })

  it('returns plain literals, not the Candle objects', () => {
    const candles = makeCandles(3)
    const tail = chartCandles(candles)!
    expect(tail[0]).not.toBe(candles[0])
    expect(tail[0]).toEqual({ ...candles[0] })
  })

  it('refuses a tail containing non-finite numbers instead of dropping bars', () => {
    const candles = makeCandles(10)
    candles[7] = { ...candles[7]!, close: Number.NaN }
    expect(chartCandles(candles)).toBeNull()
    // A dirty bar outside the tail must not poison the payload.
    expect(chartCandles(candles, 2)).not.toBeNull()
  })
})

describe('chartSeries', () => {
  it('slices every column to the same tail', () => {
    const series = { sma20: Array.from({ length: 500 }, (_, i) => i), rsi14: Array.from({ length: 500 }, () => null) }
    const sliced = chartSeries(series)
    expect(sliced['sma20']!.length).toBe(CHART_META_BARS)
    expect(sliced['sma20']![CHART_META_BARS - 1]).toBe(499)
    expect(sliced['rsi14']!.length).toBe(CHART_META_BARS)
  })
})

/**
 * Wire-level contract: capture the registered tool definitions through a fake
 * ctx and assert the model/UI split — render text carries no candle JSON, the
 * presentationMeta projection carries the full chart payload.
 */
interface RegisteredTool {
  name: string
  output: {
    render: (args: unknown, value: never) => { type: string; text?: string }[]
    presentationMeta?: (args: unknown, value: never) => unknown
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

function captureTools(candles: Candle[]): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>()
  const provider = {
    id: 'test',
    description: 'fixture',
    listSymbols: async () => [{ symbol: 'DEMO' }],
    getOhlcv: async () => candles,
  }
  const ctx = {
    tools: { register: (def: RegisteredTool) => { tools.set(def.name, def) } },
    marketData: { provider: () => provider },
  }
  apply(ctx as never, { chartDir: './charts' })
  return tools
}

describe('tool wiring: model/UI split', () => {
  const candles = makeCandles(320)

  it('market_snapshot: render text unchanged, meta carries the chart payload', async () => {
    const tool = captureTools(candles).get('market_snapshot')!
    const value = await tool.execute({ symbol: 'DEMO', timeframes: ['1d', '4h'] }, {}) as never
    const blocks = tool.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.type).toBe('text')
    expect(blocks[0]!.text).toContain('DEMO indicator regime')
    // The drawable tail must never leak into model-facing text.
    expect(blocks[0]!.text).not.toContain('"candles"')

    const meta = tool.output.presentationMeta!({}, value) as ChartPayload
    expect(meta.kind).toBe('chart')
    expect(meta.version).toBe(1)
    expect(meta.symbol).toBe('DEMO')
    expect(meta.timeframes).toHaveLength(2)
    for (const tf of meta.timeframes) {
      expect(tf.candles.length).toBeLessThanOrEqual(CHART_META_BARS)
      expect(tf.indicators).not.toBeNull()
      // Regime series ride along, tail-aligned with the candles, so chip
      // toggles draw the exact numbers the model read.
      expect(Object.keys(tf.series ?? {})).toEqual(expect.arrayContaining(
        ['rsi14', 'stoch_k', 'stoch_d', 'adx', 'macd', 'macd_signal', 'macd_hist', 'mfi14', 'bb_upper', 'bb_middle', 'bb_lower']))
      for (const col of Object.values(tf.series ?? {})) expect(col.length).toBe(tf.candles.length)
      expect(JSON.stringify(meta)).toBe(JSON.stringify(JSON.parse(JSON.stringify(meta))))
    }
  })

  it('get_ohlcv: csv text for the model, chart tail with series for the card', async () => {
    const tool = captureTools(candles).get('get_ohlcv')!
    const value = await tool.execute({ symbol: 'DEMO', timeframe: '1d', sma: [20], rsi: 14 }, {}) as never
    const blocks = tool.output.render({}, value)
    expect(blocks[0]!.text).toContain('time,open,high,low,close,volume,sma20,rsi14')
    expect(blocks[0]!.text).not.toContain('"candles"')

    const meta = tool.output.presentationMeta!({}, value) as ChartPayload
    expect(meta.kind).toBe('chart')
    expect(meta.timeframes).toHaveLength(1)
    const tf = meta.timeframes[0]!
    expect(tf.candles.length).toBe(CHART_META_BARS)
    // Requested columns plus the regime set, all tail-aligned.
    expect(Object.keys(tf.series ?? {})).toEqual(expect.arrayContaining(['sma20', 'rsi14', 'macd_hist', 'bb_upper']))
    expect(tf.series!['sma20']!.length).toBe(tf.candles.length)
    expect(tf.series!['macd_hist']!.length).toBe(tf.candles.length)
  })

  it('get_ohlcv: requested columns enter the payload rounded (CONTRACTS §2.1), matching the regime precision', async () => {
    const tool = captureTools(candles).get('get_ohlcv')!
    const value = await tool.execute({ symbol: 'DEMO', timeframe: '1d', sma: [20], rsi: 14 }, {}) as never
    const series = (tool.output.presentationMeta!({}, value) as ChartPayload).timeframes[0]!.series!
    // rsi14 is a frozen v1 column name: the requested spelling must be
    // byte-identical to what regimeSeries would publish, not a
    // full-precision shadow of it.
    for (const v of series['rsi14']!) {
      if (v !== null) expect(v).toBe(Math.round(v * 100) / 100)
    }
    for (const v of series['sma20']!) {
      if (v !== null) expect(v).toBe(Math.round(v * 10_000) / 10_000)
    }
  })

  it('get_ohlcv: refuses a limit beyond the cap instead of flooding model context', async () => {
    const tool = captureTools(candles).get('get_ohlcv')!
    await expect(tool.execute({ symbol: 'DEMO', timeframe: '1d', limit: 5000 }, {}))
      .rejects.toThrow(/limit 5000 exceeds the maximum 2000 bars per call/)
  })

  it('get_ohlcv: no candles means a null meta, not a broken payload', async () => {
    const tool = captureTools([]).get('get_ohlcv')!
    const value = await tool.execute({ symbol: 'DEMO', timeframe: '1d' }, {}) as never
    expect(tool.output.presentationMeta!({}, value)).toBeNull()
  })
})

describe('annotate_chart validation gate', () => {
  const candles = makeCandles(320)
  const lo = Math.min(...candles.map(c => c.low))
  const hi = Math.max(...candles.map(c => c.high))
  const inRange = (lo + hi) / 2
  const tool = () => captureTools(candles).get('annotate_chart')!

  it('accepts sourced levels, zones, paths, and scenarios; ships them UI-only', async () => {
    const midTime = candles[200]!.time
    const lateTime = candles[300]!.time
    const value = await tool().execute({
      symbol: 'DEMO',
      timeframe: '1d',
      levels: [{ price: inRange, label: 'neckline test', role: 'neckline', sources: ['double-bottom neckline', '  '] }],
      zones: [{ low: inRange, high: inRange * 1.05, label: 'supply', role: 'resistance', sources: ['order block'] }],
      paths: [{ points: [{ time: midTime, price: inRange }, { time: lateTime, price: inRange * 1.1 }], label: 'measured move', sources: ['pattern leg'] }],
      scenarios: [{ direction: 'bear', stance: 'base', thesis: 't', trigger: 'close below x', invalidation: 'close above y', invalidationPrice: inRange }],
    }, {}) as never
    const blocks = tool().output.render({}, value)
    expect(blocks[0]!.text).toContain('Annotated DEMO @ 1d: 1 level(s), 1 zone(s), 1 path(s), 1 scenario(s)')
    expect(blocks[0]!.text).not.toContain('"annotations"')

    const meta = tool().output.presentationMeta!({}, value) as { timeframes: { annotations: { type: string; label?: string; sources?: string[] }[] }[]; scenarios: { stance: string }[] }
    const annotations = meta.timeframes[0]!.annotations
    expect(annotations.map(a => a.type)).toEqual(['level', 'zone', 'path'])
    // Control characters stripped, empty sources dropped.
    expect(annotations[0]!.label).toBe('neckline test')
    expect(annotations[0]!.sources).toEqual(['double-bottom neckline'])
    expect(meta.scenarios[0]!.stance).toBe('base')
  })

  it('rejects a hallucinated level with an instructive error naming the real range', async () => {
    await expect(tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      levels: [{ price: hi * 5, label: 'moon', sources: ['vibes'] }],
    }, {})).rejects.toThrow(/outside the plausible range .* Anchor on prices you actually read/s)
  })

  it('gives target roles a wider projection band than structural roles', async () => {
    const projection = hi * 1.6
    await expect(tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      levels: [{ price: projection, label: 'ext', role: 'support', sources: ['1.618 extension'] }],
    }, {})).rejects.toThrow(/outside the plausible range/)
    const value = await tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      levels: [{ price: projection, label: 'ext', role: 'target', sources: ['1.618 extension'] }],
    }, {}) as never
    expect(tool().output.render({}, value)[0]!.text).toContain('1 level(s)')
  })

  it('refuses unsourced annotations', async () => {
    await expect(tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      levels: [{ price: inRange, label: 'bare', sources: [] }],
    }, {})).rejects.toThrow(/has no sources/)
  })

  it('rejects path points outside the drawn window', async () => {
    await expect(tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      paths: [{ points: [{ time: '2010-01-01T00:00:00.000Z', price: inRange }, { time: candles[300]!.time, price: inRange }], label: 'old', sources: ['s'] }],
    }, {})).rejects.toThrow(/outside the drawn window/)
  })

  it('rejects zones thinner than 0.05% of price and empty calls', async () => {
    await expect(tool().execute({
      symbol: 'DEMO', timeframe: '1d',
      zones: [{ low: inRange, high: inRange + inRange * 0.0001, label: 'thin', sources: ['s'] }],
    }, {})).rejects.toThrow(/thinner than 0.05%/)
    await expect(tool().execute({ symbol: 'DEMO', timeframe: '1d' }, {})).rejects.toThrow(/nothing to annotate/)
  })
})
