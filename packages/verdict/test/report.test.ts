import { describe, expect, it } from "vitest"
import type { BacktestArtifact } from "../src/artifact.js"
import { parseArtifact } from "../src/artifact.js"
import { assembleReport, renderReport } from "../src/report.js"
import type { CheckResult } from "../src/report.js"

const artifact: BacktestArtifact = {
  version: 1,
  symbol: "DEMO-EQ",
  timeframe: "1d",
  trades: [
    { entryTime: "2026-01-02T00:00:00Z", exitTime: "2026-01-05T00:00:00Z", side: "long", entryPrice: 100, exitPrice: 104 },
    { entryTime: "2026-01-06T00:00:00Z", exitTime: "2026-01-08T00:00:00Z", side: "short", entryPrice: 105, exitPrice: 103 },
  ],
}

const check = (status: CheckResult["status"], id = "x"): CheckResult => ({
  id, name: id.toUpperCase(), status, summary: "s",
})

/** All three substantive checks present and non-skipped. */
const substantive = (status: CheckResult["status"] = "pass"): CheckResult[] => [
  check(status, "fill-validation"),
  check(status, "random-baseline"),
  check(status, "sample-power"),
]

describe("verdict logic", () => {
  it("any error means DEFECTS_FOUND", () => {
    const report = assembleReport(artifact, [...substantive(), check("error")])
    expect(report.verdict).toBe("DEFECTS_FOUND")
  })

  it("not_proven without errors means NOT_PROVEN", () => {
    const report = assembleReport(artifact, [...substantive(), check("not_proven")])
    expect(report.verdict).toBe("NOT_PROVEN")
  })

  it("all substantive checks passing means NO_DEFECTS_FOUND — and still refuses to certify", () => {
    const report = assembleReport(artifact, substantive("pass"))
    expect(report.verdict).toBe("NO_DEFECTS_FOUND")
    expect(report.headline).toContain("NOT a certification")
  })

  it("REGRESSION: an empty check list throws instead of certifying nothing", () => {
    expect(() => assembleReport(artifact, [])).toThrow(/no checks/)
  })

  it("REGRESSION: a skipped substantive check caps the verdict at NOT_PROVEN", () => {
    const checks = [check("pass", "fill-validation"), check("skipped", "random-baseline"), check("pass", "sample-power")]
    const report = assembleReport(artifact, checks)
    expect(report.verdict).toBe("NOT_PROVEN")
    expect(report.headline).toContain("random-baseline")
  })

  it("REGRESSION: a missing substantive check also caps the verdict at NOT_PROVEN", () => {
    const report = assembleReport(artifact, [check("pass", "fill-validation"), check("pass", "sample-power")])
    expect(report.verdict).toBe("NOT_PROVEN")
  })

  it("REGRESSION: unresolved warnings are named in the headline", () => {
    const report = assembleReport(artifact, [...substantive("pass"), check("warn", "costs")])
    expect(report.verdict).toBe("NO_DEFECTS_FOUND")
    expect(report.headline).toContain("1 warning(s)")
  })

  it("renders status tags, provider, and the blind-spot block", () => {
    const text = renderReport(assembleReport(artifact, substantive("pass"), "csv"))
    expect(text).toContain("[PASS]")
    expect(text).toContain("VERDICT:")
    expect(text).toContain("provider: csv")
    expect(text).toContain("This harness cannot see:")
    expect(text).toContain("only the winning trades")
  })
})

describe("parseArtifact", () => {
  it("round-trips a valid artifact", () => {
    expect(parseArtifact(JSON.parse(JSON.stringify(artifact)))).toEqual(artifact)
  })

  it("names the offending field", () => {
    const bad = JSON.parse(JSON.stringify(artifact))
    bad.trades[0].side = "hold"
    expect(() => parseArtifact(bad)).toThrow(/trades\[0\]\.side/)
  })

  it("rejects a trade that exits before it enters", () => {
    const bad = JSON.parse(JSON.stringify(artifact))
    bad.trades[0].exitTime = "2025-12-31T00:00:00Z"
    expect(() => parseArtifact(bad)).toThrow(/exits before/)
  })

  it("rejects local datetimes whose meaning depends on the machine timezone", () => {
    for (const field of ["entryTime", "exitTime"] as const) {
      const bad = JSON.parse(JSON.stringify(artifact))
      bad.trades[0][field] = "2026-01-02T09:30:00"
      expect(() => parseArtifact(bad)).toThrow(new RegExp(`trades\\[0\\]\\.${field}.*explicit timezone`))
    }
  })

  it("accepts explicit ISO-8601 offsets as deterministic instants", () => {
    const offset = JSON.parse(JSON.stringify(artifact))
    offset.trades[0].entryTime = "2026-01-02T08:00:00+08:00"
    offset.trades[0].exitTime = "2026-01-05T08:00:00+08:00"
    expect(parseArtifact(offset)).toEqual(offset)
  })

  it("REGRESSION: a null trade element gets a named error, not a TypeError", () => {
    const bad = JSON.parse(JSON.stringify(artifact))
    bad.trades[0] = null
    expect(() => parseArtifact(bad)).toThrow(/trades\[0\] must be an object/)
  })

  it("REGRESSION: an unknown timeframe is rejected (it would break bar-duration math downstream)", () => {
    const bad = JSON.parse(JSON.stringify(artifact))
    bad.timeframe = "2d"
    expect(() => parseArtifact(bad)).toThrow(/timeframe/)
  })
})
