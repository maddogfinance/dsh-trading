import { describe, expect, it } from "vitest"
import type { Candle } from "@dsh-trading/market-data"
import type { ArtifactTrade } from "../src/artifact.js"
import { barIndexAt, validateFills } from "../src/checks/fill-validation.js"

/** Ten daily bars, 2026-01-01..2026-01-10, each spanning [95+i, 105+i]. */
function bars(): Candle[] {
  return Array.from({ length: 10 }, (_, i) => ({
    time: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000,
  }))
}

const trade = (over: Partial<ArtifactTrade>): ArtifactTrade => ({
  entryTime: "2026-01-02T10:00:00.000Z",
  exitTime: "2026-01-05T10:00:00.000Z",
  side: "long",
  entryPrice: 100,
  exitPrice: 104,
  ...over,
})

describe("barIndexAt", () => {
  it("maps an intraday instant to its containing bar", () => {
    const times = bars().map(b => Date.parse(b.time))
    expect(barIndexAt(times, Date.parse("2026-01-03T15:30:00Z"))).toBe(2)
    expect(barIndexAt(times, Date.parse("2026-01-01T00:00:00Z"))).toBe(0)
    expect(barIndexAt(times, Date.parse("2025-12-31T23:59:59Z"))).toBe(-1)
  })
})

describe("fill validation", () => {
  it("passes fills inside the bar's true range", () => {
    const result = validateFills([trade({})], bars())
    expect(result.issues).toEqual([])
  })

  it("flags a fill at a price the bar never printed", () => {
    const result = validateFills([trade({ entryPrice: 90 })], bars())
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]!.kind).toBe("impossible-entry-fill")
  })

  it("flags trades outside the candle window", () => {
    const result = validateFills([trade({ entryTime: "2025-06-01T00:00:00Z", exitTime: "2025-06-02T00:00:00Z" })], bars())
    expect(result.issues[0]!.kind).toBe("entry-outside-data")
    expect(result.tradesOutsideData).toBe(1)
  })

  it("REGRESSION: an exit after the data window is flagged, not validated against the last bar", () => {
    const DAY = 86_400_000
    const late = trade({ exitTime: "2026-03-01T00:00:00Z", exitPrice: 104 })
    const result = validateFills([late], bars(), { durationMs: DAY })
    expect(result.issues.some(i => i.kind === "exit-outside-data")).toBe(true)
  })

  it("counts close-priced entries and same-bar round trips", () => {
    const closeFill = trade({ entryPrice: 103, entryTime: "2026-01-02T00:00:00Z" }) // close of bar 1 (102+1)
    const sameBar = trade({ entryTime: "2026-01-04T01:00:00Z", exitTime: "2026-01-04T20:00:00Z", entryPrice: 101, exitPrice: 104 })
    const result = validateFills([closeFill, sameBar], bars())
    expect(result.closeFillCount).toBe(1)
    expect(result.sameBarCount).toBe(1)
  })
})
