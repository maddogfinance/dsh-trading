import { describe, expect, it } from "vitest"
import { rsi, sma } from "../src/indicators.js"

/** Deterministic pseudo-random series (LCG); fixed seed so runs are reproducible. */
function lcgSeries(length: number, seed = 42): number[] {
  let state = seed >>> 0
  const out: number[] = []
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out.push(100 + (state / 0xffffffff) * 20 - 10)
  }
  return out
}

/**
 * Reference Wilder RSI, written independently of the implementation under test:
 * seed averages over the first `period` deltas, then Wilder smoothing.
 */
function wilderRsiReference(closes: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null)
  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period && i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    gainSum += Math.max(delta, 0)
    lossSum += Math.max(-delta, 0)
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  const toRsi = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l))
  if (closes.length > period) out[period] = toRsi(avgGain, avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i]! - closes[i - 1]!
    avgGain = (avgGain * (period - 1) + Math.max(delta, 0)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(-delta, 0)) / period
    out[i] = toRsi(avgGain, avgLoss)
  }
  return out
}

describe("sma", () => {
  it("window 1 is the identity", () => {
    const closes = [3, 1, 4, 1, 5, 9, 2.5]
    expect(sma(closes, 1)).toEqual(closes)
  })

  it("emits exactly window-1 leading nulls, then numbers", () => {
    const closes = lcgSeries(10)
    for (const window of [2, 3, 5, 10]) {
      const out = sma(closes, window)
      expect(out).toHaveLength(closes.length)
      expect(out.slice(0, window - 1)).toEqual(new Array(window - 1).fill(null))
      for (const v of out.slice(window - 1)) expect(typeof v).toBe("number")
    }
  })

  it("matches known values: [1..5] window 3", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4])
  })

  it("window longer than the series is all nulls", () => {
    expect(sma([1, 2, 3], 4)).toEqual([null, null, null])
  })

  it("rolling window matches a naive per-position recompute on a longer series", () => {
    const closes = lcgSeries(200)
    const window = 14
    const out = sma(closes, window)
    for (let i = 0; i < closes.length; i++) {
      if (i < window - 1) {
        expect(out[i]).toBeNull()
      } else {
        const naive =
          closes.slice(i - window + 1, i + 1).reduce((a, b) => a + b, 0) / window
        expect(out[i]).toBeCloseTo(naive, 9)
      }
    }
  })

  it("throws on non-integer, zero, or negative window", () => {
    for (const window of [0, -1, 2.5, NaN, Infinity]) {
      expect(() => sma([1, 2, 3], window)).toThrow(/positive integer/)
    }
  })

  it("does not mutate the input", () => {
    const closes = Object.freeze([1, 2, 3, 4, 5]) as readonly number[]
    expect(() => sma(closes, 3)).not.toThrow()
  })
})

describe("rsi", () => {
  it("is 100 at every non-null position for an all-rising series", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i)
    const period = 5
    const out = rsi(closes, period)
    for (let i = 0; i < out.length; i++) {
      if (i < period) expect(out[i]).toBeNull()
      else expect(out[i]).toBe(100)
    }
  })

  it("is 0 at every non-null position for an all-falling series", () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 - i)
    const period = 5
    const out = rsi(closes, period)
    for (let i = 0; i < out.length; i++) {
      if (i < period) expect(out[i]).toBeNull()
      else expect(out[i]).toBe(0)
    }
  })

  it("matches an independent Wilder implementation within 1e-9 on a fixed 30-point series", () => {
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41, 46.22, 45.64,
      46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
    ]
    const period = 14
    const out = rsi(closes, period)
    const expected = wilderRsiReference(closes, period)
    expect(out).toHaveLength(expected.length)
    for (let i = 0; i < out.length; i++) {
      if (expected[i] === null) {
        expect(out[i]).toBeNull()
      } else {
        expect(out[i]).not.toBeNull()
        expect(Math.abs(out[i]! - expected[i]!)).toBeLessThanOrEqual(1e-9)
      }
    }
  })

  it("defaults to period 14", () => {
    const closes = lcgSeries(30)
    expect(rsi(closes)).toEqual(rsi(closes, 14))
  })

  it("is null at positions 0..period-1 and numeric from period on", () => {
    const closes = lcgSeries(25)
    const period = 7
    const out = rsi(closes, period)
    expect(out).toHaveLength(closes.length)
    for (let i = 0; i < period; i++) expect(out[i]).toBeNull()
    for (let i = period; i < out.length; i++) expect(typeof out[i]).toBe("number")
  })

  it("period 1 tracks the sign of each single delta", () => {
    expect(rsi([1, 2, 1, 2], 1)).toEqual([null, 100, 0, 100])
  })

  it("throws on non-integer, zero, or negative period", () => {
    for (const period of [0, -3, 1.5, NaN, Infinity]) {
      expect(() => rsi([1, 2, 3], period)).toThrow(/positive integer/)
    }
  })

  it("does not mutate the input", () => {
    const closes = Object.freeze([44, 45, 43, 46, 47]) as readonly number[]
    expect(() => rsi(closes, 2)).not.toThrow()
  })
})
