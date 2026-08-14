/**
 * Indicators over full OHLCV candles (the close-only family lives in
 * indicators.ts). Same contract throughout: pure, deterministic, input never
 * mutated, positions without enough history are null, textbook definitions
 * (Wilder smoothing where Wilder defined it) so values reconcile against any
 * charting platform a user compares with.
 * @module @dsh-trading/tool-market
 */

import type { Candle } from '@dsh-trading/market-data'
import { sma } from './indicators.js'

/** EMA seeded with the SMA of the first `window` values; earlier positions null. */
export function ema(values: readonly number[], window: number): (number | null)[] {
  if (!Number.isInteger(window) || window < 1) {
    throw new Error(`ema window must be a positive integer (got ${window})`)
  }
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < window) return out
  const k = 2 / (window + 1)
  let prev = values.slice(0, window).reduce((a, b) => a + b, 0) / window
  out[window - 1] = prev
  for (let i = window; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** MACD(fast, slow, signal): line, signal, histogram. Null until each part seeds. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signal = 9): {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
} {
  const fastLine = ema(closes, fast)
  const slowLine = ema(closes, slow)
  const line = closes.map((_, i) =>
    fastLine[i] !== null && slowLine[i] !== null ? fastLine[i]! - slowLine[i]! : null)
  // The signal EMA runs over the macd line's defined suffix only.
  const start = line.findIndex(v => v !== null)
  const signalLine: (number | null)[] = new Array(closes.length).fill(null)
  if (start !== -1) {
    const suffix = ema(line.slice(start) as number[], signal)
    for (let i = 0; i < suffix.length; i++) signalLine[start + i] = suffix[i]!
  }
  const histogram = line.map((v, i) =>
    v !== null && signalLine[i] !== null ? v - signalLine[i]! : null)
  return { macd: line, signal: signalLine, histogram }
}

/** Slow stochastic %K(kWindow, kSmooth) and %D(dWindow). Flat ranges yield 50. */
export function stochastic(candles: readonly Candle[], kWindow = 14, kSmooth = 3, dWindow = 3): {
  k: (number | null)[]
  d: (number | null)[]
} {
  const raw: (number | null)[] = candles.map((c, i) => {
    if (i < kWindow - 1) return null
    const slice = candles.slice(i - kWindow + 1, i + 1)
    const high = Math.max(...slice.map(s => s.high))
    const low = Math.min(...slice.map(s => s.low))
    return high === low ? 50 : ((c.close - low) / (high - low)) * 100
  })
  const smooth = (series: (number | null)[], window: number): (number | null)[] => {
    const start = series.findIndex(v => v !== null)
    if (start === -1) return series.map(() => null)
    const out: (number | null)[] = new Array(series.length).fill(null)
    const suffix = sma(series.slice(start) as number[], window)
    for (let i = 0; i < suffix.length; i++) out[start + i] = suffix[i]!
    return out
  }
  const k = smooth(raw, kSmooth)
  return { k, d: smooth(k, dWindow) }
}

/** True range per bar (first bar: high − low). */
function trueRanges(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1]!.close), Math.abs(c.low - candles[i - 1]!.close)))
}

/** Wilder-smoothed running average: seeds with the plain average of the first period. */
function wilderSmooth(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < period) return out
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]!) / period
    out[i] = prev
  }
  return out
}

/** ATR(period), Wilder smoothing over true ranges. */
export function atr(candles: readonly Candle[], period = 14): (number | null)[] {
  return wilderSmooth(trueRanges(candles), period)
}

/**
 * ADX(period) with +DI/−DI, per Wilder. ADX seeds one full period after the DIs
 * — counted over CONSECUTIVE defined DX values, so a rangeless stretch (which
 * leaves the DIs a genuine 0/0) restarts the count rather than being averaged
 * in as zero. All three series therefore agree on where they have nothing to say.
 */
