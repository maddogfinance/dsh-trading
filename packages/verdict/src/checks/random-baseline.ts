/**
 * Seeded Monte-Carlo baseline: how does the strategy's timing rank against
 * random-entry twins on the same bars, with the same holding periods and
 * side mix? Both sides of the comparison fill close-to-close — the artifact
 * is ranked by its SHADOW returns (close-to-close on its actual entry/exit
 * bars), never by its self-reported prices, so an optimistic intrabar fill
 * assumption cannot buy a percentile. Self-reported vs shadow is reported
 * separately as the fill-model gap.
 * @module @dsh-trading/verdict
 */

import type { Candle } from '@dsh-trading/market-data'
import type { ArtifactTrade } from '../artifact.js'
import { tradeReturn } from '../artifact.js'
import type { EffectiveWindow } from './independence.js'

export interface RandomBaselineResult {
  /** Fraction of simulations with mean return STRICTLY below the shadow mean. */
  percentile: number
  /** Close-to-close mean return of the effective trades — what the percentile ranks. */
  shadowMeanReturn: number
  /** Mean return by the artifact's own reported prices (effective trades). */
  selfReportedMeanReturn: number
  simMeanReturns: { p05: number; p50: number; p95: number }
  simulations: number
  seed: number
  /** Effective (independent) trades that entered the comparison. */
  tradesUsed: number
  note: string
}

/** mulberry32: tiny deterministic PRNG; same seed, same audit, forever. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function quantile(sorted: readonly number[], q: number): number {
  const pos = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[pos]!
}

function closeToClose(bars: readonly Candle[], entryIdx: number, exitIdx: number, side: 'long' | 'short'): number {
  const entry = bars[entryIdx]!.close
  const exit = bars[exitIdx]!.close
  return side === 'long' ? exit / entry - 1 : 1 - exit / entry
}

/**
 * Run the baseline over the EFFECTIVE (independent) trades. Simulated twins
 * fill close-to-close with holding periods and side mix resampled from those
 * same trades.
 */
export function randomBaseline(
  effective: readonly EffectiveWindow[],
  bars: readonly Candle[],
  options: { simulations?: number; seed?: number } = {},
): RandomBaselineResult {
  const simulations = options.simulations ?? 1000
  const seed = options.seed ?? 42
  const rng = mulberry32(seed)

  const templates = effective.map(w => ({
    barsHeld: Math.max(1, w.exitIdx - w.entryIdx),
    side: w.trade.side,
    entryIdx: w.entryIdx,
  }))
  const empty = (note: string): RandomBaselineResult => ({
    percentile: Number.NaN,
    shadowMeanReturn: Number.NaN,
    selfReportedMeanReturn: effective.length > 0 ? mean(effective.map(w => tradeReturn(w.trade))) : Number.NaN,
    simMeanReturns: { p05: Number.NaN, p50: Number.NaN, p95: Number.NaN },
    simulations: 0,
    seed,
    tradesUsed: effective.length,
    note,
  })
  if (templates.length === 0) return empty('no independent trades mapped onto the candle window; baseline not run')
  if (bars.length < 3) return empty('fewer than 3 bars; baseline not run')

  const shadowReturns = templates.map(t =>
    closeToClose(bars, t.entryIdx, Math.min(bars.length - 1, t.entryIdx + t.barsHeld), t.side))
  const shadowMeanReturn = mean(shadowReturns)

  const simMeans: number[] = []
  for (let s = 0; s < simulations; s++) {
    const returns: number[] = []
    for (const template of templates) {
      const maxEntry = bars.length - 1 - template.barsHeld
      if (maxEntry < 0) continue
      const entryIdx = Math.floor(rng() * (maxEntry + 1))
      returns.push(closeToClose(bars, entryIdx, entryIdx + template.barsHeld, template.side))
    }
    if (returns.length > 0) simMeans.push(mean(returns))
  }
  if (simMeans.length === 0) return empty('holding periods exceed the candle window; baseline not run')
  simMeans.sort((a, b) => a - b)

  // Strict '<': ties count AGAINST the strategy. A flat market where every
  // twin equals the strategy is indistinguishability, not victory.
  const below = simMeans.filter(m => m < shadowMeanReturn).length
  return {
    percentile: below / simMeans.length,
    shadowMeanReturn,
    selfReportedMeanReturn: mean(effective.map(w => tradeReturn(w.trade))),
    simMeanReturns: { p05: quantile(simMeans, 0.05), p50: quantile(simMeans, 0.5), p95: quantile(simMeans, 0.95) },
    simulations: simMeans.length,
    seed,
    tradesUsed: templates.length,
    note: 'both sides fill close-to-close on the same bars; self-reported prices are ranked separately as the fill-model gap',
  }
}
