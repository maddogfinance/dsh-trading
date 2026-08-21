/**
 * The host channel is a trust boundary: its payloads come from a browser, and
 * the symbol string it forwards becomes a filesystem path in provider-csv and
 * a wire code in provider-futu. These cases pin that nothing unchecked gets
 * through, and that the endpoint stays read-only.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  describeChartView,
  ENDPOINTS,
  MARKET_CHANNEL,
  MAX_PANEL_BARS,
  readChartView,
  readOhlcvRequest,
  serveMarketEndpoint,
} from '../src/market-rpc.js'
import type { MarketDataLike } from '../src/market-rpc.js'

const CANDLE = { time: '2026-08-20T00:00:00.000Z', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }

function hub(overrides: Partial<{ id: string; listSymbols: unknown; getOhlcv: unknown }> = {}): {
  hub: MarketDataLike
  getOhlcv: ReturnType<typeof vi.fn>
  provider: ReturnType<typeof vi.fn>
} {
  const getOhlcv = vi.fn(async () => [CANDLE])
  const listSymbols = vi.fn(async () => [{ symbol: 'US.MU', assetClass: 'equity' }])
  const provider = vi.fn(() => ({
    id: overrides.id ?? 'futu',
    description: 'test provider',
    listSymbols,
    getOhlcv,
  }))
  return { hub: { provider } as unknown as MarketDataLike, getOhlcv, provider }
}

describe('channel identity', () => {
  it('owns a namespaced channel rather than a bare path', () => {
    expect(MARKET_CHANNEL.startsWith('/dsh-trading')).toBe(true)
  })

  it('is a single path segment, as the connection layer requires', () => {
    // The client validates channels against this exact pattern and rejects the
    // call before it reaches the wire; a nested '/a/b' channel fails at runtime
    // with 'invalid RPC target', which is not obvious from the handle() API.
    expect(MARKET_CHANNEL).toMatch(/^\/[A-Za-z0-9._~-]+$/)
  })

  it('exposes exactly the endpoints it means to', () => {
    // Two data reads plus the panel's own view publication. Anything appearing
    // here that is not one of these three deserves a second look: this channel
    // is reachable from a browser.
    expect(Object.values(ENDPOINTS).sort()).toEqual(['ohlcv', 'symbols', 'view'])
  })
})

describe('readOhlcvRequest', () => {
  it('accepts a well-formed request', () => {
    expect(readOhlcvRequest({ symbol: 'US.MU', timeframe: '1d' })).toEqual({
      symbol: 'US.MU', timeframe: '1d', limit: MAX_PANEL_BARS, providerId: undefined,
    })
  })

  it('trims the symbol', () => {
    const parsed = readOhlcvRequest({ symbol: '  US.MU  ', timeframe: '1d' })
    expect(typeof parsed === 'object' && parsed.symbol).toBe('US.MU')
  })

  it('rejects a non-object payload', () => {
    expect(readOhlcvRequest('US.MU')).toMatch(/must be an object/)
    expect(readOhlcvRequest(null)).toMatch(/must be an object/)
  })

  it('rejects an empty or non-string symbol', () => {
    expect(readOhlcvRequest({ symbol: '', timeframe: '1d' })).toMatch(/symbol/)
    expect(readOhlcvRequest({ symbol: '   ', timeframe: '1d' })).toMatch(/symbol/)
    expect(readOhlcvRequest({ symbol: 42, timeframe: '1d' })).toMatch(/symbol/)
  })

  it('rejects an implausibly long symbol rather than forwarding it', () => {
    expect(readOhlcvRequest({ symbol: 'A'.repeat(200), timeframe: '1d' })).toMatch(/implausibly long/)
  })

  it('rejects a timeframe outside the seam vocabulary', () => {
    expect(readOhlcvRequest({ symbol: 'US.MU', timeframe: '2h' })).toMatch(/timeframe must be one of/)
    expect(readOhlcvRequest({ symbol: 'US.MU', timeframe: '../../etc' })).toMatch(/timeframe must be one of/)
  })

  it('clamps limit into a sane range instead of trusting it', () => {
    const big = readOhlcvRequest({ symbol: 'US.MU', timeframe: '1d', limit: 1e9 })
    expect(typeof big === 'object' && big.limit).toBe(MAX_PANEL_BARS)
    const small = readOhlcvRequest({ symbol: 'US.MU', timeframe: '1d', limit: -5 })
    expect(typeof small === 'object' && small.limit).toBe(1)
  })

  it('rejects a non-numeric limit', () => {
    expect(readOhlcvRequest({ symbol: 'US.MU', timeframe: '1d', limit: 'all' })).toMatch(/limit/)
  })

  it('rejects a non-string providerId', () => {
    expect(readOhlcvRequest({ symbol: 'US.MU', timeframe: '1d', providerId: 7 })).toMatch(/providerId/)
  })
})

describe('serveMarketEndpoint', () => {
  it('serves the symbol list with its provider identity', async () => {
    const { hub: h } = hub()
    const res = await serveMarketEndpoint(h, ENDPOINTS.symbols, {})
    expect(res).toMatchObject({ providerId: 'futu', description: 'test provider' })
  })

  it('serves candles for a valid request', async () => {
    const { hub: h, getOhlcv } = hub()
    const res = await serveMarketEndpoint(h, ENDPOINTS.ohlcv, { symbol: 'US.MU', timeframe: '1h' })
    expect(res).toMatchObject({ providerId: 'futu', symbol: 'US.MU', timeframe: '1h' })
    expect(getOhlcv).toHaveBeenCalledWith({ symbol: 'US.MU', timeframe: '1h', limit: MAX_PANEL_BARS })
  })

  it('routes to a named provider when one is requested', async () => {
    const { hub: h, provider } = hub()
    await serveMarketEndpoint(h, ENDPOINTS.ohlcv, { symbol: 'DEMO-EQ', timeframe: '1d', providerId: 'csv' })
    expect(provider).toHaveBeenCalledWith('csv')
  })

  it('throws on a malformed request instead of calling the provider', async () => {
    const { hub: h, getOhlcv } = hub()
    await expect(serveMarketEndpoint(h, ENDPOINTS.ohlcv, { symbol: 'US.MU', timeframe: 'weekly' }))
      .rejects.toThrow(/timeframe/)
    expect(getOhlcv).not.toHaveBeenCalled()
  })

  it('refuses an unknown endpoint', async () => {
    const { hub: h } = hub()
    await expect(serveMarketEndpoint(h, 'placeOrder', {})).rejects.toThrow(/unknown endpoint/)
  })

  it('surfaces a provider failure rather than swallowing it into an empty series', async () => {
    const provider = vi.fn(() => ({
      id: 'futu',
      description: 'x',
      listSymbols: async () => [],
      getOhlcv: async () => { throw new Error('Futu OpenD is not reachable') },
    }))
    const h = { provider } as unknown as MarketDataLike
    await expect(serveMarketEndpoint(h, ENDPOINTS.ohlcv, { symbol: 'US.MU', timeframe: '1d' }))
      .rejects.toThrow(/not reachable/)
  })
})

describe('readChartView', () => {
  const VIEW = { symbol: 'CC.BTCUSDT', timeframe: '15m', bars: 1000, live: true, origin: 'user' }

  it('accepts a well-formed view', () => {
    expect(readChartView(VIEW)).toMatchObject({ symbol: 'CC.BTCUSDT', timeframe: '15m', bars: 1000, live: true })
  })

  it('rejects a bad symbol or timeframe rather than letting it into a prompt', () => {
    // This value lands in a model's context, so it is a prompt-injection
    // surface as much as a correctness one.
    expect(readChartView({ ...VIEW, symbol: '' })).toMatch(/symbol/)
    expect(readChartView({ ...VIEW, symbol: 'A'.repeat(200) })).toMatch(/symbol/)
    expect(readChartView({ ...VIEW, timeframe: 'yearly' })).toMatch(/timeframe/)
    expect(readChartView('not an object')).toMatch(/object/)
  })

  it('drops unparsable or oversized timestamps instead of trusting them', () => {
    const v = readChartView({ ...VIEW, from: 'whenever', to: 'x'.repeat(80) })
    expect(typeof v === 'object' && v.from).toBeUndefined()
    expect(typeof v === 'object' && v.to).toBeUndefined()
  })

  it('defaults origin to the user and never invents a third value', () => {
    expect((readChartView({ ...VIEW, origin: 'hacker' }) as { origin: string }).origin).toBe('user')
    expect((readChartView({ ...VIEW, origin: 'agent' }) as { origin: string }).origin).toBe('agent')
  })

  it('coerces a non-numeric bar count to zero rather than NaN', () => {
    expect((readChartView({ ...VIEW, bars: 'lots' }) as { bars: number }).bars).toBe(0)
  })
})

describe('describeChartView', () => {
  it('contributes nothing when no chart is up', () => {
    // The prompt layer treats empty text as no contribution, so an idle panel
    // must cost zero tokens.
    expect(describeChartView(undefined)).toBe('')
  })

  it('names the symbol, timeframe and provenance', () => {
    const line = describeChartView({
      symbol: 'US.MU', timeframe: '1d', bars: 500, live: true, origin: 'user',
      from: '2026-01-01T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z', close: 974.33,
    })
    expect(line).toContain('US.MU')
    expect(line).toContain('1d')
    expect(line).toContain('974.33')
    expect(line).toContain('the user opened it')
  })

  it('tells the model not to ask for a screenshot', () => {
    // The whole point of the injection: without this sentence the agent
    // repeatedly asked the user to photograph a chart it was rendering.
    const line = describeChartView({ symbol: 'US.MU', timeframe: '1d', bars: 10, live: false, origin: 'agent' })
    expect(line).toMatch(/do not ask for a screenshot/i)
    expect(line).toContain('paused')
  })
})

describe('marks reported through the view', () => {
  const VIEW = { symbol: 'US.MU', timeframe: '1d', bars: 1000, live: true, origin: 'user' }

  it('clamps the mark counts and keeps a known timeframe', () => {
    const v = readChartView({ ...VIEW, marks: 4, marksDropped: 1, marksTimeframe: '1d' })
    expect(v).toMatchObject({ marks: 4, marksDropped: 1, marksTimeframe: '1d' })
    const clamped = readChartView({ ...VIEW, marks: 1e9, marksDropped: -3 })
    expect(clamped).toMatchObject({ marks: 100, marksDropped: 0 })
  })

  it('refuses a timeframe outside the known set', () => {
    const v = readChartView({ ...VIEW, marks: 2, marksTimeframe: 'yearly' })
    expect(typeof v === 'object' && v.marksTimeframe).toBeUndefined()
  })

  it('leaves all three absent when the panel sent none', () => {
    const v = readChartView(VIEW) as Record<string, unknown>
    expect(v['marks']).toBeUndefined()
    expect(v['marksDropped']).toBeUndefined()
    expect(v['marksTimeframe']).toBeUndefined()
  })

  it('tells the model its marks are drawn, and how many were refused', () => {
    // Whether the drawing landed is the one thing the agent cannot infer:
    // annotate_chart returning successfully says nothing about what the user's
    // column decided to render.
    const line = describeChartView({
      symbol: 'US.MU', timeframe: '1d', bars: 1000, live: true, origin: 'user',
      marks: 4, marksDropped: 1, marksTimeframe: '1d',
    })
    expect(line).toMatch(/marks are drawn on it \(4 from the 1d analysis; 1 fell outside/)
  })

  it('says nothing about marks when there are none', () => {
    const line = describeChartView({ symbol: 'US.MU', timeframe: '1d', bars: 10, live: false, origin: 'user' })
    expect(line).not.toMatch(/marks/)
  })
})
