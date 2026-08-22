/**
 * Browser caller for the host's market-data channel, plus the adapter that
 * turns raw candles into the payload {@link ChartBody} already knows how to
 * draw. Keeping the adapter here means the panel has one rendering path
 * whether its bars came from the user's own lookup or from a tool result.
 * @module
 */

import { annotationDigest } from './payload.js'
import type { ChartAnnotation, ChartPayload, ChartScenario } from './payload.js'

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
    origin: 'user' | 'agent' | 'followed'
    marks?: number | undefined
    marksDropped?: number | undefined
    marksTimeframe?: string | undefined
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

/* ------------------------------------------------------------------ */
/* Agent marks: the drawings annotate_chart produced, lifted off its    */
/* payload so they can be overlaid on the series the USER is watching.  */
/* ------------------------------------------------------------------ */

/** Marks lifted off an agent payload, normalised and content-keyed. */
export interface ChartMarks {
  /** `provider|SYMBOL|timeframe|digest` — content identity, not object identity. */
  key: string
  provider: string
  /** Normalised for matching only: trimmed and upper-cased. */
  symbol: string
  /**
   * The symbol as the producer wrote it, trimmed. Instrument codes are
   * case-sensitive at the provider (Futu keeps the code's case and only
   * upper-cases the market prefix), so the normalised form above is a
   * comparison key and must never be handed back to a lookup.
   */
  rawSymbol: string
  timeframe: string
  annotations: ChartAnnotation[]
  scenarios: ChartScenario[]
  /** Local clock when these marks were adopted, for the pill. */
  at: string
}

/** Outcome of trying to draw marks on a series. */
export interface MergeMarksResult {
  /** The payload to render — the SAME reference when nothing was drawn. */
  payload: ChartPayload
  /** Whether the marks are about this exact chart. */
  applied: boolean
  kept: number
  dropped: number
}

/**
 * Lift the drawings off an agent payload, or null when it carries none.
 *
 * `market_snapshot` and `get_ohlcv` payloads have neither annotations nor
 * scenarios, so they can never blank existing marks — the panel's adoption
 * effect relies on that.
 *
 * @param payload - the newest payload a chat card rendered.
 * @returns normalised marks, or null when there is nothing to adopt.
 */
export function readMarks(payload: ChartPayload | null): ChartMarks | null {
  if (payload === null) return null
  const tf = payload.timeframes.find(t => (t.annotations?.length ?? 0) > 0) ?? payload.timeframes[0]
  if (tf === undefined) return null
  const annotations = [...tf.annotations ?? []]
  const scenarios = [...payload.scenarios ?? []]
  if (annotations.length === 0 && scenarios.length === 0) return null
  const rawSymbol = payload.symbol.trim()
  const symbol = rawSymbol.toUpperCase()
  return {
    key: `${payload.provider}|${symbol}|${tf.timeframe}|${annotationDigest(annotations, scenarios)}`,
    provider: payload.provider,
    symbol,
    rawSymbol,
    timeframe: tf.timeframe,
    annotations,
    scenarios,
    at: new Date().toLocaleTimeString(),
  }
}

/** Plausibility band, mirroring the producer's own validation. */
function band(role: unknown, lo: number, hi: number): { floor: number; ceil: number } {
  const wide = role === 'target' || role === 'invalidation'
  return wide ? { floor: lo * 0.5, ceil: hi * 2.0 } : { floor: lo * 0.7, ceil: hi * 1.3 }
}

function inBand(price: unknown, role: unknown, lo: number, hi: number): boolean {
  if (typeof price !== 'number' || !Number.isFinite(price)) return false
  const { floor, ceil } = band(role, lo, hi)
  return price >= floor && price <= ceil
}

/**
 * Draw an agent's marks onto the user's series — but only when they are about
 * that exact chart.
 *
 * The predicate is deliberately strict: same provider, same symbol
 * (case-insensitively), same timeframe. A price level is meaningful on any
 * timeframe in the abstract, but klinecharts scales its price axis to the
 * VISIBLE candles, so a level lifted onto a different window can sit off-pane
 * while its row in the table below still prints a price and a distance. Half a
 * drawing that disagrees with its own caption is the failure this feature
 * exists to prevent; the panel offers to switch the chart instead.
 *
 * Survivors are additionally range-gated against the user's own candles. The
 * producer validated every price against ITS window; at equal timeframe the
 * user's window is a superset, so this is defense in depth rather than a
 * second opinion — but a mark it refuses is one that would have been drawn
 * outside the plot.
 *
 * Indicators and per-bar series are never copied: they are aligned
 * index-for-index with the agent's own (shorter) window and are read
 * positionally, so importing them would shift indicator panes by hundreds of
 * bars and print numbers that look real.
 *
 * @param payload - the user's live payload.
 * @param marks - the agent's drawings.
 * @returns the payload to render plus what happened, for the UI to report.
 */
