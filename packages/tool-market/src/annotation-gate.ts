/**
 * The annotate_chart trust gate, extracted as a pure module so the rules can
 * be unit-tested and audited on their own — the same reasoning risk-guard's
 * policy.ts states: a safety rule nobody can read in isolation is a safety
 * rule nobody checks. No IO, no cordis: callers derive a {@link GateWindow}
 * from the candles they fetched and pass the raw tool arguments through
 * {@link gateAnnotations}; everything model-authored is validated against the
 * real window or refused with a model-facing reason. Third-party authoring
 * tools are welcome to reuse this gate — CONTRACTS.md asks them to hold the
 * same line, and this module IS that line.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'
import type { AnnotationRole, ChartAnnotation, ChartScenario } from './chart-payload.js'

export const ANNOTATION_ROLES = ['support', 'resistance', 'neckline', 'target', 'invalidation', 'other'] as const

// Structural caps: a card is a readable analysis surface, not a dump.
export const MAX_ANNOTATIONS = 24
export const MAX_SCENARIOS = 6
export const MAX_SOURCES = 6
export const MAX_PATH_POINTS = 12

/** Strip control characters and cap length: model-authored text lands in a
 * durable log and is rendered by arbitrary ecosystem renderers. */
export const clean = (s: string, cap: number): string =>
  s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)

/** The real candle window every model-authored price is validated against. */
export type GateWindow = {
  symbol: string
  timeframe: string
  /** Lowest low / highest high over the fetched bars. */
  lo: number
  hi: number
  lastClose: number
  /** Bar-open times of the first and last fetched bar, verbatim and as epoch ms. */
  firstTime: string
  lastTime: string
  firstMs: number
  lastMs: number
  bars: number
}

/** Derive the validation window from the candles the caller just fetched. */
export function gateWindow(candles: readonly Candle[], symbol: string, timeframe: string): GateWindow {
  if (candles.length === 0) throw new Error(`no candles for ${symbol} @ ${timeframe}`)
  const first = candles[0]!
  const latest = candles[candles.length - 1]!
  return {
    symbol,
    timeframe,
    lo: Math.min(...candles.map(c => c.low)),
    hi: Math.max(...candles.map(c => c.high)),
    lastClose: latest.close,
    firstTime: first.time,
    lastTime: latest.time,
    firstMs: Date.parse(first.time),
    lastMs: Date.parse(latest.time),
    bars: candles.length,
  }
}

/** The raw argument shapes annotate_chart accepts, pre-validation. */
export type RawLevel = { price: number; label: string; role?: string; sources: string[]; confidence?: number }
export type RawZone = { low: number; high: number; label: string; role?: string; sources: string[]; confidence?: number }
export type RawPath = { points: { time: string; price: number }[]; label: string; role?: string; sources: string[] }
export type RawScenario = {
  direction: string
  stance: string
  thesis: string
  trigger: string
  invalidation: string
  triggerPrice?: number
  invalidationPrice?: number
}

export type GateInput = {
  levels?: RawLevel[] | undefined
  zones?: RawZone[] | undefined
  paths?: RawPath[] | undefined
  scenarios?: RawScenario[] | undefined
}

/**
 * Validate every model-authored annotation and scenario against the window,
 * or throw a model-facing error explaining how to earn the annotation: read
 * real data first, cite real evidence. Prices must sit inside a plausibility
 * band around the window (×0.7..×1.3 of its low..high; projection
 * roles `target`/`invalidation` get ×0.5..×2.0), path times inside
 * the window (+10% forward projection), zones must have real width, and every
 * core annotation must cite at least one source.
 */
