/**
 * Browser caller for the host's market-data channel, plus the adapter that
 * turns raw candles into the payload {@link ChartBody} already knows how to
 * draw. Keeping the adapter here means the panel has one rendering path
 * whether its bars came from the user's own lookup or from a tool result.
 * @module
 */

import type { ChartPayload } from './payload.js'

/**
 * Mirrors the host's `MARKET_CHANNEL`; duplicated rather than imported so the
 * browser bundle stays free of host modules. Must stay a single path segment —
 * the connection layer rejects anything else as an invalid RPC target.
 */
const CHANNEL = '/dsh-trading-market'

/** The shape of `ctx.connection.rpc` this module needs. */
export interface RpcCaller {
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: { message: string } }>
}

/** One instrument as the host reports it. */
export interface PanelInstrument {
  symbol: string
  name?: string
  assetClass?: string
  timeframes?: string[]
}

/** What the panel needs from the host; the whole surface the UI may touch. */
export interface MarketClient {
  listSymbols(signal?: AbortSignal): Promise<{ providerId: string; description: string; symbols: PanelInstrument[] }>
  getPayload(symbol: string, timeframe: string, signal?: AbortSignal): Promise<ChartPayload>
  /** The last few bars only — what a live refresh needs, without refetching the series. */
  getTail(symbol: string, timeframe: string, bars: number, signal?: AbortSignal): Promise<Candle[]>
  /**
   * Tell the host what the panel is showing, so the agent sitting beside this
   * chart can see it. Fire-and-forget: a failed publication must never disturb
   * the chart the user is actually reading.
   */
  publishView(view: {
    symbol: string
    timeframe: string
    bars: number
    from?: string | undefined
    to?: string | undefined
    close?: number | undefined
    live: boolean
    origin: 'user' | 'agent'
  }): void
}

/** One bar, as the seam defines it. */
type Candle = ChartPayload['timeframes'][number]['candles'][number]

/**
 * Fold freshly fetched tail bars into an existing series.
 *
 * Bars are keyed by open time, so a bar that is still forming REPLACES its
 * earlier self and a bar that has just opened is appended. That distinction is
 * the whole job: append blindly and a live chart grows a duplicate candle
 * every poll; replace blindly and it never gains a new one.
 *
 * @param series - the current ascending candles.
 * @param tail - freshly fetched bars, ascending.
 * @returns the merged series, ascending, or the original reference when nothing moved.
 */
export function mergeTail(series: readonly Candle[], tail: readonly Candle[]): Candle[] {
  if (tail.length === 0) return series as Candle[]
  const byTime = new Map(series.map(c => [c.time, c]))
  let changed = false
  for (const bar of tail) {
    const existing = byTime.get(bar.time)
    if (existing === undefined) {
      changed = true
    } else if (
      existing.open !== bar.open || existing.high !== bar.high
      || existing.low !== bar.low || existing.close !== bar.close || existing.volume !== bar.volume
    ) {
      changed = true
    }
    byTime.set(bar.time, bar)
  }
  if (!changed) return series as Candle[]
  return [...byTime.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
}

/**
 * Replace a payload's candle series, keeping everything else identical.
 * @param payload - the payload to refresh.
 * @param candles - the merged series.
 * @returns a new payload, or the original when the series did not move.
 */
export function withCandles(payload: ChartPayload, candles: Candle[]): ChartPayload {
  const tf = payload.timeframes[0]
  if (tf === undefined || tf.candles === candles) return payload
  return { ...payload, timeframes: [{ ...tf, candles }, ...payload.timeframes.slice(1)] }
}

/** Unwrap an RPC result, turning the error branch into a thrown Error. */
async function unwrap(promise: ReturnType<RpcCaller['call']>): Promise<unknown> {
  const result = await promise
  if (result.ok) return result.value
  throw new Error(result.error.message)
}

/**
 * Wrap raw candles as a chart payload. Indicators are `null` on purpose: these
 * bars came straight from the provider, so there is no model-computed regime
 * to show, and the card renders no indicator chips rather than inventing any.
 * @param providerId - the provider that served the bars.
 * @param symbol - the instrument.
 * @param timeframe - the bar interval.
 * @param candles - ascending candles.
 * @returns a payload ChartBody can render.
 */
export function candlesToPayload(
  providerId: string,
  symbol: string,
  timeframe: string,
  candles: ChartPayload['timeframes'][number]['candles'],
): ChartPayload {
  return {
    kind: 'chart',
    version: 1,
    provider: providerId,
    symbol,
    timeframes: [{ timeframe, candles, indicators: null, annotations: [] }],
    scenarios: [],
  }
}

/**
 * Bind a market client to a live RPC caller.
 * @param rpc - `ctx.connection.rpc`.
 * @returns the panel's data client.
 */
export function createMarketClient(rpc: RpcCaller): MarketClient {
  return {
    async listSymbols(signal) {
      const value = await unwrap(rpc.call(CHANNEL, 'symbols', {}, signal)) as {
        providerId: string
        description: string
        symbols: PanelInstrument[]
      }
      return value
    },

    async getPayload(symbol, timeframe, signal) {
      const value = await unwrap(rpc.call(CHANNEL, 'ohlcv', { symbol, timeframe }, signal)) as {
        providerId: string
        symbol: string
        timeframe: string
        candles: ChartPayload['timeframes'][number]['candles']
      }
      if (value.candles.length === 0) {
        throw new Error(`${symbol} @ ${timeframe}: the provider returned no bars for this window`)
      }
      return candlesToPayload(value.providerId, value.symbol, value.timeframe, value.candles)
    },

    publishView(view) {
      void rpc.call(CHANNEL, 'view', view).catch(() => { /* presentation only */ })
    },

    async getTail(symbol, timeframe, bars, signal) {
      const value = await unwrap(rpc.call(CHANNEL, 'ohlcv', { symbol, timeframe, limit: bars }, signal)) as {
        candles: Candle[]
      }
      return value.candles
    },
  }
}
