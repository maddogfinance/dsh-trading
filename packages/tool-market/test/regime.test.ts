import { describe, expect, it } from "vitest"
import type { Candle } from "@dsh-trading/market-data"
import { regimeSnapshot, renderSnapshot } from "../src/regime.js"

// ---------------------------------------------------------------------------
// Fixtures. Closed-form functions of the bar index or fixed literals — no
// randomness and no clock reads, so every label below is reproducible.
// ---------------------------------------------------------------------------

/** Bar open times: 2024-01-01 UTC plus one day per index. Fixed, never "now". */
const isoAt = (i: number): string =>
  new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString()

const bar = (i: number, open: number, high: number, low: number, close: number, volume: number): Candle =>
  ({ time: isoAt(i), open, high, low, close, volume })

/** `n` bars whose price follows `price(i)`, with a fixed half-point band. */
const from = (n: number, price: (i: number) => number, band = 1): Candle[] =>
  Array.from({ length: n }, (_, i) => {
    const p = price(i)
    return bar(i, p, p + band, p - band, p, 1_000)
  })

/** The placeholder renderSnapshot prints for a null value (U+2013 EN DASH). */
const DASH = "–"

/** Monotonic advance: RSI 100, MFI 100, close above every seeded average. */
const RISING = from(250, i => 100 + i)
/** Monotonic decline: RSI 0, MFI 0, close below every seeded average. */
const FALLING = from(250, i => 400 - i)
/** One-point zigzag: no net drift, so RSI/stochastic/ADX all sit mid-range. */
const SIDEWAYS = from(60, i => 100 + (i % 2), 0.5)
/** Uptrend with a hard pullback every fifth bar — a trend with real retracement. */
const TRENDING = from(60, i => 100 + i * 2 - (i % 5 === 4 ? 6 : 0), 1.5)
/** A 200-bar decline followed by a 50-bar bounce: above the fast MAs, below SMA200. */
const V_SHAPED = from(250, i => (i < 200 ? 400 - i * 1.5 : 100 + (i - 199)))
/** Forty flat bars, then a sharp breakout: the macd line pulls clear of its signal. */
const BULLISH_TURN = from(60, i => (i < 40 ? 100 : 100 + (i - 39) * 3))
/** The mirror image: a sharp breakdown out of the same flat base. */
const BEARISH_TURN = from(60, i => (i < 40 ? 100 : 100 - (i - 39) * 3))
/** The same breakout 30 bars later: the signal has nearly caught the line, but
 *  not exactly — a converging macd that still has a side. */
const MATURED_TURN = from(90, i => (i < 40 ? 100 : 100 + (i - 39) * 3))

/** The band mapping regimeSnapshot documents, restated here independently. */
function bandOf(value: number | null, low: number, high: number, labels: [string, string, string]): string | null {
  if (value === null) return null
  if (value < low) return labels[0]
  if (value > high) return labels[2]
  return labels[1]
}