export function gateAnnotations(input: GateInput, w: GateWindow): {
  annotations: ChartAnnotation[]
  scenarios: ChartScenario[]
} {
  const forwardMs = Math.max(0, (w.lastMs - w.firstMs) * 0.1)
  const range = `actual ${w.timeframe} window is low ${w.lo} … high ${w.hi} over the last ${w.bars} bars`
  const checkPrice = (price: number, what: string, role: AnnotationRole): void => {
    // Projection roles get a wider band: 1.618/2.618 extensions legitimately
    // clear a tight window's +30%.
    const wide = role === 'target' || role === 'invalidation'
    const floor = wide ? w.lo * 0.5 : w.lo * 0.7
    const ceil = wide ? w.hi * 2.0 : w.hi * 1.3
    if (!Number.isFinite(price) || price < floor || price > ceil) {
      throw new Error(`${what} ${price} is outside the plausible range for ${w.symbol} @ ${w.timeframe}: ${range} (tolerance ×${wide ? '0.5..×2.0' : '0.7..×1.3'}). Anchor on prices you actually read — call market_snapshot or get_ohlcv first and cite real swing points.`)
    }
  }
  const checkConfidence = (confidence: number | undefined, what: string): void => {
    if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
      throw new Error(`${what} confidence must be within 0..1`)
    }
  }
  const checkSources = (sources: string[], what: string): string[] => {
    const cleaned = sources.map(s => clean(s, 120)).filter(s => s !== '').slice(0, MAX_SOURCES)
    if (cleaned.length === 0) {
      throw new Error(`${what} has no sources. Every annotation must cite its evidence (e.g. "prior swing high", "Fibonacci 0.618", "round number"). Unsourced annotations are refused.`)
    }
    return cleaned
  }

  const annotations: ChartAnnotation[] = []
  for (const level of input.levels ?? []) {
    const role = (level.role ?? 'other') as AnnotationRole
    const label = clean(level.label, 120)
    checkPrice(level.price, `level '${label}' at`, role)
    checkConfidence(level.confidence, `level '${label}'`)
    annotations.push({
      type: 'level', price: level.price, label, role,
      sources: checkSources(level.sources, `level '${label}'`),
      ...level.confidence !== undefined ? { confidence: level.confidence } : {},
    })
  }
  for (const zone of input.zones ?? []) {
    const role = (zone.role ?? 'other') as AnnotationRole
    const label = clean(zone.label, 120)
    if (!Number.isFinite(zone.low) || !Number.isFinite(zone.high) || zone.low >= zone.high) {
      throw new Error(`zone '${label}': low must be a finite number below high`)
    }
    if (zone.high - zone.low < w.lastClose * 0.0005) {
      throw new Error(`zone '${label}' is thinner than 0.05% of price — use a level for a single price`)
    }
    checkPrice(zone.low, `zone '${label}' low`, role)
    checkPrice(zone.high, `zone '${label}' high`, role)
    checkConfidence(zone.confidence, `zone '${label}'`)
    annotations.push({
      type: 'zone', low: zone.low, high: zone.high, label, role,
      sources: checkSources(zone.sources, `zone '${label}'`),
      ...zone.confidence !== undefined ? { confidence: zone.confidence } : {},
    })
  }
  for (const path of input.paths ?? []) {
    const role = (path.role ?? 'other') as AnnotationRole
    const label = clean(path.label, 120)
    const points = path.points ?? []
    if (points.length < 2 || points.length > MAX_PATH_POINTS) {
      throw new Error(`path '${label}' needs 2..${MAX_PATH_POINTS} points`)
    }
    const mapped = points.map((p) => {
      const t = Date.parse(p.time)
      if (!Number.isFinite(t) || t < w.firstMs || t > w.lastMs + forwardMs) {
        throw new Error(`path '${label}' point time ${p.time} is outside the drawn window ${w.firstTime} … ${w.lastTime} (small forward projection allowed). Use bar-open times you actually read.`)
      }
      checkPrice(p.price, `path '${label}' point at`, role)
      return { time: p.time, price: p.price }
    })
    annotations.push({
      type: 'path', points: mapped, label, role,
      sources: checkSources(path.sources, `path '${label}'`),
    })
  }
  if (annotations.length > MAX_ANNOTATIONS) {
    throw new Error(`too many annotations (${annotations.length} > ${MAX_ANNOTATIONS}): a readable analysis names its few decisive structures`)
  }
  const rawScenarios = input.scenarios ?? []
  if (rawScenarios.length > MAX_SCENARIOS) throw new Error(`too many scenarios (max ${MAX_SCENARIOS})`)
  const scenarios: ChartScenario[] = rawScenarios.map((s) => {
    if (s.triggerPrice !== undefined) checkPrice(s.triggerPrice, 'scenario triggerPrice', 'target')
    if (s.invalidationPrice !== undefined) checkPrice(s.invalidationPrice, 'scenario invalidationPrice', 'invalidation')
    return {
      direction: s.direction as 'bull' | 'bear',
      stance: s.stance as 'base' | 'alternative',
      thesis: clean(s.thesis, 300),
      trigger: clean(s.trigger, 300),
      invalidation: clean(s.invalidation, 300),
      ...s.triggerPrice !== undefined ? { triggerPrice: s.triggerPrice } : {},
      ...s.invalidationPrice !== undefined ? { invalidationPrice: s.invalidationPrice } : {},
    }
  })
  if (annotations.length === 0 && scenarios.length === 0) {
    throw new Error('nothing to annotate: pass at least one level, zone, path, or scenario')
  }
  return { annotations, scenarios }
}