export function adx(candles: readonly Candle[], period = 14): {
  adx: (number | null)[]
  plusDi: (number | null)[]
  minusDi: (number | null)[]
} {
  const n = candles.length
  const empty = (): (number | null)[] => new Array(n).fill(null)
  if (n < period + 1) return { adx: empty(), plusDi: empty(), minusDi: empty() }
  const plusDm: number[] = [0]
  const minusDm: number[] = [0]
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high
    const down = candles[i - 1]!.low - candles[i]!.low
    plusDm.push(up > down && up > 0 ? up : 0)
    minusDm.push(down > up && down > 0 ? down : 0)
  }
  const tr = trueRanges(candles)
  // Wilder's running SUMS over the post-seed bars (skip bar 0, which has no move).
  const smooth = (values: number[]): (number | null)[] => {
    const out = empty()
    let prev = values.slice(1, period + 1).reduce((a, b) => a + b, 0)
    out[period] = prev
    for (let i = period + 1; i < n; i++) {
      prev = prev - prev / period + values[i]!
      out[i] = prev
    }
    return out
  }
  const trS = smooth(tr)
  const plusS = smooth(plusDm)
  const minusS = smooth(minusDm)
  const plusDi = empty()
  const minusDi = empty()
  const dx = empty()
  for (let i = period; i < n; i++) {
    // A zero smoothed true range means the window held no range at all, so both
    // DIs are 0/0 — undefined, not zero. DX is left undefined with them.
    if (trS[i] === null || trS[i] === 0) continue
    plusDi[i] = (plusS[i]! / trS[i]!) * 100
    minusDi[i] = (minusS[i]! / trS[i]!) * 100
    const sum = plusDi[i]! + minusDi[i]!
    dx[i] = sum === 0 ? 0 : (Math.abs(plusDi[i]! - minusDi[i]!) / sum) * 100
  }
  // Wilder-average the DX over a window that must be `period` long and
  // unbroken: an undefined DX restarts the run, so no reported ADX rests on a
  // gap read as zero. With DX defined throughout — every real series — the run
  // completes at 2*period-1 and this is Wilder's plain recursion.
  const adxOut = empty()
  let run = 0
  let seed = 0
  let prev = 0
  for (let i = period; i < n; i++) {
    if (dx[i] === null) {
      run = 0
      seed = 0
      continue
    }
    const value = dx[i]!
    run += 1
    if (run < period) {
      seed += value
    } else if (run === period) {
      prev = (seed + value) / period
      adxOut[i] = prev
    } else {
      prev = (prev * (period - 1) + value) / period
      adxOut[i] = prev
    }
  }
  return { adx: adxOut, plusDi, minusDi }
}

/** MFI(period) over typical-price money flow. All-one-sided flow clamps to 100/0. */
export function mfi(candles: readonly Candle[], period = 14): (number | null)[] {
  const n = candles.length
  const out: (number | null)[] = new Array(n).fill(null)
  const typical = candles.map(c => (c.high + c.low + c.close) / 3)
  for (let i = period; i < n; i++) {
    let pos = 0
    let neg = 0
    for (let j = i - period + 1; j <= i; j++) {
      const flow = typical[j]! * candles[j]!.volume
      if (typical[j]! > typical[j - 1]!) pos += flow
      else if (typical[j]! < typical[j - 1]!) neg += flow
    }
    out[i] = neg === 0 ? 100 : pos === 0 ? 0 : 100 - 100 / (1 + pos / neg)
  }
  return out
}

/** Bollinger(window, mult): SMA mid band ± mult population standard deviations. */
export function bollinger(closes: readonly number[], window = 20, mult = 2): {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
} {
  const middle = sma(closes, window)
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = window - 1; i < closes.length; i++) {
    const mean = middle[i]!
    const variance = closes.slice(i - window + 1, i + 1)
      .reduce((acc, v) => acc + (v - mean) ** 2, 0) / window
    const dev = Math.sqrt(variance) * mult
    upper[i] = mean + dev
    lower[i] = mean - dev
  }
  return { upper, middle, lower }
}
