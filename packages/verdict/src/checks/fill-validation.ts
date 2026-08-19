/**
 * Validate reported fills against the real candle window — the same
 * philosophy as annotate_chart's trust gate, applied to trades: a price the
 * bar never printed is a fill that never happened.
 * @module @dsh-trading/verdict
 */

import type { Candle } from '@dsh-trading/market-data'
import type { ArtifactTrade } from '../artifact.js'

export interface FillIssue {
  tradeIndex: number
  kind: 'entry-outside-data' | 'exit-outside-data' | 'impossible-entry-fill' | 'impossible-exit-fill'
  detail: string
}

export interface FillValidationResult {
  issues: FillIssue[]
  /** Trades whose entry fill equals the entry bar's close (rel. 1e-9). */
  closeFillCount: number
  /** Trades entering and exiting inside the same bar. */
  sameBarCount: number
  tradesChecked: number
  /** Trades skipped because their times precede/follow the candle window. */
  tradesOutsideData: number
}

/** Relative tolerance for price comparisons. */
const REL_EPS = 1e-9

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= REL_EPS * Math.max(Math.abs(a), Math.abs(b), 1)
}

function withinBar(price: number, bar: Candle, tolerancePct: number): boolean {
  const slack = Math.max(REL_EPS, tolerancePct / 100)
  const lo = bar.low * (1 - slack)
  const hi = bar.high * (1 + slack)
  return price >= lo && price <= hi
}

/**
 * Index of the bar containing instant `t`: the last bar whose open time is
 * <= t. Returns -1 when t precedes the first bar — or, when `durationMs` is
 * given, when t falls at/after the LAST bar's close boundary (a time the
 * data simply does not cover; without the bound, fabricated far-future
 * trades would be silently validated against the final bar).
 */
export function barIndexAt(barTimes: readonly number[], t: number, durationMs?: number): number {
  let lo = 0
  let hi = barTimes.length - 1
  if (hi < 0 || t < barTimes[0]!) return -1
  if (durationMs !== undefined && t >= barTimes[hi]! + durationMs) return -1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (barTimes[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Check every trade's entry/exit price against the bar that contains its
 * entry/exit time. Bars must be ascending (provider contract).
 */
export function validateFills(
  trades: readonly ArtifactTrade[],
  bars: readonly Candle[],
  options: { durationMs?: number; priceTolerancePct?: number } = {},
): FillValidationResult {
  const barTimes = bars.map(b => Date.parse(b.time))
  const durationMs = options.durationMs
  const tolerancePct = options.priceTolerancePct ?? 0
  const issues: FillIssue[] = []
  let closeFillCount = 0
  let sameBarCount = 0
  let tradesOutsideData = 0

  trades.forEach((trade, i) => {
    const entryIdx = barIndexAt(barTimes, Date.parse(trade.entryTime), durationMs)
    const exitIdx = barIndexAt(barTimes, Date.parse(trade.exitTime), durationMs)
    if (entryIdx < 0 || entryIdx >= bars.length) {
      issues.push({ tradeIndex: i, kind: 'entry-outside-data', detail: `entryTime ${trade.entryTime} is outside the candle window` })
      tradesOutsideData += 1
      return
    }
    const entryBar = bars[entryIdx]!
    if (!withinBar(trade.entryPrice, entryBar, tolerancePct)) {
      issues.push({
        tradeIndex: i,
        kind: 'impossible-entry-fill',
        detail: `entry ${trade.entryPrice} outside bar ${entryBar.time} range [${entryBar.low}, ${entryBar.high}]`,
      })
    }
    if (exitIdx >= 0 && exitIdx < bars.length) {
      const exitBar = bars[exitIdx]!
      if (!withinBar(trade.exitPrice, exitBar, tolerancePct)) {
        issues.push({
          tradeIndex: i,
          kind: 'impossible-exit-fill',
          detail: `exit ${trade.exitPrice} outside bar ${exitBar.time} range [${exitBar.low}, ${exitBar.high}]`,
        })
      }
      if (exitIdx === entryIdx) sameBarCount += 1
    } else {
      issues.push({ tradeIndex: i, kind: 'exit-outside-data', detail: `exitTime ${trade.exitTime} outside the candle window` })
      tradesOutsideData += 1
    }
    if (approxEqual(trade.entryPrice, entryBar.close)) closeFillCount += 1
  })

  return { issues, closeFillCount, sameBarCount, tradesChecked: trades.length, tradesOutsideData }
}
