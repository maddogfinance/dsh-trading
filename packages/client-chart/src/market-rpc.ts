/**
 * The host half's data channel for the chart column.
 *
 * Why this exists: the persistent chart panel must be drivable BY THE USER, not
 * only by the model. Routing the panel's own symbol lookups through a tool call
 * would make the workbench hostage to whether the agent decides to call one —
 * which, in practice, it often does not. So the panel talks to `ctx.marketData`
 * over a loopback RPC channel, and the model's `market_snapshot` /
 * `annotate_chart` results keep arriving through the tool-view seam. Two
 * independent paths onto one chart.
 *
 * The two data verbs are exactly `MarketDataProvider`'s, and nothing else. The
 * third endpoint (`view`) writes only what the panel is CURRENTLY SHOWING —
 * a symbol, a timeframe, a bar count — so the agent can stop asking the user
 * for a screenshot of a chart it is sitting right next to. None of this
 * reaches the tool layer, so risk-guard's execution gate is neither weakened
 * nor bypassed: there is no execution-shaped verb here to gate.
 * @module
 */

import type { Candle, InstrumentInfo, MarketDataProvider, Timeframe } from '@dsh-trading/market-data'

/**
 * Logical channel this package owns on the Connection transport.
 *
 * ONE path segment, by contract: the client validates channels against
 * `/^\/[A-Za-z0-9._~-]+$/`, so a namespaced `/dsh-trading/market` is rejected
 * before it ever reaches the wire. The hyphen carries the namespace instead.
 */
export const MARKET_CHANNEL = '/dsh-trading-market'

/** Channel-relative endpoints. */
export const ENDPOINTS = { symbols: 'symbols', ohlcv: 'ohlcv', view: 'view' } as const

/** Bars a single panel request may pull; a chart cannot show more than this usefully. */
export const MAX_PANEL_BARS = 1000

const TIMEFRAMES: ReadonlySet<string> = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])

/** A validated `ohlcv` request. */
export interface OhlcvRequest {
  symbol: string
  timeframe: Timeframe
  limit: number
  providerId?: string | undefined
}

/**
 * Validate an `ohlcv` payload arriving from the browser. Returns a typed
 * request or an error string — the channel must not hand unchecked strings to
 * a provider that may turn them into filesystem paths or wire codes.
 * @param payload - the decoded request body.
 * @returns the validated request, or a message naming what was wrong.
 */
export function readOhlcvRequest(payload: unknown): OhlcvRequest | string {
  if (typeof payload !== 'object' || payload === null) return 'request must be an object'
  const body = payload as Record<string, unknown>

  const symbol = body['symbol']
  if (typeof symbol !== 'string' || symbol.trim() === '') return 'symbol must be a non-empty string'
  if (symbol.length > 64) return 'symbol is implausibly long'

  const timeframe = body['timeframe']
  if (typeof timeframe !== 'string' || !TIMEFRAMES.has(timeframe)) {
    return `timeframe must be one of ${[...TIMEFRAMES].join(', ')}`
  }

  const rawLimit = body['limit']
  const limit = rawLimit === undefined
    ? MAX_PANEL_BARS
    : typeof rawLimit === 'number' && Number.isFinite(rawLimit)
      ? Math.min(MAX_PANEL_BARS, Math.max(1, Math.trunc(rawLimit)))
      : NaN
  if (Number.isNaN(limit)) return 'limit must be a number'

  const providerId = body['providerId']
  if (providerId !== undefined && typeof providerId !== 'string') return 'providerId must be a string'

  return { symbol: symbol.trim(), timeframe: timeframe as Timeframe, limit, providerId }
}

/** The panel's view of one instrument. */
export interface SymbolsResponse {
  providerId: string
  description: string
  symbols: InstrumentInfo[]
}

/** The panel's view of a candle series. */
export interface OhlcvResponse {
  providerId: string
  symbol: string
  timeframe: string
  candles: Candle[]
}

/**
 * What the chart column is showing right now.
 *
 * Deliberately small: enough for the agent to know a chart exists and what is
 * on it, not a mirror of the panel's internals. Anything the model needs in
 * detail it can fetch itself through the ordinary market tools.
 */
export interface ChartView {
  symbol: string
  timeframe: string
  bars: number
  /** ISO time of the first and last bar on screen. */
  from?: string | undefined
  to?: string | undefined
  /** Last close as displayed. */
  close?: number | undefined
  /** Whether the panel is refreshing live. */
  live: boolean
  /**
   * Who chose this chart: the user typed it, the column followed the
   * conversation to it, or it is a tool result rendered verbatim.
   */
  origin: 'user' | 'agent' | 'followed'
  /** Agent marks currently drawn on this chart. */
  marks?: number | undefined
  /** Marks the chart refused because they fell outside its window. */
  marksDropped?: number | undefined
  /** Timeframe the marks were authored on. */
  marksTimeframe?: string | undefined
}

/**
 * Validate a `view` publication. The panel is trusted code, but this crosses a
 * process boundary from a browser and lands in a model's context — a malformed
 * or oversized value would become a prompt-injection surface.
 * @param payload - the decoded body.
 * @returns the validated view, or a message naming what was wrong.
 */