export function mergeMarks(payload: ChartPayload, marks: ChartMarks): MergeMarksResult {
  const tf = payload.timeframes[0]
  const refused: MergeMarksResult = { payload, applied: false, kept: 0, dropped: 0 }
  if (tf === undefined) return refused
  if (payload.provider !== marks.provider) return refused
  if (payload.symbol.trim().toUpperCase() !== marks.symbol) return refused
  if (tf.timeframe !== marks.timeframe) return refused

  const candles = tf.candles
  if (candles.length === 0) return { payload, applied: true, kept: 0, dropped: 0 }
  let lo = Infinity
  let hi = -Infinity
  for (const c of candles) {
    if (c.low < lo) lo = c.low
    if (c.high > hi) hi = c.high
  }
  const firstMs = Date.parse(candles[0]!.time)
  const lastMs = Date.parse(candles[candles.length - 1]!.time)
  const forwardMs = (lastMs - firstMs) * 0.1

  let dropped = 0
  const kept: ChartAnnotation[] = []
  for (const a of marks.annotations) {
    const record = a as unknown as Record<string, unknown>
    const role = record['role']
    if (a.type === 'level') {
      if (inBand(record['price'], role, lo, hi)) kept.push(a)
      else dropped += 1
    } else if (a.type === 'zone') {
      if (inBand(record['low'], role, lo, hi) && inBand(record['high'], role, lo, hi)) kept.push(a)
      else dropped += 1
    } else if (a.type === 'path') {
      const points = Array.isArray(record['points']) ? record['points'] : []
      // A path is dropped WHOLE or not at all: a truncated path is a different
      // claim than the one the agent made.
      const ok = points.length >= 2 && points.every(p => {
        if (typeof p !== 'object' || p === null) return false
        const pt = p as Record<string, unknown>
        const t = typeof pt['time'] === 'string' ? Date.parse(pt['time']) : NaN
        return inBand(pt['price'], role, lo, hi)
          && !Number.isNaN(t) && t >= firstMs && t <= lastMs + forwardMs
      })
      if (ok) kept.push(a)
      else dropped += 1
    } else {
      // The annotation array is an open envelope: an unknown type belongs to a
      // renderer this build has never heard of, and stripping it would break
      // that seam. Pass it through untouched.
      kept.push(a)
    }
  }

  const scenarios: ChartScenario[] = marks.scenarios.map(s => {
    const rec = s as unknown as Record<string, unknown>
    let next = s
    for (const field of ['triggerPrice', 'invalidationPrice'] as const) {
      const price = rec[field]
      if (price !== undefined && !inBand(price, field === 'triggerPrice' ? 'target' : 'invalidation', lo, hi)) {
        // Keep the prose, lose only the price it cannot justify.
        const { [field]: _drop, ...rest } = next as Record<string, unknown>
        next = rest as unknown as ChartScenario
        dropped += 1
      }
    }
    return next
  })

  if (kept.length === 0 && scenarios.length === 0) {
    return { payload, applied: true, kept: 0, dropped }
  }
  // Scenarios draw trigger/invalidation lines of their own, so they count as
  // marks; reporting only annotations makes a scenario-only analysis claim
  // "0 marks" while its lines sit on the canvas.
  const drawn = kept.length + scenarios.length

  return {
    payload: {
      ...payload,
      timeframes: [{ ...tf, annotations: kept }, ...payload.timeframes.slice(1)],
      ...scenarios.length > 0 ? { scenarios } : {},
    },
    applied: true,
    kept: drawn,
    dropped,
  }
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

/** Where a tab remembers the marks it was last showing. */
const MARKS_KEY = 'dsh-trading:chart-marks'

/**
 * Remember the agent's marks for this tab.
 *
 * `latest` holds one payload and only a card that RENDERS publishes it, so
 * after a reload the marks depend on which cards the conversation happened to
 * have in view — an annotated chart drawn twenty messages ago is virtualised
 * away and its drawing silently does not come back. Session storage is the
 * right scope: per tab, and gone when the tab closes, so nothing resurfaces a
 * day later claiming to be current.
 *
 * Failures are swallowed. Storage can be full or blocked by policy, and a
 * chart that draws without its marks is a far better outcome than one that
 * does not draw at all.
 *
 * @param marks - the marks to remember, or null to forget them.
 */
export function rememberMarks(marks: ChartMarks | null): void {
  try {
    if (marks === null) sessionStorage.removeItem(MARKS_KEY)
    else sessionStorage.setItem(MARKS_KEY, JSON.stringify(marks))
  } catch { /* storage is a convenience, never a requirement */ }
}

/**
 * Read back the marks this tab was last showing.
 * @returns the remembered marks, or null when there are none or they are unreadable.
 */
export function recallMarks(): ChartMarks | null {
  try {
    const raw = sessionStorage.getItem(MARKS_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as ChartMarks
    // Validate the shape rather than trusting storage: this feeds the merge
    // predicate and, through it, what gets drawn on a chart.
    if (typeof parsed?.key !== 'string' || typeof parsed?.symbol !== 'string') return null
    if (typeof parsed.rawSymbol !== 'string' || typeof parsed.timeframe !== 'string') return null
    if (!Array.isArray(parsed.annotations) || !Array.isArray(parsed.scenarios)) return null
    return parsed
  } catch {
    return null
  }
}
