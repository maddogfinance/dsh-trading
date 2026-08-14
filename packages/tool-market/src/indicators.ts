/**
 * Pure indicator math over close prices. Deliberately dependency-free and
 * deterministic: indicator values reach the model, and "model-visible means
 * logged" only helps if replaying the log recomputes identical numbers.
 * @module @dsh-trading/tool-market
 */

/** Simple moving average; positions with fewer than `window` samples are null. */
export function sma(closes: readonly number[], window: number): (number | null)[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`sma window must be a positive integer (got ${window})`)
  }
  let sum = 0
  return closes.map((close, i) => {
    sum += close
    if (i >= window) sum -= closes[i - window]!
    return i >= window - 1 ? sum / window : null
  })
}

/** Wilder-smoothed RSI; positions before the first full period are null. */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) {
    throw new Error(`rsi period must be a positive integer (got ${period})`)
  }
  const out: (number | null)[] = new Array(closes.length).fill(null)
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    const gain = Math.max(delta, 0)
    const loss = Math.max(-delta, 0)
    if (i <= period) {
      avgGain += gain / period
      avgLoss += loss / period
      if (i < period) continue
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period
      avgLoss = (avgLoss * (period - 1) + loss) / period
    }
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}
