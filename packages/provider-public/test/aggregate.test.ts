/**
 * 4h bars for the keyless Yahoo provider. Yahoo has no 4-hour interval, so 4h
 * is folded from 60m, and the fold has to respect sessions: a US day has seven
 * hourly bars, so counting bars in fours drifts across days and files Monday's
 * low under Friday's date. These cases pin the New York session grid, the UTC
 * grid for round-the-clock markets, and the flat closing tick Yahoo appends to
 * the latest session.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Candle, MarketDataProvider } from '@dsh-trading/market-data'
import { aggregate, apply, foldEchoes, sessionOf, UTC_GRID } from '../src/index.js'
import type { Session, YahooMeta } from '../src/index.js'

const HOUR = 3_600_000
const NEW_YORK: Session = { timeZone: 'America/New_York', openMinute: 9 * 60 + 30 }

function bar(time: string, open: number, high: number, low: number, close: number, volume: number): Candle {
  return { time, open, high, low, close, volume }
}

/** `count` hourly bars from `first`, a dollar apart so every bar is distinct. */
function hourly(first: string, count: number, volume = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = 100 + i
    return bar(new Date(Date.parse(first) + i * HOUR).toISOString(), open, open + 0.5, open - 0.5, open + 0.25, volume)
  })
}

// AAPL around the reported case. Late October is still EDT, so 09:30 New York is 13:30Z.
const FRIDAY = [
  bar('2026-10-23T13:30:00.000Z', 345.10, 346.20, 344.80, 345.90, 6000),
  bar('2026-10-23T14:30:00.000Z', 345.90, 346.50, 345.20, 346.10, 3000),
  bar('2026-10-23T15:30:00.000Z', 346.10, 346.40, 345.60, 345.80, 2500),
  bar('2026-10-23T16:30:00.000Z', 345.80, 346.00, 345.10, 345.40, 2000),
  bar('2026-10-23T17:30:00.000Z', 345.40, 345.90, 344.90, 345.70, 2100),
  bar('2026-10-23T18:30:00.000Z', 345.70, 346.30, 345.50, 346.00, 2400),
  bar('2026-10-23T19:30:00.000Z', 346.00, 346.60, 345.80, 346.40, 4000),
]
const MONDAY = [
  bar('2026-10-26T13:30:00.000Z', 344.00, 344.50, 341.03, 342.20, 9000),
  bar('2026-10-26T14:30:00.000Z', 342.20, 343.40, 341.90, 343.10, 4000),
  bar('2026-10-26T15:30:00.000Z', 343.10, 343.80, 342.70, 343.50, 3000),
  bar('2026-10-26T16:30:00.000Z', 343.50, 344.10, 343.20, 343.90, 2500),
  bar('2026-10-26T17:30:00.000Z', 343.90, 344.40, 343.60, 344.20, 2500),
  bar('2026-10-26T18:30:00.000Z', 344.20, 344.90, 344.00, 344.70, 3000),
  bar('2026-10-26T19:30:00.000Z', 344.70, 345.20, 344.30, 344.90, 5000),
]

// Monday 2026-11-02, the first session after the switch to EST (09:30 = 14:30Z),
// as Yahoo served it the next morning: seven bars, then the 16:00 closing tick.
const NOV_2 = [
  bar('2026-11-02T14:30:00.000Z', 342.67, 343.78, 339.61, 340.33, 10_151),
  bar('2026-11-02T15:30:00.000Z', 340.33, 342.32, 340.06, 341.19, 4_310),
  bar('2026-11-02T16:30:00.000Z', 341.20, 341.26, 337.23, 337.29, 5_578),
  bar('2026-11-02T17:30:00.000Z', 337.25, 338.76, 336.52, 337.13, 5_036),
  bar('2026-11-02T18:30:00.000Z', 337.13, 337.80, 335.84, 336.86, 4_659),
  bar('2026-11-02T19:30:00.000Z', 336.89, 339.19, 336.50, 338.97, 5_570),
  bar('2026-11-02T20:30:00.000Z', 338.96, 339.14, 337.58, 339.11, 7_538),
]
const NOV_2_CLOSE = bar('2026-11-02T21:00:00.000Z', 338.32, 338.32, 338.32, 338.32, 0)

