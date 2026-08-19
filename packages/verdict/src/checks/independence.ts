/**
 * Effective sample size: duplicated or overlapping same-side trades are not
 * independent observations. One lucky trade copied 800 times must not buy
 * its way past the power check or narrow the baseline distribution.
 * @module @dsh-trading/verdict
 */

import type { ArtifactTrade } from '../artifact.js'
import { barIndexAt } from './fill-validation.js'

export interface EffectiveWindow {
  trade: ArtifactTrade
  entryIdx: number
  exitIdx: number
}

export interface IndependenceResult {
  reported: number
  /** Trades that mapped onto the candle window at all. */
  mapped: number
  /** Non-overlapping same-side windows — the independent evidence count. */
  effective: number
  overlapRatio: number
  /** The kept, independent trades (audit statistics run on these). */
  kept: EffectiveWindow[]
}

/**
 * Greedy non-overlap selection per side: sort by entry index, keep a trade
 * only if it enters strictly after the previously kept same-side trade
 * exits. Exact duplicates collapse to one.
 */
export function effectiveTrades(
  trades: readonly ArtifactTrade[],
  barTimes: readonly number[],
  durationMs?: number,
): IndependenceResult {
  const mapped: EffectiveWindow[] = []
  for (const trade of trades) {
    const entryIdx = barIndexAt(barTimes, Date.parse(trade.entryTime), durationMs)
    const exitIdx = barIndexAt(barTimes, Date.parse(trade.exitTime), durationMs)
    if (entryIdx < 0 || exitIdx < 0) continue
    mapped.push({ trade, entryIdx, exitIdx })
  }
  mapped.sort((a, b) => a.entryIdx - b.entryIdx || a.exitIdx - b.exitIdx)

  const kept: EffectiveWindow[] = []
  const lastExitBySide: Record<'long' | 'short', number> = { long: -1, short: -1 }
  for (const window of mapped) {
    if (window.entryIdx > lastExitBySide[window.trade.side]) {
      kept.push(window)
      lastExitBySide[window.trade.side] = window.exitIdx
    }
  }
  return {
    reported: trades.length,
    mapped: mapped.length,
    effective: kept.length,
    overlapRatio: mapped.length === 0 ? 0 : 1 - kept.length / mapped.length,
    kept,
  }
}