export function readChartView(payload: unknown): ChartView | string {
  if (typeof payload !== 'object' || payload === null) return 'view must be an object'
  const b = payload as Record<string, unknown>
  const symbol = b['symbol']
  const timeframe = b['timeframe']
  if (typeof symbol !== 'string' || symbol.trim() === '' || symbol.length > 64) return 'view.symbol invalid'
  if (typeof timeframe !== 'string' || !TIMEFRAMES.has(timeframe)) return 'view.timeframe invalid'
  const bars = typeof b['bars'] === 'number' && Number.isFinite(b['bars']) ? Math.max(0, Math.trunc(b['bars'])) : 0
  const iso = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 32 && !Number.isNaN(Date.parse(v)) ? v : undefined
  const close = typeof b['close'] === 'number' && Number.isFinite(b['close']) ? b['close'] : undefined
  const origin = b['origin'] === 'agent' ? 'agent' : b['origin'] === 'followed' ? 'followed' : 'user'
  // Counts and a known timeframe only. This boundary stays scalars-only on
  // purpose: the marks' labels and sources are model-authored text the model
  // already wrote, and echoing them back through a prompt adds nothing but a
  // round trip for injected content.
  const count = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.trunc(v))) : undefined
  const marksTimeframe = typeof b['marksTimeframe'] === 'string' && TIMEFRAMES.has(b['marksTimeframe'])
    ? b['marksTimeframe']
    : undefined
  return {
    symbol: symbol.trim(), timeframe, bars,
    from: iso(b['from']), to: iso(b['to']), close,
    live: b['live'] === true, origin,
    marks: count(b['marks']), marksDropped: count(b['marksDropped']), marksTimeframe,
  }
}

/**
 * One line describing the chart for a model's context. Empty when no chart is
 * up — the prompt layer treats empty text as no contribution, so an idle panel
 * costs nothing.
 * @param view - the current view, if any.
 * @returns the summary line, or ''.
 */
export function describeChartView(view: ChartView | undefined): string {
  if (view === undefined) return ''
  const span = view.from !== undefined && view.to !== undefined ? `, ${view.from} to ${view.to}` : ''
  const price = view.close !== undefined ? `, last ${view.close}` : ''
  const who = view.origin === 'user'
    ? 'the user opened it'
    : view.origin === 'followed'
      // Say plainly that the column chose this, or the model will assert the
      // user's intent about an instrument they never asked for.
      ? 'the column followed your analysis here — the user did not pick this symbol'
      : 'from a tool result'
  // Whether the agent's own drawings actually landed is the one thing it
  // cannot infer: annotate_chart returning successfully says nothing about
  // what the user's column decided to render.
  const drawn = view.marks !== undefined && view.marks > 0
    ? ` Your annotate_chart marks are drawn on it (${view.marks} from the ${view.marksTimeframe ?? view.timeframe} analysis`
      + `${view.marksDropped !== undefined && view.marksDropped > 0
        ? `; ${view.marksDropped} fell outside this window and are not shown` : ''}).`
    : ''
  return (
    `The user's chart panel is showing ${view.symbol} at ${view.timeframe} `
    + `(${view.bars} bars${span}${price}; ${view.live ? 'refreshing live' : 'paused'}; ${who}).${drawn} `
    + `You can see this chart — do not ask for a screenshot of it. `
    + `Call get_chart_view for the same facts on demand, or the market tools for the data behind it.`
  )
}

/** The slice of the market-data hub this channel needs (kept narrow for testing). */
export interface MarketDataLike {
  provider(id?: string): MarketDataProvider
}

/**
 * Serve one decoded endpoint against the market-data hub.
 * @param marketData - the hub (or a fake with the same two members).
 * @param endpoint - channel-relative endpoint.
 * @param payload - decoded request body.
 * @returns the endpoint's value.
 * @throws when the endpoint is unknown or the request is malformed; the caller
 *   folds this into the RPC error branch.
 */
export async function serveMarketEndpoint(
  marketData: MarketDataLike,
  endpoint: string,
  payload: unknown,
  onView?: (view: ChartView) => void,
): Promise<SymbolsResponse | OhlcvResponse | { ok: true }> {
  if (endpoint === ENDPOINTS.view) {
    const view = readChartView(payload)
    if (typeof view === 'string') throw new Error(view)
    onView?.(view)
    return { ok: true }
  }

  if (endpoint === ENDPOINTS.symbols) {
    const id = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['providerId']
      : undefined
    if (id !== undefined && typeof id !== 'string') throw new Error('providerId must be a string')
    const provider = marketData.provider(id)
    return { providerId: provider.id, description: provider.description, symbols: await provider.listSymbols() }
  }

  if (endpoint === ENDPOINTS.ohlcv) {
    const request = readOhlcvRequest(payload)
    if (typeof request === 'string') throw new Error(request)
    const provider = marketData.provider(request.providerId)
    const candles = await provider.getOhlcv({
      symbol: request.symbol,
      timeframe: request.timeframe,
      limit: request.limit,
    })
    return { providerId: provider.id, symbol: request.symbol, timeframe: request.timeframe, candles }
  }

  throw new Error(`unknown endpoint '${endpoint}'`)
}