describe('aggregate on the New York session grid', () => {
  it('never merges two consecutive sessions', () => {
    const blocks = aggregate([...FRIDAY, ...MONDAY], 4, NEW_YORK)
    expect(blocks).toEqual([
      { time: '2026-10-23T13:30:00.000Z', open: 345.10, high: 346.50, low: 344.80, close: 345.40, volume: 13_500 },
      { time: '2026-10-23T17:30:00.000Z', open: 345.40, high: 346.60, low: 344.90, close: 346.40, volume: 8_500 },
      { time: '2026-10-26T13:30:00.000Z', open: 344.00, high: 344.50, low: 341.03, close: 343.90, volume: 18_500 },
      { time: '2026-10-26T17:30:00.000Z', open: 343.90, high: 345.20, low: 343.60, close: 344.90, volume: 10_500 },
    ])
  })

  it('follows New York wall-clock time across the DST switch', () => {
    const blocks = aggregate([...hourly('2026-10-30T13:30:00Z', 7), ...hourly('2026-11-02T14:30:00Z', 7)], 4, NEW_YORK)
    expect(blocks.map(b => b.time)).toEqual([
      '2026-10-30T13:30:00.000Z',
      '2026-10-30T17:30:00.000Z',
      '2026-11-02T14:30:00.000Z',
      '2026-11-02T18:30:00.000Z',
    ])
  })

  it('folds the closing tick into the last block instead of making it a candle', () => {
    const blocks = aggregate([...NOV_2, NOV_2_CLOSE], 4, NEW_YORK)
    expect(blocks.map(b => b.time)).toEqual(['2026-11-02T14:30:00.000Z', '2026-11-02T18:30:00.000Z'])
    // The tick carries the official close; it adds no volume.
    expect(blocks[1]).toEqual({
      time: '2026-11-02T18:30:00.000Z', open: 337.13, high: 339.19, low: 335.84, close: 338.32, volume: 17_767,
    })
  })

  it('never lets a closing tick open a block of its own', () => {
    // The afternoon is missing (Yahoo pads such gaps with nulls, which are skipped).
    const blocks = aggregate([...NOV_2.slice(0, 4), NOV_2_CLOSE], 4, NEW_YORK)
    expect(blocks.map(b => b.time)).toEqual(['2026-11-02T14:30:00.000Z'])
  })

  it('keeps a half-day session in one block', () => {
    // 2025-11-28 closed at 13:00; Yahoo stamps the last half hour at 13:00 with zero volume.
    const blocks = aggregate([
      bar('2025-11-28T14:30:00.000Z', 277.26, 278.24, 276.02, 276.26, 4000),
      bar('2025-11-28T15:30:00.000Z', 276.29, 276.92, 275.99, 276.25, 1700),
      bar('2025-11-28T16:30:00.000Z', 276.25, 277.16, 275.99, 277.05, 1800),
      bar('2025-11-28T18:00:00.000Z', 277.06, 279.00, 276.90, 278.61, 0),
    ], 4, NEW_YORK)
    expect(blocks).toEqual([
      { time: '2025-11-28T14:30:00.000Z', open: 277.26, high: 279.00, low: 275.99, close: 278.61, volume: 7500 },
    ])
  })

  it('keeps every block inside one New York date over three weeks', () => {
    const days = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23',
      '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30',
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']
    const bars = [
      ...days.flatMap(day => hourly(`${day}T${day < '2026-11-01' ? '13:30' : '14:30'}:00Z`, 7)),
      bar('2026-11-06T21:00:00.000Z', 106.4, 106.4, 106.4, 106.4, 0),
    ]
    const blocks = aggregate(bars, 4, NEW_YORK)
    const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' })
    const nyClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })

    expect(blocks).toHaveLength(2 * days.length)
    expect(new Set(blocks.map(b => nyClock.format(Date.parse(b.time))))).toEqual(new Set(['09:30', '13:30']))
    for (const one of bars) {
      const home = blocks.findLast(b => Date.parse(b.time) <= Date.parse(one.time))!
      expect(nyDate.format(Date.parse(home.time))).toBe(nyDate.format(Date.parse(one.time)))
    }
    expect(blocks.reduce((sum, b) => sum + b.volume, 0)).toBe(bars.reduce((sum, b) => sum + b.volume, 0))
  })
})

