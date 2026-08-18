/**
 * Pure cross-instrument comparison math. Same contract as the indicator
 * modules: dependency-free, deterministic, inputs never mutated, and every
 * reported number is rounded ONCE here, producer-side, so the model, the
 * render, and any card all read identical values.
 *
 * Everything is computed over BARS THE SYMBOLS SHARE: candles are aligned on
 * the intersection of bar-open instants first, because comparing returns
 * across mismatched calendars (one symbol trades a holiday the other skips)
 * silently shifts every pairwise statistic. Alignment is reported, never
 * silent — dropped bars are counted per symbol.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'

/** Round to `places`, collapsing -0 to 0 (same rule as regime.ts). */
const round = (v: number, places = 2): number => {
  const rounded = Number(v.toFixed(places))
  return rounded === 0 ? 0 : rounded
}

/** One symbol's candles trimmed to the shared bar-open instants. */
export type AlignedSeries = {
  symbol: string
  /** Closes on the shared instants, ascending. */
  closes: number[]
  /** Bars this symbol had that the intersection dropped. */
  dropped: number
}

export type Alignment = {
  /** Shared bar-open times, ascending, spelled as the FIRST symbol serves them. */
  times: string[]
  series: AlignedSeries[]
}

/**
 * Intersect candle sets on bar-open instants (epoch ms, so `Z` vs `+00:00`
 * spellings of the same instant still align). Preserves input order of
 * `bySymbol`; the first entry is the benchmark by convention.
 */
export function alignCandles(bySymbol: { symbol: string; candles: Candle[] }[]): Alignment {
  if (bySymbol.length < 2) throw new Error('alignCandles needs at least two symbols')
  const keyed = bySymbol.map(({ symbol, candles }) => ({
    symbol,
    map: new Map(candles.map(c => [Date.parse(c.time), c])),
    candles,
  }))
  const shared = keyed[0]!.candles
    .map(c => Date.parse(c.time))
    .filter(ms => keyed.every(k => k.map.has(ms)))
    .sort((a, b) => a - b)
  const sharedSet = new Set(shared)
  return {
    times: shared.map(ms => keyed[0]!.map.get(ms)!.time),
    series: keyed.map(k => ({
      symbol: k.symbol,
      closes: shared.map(ms => k.map.get(ms)!.close),
      dropped: k.candles.length - sharedSet.size,
    })),
  }
}

/** Per-bar simple returns; length is closes.length - 1. Zero closes yield 0. */
export function pctReturns(closes: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i - 1] === 0 ? 0 : closes[i]! / closes[i - 1]! - 1)
  }
  return out
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length

/** Population covariance of two equal-length series. */
function covariance(a: readonly number[], b: readonly number[]): number {
  const ma = mean(a)
  const mb = mean(b)
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i]! - ma) * (b[i]! - mb)
  return sum / a.length
}

/**
 * Pearson correlation of two equal-length series, or null when either side
 * has zero variance — a flat series correlates with nothing, and 0/0 must
 * read as "undefined", never as a number an analysis could lean on.
 */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  if (a.length !== b.length) throw new Error(`pearson needs equal lengths (got ${a.length}, ${b.length})`)
  if (a.length < 2) return null
  const va = covariance(a, a)
  const vb = covariance(b, b)
  if (va === 0 || vb === 0) return null
  return covariance(a, b) / Math.sqrt(va * vb)
}

/**
 * Beta of `target` returns against `benchmark` returns (cov/var), or null
 * when the benchmark is flat.
 */
export function beta(target: readonly number[], benchmark: readonly number[]): number | null {
  if (target.length !== benchmark.length) throw new Error(`beta needs equal lengths (got ${target.length}, ${benchmark.length})`)
  if (target.length < 2) return null
  const vb = covariance(benchmark, benchmark)
  if (vb === 0) return null
  return covariance(target, benchmark) / vb
}

/** Maximum peak-to-trough decline over the closes, as a NEGATIVE percent (0 for monotonic rises). */
export function maxDrawdownPct(closes: readonly number[]): number {
  let peak = -Infinity
  let worst = 0
  for (const close of closes) {
    if (close > peak) peak = close
    else if (peak > 0) worst = Math.min(worst, (close / peak - 1) * 100)
  }
  return worst
}

/** One symbol's row in the comparison table. All values reporting-rounded. */
export type ComparisonRow = {
  symbol: string
  lastClose: number
  /** Close-to-close percent change over the aligned window. */
  totalReturnPct: number
  /** Deepest peak-to-trough decline inside the window, ≤ 0. */
  maxDrawdownPct: number
  /**
   * Standard deviation of per-bar returns, in percent PER BAR — deliberately
   * not annualized, which would smuggle in a bars-per-year assumption the
   * data does not state.
   */
  perBarVolPct: number
  /** Beta vs the first (benchmark) symbol; null when the benchmark is flat. 1 for the benchmark itself. */
  betaVsBenchmark: number | null
  /** Bars this symbol had that alignment dropped. */
  droppedBars: number
}

