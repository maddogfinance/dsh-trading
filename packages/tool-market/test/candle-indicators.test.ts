import { describe, expect, it } from "vitest"
import type { Candle } from "@dsh-trading/market-data"
import { adx, atr, bollinger, ema, macd, mfi, stochastic } from "../src/candle-indicators.js"

// ---------------------------------------------------------------------------
// Fixtures. Every series here is a fixed literal or a closed-form function of
// the bar index — no randomness, no clock reads — so a failure is always
// reproducible.
// ---------------------------------------------------------------------------

/** Bar open times: 2024-01-01 UTC plus one day per index. Fixed, never "now". */
const isoAt = (i: number): string =>
  new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString()

const bar = (i: number, open: number, high: number, low: number, close: number, volume: number): Candle =>
  ({ time: isoAt(i), open, high, low, close, volume })

/** Build candles from `[open, high, low, close, volume]` rows. */
const series = (rows: readonly (readonly [number, number, number, number, number])[]): Candle[] =>
  rows.map((r, i) => bar(i, r[0], r[1], r[2], r[3], r[4]))

/** A flat-price bar: high = low = close, so every range is degenerate. */
const flat = (n: number, price = 50): Candle[] =>
  Array.from({ length: n }, (_, i) => bar(i, price, price, price, price, 1_000))

/** 30 fixed OHLCV bars with both up and down legs — the general-purpose fixture. */
const OHLCV_30: readonly (readonly [number, number, number, number, number])[] = [
  [44.1, 44.46, 43.91, 44.34, 1000],
  [44.34, 44.68, 44.04, 44.09, 1250],
  [44.09, 44.22, 43.81, 44.15, 1500],
  [44.15, 44.36, 43.5, 43.61, 1750],
  [43.61, 44.78, 43.24, 44.33, 2000],
  [44.33, 44.95, 44.14, 44.83, 2250],
  [44.83, 45.44, 44.78, 45.1, 2500],
  [45.1, 45.49, 44.82, 45.42, 1000],
  [45.42, 46.05, 45.31, 45.84, 1250],
  [45.84, 46.53, 45.47, 46.08, 1500],
  [46.08, 46.2, 45.7, 45.89, 1750],
  [45.89, 46.37, 45.84, 46.03, 2000],
  [46.03, 46.1, 45.33, 45.61, 2250],
  [45.61, 46.49, 45.5, 46.28, 2500],
  [46.28, 46.73, 45.91, 46.28, 1000],
  [46.28, 46.4, 45.81, 46.0, 1250],
  [46.0, 46.37, 45.95, 46.03, 1500],
  [46.03, 46.48, 45.75, 46.41, 1750],
  [46.41, 46.62, 46.11, 46.22, 2000],
  [46.22, 46.67, 45.27, 45.64, 2250],
  [45.64, 46.33, 45.45, 46.21, 2500],
  [46.21, 46.59, 46.16, 46.25, 1000],
  [46.25, 46.32, 45.43, 45.71, 1250],
  [45.71, 46.66, 45.6, 46.45, 1500],
  [46.45, 46.9, 45.41, 45.78, 1750],
  [45.78, 45.9, 45.16, 45.35, 2000],
  [45.35, 45.69, 43.98, 44.03, 2250],
  [44.03, 44.25, 43.75, 44.18, 2500],
  [44.18, 44.43, 44.07, 44.22, 1000],
  [44.22, 45.02, 43.85, 44.57, 1250],
]

const BARS_30 = series(OHLCV_30)
const CLOSES_30 = OHLCV_30.map(r => r[3])

/** Six bars whose intrabar extremes sit outside the close range (stochastic). */
const STOCH_6 = series([
  [8.5, 10, 8, 9, 100],
  [9, 12, 9, 11, 200],
  [11, 13, 10, 12, 300],
  [12, 14, 11, 11.5, 400],
  [11.5, 13, 10.5, 13, 500],
  [13, 15, 12, 14, 600],
])

/** Five bars with typical prices 10, 12, 10, 14, 11 and round volumes (MFI). */
const MFI_5 = series([
  [10, 12, 9, 9, 100],
  [11, 13, 11, 12, 200],
  [11, 12, 9, 9, 300],
  [12, 15, 12, 15, 400],
  [12, 12, 9, 12, 500],
])

/** Four bars with true ranges 2, 2, 1.5, 2.5 (ATR). */
const ATR_4 = series([
  [9, 10, 8, 9, 100],
  [9, 11, 9, 10.5, 100],
  [10.5, 12, 10.5, 11, 100],
  [11, 11.5, 9, 9.5, 100],
])

/** Uptrend with a hard pullback every fifth bar: a real trend, not a ramp. */
const TRENDING_UP = Array.from({ length: 60 }, (_, i) => {
  const p = 100 + i * 2 - (i % 5 === 4 ? 6 : 0)
  return bar(i, p, p + 1.5, p - 1.5, p, 1_000)
})

/** The mirror image of TRENDING_UP. */
const TRENDING_DOWN = Array.from({ length: 60 }, (_, i) => {
  const p = 400 - i * 2 + (i % 5 === 4 ? 6 : 0)
  return bar(i, p, p + 1.5, p - 1.5, p, 1_000)
})

/** Two-level zigzag: direction reverses every bar, net drift zero. */
const CHOPPY = Array.from({ length: 60 }, (_, i) => {
  const p = 100 + (i % 2)
  return bar(i, p, p + 0.5, p - 0.5, p, 1_000)
})