describe('aggregate on the UTC grid', () => {
  // BTC-USD, an evening and a night either side of UTC midnight. Yahoo reports
  // zero volume on some hours that clearly traded, and ends on a live tick.
  const BTC = [
    bar('2026-11-02T22:00:00.000Z', 76706.5, 76876.1, 76647.8, 76788.5, 30),
    bar('2026-11-02T23:00:00.000Z', 76757.1, 76760.7, 76591.8, 76674.1, 0),
    bar('2026-11-03T00:00:00.000Z', 76680.8, 77123.0, 76538.8, 76997.2, 0),
    bar('2026-11-03T01:00:00.000Z', 76983.1, 77184.2, 76922.1, 76985.5, 0),
    bar('2026-11-03T02:00:00.000Z', 76982.7, 77005.6, 76576.4, 76585.6, 0),
    bar('2026-11-03T03:00:00.000Z', 76585.5, 76852.3, 76430.7, 76799.5, 1200),
    bar('2026-11-03T04:00:00.000Z', 76787.8, 77009.1, 76630.9, 76821.7, 100),
    bar('2026-11-03T05:00:00.000Z', 76814.5, 76819.9, 76441.0, 76515.9, 50),
    bar('2026-11-03T05:22:56.000Z', 76725.1, 76725.1, 76725.1, 76725.1, 0),
  ]

  it('anchors blocks at 00/04/08/12/16/20 UTC and times them at the block start', () => {
    expect(aggregate(BTC, 4, UTC_GRID)).toEqual([
      // Opens at 22:00 but is the 20:00 block, and stops at midnight.
      { time: '2026-11-02T20:00:00.000Z', open: 76706.5, high: 76876.1, low: 76591.8, close: 76674.1, volume: 30 },
      // A zero-volume bar that moved still opens its block.
      { time: '2026-11-03T00:00:00.000Z', open: 76680.8, high: 77184.2, low: 76430.7, close: 76799.5, volume: 1200 },
      // The live tick moves the forming block's close.
      { time: '2026-11-03T04:00:00.000Z', open: 76787.8, high: 77009.1, low: 76441.0, close: 76725.1, volume: 150 },
    ])
  })
})

describe('foldEchoes on an hourly series', () => {
  it('folds the closing tick into the 15:30 bar instead of showing a 16:00 bar', () => {
    const bars = foldEchoes([...NOV_2, NOV_2_CLOSE], HOUR)
    expect(bars.map(b => b.time)).toEqual(NOV_2.map(b => b.time))
    expect(bars.at(-1)).toEqual({ ...NOV_2.at(-1)!, close: 338.32 })
  })

  it('folds the live tick into the forming bar', () => {
    const bars = foldEchoes([
      bar('2026-11-03T09:00:00.000Z', 76469.7, 76749.3, 76469.7, 76677.3, 400),
      bar('2026-11-03T09:22:56.000Z', 76780.0, 76780.0, 76780.0, 76780.0, 0),
    ], HOUR)
    expect(bars).toEqual([bar('2026-11-03T09:00:00.000Z', 76469.7, 76780.0, 76469.7, 76780.0, 400)])
  })

  it('drops a placeholder that would stand as a bar of its own', () => {
    const quiet = bar('2026-01-01T00:00:00.000Z', 1.17495, 1.17495, 1.17495, 1.17495, 0)
    const moved = bar('2026-01-01T22:00:00.000Z', 1.17481, 1.17578, 1.17426, 1.17536, 0)
    expect(foldEchoes([quiet, moved], HOUR)).toEqual([moved])
  })

  it('leaves a zero-volume bar that moved alone', () => {
    const bars = [bar('2026-11-03T00:00:00.000Z', 76680.8, 77123.0, 76538.8, 76997.2, 0)]
    expect(foldEchoes(bars, HOUR)).toEqual(bars)
  })
})

describe('sessionOf', () => {
  const period = (start: string, end: string): YahooMeta['currentTradingPeriod'] =>
    ({ regular: { start: Date.parse(start) / 1000, end: Date.parse(end) / 1000 } })

  it('anchors a US listing at the 09:30 New York open', () => {
    const meta = { exchangeTimezoneName: 'America/New_York', currentTradingPeriod: period('2026-11-03T14:30:00Z', '2026-11-03T21:00:00Z') }
    expect(sessionOf(meta, 'AAPL')).toEqual(NEW_YORK)
  })

  it('reads the open in the exchange zone, so summer time gives the same anchor', () => {
    const meta = { exchangeTimezoneName: 'America/New_York', currentTradingPeriod: period('2026-07-15T13:30:00Z', '2026-07-15T20:00:00Z') }
    expect(sessionOf(meta, 'SPY')).toEqual(NEW_YORK)
  })

  it('anchors another exchange at its own open', () => {
    const meta = { exchangeTimezoneName: 'Asia/Hong_Kong', currentTradingPeriod: period('2026-11-03T01:30:00Z', '2026-11-03T08:10:00Z') }
    expect(sessionOf(meta, '0700.HK')).toEqual({ timeZone: 'Asia/Hong_Kong', openMinute: 9 * 60 + 30 })
  })

  it.each([
    ['BTC-USD', 'UTC', '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z'],
    ['EURUSD=X', 'Europe/London', '2026-11-03T00:00:00Z', '2026-11-03T23:59:00Z'],
    ['GC=F', 'America/New_York', '2026-11-03T05:00:00Z', '2026-11-04T04:59:00Z'],
  ])('puts %s, which trades round the clock, on the UTC grid', (symbol, zone, start, end) => {
    expect(sessionOf({ exchangeTimezoneName: zone, currentTradingPeriod: period(start, end) }, symbol)).toEqual(UTC_GRID)
  })

  it('fails loud when Yahoo omits the trading period', () => {
    expect(() => sessionOf({ exchangeTimezoneName: 'America/New_York' }, 'AAPL')).toThrow(/no trading period for 'AAPL'/)
    expect(() => sessionOf(undefined, 'AAPL')).toThrow(/no trading period/)
  })
})

