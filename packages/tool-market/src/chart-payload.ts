/**
 * The chart payload that rides the durable `tool/result` event's `meta` field
 * via `output.presentationMeta`. Model-invisible by construction — dsh projects
 * only the rendered content into model context — so a chart card can carry the
 * full drawable candle tail without costing a single token, and it survives
 * session-log replay (the canonical tool value does not).
 *
 * Everything here is a type ALIAS, not an interface: interfaces get no implicit
 * index signature, so they are not assignable to dsh's JsonValue (the same trap
 * RegimeSnapshot documents).
 */
import type { Candle, Timeframe } from '@dsh-trading/market-data'
import { adx, bollinger, macd, mfi, stochastic } from './candle-indicators.js'
import { rsi } from './indicators.js'
import type { RegimeSnapshot } from './regime.js'

/**
 * Bars a chart card draws. render_chart documents ~400 as unreadably dense;
 * 200 keeps the durable event around 25 KB per timeframe.
 */
export const CHART_META_BARS = 200

/** JsonValue-safe mirror of market-data's `Candle` interface. */
export type ChartCandle = {
  time: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Per-bar indicator columns the call actually computed (e.g. 'sma20', 'rsi14'),
 * aligned index-for-index with `candles`; unseeded leading positions are null.
 */
export type ChartSeries = Record<string, (number | null)[]>

/** What a level or zone means on the chart; renderers color by role. */
export type AnnotationRole = 'support' | 'resistance' | 'neckline' | 'target' | 'invalidation' | 'other'

/**
 * A horizontal price level with mandatory provenance. `sources` is the
 * human-readable evidence trail ("Fibonacci 0.77 retracement", "daily S1
 * pivot") — a level with no stated source is not analysis, it is a guess,
 * and annotate_chart refuses it.
 */
export type ChartLevelAnnotation = {
  type: 'level'
  price: number
  label: string
  role: AnnotationRole
  sources: string[]
  /** 0..1; omit rather than invent. */
  confidence?: number
}

/** A horizontal price band (supply/demand zone, confluence area). */
export type ChartZoneAnnotation = {
  type: 'zone'
  low: number
  high: number
  label: string
  role: AnnotationRole
  sources: string[]
  /** 0..1; omit rather than invent. */
  confidence?: number
}

/**
 * A time-anchored point sequence: pattern necklines, measured moves, ABCD
 * harmonics, wave counts. Times must fall inside the drawn candle window.
 */
export type ChartPathAnnotation = {
  type: 'path'
  points: { time: string; price: number }[]
  label: string
  role: AnnotationRole
  sources: string[]
}

/**
 * The core vocabulary. The annotation ARRAY is an open envelope: ecosystem
 * plugins may emit further `type` values with their own fields; readers must
 * pass unknown types through UNMODIFIED to the renderer registry or fall back
 * to a textual listing — never crash on them, never strip their fields.
 */
export type ChartAnnotation = ChartLevelAnnotation | ChartZoneAnnotation | ChartPathAnnotation

/**
 * A conditional research scenario: a thesis plus the observable that would
 * confirm it and the observable that would kill it. Deliberately NOT a trade
 * recommendation — no entries, sizes, stops, or numeric probabilities exist in
 * this vocabulary. `stance` says which reading the analysis treats as primary;
 * it is a label, not a forecast weight.
 */
export type ChartScenario = {
  direction: 'bull' | 'bear'
  stance: 'base' | 'alternative'
  thesis: string
  trigger: string
  invalidation: string
  /** Optional price the trigger/invalidation observably crosses; range-gated like levels. */
  triggerPrice?: number
  invalidationPrice?: number
}

export type ChartTimeframeData = {
  timeframe: Timeframe
  /** Trimmed drawable tail, ascending. */
  candles: ChartCandle[]
  /**
   * The RegimeSnapshot verbatim, so the card's indicator readout always matches
   * the numbers the model read. Null when the call computed no snapshot.
   */
  indicators: RegimeSnapshot | null
  series?: ChartSeries
  /** Present on annotate_chart results; validated against the real candle range. */
  annotations?: ChartAnnotation[]
}

export type ChartPayload = {
  /** Discriminant against other tools' meta shapes. */
  kind: 'chart'
  /** Card forward-compatibility. */
  version: 1
  provider: string
  symbol: string
  timeframes: ChartTimeframeData[]
  /** Present on annotate_chart results. */
  scenarios?: ChartScenario[]
}

/**
 * Trim candles to the drawable tail as JsonValue-safe literals. Returns null if
 * the tail contains a non-finite number: NaN anywhere in the tool value fails
 * the whole call as INVALID_TOOL_OUTPUT, and silently dropping bars would
 * misalign any indicator series — no chart beats a wrong chart.
 */
export function chartCandles(candles: Candle[], cap: number = CHART_META_BARS): ChartCandle[] | null {
  const tail = candles.slice(-cap)
  for (const c of tail) {
    if (!Number.isFinite(c.open) || !Number.isFinite(c.high) || !Number.isFinite(c.low)
      || !Number.isFinite(c.close) || !Number.isFinite(c.volume)) return null
  }
  return tail.map(c => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
}

/** Slice indicator columns to the same tail `chartCandles` kept. */
export function chartSeries(series: ChartSeries, cap: number = CHART_META_BARS): ChartSeries {
  const out: ChartSeries = {}
  for (const [name, values] of Object.entries(series)) out[name] = values.slice(-cap)
  return out
}

function roundSeries(values: (number | null)[], digits: number): (number | null)[] {
  const f = 10 ** digits
  return values.map(v => v === null || !Number.isFinite(v) ? null : Math.round(v * f) / f)
}

/**
 * Full-length per-bar series for the regime indicators, rounded with the same
 * precision RegimeSnapshot reports — so a pane the card draws from these shows
 * EXACTLY the numbers the model read, not a front-end re-computation that
 * could disagree. Callers trim with `chartSeries` to stay aligned with the
 * candle tail.
 */
export function regimeSeries(candles: readonly Candle[]): ChartSeries {
  const closes = candles.map(c => c.close)
  const stoch = stochastic(candles)
  const adxR = adx(candles)
  const macdR = macd(closes)
  const bb = bollinger(closes)
  return {
    rsi14: roundSeries(rsi(closes, 14), 2),
    stoch_k: roundSeries(stoch.k, 2),
    stoch_d: roundSeries(stoch.d, 2),
    adx: roundSeries(adxR.adx, 2),
    plus_di: roundSeries(adxR.plusDi, 2),
    minus_di: roundSeries(adxR.minusDi, 2),
    macd: roundSeries(macdR.macd, 4),
    macd_signal: roundSeries(macdR.signal, 4),
    macd_hist: roundSeries(macdR.histogram, 4),
    mfi14: roundSeries(mfi(candles), 2),
    bb_upper: roundSeries(bb.upper, 4),
    bb_middle: roundSeries(bb.middle, 4),
    bb_lower: roundSeries(bb.lower, 4),
  }
}
