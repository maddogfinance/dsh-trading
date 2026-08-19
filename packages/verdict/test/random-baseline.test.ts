import { describe, expect, it } from "vitest"
import type { Candle } from "@dsh-trading/market-data"
import type { ArtifactTrade } from "../src/artifact.js"
import { effectiveTrades } from "../src/checks/independence.js"
import { mulberry32, randomBaseline } from "../src/checks/random-baseline.js"

const DAY = 86_400_000

/**
 * 120 daily bars of a deterministic zigzag: 10 bars up, 10 bars down, so
 * random entries hit rising and falling legs about equally.
 */
function zigzagBars(): Candle[] {
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < 120; i++) {
    const rising = Math.floor(i / 10) % 2 === 0
    price += rising ? 1 : -1
    const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
    out.push({ time: day, open: price - 0.5, high: price + 1, low: price - 1, close: price, volume: 1000 })
  }
  return out
}

/** Long trades that ride only the up-legs, priced close-to-close (honest). */
function clairvoyantTrades(bars: Candle[]): ArtifactTrade[] {
  const trades: ArtifactTrade[] = []
  for (let leg = 0; leg < 6; leg++) {
    const start = leg * 20
    const end = start + 9
    trades.push({
      entryTime: bars[start]!.time,
      exitTime: bars[end]!.time,
      side: "long",
      entryPrice: bars[start]!.close,
      exitPrice: bars[end]!.close,
    })
  }
  return trades
}

function windowsOf(trades: ArtifactTrade[], bars: Candle[]) {
  return effectiveTrades(trades, bars.map(b => Date.parse(b.time)), DAY).kept
}

describe("mulberry32", () => {
  it("is deterministic per seed", () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe("random baseline", () => {
  it("ranks a clairvoyant strategy above nearly all random twins", () => {
    const bars = zigzagBars()
    const result = randomBaseline(windowsOf(clairvoyantTrades(bars), bars), bars, { simulations: 400, seed: 42 })
    expect(result.percentile).toBeGreaterThanOrEqual(0.95)
    expect(result.tradesUsed).toBe(6)
  })

  it("ranks an inverted (short-the-up-leg) strategy near the bottom", () => {
    const bars = zigzagBars()
    const inverted = clairvoyantTrades(bars).map(t => ({ ...t, side: "short" as const }))
    const result = randomBaseline(windowsOf(inverted, bars), bars, { simulations: 400, seed: 42 })
    expect(result.percentile).toBeLessThanOrEqual(0.05)
  })

  it("REGRESSION: perfect intrabar fills cannot buy a percentile — ranking uses close-to-close shadow returns", () => {
    const bars = zigzagBars()
    // Zero-skill timing (fixed-stride entries), but every fill is a fantasy:
    // buy each entry bar's LOW, sell each exit bar's HIGH. Fill validation
    // cannot catch it (prices are inside the bars). The old percentile-on-
    // self-reported design ranked this at 1.0.
    const fantasy: ArtifactTrade[] = []
    for (let i = 0; i < 20; i++) {
      const e = i * 5
      const x = e + 3
      fantasy.push({
        entryTime: bars[e]!.time, exitTime: bars[x]!.time, side: "long",
        entryPrice: bars[e]!.low, exitPrice: bars[x]!.high,
      })
    }
    const result = randomBaseline(windowsOf(fantasy, bars), bars, { simulations: 400, seed: 42 })
    // Shadow (close-to-close) percentile stays in the luck zone...
    expect(result.percentile).toBeLessThan(0.95)
    // ...while the fill-model gap exposes the fantasy pricing.
    expect(result.selfReportedMeanReturn - result.shadowMeanReturn).toBeGreaterThan(0.005)
  })

  it("REGRESSION: a flat market gives percentile 0, not a free pass (strict '<', ties lose)", () => {
    const flat: Candle[] = Array.from({ length: 60 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      open: 100, high: 100, low: 100, close: 100, volume: 1,
    }))
    const trades: ArtifactTrade[] = [{
      entryTime: flat[5]!.time, exitTime: flat[10]!.time, side: "long", entryPrice: 100, exitPrice: 100,
    }]
    const result = randomBaseline(windowsOf(trades, flat), flat, { simulations: 100, seed: 42 })
    expect(result.percentile).toBe(0)
  })

  it("is reproducible: same inputs and seed, same result object", () => {
    const bars = zigzagBars()
    const kept = windowsOf(clairvoyantTrades(bars), bars)
    const a = randomBaseline(kept, bars, { simulations: 100, seed: 7 })
    const b = randomBaseline(kept, bars, { simulations: 100, seed: 7 })
    expect(a).toEqual(b)
  })

  it("degrades loudly when no windows are given", () => {
    const bars = zigzagBars()
    const result = randomBaseline([], bars)
    expect(Number.isNaN(result.percentile)).toBe(true)
    expect(result.note).toContain("baseline not run")
  })
})
