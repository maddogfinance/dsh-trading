/**
 * The backtest-artifact contract: the normalized shape `verdict` audits,
 * regardless of which engine produced it. Dependency-free on purpose, like
 * the market-data seam — an engine implements this and nothing else.
 * @module @dsh-trading/verdict
 */

import type { Timeframe } from '@dsh-trading/market-data'

/** Bar duration per timeframe, milliseconds. 1w = 7 calendar days. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
}

/** One completed round trip. Times are ISO-8601 UTC. */
export interface ArtifactTrade {
  /** Time the position was opened (any instant inside the entry bar). */
  entryTime: string
  /** Time the position was closed. */
  exitTime: string
  side: 'long' | 'short'
  entryPrice: number
  exitPrice: number
}

/** Cost assumptions the producing engine applied (or didn't). */
export interface ArtifactCosts {
  /** Whether fees/slippage are already reflected in the prices. */
  included: boolean
  /** Round-trip fee estimate, percent of notional, when known. */
  feesPct?: number
  /** Per-side slippage estimate, percent, when known. */
  slippagePct?: number
}

/**
 * A backtest result in auditable form. Version 1; within the version,
 * changes are additive only (see CONTRACTS.md conventions).
 */
export interface BacktestArtifact {
  version: 1
  /** Symbol exactly as the market-data provider reports it. */
  symbol: string
  timeframe: Timeframe
  trades: ArtifactTrade[]
  costs?: ArtifactCosts
  /** Optional provenance: what produced this artifact. */
  source?: { engine?: string; description?: string }
}

/**
 * Signed per-trade return on the ENTRY notional, fraction (0.01 = +1%),
 * before any extra costs. Shorts use (entry - exit) / entry, the standard
 * return-on-initial-capital convention.
 */
export function tradeReturn(trade: ArtifactTrade): number {
  return trade.side === 'long'
    ? trade.exitPrice / trade.entryPrice - 1
    : 1 - trade.exitPrice / trade.entryPrice
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function isIsoInstant(x: unknown): x is string {
  if (typeof x !== 'string') return false
  // Date.parse accepts naive local datetimes and implementation-specific prose.
  // Require an ISO date-time with an explicit zone so the same artifact maps to
  // the same candles on every machine. Date.parse still validates the calendar.
  const explicitZone = /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}(?::?\d{2})?)$/i
  return explicitZone.test(x) && Number.isFinite(Date.parse(x))
}

/**
 * Validate an unknown value into a {@link BacktestArtifact}. Throws with a
 * message naming the first offending field — loud beats lenient in an
 * evidence pipeline.
 */
export function parseArtifact(value: unknown): BacktestArtifact {
  if (typeof value !== 'object' || value === null) {
    throw new Error('artifact must be a JSON object')
  }
  const a = value as Record<string, unknown>
  if (a.version !== 1) throw new Error(`artifact.version must be 1 (got ${JSON.stringify(a.version)})`)
  if (typeof a.symbol !== 'string' || a.symbol.length === 0) throw new Error('artifact.symbol must be a non-empty string')
  if (typeof a.timeframe !== 'string' || !(a.timeframe in TIMEFRAME_MS)) {
    throw new Error(`artifact.timeframe must be one of ${Object.keys(TIMEFRAME_MS).join(', ')} (got ${JSON.stringify(a.timeframe)})`)
  }
  if (!Array.isArray(a.trades)) throw new Error('artifact.trades must be an array')
  if (a.trades.length === 0) throw new Error('artifact.trades is empty — nothing to audit')
  a.trades.forEach((t, i) => {
    if (typeof t !== 'object' || t === null) throw new Error(`trades[${i}] must be an object`)
    const trade = t as Record<string, unknown>
    if (!isIsoInstant(trade.entryTime)) throw new Error(`trades[${i}].entryTime must be an ISO-8601 time with an explicit timezone (Z or offset)`)
    if (!isIsoInstant(trade.exitTime)) throw new Error(`trades[${i}].exitTime must be an ISO-8601 time with an explicit timezone (Z or offset)`)
    if (Date.parse(trade.exitTime as string) < Date.parse(trade.entryTime as string)) {
      throw new Error(`trades[${i}] exits before it enters`)
    }
    if (trade.side !== 'long' && trade.side !== 'short') throw new Error(`trades[${i}].side must be 'long' or 'short'`)
    if (!isFiniteNumber(trade.entryPrice) || (trade.entryPrice as number) <= 0) throw new Error(`trades[${i}].entryPrice must be a positive finite number`)
    if (!isFiniteNumber(trade.exitPrice) || (trade.exitPrice as number) <= 0) throw new Error(`trades[${i}].exitPrice must be a positive finite number`)
  })
  if (a.costs !== undefined) {
    const c = a.costs as Record<string, unknown>
    if (typeof c.included !== 'boolean') throw new Error('artifact.costs.included must be a boolean')
  }
  return value as BacktestArtifact
}