describe("regimeSnapshot", () => {
  it("throws on empty input", () => {
    expect(() => regimeSnapshot([])).toThrow(/at least one candle/)
  })

  it("reports the bar count, last bar time, and last close", () => {
    const snapshot = regimeSnapshot(RISING)
    expect(snapshot.bars).toBe(250)
    expect(snapshot.lastTime).toBe(isoAt(249))
    expect(snapshot.close).toBe(349)
  })

  describe("state labels", () => {
    it("calls a relentless advance overbought and a relentless decline oversold", () => {
      const up = regimeSnapshot(RISING)
      expect(up.rsi14.value).toBe(100)
      expect(up.rsi14.state).toBe("overbought")
      expect(up.mfi14.value).toBe(100)
      expect(up.mfi14.state).toBe("overbought")
      expect(up.stochastic.state).toBe("overbought")

      const down = regimeSnapshot(FALLING)
      expect(down.rsi14.value).toBe(0)
      expect(down.rsi14.state).toBe("oversold")
      expect(down.mfi14.value).toBe(0)
      expect(down.mfi14.state).toBe("oversold")
      expect(down.stochastic.state).toBe("oversold")
    })

    it("calls a directionless zigzag neutral", () => {
      const snapshot = regimeSnapshot(SIDEWAYS)
      expect(snapshot.rsi14.value!).toBeGreaterThanOrEqual(30)
      expect(snapshot.rsi14.value!).toBeLessThanOrEqual(70)
      expect(snapshot.rsi14.state).toBe("neutral")
      expect(snapshot.stochastic.state).toBe("neutral")
      expect(snapshot.mfi14.state).toBe("neutral")
    })

    it("calls a trending series trending and a choppy one no trend", () => {
      const trending = regimeSnapshot(TRENDING)
      expect(trending.adx14.value!).toBeGreaterThan(25)
      expect(trending.adx14.state).toBe("trending")
      expect(trending.adx14.plusDi!).toBeGreaterThan(trending.adx14.minusDi!)

      const choppy = regimeSnapshot(SIDEWAYS)
      expect(choppy.adx14.value!).toBeLessThan(20)
      expect(choppy.adx14.state).toBe("no trend")
    })

    it("puts every state in the band its own value implies", () => {
      for (const candles of [RISING, FALLING, SIDEWAYS, TRENDING, V_SHAPED]) {
        const s = regimeSnapshot(candles)
        expect(s.rsi14.state).toBe(bandOf(s.rsi14.value, 30, 70, ["oversold", "neutral", "overbought"]))
        expect(s.stochastic.state).toBe(bandOf(s.stochastic.k, 20, 80, ["oversold", "neutral", "overbought"]))
        expect(s.mfi14.state).toBe(bandOf(s.mfi14.value, 20, 80, ["oversold", "neutral", "overbought"]))
        expect(s.adx14.state).toBe(bandOf(s.adx14.value, 20, 25, ["no trend", "developing trend", "trending"]))
      }
    })

    it("leaves every state null when nothing has seeded", () => {
      const s = regimeSnapshot(from(3, i => 100 + i))
      expect(s.rsi14).toEqual({ value: null, state: null })
      expect(s.stochastic).toEqual({ k: null, d: null, state: null })
      expect(s.adx14).toEqual({ value: null, plusDi: null, minusDi: null, state: null })
      expect(s.macd).toEqual({ line: null, signal: null, histogram: null, state: null })
      expect(s.mfi14).toEqual({ value: null, state: null })
      expect(s.atr14).toEqual({ value: null, pctOfClose: null })
      expect(s.bollinger20.state).toBeNull()
    })

    it("labels macd bullish when the line leads the signal and bearish when it lags", () => {
      expect(regimeSnapshot(BULLISH_TURN).macd.state).toMatch(/^bullish/)
      expect(regimeSnapshot(BEARISH_TURN).macd.state).toMatch(/^bearish/)
      // The label must follow the two numbers it reports, on every fixture
      // where those numbers actually differ. (An exact tie is covered below.)
      for (const candles of [SIDEWAYS, TRENDING, V_SHAPED, BULLISH_TURN, BEARISH_TURN]) {
        const s = regimeSnapshot(candles)
        if (s.macd.line === null || s.macd.signal === null) {
          expect(s.macd.state).toBeNull()
          continue
        }
        expect(s.macd.line).not.toBe(s.macd.signal)
        expect(s.macd.state!.startsWith("bullish")).toBe(s.macd.line > s.macd.signal)
        expect(s.macd.histogram!).toBeCloseTo(s.macd.line - s.macd.signal, 3)
      }
    })

    it("calls an exact tie flat instead of taking a side from float residue", () => {
      // A perfectly linear ramp pins the macd line to a constant, which the
      // signal EMA reproduces exactly: line and signal are equal in real
      // arithmetic and differ only by ~1e-15 of float residue. The side is
      // decided on the reported (4-place) numbers, so that residue is gone by
      // the time the label is chosen and the tie reads 'flat' — rather than
      // 'bearish' printed beside two equal numbers, which is what comparing the
      // unrounded values used to produce here.
      for (const candles of [RISING, FALLING]) {
        const s = regimeSnapshot(candles)
        expect(s.macd.line).toBe(s.macd.signal)
        expect(s.macd.state).toBe("flat")
        // A tie has already converged, so it carries no ', converging' tail.
        expect(s.macd.state).not.toContain("converging")
      }
    })

    it("reports a rounded-away histogram as plain zero, never signed zero", () => {
      // RISING's residual histogram is negative before rounding, and toFixed
      // turns that into the string "-0.0000". Left alone it would reach the
      // model as -0 beside a line and signal that are equal.
      const s = regimeSnapshot(RISING)
      // toBe uses Object.is, so it already separates 0 from -0; the second
      // assertion states the intent outright rather than relying on that.
      expect(s.macd.histogram).toBe(0)
      expect(Object.is(s.macd.histogram, -0)).toBe(false)
    })

    it("tags macd as converging when the histogram is under 5% of the line", () => {
      // TRENDING's line has nearly been caught by its signal from above, and
      // MATURED_TURN's from below: the tag composes with either side.
      for (const [candles, expected] of [
        [TRENDING, "bearish, converging"],
        [MATURED_TURN, "bullish, converging"],
      ] as const) {
        const s = regimeSnapshot(candles)
        expect(Math.abs(s.macd.histogram!)).toBeLessThan(Math.abs(s.macd.line!) * 0.05)
        expect(s.macd.state).toBe(expected)
      }
      // A fresh breakout is the opposite: a wide histogram, no converging tag.
      const turning = regimeSnapshot(BULLISH_TURN)
      expect(Math.abs(turning.macd.histogram!)).toBeGreaterThan(Math.abs(turning.macd.line!) * 0.05)
      expect(turning.macd.state).toBe("bullish")
    })

    it("labels the close against the Bollinger bands", () => {
      expect(regimeSnapshot(SIDEWAYS).bollinger20.state).toBe("inside bands")
      // A single spike well beyond the band closes above it.
      const spiked = [...from(40, () => 100, 0.5), bar(40, 100, 130, 100, 130, 1_000)]
      expect(regimeSnapshot(spiked).bollinger20.state).toBe("above upper band")
      const dumped = [...from(40, () => 100, 0.5), bar(40, 100, 100, 70, 70, 1_000)]
      expect(regimeSnapshot(dumped).bollinger20.state).toBe("below lower band")
    })
  })

  describe("movingAverages.closeVs", () => {
    it("reports every average the close leads", () => {
      expect(regimeSnapshot(RISING).movingAverages.closeVs).toBe("above 20/50/200")
    })

    it("reports every average the close trails", () => {
      expect(regimeSnapshot(FALLING).movingAverages.closeVs).toBe("below 20/50/200")
    })

    it("splits a mixed posture into an above clause then a below clause", () => {
      const snapshot = regimeSnapshot(V_SHAPED)
      expect(snapshot.movingAverages.closeVs).toBe("above 20/50, below 200")
      // Cross-check the claim against the reported averages themselves.
      const { sma20, sma50, sma200 } = snapshot.movingAverages
      expect(snapshot.close).toBeGreaterThanOrEqual(sma20!)
      expect(snapshot.close).toBeGreaterThanOrEqual(sma50!)
      expect(snapshot.close).toBeLessThan(sma200!)
    })

    it("omits averages the series is too short to seed", () => {
      // 60 bars seeds SMA20 and SMA50 but not SMA200.
      const snapshot = regimeSnapshot(TRENDING)
      expect(snapshot.movingAverages.sma200).toBeNull()
      expect(snapshot.movingAverages.closeVs).toBe("above 20/50")
      expect(snapshot.movingAverages.closeVs).not.toContain("200")
    })

    it("reports 'no seeded moving averages' when the series is too short", () => {
      for (const length of [1, 2, 10, 19]) {
        const snapshot = regimeSnapshot(from(length, i => 100 + i))
        expect(snapshot.movingAverages.sma20).toBeNull()
        expect(snapshot.movingAverages.sma50).toBeNull()
        expect(snapshot.movingAverages.sma200).toBeNull()
        expect(snapshot.movingAverages.ema20).toBeNull()
        expect(snapshot.movingAverages.closeVs).toBe("no seeded moving averages")
      }
    })

    it("counts a close sitting exactly on an average as above it", () => {
      const snapshot = regimeSnapshot(from(20, () => 100))
      expect(snapshot.movingAverages.sma20).toBe(100)
      expect(snapshot.movingAverages.closeVs).toBe("above 20")
    })
  })

  describe("changePct", () => {
    it("is null for a single-candle series", () => {
      const snapshot = regimeSnapshot([bar(0, 10, 11, 9, 10.5, 100)])
      expect(snapshot.bars).toBe(1)
      expect(snapshot.close).toBe(10.5)
      expect(snapshot.changePct).toBeNull()
    })

    it("is the percent move from the previous close for two candles", () => {
      const up = regimeSnapshot([bar(0, 100, 101, 99, 100, 100), bar(1, 100, 106, 100, 105, 100)])
      expect(up.changePct).toBe(5)
      const down = regimeSnapshot([bar(0, 200, 201, 199, 200, 100), bar(1, 200, 200, 189, 190, 100)])
      expect(down.changePct).toBe(-5)
      // Rounded to two places, not truncated.
      const odd = regimeSnapshot([bar(0, 21, 21, 21, 21, 100), bar(1, 21, 22, 21, 22, 100)])
      expect(odd.changePct).toBe(4.76)
    })

    it("is null when the previous close is zero", () => {
      const snapshot = regimeSnapshot([bar(0, 0, 0, 0, 0, 100), bar(1, 0, 1, 0, 1, 100)])
      expect(snapshot.changePct).toBeNull()
    })

    it("compares the last two bars, not the first and last", () => {
      const snapshot = regimeSnapshot([
        bar(0, 10, 10, 10, 10, 100),
        bar(1, 50, 50, 50, 50, 100),
        bar(2, 55, 55, 55, 55, 100),
      ])
      expect(snapshot.changePct).toBe(10)
    })
  })

  it("rounds atr to four places and reports it as a percent of the close", () => {
    const snapshot = regimeSnapshot(TRENDING)
    expect(snapshot.atr14.value!).toBeGreaterThan(0)
    expect(snapshot.atr14.pctOfClose).toBeCloseTo((snapshot.atr14.value! / snapshot.close) * 100, 2)
  })

  it("does not mutate the candles it is given", () => {
    const candles = Object.freeze(TRENDING.map(c => Object.freeze({ ...c })))
    const before = JSON.stringify(TRENDING)
    expect(() => regimeSnapshot(candles)).not.toThrow()
    expect(JSON.stringify(TRENDING)).toBe(before)
  })
})