/** Deterministic pseudo-random closes (LCG); fixed seed so runs are reproducible. */
function lcgSeries(length: number, seed = 42): number[] {
  let state = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out.push(100 + (state / 0xffffffff) * 20 - 10)
  }
  return out
}

/** Freeze a candle array and every candle in it, so any write throws. */
function frozen(candles: readonly Candle[]): readonly Candle[] {
  return Object.freeze(candles.map(c => Object.freeze({ ...c })))
}

/** Assert `fn` neither throws on frozen input nor leaves the input changed. */
function expectPure<T>(input: readonly T[], fn: (input: readonly T[]) => unknown): void {
  const before = JSON.stringify(input)
  expect(() => fn(Object.freeze(input.map(v =>
    typeof v === "object" && v !== null ? Object.freeze({ ...v }) : v)) as readonly T[])).not.toThrow()
  expect(JSON.stringify(input)).toBe(before)
}

// ---------------------------------------------------------------------------
// Reference implementations, written independently of the code under test:
// different formulations of the same textbook definitions (incremental rather
// than weighted-sum EMA, Wilder AVERAGES rather than Wilder running SUMS,
// two-pass variance rather than a rolling mean), so agreement is evidence and
// not a tautology. Compared with a 1e-9 tolerance to absorb the reordering.
// ---------------------------------------------------------------------------

/** EMA: SMA seed at `window - 1`, then prev + k(value - prev). */
function emaReference(values: readonly number[], window: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < window) return out
  let seed = 0
  for (let i = 0; i < window; i++) seed += values[i]!
  let prev = seed / window
  out[window - 1] = prev
  const k = 2 / (window + 1)
  for (let i = window; i < values.length; i++) {
    prev = prev + k * (values[i]! - prev)
    out[i] = prev
  }
  return out
}

/** True range per bar; the first bar has no previous close, so it is high − low. */
function trueRangeReference(candles: readonly Candle[]): number[] {
  return candles.map((c, i) => {
    if (i === 0) return c.high - c.low
    const prevClose = candles[i - 1]!.close
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
  })
}

/** Wilder average: mean of the first `period`, then prev + (value − prev)/period. */
function wilderAverageReference(values: readonly number[], period: number, from = 0): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  const seedEnd = from + period
  if (values.length < seedEnd) return out
  let sum = 0
  for (let i = from; i < seedEnd; i++) sum += values[i]!
  let prev = sum / period
  out[seedEnd - 1] = prev
  for (let i = seedEnd; i < values.length; i++) {
    prev = prev + (values[i]! - prev) / period
    out[i] = prev
  }
  return out
}

function atrReference(candles: readonly Candle[], period: number): (number | null)[] {
  return wilderAverageReference(trueRangeReference(candles), period)
}

/**
 * ADX reference. Uses Wilder AVERAGES where the implementation carries running
 * SUMS — mathematically the same ratio, a different arithmetic path.
 */
function adxReference(candles: readonly Candle[], period: number): {
  adx: (number | null)[]
  plusDi: (number | null)[]
  minusDi: (number | null)[]
} {
  const n = candles.length
  const nulls = (): (number | null)[] => new Array(n).fill(null)
  if (n < period + 1) return { adx: nulls(), plusDi: nulls(), minusDi: nulls() }
  const plusDm: number[] = [0]
  const minusDm: number[] = [0]
  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high
    const down = candles[i - 1]!.low - candles[i]!.low
    plusDm.push(up > down && up > 0 ? up : 0)
    minusDm.push(down > up && down > 0 ? down : 0)
  }
  // Bar 0 carries no directional move, so the smoothing window starts at bar 1
  // and first completes at bar `period`.
  const trAvg = wilderAverageReference(trueRangeReference(candles), period, 1)
  const plusAvg = wilderAverageReference(plusDm, period, 1)
  const minusAvg = wilderAverageReference(minusDm, period, 1)
  const plusDi = nulls()
  const minusDi = nulls()
  const dx = nulls()
  for (let i = period; i < n; i++) {
    if (trAvg[i] === null || trAvg[i] === 0) continue
    plusDi[i] = (plusAvg[i]! / trAvg[i]!) * 100
    minusDi[i] = (minusAvg[i]! / trAvg[i]!) * 100
    const sum = plusDi[i]! + minusDi[i]!
    dx[i] = sum === 0 ? 0 : (Math.abs(plusDi[i]! - minusDi[i]!) / sum) * 100
  }
  // Assumes DX is defined from `period` onward, which holds for every series
  // this reference is used against (all have real ranges throughout). The
  // rangeless case, where DX has gaps, is covered separately by its own tests
  // rather than being papered over here with a null-to-zero coercion.
  const adxOut = nulls()
  const first = 2 * period - 1
  if (n > first) {
    let sum = 0
    for (let i = period; i <= first; i++) sum += dx[i]!
    let prev = sum / period
    adxOut[first] = prev
    for (let i = first + 1; i < n; i++) {
      prev = prev + (dx[i]! - prev) / period
      adxOut[i] = prev
    }
  }
  return { adx: adxOut, plusDi, minusDi }
}