export type Comparison = {
  /** Aligned bar count all statistics are computed over. */
  bars: number
  firstTime: string
  lastTime: string
  rows: ComparisonRow[]
  /**
   * Pearson correlation of per-bar returns, rows/cols in `rows` order.
   * Diagonal is 1; null marks a flat series (undefined, not zero).
   */
  correlation: (number | null)[][]
}

/**
 * Fewer aligned bars than this and the pairwise statistics are noise wearing
 * a number's clothes; the tool refuses rather than reporting them.
 */
export const MIN_ALIGNED_BARS = 20

/** Compute the full comparison over pre-fetched candles. */
export function compareSymbols(bySymbol: { symbol: string; candles: Candle[] }[]): Comparison {
  const { times, series } = alignCandles(bySymbol)
  if (times.length < MIN_ALIGNED_BARS) {
    const detail = series.map(s => `${s.symbol}: ${s.closes.length + s.dropped} bars`).join(', ')
    throw new Error(
      `only ${times.length} bars are shared by all symbols (minimum ${MIN_ALIGNED_BARS} for meaningful statistics; ${detail}). `
      + 'Use a timeframe and range the symbols genuinely share, or fetch more history.',
    )
  }
  const returns = series.map(s => pctReturns(s.closes))
  const benchmark = returns[0]!
  const rows: ComparisonRow[] = series.map((s, i) => {
    const first = s.closes[0]!
    const last = s.closes[s.closes.length - 1]!
    const b = i === 0 ? 1 : beta(returns[i]!, benchmark)
    return {
      symbol: s.symbol,
      lastClose: round(last, 4),
      totalReturnPct: round(first === 0 ? 0 : (last / first - 1) * 100),
      maxDrawdownPct: round(maxDrawdownPct(s.closes)),
      perBarVolPct: round(Math.sqrt(covariance(returns[i]!, returns[i]!)) * 100),
      betaVsBenchmark: b === null ? null : round(b),
      droppedBars: s.dropped,
    }
  })
  const correlation = returns.map((a, i) => returns.map((b2, j) => {
    if (i === j) return 1
    const r = pearson(a, b2)
    return r === null ? null : round(r)
  }))
  return {
    bars: times.length,
    firstTime: times[0]!,
    lastTime: times[times.length - 1]!,
    rows,
    correlation,
  }
}

/** Render the comparison as the compact text block the model reads. */
export function renderComparison(timeframe: string, c: Comparison): string {
  const fmt = (v: number | null): string => v === null ? '–' : String(v)
  const header = ['symbol', 'last close', 'total return', 'max drawdown', 'per-bar vol', 'beta vs ' + c.rows[0]!.symbol]
  const table = c.rows.map(r => [
    r.symbol,
    String(r.lastClose),
    `${r.totalReturnPct > 0 ? '+' : ''}${r.totalReturnPct}%`,
    `${r.maxDrawdownPct}%`,
    `${r.perBarVolPct}%`,
    fmt(r.betaVsBenchmark),
  ])
  const widths = header.map((h, col) => Math.max(h.length, ...table.map(row => row[col]!.length)))
  const line = (cells: string[]): string => '  ' + cells.map((cell, col) => cell.padEnd(widths[col]!)).join('  ').trimEnd()
  const names = c.rows.map(r => r.symbol)
  const nameW = Math.max(...names.map(n => n.length), 5)
  const corrLines = [
    '  ' + ' '.repeat(nameW) + '  ' + names.map(n => n.padStart(nameW)).join('  '),
    ...c.correlation.map((row, i) =>
      '  ' + names[i]!.padEnd(nameW) + '  ' + row.map(v => fmt(v).padStart(nameW)).join('  ')),
  ]
  const dropped = c.rows.filter(r => r.droppedBars > 0).map(r => `${r.symbol} ${r.droppedBars}`).join(', ')
  return [
    `[${timeframe}] ${c.bars} aligned bars, ${c.firstTime} … ${c.lastTime}`
      + (dropped ? ` (bars dropped by alignment: ${dropped})` : ''),
    line(header),
    ...table.map(line),
    '  correlation of per-bar returns (– = flat series, undefined):',
    ...corrLines,
    '  per-bar vol is NOT annualized; beta and correlation are over the aligned window only.',
  ].join('\n')
}
