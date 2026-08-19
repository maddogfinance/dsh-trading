import { describe, expect, it } from "vitest"
import { lintSource } from "../src/checks/lookahead-lint.js"

const LEAKY = `
import pandas as pd
df["signal"] = df["close"].shift(-1) > df["close"]
df["smooth"] = df["close"].rolling(20, center=True).mean()
arr = np.roll(prices, -3)
df["filled"] = df["gap"].bfill()
scaler.fit(df)
nxt = lead(close, 1)
`

const CLEAN = `
import pandas as pd
df["signal"] = df["close"].shift(1) > df["sma20"]
df["smooth"] = df["close"].rolling(20).mean()
df["filled"] = df["gap"].ffill()
scaler.fit(train_features)
`

describe("lookahead lint", () => {
  it("flags the classic leak constructs with the right rules", () => {
    const findings = lintSource("strategy.py", LEAKY)
    const ids = findings.map(f => f.ruleId)
    expect(ids).toContain("LK001") // shift(-1)
    expect(ids).toContain("LK002") // center=True
    expect(ids).toContain("LK003") // np.roll(..., -3)
    expect(ids).toContain("LK004") // bfill
    expect(ids).toContain("LK005") // fit(df)
    expect(ids).toContain("LK006") // lead(
  })

  it("reports 1-based line numbers and file labels", () => {
    const findings = lintSource("strategy.py", LEAKY)
    const shiftHit = findings.find(f => f.ruleId === "LK001")!
    expect(shiftHit.file).toBe("strategy.py")
    expect(shiftHit.line).toBe(3)
    expect(shiftHit.excerpt).toContain("shift(-1)")
  })

  it("stays silent on trailing-window code", () => {
    expect(lintSource("clean.py", CLEAN)).toEqual([])
  })

  it("suppresses fit() hits on lines that mention train", () => {
    const findings = lintSource("x.py", "model.fit(X_train)\nscaler.fit(df_train)\n")
    expect(findings).toEqual([])
  })

  it("REGRESSION: catches bare shift(-1) without a leading dot", () => {
    const findings = lintSource("x.py", "sig = shift(-1) > 0\n")
    expect(findings.map(f => f.ruleId)).toContain("LK001")
  })

  it("REGRESSION: comment lines are downgraded to warn — prose about a leak must not convict the file", () => {
    const findings = lintSource("x.py", "# never use rolling(center=True) here\n// df['x'].shift(-1) was removed\n")
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every(f => f.severity === "warn")).toBe(true)
  })
})