describe('the provider at 4h', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Answer every request with one Yahoo chart body. */
  function serve(meta: YahooMeta, bars: Candle[]): ReturnType<typeof vi.fn> {
    const body = {
      chart: {
        result: [{
          meta,
          timestamp: bars.map(b => Date.parse(b.time) / 1000),
          indicators: {
            quote: [{
              open: bars.map(b => b.open),
              high: bars.map(b => b.high),
              low: bars.map(b => b.low),
              close: bars.map(b => b.close),
              volume: bars.map(b => b.volume),
            }],
          },
        }],
        error: null,
      },
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body)))
    vi.stubGlobal('fetch', fetch)
    return fetch
  }

  function mount(): MarketDataProvider {
    const registered: MarketDataProvider[] = []
    const ctx = {
      effect: (run: () => () => void) => void run(),
      marketData: {
        register: (provider: MarketDataProvider) => {
          registered.push(provider)
          return () => {}
        },
      },
    }
    apply(ctx, { id: 'public', baseURL: 'https://yahoo.test', cacheMs: 20_000, dailyCacheMs: 300_000 })
    return registered[0]!
  }

  it('cuts a US equity at each New York session, from Yahoo 60m bars', async () => {
    const fetch = serve(
      { symbol: 'AAPL', exchangeTimezoneName: 'America/New_York', currentTradingPeriod: { regular: { start: 1793716200, end: 1793739600 } } },
      [...FRIDAY, ...MONDAY, bar('2026-10-26T20:00:00.000Z', 344.75, 344.75, 344.75, 344.75, 0)],
    )
    const candles = await mount().getOhlcv({ symbol: 'aapl', timeframe: '4h' })
    expect(String(fetch.mock.calls[0]![0])).toContain('interval=60m')
    expect(candles.map(c => c.time)).toEqual([
      '2026-10-23T13:30:00.000Z',
      '2026-10-23T17:30:00.000Z',
      '2026-10-26T13:30:00.000Z',
      '2026-10-26T17:30:00.000Z',
    ])
    expect(candles[1]!.low).toBe(344.90)
    expect(candles[3]!.close).toBe(344.75)
  })

  it('puts a crypto pair on the UTC grid', async () => {
    serve(
      { symbol: 'BTC-USD', exchangeTimezoneName: 'UTC', currentTradingPeriod: { regular: { start: 1793664000, end: 1793750340 } } },
      [...hourly('2026-11-02T22:00:00Z', 7)],
    )
    const candles = await mount().getOhlcv({ symbol: 'BTC', timeframe: '4h' })
    expect(candles.map(c => c.time)).toEqual(['2026-11-02T20:00:00.000Z', '2026-11-03T00:00:00.000Z', '2026-11-03T04:00:00.000Z'])
  })

  it('serves 1h without the closing tick as a bar of its own', async () => {
    serve({ symbol: 'AAPL' }, [...NOV_2, NOV_2_CLOSE])
    const candles = await mount().getOhlcv({ symbol: 'AAPL', timeframe: '1h' })
    expect(candles).toHaveLength(7)
    expect(candles.at(-1)).toMatchObject({ time: '2026-11-02T20:30:00.000Z', close: 338.32 })
  })

  it('refuses 4h when Yahoo drops the trading period', async () => {
    serve({ symbol: 'AAPL' }, FRIDAY)
    await expect(mount().getOhlcv({ symbol: 'AAPL', timeframe: '4h' })).rejects.toThrow(/no trading period/)
  })
})