function mfiReference(candles: readonly Candle[], period: number): (number | null)[] {
  const typical = candles.map(c => (c.high + c.low + c.close) / 3)
  const out: (number | null)[] = new Array(candles.length).fill(null)
  for (let i = period; i < candles.length; i++) {
    let positive = 0
    let negative = 0
    for (let j = i - period + 1; j <= i; j++) {
      const flow = typical[j]! * candles[j]!.volume
      if (typical[j]! > typical[j - 1]!) positive += flow
      if (typical[j]! < typical[j - 1]!) negative += flow
    }
    // Money-ratio form: 100 * positive / (positive + negative).
    if (negative === 0) out[i] = 100
    else if (positive === 0) out[i] = 0
    else out[i] = (positive / (positive + negative)) * 100
  }
  return out
}

/** Bollinger reference: two-pass mean and POPULATION variance (divide by n). */
function bollingerReference(closes: readonly number[], window: number, mult: number): {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
} {
  const upper: (number | null)[] = new Array(closes.length).fill(null)
  const middle: (number | null)[] = new Array(closes.length).fill(null)
  const lower: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = window - 1; i < closes.length; i++) {
    const slice = closes.slice(i - window + 1, i + 1)
    let sum = 0
    for (const v of slice) sum += v
    const mean = sum / window
    let sq = 0
    for (const v of slice) sq += (v - mean) ** 2
    const dev = Math.sqrt(sq / window) * mult
    middle[i] = mean
    upper[i] = mean + dev
    lower[i] = mean - dev
  }
  return { upper, middle, lower }
}

function simpleMovingAverage(series: readonly (number | null)[], window: number): (number | null)[] {
  return series.map((_, i) => {
    if (i < window - 1) return null
    const slice = series.slice(i - window + 1, i + 1)
    if (slice.some(v => v === null)) return null
    return slice.reduce((a, b) => a! + b!, 0)! / window
  })
}

function stochasticReference(
  candles: readonly Candle[], kWindow: number, kSmooth: number, dWindow: number,
): { k: (number | null)[]; d: (number | null)[] } {
  const raw: (number | null)[] = candles.map((c, i) => {
    if (i < kWindow - 1) return null
    let high = -Infinity
    let low = Infinity
    for (let j = i - kWindow + 1; j <= i; j++) {
      high = Math.max(high, candles[j]!.high)
      low = Math.min(low, candles[j]!.low)
    }
    return high === low ? 50 : ((c.close - low) / (high - low)) * 100
  })
  const k = simpleMovingAverage(raw, kSmooth)
  return { k, d: simpleMovingAverage(k, dWindow) }
}

/** Compare a series against a reference: same nullity, values within `tol`. */
function expectSeriesCloseTo(
  actual: readonly (number | null)[], expected: readonly (number | null)[], tol = 1e-9,
): void {
  expect(actual).toHaveLength(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === null) {
      expect(actual[i], `index ${i} should be null`).toBeNull()
    } else {
      expect(actual[i], `index ${i} should be a number`).not.toBeNull()
      expect(Math.abs(actual[i]! - expected[i]!), `index ${i}`).toBeLessThanOrEqual(tol)
    }
  }
}

const firstDefined = (series: readonly (number | null)[]): number => series.findIndex(v => v !== null)

// ---------------------------------------------------------------------------