describe("renderSnapshot", () => {
  it("leads with the timeframe label", () => {
    for (const timeframe of ["1d", "4h", "15m"]) {
      const text = renderSnapshot(timeframe, regimeSnapshot(TRENDING))
      expect(text.startsWith(`[${timeframe}]`)).toBe(true)
      expect(text).toContain(`[${timeframe}]`)
    }
  })

  it("carries the header facts: bar count, last time, close, and signed change", () => {
    const snapshot = regimeSnapshot(TRENDING)
    const header = renderSnapshot("1d", snapshot).split("\n")[0]!
    expect(header).toContain(`${snapshot.bars} bars`)
    expect(header).toContain(`last ${snapshot.lastTime}`)
    expect(header).toContain(`close ${snapshot.close}`)
    // TRENDING ends on a pullback bar, so the change is negative and already
    // carries its own sign; only a rise gets an explicit '+'.
    expect(snapshot.changePct!).toBeLessThan(0)
    expect(header).toContain(`(${snapshot.changePct}%)`)
    expect(header).not.toContain("+-")

    const rising = regimeSnapshot(RISING)
    expect(rising.changePct!).toBeGreaterThan(0)
    expect(renderSnapshot("1d", rising)).toContain(`(+${rising.changePct}%)`)
  })

  it("renders every null as the en-dash placeholder", () => {
    // Three bars seed nothing at all, so every numeric slot is a placeholder.
    const text = renderSnapshot("1d", regimeSnapshot(from(3, i => 100 + i)))
    expect(text).toContain(`RSI14 ${DASH} (${DASH})`)
    expect(text).toContain(`Stoch %K ${DASH} %D ${DASH} (${DASH})`)
    expect(text).toContain(`ADX ${DASH} +DI ${DASH} −DI ${DASH} (${DASH})`)
    expect(text).toContain(`MACD ${DASH} sig ${DASH} hist ${DASH} (${DASH})`)
    expect(text).toContain(`MFI ${DASH} (${DASH})`)
    expect(text).toContain(`ATR ${DASH}`)
    expect(text).toContain(`SMA20 ${DASH} SMA50 ${DASH} SMA200 ${DASH} EMA20 ${DASH}`)
    expect(text).toContain(`BB(20,2) ${DASH} [${DASH} … ${DASH}]`)
    expect(text).toContain("close no seeded moving averages")
    // Nothing seeded also means no "% of close" tail on the ATR field.
    expect(text).not.toContain("% of close")
    expect(text).not.toContain("null")
    expect(text).not.toContain("NaN")
  })

  it("omits the change tail entirely for a single-candle series", () => {
    const text = renderSnapshot("1h", regimeSnapshot([bar(0, 10, 11, 9, 10.5, 100)]))
    expect(text).toContain("[1h] 1 bars, last 2024-01-01T00:00:00.000Z, close 10.5")
    expect(text).not.toContain("%)")
  })

  it("prints numbers rather than placeholders once everything has seeded", () => {
    const snapshot = regimeSnapshot(RISING)
    const text = renderSnapshot("1d", snapshot)
    expect(text).not.toContain(DASH)
    expect(text).toContain(`RSI14 ${snapshot.rsi14.value} (overbought)`)
    expect(text).toContain("close above 20/50/200")
    expect(text).toContain("BB(20,2) inside bands")
    expect(text.split("\n")).toHaveLength(4)
  })
})
