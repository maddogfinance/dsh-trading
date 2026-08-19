import { describe, expect, it } from "vitest"
import type { Candle } from "@dsh-trading/market-data"
import type { ArtifactTrade } from "../src/artifact.js"
import { effectiveTrades } from "../src/checks/independence.js"
import { independenceCheck } from "../src/report.js"

const DAY = 86_400_000

function bars(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    open: 100, high: 101, low: 99, close: 100.5, volume: 1,
  }))
}

const trade = (entryDay: number, exitDay: number, side: 'long' | 'short' = 'long'): ArtifactTrade => ({
  entryTime: new Date(Date.UTC(2026, 0, 1 + entryDay)).toISOString(),
  exitTime: new Date(Date.UTC(2026, 0, 1 + exitDay)).toISOString(),
  side,
  entryPrice: 100,
  exitPrice: 100.5,
})

describe("effectiveTrades", () => {
  it("keeps non-overlapping same-side trades", () => {
    const b = bars(30)
    const result = effectiveTrades([trade(1, 3), trade(5, 7), trade(9, 11)], b.map(x => Date.parse(x.time)), DAY)
    expect(result.effective).toBe(3)
    expect(result.overlapRatio).toBe(0)
  })

  it("REGRESSION: one lucky trade copied 800 times collapses to ONE independent observation", () => {
    const b = bars(30)
    const copies = Array.from({ length: 800 }, () => trade(4, 8))
    const result = effectiveTrades(copies, b.map(x => Date.parse(x.time)), DAY)
    expect(result.effective).toBe(1)
    expect(result.overlapRatio).toBeGreaterThan(0.99)
    expect(independenceCheck(result).status).toBe("error")
  })

  it("opposite sides do not block each other", () => {
    const b = bars(30)
    const result = effectiveTrades([trade(1, 5, 'long'), trade(2, 6, 'short')], b.map(x => Date.parse(x.time)), DAY)
    expect(result.effective).toBe(2)
  })
})