describe("ema", () => {
  it("seeds at index window-1 with the SMA of the first window values", () => {
    // [1,2,3]/3 = 2 seeds index 2; k = 2/4 = 0.5, so each step is a midpoint.
    expect(ema([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it("places the seed at window-1 (not window, not 0) for several windows", () => {
    for (const window of [2, 5, 14, 20]) {
      const out = ema(CLOSES_30, window)
      expect(firstDefined(out)).toBe(window - 1)
      const seed = CLOSES_30.slice(0, window).reduce((a, b) => a + b, 0) / window
      expect(out[window - 1]).toBeCloseTo(seed, 12)
      // The seed is a plain average, so it must differ from the recursive value
      // that a "start from values[0]" EMA would report there.
      expect(out[window - 1]).not.toBe(CLOSES_30[window - 1])
    }
  })

  it("emits exactly window-1 leading nulls, then numbers", () => {
    const values = lcgSeries(40)
    for (const window of [2, 3, 9, 26]) {
      const out = ema(values, window)
      expect(out).toHaveLength(values.length)
      expect(out.slice(0, window - 1)).toEqual(new Array(window - 1).fill(null))
      for (const v of out.slice(window - 1)) expect(typeof v).toBe("number")
    }
  })

  it("window 1 is the identity", () => {
    const values = [3, 1, 4, 1, 5, 9, 2.5]
    expect(ema(values, 1)).toEqual(values)
    expect(ema(CLOSES_30, 1)).toEqual(CLOSES_30)
  })

  it("window longer than the series is all nulls", () => {
    expect(ema([1, 2, 3], 4)).toEqual([null, null, null])
    expect(ema([], 3)).toEqual([])
  })

  it("matches an independent EMA implementation within 1e-9", () => {
    for (const window of [2, 5, 12, 26]) {
      expectSeriesCloseTo(ema(CLOSES_30, window), emaReference(CLOSES_30, window))
    }
    expectSeriesCloseTo(ema(lcgSeries(200), 20), emaReference(lcgSeries(200), 20))
  })

  it("converges toward a constant series", () => {
    // Exactly 7 up to the rounding of the k / (1-k) split.
    const out = ema(new Array(30).fill(7), 10)
    for (const v of out.slice(9)) expect(v).toBeCloseTo(7, 12)
  })

  it("throws on non-integer, zero, or negative window", () => {
    for (const window of [0, -1, 2.5, NaN, Infinity]) {
      expect(() => ema([1, 2, 3], window)).toThrow(/positive integer/)
    }
  })

  it("does not mutate the input", () => {
    expectPure(CLOSES_30, values => ema(values, 5))
  })
})

describe("macd", () => {
  const CLOSES = lcgSeries(120)

  it("line is ema(fast) - ema(slow) wherever both are defined", () => {
    for (const [fast, slow, signal] of [[12, 26, 9], [3, 7, 4], [5, 10, 3]] as const) {
      const out = macd(CLOSES, fast, slow, signal)
      const fastLine = emaReference(CLOSES, fast)
      const slowLine = emaReference(CLOSES, slow)
      const expected = CLOSES.map((_, i) =>
        fastLine[i] !== null && slowLine[i] !== null ? fastLine[i]! - slowLine[i]! : null)
      expectSeriesCloseTo(out.macd, expected)
    }
  })

  it("line seeds where the SLOW ema seeds, at slow-1", () => {
    expect(firstDefined(macd(CLOSES, 12, 26, 9).macd)).toBe(25)
    expect(firstDefined(macd(CLOSES, 3, 7, 4).macd)).toBe(6)
  })

  it("signal's first non-null index is slowSeedIndex + signal - 1", () => {
    for (const [fast, slow, signal] of [[12, 26, 9], [3, 7, 4], [5, 10, 3], [12, 26, 1]] as const) {
      const out = macd(CLOSES, fast, slow, signal)
      const slowSeedIndex = slow - 1
      expect(firstDefined(out.macd)).toBe(slowSeedIndex)
      expect(firstDefined(out.signal)).toBe(slowSeedIndex + signal - 1)
    }
  })

  it("signal is an EMA over the macd line's DEFINED SUFFIX, not over the padded array", () => {
    const [fast, slow, signal] = [12, 26, 9]
    const out = macd(CLOSES, fast, slow, signal)
    const start = firstDefined(out.macd)
    const suffix = out.macd.slice(start) as number[]
    const suffixEma = emaReference(suffix, signal)
    const expected: (number | null)[] = new Array(CLOSES.length).fill(null)
    for (let i = 0; i < suffixEma.length; i++) expected[start + i] = suffixEma[i]!
    expectSeriesCloseTo(out.signal, expected)

    // The discriminator: the signal seed is the SMA of the FIRST `signal` DEFINED
    // macd values (indices 25..33), not of indices 0..8 with nulls read as zero,
    // and nothing is emitted at index signal-1.
    const seed = suffix.slice(0, signal).reduce((a, b) => a + b, 0) / signal
    expect(out.signal[start + signal - 1]).toBeCloseTo(seed, 12)
    expect(out.signal[signal - 1]).toBeNull()
    expect(out.signal[start]).toBeNull()
  })

  it("histogram is line - signal wherever both are defined, null elsewhere", () => {
    const out = macd(CLOSES, 12, 26, 9)
    for (let i = 0; i < CLOSES.length; i++) {
      if (out.macd[i] === null || out.signal[i] === null) {
        expect(out.histogram[i]).toBeNull()
      } else {
        expect(out.histogram[i]).toBeCloseTo(out.macd[i]! - out.signal[i]!, 12)
      }
    }
    // Histogram nullity is driven by the signal, which seeds last.
    expect(firstDefined(out.histogram)).toBe(firstDefined(out.signal))
  })

  it("all three series are the input length and all-null when the series is too short", () => {
    const short = CLOSES.slice(0, 10)
    const out = macd(short, 12, 26, 9)
    expect(out.macd).toEqual(new Array(10).fill(null))
    expect(out.signal).toEqual(new Array(10).fill(null))
    expect(out.histogram).toEqual(new Array(10).fill(null))
  })

  it("defaults to 12/26/9", () => {
    expect(macd(CLOSES)).toEqual(macd(CLOSES, 12, 26, 9))
  })

  it("is zero throughout for a constant series", () => {
    const constant = new Array(80).fill(42)
    const out = macd(constant)
    for (let i = 25; i < 80; i++) expect(out.macd[i]).toBe(0)
    for (let i = 33; i < 80; i++) {
      expect(out.signal[i]).toBe(0)
      expect(out.histogram[i]).toBe(0)
    }
  })

  it("does not mutate the input", () => {
    expectPure(CLOSES_30, closes => macd(closes, 3, 7, 4))
  })
})

describe("stochastic", () => {
  it("matches hand-computed %K and %D on a fixed 6-bar series", () => {
    // kWindow 3, kSmooth 1 (raw %K), dWindow 2.
    //  i=2: hh 13, ll 8,    close 12   -> (12-8)/5      * 100 = 80
    //  i=3: hh 14, ll 9,    close 11.5 -> (11.5-9)/5    * 100 = 50
    //  i=4: hh 14, ll 10,   close 13   -> (13-10)/4     * 100 = 75
    //  i=5: hh 15, ll 10.5, close 14   -> (14-10.5)/4.5 * 100 = 77.777...
    const { k, d } = stochastic(STOCH_6, 3, 1, 2)
    expect(k[0]).toBeNull()
    expect(k[1]).toBeNull()
    expect(k[2]).toBe(80)
    expect(k[3]).toBe(50)
    expect(k[4]).toBe(75)
    expect(k[5]).toBeCloseTo((3.5 / 4.5) * 100, 12)
    // %D is the 2-bar SMA of %K, so it lags %K by one more bar.
    expect(d[2]).toBeNull()
    expect(d[3]).toBe(65)
    expect(d[4]).toBe(62.5)
    expect(d[5]).toBeCloseTo((75 + (3.5 / 4.5) * 100) / 2, 12)
  })

  it("uses the window's highest high and lowest low, not the close range", () => {
    // At i=2 the closes alone span 9..12 and would put %K at 100; the true
    // window low is the bar-0 low of 8, which drops it to 80.
    const { k } = stochastic(STOCH_6, 3, 1, 2)
    const closeOnly = ((12 - 9) / (12 - 9)) * 100
    expect(closeOnly).toBe(100)
    expect(k[2]).toBe(80)
  })

  it("yields 50 on a flat range instead of NaN or a divide-by-zero", () => {
    const { k, d } = stochastic(flat(30), 14, 3, 3)
    for (let i = 0; i < 30; i++) {
      for (const v of [k[i], d[i]]) {
        expect(Number.isNaN(v as number)).toBe(false)
        expect(v === null || Number.isFinite(v)).toBe(true)
      }
    }
    expect(k[29]).toBe(50)
    expect(d[29]).toBe(50)
    // Every seeded position is 50, not just the last.
    for (let i = 16; i < 30; i++) expect(k[i]).toBe(50)
    for (let i = 18; i < 30; i++) expect(d[i]).toBe(50)
  })

  it("%D is the SMA of %K over dWindow at every defined position", () => {
    const { k, d } = stochastic(BARS_30, 5, 3, 3)
    for (let i = 0; i < BARS_30.length; i++) {
      const window = k.slice(i - 2, i + 1)
      if (window.length < 3 || window.some(v => v === null)) {
        expect(d[i]).toBeNull()
      } else {
        expect(d[i]).toBeCloseTo((window[0]! + window[1]! + window[2]!) / 3, 9)
      }
    }
  })

  it("seeds %K at kWindow+kSmooth-2 and %D one dWindow later", () => {
    for (const [kWindow, kSmooth, dWindow] of [[14, 3, 3], [5, 1, 2], [3, 4, 2]] as const) {
      const { k, d } = stochastic(BARS_30, kWindow, kSmooth, dWindow)
      expect(firstDefined(k)).toBe(kWindow - 1 + kSmooth - 1)
      expect(firstDefined(d)).toBe(kWindow - 1 + kSmooth - 1 + dWindow - 1)
    }
  })

  it("matches an independent implementation on the 30-bar series", () => {
    for (const [kWindow, kSmooth, dWindow] of [[14, 3, 3], [5, 1, 2], [7, 2, 4]] as const) {
      const out = stochastic(BARS_30, kWindow, kSmooth, dWindow)
      const ref = stochasticReference(BARS_30, kWindow, kSmooth, dWindow)
      expectSeriesCloseTo(out.k, ref.k)
      expectSeriesCloseTo(out.d, ref.d)
    }
  })

  it("stays inside 0..100", () => {
    const out = stochastic(BARS_30)
    for (const v of [...out.k, ...out.d]) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })

  it("is all nulls when the series is shorter than kWindow", () => {
    const out = stochastic(BARS_30.slice(0, 5), 14, 3, 3)
    expect(out.k).toEqual(new Array(5).fill(null))
    expect(out.d).toEqual(new Array(5).fill(null))
    expect(() => stochastic([], 14, 3, 3)).not.toThrow()
  })

  it("does not mutate the input", () => {
    expectPure(BARS_30, candles => stochastic(candles, 5, 3, 3))
    expect(() => stochastic(frozen(BARS_30))).not.toThrow()
  })
})

describe("atr", () => {
  it("uses high - low for the first bar's true range", () => {
    // period 1 makes ATR the bare true-range series.
    const out = atr(ATR_4, 1)
    expect(out[0]).toBe(ATR_4[0]!.high - ATR_4[0]!.low)
    expect(out[0]).toBe(2)
    expect(out).toEqual([2, 2, 1.5, 2.5])
  })

  it("seeds at period-1 with the plain average of the first period true ranges", () => {
    // True ranges are 2, 2, 1.5, 2.5 -> seed = 5.5/3, then Wilder from there.
    const out = atr(ATR_4, 3)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeNull()
    expect(out[2]).toBeCloseTo(11 / 6, 12)
    expect(out[3]).toBeCloseTo(37 / 18, 12)
  })

  it("matches a hand-rolled Wilder reference within 1e-9 on the 30-bar series", () => {
    for (const period of [3, 5, 14]) {
      expectSeriesCloseTo(atr(BARS_30, period), atrReference(BARS_30, period))
    }
  })

  it("accounts for gaps through the previous close", () => {
    // Bar 1 gaps up: its own range is 1, but the move from the prior close is 6.
    const gapped = series([
      [10, 11, 9, 10, 100],
      [16, 16.5, 15.5, 16, 100],
    ])
    expect(atr(gapped, 1)).toEqual([2, 6.5])
  })

  it("is all nulls when the series is shorter than period", () => {
    expect(atr(BARS_30.slice(0, 5), 14)).toEqual(new Array(5).fill(null))
    expect(atr([], 14)).toEqual([])
  })

  it("is zero for a flat series", () => {
    for (const v of atr(flat(30), 14).slice(13)) expect(v).toBe(0)
  })

  it("defaults to period 14", () => {
    expect(atr(BARS_30)).toEqual(atr(BARS_30, 14))
  })

  it("is never negative", () => {
    for (const v of atr(BARS_30, 14)) if (v !== null) expect(v).toBeGreaterThanOrEqual(0)
  })

  it("does not mutate the input", () => {
    expectPure(BARS_30, candles => atr(candles, 14))
    expect(() => atr(frozen(BARS_30))).not.toThrow()
  })
})

describe("adx", () => {
  it("takes +DM only when the up move exceeds the down move (up > down && up > 0)", () => {
    // Every bar is an outside-DOWN bar: the high rises by 1 (up > 0) but the low
    // falls by 3, so down > up and +DM must stay 0 for the whole series.
    const outsideDown = Array.from({ length: 30 }, (_, i) =>
      bar(i, 100 - i, 101 + i, 99 - 3 * i, 100 - i, 1_000))
    const out = adx(outsideDown, 14)
    for (let i = 14; i < 30; i++) {
      expect(out.plusDi[i], `plusDi at ${i}`).toBe(0)
      expect(out.minusDi[i]!, `minusDi at ${i}`).toBeGreaterThan(0)
    }
  })

  it("takes -DM only when the down move exceeds the up move (down > up && down > 0)", () => {
    // Outside-UP bars: the low falls by 1 (down > 0) but the high rises by 3.
    const outsideUp = Array.from({ length: 30 }, (_, i) =>
      bar(i, 100 + i, 101 + 3 * i, 99 - i, 100 + i, 1_000))
    const out = adx(outsideUp, 14)
    for (let i = 14; i < 30; i++) {
      expect(out.minusDi[i], `minusDi at ${i}`).toBe(0)
      expect(out.plusDi[i]!, `plusDi at ${i}`).toBeGreaterThan(0)
    }
  })

  it("takes neither DM on inside bars (both moves negative)", () => {
    // Each bar's high is lower and low is higher than the previous bar's, so
    // up < 0 and down < 0 and both DMs are zero — while the range stays wide,
    // which keeps the smoothed true range non-zero.
    const inside = Array.from({ length: 30 }, (_, i) => bar(i, 100, 200 - i, 0 + i, 100, 1_000))
    const out = adx(inside, 14)
    for (let i = 14; i < 30; i++) {
      expect(out.plusDi[i]).toBe(0)
      expect(out.minusDi[i]).toBe(0)
    }
    // Both DIs zero means DX is defined as 0 rather than 0/0.
    for (let i = 27; i < 30; i++) expect(out.adx[i]).toBe(0)
  })

  it("seeds the DIs at index period and the ADX at index 2*period-1", () => {
    for (const period of [3, 5, 14]) {
      const out = adx(BARS_30, period)
      expect(firstDefined(out.plusDi)).toBe(period)
      expect(firstDefined(out.minusDi)).toBe(period)
      expect(firstDefined(out.adx)).toBe(2 * period - 1)
    }
  })

  it("needs 2*period bars before the ADX seeds at all", () => {
    const period = 5
    const justShort = adx(BARS_30.slice(0, 2 * period - 1), period)
    expect(justShort.adx).toEqual(new Array(2 * period - 1).fill(null))
    expect(firstDefined(justShort.plusDi)).toBe(period) // the DIs are already seeded
    const justEnough = adx(BARS_30.slice(0, 2 * period), period)
    expect(firstDefined(justEnough.adx)).toBe(2 * period - 1)
    expect(justEnough.adx.filter(v => v !== null)).toHaveLength(1)
  })

  it("returns all nulls without throwing for a series shorter than period+1", () => {
    const period = 14
    for (let length = 0; length <= period; length++) {
      const candles = BARS_30.slice(0, length)
      let out!: ReturnType<typeof adx>
      expect(() => { out = adx(candles, period) }).not.toThrow()
      expect(out.adx).toEqual(new Array(length).fill(null))
      expect(out.plusDi).toEqual(new Array(length).fill(null))
      expect(out.minusDi).toEqual(new Array(length).fill(null))
    }
  })

  it("reports a strong trend as ADX above 25, with the DI in the trend direction on top", () => {
    const up = adx(TRENDING_UP, 14)
    expect(up.adx[up.adx.length - 1]!).toBeGreaterThan(25)
    expect(up.plusDi[up.plusDi.length - 1]!).toBeGreaterThan(up.minusDi[up.minusDi.length - 1]!)
    for (const v of up.adx.slice(27)) expect(v!).toBeGreaterThan(25)

    const down = adx(TRENDING_DOWN, 14)
    expect(down.adx[down.adx.length - 1]!).toBeGreaterThan(25)
    expect(down.minusDi[down.minusDi.length - 1]!).toBeGreaterThan(down.plusDi[down.plusDi.length - 1]!)
  })

  it("reports a choppy series as a low ADX", () => {
    const out = adx(CHOPPY, 14)
    for (const v of out.adx.slice(27)) expect(v!).toBeLessThan(20)
    expect(out.adx[out.adx.length - 1]!).toBeLessThan(10)
    // A zigzag hands both sides the same directional movement, so the DIs tie.
    const i = CHOPPY.length - 1
    expect(Math.abs(out.plusDi[i]! - out.minusDi[i]!)).toBeLessThan(5)
  })

  it("reports nothing on a flat series: no range means no DI, and so no ADX", () => {
    // Every bar has high === low === close and no gaps, so the smoothed true
    // range is 0 and the DIs are a genuine 0/0. The ADX averages DX, so it has
    // nothing to average and stays null too — all three series agree on where
    // they have nothing to say, rather than the ADX reporting a 0 built out of
    // undefined DX values read as zeros.
    const out = adx(flat(40), 14)
    expect(out.plusDi).toEqual(new Array(40).fill(null))
    expect(out.minusDi).toEqual(new Array(40).fill(null))
    expect(out.adx).toEqual(new Array(40).fill(null))
    for (const v of [...out.adx, ...out.plusDi, ...out.minusDi]) {
      expect(Number.isNaN(v as number)).toBe(false)
    }
  })

  it("re-seeds after a rangeless stretch instead of averaging the gap in as zero", () => {
    // Twenty rangeless bars, then a real trend. The ADX must not seed at
    // 2*period-1 off a window that is half undefined DX; it seeds a full,
    // unbroken period after DX becomes available again.
    const period = 14
    const candles = [
      ...flat(20, 100),
      ...Array.from({ length: 40 }, (_, i) => {
        const p = 100 + (i + 1) * 2 - ((i + 1) % 5 === 4 ? 6 : 0)
        return bar(20 + i, p, p + 1.5, p - 1.5, p, 1_000)
      }),
    ]
    const out = adx(candles, period)
    const diStart = firstDefined(out.plusDi)
    expect(diStart).toBe(20) // the first bar that gives the smoothed range a value
    expect(firstDefined(out.minusDi)).toBe(diStart)
    expect(firstDefined(out.adx)).toBe(diStart + period - 1)
    // Nowhere does a defined ADX sit on top of an undefined DI.
    for (let i = 0; i < candles.length; i++) {
      if (out.plusDi[i] === null) expect(out.adx[i], `adx at ${i}`).toBeNull()
    }
    // Once seeded it still reads the trend it was given.
    expect(out.adx[out.adx.length - 1]!).toBeGreaterThan(25)
  })

  it("matches an independent Wilder-average implementation within 1e-9", () => {
    for (const [candles, period] of [
      [BARS_30, 14], [BARS_30, 5], [TRENDING_UP, 14], [CHOPPY, 14],
    ] as const) {
      const out = adx(candles, period)
      const ref = adxReference(candles, period)
      expectSeriesCloseTo(out.plusDi, ref.plusDi)
      expectSeriesCloseTo(out.minusDi, ref.minusDi)
      expectSeriesCloseTo(out.adx, ref.adx)
    }
  })

  it("keeps every output inside 0..100", () => {
    const out = adx(BARS_30, 5)
    for (const v of [...out.adx, ...out.plusDi, ...out.minusDi]) {
      if (v !== null) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(100)
      }
    }
  })

  it("defaults to period 14", () => {
    expect(adx(BARS_30)).toEqual(adx(BARS_30, 14))
  })

  it("does not mutate the input", () => {
    expectPure(BARS_30, candles => adx(candles, 5))
    expect(() => adx(frozen(BARS_30))).not.toThrow()
  })
})

describe("mfi", () => {
  it("matches a hand-computed value on a fixed 5-bar series", () => {
    // Typical prices: 10, 12, 10, 14, 11 with volumes 100..500.
    //  i=3: up 12*200 + 14*400 = 8000 positive, 10*300 = 3000 negative
    //       -> 100 * 8000/11000 = 72.7272...
    //  i=4: up 14*400 = 5600 positive, 10*300 + 11*500 = 8500 negative
    //       -> 100 * 5600/14100 = 39.7163...
    const out = mfi(MFI_5, 3)
    expect(out.slice(0, 3)).toEqual([null, null, null])
    expect(out[3]).toBeCloseTo((8000 / 11000) * 100, 12)
    expect(out[4]).toBeCloseTo((5600 / 14100) * 100, 12)
  })

  it("is 100 at every defined position for an all-rising series", () => {
    const rising = Array.from({ length: 30 }, (_, i) => bar(i, 100 + i, 101 + i, 99 + i, 100 + i, 1_000))
    const out = mfi(rising, 14)
    for (let i = 0; i < 30; i++) {
      if (i < 14) expect(out[i]).toBeNull()
      else expect(out[i]).toBe(100)
    }
  })

  it("is 0 at every defined position for an all-falling series", () => {
    const falling = Array.from({ length: 30 }, (_, i) => bar(i, 100 - i, 101 - i, 99 - i, 100 - i, 1_000))
    const out = mfi(falling, 14)
    for (let i = 0; i < 30; i++) {
      if (i < 14) expect(out[i]).toBeNull()
      else expect(out[i]).toBe(0)
    }
  })

  it("seeds at index period, one bar after the first full window of changes", () => {
    for (const period of [3, 5, 14]) {
      expect(firstDefined(mfi(BARS_30, period))).toBe(period)
    }
  })

  it("weights flow by volume, not by price alone", () => {
    // Same prices, different volumes on the single up bar -> different MFI.
    const light = series([[10, 12, 9, 9, 100], [11, 13, 11, 12, 1], [11, 12, 9, 9, 300]])
    const heavy = series([[10, 12, 9, 9, 100], [11, 13, 11, 12, 10_000], [11, 12, 9, 9, 300]])
    expect(mfi(light, 2)[2]).not.toBe(mfi(heavy, 2)[2])
    expect(mfi(heavy, 2)[2]!).toBeGreaterThan(mfi(light, 2)[2]!)
  })

  it("matches an independent implementation on the 30-bar series", () => {
    for (const period of [3, 5, 14]) {
      expectSeriesCloseTo(mfi(BARS_30, period), mfiReference(BARS_30, period), 1e-9)
    }
  })

  it("is all nulls when the series is no longer than period", () => {
    expect(mfi(BARS_30.slice(0, 14), 14)).toEqual(new Array(14).fill(null))
    expect(mfi([], 14)).toEqual([])
  })

  it("reads a flat series as 100, the same 'no losses' convention rsi uses", () => {
    // Unchanged typical prices count toward neither side, so negative flow is 0
    // and the money ratio degenerates. Documented here so the convention is a
    // decision rather than an accident.
    for (const v of mfi(flat(30), 14).slice(14)) expect(v).toBe(100)
  })

  it("defaults to period 14", () => {
    expect(mfi(BARS_30)).toEqual(mfi(BARS_30, 14))
  })

  it("does not mutate the input", () => {
    expectPure(BARS_30, candles => mfi(candles, 5))
    expect(() => mfi(frozen(BARS_30))).not.toThrow()
  })
})

describe("bollinger", () => {
  it("uses POPULATION standard deviation, not sample", () => {
    // [2,4,4,4,5,5,7,9] has mean 5 and squared deviations 9,1,1,1,0,0,4,16 = 32.
    // Population: sqrt(32/8) = 2 exactly -> bands at 9 and 1.
    // Sample:     sqrt(32/7) = 2.13809... -> bands at 9.276... and 0.723...
    const closes = [2, 4, 4, 4, 5, 5, 7, 9]
    const { upper, middle, lower } = bollinger(closes, 8, 2)
    expect(middle[7]).toBeCloseTo(5, 12)
    expect(upper[7]).toBeCloseTo(9, 12)
    expect(lower[7]).toBeCloseTo(1, 12)
    const sampleUpper = 5 + 2 * Math.sqrt(32 / 7)
    expect(sampleUpper).toBeCloseTo(9.27618, 4)
    expect(Math.abs(upper[7]! - sampleUpper)).toBeGreaterThan(0.2)
  })

  it("middle band is the simple moving average", () => {
    expect(bollinger([1, 2, 3, 4, 5], 3, 2).middle).toEqual([null, null, 2, 3, 4])
    const { middle } = bollinger(CLOSES_30, 20, 2)
    for (let i = 19; i < CLOSES_30.length; i++) {
      const mean = CLOSES_30.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20
      expect(middle[i]).toBeCloseTo(mean, 9)
    }
  })

  it("emits exactly window-1 leading nulls on all three bands", () => {
    for (const window of [2, 5, 20]) {
      const out = bollinger(CLOSES_30, window, 2)
      for (const series of [out.upper, out.middle, out.lower]) {
        expect(series).toHaveLength(CLOSES_30.length)
        expect(series.slice(0, window - 1)).toEqual(new Array(window - 1).fill(null))
        for (const v of series.slice(window - 1)) expect(typeof v).toBe("number")
      }
    }
  })

  it("bands are symmetric about the middle and scale linearly with mult", () => {
    const one = bollinger(CLOSES_30, 20, 1)
    const two = bollinger(CLOSES_30, 20, 2)
    for (let i = 19; i < CLOSES_30.length; i++) {
      expect(two.upper[i]! - two.middle[i]!).toBeCloseTo(two.middle[i]! - two.lower[i]!, 12)
      expect(two.upper[i]! - two.middle[i]!).toBeCloseTo(2 * (one.upper[i]! - one.middle[i]!), 12)
    }
  })

  it("collapses onto the middle band for a constant series", () => {
    const out = bollinger(new Array(30).fill(12.5), 20, 2)
    for (let i = 19; i < 30; i++) {
      expect(out.middle[i]).toBe(12.5)
      expect(out.upper[i]).toBe(12.5)
      expect(out.lower[i]).toBe(12.5)
    }
  })

  it("matches an independent two-pass implementation within 1e-9", () => {
    for (const [window, mult] of [[20, 2], [5, 1], [10, 2.5]] as const) {
      const out = bollinger(CLOSES_30, window, mult)
      const ref = bollingerReference(CLOSES_30, window, mult)
      expectSeriesCloseTo(out.upper, ref.upper)
      expectSeriesCloseTo(out.middle, ref.middle)
      expectSeriesCloseTo(out.lower, ref.lower)
    }
    const long = lcgSeries(300)
    const out = bollinger(long, 20, 2)
    const ref = bollingerReference(long, 20, 2)
    expectSeriesCloseTo(out.upper, ref.upper)
    expectSeriesCloseTo(out.lower, ref.lower)
  })

  it("window longer than the series is all nulls", () => {
    const out = bollinger([1, 2, 3], 20, 2)
    expect(out.upper).toEqual([null, null, null])
    expect(out.middle).toEqual([null, null, null])
    expect(out.lower).toEqual([null, null, null])
  })

  it("defaults to window 20 and mult 2", () => {
    expect(bollinger(CLOSES_30)).toEqual(bollinger(CLOSES_30, 20, 2))
  })

  it("propagates the invalid-window error from sma", () => {
    for (const window of [0, -1, 2.5, NaN, Infinity]) {
      expect(() => bollinger([1, 2, 3], window, 2)).toThrow(/positive integer/)
    }
  })

  it("does not mutate the input", () => {
    expectPure(CLOSES_30, closes => bollinger(closes, 5, 2))
  })
})
