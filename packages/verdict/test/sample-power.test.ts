import { describe, expect, it } from "vitest"
import { inverseNormalCdf, requiredTrades, samplePower, wilsonInterval } from "../src/checks/sample-power.js"

describe("inverseNormalCdf", () => {
  it("matches the standard quantiles", () => {
    expect(inverseNormalCdf(0.975)).toBeCloseTo(1.959964, 5)
    expect(inverseNormalCdf(0.8)).toBeCloseTo(0.8416212, 5)
    expect(inverseNormalCdf(0.5)).toBeCloseTo(0, 9)
    expect(inverseNormalCdf(0.025)).toBeCloseTo(-1.959964, 5)
  })
})

describe("requiredTrades", () => {
  it("computes the two-proportion sample size for a 5pp edge", () => {
    // ((1.959964*0.5 + 0.8416212*sqrt(0.55*0.45)) / 0.05)^2 = 782.5...
    expect(requiredTrades(0.05)).toBe(783)
  })

  it("scales roughly with the inverse square of the edge", () => {
    const n5 = requiredTrades(0.05)
    const n1 = requiredTrades(0.01)
    expect(n1 / n5).toBeGreaterThan(20)
    expect(n1 / n5).toBeLessThan(30)
  })
})

describe("wilsonInterval", () => {
  it("covers the point estimate and stays inside [0,1]", () => {
    const { low, high } = wilsonInterval(60, 100)
    expect(low).toBeGreaterThan(0.49)
    expect(high).toBeLessThan(0.70)
    expect(low).toBeLessThan(0.6)
    expect(high).toBeGreaterThan(0.6)
  })
})

describe("samplePower", () => {
  const returnsOf = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0.01 : -0.008))

  it("declares a 68-trade sample underpowered for a 5pp edge", () => {
    const result = samplePower(returnsOf(68))
    expect(result.powered).toBe(false)
    expect(result.requiredTrades).toBe(783)
  })

  it("declares a 1000-trade sample powered for the same edge", () => {
    expect(samplePower(returnsOf(1000)).powered).toBe(true)
  })

  it("REGRESSION: a unit-confused edge (5 instead of 0.05) throws instead of passing one trade", () => {
    expect(() => samplePower([0.01], { minDetectableEdge: 5 })).toThrow(/\(0, 0.5\]/)
  })

  it("REGRESSION: an impossible baseline+edge combination throws instead of silently truncating", () => {
    expect(() => requiredTrades(0.2, { baseline: 0.9 })).toThrow(/impossible/)
  })

  it("REGRESSION: high-variance mean returns keep a big-n sample honest on the mean dimension", () => {
    // 800 trades, tiny mean, huge dispersion: win-rate dimension is satisfied
    // (n >= 783) but the mean return is pure noise — powered must be false.
    const noisy = Array.from({ length: 800 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.0499))
    const result = samplePower(noisy)
    expect(result.trades).toBeGreaterThanOrEqual(result.requiredTrades)
    expect(result.requiredTradesMeanReturn).toBeGreaterThan(800)
    expect(result.powered).toBe(false)
  })
})
